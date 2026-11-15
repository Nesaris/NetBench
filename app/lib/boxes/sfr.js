'use strict';
// SFR Box (NB4, NB6, NB6V, NB6VAC…) — API « 1.0 » des neufbox (XML). Les SFR Box 8 récentes n'ont plus cette API :
// Sonde passe alors en mode « box générique » (appareils vus par l'ordinateur, sans les infos de la box).
const crypto = require('node:crypto');
const { http, err, normMac, randomMac, dashify, GENERIC, guessModel, isConsoleName } = require('./common');

const attrs = s => { const o = {}; for (const m of String(s).matchAll(/([a-z_0-9]+)="([^"]*)"/gi)) o[m[1]] = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'); return o; };
const tags = (xml, tag) => [...String(xml).matchAll(new RegExp(`<${tag}\\b([^>]*)/?>`, 'gi'))].map(m => attrs(m[1]));
const stat = xml => (String(xml).match(/<rsp[^>]*stat="(\w+)"/) || [])[1];
const errCode = xml => attrs((String(xml).match(/<err\b([^>]*)/) || [])[1] || '');

async function probe(host) {
  for (const h of [host, '192.168.1.1', '192.168.0.1'].filter(Boolean)) {
    try {
      const r = await http(`http://${h}/api/1.0/?method=system.getInfo`, { timeout: 3000 });
      if (stat(r.text) === 'ok') { const s = tags(r.text, 'system')[0] || {}; return { ok: true, host: h, model: (s.product_id || 'SFR Box').split('-')[0] }; }
    } catch { }
  }
  return { ok: false };
}

function create(ctx, cfg) {
  const host = cfg.host || '192.168.1.1';
  const API = `http://${host}/api/1.0/`;
  const st = { token: null, t: 0 };
  const cred = () => { try { return JSON.parse(ctx.secrets.get('sfr-login') || 'null'); } catch { return null; } };
  const h256 = (token, v) => crypto.createHmac('sha256', token).update(crypto.createHash('sha256').update(v).digest('hex')).digest('hex');

  async function get(method, params = {}) {
    const r = await http(API + '?' + new URLSearchParams({ method, ...params }), { timeout: 6000 });
    if (stat(r.text) !== 'ok') { const e = errCode(r.text); throw err(e.msg || 'Erreur SFR Box', ['115', '204', '901'].includes(e.code) ? 'auth_failed' : 'api_error'); }
    return r.text;
  }
  async function token() {
    if (st.token && Date.now() - st.t < 9 * 60_000) return st.token;
    const c = cred(); if (!c) throw err('Identifiants de la SFR Box manquants', 'no_token');
    const a = tags(await get('auth.getToken'), 'auth')[0] || {};
    if (a.method && !/all|passwd/.test(a.method)) throw err('Cette box n\'autorise pas la connexion par mot de passe (seulement par bouton).', 'auth_failed');
    const hash = h256(a.token, c.user || 'admin') + h256(a.token, c.password);
    const b = tags(await get('auth.checkToken', { token: a.token, hash }), 'auth')[0] || {};
    st.token = b.token || a.token; st.t = Date.now(); return st.token;
  }
  async function authed(method) { try { return await get(method, { token: await token() }); } catch (e) { if (e.code === 'auth_failed') { st.token = null; return get(method, { token: await token() }); } throw e; } }

  return {
    id: 'sfr', label: 'SFR Box', host,
    features: { signal: false, perDeviceRate: false, wanRate: false, rename: false, block: false, ports: false, repeater: false, vm: false, auth: 'password', user: true, experimental: true },
    async authState() { return { ok: !!cred(), kind: 'password', user: true }; },
    async authorize({ user, password }) {
      if (!password) throw err('Mot de passe requis', 'bad_request');
      const old = ctx.secrets.get('sfr-login');
      ctx.secrets.set('sfr-login', JSON.stringify({ user: user || 'admin', password })); st.token = null;
      try { await token(); return { status: 'granted' }; } catch (e) { if (old) ctx.secrets.set('sfr-login', old); else ctx.secrets.del('sfr-login'); throw e; }
    },
    async devices() {
      const hosts = tags(await authed('lan.getHostsList'), 'host');
      return hosts.filter(h => h.mac && (h.status || 'online') === 'online').map(h => {
        const mac = normMac(h.mac), name = (h.name || '').trim() || mac;
        const wifi = /wlan|wifi/i.test(h.iface || '');
        const model = guessModel(name, h.type);
        return {
          id: 'sfr-' + mac, mac, name, ip: h.ip || null, type: h.type || 'other', vendor: '', via: wifi ? 'box' : 'cable', band: null, signal: null, standard: null,
          linkTx: null, linkRx: null, ethMax: null, port: !wifi ? h.iface || null : null, totDown: 0, totUp: 0, down: 0, up: 0, lastAct: null,
          isConsole: isConsoleName(name), manual: false, model, suggest: GENERIC.test(name) && model ? dashify(model) : null, source: 'SFR Box', randomMac: randomMac(mac)
        };
      });
    },
    async wan() { const w = tags(await get('wan.getInfo'), 'wan')[0] || {}; return { down: null, up: null, state: w.status === 'up' ? 'up' : 'down', bwDown: null, bwUp: null }; },
    async overview() {
      const out = {};
      try { const s = tags(await get('system.getInfo'), 'system')[0] || {}; out.system = { model: (s.product_id || 'SFR Box').split('-')[0], firmware: s.version_mainfirmware || null, uptimeSec: +s.uptime || null }; } catch (e) { out.system = { error: e.message }; }
      try { const w = tags(await get('wan.getInfo'), 'wan')[0] || {}; out.connection = { state: w.status === 'up' ? 'up' : 'down', media: w.infra || null, ipv4: w.ip_addr || null }; } catch (e) { out.connection = { error: e.message }; }
      return out;
    }
  };
}
module.exports = { id: 'sfr', isp: 'sfr', label: 'SFR Box', probe, create };
