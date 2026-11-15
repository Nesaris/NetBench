'use strict';
// Bbox (Bouygues Telecom) — API locale officielle (api.bbox.fr). Connexion avec le mot de passe d'administration de la box.
const { round, http, err, normMac, randomMac, dashify, GENERIC, guessModel, isConsoleName } = require('./common');

const bases = host => ['https://mabbox.bytel.fr/api/v1', `http://${host || '192.168.1.254'}/api/v1`];

async function probe(host) {
  for (const b of bases(host)) {
    try {
      const r = await http(b + '/device/summary', { timeout: 3000 });
      const j = Array.isArray(r.json) ? r.json[0] : null;
      if (j && (j.device || j.wan || j.display)) return { ok: true, base: b, model: j.device?.modelname || 'Bbox' };
      if (r.json && r.json.exception) return { ok: true, base: b, model: 'Bbox' };
    } catch { }
  }
  return { ok: false };
}

function create(ctx, cfg) {
  let base = cfg.base || bases(cfg.host)[0];
  const st = { cookie: null, btoken: null, btokenExp: 0, last: null };
  const pw = () => ctx.secrets.get('bbox-password');

  async function login() {
    const p = pw(); if (!p) throw err('Mot de passe de la Bbox manquant', 'no_token');
    const r = await http(base + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: p, remember: '1' }).toString() });
    const sc = r.headers.get('set-cookie') || '';
    const m = sc.match(/BBOX_ID=([^;]+)/);
    if (r.status >= 400 || !m) throw err(r.status === 429 ? 'Trop d\'essais : la Bbox bloque la connexion quelques minutes.' : 'Mot de passe de la Bbox refusé', 'auth_failed');
    st.cookie = 'BBOX_ID=' + m[1];
  }
  async function call(method, p, form, retry = true) {
    if (!st.cookie) await login();
    let url = base + p;
    if (method !== 'GET') {
      if (Date.now() > st.btokenExp) {
        const t = await http(base + '/device/token', { headers: { cookie: st.cookie } });
        const d = Array.isArray(t.json) ? t.json[0]?.device : null;
        if (!d?.token) throw err('Jeton d\'écriture Bbox indisponible', 'no_btoken');
        st.btoken = d.token; st.btokenExp = Date.now() + 60_000;
      }
      url += (url.includes('?') ? '&' : '?') + 'btoken=' + encodeURIComponent(st.btoken);
    }
    const r = await http(url, { method, headers: { cookie: st.cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
    if ((r.status === 401 || r.status === 403) && retry) { st.cookie = null; return call(method, p, form, false); }
    if (r.status >= 400) throw err(r.json?.exception?.errors?.[0]?.reason || `Erreur Bbox (${r.status})`, 'api_error');
    return r.json;
  }
  const first = j => (Array.isArray(j) ? j[0] : j) || {};
  const num = v => (v == null || v === '' || isNaN(+v) ? null : +v);

  return {
    id: 'bbox', label: 'Bbox', host: cfg.host || '192.168.1.254',
    features: { signal: true, perDeviceRate: false, wanRate: true, rename: true, block: false, ports: false, repeater: false, vm: false, auth: 'password', experimental: true },
    async authState() { return { ok: !!pw(), kind: 'password', user: false }; },
    async authorize({ password }) {
      if (!password) throw err('Mot de passe requis', 'bad_request');
      const old = pw(); ctx.secrets.set('bbox-password', password); st.cookie = null;
      try { await login(); return { status: 'granted' }; } catch (e) { if (old) ctx.secrets.set('bbox-password', old); else ctx.secrets.del('bbox-password'); throw e; }
    },
    async devices() {
      const list = first(await call('GET', '/hosts')).hosts?.list || [];
      return list.filter(h => +h.active === 1 && h.macaddress).map(h => {
        const mac = normMac(h.macaddress);
        const name = (h.userfriendlyname || h.hostname || '').trim() || mac;
        const link = String(h.link || '');
        const w = h.wireless || {};
        const rssi = [w.rssi0, w.rssi1, w.rssi2].map(num).filter(v => v != null && v < 0);
        const wifi = /wifi/i.test(link);
        const band = wifi ? (/6/.test(link + w.band) ? '6g' : /5/.test(link + w.band) ? '5g' : '2d4g') : null;
        const model = guessModel(h.hostname, h.devicetype);
        return {
          id: 'bbox-' + mac, mac, name, ip: h.ipaddress || null, type: h.devicetype || 'other', vendor: '',
          via: wifi ? 'box' : 'cable', band, signal: rssi.length ? Math.max(...rssi) : null, standard: null,
          linkTx: wifi ? num(w.rate) : num(h.ethernet?.speed), linkRx: null, ethMax: null,
          port: h.ethernet?.physicalport ? 'port ' + h.ethernet.physicalport : null,
          totDown: 0, totUp: 0, down: 0, up: 0, lastAct: num(h.lastseen),
          isConsole: isConsoleName(name), manual: !!h.userfriendlyname,
          model, suggest: !GENERIC.test(h.hostname || '') && h.hostname ? dashify(h.hostname) : model ? dashify(model) : null, source: 'DHCP', randomMac: randomMac(mac)
        };
      });
    },
    async wan() {
      const s = first(await call('GET', '/wan/ip/stats')).wan?.ip?.stats || {};
      const t = Date.now(), rx = num(s.rx?.bytes), tx = num(s.tx?.bytes);
      let down = null, up = null;
      if (st.last && rx != null && tx != null && rx >= st.last.rx && tx >= st.last.tx) {
        const dt = (t - st.last.t) / 1000;
        if (dt > 0.2) { down = round((rx - st.last.rx) * 8 / dt / 1e6, 0); up = round((tx - st.last.tx) * 8 / dt / 1e6, 0); }
      }
      if (rx != null) st.last = { t, rx, tx };
      if (down == null && num(s.rx?.bandwidth) != null) { down = round(num(s.rx.bandwidth) / 1000, 0); up = round(num(s.tx?.bandwidth) / 1000, 0); }
      return { down, up, state: 'up', bwDown: num(s.rx?.maxBandwidth) ? num(s.rx.maxBandwidth) / 1000 : null, bwUp: num(s.tx?.maxBandwidth) ? num(s.tx.maxBandwidth) / 1000 : null };
    },
    async overview() {
      const out = {};
      const safe = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = { error: e.message }; } };
      await Promise.all([
        safe('system', async () => { const d = first(await call('GET', '/device')).device || {}; return { model: d.modelname || 'Bbox', firmware: d.main?.version || null, uptimeSec: num(d.uptime), tempMax: num(d.temperature?.current ?? d.temperature) }; }),
        safe('connection', async () => { const w = first(await call('GET', '/wan/ip')).wan || {}; return { state: /up/i.test(w.ip?.state || w.link?.state || '') ? 'up' : 'down', media: w.link?.type || null, ipv4: w.ip?.address || null }; }),
        safe('wifi', async () => { const w = first(await call('GET', '/wireless')).wireless || {}; const radios = Object.entries(w.radio || {}).map(([k, r]) => ({ id: k, name: k === '24' ? '2,4 GHz' : k + ' GHz', band: k === '24' ? '2d4g' : k + 'g', state: +r.state === 1 ? 'active' : 'off', channel: num(r.current_channel ?? r.channel), width: num(r.htbw) })); return { powerSaving: null, radios }; })
      ]);
      return out;
    },
    async rename(id, name) {
      const mac = id.replace(/^bbox-/, '');
      const list = first(await call('GET', '/hosts')).hosts?.list || [];
      const h = list.find(x => normMac(x.macaddress) === mac); if (!h) throw err('Appareil introuvable sur la Bbox', 'not_found');
      await call('PUT', '/hosts/' + h.id, { hostname: name });
    },
    canRenameId: id => /^bbox-/.test(id || '')
  };
}
module.exports = { id: 'bbox', isp: 'bouygues', label: 'Bbox', probe, create };
