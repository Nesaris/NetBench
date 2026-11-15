'use strict';
// Livebox (Orange) — interface « sysbus » utilisée par la page d'administration de la box (non documentée
// officiellement). Connexion avec l'identifiant admin et le mot de passe d'administration.
const { round, http, err, normMac, randomMac, dashify, GENERIC, guessModel, isConsoleName } = require('./common');
const CT = 'application/x-sah-ws-4-call+json';

async function probe(host) {
  for (const h of [host, '192.168.1.1', 'livebox.home'].filter(Boolean)) {
    try {
      const r = await http(`http://${h}/ws`, { method: 'POST', timeout: 3000, headers: { 'content-type': CT, authorization: 'X-Sah-Login' }, body: JSON.stringify({ service: 'DeviceInfo', method: 'get', parameters: {} }) });
      const s = r.json?.status || r.json?.result?.status;
      if (s && (s.ProductClass || s.Manufacturer)) return { ok: true, host: h, model: s.ProductClass || 'Livebox' };
      if (r.json && /livebox|sah/i.test(r.text)) return { ok: true, host: h, model: 'Livebox' };
    } catch { }
  }
  return { ok: false };
}

function create(ctx, cfg) {
  const host = cfg.host || '192.168.1.1';
  const WS = `http://${host}/ws`;
  const st = { ctxId: null, cookies: {}, last: null };
  const cred = () => { try { return JSON.parse(ctx.secrets.get('livebox-login') || 'null'); } catch { return null; } };
  const keepCookies = r => { const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean); for (const c of sc) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) st.cookies[kv.slice(0, i)] = kv.slice(i + 1); } };
  const cookie = () => Object.entries(st.cookies).map(([k, v]) => `${k}=${v}`).join('; ');

  async function login() {
    const c = cred(); if (!c) throw err('Identifiants de la Livebox manquants', 'no_token');
    st.cookies = {};
    try { keepCookies((await fetch(`http://${host}/`, { signal: AbortSignal.timeout(4000) }))); } catch { }
    const r = await http(WS, { method: 'POST', headers: { 'content-type': CT, authorization: 'X-Sah-Login', ...(cookie() ? { cookie: cookie() } : {}) }, body: JSON.stringify({ service: 'sah.Device.Information', method: 'createContext', parameters: { applicationName: 'webui', username: c.user || 'admin', password: c.password } }) });
    keepCookies(r);
    const id = r.json?.data?.contextID;
    if (!id) throw err('Identifiant ou mot de passe de la Livebox refusé', 'auth_failed');
    st.ctxId = id;
  }
  async function call(service, method, parameters = {}, retry = true) {
    if (!st.ctxId) await login();
    const r = await http(WS, { method: 'POST', headers: { 'content-type': CT, 'x-context': st.ctxId, authorization: 'X-Sah ' + st.ctxId, cookie: cookie() }, body: JSON.stringify({ service, method, parameters }) });
    const j = r.json || {};
    const errors = j.errors || j.result?.errors;
    if ((r.status === 401 || (errors && errors.some?.(e => /permission|context/i.test(e.description || '')))) && retry) { st.ctxId = null; return call(service, method, parameters, false); }
    if (errors && errors.length) throw err(errors[0].description || 'Erreur Livebox', 'api_error');
    return { status: j.status ?? j.result?.status, data: j.data ?? j.result?.data };
  }
  const num = v => (v == null || v === '' || isNaN(+v) ? null : +v);

  return {
    id: 'livebox', label: 'Livebox', host,
    features: { signal: true, perDeviceRate: false, wanRate: true, rename: true, block: true, ports: false, repeater: false, vm: false, auth: 'password', user: true, experimental: true },
    async authState() { return { ok: !!cred(), kind: 'password', user: true }; },
    async authorize({ user, password }) {
      if (!password) throw err('Mot de passe requis', 'bad_request');
      const old = ctx.secrets.get('livebox-login');
      ctx.secrets.set('livebox-login', JSON.stringify({ user: user || 'admin', password })); st.ctxId = null;
      try { await login(); return { status: 'granted' }; } catch (e) { if (old) ctx.secrets.set('livebox-login', old); else ctx.secrets.del('livebox-login'); throw e; }
    },
    async devices() {
      const { status } = await call('Devices', 'get', { expression: 'lan and not self' });
      const list = Array.isArray(status) ? status : [];
      return list.filter(d => d.Active && d.PhysAddress && !/self|hgw/i.test(d.Tags || '')).map(d => {
        const mac = normMac(d.PhysAddress);
        const tags = String(d.Tags || '') + ' ' + String(d.Layer2Interface || '') + ' ' + String(d.InterfaceName || '');
        const wifi = /wifi|vap|wl\d|wlan/i.test(tags);
        const fb = String(d.OperatingFrequencyBand || '') + tags;
        const band = wifi ? (/6\s?G|6g/i.test(fb) ? '6g' : /5\s?G|5g/i.test(fb) ? '5g' : '2d4g') : null;
        const name = (d.Name || '').trim() || mac;
        const last = d.LastChanged || d.LastConnection;
        const model = guessModel(name, d.DeviceType);
        return {
          id: 'lb-' + mac, mac, name, ip: d.IPAddress || null, type: d.DeviceType || 'other', vendor: d.VendorClassID || '',
          via: wifi ? 'box' : 'cable', band, signal: num(d.SignalStrength), standard: null,
          linkTx: num(d.LastDataDownlinkRate) ? Math.round(num(d.LastDataDownlinkRate) / 1000) : null,
          linkRx: num(d.LastDataUplinkRate) ? Math.round(num(d.LastDataUplinkRate) / 1000) : null,
          ethMax: null, port: !wifi && d.InterfaceName ? String(d.InterfaceName) : null,
          totDown: 0, totUp: 0, down: 0, up: 0, lastAct: last ? Math.max(0, Math.round((Date.now() - Date.parse(last)) / 1000)) : null,
          isConsole: isConsoleName(name), manual: false,
          model, suggest: !GENERIC.test(name) ? null : model ? dashify(model) : null, source: 'Livebox', randomMac: randomMac(mac)
        };
      });
    },
    async wan() {
      const { status } = await call('NeMo.Intf.data', 'getNetDevStats');
      const t = Date.now(), rx = num(status?.RxBytes), tx = num(status?.TxBytes);
      let down = null, up = null;
      if (st.last && rx != null && rx >= st.last.rx && tx >= st.last.tx) { const dt = (t - st.last.t) / 1000; if (dt > 0.2) { down = round((rx - st.last.rx) * 8 / dt / 1e6, 0); up = round((tx - st.last.tx) * 8 / dt / 1e6, 0); } }
      if (rx != null) st.last = { t, rx, tx };
      return { down, up, state: 'up', bwDown: null, bwUp: null };
    },
    async overview() {
      const out = {};
      const safe = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = { error: e.message }; } };
      await Promise.all([
        safe('system', async () => { const s = (await call('DeviceInfo', 'get')).status || {}; return { model: s.ProductClass || 'Livebox', firmware: s.SoftwareVersion || null, uptimeSec: num(s.UpTime) }; }),
        safe('connection', async () => { const d = (await call('NMC', 'getWANStatus')).data || {}; return { state: /up|bound|connected/i.test(d.LinkState + d.ConnectionState) ? 'up' : 'down', media: d.LinkType || null, ipv4: d.IPAddress || null }; })
      ]);
      return out;
    },
    async rename(id, name) { await call('Devices.Device.' + id.replace(/^lb-/, ''), 'setName', { name, source: 'webui' }); },
    canRenameId: id => /^lb-/.test(id || ''),
    async blockedList() { return ctx.store.get('livebox-blocked', []); },
    async block(mac, on, name) {
      let list = ctx.store.get('livebox-blocked', []);
      if (on) {
        try { await call('Scheduler', 'addSchedule', { type: 'ToD', info: { ID: mac, enable: true, override: 'Disable', base: 'Weekly', def: 'Enable', schedule: [] } }); }
        catch { await call('Scheduler', 'overrideSchedule', { type: 'ToD', ID: mac, override: 'Disable' }); }
        if (!list.some(x => x.mac === mac)) list.push({ mac, name: String(name || mac).slice(0, 40) });
      } else {
        try { await call('Scheduler', 'removeSchedules', { type: 'ToD', ID: [mac] }); } catch { await call('Scheduler', 'overrideSchedule', { type: 'ToD', ID: mac, override: '' }); }
        list = list.filter(x => x.mac !== mac);
      }
      ctx.store.set('livebox-blocked', list);
    },
    blockNote: 'L\'appareil perd l\'accès à Internet (contrôle d\'accès de la Livebox, comme la « pause » de l\'application Orange).'
  };
}
module.exports = { id: 'livebox', isp: 'orange', label: 'Livebox', probe, create };
