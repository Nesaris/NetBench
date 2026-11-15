'use strict';
// Freebox (Free) — API officielle Freebox OS (dev.freebox.fr). Autorisation par bouton sur l'écran de la box.
const crypto = require('node:crypto');
const os = require('node:os');
const { sleep, round, http, err, GENERIC, clean, dashify, randomMac } = require('./common');

const APP_ID = 'fr.nesaris.sonde';

async function probe(host) {
  for (const h of [host, 'mafreebox.freebox.fr'].filter(Boolean)) {
    try {
      const r = await http(`http://${h}/api_version`, { timeout: 2500 });
      if (r.json && r.json.api_base_url) return { ok: true, host: h, model: r.json.box_model_name || r.json.device_name || 'Freebox', api: parseInt(r.json.api_version, 10) || 8 };
    } catch { }
  }
  return { ok: false };
}

function create(ctx, cfg) {
  const host = cfg.host || '192.168.1.254';
  const ver = Math.min(cfg.api || 8, 16);
  const BASE = `http://${host}/api/v${ver}`;
  const fbx = {
    session: null, authorizing: null,
    // jeton d'application gardé dans le coffre de l'ordinateur ; « freebox-app-id » permet de reprendre
    // une autorisation accordée sous un autre identifiant d'application
    token(full) {
      const t = ctx.secrets.get('freebox-token'); if (!t) return null;
      return full ? { tok: t, appId: ctx.secrets.get('freebox-app-id') || APP_ID } : t;
    },
    async raw(p, opt = {}) {
      const r = await http(BASE + p, opt);
      if (!r.json) throw err('Réponse illisible de la Freebox', 'bad_response');
      return r.json;
    },
    async login() {
      const t = this.token(true);
      if (!t) throw err('Rebond n\'est pas encore autorisé sur la Freebox', 'no_token');
      const ch = (await this.raw('/login/')).result.challenge;
      const password = crypto.createHmac('sha1', t.tok).update(ch).digest('hex');
      const s = await this.raw('/login/session/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: t.appId, password }) });
      if (!s.success) throw err(s.msg || 'Connexion refusée', s.error_code || 'login_failed');
      this.session = s.result.session_token;
    },
    async call(method, p, body, retry = true) {
      if (!this.session) await this.login();
      const r = await this.raw(p, { method, headers: { 'X-Fbx-App-Auth': this.session, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (!r.success && retry && /auth|invalid_session/.test(r.error_code || '')) { this.session = null; return this.call(method, p, body, false); }
      if (!r.success) throw err(r.msg || 'Erreur API Freebox', r.error_code);
      return r.result;
    },
    get(p) { return this.call('GET', p); },
    put(p, b) { return this.call('PUT', p, b); }
  };

  // ---------------------------------------------------------- noms automatiques (UPnP, mDNS, DHCP)
  function identify(h) {
    const names = h.names || [], info = h.info || {};
    const by = src => names.filter(n => n.source === src).map(n => clean(n.name)).find(n => n && !GENERIC.test(n));
    const dhcp = info.dhcp || {}, mdns = info.mdns || {}, upnp = info.upnp || {};
    const svc = Object.keys(mdns).join(' ');
    const vci = dhcp['Vendor Class Identifier'] || '';
    const hostn = clean(dhcp['Host Name']);
    const vendor = (h.vendor_name || '').replace(/,? ?(Inc|Ltd|LTD|Co|Corporation|Technologies|Technology|GmbH|Pte|SAS)\.?.*$/i, '').trim();
    let model = null, source = null, name = null;
    const md = by('mdns') || '';
    if (/UniFi|Ubiquiti/i.test(vci)) model = vci;
    else if (vci === 'PS5' || /^PS5/i.test(md)) model = 'PlayStation 5';
    else if (/bosch-oven/i.test(hostn)) model = 'Four Bosch (Home Connect)';
    else if (/Meross/i.test(hostn)) model = 'Prise Meross';
    else if (/^amazon-/i.test(hostn)) model = 'Amazon Echo / Fire';
    else if (/HomePod/i.test(hostn + md)) model = 'Apple HomePod';
    else if (/googlecast/.test(svc) && /androidtvremote/.test(svc)) model = /sony/i.test(upnp.manufacturerURL || '') ? 'Téléviseur Sony (Google TV)' : 'Téléviseur / box Google TV';
    else if (/googlecast/.test(svc)) model = 'Appareil Google Cast';
    else if (/^iPhone/i.test(hostn + md)) model = 'iPhone';
    else if (/^iPad/i.test(hostn + md)) model = 'iPad';
    else if (/MacBook/i.test(md)) model = 'MacBook';
    else if (/android-dhcp/i.test(vci)) model = 'Appareil Android';
    else if (upnp.modelName) model = [upnp.manufacturer, upnp.modelName].filter(Boolean).join(' ');
    if (upnp.friendlyName && !GENERIC.test(clean(upnp.friendlyName))) { name = clean(upnp.friendlyName); source = 'UPnP'; }
    else if (by('mdns_srv')) { name = by('mdns_srv'); source = 'mDNS'; }
    else if (md && !/^(PS5-|Android)|bosch-oven|Meross_|^amazon-/i.test(md)) { name = md; source = 'mDNS'; }
    else if (hostn && !GENERIC.test(hostn) && !/bosch-oven|Meross_|^amazon-/i.test(hostn)) { name = hostn; source = 'DHCP'; }
    else if (model) { name = model.replace(/ \(.*\)/, '').replace(/^Téléviseur \/ box /, ''); source = 'modèle'; }
    else if (vendor) { name = vendor; source = 'fabricant'; }
    return { model, suggest: name ? dashify(name) : null, source, randomMac: randomMac(h.l2ident?.id) };
  }

  function mapDevice(h, ports) {
    const ap = h.access_point || {};
    const w = ap.wifi_information || {};
    const e = ap.ethernet_information || {};
    const ip = ((h.l3connectivities || []).find(c => c.af === 'ipv4' && c.active) || {}).addr || null;
    const name = (h.primary_name || '').trim() || h.vendor_name || h.id;
    let via = 'box';
    if (ap.connectivity_type === 'ethernet') via = 'cable';
    else if (ap.type === 'repeater') via = 'repeteur';
    const mac = (h.l2ident?.id || '').toUpperCase();
    const ml = p => Array.isArray(p.mac_list) ? p.mac_list : [];
    const port = ports.find(p => ml(p).some(m => (m.mac || '').toUpperCase() === mac));
    return {
      id: h.id, mac, name, ip, type: h.host_type || 'other', vendor: h.vendor_name || '',
      via, band: w.band || null, signal: w.signal || null, standard: w.standard || null,
      linkTx: w.phy_tx_rate ? Math.round(w.phy_tx_rate / 10) : (e.speed || (port ? +port.speed : null)),
      linkRx: w.phy_rx_rate ? Math.round(w.phy_rx_rate / 10) : null,
      ethMax: e.max_port_speed || null, port: port ? port.name : null,
      totDown: ap.tx_bytes || 0, totUp: ap.rx_bytes || 0,
      down: Math.round((ap.tx_rate || 0) * 8 / 1000), up: Math.round((ap.rx_rate || 0) * 8 / 1000),
      lastAct: h.last_activity ? Math.round(Date.now() / 1000 - h.last_activity) : null,
      isConsole: h.host_type === 'vg_console' || /ps5|ps4|xbox|switch/i.test(name),
      manual: !!h.primary_name_manual, ...identify(h)
    };
  }

  return {
    id: 'freebox', label: 'Freebox', host,
    features: { signal: true, perDeviceRate: true, wanRate: true, rename: true, block: true, cableBlock: false, ports: true, repeater: true, vm: true, auth: 'button' },
    async authState() { return { ok: !!fbx.token(), kind: 'button' }; },
    async authorize() {
      if (fbx.authorizing) return fbx.authorizing;
      const r = await fbx.raw('/login/authorize/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: APP_ID, app_name: 'Rebond', app_version: ctx.version, device_name: os.hostname() }) });
      if (!r.success) throw err(r.msg || 'Autorisation impossible', 'auth_failed');
      const { app_token, track_id } = r.result;
      fbx.authorizing = { status: 'pending' };
      (async () => {
        for (let i = 0; i < 60; i++) {
          await sleep(2000);
          try {
            const s = await fbx.raw('/login/authorize/' + track_id);
            const st = s.result && s.result.status;
            fbx.authorizing.status = st; ctx.broadcast('auth', { status: st });
            if (st === 'granted') { ctx.secrets.set('freebox-token', app_token); ctx.secrets.del('freebox-app-id'); fbx.session = null; break; }
            if (st !== 'pending') break;
          } catch { }
        }
        setTimeout(() => { fbx.authorizing = null; }, 3000);
      })();
      return fbx.authorizing;
    },
    async devices() {
      const [hosts, ports] = await Promise.all([fbx.get('/lan/browser/pub/'), fbx.get('/switch/status/').catch(() => [])]);
      return hosts.filter(h => h.active && h.access_point && h.host_type !== 'freebox_repeater' && !/r[ée]p[ée]teur/i.test(h.primary_name || ''))
        .map(h => mapDevice(h, ports));
    },
    async wan() {
      const c = await fbx.get('/connection/');
      return { down: round(c.rate_down * 8 / 1e6, 0), up: round(c.rate_up * 8 / 1e6, 0), state: c.state, bwDown: c.bandwidth_down / 1e6, bwUp: c.bandwidth_up / 1e6 };
    },
    async overview() {
      const out = {};
      const safe = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = { error: e.message }; } };
      await Promise.all([
        safe('connection', async () => { const c = await fbx.get('/connection/'); return { state: c.state, media: c.media, ipv4: c.ipv4, bwDown: c.bandwidth_down / 1e6, bwUp: c.bandwidth_up / 1e6 }; }),
        safe('system', async () => {
          const s = await fbx.get('/system/');
          const temps = (s.sensors || []).map(x => x.value).filter(Number.isFinite);
          return { model: s.model_info?.pretty_name || s.board_name, firmware: s.firmware_version, uptime: s.uptime, uptimeSec: s.uptime_val, tempMax: temps.length ? Math.max(...temps) : null, fan: (s.fans || [])[0]?.value || null };
        }),
        safe('wifi', async () => {
          const [cfg, aps] = await Promise.all([fbx.get('/wifi/config/').catch(() => ({})), fbx.get('/wifi/ap/')]);
          return { powerSaving: cfg.power_saving ?? null, radios: aps.map(a => ({ id: a.id, name: a.name, band: a.config?.band, state: a.status?.state, channel: a.status?.primary_channel, width: +a.status?.channel_width || +a.config?.channel_width })) };
        }),
        safe('repeater', async () => {
          const r = (await fbx.get('/repeater/'))[0]; if (!r) return null;
          const b = (r.backhaul || []).find(x => x.best) || {};
          return { name: r.name, state: r.connection, model: r.model, firmware: r.firmware_version, signal: b.signal || null, throughput: b.throughput ? Math.round(b.throughput / 1000) : null, band: b.band || b.type, placement: b.placement_str || null };
        }),
        safe('ports', async () => (await fbx.get('/switch/status/')).map(p => ({ id: p.id, name: p.name, link: p.link, speed: +p.speed, hosts: (Array.isArray(p.mac_list) ? p.mac_list : []).map(m => m.hostname) })))
      ]);
      return out;
    },
    async rename(id, name) { await fbx.put('/lan/browser/pub/' + encodeURIComponent(id), { primary_name: name }); },
    canRenameId: id => /^ether-[0-9a-f:]{17}$/i.test(id || ''),
    async blockedList() {
      const list = (await fbx.call('GET', '/wifi/mac_filter/')) || [];
      return list.filter(x => x.type === 'blacklist' && /^Sonde - bloqué/.test(x.comment || '')).map(x => ({ mac: x.mac.toUpperCase(), name: x.comment.replace(/^Sonde - bloqué : /, '') }));
    },
    async block(mac, on, name) {
      const all = (await fbx.call('GET', '/wifi/mac_filter/')) || [];
      const mine = all.filter(x => x.mac.toUpperCase() === mac && /^Sonde - bloqué/.test(x.comment || ''));
      if (on) {
        if (!mine.length) await fbx.call('POST', '/wifi/mac_filter/', { mac, type: 'blacklist', comment: 'Sonde - bloqué : ' + String(name || mac).slice(0, 40) });
        const cfg = await fbx.get('/wifi/config/'); if (cfg.mac_filter_state !== 'blacklist') await fbx.put('/wifi/config/', { mac_filter_state: 'blacklist' });
      } else {
        for (const x of mine) await fbx.call('DELETE', '/wifi/mac_filter/' + encodeURIComponent(x.id));
        const left = ((await fbx.call('GET', '/wifi/mac_filter/')) || []).filter(x => x.type === 'blacklist');
        if (!left.length) await fbx.put('/wifi/config/', { mac_filter_state: 'disabled' });
      }
    },
    blockNote: 'L\'appareil est refusé sur le Wi‑Fi de la box (filtrage par adresse MAC). Un appareil en câble ne peut pas être bloqué.'
  };
}
module.exports = { id: 'freebox', isp: 'free', label: 'Freebox', probe, create };
