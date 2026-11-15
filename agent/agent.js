#!/usr/bin/env node
// Sonde Agent — DNS local qui montre quels services utilise chaque appareil. Zéro dépendance.
// Tourne dans Docker, sur Debian/Ubuntu (systemd), dans la VM d'une Freebox, ou directement sur l'ordinateur
// qui fait tourner Sonde (seulement quand Sonde est ouvert).
//  - serveur DNS qui transmet au DNS de la box et note quel appareil demande quel domaine
//  - Freebox seulement : lit le trafic de chaque appareil et le répartit entre ses services actifs
//  - API HTTPS protégée par identifiant + mot de passe, pour l'app Sonde
'use strict';
const dgram = require('node:dgram');
const net = require('node:net');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SERVICES, OTHER, UNKNOWN, classify, rootDomain } = require('./services.js');

const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version; } catch { return '1.1.0'; } })();
const DATA = process.env.SONDE_DATA || '/var/lib/sonde-agent';
const HTTPS_PORT = +process.env.SONDE_PORT || 8443;
const DNS_PORT = +process.env.SONDE_DNS_PORT || 53;
// Passerelle (box) : variable SONDE_BOX, sinon lue dans la table de routage (Linux), sinon 192.168.1.254
function gatewayLinux() { try { for (const l of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) { const c = l.trim().split(/\s+/); if (c[1] === '00000000' && c[2] && c[2] !== '00000000') { const h = c[2]; return [6, 4, 2, 0].map(i => parseInt(h.substr(i, 2), 16)).join('.'); } } } catch { } return null; }
const BOX = process.env.SONDE_BOX || gatewayLinux() || '192.168.1.254';
const UPSTREAMS = [process.env.SONDE_UPSTREAM || BOX, '1.1.1.1'];
let FBX = `http://${BOX}/api/v8`;
const APP_ID = 'fr.nesaris.sonde-agent';
const API_LOCAL = process.env.SONDE_API === 'local'; // mode « sur l'ordinateur » : API en HTTP sur 127.0.0.1 seulement
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
const F = n => path.join(DATA, n);
// La lecture du trafic par appareil n'existe que sur Freebox : on la détecte au démarrage.
let IS_FBX = null;
(async () => { try { const r = await (await fetch(`http://${BOX}/api_version`, { signal: AbortSignal.timeout(3000) })).json(); if (r.api_base_url) { IS_FBX = true; FBX = `http://${BOX}/api/v${Math.min(parseInt(r.api_version, 10) || 8, 16)}`; } else IS_FBX = false; } catch { IS_FBX = false; } })();
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(F(f), 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { const t = F(f + '.tmp'); fs.writeFileSync(t, JSON.stringify(v), { mode: 0o600 }); fs.renameSync(t, F(f)); };

// =================================================================== DNS
// Chaque requête est transmise telle quelle au DNS de la box (puis 1.1.1.1 en secours).
const recent = [];            // dernières requêtes {t, ip, domain, svc}
const activity = new Map();   // ip -> Map(serviceId -> {w, t, domains:Map})
const pending = new Map();    // id amont -> {rinfo, origId, t, qname, tries, msg}
const udp = dgram.createSocket('udp4');
function parseQName(msg) {
  try {
    let o = 12, labels = [];
    while (o < msg.length) {
      const len = msg[o];
      if (len === 0) { o++; break; }
      if (len > 63) return null;
      labels.push(msg.toString('latin1', o + 1, o + 1 + len)); o += len + 1;
      if (labels.length > 40) return null;
    }
    const qtype = msg.readUInt16BE(o);
    return { name: labels.join('.').toLowerCase(), qtype, end: o + 4 };
  } catch { return null; }
}
// =================================================================== blocages de sites
// Un domaine bloqué (et tous ses sous-domaines) reçoit « n'existe pas » (NXDOMAIN), pour tout le monde ou pour une IP.
let blocks = readJSON('blocks.json', []); // [{id, domain, ip|null, label, t}]
const saveBlocks = () => writeJSON('blocks.json', blocks);
function isBlocked(ip, name) {
  if (!name) return null;
  return (blocks.length && blocks.find(b => (!b.ip || b.ip === ip) && (name === b.domain || name.endsWith('.' + b.domain)))) || prioBlocked(ip, name);
}
// =================================================================== mode priorité
// Pendant une durée choisie, les gros consommateurs (vidéo, téléchargements de jeux, mises à jour)
// reçoivent « n'existe pas » pour tous les appareils sauf celui qui est prioritaire.
const PRIO_DL = ['dl.playstation.net', 'gs2.ww.prod.dl.playstation.net', 'gst.prod.dl.playstation.net', 'sgst.prod.dl.playstation.net',
  'steamcontent.com', 'steamcdn-a.akamaihd.net', 'download.epicgames.com', 'epicgames-download1.akamaized.net', 'fastly-download.epicgames.com',
  'assets1.xboxlive.com', 'assets2.xboxlive.com', 'dlassets.xboxlive.com', 'xvcf1.xboxlive.com', 'xvcf2.xboxlive.com',
  'swcdn.apple.com', 'updates.cdn-apple.com', 'osxapps.itunes.apple.com', 'iosapps.itunes.apple.com', 'mesu.apple.com', 'appldnld.apple.com',
  'dl.delivery.mp.microsoft.com', 'delivery.mp.microsoft.com', 'windowsupdate.com', 'update.microsoft.com', 'officecdn.microsoft.com',
  'gamesdownloads.ubi.com', 'origin-a.akamaihd.net', 'level3.nintendo.net', 'cdn.nintendo.net', 'atum.hac.lp1.d4c.nintendo.net'];
const prioDomains = () => [...new Set([...SERVICES.filter(x => x.cat === 'Vidéo' && x.id !== 'freetv').flatMap(x => x.domains || []), ...PRIO_DL])];
let PRIO_SET = null;
let priority = readJSON('priority.json', null); // {ip, name, until, t, hits}
const PRIO_HIT = { id: 'prio', label: 'Mode priorité', service: 'Mode priorité' };
function prioBlocked(ip, name) {
  if (!priority) return null;
  if (now() > priority.until) { priority = null; writeJSON('priority.json', null); return null; }
  if (ip === priority.ip) return null;
  if (!PRIO_SET) PRIO_SET = prioDomains();
  if (PRIO_SET.some(d => name === d || name.endsWith('.' + d))) { priority.hits = (priority.hits || 0) + 1; return PRIO_HIT; }
  return null;
}
function nxdomain(msg, q) {
  const end = Math.min(q && q.end ? q.end : msg.length, msg.length);
  const r = Buffer.from(msg.subarray(0, end));
  r[2] = 0x80 | (msg[2] & 0x01); r[3] = 0x80 | 0x03; // réponse, récursion conservée, NXDOMAIN
  r.writeUInt16BE(1, 4); r.writeUInt16BE(0, 6); r.writeUInt16BE(0, 8); r.writeUInt16BE(0, 10);
  return r;
}
function noteQuery(ip, q, blocked) {
  if (!q || !q.name || ![1, 28, 65].includes(q.qtype)) return; // A, AAAA, HTTPS
  const svc = classify(q.name); if (!svc) return;
  const t = now();
  recent.push({ t, ip, domain: q.name, svc: svc.id, b: blocked ? 1 : 0 }); logLine('dns', { t, ip, d: q.name, s: svc.id, ...(blocked ? { b: 1 } : {}) });
  checkSiteRules(ip, q.name, svc, blocked);
  liveSend({ t, ip, d: q.name, s: svc.id, n: svc.name, site: (svc.domains || [])[0] || null, c: svc.color, q: q.qtype, b: blocked ? 1 : 0 }); if (recent.length > 20000) recent.splice(0, recent.length - 20000);
  const rd = touchActivity(ip, q.name, svc, t);
  stats.addQuery(svc.id, rd, ip);
}
function touchActivity(ip, name, svc, t) {
  let m = activity.get(ip); if (!m) activity.set(ip, m = new Map());
  let a = m.get(svc.id); if (!a) m.set(svc.id, a = { w: 0, t, n: 0, domains: new Map() });
  a.w = decay(a.w, a.t, t) + 1; a.t = t; a.n++;
  const rd = svc === OTHER ? rootDomain(name) : name;
  a.domains.set(rd, (a.domains.get(rd) || 0) + 1);
  if (a.domains.size > 200) a.domains.delete(a.domains.keys().next().value);
  return rd;
}
// Au démarrage : on recharge les dernières requêtes depuis les journaux du disque (aujourd'hui + hier),
// pour que le flux et l'activité récente survivent à un redémarrage.
function readLogTail(dayStr, maxBytes = 8e6) {
  const f = path.join(DATA, 'logs', `${dayStr}-dns.jsonl`);
  try {
    const st = fs.statSync(f), fd = fs.openSync(f, 'r'), len = Math.min(st.size, maxBytes), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n'); if (len < st.size) lines.shift();
    return lines.map(l => { try { const o = JSON.parse(l); return { t: o.t, ip: o.ip, domain: o.d, svc: o.s, b: o.b || 0 }; } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function reloadRecent() {
  const d0 = new Date().toISOString().slice(0, 10), d1 = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const rows = [...readLogTail(d1), ...readLogTail(d0)].slice(-20000);
  recent.push(...rows);
  const t = now();
  for (const r of rows) if (t - r.t < 30 * 60e3) { const svc = classify(r.domain); if (svc) touchActivity(r.ip, r.domain, svc, r.t); }
  log(`historique rechargé : ${rows.length} requêtes`);
}
const HALF = 5 * 60e3; // l'activité DNS « s'efface » de moitié toutes les 5 min
const decay = (w, t0, t1) => w * Math.pow(0.5, (t1 - t0) / HALF);
function newId() { let id; do { id = crypto.randomInt(65536); } while (pending.has(id)); return id; }
function sendUp(p) {
  const up = UPSTREAMS[Math.min(p.tries, UPSTREAMS.length - 1)];
  const m = Buffer.from(p.msg); m.writeUInt16BE(p.upId, 0);
  udp.send(m, 53, up);
}
udp.on('message', (msg, rinfo) => {
  if (msg.length < 12) return;
  if (rinfo.port === 53 && UPSTREAMS.includes(rinfo.address)) { // réponse amont
    const id = msg.readUInt16BE(0), p = pending.get(id); if (!p) return;
    pending.delete(id); msg.writeUInt16BE(p.origId, 0);
    udp.send(msg, p.rinfo.port, p.rinfo.address); return;
  }
  if (!isLan(rinfo.address)) return; // on ne répond qu'au réseau local
  const q = parseQName(msg); const blk = q && isBlocked(rinfo.address, q.name); noteQuery(rinfo.address, q, blk);
  if (blk) { blk.hits = (blk.hits || 0) + 1; return udp.send(nxdomain(msg, q), rinfo.port, rinfo.address); }
  const p = { rinfo, origId: msg.readUInt16BE(0), t: now(), tries: 0, msg: Buffer.from(msg), upId: newId() };
  pending.set(p.upId, p); sendUp(p);
});
setInterval(() => { // relance vers le DNS de secours, puis abandon
  const t = now();
  for (const [id, p] of pending) {
    if (t - p.t > 1500 && p.tries === 0) { p.tries = 1; pending.delete(id); p.upId = newId(); p.t = t; pending.set(p.upId, p); sendUp(p); }
    else if (t - p.t > 3000) pending.delete(id);
  }
}, 500);
let dnsState = { ok: false, error: null };
// En mode « sur l'ordinateur », un port 53 déjà pris ne doit pas arrêter l'API : on le signale à l'app.
udp.on('error', e => { log('DNS UDP :', e.message); dnsState = { ok: false, error: e.code === 'EADDRINUSE' ? 'Le port 53 est déjà utilisé sur cette machine' : e.code === 'EACCES' ? 'Pas le droit d\'ouvrir le port 53' : e.message }; if (!API_LOCAL) process.exit(1); });
udp.bind(DNS_PORT, '0.0.0.0', () => { dnsState = { ok: true, error: null }; log(`DNS sur le port ${DNS_PORT}`); });
// DNS en TCP (réponses longues) : simple relais
net.createServer(sock => {
  if (!isLan(sock.remoteAddress)) return sock.destroy();
  let buf = Buffer.alloc(0), up = null;
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
      const len = buf.readUInt16BE(0), m = buf.subarray(2, 2 + len); buf = buf.subarray(2 + len);
      const cip = sock.remoteAddress.replace(/^::ffff:/, ''), q = parseQName(m), blk = q && isBlocked(cip, q.name);
      noteQuery(cip, q, blk);
      if (blk) { const r = nxdomain(m, q), fr = Buffer.alloc(2); fr.writeUInt16BE(r.length); sock.write(Buffer.concat([fr, r])); continue; }
      if (!up) { up = net.connect(53, UPSTREAMS[0]); up.on('data', x => sock.write(x)); up.on('error', () => sock.destroy()); up.on('close', () => sock.end()); }
      const fr = Buffer.alloc(2); fr.writeUInt16BE(len); up.write(Buffer.concat([fr, m]));
    }
  });
  sock.on('error', () => { }); sock.on('close', () => up && up.destroy());
  sock.setTimeout(10000, () => sock.destroy());
}).on('error', e => log('DNS TCP :', e.message)).listen(DNS_PORT, '0.0.0.0');
function isLan(a) { a = String(a).replace(/^::ffff:/, ''); return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(a); }

// =================================================================== flux en direct (SSE) des requêtes
const liveClients = new Set();
function liveSend(o) { if (!liveClients.size) return; const m = `data: ${JSON.stringify(o)}\n\n`; for (const c of liveClients) c.write(m); }

// =================================================================== journaux bruts + rétention par taille
// Chaque requête DNS est écrite dans logs/AAAA-MM-JJ-dns.jsonl (et les pings dans …-ping.jsonl).
// Quand le disque se remplit, les journaux les plus anciens sont supprimés jour par jour :
// on garde toujours au moins MIN_FREE de libre et au plus MAX_LOGS de journaux.
const LOGS = F('logs'); fs.mkdirSync(LOGS, { recursive: true });
const MIN_FREE = (+process.env.SONDE_MIN_FREE_GB || 2) * 1e9;     // espace libre minimum sur la clé
const MAX_LOGS = (+process.env.SONDE_MAX_LOGS_GB || 0) * 1e9;     // 0 = pas de plafond fixe, seulement l'espace libre
const day = t => new Date(t).toISOString().slice(0, 10);
const writers = {};
function logLine(kind, obj) {
  const f = path.join(LOGS, `${day(obj.t)}-${kind}.jsonl`);
  let w = writers[kind];
  if (!w || w.file !== f) { if (w) w.stream.end(); w = writers[kind] = { file: f, stream: fs.createWriteStream(f, { flags: 'a', mode: 0o600 }) }; }
  w.stream.write(JSON.stringify(obj) + '\n');
}
function diskFree() { try { const s = fs.statfsSync(DATA); return s.bavail * s.bsize; } catch { return Infinity; } }
function logFiles() { return fs.readdirSync(LOGS).filter(f => f.endsWith('.jsonl')).sort().map(f => ({ f, size: fs.statSync(path.join(LOGS, f)).size })); }
function retention() {
  let files = logFiles(), total = files.reduce((a, x) => a + x.size, 0), freed = 0;
  const today = day(now());
  while (files.length && (diskFree() + freed < MIN_FREE || (MAX_LOGS && total > MAX_LOGS))) {
    const x = files.shift(); if (x.f.startsWith(today)) break; // on ne supprime jamais la journée en cours
    try { fs.unlinkSync(path.join(LOGS, x.f)); freed += x.size; total -= x.size; log('rétention : supprimé', x.f); } catch { }
  }
  // les agrégats horaires sont minuscules : on les garde 1 an, et on raccourcit seulement si le disque est vraiment plein
  if (diskFree() < MIN_FREE / 2) stats.keepHours = Math.max(24 * 7, Math.floor(stats.keepHours / 2));
}
setInterval(retention, 10 * 60e3); setTimeout(retention, 5000);
function storage() {
  const files = logFiles();
  let s = {}; try { s = fs.statfsSync(DATA); } catch { }
  return { free: diskFree(), total: s.blocks ? s.blocks * s.bsize : null, logs: files.reduce((a, x) => a + x.size, 0), oldest: files[0]?.f.slice(0, 10) || null, days: new Set(files.map(x => x.f.slice(0, 10))).size, keepHours: stats.keepHours, minFree: MIN_FREE };
}

// =================================================================== statistiques (heure par heure)
const stats = {
  h: readJSON('stats.json', {}), // { heure: { svc: { dev: octets } } }
  q: readJSON('queries.json', {}), // { heure: { svc: { dom: n, '@dev': {ip: n} } } }
  key: t => String(Math.floor(t / 3600e3)),
  addBytes(svc, dev, b) { const k = this.key(now()); ((this.h[k] = this.h[k] || {})[svc] = this.h[k][svc] || {})[dev] = (this.h[k][svc][dev] || 0) + b; },
  addQuery(svc, dom, ip) { const k = this.key(now()); const s = ((this.q[k] = this.q[k] || {})[svc] = this.q[k][svc] || {}); s[dom] = (s[dom] || 0) + 1; },
  keepHours: 24 * 365,
  prune() { const min = Math.floor(now() / 3600e3) - this.keepHours; for (const o of [this.h, this.q]) for (const k of Object.keys(o)) if (+k < min) delete o[k]; },
  save() { this.prune(); writeJSON('stats.json', this.h); writeJSON('queries.json', this.q); }
};
setInterval(() => stats.save(), 60e3);

// =================================================================== Freebox : trafic par appareil
const fbx = {
  session: null,
  token() { try { return fs.readFileSync(F('fbx_token'), 'utf8').trim(); } catch { return null; } },
  async raw(p, o = {}) { const c = new AbortController(); const t = setTimeout(() => c.abort(), 6000); try { return await (await fetch(FBX + p, { ...o, signal: c.signal })).json(); } finally { clearTimeout(t); } },
  async login() {
    const tok = this.token(); if (!tok) throw Object.assign(new Error('Agent non autorisé sur la box'), { code: 'no_token' });
    const ch = (await this.raw('/login/')).result.challenge;
    const s = await this.raw('/login/session/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: APP_ID, password: crypto.createHmac('sha1', tok).update(ch).digest('hex') }) });
    if (!s.success) throw Object.assign(new Error(s.msg), { code: s.error_code });
    this.session = s.result.session_token;
  },
  async get(p, retry = true) {
    if (!this.session) await this.login();
    const r = await this.raw(p, { headers: { 'X-Fbx-App-Auth': this.session } });
    if (!r.success && retry && /auth|invalid_session/.test(r.error_code || '')) { this.session = null; return this.get(p, false); }
    if (!r.success) throw Object.assign(new Error(r.msg), { code: r.error_code });
    return r.result;
  },
  auth: null,
  async authorize() {
    if (this.auth && this.auth.status === 'pending') return this.auth;
    const r = await this.raw('/login/authorize/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: APP_ID, app_name: 'Sonde Agent', app_version: VERSION, device_name: os.hostname() }) });
    if (!r.success) throw new Error(r.msg);
    const { app_token, track_id } = r.result; this.auth = { status: 'pending' };
    (async () => { for (let i = 0; i < 60; i++) { await new Promise(x => setTimeout(x, 2000)); try { const s = (await this.raw('/login/authorize/' + track_id)).result.status; this.auth.status = s; if (s === 'granted') { fs.writeFileSync(F('fbx_token'), app_token, { mode: 0o600 }); this.session = null; break; } if (s !== 'pending') break; } catch { } } })();
    return this.auth;
  }
};
const devices = new Map(); // mac -> {name, ip, last:{tx,rx}, via, band, signal}
let fbxState = { ok: false, error: null };
async function pollBox() {
  if (IS_FBX === false) { fbxState = { ok: false, error: 'Volumes par appareil disponibles seulement avec une Freebox', code: 'not_freebox' }; return; }
  if (IS_FBX === null) return;
  let hosts;
  try { hosts = await fbx.get('/lan/browser/pub/'); fbxState = { ok: true, error: null }; }
  catch (e) { fbxState = { ok: false, error: e.message, code: e.code }; return; }
  const t = now();
  for (const h of hosts) {
    if (!h.active || !h.access_point) continue;
    const mac = h.l2ident?.id; if (!mac) continue;
    const ip = ((h.l3connectivities || []).find(c => c.af === 'ipv4' && c.active) || {}).addr;
    const a = h.access_point, w = a.wifi_information || {};
    const d = devices.get(mac) || { mac, last: null };
    Object.assign(d, { name: h.primary_name || h.vendor_name || mac, ip, type: h.host_type, via: a.connectivity_type === 'ethernet' ? 'cable' : a.type === 'repeater' ? 'repeteur' : 'box', band: w.band, signal: w.signal, seen: t });
    const tx = a.tx_bytes || 0, rx = a.rx_bytes || 0; // tx = box -> appareil (ce que l'appareil reçoit)
    if (d.last && tx >= d.last.tx && rx >= d.last.rx) {
      const bytes = (tx - d.last.tx) + (rx - d.last.rx);
      if (bytes > 0 && bytes < 50e9) { attribute(d, bytes, t); checkOverload(d, bytes, (t - (d.lastT || t)) / 1000); }
    }
    d.last = { tx, rx }; d.lastT = t;
    devices.set(mac, d);
  }
}
// Répartit le volume d'un appareil entre les services qu'il a utilisés récemment (poids DNS × poids du service).
function attribute(d, bytes, t) {
  const m = d.ip && activity.get(d.ip);
  const parts = [];
  if (m) for (const [id, a] of m) {
    const w = decay(a.w, a.t, t);
    if (t - a.t > 30 * 60e3 || w < 0.05) continue;
    const svc = SERVICES.find(s => s.id === id) || OTHER;
    parts.push([id, w * svc.heavy]);
  }
  const tot = parts.reduce((s, p) => s + p[1], 0);
  if (!tot) return stats.addBytes(UNKNOWN.id, d.mac, bytes);
  for (const [id, w] of parts) stats.addBytes(id, d.mac, Math.round(bytes * w / tot));
}
reloadRecent();
setInterval(pollBox, 5000); pollBox();

// =================================================================== alertes Discord
// Webhook Discord (salon) : surcharge réseau par appareil et consultation de sites/services surveillés.
let alerts = Object.assign({ webhook: '', tgToken: '', tgChat: '', overload: { enabled: true, deviceMbps: 200, seconds: 20 }, rules: [], cooldownMin: 10 }, readJSON('alerts.json', {}));
const saveAlerts = () => writeJSON('alerts.json', alerts);
const alertLog = readJSON('alert-log.json', []);
const lastSent = new Map(); // clé -> heure du dernier envoi (anti-spam)
const discordQ = []; let discordBusy = false;
function devByIp(ip) { return [...devices.values()].find(d => d.ip === ip); }
function sendDiscord(kind, title, desc, color, fields = []) {
  const entry = { t: now(), kind, title, desc };
  alertLog.unshift(entry); if (alertLog.length > 200) alertLog.pop(); writeJSON('alert-log.json', alertLog);
  if (alerts.tgToken && alerts.tgChat) sendTelegram(title, desc, fields);
  if (!alerts.webhook) { entry.sent = !!(alerts.tgToken && alerts.tgChat); return; }
  discordQ.push({ embeds: [{ title, description: desc, color, fields, timestamp: new Date().toISOString(), footer: { text: 'Sonde · réseau de la maison' } }] });
  pumpDiscord();
}
// Telegram : bot créé avec @BotFather, messages envoyés dans la discussion choisie
const tgEsc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
async function sendTelegram(title, desc, fields = []) {
  const text = `<b>${tgEsc(title)}</b>\n${tgEsc(desc).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}` + fields.map(f => `\n${tgEsc(f.name)} : ${tgEsc(String(f.value).replace(/`/g, ''))}`).join('');
  try {
    const r = await fetch(`https://api.telegram.org/bot${alerts.tgToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: alerts.tgChat, text, parse_mode: 'HTML', disable_web_page_preview: true }), signal: AbortSignal.timeout(8000) });
    if (!r.ok) log('Telegram :', r.status);
  } catch (e) { log('Telegram :', e.message); }
}
async function pumpDiscord() {
  if (discordBusy || !discordQ.length) return; discordBusy = true;
  const msg = discordQ.shift();
  try {
    const r = await fetch(alerts.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Sonde', ...msg }), signal: AbortSignal.timeout(8000) });
    if (r.status === 429) { const j = await r.json().catch(() => ({})); discordQ.unshift(msg); await new Promise(x => setTimeout(x, (j.retry_after || 2) * 1000)); }
    else if (!r.ok) log('Discord :', r.status);
  } catch (e) { log('Discord :', e.message); }
  await new Promise(x => setTimeout(x, 700)); discordBusy = false; pumpDiscord();
}
function cooldown(key) { const t = lastSent.get(key) || 0; if (now() - t < alerts.cooldownMin * 60e3) return false; lastSent.set(key, now()); return true; }
function checkSiteRules(ip, name, svc, blocked) {
  if (!alerts.rules.length) return;
  for (const r of alerts.rules) {
    if (r.ip && r.ip !== ip) continue;
    const hit = r.service ? svc.id === r.service : (name === r.domain || name.endsWith('.' + r.domain));
    if (!hit || !cooldown('rule:' + r.id + ':' + ip)) continue;
    const dev = devByIp(ip);
    sendDiscord('site', `${r.service ? svc.name : r.domain} consulté`, `**${dev ? dev.name : ip}** ${blocked ? 'a essayé d\'ouvrir (bloqué)' : 'utilise'} **${r.service ? svc.name : r.domain}**`, blocked ? 0xF26A5E : 0x5CC8E8,
      [{ name: 'Domaine', value: '`' + name + '`', inline: true }, { name: 'Appareil', value: (dev ? dev.name : '?') + ' · ' + ip, inline: true }]);
  }
}
const over = new Map(); // mac -> secondes consécutives au-dessus du seuil
function checkOverload(d, bytes, dt) {
  const o = alerts.overload; if (!o.enabled || !dt) return;
  const mbps = bytes * 8 / dt / 1e6;
  if (mbps < o.deviceMbps) { over.delete(d.mac); return; }
  const secs = (over.get(d.mac) || 0) + dt; over.set(d.mac, secs);
  if (secs < o.seconds || !cooldown('over:' + d.mac)) return;
  const m = d.ip && activity.get(d.ip), t = now();
  const top = m ? [...m].filter(([, a]) => t - a.t < 5 * 60e3).sort((x, y) => y[1].w - x[1].w).slice(0, 3).map(([id]) => (SERVICES.find(s => s.id === id) || { name: id }).name) : [];
  sendDiscord('surcharge', 'Surcharge réseau', `**${d.name}** consomme **${Math.round(mbps)} Mb/s** depuis ${Math.round(secs)} s`, 0xF0B54A,
    [{ name: 'Connexion', value: d.via === 'cable' ? 'câble' : `${d.via === 'repeteur' ? 'répéteur' : 'box'} ${d.band || ''} ${d.signal ?? ''} dBm`, inline: true }, { name: 'Probablement', value: top.join(', ') || 'inconnu', inline: true }]);
}

// =================================================================== comptes et sessions
const users = () => readJSON('users.json', null);
const scrypt = (pass, salt) => crypto.scryptSync(pass, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
const sessions = new Map(Object.entries(readJSON('sessions.json', {}))); // sha256(token) -> {user, exp}
const saveSessions = () => writeJSON('sessions.json', Object.fromEntries(sessions));
const fails = new Map(); // ip -> {n, until}
const tokHash = t => crypto.createHash('sha256').update(t).digest('hex');
function authUser(req) {
  const h = req.headers.authorization || '';
  const c = (req.headers.cookie || '').match(/(?:^|;\s*)sonde=([a-f0-9]{64})/);
  const tok = h.startsWith('Bearer ') ? h.slice(7) : c ? c[1] : null;
  if (!tok || !/^[a-f0-9]{64}$/.test(tok)) return null;
  const s = sessions.get(tokHash(tok)); if (!s || s.exp < now()) return null;
  return s.user;
}

// =================================================================== API HTTPS
function svcInfo(id) { return SERVICES.find(s => s.id === id) || (id === OTHER.id ? OTHER : UNKNOWN); }
const RANGES = { '1h': 1, '24h': 24, '7j': 24 * 7, '30j': 24 * 30, '1an': 24 * 365 };
function services(range) {
  const hours = RANGES[range] || 24, k1 = Math.floor(now() / 3600e3), k0 = k1 - hours + 1;
  const agg = {};
  for (let k = k0; k <= k1; k++) {
    const H = stats.h[k] || {};
    for (const [svc, devs] of Object.entries(H)) for (const [dev, b] of Object.entries(devs)) {
      const a = agg[svc] = agg[svc] || { bytes: 0, devs: {} }; a.bytes += b; a.devs[dev] = (a.devs[dev] || 0) + b;
    }
    const Q = stats.q[k] || {};
    for (const [svc, doms] of Object.entries(Q)) { const a = agg[svc] = agg[svc] || { bytes: 0, devs: {} }; a.queries = (a.queries || 0) + Object.values(doms).reduce((s, n) => s + (typeof n === 'number' ? n : 0), 0); a.domains = a.domains || {}; for (const [d, n] of Object.entries(doms)) a.domains[d] = (a.domains[d] || 0) + n; }
  }
  const live = liveNow();
  return Object.entries(agg).map(([id, a]) => {
    const s = svcInfo(id);
    return {
      id, name: s.name, cat: s.cat, color: s.color, icon: s.icon, site: (s.domains || [])[0] || null, bytes: a.bytes, queries: a.queries || 0,
      devices: Object.entries(a.devs).sort((x, y) => y[1] - x[1]).map(([mac, b]) => ({ mac, name: devices.get(mac)?.name || mac, bytes: b, now: !!live[id]?.includes(mac) })),
      active: (live[id] || []).map(mac => devices.get(mac)?.name || mac),
      domains: Object.entries(a.domains || {}).sort((x, y) => y[1] - x[1]).slice(0, id === OTHER.id ? 40 : 8).map(([d, n]) => ({ d, n }))
    };
  }).filter(s => s.bytes > 0 || s.queries > 0).sort((a, b) => b.bytes - a.bytes || b.queries - a.queries);
}
function liveNow() { // service -> appareils actifs (requête DNS dans les 5 dernières minutes)
  const t = now(), o = {};
  for (const [ip, m] of activity) {
    const dev = [...devices.values()].find(d => d.ip === ip); if (!dev) continue;
    for (const [id, a] of m) if (t - a.t < 5 * 60e3) (o[id] = o[id] || []).push(dev.mac);
  }
  return o;
}
function send(res, code, obj, extra = {}) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }); res.end(JSON.stringify(obj)); }
function body(req) { return new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e4) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }

const apiHandler = async (req, res) => {
  const ip = String(req.socket.remoteAddress).replace(/^::ffff:/, '');
  if (!isLan(ip)) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, 'https://x'), p = url.pathname;
  try {
    if (p === '/api/health') return send(res, 200, { ok: true, version: VERSION, setup: !users(), fbx: fbxState.ok, freebox: IS_FBX, dns: dnsState, local: API_LOCAL, uptime: Math.round(process.uptime()) });
    if (p === '/api/setup' && req.method === 'POST') {
      if (users()) return send(res, 409, { error: 'Le compte existe déjà.' });
      const b = await body(req);
      if (!/^[\w.@-]{3,32}$/.test(b.user || '')) return send(res, 400, { error: 'Identifiant : 3 à 32 caractères (lettres, chiffres, . _ - @).' });
      if (String(b.pass || '').length < 10) return send(res, 400, { error: 'Mot de passe : 10 caractères minimum.' });
      const salt = crypto.randomBytes(16).toString('hex');
      writeJSON('users.json', { user: b.user, salt, hash: scrypt(b.pass, salt), created: new Date().toISOString() });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const f = fails.get(ip); if (f && f.until > now()) return send(res, 429, { error: `Trop d'essais. Réessaie dans ${Math.ceil((f.until - now()) / 60000)} min.` });
      const b = await body(req), u = users();
      const ok = u && b.user === u.user && crypto.timingSafeEqual(Buffer.from(scrypt(String(b.pass || ''), u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
      if (!ok) { const n = (f && f.until < now() ? 0 : (f?.n || 0)) + 1; fails.set(ip, { n, until: n >= 5 ? now() + 15 * 60e3 : 0 }); await new Promise(r => setTimeout(r, 400)); return send(res, 401, { error: 'Identifiant ou mot de passe incorrect.' }); }
      fails.delete(ip);
      const tok = crypto.randomBytes(32).toString('hex');
      sessions.set(tokHash(tok), { user: u.user, exp: now() + 30 * 86400e3 }); saveSessions();
      return send(res, 200, { token: tok, user: u.user }, { 'set-cookie': `sonde=${tok}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${30 * 86400}` });
    }
    const user = authUser(req);
    if (!user) return send(res, 401, { error: 'Connexion requise.' });
    if (p === '/api/logout' && req.method === 'POST') { const tok = (req.headers.authorization || '').slice(7); sessions.delete(tokHash(tok)); saveSessions(); return send(res, 200, { ok: true }); }
    if (p === '/api/password' && req.method === 'POST') {
      const b = await body(req), u = users();
      if (!crypto.timingSafeEqual(Buffer.from(scrypt(String(b.old || ''), u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) return send(res, 401, { error: 'Ancien mot de passe incorrect.' });
      if (String(b.pass || '').length < 10) return send(res, 400, { error: 'Mot de passe : 10 caractères minimum.' });
      const salt = crypto.randomBytes(16).toString('hex'); writeJSON('users.json', { ...u, salt, hash: scrypt(b.pass, salt) });
      sessions.clear(); saveSessions(); return send(res, 200, { ok: true });
    }
    if (p === '/api/services') return send(res, 200, { range: url.searchParams.get('range') || '24h', fbx: fbxState, services: services(url.searchParams.get('range')), since: Math.min(...Object.keys(stats.h).map(Number), Math.floor(now() / 3600e3)) * 3600e3 });
    if (p === '/api/recent' || p === '/api/history') {
      // ?before=horodatage&limit=N&ip=…&q=… ; au-delà de la mémoire, on lit les journaux des jours précédents (7 jours max)
      const ipf = url.searchParams.get('ip'), qf = (url.searchParams.get('q') || '').toLowerCase(), before = +url.searchParams.get('before') || Infinity, limit = Math.min(1000, +url.searchParams.get('limit') || 300);
      const ok = r => r.t < before && (!ipf || r.ip === ipf) && (!qf || r.domain.includes(qf));
      let out = recent.filter(ok).slice(-limit);
      for (let k = 0; out.length < limit && k < 8; k++) {
        const dayStr = new Date((Math.min(before, out[0]?.t || before, now())) - k * 86400e3).toISOString().slice(0, 10);
        const more = readLogTail(dayStr, 3e7).filter(r => ok(r) && (!out.length || r.t < out[0].t));
        out = [...more.slice(-(limit - out.length)), ...out];
      }
      const nm = ip => [...devices.values()].find(d => d.ip === ip)?.name || ip;
      return send(res, 200, out.reverse().map(r => { const sv = SERVICES.find(x => x.id === r.svc); return { ...r, name: nm(r.ip), n: sv?.name || null, site: sv?.domains?.[0] || null, c: sv?.color || null }; }));
    }
    if (p === '/api/fbx/authorize' && req.method === 'POST') return send(res, 200, await fbx.authorize());
    if (p === '/api/storage') return send(res, 200, storage());
    if (p === '/api/alerts' && req.method === 'GET') return send(res, 200, { ...alerts, tgToken: alerts.tgToken ? '••••••' : '', hasTelegram: !!(alerts.tgToken && alerts.tgChat), webhook: alerts.webhook ? alerts.webhook.replace(/\/[\w-]{20,}$/, '/••••••') : '', hasWebhook: !!alerts.webhook, log: alertLog.slice(0, 50) });
    if (p === '/api/alerts' && req.method === 'POST') {
      const b = await body(req);
      if (typeof b.webhook === 'string' && !b.webhook.includes('••')) {
        if (b.webhook && !/^https:\/\/(discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(b.webhook)) return send(res, 400, { error: 'Lien de webhook Discord invalide (https://discord.com/api/webhooks/…).' });
        alerts.webhook = b.webhook;
      }
      if (typeof b.tgToken === 'string' && !b.tgToken.includes('••')) {
        if (b.tgToken && !/^\d{6,12}:[\w-]{30,50}$/.test(b.tgToken)) return send(res, 400, { error: 'Jeton Telegram invalide (format 123456789:ABC…).' });
        alerts.tgToken = b.tgToken; if (!b.tgToken) alerts.tgChat = '';
      }
      if (b.tgDetect) { // trouve la discussion : il faut avoir envoyé un message au bot juste avant
        if (!alerts.tgToken) return send(res, 400, { error: 'Enregistre d\'abord le jeton du bot.' });
        const r = await fetch(`https://api.telegram.org/bot${alerts.tgToken}/getUpdates`, { signal: AbortSignal.timeout(8000) }).then(x => x.json()).catch(() => ({}));
        const m = (r.result || []).map(u => u.message || u.channel_post || u.my_chat_member).filter(Boolean).pop();
        if (!m || !m.chat) return send(res, 404, { error: 'Aucun message reçu par le bot : envoie‑lui « bonjour » dans Telegram, puis réessaie.' });
        alerts.tgChat = String(m.chat.id); saveAlerts();
        await sendTelegram('Sonde connecté', 'Les alertes du réseau de la maison arriveront ici.');
        return send(res, 200, { ok: true, chat: m.chat.title || m.chat.first_name || m.chat.username || m.chat.id });
      }
      if (b.overload) alerts.overload = { enabled: !!b.overload.enabled, deviceMbps: Math.max(5, Math.min(8000, +b.overload.deviceMbps || 200)), seconds: Math.max(5, Math.min(600, +b.overload.seconds || 20)) };
      if (b.cooldownMin) alerts.cooldownMin = Math.max(1, Math.min(240, +b.cooldownMin));
      if (b.addRule) { const r = b.addRule; const domain = String(r.domain || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); if (!r.service && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return send(res, 400, { error: 'Site invalide' }); alerts.rules.push({ id: crypto.randomBytes(4).toString('hex'), service: r.service || null, serviceName: r.service ? (SERVICES.find(s => s.id === r.service) || {}).name : null, domain: r.service ? null : domain, ip: r.ip || null }); }
      if (b.delRule) alerts.rules = alerts.rules.filter(r => r.id !== b.delRule);
      saveAlerts();
      if (b.test) sendDiscord('test', 'Test Sonde', 'Les alertes du réseau de la maison arriveront dans ce salon.', 0x7CCF7A);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/catalog') return send(res, 200, SERVICES.filter(s => s.domains?.length).map(s => ({ id: s.id, name: s.name, cat: s.cat, site: s.domains[0] })));
    if (p === '/api/priority' && req.method === 'GET') return send(res, 200, priority && now() < priority.until ? { ...priority, left: Math.round((priority.until - now()) / 1000) } : null);
    if (p === '/api/priority' && req.method === 'POST') {
      const b = await body(req);
      if (b.stop) { priority = null; writeJSON('priority.json', null); return send(res, 200, { ok: true }); }
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(b.ip || '')) return send(res, 400, { error: 'Appareil sans IP' });
      const min = Math.max(5, Math.min(240, +b.minutes || 60));
      priority = { ip: b.ip, name: String(b.name || b.ip).slice(0, 60), t: now(), until: now() + min * 60000, hits: 0 }; writeJSON('priority.json', priority);
      return send(res, 200, { ok: true, until: priority.until, domains: (PRIO_SET = prioDomains()).length });
    }
    if (p === '/api/blocks' && req.method === 'GET') return send(res, 200, blocks);
    if (p === '/api/blocks' && req.method === 'POST') {
      const b = await body(req);
      if (b.service) { // bloque tous les domaines connus d'un service (ex. TikTok)
        const sv = SERVICES.find(x => x.id === b.service); if (!sv || !sv.domains?.length) return send(res, 400, { error: 'Service inconnu' });
        const ip = b.ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(b.ip) ? b.ip : null;
        for (const d of sv.domains) if (!blocks.some(x => x.domain === d && x.ip === ip)) blocks.push({ id: crypto.randomBytes(4).toString('hex'), domain: d, ip, label: String(b.label || '').slice(0, 60), service: sv.name, t: now() });
        saveBlocks(); return send(res, 200, { ok: true, n: sv.domains.length });
      }
      const domain = String(b.domain || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '');
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return send(res, 400, { error: 'Domaine invalide (ex. tiktok.com).' });
      const ip = b.ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(b.ip) ? b.ip : null;
      if (blocks.some(x => x.domain === domain && x.ip === ip)) return send(res, 200, { ok: true });
      blocks.push({ id: crypto.randomBytes(4).toString('hex'), domain, ip, label: String(b.label || '').slice(0, 60), t: now() }); saveBlocks();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/blocks/delete' && req.method === 'POST') { const b = await body(req); blocks = blocks.filter(x => b.service ? !(x.service === b.service && (x.ip || null) === (b.ip || null)) : x.id !== b.id); saveBlocks(); return send(res, 200, { ok: true }); }
    if (p === '/api/live') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': ok\n\n'); liveClients.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clearInterval(ka); liveClients.delete(res); });
      return;
    }
    if (p === '/api/fbx/status') return send(res, 200, { ...fbxState, auth: fbx.auth });
    if (p === '/api/names' && req.method === 'POST') {
      // Box autres que Freebox : l'app Sonde envoie les noms des appareils qu'elle lit dans la box
      if (IS_FBX) return send(res, 200, { ok: true, ignored: true });
      const b = await body(req); let n = 0;
      for (const d of (Array.isArray(b.devices) ? b.devices.slice(0, 300) : [])) {
        const mac = String(d.mac || '').toUpperCase(); if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(d.ip || '')) continue;
        const o = devices.get(mac) || { last: null };
        devices.set(mac, { ...o, mac, name: String(d.name || mac).slice(0, 60), ip: d.ip, via: d.via || null, band: d.band || null, signal: d.signal ?? null }); n++;
      }
      return send(res, 200, { ok: true, n });
    }
    send(res, 404, { error: 'introuvable' });
  } catch (e) { log('API', p, e.message); send(res, 500, { error: e.message }); }
};
if (API_LOCAL) require('node:http').createServer(apiHandler).listen(HTTPS_PORT, '127.0.0.1', () => log(`API locale sur 127.0.0.1:${HTTPS_PORT}`));
else https.createServer({ key: fs.readFileSync(F('tls.key')), cert: fs.readFileSync(F('tls.crt')) }, apiHandler).listen(HTTPS_PORT, '0.0.0.0', () => log(`API HTTPS sur le port ${HTTPS_PORT}`));

process.on('SIGTERM', () => { stats.save(); process.exit(0); });
process.on('uncaughtException', e => log('erreur :', e.stack || e.message));
