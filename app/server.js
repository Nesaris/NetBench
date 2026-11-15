#!/usr/bin/env node
// Sonde — banc de test du réseau de la maison (Freebox, Livebox, SFR Box, Bbox). Zéro dépendance.
// Écoute uniquement sur 127.0.0.1.
'use strict';
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const platform = require('./lib/platform');
const boxes = require('./lib/boxes');
const updater = require('./lib/updater');

const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
const PORT = +process.env.SONDE_PORT || 47800;
// Mode serveur : lancé par l'agent (VM de la box, Docker, Debian/Ubuntu), mesure en continu sans fenêtre ouverte
const HEADLESS = !!process.env.SONDE_HEADLESS;
const HOST = '127.0.0.1';
const DATA_DIR = platform.dataDir;
const HIST_FILE = path.join(DATA_DIR, 'history.json');

// ---------------------------------------------------------------- utilitaires
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const round = (v, d = 1) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

// ---------------------------------------------------------------- SSE
const clients = new Set();
let lastClientSeen = now();
let proxied = 0; // fenêtres ouvertes dont le flux passe par l'agent (mode « mesures par l'agent »)
const active = () => HEADLESS || clients.size > 0;
function broadcast(ev, data) {
  const msg = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

// ---------------------------------------------------------------- box
// La box se choisit au premier lancement (opérateur → détection du modèle → autorisation).
const BOX_FILE = path.join(DATA_DIR, 'box.json');
const store = {
  get(k, d) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'store-' + k + '.json'), 'utf8')); } catch { return d; } },
  set(k, v) { fs.writeFileSync(path.join(DATA_DIR, 'store-' + k + '.json'), JSON.stringify(v)); }
};
const boxCtx = { secrets: platform.secrets, store, platform, broadcast: (...a) => broadcast(...a), version: VERSION, log: (...a) => log(...a) };
let boxCfg = (() => { try { return JSON.parse(fs.readFileSync(BOX_FILE, 'utf8')); } catch { return null; } })();
let box = null;
function loadBox() { box = boxCfg ? boxes.ADAPTERS[boxCfg.box].create(boxCtx, boxCfg) : null; devCache = []; }
const GW = () => String(box?.host || boxCfg?.host || '192.168.1.254').split(':')[0];
const F = k => !!box?.features?.[k];
// Adresses de cet ordinateur : il ne peut pas se bloquer lui-même
const selfIps = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4').map(i => i.address);

// Veille : un téléphone endormi n'envoie que de rares trames à bas débit, sa puissance d'émission baisse
// et la box mesure alors un signal bien plus faible que la réalité. On garde le signal mesuré éveillé.
const SIG_FILE = path.join(DATA_DIR, 'signal-awake.json');
let sigAwake = {}; try { sigAwake = JSON.parse(fs.readFileSync(SIG_FILE, 'utf8')); } catch { }
let sigSaveT = 0;
function markSleep(d) {
  if (d.via === 'cable') return d;
  const quiet = (d.up * 1000 / 8) < 60 && d.down < 8; // appareil → box < 60 o/s
  d.asleep = quiet && d.lastAct != null && d.lastAct > 30;
  d.sigNow = d.signal;
  if (!d.asleep && d.signal != null) {
    const o = sigAwake[d.id];
    // moyenne glissante pour lisser, réinitialisée si l'appareil a changé de bande ou de borne
    const key = d.via + d.band;
    sigAwake[d.id] = o && o.key === key && Date.now() - o.t < 6 * 3600e3 ? { s: Math.round((o.s * 4 + d.signal) / 5), key, t: Date.now() } : { s: d.signal, key, t: Date.now() };
  }
  const a = sigAwake[d.id];
  if (d.asleep && a && a.key === d.via + d.band && Date.now() - a.t < 7 * 86400e3) { d.signal = a.s; d.sigAge = Math.round((Date.now() - a.t) / 60000); d.sigFromAwake = true; }
  if (Date.now() - sigSaveT > 60000) { sigSaveT = Date.now(); fs.writeFile(SIG_FILE, JSON.stringify(sigAwake), () => { }); }
  return d;
}

async function getDevices() {
  if (!box) throw Object.assign(new Error('Box non configurée'), { code: 'no_box' });
  const me = selfIps();
  return (await box.devices()).map(d => {
    d.isSelf = !!d.ip && me.includes(d.ip);
    d.gaming = d.isConsole && (d.down + d.up) > 120;
    return F('signal') ? markSleep(d) : d;
  }).sort((a, b) => (b.isConsole - a.isConsole) || a.name.localeCompare(b.name));
}

async function getOverview() { if (!box) throw Object.assign(new Error('Box non configurée'), { code: 'no_box' }); return box.overview(); }
// ---------------------------------------------------------------- Wi-Fi de l'ordinateur
const getMacWifi = () => platform.wifiInfo();
// ---------------------------------------------------------------- moteur de ping
// Chaque cible = un process `ping` ; échantillons diffusés en SSE.
const pings = new Map(); // key -> {proc, ip, name, samples:[{t,ms}]}
function startPing(key, ip, name, intervalSec = 0.25) {
  const old = pings.get(key); if (old) { try { old.proc.kill(); } catch { } }
  const st = { ip, name, samples: [], started: now() };
  st.proc = platform.pingStream(ip, intervalSec, s => {
    st.samples.push(s); if (st.samples.length > 20000) st.samples.shift();
    broadcast('ping', { key, t: s.t, ms: s.ms });
  });
  st.proc.onExit(() => { if (pings.get(key) === st) st.ended = now(); });
  pings.set(key, st);
  return st;
}
function stopPing(key) { const p = pings.get(key); if (p) { try { p.proc.kill(); } catch { } p.ended = p.ended || now(); } }
function stopAllPings() { for (const k of [...pings.keys()]) stopPing(k); }
// une nouvelle session efface les mesures de la précédente (gardées jusque-là pour pouvoir les enregistrer)
function newPingSession() { for (const [k, p] of pings) { try { p.proc.kill(); } catch { } } pings.clear(); }

function stats(samples, ref) {
  // ref : échantillons Mac→box ; on retire les instants où le Wi-Fi du Mac a lui-même un pic (>40 ms)
  let s = samples;
  let filtered = 0;
  if (ref && ref.length) {
    const bad = ref.filter(x => x.ms == null || x.ms > 40).map(x => x.t);
    if (bad.length) {
      const before = s.length;
      s = s.filter(x => !bad.some(b => Math.abs(b - x.t) < 400));
      filtered = before - s.length;
    }
  }
  const ok = s.filter(x => x.ms != null).map(x => x.ms);
  const n = s.length;
  if (!n) return { n: 0 };
  let jit = 0; for (let i = 1; i < ok.length; i++) jit += Math.abs(ok[i] - ok[i - 1]);
  const sorted = [...ok].sort((a, b) => a - b);
  return {
    n, filtered,
    min: round(sorted[0]), avg: round(ok.reduce((a, b) => a + b, 0) / (ok.length || 1)),
    p95: round(sorted[Math.floor(sorted.length * 0.95)] ?? null), max: round(sorted[sorted.length - 1]),
    jitter: round(ok.length > 1 ? jit / (ok.length - 1) : 0),
    loss: round((n - ok.length) / n * 100), spikes: ok.filter(v => v > 60).length
  };
}

// ---------------------------------------------------------------- moteur de charge
const DOWN_SRC = [
  'http://ping.online.net/10000Mo.dat',
  'https://scaleway.testdebit.info/10G.iso',
  'https://speed.cloudflare.com/__down?bytes=50000000'
];
const UP_URL = 'https://speed.cloudflare.com/__up';
const agentHttp = new http.Agent({ keepAlive: true, maxSockets: 64 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 64 });
const UP_CHUNK = crypto.randomBytes(1 << 20);

let load = null;
function startLoad({ mode = 'down', flows = 8, duration = 15 } = {}) {
  stopLoad();
  flows = Math.max(1, Math.min(32, +flows || 8));
  duration = Math.max(5, Math.min(120, +duration || 15));
  const L = load = { mode, flows, duration, started: now(), bytesDown: 0, bytesUp: 0, reqs: new Set(), series: [], errors: 0, running: true, boxPeakDown: 0, boxPeakUp: 0 };

  const downFlow = idx => {
    if (!L.running) return;
    const url = DOWN_SRC[idx % DOWN_SRC.length];
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { agent: url.startsWith('https') ? agentHttps : agentHttp, headers: { 'user-agent': 'Sonde/1.0' } }, res => {
      if (res.statusCode !== 200) { res.resume(); L.errors++; L.reqs.delete(req); return setTimeout(() => downFlow(idx + 1), 300); }
      res.on('data', d => { L.bytesDown += d.length; });
      res.on('end', () => { L.reqs.delete(req); downFlow(idx); });
      res.on('error', () => { });
    });
    req.on('error', () => { L.reqs.delete(req); if (L.running) { L.errors++; setTimeout(() => downFlow(idx + 1), 300); } });
    L.reqs.add(req);
  };
  const upFlow = () => {
    if (!L.running) return;
    const size = 25 << 20;
    const req = https.request(UP_URL, { method: 'POST', agent: agentHttps, headers: { 'content-type': 'application/octet-stream', 'content-length': size, 'user-agent': 'Sonde/1.0' } }, res => {
      res.resume(); res.on('end', () => { L.reqs.delete(req); upFlow(); });
    });
    req.on('error', () => { L.reqs.delete(req); if (L.running) { L.errors++; setTimeout(upFlow, 300); } });
    L.reqs.add(req);
    let sent = 0;
    const pump = () => {
      while (L.running && sent < size) {
        const n = Math.min(UP_CHUNK.length, size - sent);
        const chunk = n === UP_CHUNK.length ? UP_CHUNK : UP_CHUNK.subarray(0, n);
        sent += n;
        const okk = req.write(chunk, () => { L.bytesUp += n; });
        if (!okk) return req.once('drain', pump);
      }
      if (sent >= size) req.end();
    };
    pump();
  };

  const nDown = mode === 'up' ? 0 : (mode === 'both' ? Math.ceil(flows / 2) : flows);
  const nUp = mode === 'down' ? 0 : (mode === 'both' ? Math.ceil(flows / 2) : flows);
  for (let i = 0; i < nDown; i++) downFlow(i);
  for (let i = 0; i < nUp; i++) upFlow();

  let lastD = 0, lastU = 0, lastT = now();
  L.timer = setInterval(() => {
    const t = now(), dt = (t - lastT) / 1000;
    const md = (L.bytesDown - lastD) * 8 / dt / 1e6, mu = (L.bytesUp - lastU) * 8 / dt / 1e6;
    lastD = L.bytesDown; lastU = L.bytesUp; lastT = t;
    const pt = { t, macDown: round(md, 0), macUp: round(mu, 0), boxDown: wan.down, boxUp: wan.up };
    if (t - L.started > 2500) { L.boxPeakDown = Math.max(L.boxPeakDown, wan.down || 0); L.boxPeakUp = Math.max(L.boxPeakUp, wan.up || 0); }
    L.series.push(pt);
    broadcast('load', { ...pt, elapsed: (t - L.started) / 1000, duration: L.duration });
    if (t - L.started >= L.duration * 1000) finishLoad();
  }, 500);
  return L;
}
function summarizeLoad(L) {
  const warm = L.series.filter(p => p.t - L.started > 2500); // on ignore la montée en charge
  const avg = k => { const v = warm.map(p => p[k]).filter(x => x != null); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 0) : null; };
  const max = k => { const v = warm.map(p => p[k]).filter(x => x != null); return v.length ? Math.max(...v) : null; };
  return {
    mode: L.mode, flows: L.flows, duration: L.duration, errors: L.errors,
    macDownAvg: avg('macDown'), macDownMax: max('macDown'), macUpAvg: avg('macUp'), macUpMax: max('macUp'),
    boxDownAvg: avg('boxDown'), boxDownMax: L.boxPeakDown || max('boxDown'), boxUpAvg: avg('boxUp'), boxUpMax: L.boxPeakUp || max('boxUp'),
    totalMB: Math.round((L.bytesDown + L.bytesUp) / 1e6)
  };
}
function finishLoad() {
  const L = load; if (!L || !L.running) return null;
  L.running = false; clearInterval(L.timer);
  for (const r of L.reqs) { try { r.destroy(); } catch { } }
  L.reqs.clear();
  L.summary = summarizeLoad(L);
  broadcast('loadEnd', L.summary);
  if (L.onEnd) L.onEnd(L.summary);
  return L.summary;
}
function stopLoad() { if (load && load.running) finishLoad(); }
const loadDone = L => new Promise(r => { if (!L.running) return r(L.summary); L.onEnd = r; });

// ---------------------------------------------------------------- débit WAN de la box (temps réel)
const wan = { down: null, up: null, t: 0, hist: [] };
let wanBusy = false;
async function pollWan() {
  if (wanBusy) return; wanBusy = true;
  try {
    if (!box) return;
    const c = await box.wan();
    wan.down = c.down; wan.up = c.up; wan.t = now();
    wan.state = c.state; wan.bwDown = c.bwDown; wan.bwUp = c.bwUp;
    wan.hist.push({ t: wan.t, down: wan.down, up: wan.up }); if (wan.hist.length > 21600) wan.hist.shift();
    broadcast('wan', { t: wan.t, down: wan.down, up: wan.up, state: wan.state, bwDown: wan.bwDown, bwUp: wan.bwUp });
  } catch (e) { broadcast('wanError', { message: e.message, code: e.code }); }
  finally { wanBusy = false; }
}
let devCache = [];
let devBusy = false;
async function pollDevices() {
  if (devBusy) return; devBusy = true;
  try { devCache = await getDevices(); broadcast('devices', devCache); await checkNewDevices(devCache); } catch (e) { broadcast('devError', { message: e.message, code: e.code }); }
  finally { devBusy = false; }
}
// ---------------------------------------------------------------- nouveaux appareils : détection + nom automatique
const KNOWN_FILE = path.join(DATA_DIR, 'known.json'), SET_FILE = path.join(DATA_DIR, 'settings.json');
const settings = Object.assign({ autoName: true }, (() => { try { return JSON.parse(fs.readFileSync(SET_FILE, 'utf8')); } catch { return {}; } })());
let known = (() => { try { return new Set(JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8'))); } catch { return null; } })();
async function checkNewDevices(list) {
  if (!known) { known = new Set(list.map(d => d.id)); fs.writeFileSync(KNOWN_FILE, JSON.stringify([...known])); return; } // premier lancement : tout l'existant est « connu »
  let changed = false;
  for (const d of list) {
    if (known.has(d.id)) continue;
    known.add(d.id); changed = true;
    const nm = (d.name || '').trim();
    const generic = !d.manual && (!nm || GENERIC.test(nm) || nm === d.vendor);
    let renamed = null;
    if (settings.autoName && generic && d.suggest && F('rename') && box.canRenameId(d.id)) {
      try { await box.rename(d.id, d.suggest); renamed = d.suggest; } catch (e) { log('nommage auto:', e.message); }
    }
    const ev = { kind: 'newdev', id: crypto.randomBytes(4).toString('hex'), device: renamed || d.name || d.suggest || d.id, oldName: d.name, renamed, model: d.model, via: d.via, band: d.band, ip: d.ip, start: now(), end: now(), randomMac: d.randomMac };
    watch.events.unshift(ev); watch.events = watch.events.slice(0, 500); fs.writeFile(EVT_FILE, JSON.stringify(watch.events), () => { });
    broadcast('wevent', ev); broadcast('newdev', ev);
  }
  if (changed) fs.writeFile(KNOWN_FILE, JSON.stringify([...known]), () => { });
}
// Wi-Fi du Mac poussé toutes les 5 s
setInterval(async () => { if (clients.size) broadcast('mac', await getMacWifi()); }, 4000);
setInterval(() => { if (active() || (load && load.running)) pollWan(); }, HEADLESS ? 1000 : 500);
setInterval(() => { if (active()) pollDevices(); }, HEADLESS ? 2000 : 1000);

// ---------------------------------------------------------------- surveillance continue (tant que l'app est ouverte)
// Ping permanent des consoles + box + Internet, agrégé chaque seconde, avec journal des pics.
const JOUR_DIR = path.join(DATA_DIR, 'journal'); fs.mkdirSync(JOUR_DIR, { recursive: true });
const EVT_FILE = path.join(DATA_DIR, 'events.json');
const watch = { procs: new Map(), buf: new Map(), hist: new Map(), pending: [], macNoise: 0, rows: [], events: (() => { try { return JSON.parse(fs.readFileSync(EVT_FILE, 'utf8')); } catch { return []; } })(), open: new Map() };
function watchTarget(key, ip, name, meta) {
  const cur = watch.procs.get(key);
  if (cur && cur.ip === ip) { cur.name = name; cur.meta = meta; return; }
  if (cur) { try { cur.proc.kill(); } catch { } }
  const live = !meta || meta.console; // consoles, box et Internet : 4/s et en direct ; autres appareils : 1/s
  const st = { ip, name, meta, seen: now() };
  watch.procs.set(key, st); watch.buf.set(key, []); watch.hist.set(key, []);
  st.proc = platform.pingStream(ip, live ? 0.25 : 1, smp0 => {
    {
      const v = smp0.ms;
      const smp = { t: smp0.t, ms: v };
      watch.buf.get(key)?.push(smp);
      const h = watch.hist.get(key); if (h) { h.push(smp); while (h.length && h[0].t < smp.t - 30000) h.shift(); }
      if (key === 'ref') { if (live) broadcast('wping', { key, t: smp.t, ms: v }); }
      else watch.pending.push({ key, smp, live }); // décidé ~0,6 s plus tard, une fois les pings de référence arrivés
    }
  });
  st.proc.onExit(() => { if (watch.procs.get(key) === st) watch.procs.delete(key); });
}
// Un ping est « bruit du Mac » si, au même moment, le ping Mac → box a lui aussi décroché (> 40 ms ou perdu) :
// le problème est alors sur le Wi-Fi du Mac, pas sur l'appareil.
function isMacNoise(smp) {
  const ref = watch.hist.get('ref'); if (!ref || !ref.length) return false;
  const a0 = smp.t - (smp.ms ?? 1000) - 150, a1 = smp.t + 150;
  return ref.some(r => (r.ms == null || r.ms > 40) && r.t - (r.ms ?? 1000) <= a1 && r.t >= a0);
}
setInterval(() => {
  const lim = now() - 600, keep = [];
  for (const p of watch.pending) {
    if (p.smp.t > lim) { keep.push(p); continue; }
    p.smp.noise = isMacNoise(p.smp);
    if (p.smp.noise) watch.macNoise++;
    if (p.live) broadcast('wping', { key: p.key, t: p.smp.t, ms: p.smp.ms, noise: p.smp.noise });
  }
  watch.pending = keep;
}, 200);
function watchStopAll() { for (const [, w] of watch.procs) { try { w.proc.kill(); } catch { } } watch.procs.clear(); }
function syncWatchTargets() {
  if (!active()) return watchStopAll();
  if (!box) return watchStopAll();
  const want = new Map([['ref', { ip: GW(), name: `Box (référence ${platform.label})` }], ['inet', { ip: '1.1.1.1', name: 'Internet · 1.1.1.1' }]]);
  for (const d of devCache) if (d.ip) want.set(d.id, { ip: d.ip, name: d.name, meta: { console: d.isConsole, via: d.via, band: d.band, signal: d.signal, linkTx: d.linkTx } });
  for (const [k, w] of want) watchTarget(k, w.ip, w.name, w.meta);
  for (const k of [...watch.procs.keys()]) if (!want.has(k)) { try { watch.procs.get(k).proc.kill(); } catch { } watch.procs.delete(k); }
}
setInterval(syncWatchTargets, 3000);
// Journal seconde par seconde (débit de la box + ping des consoles), écrit par paquets toutes les 10 s
// pour ménager le disque, et limité en taille : les jours les plus anciens partent en premier.
const JOURNAL_MAX = (+process.env.SONDE_JOURNAL_MB || 1500) * 1e6;
let jbuf = [];
function journalAppend(row) { jbuf.push(row); }
function flushJournal() {
  if (!jbuf.length) return; const rows = jbuf; jbuf = [];
  const by = {}; for (const r of rows) (by[new Date(r.t).toISOString().slice(0, 10)] ||= []).push(JSON.stringify(r));
  for (const [d, ls] of Object.entries(by)) fs.appendFile(path.join(JOUR_DIR, d + '.jsonl'), ls.join('\n') + '\n', () => { });
}
setInterval(flushJournal, 10000);
function pruneJournal() {
  try {
    const fl = fs.readdirSync(JOUR_DIR).filter(f => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort().map(f => ({ f, size: fs.statSync(path.join(JOUR_DIR, f)).size }));
    let tot = fl.reduce((a, x) => a + x.size, 0);
    const old = new Date(now() - 90 * 86400e3).toISOString().slice(0, 10);
    for (const x of fl.slice(0, -1)) { if (tot <= JOURNAL_MAX && x.f.slice(0, 10) >= old) break; fs.rmSync(path.join(JOUR_DIR, x.f), { force: true }); tot -= x.size; }
  } catch { }
}
setInterval(pruneJournal, 3600e3); setTimeout(pruneJournal, 60e3);
// Historique pour les graphiques : jusqu'à 600 points, en gardant le pire de chaque tranche (les pics restent visibles)
async function liveHistory(rangeS) {
  const since = now() - rangeS * 1000;
  let rows = watch.rows.filter(r => r.t >= since);
  if (!rows.length || rows[0].t > since + 60e3) {
    const days = new Set(); for (let t = since; t <= now() + 86400e3; t += 86400e3) days.add(new Date(t).toISOString().slice(0, 10));
    const fromFiles = [];
    for (const d of [...days].sort()) { try { for (const l of fs.readFileSync(path.join(JOUR_DIR, d + '.jsonl'), 'utf8').split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (r.t >= since) fromFiles.push(r); } catch { } } } catch { } }
    const first = rows.length ? rows[0].t : Infinity;
    rows = fromFiles.filter(r => r.t < first).concat(rows);
  }
  const N = 600, span = rangeS * 1000 / N, wanB = new Map(), pB = {};
  for (const r of rows) {
    const b = Math.floor((r.t - since) / span), t = Math.round(since + (b + 1) * span);
    const w = wanB.get(b) || [t, null, null];
    if (r.wan?.d != null) w[1] = Math.max(w[1] ?? 0, r.wan.d); if (r.wan?.u != null) w[2] = Math.max(w[2] ?? 0, r.wan.u);
    wanB.set(b, w);
    for (const [name, x] of Object.entries(r.p || {})) {
      const m = (pB[name] ||= new Map()); const o = m.get(b) || { t, max: null, lost: 0, n: 0 };
      if (x.max != null) o.max = Math.max(o.max ?? 0, x.max); o.lost += x.lost || 0; o.n += x.n || 0; m.set(b, o);
    }
  }
  const pings = {}; for (const [name, m] of Object.entries(pB)) pings[name] = [...m.values()].map(o => [o.t, o.max == null && o.lost ? null : o.max]);
  return { since, rangeS, wan: [...wanB.values()], pings, oldest: rows[0]?.t || null };
}
setInterval(() => {
  if (!watch.procs.size) return;
  const t = now(), row = { t, wan: { d: wan.down, u: wan.up }, p: {} };
  const refS = watch.buf.get('ref') || [];
  const refBad = refS.some(x => x.ms == null || x.ms > 40);
  for (const [k, w] of watch.procs) {
    const all = watch.buf.get(k) || []; // on laisse 0,7 s aux pings de référence pour arriver
    const smp = all.filter(x => x.t < t - 700); watch.buf.set(k, all.filter(x => x.t >= t - 700));
    if (!smp.length) continue;
    const clean = k === 'ref' ? smp : smp.filter(x => !isMacNoise(x));
    const noisy = smp.length - clean.length;
    const ok = clean.filter(x => x.ms != null).map(x => x.ms);
    const r = { n: clean.length, noise: noisy, lost: clean.length - ok.length, max: ok.length ? Math.max(...ok) : null, avg: ok.length ? round(ok.reduce((a, b) => a + b, 0) / ok.length) : null };
    if (!w.meta || w.meta.console) row.p[w.name] = r;
    // pic sur une console
    if (w.meta && w.meta.console && ((r.max != null && r.max > 60) || r.lost > 0)) {
      const top = devCache.filter(d => d.down + d.up > 300).sort((a, b) => (b.down + b.up) - (a.down + a.up)).slice(0, 3).map(d => ({ name: d.name, down: d.down, up: d.up }));
      let e = watch.open.get(k);
      if (e && t - e.last < 5000) { e.last = t; e.end = t; if (r.max != null && r.max > (e.peak || 0)) e.peak = r.max; e.lost += r.lost; e.wanMax = Math.max(e.wanMax || 0, wan.down || 0); if (refBad) e.macNoise = true; }
      else {
        e = { id: crypto.randomBytes(4).toString('hex'), device: w.name, start: t, end: t, last: t, peak: r.max, lost: r.lost, wanMax: wan.down || 0, wanUp: wan.up || 0, top, meta: w.meta, macNoise: refBad, refMax: refS.length ? Math.max(...refS.map(x => x.ms ?? 999)) : null };
        watch.open.set(k, e);
      }
    }
    const e = watch.open.get(k);
    if (e && t - e.last >= 5000) { watch.open.delete(k); delete e.last; e.cause = eventCause(e); watch.events.unshift(e); watch.events = watch.events.slice(0, 500); fs.writeFile(EVT_FILE, JSON.stringify(watch.events), () => { }); broadcast('wevent', e); }
  }
  watch.rows.push(row); if (watch.rows.length > 21600) watch.rows.shift();
  journalAppend(row);
  broadcast('wrow', row);
}, 1000);
// Recherches Wi-Fi lancées sur le Mac (ex. page Wi-Fi des Réglages ouverte) : elles font décrocher la carte Wi-Fi.
let macScan = { n: 0, procs: [], t: 0 };
if (platform.OS === 'mac') setInterval(async () => { if (!clients.size) return; const r = await platform.wifiScans(); if (r) { macScan = r; broadcast('macscan', macScan); } }, 15000);
function eventCause(e) {
  if (e.macNoise) return `Le Wi‑Fi du ${platform.label} avait lui aussi un pic à ce moment : mesure peut-être faussée.`;
  if (e.wanMax > 500) return `La fibre recevait ${e.wanMax >= 1000 ? (Math.round(e.wanMax / 100) / 10 + ' Gb/s') : e.wanMax + ' Mb/s'} à ce moment (gros téléchargement dans la maison).`;
  if (e.top && e.top.length) return `Trafic à ce moment : ${e.top.map(x => `${x.name} ↓${x.down >= 1000 ? Math.round(x.down / 1000) + ' Mb/s' : x.down + ' kb/s'}`).join(', ')}.`;
  if (e.meta && e.meta.signal != null && e.meta.signal < -70) return `Signal faible de la console (${e.meta.signal} dBm via ${e.meta.via === 'repeteur' ? 'le répéteur' : 'la box'}) : interférence ou micro-coupure Wi‑Fi.`;
  if (!F('perDeviceRate')) return 'La box ne donne pas le trafic par appareil : cause exacte inconnue (gros téléchargement ou perturbation Wi‑Fi).';
  return 'Aucun gros trafic visible : probablement une perturbation Wi‑Fi (voisins, micro-ondes, répéteur).';
}

// ---------------------------------------------------------------- networkQuality (Apple)
const runNQ = () => platform.networkQuality();
// ---------------------------------------------------------------- test complet
let full = null;
async function runFull(targets, opts = {}) {
  if (full && full.running) throw new Error('Un test complet est déjà en cours');
  const F = full = { running: true, started: now(), steps: [], targets };
  const step = (id, label, state, data) => { broadcast('full', { id, label, state, data }); };
  const all = [{ key: 'ref', ip: GW(), name: `Box (référence ${platform.label})` }, { key: 'inet', ip: '1.1.1.1', name: 'Internet · 1.1.1.1' }, ...targets.map(t => ({ key: 'd:' + t.id, ip: t.ip, name: t.name }))];
  F.started = now(); newPingSession();
  const window = async (label, ms, fn) => {
    const t0 = now(); if (fn) fn();
    await sleep(ms);
    const t1 = now();
    const ref = pings.get('ref')?.samples.filter(s => s.t >= t0 && s.t <= t1) || [];
    const res = {};
    for (const a of all) {
      const smp = pings.get(a.key)?.samples.filter(s => s.t >= t0 && s.t <= t1) || [];
      res[a.key] = { name: a.name, raw: stats(smp), clean: a.key === 'ref' ? null : stats(smp, ref) };
    }
    return res;
  };
  const report = { date: new Date().toISOString(), kind: 'full', targets: all.map(a => ({ key: a.key, name: a.name })) };
  try {
    for (const a of all) startPing(a.key, a.ip, a.name, 0.25);
    report.mac = await getMacWifi();
    step('idle', 'Latence au repos', 'run');
    report.idle = await window('idle', (opts.idle || 15) * 1000);
    step('idle', 'Latence au repos', 'done', report.idle);
    if (!F.running) throw new Error('Arrêté');

    step('down', 'Téléchargement + ping sous charge', 'run');
    let L = startLoad({ mode: 'down', flows: opts.flows || 8, duration: opts.dur || 15 });
    report.downPing = await window('down', (opts.dur || 15) * 1000);
    report.down = await loadDone(L);
    step('down', 'Téléchargement + ping sous charge', 'done', { load: report.down, ping: report.downPing });
    if (!F.running) throw new Error('Arrêté');
    await sleep(2000);

    step('up', 'Envoi + ping sous charge', 'run');
    L = startLoad({ mode: 'up', flows: Math.max(4, (opts.flows || 8) - 2), duration: opts.dur || 12 });
    report.upPing = await window('up', (opts.dur || 12) * 1000);
    report.up = await loadDone(L);
    step('up', 'Envoi + ping sous charge', 'done', { load: report.up, ping: report.upPing });

    report.verdict = verdict(report);
    F.report = report;
    step('verdict', 'Verdict', 'done', report.verdict);
    saveHistory(report);
    broadcast('fullEnd', report);
    return report;
  } catch (e) {
    broadcast('fullEnd', { error: e.message });
    throw e;
  } finally {
    stopLoad(); for (const a of all) stopPing(a.key); F.running = false;
  }
}
function verdict(r) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const ii = r.idle?.inet?.raw, ir = r.idle?.ref?.raw;
  if (ii?.avg != null) add(ii.avg < 15 ? 'ok' : ii.avg < 30 ? 'warn' : 'bad', `Latence Internet au repos : ${ii.avg} ms (min ${ii.min}).`);
  if (ir?.avg != null) add(ir.avg < 6 ? 'ok' : 'warn', `${platform.label} vers la box : ${ir.avg} ms en moyenne, max ${ir.max} ms.`);
  if (r.down) {
    add('info', r.down.boxDownMax ? `La box a reçu jusqu'à ${r.down.boxDownMax} Mb/s pendant le test${wan.bwDown ? ` (sur ${Math.round(wan.bwDown)} possibles)` : ''}. Le ${platform.label} seul : ${r.down.macDownAvg} Mb/s en moyenne.` : `Le ${platform.label} a reçu ${r.down.macDownAvg} Mb/s en moyenne (la box ne donne pas son débit total).`);
    const macLim = r.mac?.rate ? Math.round(r.mac.rate * 0.75) : null;
    if (macLim && r.down.macDownAvg < macLim * 0.6) add('warn', `Le ${platform.label} télécharge bien en dessous de ce que permet son lien Wi‑Fi (${r.mac.rate} Mb/s) : serveurs ou Wi‑Fi saturé.`);
    else if (macLim) add('ok', `Le ${platform.label} est limité par son propre lien Wi‑Fi (${r.mac.rate} Mb/s), pas par la fibre.`);
  }
  if (r.up) add('info', `Envoi : ${r.up.macUpAvg} Mb/s depuis le ${platform.label}${r.up.boxUpMax ? ` (box : jusqu'à ${r.up.boxUpMax} Mb/s)` : ''}.`);
  const loaded = r.downPing?.ref?.raw;
  if (ir?.avg != null && loaded?.avg != null) {
    const d = round(loaded.avg - ir.avg);
    add(d < 15 ? 'ok' : d < 40 ? 'warn' : 'bad', `Sous charge, le ping vers la box monte de ${d} ms (gonflement de file d'attente).`);
  }
  for (const k of Object.keys(r.idle || {})) {
    if (!k.startsWith('d:')) continue;
    const i = r.idle[k], dn = r.downPing?.[k];
    const c = i.clean || i.raw;
    if (!c || !c.n) { add('warn', `${i.name} : pas de réponse au ping (éteint, en veille ou pare-feu).`); continue; }
    const lvl = (c.loss > 2 || c.spikes > 3) ? 'bad' : (c.loss > 0 || c.spikes > 0 || c.max > 40) ? 'warn' : 'ok';
    let t = `${i.name} au repos : moy ${c.avg} ms, max ${c.max} ms, ${c.spikes} pic(s) > 60 ms, ${c.loss} % de pertes`;
    const dc = dn?.clean || dn?.raw;
    if (dc?.n) t += ` · sous charge : moy ${dc.avg} ms, max ${dc.max} ms`;
    add(lvl, t + '.');
  }
  return out;
}

// ---------------------------------------------------------------- scan (inventaire + ping de chaque appareil + comparaison)
const SCAN_FILE = path.join(DATA_DIR, 'scans.json');
function readScans() { try { return JSON.parse(fs.readFileSync(SCAN_FILE, 'utf8')); } catch { return []; } }
const pingBurst = (ip, count) => platform.pingBurst(ip, count);
let scanning = false;
async function runScan() {
  if (scanning) throw new Error('Scan déjà en cours');
  scanning = true;
  try {
    broadcast('scan', { state: 'run', step: 'Lecture de la box' });
    const [devs, ov] = await Promise.all([getDevices(), getOverview()]);
    broadcast('scan', { state: 'run', step: `Ping de ${devs.filter(d => d.ip).length} appareils (5 s)` });
    const refP = pingBurst(GW());
    const res = await Promise.all(devs.map(d => d.ip ? pingBurst(d.ip) : Promise.resolve(null)));
    const refS = await refP;
    const ref = stats(refS);
    // valeurs nettes : on retire les instants où le Wi-Fi du Mac avait lui-même un pic
    devs.forEach((d, i) => { if (res[i]) { d.pingRaw = stats(res[i]); d.ping = stats(res[i], refS); } else d.ping = null; });
    const prev = readScans()[0] || null;
    const prevMap = new Map((prev?.devices || []).map(d => [d.id, d]));
    const curMap = new Map(devs.map(d => [d.id, d]));
    const added = devs.filter(d => !prevMap.has(d.id)).map(d => d.id);
    const removed = prev ? prev.devices.filter(d => !curMap.has(d.id)).map(d => ({ id: d.id, name: d.name, ip: d.ip, type: d.type, vendor: d.vendor })) : [];
    const changes = [];
    const lbl = { ip: 'Adresse IP', via: 'Connecté via', band: 'Bande Wi‑Fi', name: 'Nom', linkTx: 'Lien' };
    if (prev) for (const d of devs) {
      const o = prevMap.get(d.id); if (!o) continue;
      for (const k of ['name', 'ip', 'via', 'band']) if ((o[k] || null) !== (d[k] || null)) changes.push({ id: d.id, name: d.name, field: lbl[k], from: o[k], to: d[k] });
      if (o.signal != null && d.signal != null && Math.abs(o.signal - d.signal) >= 8) changes.push({ id: d.id, name: d.name, field: 'Signal', from: o.signal + ' dBm', to: d.signal + ' dBm' });
    }
    const alerts = [];
    const A = (level, text, id) => alerts.push({ level, text, id });
    for (const d of devs) {
      if (d.isConsole && d.band === '2d4g') A('warn', `${d.name} est en 2,4 GHz : lien lent (${d.linkTx || '—'} Mb/s).`, d.id);
      if (d.signal != null && d.signal < -75 && !d.asleep) A('warn', `${d.name} capte mal (${d.signal} dBm via ${d.via === 'repeteur' ? 'le répéteur' : 'la box'}).`, d.id);
      if (d.via === 'cable' && d.linkTx && d.linkTx < 1000 && d.ethMax !== 100) A(d.isConsole ? 'warn' : 'info', `${d.name} est branché à ${d.linkTx} Mb/s seulement${d.port ? ' (' + d.port + ')' : ''} : câble, adaptateur ou CPL limité à 100 Mb/s.`, d.id);
      if (d.ping && d.ping.n && d.isConsole && (d.ping.loss > 0 || d.ping.max > 60)) A(d.ping.loss >= 10 || d.ping.max > 100 ? 'bad' : 'warn', (d.ping.loss > 0 ? `${d.name} : ${d.ping.loss} % de pings perdus sur 5 s (moy ${d.ping.avg} ms, max ${d.ping.max} ms).` : `${d.name} : pic à ${d.ping.max} ms pendant le scan (moy ${d.ping.avg} ms, aucune perte).`), d.id);
      if (d.ip && d.ping && d.ping.n && d.ping.loss === 100 && !d.isConsole) A('info', `${d.name} ne répond pas au ping (veille ou pare-feu).`, d.id);
    }
    if (ov.wifi?.powerSaving) A('warn', 'Économie d\'énergie Wi‑Fi activée sur la box : une radio peut se couper.');
    if (ov.repeater?.signal != null && ov.repeater.signal < -65) A('warn', `Lien répéteur → box faible (${ov.repeater.signal} dBm).`);
    if (ov.connection?.state && ov.connection.state !== 'up') A('bad', 'Fibre non connectée.');
    const fr = v => String(v).replace('.', ',');
    for (const a of alerts) a.text = a.text.replace(/(\d)\.(\d)/g, '$1,$2');
    const scan = { date: new Date().toISOString(), ref, devices: devs, added, removed, changes, alerts, first: !prev, prevDate: prev?.date || null };
    const all = readScans(); all.unshift(scan); fs.writeFileSync(SCAN_FILE, JSON.stringify(all.slice(0, 40)));
    broadcast('scan', { state: 'done' });
    return scan;
  } catch (e) { broadcast('scan', { state: 'error', message: e.message }); throw e; }
  finally { scanning = false; }
}

// ---------------------------------------------------------------- rapports comparables
// Un rapport = des valeurs par appareil (nom) + éventuellement les courbes de ping.
const REP_FILE = path.join(DATA_DIR, 'reports.json');
const SEED = [];
function readReports() {
  try { return JSON.parse(fs.readFileSync(REP_FILE, 'utf8')); }
  catch { fs.writeFileSync(REP_FILE, JSON.stringify(SEED)); return JSON.parse(JSON.stringify(SEED)); }
}
const writeReports = r => fs.writeFileSync(REP_FILE, JSON.stringify(r));
function reportFromPings(name, since, until, statsOverride) {
  const devs = {};
  const ref = pings.get('ref')?.samples.filter(x => x.t >= since && x.t <= until) || [];
  for (const [k, p] of pings) {
    const smp = p.samples.filter(x => x.t >= since && x.t <= until);
    if (!smp.length) continue;
    const badRef = k === 'ref' ? [] : ref.filter(x => x.ms == null || x.ms > 40).map(x => x.t);
    const curve = badRef.length ? smp.filter(x => !badRef.some(b => Math.abs(b - x.t) < 400)) : smp;
    const st = k === 'ref' ? stats(smp) : stats(smp, ref);
    const raw = stats(smp);
    const minutes = Math.max(1 / 60, (smp[smp.length - 1].t - smp[0].t) / 60000);
    const d = devCache.find(x => x.ip === p.ip);
    // courbe : une valeur par demi-seconde au plus (max par tranche, pour garder les pics)
    const series = []; let bucket = null;
    for (const x of curve) {
      const b = Math.floor((x.t - since) / 500);
      if (!bucket || bucket.b !== b) { if (bucket) series.push([bucket.b / 2, bucket.v]); bucket = { b, v: x.ms }; }
      else if (x.ms == null || (bucket.v != null && x.ms > bucket.v)) bucket.v = x.ms;
    }
    if (bucket) series.push([bucket.b / 2, bucket.v]);
    const o = statsOverride?.[k];
    const use = o || st;
    devs[p.name] = {
      conn: d ? (d.via === 'cable' ? `Câble${d.linkTx ? ' · ' + d.linkTx + ' Mb/s' : ''}` : `${d.via === 'repeteur' ? 'Répéteur' : 'Box'}${d.band ? ', ' + ({ '2d4g': '2,4 GHz', '5g': '5 GHz', '6g': '6 GHz' })[d.band] : ''}${d.signal != null ? ', ' + d.signal + ' dBm' : ''}`) : (k === 'ref' ? `${platform.label} → box` : k === 'inet' ? `${platform.label} → Internet` : ''),
      link: d?.linkTx || null, avg: use.avg, min: use.min, max: use.max, jitter: use.jitter, loss: use.loss,
      spikesPerMin: round(use.spikes / minutes, 2), spikesTxt: `${use.spikes} en ${round(minutes, 1)} min`,
      rawAvg: raw.avg, rawMax: raw.max, n: smp.length, series
    };
  }
  return { id: crypto.randomBytes(6).toString('hex'), name: String(name || 'Test').slice(0, 60), date: new Date().toISOString(), kind: 'test', durationS: Math.round((until - since) / 1000), devices: devs };
}

// ---------------------------------------------------------------- historique
function readHistory() { try { return JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch { return []; } }
function saveHistory(entry) {
  const h = readHistory(); h.unshift(entry); fs.writeFileSync(HIST_FILE, JSON.stringify(h.slice(0, 200)));
}

// ---------------------------------------------------------------- agent de la VM (services, sites)
// Connexion HTTPS avec certificat auto-signé : son empreinte est mémorisée au premier contact
// (comme SSH), puis toute autre empreinte est refusée.
const AGENT_FILE = path.join(DATA_DIR, 'agent.json');
// Le jeton de connexion au serveur est rangé dans le coffre du système (trousseau / DPAPI), pas dans un fichier.
const agentCfg = () => { let c = {}; try { c = JSON.parse(fs.readFileSync(AGENT_FILE, 'utf8')); } catch { } if (c.token) { platform.secrets.set('agent-token', c.token); delete c.token; fs.writeFileSync(AGENT_FILE, JSON.stringify(c), { mode: 0o600 }); } const t = c.url ? platform.secrets.get('agent-token') : null; return t ? { ...c, token: t } : c; };
const saveAgent = c => { const { token, ...rest } = c; if (token) platform.secrets.set('agent-token', token); else platform.secrets.del('agent-token'); fs.writeFileSync(AGENT_FILE, JSON.stringify(rest), { mode: 0o600 }); };
// Pas de reprise de session TLS : le certificat est relu et vérifié à chaque connexion.
const agentHttpsAgent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
function agentReq(method, p, payload, opts = {}) {
  const c = { ...agentCfg(), ...opts };
  if (!c.url) return Promise.reject(Object.assign(new Error('Agent non configuré'), { status: 412 }));
  const u = new URL(p, c.url);
  // Agent lancé par Sonde sur cet ordinateur : HTTP sur 127.0.0.1 seulement, pas de certificat
  if (u.protocol === 'http:') {
    if (u.hostname !== '127.0.0.1') return Promise.reject(Object.assign(new Error('Adresse d\'agent refusée'), { status: 400 }));
    return fetch(u, { method, headers: { 'content-type': 'application/json', ...(c.token && !opts.noAuth ? { authorization: 'Bearer ' + c.token } : {}) }, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(8000) })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})), fp: null }))
      .catch(e => { throw Object.assign(new Error('Agent local injoignable'), { status: 502 }); });
  }
  let seenFp = null;
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const req = https.request(u, {
      method, timeout: 8000, rejectUnauthorized: false, agent: agentHttpsAgent,
      checkServerIdentity: (host, cert) => { seenFp = cert && cert.fingerprint256; if (c.fp && seenFp !== c.fp) return Object.assign(new Error('Certificat de l\'agent différent de celui mémorisé : connexion refusée.'), { status: 495 }); },
      headers: { 'content-type': 'application/json', ...(c.token && !opts.noAuth ? { authorization: 'Bearer ' + c.token } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) }
    }, res => {
      const fp = seenFp || res.socket.getPeerCertificate()?.fingerprint256;
      if (c.fp && fp !== c.fp) { res.resume(); return reject(Object.assign(new Error('Certificat de l\'agent différent de celui mémorisé : connexion refusée.'), { status: 495 })); }
      let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch { } resolve({ status: res.statusCode, body: j, fp }); });
    });
    req.on('timeout', () => req.destroy(new Error('Agent injoignable (délai dépassé)')));
    req.on('error', e => reject(Object.assign(e, { status: 502 })));
    if (data) req.write(data); req.end();
  });
}

// ---------------------------------------------------------------- agent sur cet ordinateur (mode « tant que Sonde est ouvert »)
const LOCAL_AGENT_PORT = 47853;
let localAgent = null;
function agentDir() { for (const d of [path.join(__dirname, 'agent'), path.join(__dirname, '..', 'agent')]) if (fs.existsSync(path.join(d, 'agent.js'))) return d; return null; }
async function startLocalAgent() {
  const dir = agentDir(); if (!dir) return { ok: false, error: 'Fichiers de l\'agent introuvables' };
  if (!localAgent || localAgent.exitCode != null) {
    const { spawn } = require('node:child_process');
    localAgent = spawn(process.execPath, [path.join(dir, 'agent.js')], { env: { ...process.env, SONDE_API: 'local', SONDE_PORT: String(LOCAL_AGENT_PORT), SONDE_DATA: path.join(DATA_DIR, 'agent'), SONDE_BOX: GW(), SONDE_MIN_FREE_GB: '2' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    localAgent.stdout.on('data', d => log('[agent]', String(d).trim())); localAgent.stderr.on('data', d => log('[agent]', String(d).trim()));
  }
  for (let i = 0; i < 30; i++) { try { const r = await fetch(`http://127.0.0.1:${LOCAL_AGENT_PORT}/api/health`, { signal: AbortSignal.timeout(1000) }); if (r.ok) break; } catch { } await sleep(200); }
  const c = agentCfg();
  if (!c.local) saveAgent({ url: `http://127.0.0.1:${LOCAL_AGENT_PORT}`, local: true });
  settings.localAgent = true; fs.writeFileSync(SET_FILE, JSON.stringify(settings));
  return { ok: true };
}
function stopLocalAgent() { if (localAgent) { try { localAgent.kill(); } catch { } localAgent = null; } }
// Noms des appareils (lus dans la box) envoyés à l'agent, pour qu'il sache qui est qui hors Freebox
setInterval(async () => { const c = agentCfg(); if (!c.url || !c.token || !devCache.length || box?.id === 'freebox') return; try { await agentReq('POST', '/api/names', { devices: devCache.filter(d => d.ip && d.mac).map(d => ({ mac: d.mac, ip: d.ip, name: d.name, via: d.via, band: d.band, signal: d.signal })) }); } catch { } }, 30000);

// ---------------------------------------------------------------- HTTP
const INDEX = path.join(__dirname, 'index.html');
function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(b);
}
function body(req) {
  return new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
}
const okHost = h => h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`;

// ---------------------------------------------------------------- mode « mesures par l'agent »
// L'app ne mesure plus rien elle-même : toutes les routes du moteur sont relayées vers l'agent (HTTPS, certificat épinglé).
const LOCAL_ONLY = /^\/api\/(update|agent\/|mode$|quit$|logo$)/;
// Sans jeton, on ne repasse pas en douce sur les mesures locales : l'app demande de se connecter au serveur.
const remoteOn = () => { if (HEADLESS || !settings.remote) return false; const c = agentCfg(); return !!(c.url && !c.local); };
function proxyToAgent(req, res, p, search) {
  const c = agentCfg();
  const u = new URL('/api/engine/' + p.slice(5) + search, c.url);
  let seenFp = null;
  const sse = p === '/api/stream';
  const up = https.request(u, {
    method: req.method, rejectUnauthorized: false, agent: agentHttpsAgent, timeout: sse ? 0 : 60000,
    checkServerIdentity: (h, cert) => { seenFp = cert && cert.fingerprint256; if (c.fp && seenFp !== c.fp) return new Error('Certificat de l\'agent différent de celui mémorisé'); },
    headers: { ...(c.token ? { authorization: 'Bearer ' + c.token } : {}), 'content-type': req.headers['content-type'] || 'application/json', ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}) }
  }, ur => {
    const fp = seenFp || ur.socket.getPeerCertificate()?.fingerprint256;
    if (c.fp && fp !== c.fp) { ur.resume(); return send(res, 495, { error: 'Certificat de l\'agent différent de celui mémorisé : connexion refusée.' }); }
    if (ur.statusCode === 401) { ur.resume(); const { token, ...rest } = c; saveAgent(rest); return send(res, 401, { error: 'Connexion au serveur Sonde requise', needAgentLogin: true, agent: c.url, user: c.user || null }); }
    if (sse) { proxied++; lastClientSeen = now(); res.on('close', () => { proxied--; lastClientSeen = now(); up.destroy(); }); }
    res.writeHead(ur.statusCode, { 'content-type': ur.headers['content-type'] || 'application/json', 'cache-control': 'no-store', ...(sse ? { connection: 'keep-alive' } : {}) });
    ur.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('délai dépassé')));
  up.on('error', e => { if (!res.headersSent) send(res, 502, { error: 'Agent injoignable : ' + e.message, remoteDown: true }); else try { res.end(); } catch { } });
  req.pipe(up);
}

async function handler(req, res, opts = {}) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (!opts.embedded) {
    // Protection contre le DNS rebinding / appels d'autres sites
    if (!okHost(req.headers.host)) { res.writeHead(403); return res.end(); }
    if (req.method !== 'GET' && req.headers.origin && !okHost((req.headers.origin || '').replace(/^https?:\/\//, ''))) { res.writeHead(403); return res.end(); }
    if (p.startsWith('/api/') && !LOCAL_ONLY.test(p) && remoteOn()) return proxyToAgent(req, res, p, url.search);
  } else if (/^\/api\/(agent\/|update|mode$)/.test(p)) return send(res, 404, { error: 'introuvable' });
  try {
    if (p === '/api/mode') {
      if (req.method === 'POST') { const b = await body(req); settings.remote = !!b.remote; fs.writeFileSync(SET_FILE, JSON.stringify(settings)); if (settings.remote) { stopAllPings(); watchStopAll(); } }
      const c = agentCfg(); return send(res, 200, { remote: !!settings.remote, active: remoteOn(), agent: c.url || null, headless: HEADLESS });
    }
    if (p === '/api/history/live') return send(res, 200, await liveHistory(Math.max(60, Math.min(7 * 86400, +url.searchParams.get('range') || 180))));
    if (p === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return fs.createReadStream(INDEX).pipe(res);
    }
    if (p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      clients.add(res); lastClientSeen = now();
      if (wan.hist.length) res.write(`event: wanHist\ndata: ${JSON.stringify(wan.hist.slice(-200))}\n\n`);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); lastClientSeen = now(); });
      pollWan(); pollDevices();
      return;
    }
    // ---- assistant de premier lancement : opérateur, détection de la box, autorisation
    if (p === '/api/setup' && req.method === 'GET') {
      const a = box ? await box.authState() : null;
      return send(res, 200, { version: VERSION, os: platform.OS, osLabel: platform.label, hasNQ: platform.hasNQ, isps: boxes.ISPS, config: boxCfg, configured: !!boxCfg && !!a?.ok, auth: a, features: box?.features || null, label: box?.label || null, gateway: await platform.gateway() });
    }
    if (p === '/api/setup/detect' && req.method === 'POST') {
      const b = await body(req);
      const gw = (/^\d{1,3}(\.\d{1,3}){3}$/.test(b.host || '') ? b.host : null) || await platform.gateway() || '192.168.1.1';
      return send(res, 200, await boxes.detect(gw, String(b.isp || '')));
    }
    if (p === '/api/setup/save' && req.method === 'POST') {
      const b = await body(req);
      if (!boxes.ADAPTERS[b.box]) return send(res, 400, { error: 'Box inconnue' });
      if (!/^[\w.-]{1,80}(:\d{1,5})?$/.test(b.host || '')) return send(res, 400, { error: 'Adresse de box invalide' });
      boxCfg = { isp: String(b.isp || ''), box: b.box, host: b.host, base: /^https?:\/\/[\w.-]+(:\d+)?\/api\/v1$/.test(b.base || '') ? b.base : undefined, api: +b.api || undefined, model: String(b.model || '').slice(0, 60) || null, label: b.box === 'generic' ? String(b.label || 'Box').slice(0, 40) : undefined };
      fs.writeFileSync(BOX_FILE, JSON.stringify(boxCfg)); loadBox(); known = null;
      return send(res, 200, { ok: true, features: box.features, auth: await box.authState() });
    }
    if (p === '/api/setup/auth' && req.method === 'POST') {
      if (!box) return send(res, 409, { error: 'Choisis d\'abord ta box' });
      const b = await body(req);
      const r = await box.authorize({ user: typeof b.user === 'string' ? b.user.slice(0, 64) : undefined, password: typeof b.password === 'string' ? b.password.slice(0, 128) : undefined });
      pollDevices(); return send(res, 200, r);
    }
    if (p === '/api/setup/reset' && req.method === 'POST') { stopAllPings(); watchStopAll(); boxCfg = null; try { fs.rmSync(BOX_FILE); } catch { } loadBox(); return send(res, 200, { ok: true }); }
    // ---- mises à jour
    if (p === '/api/update' && req.method === 'GET') return send(res, 200, updater.status());
    if (p === '/api/update/check' && req.method === 'POST') return send(res, 200, await updater.check(true));
    if (p === '/api/update/apply' && req.method === 'POST') { const r = await updater.apply(); send(res, 200, r); if (r.ok) setTimeout(() => { shutdown(75); }, 400); return; }
    if (p === '/api/update/auto' && req.method === 'POST') { const b = await body(req); return send(res, 200, updater.setAuto(!!b.auto)); }

    if (p === '/api/overview') {
      if (!boxCfg) return send(res, 200, { needSetup: true });
      const a = await box.authState();
      if (!a.ok) return send(res, 200, { needAuth: true, kind: a.kind });
      try { return send(res, 200, { ...(await getOverview()), mac: await getMacWifi(), features: box.features, label: box.label, model: boxCfg.model }); }
      catch (e) { return send(res, 200, { needAuth: /no_token|invalid_token|denied|auth_failed/.test(e.code || ''), kind: a.kind, error: e.message }); }
    }
    if (p === '/api/devices') return send(res, 200, await getDevices());
    if (p === '/api/mac') return send(res, 200, await getMacWifi());
    if (p === '/api/authorize' && req.method === 'POST') { if (!box) return send(res, 409, { error: 'Box non configurée' }); return send(res, 200, await box.authorize({})); }

    if (p === '/api/ping/start' && req.method === 'POST') {
      const b = await body(req);
      if (!b.keep) newPingSession();
      const iv = Math.max(0.2, Math.min(2, +b.interval || 0.25));
      for (const t of (b.targets || [])) {
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(t.ip || '')) continue;
        startPing(String(t.key), t.ip, String(t.name || t.ip).slice(0, 60), iv);
      }
      return send(res, 200, { running: [...pings.keys()] });
    }
    if (p === '/api/ping/stop' && req.method === 'POST') { stopAllPings(); return send(res, 200, { ok: true }); }
    if (p === '/api/ping/stats' && req.method === 'POST') {
      const b = await body(req); const since = +b.since || 0;
      const ref = pings.get('ref')?.samples.filter(s => s.t >= since);
      const o = {};
      for (const [k, v] of pings) { const smp = v.samples.filter(s => s.t >= since); o[k] = { name: v.name, raw: stats(smp), clean: k === 'ref' ? null : stats(smp, ref) }; }
      return send(res, 200, o);
    }

    if (p === '/api/load/start' && req.method === 'POST') {
      const b = await body(req);
      if (full && full.running) return send(res, 409, { error: 'Test complet en cours' });
      const L = startLoad(b);
      return send(res, 200, { mode: L.mode, flows: L.flows, duration: L.duration });
    }
    if (p === '/api/load/stop' && req.method === 'POST') { const s = load && load.running ? finishLoad() : null; return send(res, 200, { summary: s }); }
    if (p === '/api/load/save' && req.method === 'POST') { const b = await body(req); saveHistory({ date: new Date().toISOString(), kind: 'load', ...b }); return send(res, 200, { ok: true }); }

    if (p === '/api/nq' && req.method === 'POST') {
      const r = await runNQ(); if (r.ok) saveHistory({ date: new Date().toISOString(), kind: 'nq', ...r }); return send(res, 200, r);
    }
    if (p === '/api/full/start' && req.method === 'POST') {
      const b = await body(req);
      const targets = (b.targets || []).filter(t => /^\d{1,3}(\.\d{1,3}){3}$/.test(t.ip || '')).slice(0, 12);
      runFull(targets, b.opts || {}).catch(e => log('full:', e.message));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/full/stop' && req.method === 'POST') { if (full) full.running = false; stopLoad(); return send(res, 200, { ok: true }); }
    if (p === '/api/history') return send(res, 200, readHistory());
    if (p === '/api/rename' && req.method === 'POST') {
      const b = await body(req); const list = Array.isArray(b.items) ? b.items.slice(0, 50) : [];
      const done = [];
      for (const it of list) {
        const name = String(it.name || '').trim().slice(0, 60);
        if (!F('rename') || !box.canRenameId(it.id) || !name) continue;
        await box.rename(it.id, name);
        done.push({ id: it.id, name });
      }
      pollDevices();
      return send(res, 200, { done });
    }
    if (p.startsWith('/api/agent/')) {
      const sub = p.slice('/api/agent'.length);
      const c = agentCfg();
      if (sub === '/status') {
        if (!c.url) return send(res, 200, { configured: false, box: box?.id || null, localPossible: true });
        try { const h = await agentReq('GET', '/api/health', null, { noAuth: true }); let logged = false; if (c.token) { const t = await agentReq('GET', '/api/fbx/status'); logged = t.status === 200; } return send(res, 200, { configured: true, url: c.url, local: !!c.local, reachable: true, setup: h.body.setup, version: h.body.version, fbx: h.body.fbx, freebox: h.body.freebox, dns: h.body.dns, engine: !!h.body.engine, logged, user: c.user || null }); }
        catch (e) { return send(res, 200, { configured: true, url: c.url, local: !!c.local, reachable: false, error: e.message }); }
      }
      if (sub === '/connect' && req.method === 'POST') {
        const b = await body(req);
        if (!/^https:\/\/(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))[\d.]*(:\d+)?\/?$/.test(b.url || '')) return send(res, 400, { error: 'Adresse attendue : https://IP-locale:8443' });
        const r = await agentReq('GET', '/api/health', null, { url: b.url, fp: null, noAuth: true });
        if (!r.body.version) return send(res, 502, { error: 'Pas un agent Sonde à cette adresse.' });
        saveAgent({ url: b.url.replace(/\/$/, ''), fp: r.fp }); return send(res, 200, { ok: true, fp: r.fp });
      }
      if (sub === '/login' && req.method === 'POST') {
        const b = await body(req);
        const r = await agentReq('POST', '/api/login', { user: b.user, pass: b.pass, device: os.hostname().replace(/\.local$/, '') }, { noAuth: true });
        if (r.status === 200 && r.body.token) { saveAgent({ ...c, token: r.body.token, user: r.body.user }); return send(res, 200, { ok: true, user: r.body.user }); }
        return send(res, r.status, r.body);
      }
      if (sub === '/setup' && req.method === 'POST') { const b = await body(req); const r = await agentReq('POST', '/api/setup', { user: b.user, pass: b.pass }, { noAuth: true }); return send(res, r.status, r.body); }
      if (sub === '/forget' && req.method === 'POST') { stopLocalAgent(); saveAgent({}); return send(res, 200, { ok: true }); }
      if (sub === '/local' && req.method === 'POST') {
        const b = await body(req);
        if (b.on) { const r = await startLocalAgent(); return send(res, r.ok ? 200 : 500, r); }
        stopLocalAgent(); settings.localAgent = false; fs.writeFileSync(SET_FILE, JSON.stringify(settings));
        if (c.local) saveAgent({}); return send(res, 200, { ok: true });
      }
      if (sub === '/live') {
        // Relais du flux en direct de l'agent (chaque requête DNS), certificat vérifié
        if (!c.url || !c.token) return send(res, 412, { error: 'Connexion à l\'agent requise' });
        if (c.local) {
          const ctl = new AbortController(); req.on('close', () => ctl.abort());
          try { const r = await fetch(new URL('/api/live', c.url), { headers: { authorization: 'Bearer ' + c.token }, signal: ctl.signal }); if (r.status !== 200) { res.writeHead(r.status); return res.end(); } res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); for await (const ch of r.body) res.write(ch); } catch { } try { res.end(); } catch { } return;
        }
        const up = https.request(new URL('/api/live', c.url), { method: 'GET', rejectUnauthorized: false, agent: agentHttpsAgent, headers: { authorization: 'Bearer ' + c.token } }, ur => {
          const fp = ur.socket.getPeerCertificate()?.fingerprint256;
          if (fp !== c.fp || ur.statusCode !== 200) { ur.resume(); res.writeHead(ur.statusCode === 200 ? 495 : ur.statusCode); return res.end(); }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          ur.pipe(res);
        });
        up.on('error', () => { try { res.end(); } catch { } });
        req.on('close', () => up.destroy());
        up.end(); return;
      }
      if (sub === '/logout' && req.method === 'POST') { try { await agentReq('POST', '/api/logout'); } catch { } const { token, user, ...rest } = c; saveAgent(rest); return send(res, 200, { ok: true }); }
      const allowed = { 'GET /services': 1, 'GET /recent': 1, 'GET /history': 1, 'GET /fbx/status': 1, 'GET /storage': 1, 'GET /blocks': 1, 'POST /blocks': 1, 'POST /blocks/delete': 1, 'GET /alerts': 1, 'POST /alerts': 1, 'GET /catalog': 1, 'POST /fbx/authorize': 1, 'POST /password': 1, 'GET /priority': 1, 'POST /priority': 1, 'GET /sessions': 1, 'POST /sessions/revoke': 1 };
      if (!allowed[req.method + ' ' + sub]) return send(res, 404, { error: 'introuvable' });
      const r = await agentReq(req.method, '/api' + sub + url.search, req.method === 'POST' ? await body(req) : null);
      if (r.status === 401 && c.token) { const { token, ...rest } = c; saveAgent(rest); }
      return send(res, r.status, r.body);
    }
    if (p === '/api/logo') {
      // Logo en couleur d'un site (favicon haute définition), téléchargé une fois puis gardé sur le Mac
      const d = String(url.searchParams.get('d') || '').toLowerCase();
      if (!/^[a-z0-9.-]{3,80}$/.test(d)) { res.writeHead(400); return res.end(); }
      const dir = path.join(DATA_DIR, 'logos'); fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, d + '.png');
      if (!fs.existsSync(f)) {
        try {
          const r = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=128`, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) throw new Error(r.status);
          fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
        } catch { res.writeHead(404); return res.end(); }
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=604800' });
      return fs.createReadStream(f).pipe(res);
    }
    // ---- blocage d'un appareil : refusé sur le Wi-Fi de la box (filtrage par adresse MAC)
    if (p === '/api/blocked-devices') {
      if (!F('block')) return send(res, 200, []);
      return send(res, 200, (await box.blockedList()).map(x => ({ mac: x.mac, comment: 'Sonde - bloqué : ' + (x.name || x.mac) })));
    }
    if (p === '/api/block-device' && req.method === 'POST') {
      const b = await body(req);
      const mac = String(b.mac || '').toUpperCase();
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return send(res, 400, { error: 'Adresse MAC invalide' });
      if (!F('block')) return send(res, 400, { error: 'Cette box ne permet pas à Sonde de bloquer un appareil.' });
      const d = devCache.find(x => (x.mac || '').toUpperCase() === mac);
      if (d && d.via === 'cable' && box.id === 'freebox') return send(res, 400, { error: 'Appareil branché en câble : la box ne peut le bloquer que sur le Wi‑Fi.' });
      const agentIp = (() => { try { return new URL(agentCfg().url).hostname; } catch { return null; } })();
      if (d && (d.isSelf || d.ip === agentIp || /r[ée]p[ée]teur/i.test(d.name))) return send(res, 400, { error: 'Cet appareil est protégé (répéteur, agent DNS ou ordinateur qui fait tourner Sonde).' });
      await box.block(mac, !!b.block, b.name);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/settings') {
      if (req.method === 'POST') { const b = await body(req); if (typeof b.autoName === 'boolean') settings.autoName = b.autoName; fs.writeFileSync(SET_FILE, JSON.stringify(settings)); }
      return send(res, 200, settings);
    }
    if (p === '/api/devstats') {
      const o = {};
      for (const [k, h] of watch.hist) {
        const ok = h.filter(x => x.ms != null).map(x => x.ms);
        const hc = k === 'ref' ? h : h.filter(x => x.noise === false || (x.noise === undefined && !isMacNoise(x)));
        const okc = hc.filter(x => x.ms != null).map(x => x.ms);
        o[k] = hc.length ? { n: hc.length, removed: h.length - hc.length, last: hc[hc.length - 1].ms, avg: okc.length ? round(okc.reduce((a, b) => a + b, 0) / okc.length) : null, max: okc.length ? round(Math.max(...okc)) : null, loss: round((hc.length - okc.length) / hc.length * 100, 0) } : null;
      }
      return send(res, 200, o);
    }
    if (p === '/api/watch') return send(res, 200, { rows: watch.rows.slice(-240), events: watch.events.slice(0, 100), targets: [...watch.procs].filter(([, w]) => !w.meta || w.meta.console).map(([k, w]) => ({ key: k, name: w.name })) });
    if (p === '/api/reports' && req.method === 'GET') return send(res, 200, readReports().map(r => ({ ...r, devices: Object.fromEntries(Object.entries(r.devices).map(([k, v]) => [k, { ...v, series: v.series ? v.series.length : 0 }])) })));
    if (p.startsWith('/api/reports/series/')) { const r = readReports().find(x => x.id === p.split('/').pop()); return r ? send(res, 200, Object.fromEntries(Object.entries(r.devices).map(([k, v]) => [k, v.series || []]))) : send(res, 404, { error: 'introuvable' }); }
    if (p === '/api/reports/save' && req.method === 'POST') {
      const b = await body(req);
      if (!pings.size) return send(res, 400, { error: 'Aucune mesure de ping à enregistrer : lance un ping ou un test complet.' });
      const since = +b.since || Math.min(...[...pings.values()].map(x => x.started));
      const until = Math.max(...[...pings.values()].map(x => x.ended || now()));
      let override = null;
      if (b.from === 'full' && full?.report?.idle) override = Object.fromEntries(Object.entries(full.report.idle).map(([k, v]) => [k, v.clean || v.raw]));
      const r = reportFromPings(b.name, since + 2000, until, override);
      if (b.from === 'full' && full?.report) { r.note = 'Test complet : valeurs au repos, courbe sur tout le test (repos puis charges).'; r.load = { down: full.report.down, up: full.report.up }; }
      const all = readReports(); all.push(r); writeReports(all);
      return send(res, 200, { id: r.id, name: r.name });
    }
    if (p === '/api/reports/rename' && req.method === 'POST') { const b = await body(req); const all = readReports(); const r = all.find(x => x.id === b.id); if (!r) return send(res, 404, { error: 'introuvable' }); r.name = String(b.name || r.name).slice(0, 60); writeReports(all); return send(res, 200, { ok: true }); }
    if (p === '/api/reports/delete' && req.method === 'POST') { const b = await body(req); writeReports(readReports().filter(x => x.id !== b.id)); return send(res, 200, { ok: true }); }
    if (p === '/api/scan' && req.method === 'POST') return send(res, 200, await runScan());
    if (p === '/api/scans') return send(res, 200, readScans().map((x, i) => ({ i, date: x.date, n: x.devices.length, added: x.added.length, removed: x.removed.length, changes: x.changes.length, alerts: x.alerts.length })));
    if (p.startsWith('/api/scans/')) { const x = readScans()[+p.split('/').pop()]; return x ? send(res, 200, x) : send(res, 404, { error: 'introuvable' }); }
    if (p === '/api/quit' && req.method === 'POST') { if (HEADLESS) return send(res, 200, { ok: true, headless: true }); send(res, 200, { ok: true }); return shutdown(0); }
    send(res, 404, { error: 'introuvable' });
  } catch (e) {
    if ((e.status || 500) >= 500) log('err', p, e.message);
    send(res, e.status || 500, { error: e.message, code: e.code });
  }
}

// Code de sortie 75 = « redémarre-moi » (après une mise à jour) pour le lanceur.
function shutdown(code = 0) {
  stopLoad(); stopAllPings(); watchStopAll(); stopLocalAgent(); flushJournal();
  setTimeout(() => { process.exit(typeof code === 'number' ? code : 0); }, 200);
}
loadBox();
if (HEADLESS) {
  // dans l'agent : pas de serveur HTTP propre, pas de mise à jour (l'agent a la sienne), jamais d'arrêt automatique
  log(`moteur Sonde ${VERSION} en mode serveur`);
  module.exports = { handler, flush: flushJournal };
  process.on('SIGTERM', () => flushJournal());
} else {
  process.on('SIGINT', () => shutdown(0)); process.on('SIGTERM', () => shutdown(0));
  // S'arrête tout seul 1 min après la fermeture de la fenêtre (rien ne tourne en fond)
  setInterval(() => { if (!clients.size && !proxied && !(load && load.running) && !(full && full.running) && !updater.busy() && now() - lastClientSeen > 60000) shutdown(0); }, 10000);
  const server = http.createServer((req, res) => handler(req, res));
  server.on('error', e => { if (e.code === 'EADDRINUSE') { log('déjà lancé'); return shutdown(); } throw e; });
  if (settings.localAgent) startLocalAgent().catch(e => log('agent local :', e.message));
  updater.init({ version: VERSION, dataDir: DATA_DIR, appDir: __dirname, log, broadcast: (...a) => broadcast(...a), idle: () => !(load && load.running) && !(full && full.running) && !scanning });
  server.listen(PORT, HOST, () => log(`Sonde ${VERSION} prête : http://${HOST}:${PORT}`));
}
