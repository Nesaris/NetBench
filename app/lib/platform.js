'use strict';
// Tout ce qui dépend du système : ping, Wi‑Fi de l'ordinateur, passerelle, table ARP, coffre à secrets, dossiers.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');

const OS = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const now = () => Date.now();
const run = (cmd, args, timeout = 5000, input) => new Promise(res => {
  const p = execFile(cmd, args, { timeout, maxBuffer: 8e6, windowsHide: true, encoding: 'utf8' }, (e, so) => res(String(so || '')));
  if (input != null) { p.stdin.end(input); }
});

const dataDir = process.env.SONDE_DATA_DIR || (OS === 'mac' ? path.join(os.homedir(), 'Library', 'Application Support', 'Sonde')
  : OS === 'win' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Sonde')
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'sonde'));
fs.mkdirSync(dataDir, { recursive: true });

// ---------------------------------------------------------------- ping
// Une ligne de sortie → nombre (ms), null (perdu) ou undefined (ligne sans intérêt). Anglais, français, allemand…
const RE_MS = /(?:time|temps|zeit|tiempo|tempo)[=<]\s*([\d.,]+)\s*ms/i;
const RE_LOST = /timed? ?out|timeout|d.lai d.attente|unreachable|inaccessible|transmit failed|.chec g.n.ral|general failure|zeit.berschreitung/i;
function parsePing(line) {
  const m = line.match(RE_MS);
  if (m) return +m[1].replace(',', '.');
  if (RE_LOST.test(line)) return null;
  return undefined;
}
function spawnPing(ip, args) {
  const exe = OS === 'mac' ? '/sbin/ping' : OS === 'win' ? 'ping' : 'ping';
  const p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  p.on('error', () => { }); // ping absent ou refusé : la cible apparaît simplement sans réponse
  return p;
}
function lines(proc, cb) {
  let b = '';
  proc.stdout.on('data', d => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); const v = parsePing(l); if (v !== undefined) cb({ t: now(), ms: v }); } });
}
// Ping continu. Windows ne descend pas sous 1 ping/s : on décale plusieurs processus pour tenir la cadence.
function pingStream(ip, intervalSec, onSample) {
  const procs = [];
  if (OS === 'win') {
    const k = Math.max(1, Math.min(4, Math.round(1 / Math.max(0.25, intervalSec))));
    for (let i = 0; i < k; i++) setTimeout(() => { if (procs.killed) return; const p = spawnPing(ip, ['-t', '-w', '1000', ip]); lines(p, onSample); procs.push(p); }, i * 1000 / k);
  } else {
    const iv = String(Math.max(0.2, intervalSec));
    const p = spawnPing(ip, OS === 'mac' ? ['-i', iv, '-W', '1000', ip] : ['-n', '-i', iv, '-W', '1', ip]);
    lines(p, onSample); procs.push(p);
  }
  return {
    kill() { procs.killed = true; for (const p of procs) { try { p.kill(); } catch { } } },
    onExit(cb) { const t = setInterval(() => { if (procs.length && procs.every(p => p.exitCode != null || p.killed)) { clearInterval(t); cb(); } }, 2000); }
  };
}
// Rafale courte (scan) : environ 5 s
function pingBurst(ip, count = 20) {
  return new Promise(res => {
    const out = []; const procs = [];
    const done = () => { while (out.length < count) out.push({ t: now(), ms: null }); res(out.slice(2)); };
    if (OS === 'win') {
      const k = 4, n = Math.ceil(count / k); let left = k;
      for (let i = 0; i < k; i++) setTimeout(() => { const p = spawnPing(ip, ['-n', String(n), '-w', '1000', ip]); lines(p, s => out.push(s)); p.on('exit', () => { if (--left === 0) done(); }); procs.push(p); }, i * 250);
    } else {
      const p = spawnPing(ip, OS === 'mac' ? ['-c', String(count), '-i', '0.25', '-W', '1000', ip] : ['-n', '-c', String(count), '-i', '0.25', '-W', '1', ip]);
      lines(p, s => out.push(s)); procs.push(p);
      const k = setTimeout(() => p.kill(), count * 250 + 3000);
      p.on('exit', () => { clearTimeout(k); done(); });
    }
  });
}

// ---------------------------------------------------------------- Wi‑Fi de l'ordinateur (sans lancer de recherche de réseaux)
const JXA = 'ObjC.import("CoreWLAN");const i=$.CWWiFiClient.sharedWiFiClient.interface;const c=i.wlanChannel;' +
  'JSON.stringify({rssi:+i.rssiValue,noise:+i.noiseMeasurement,tx:+i.transmitRate,ch:c?+c.channelNumber:null,band:c?+c.channelBand:null,width:c?+c.channelWidth:null,on:!!i.powerOn})';
const bandOfCh = ch => ch == null ? null : ch <= 14 ? '2d4g' : '5g';
const chTxt = (ch, band, width) => ch ? `${ch} (${({ '2d4g': '2,4 GHz', '5g': '5 GHz', '6g': '6 GHz' })[band] || ''}${width ? ', ' + width + ' MHz' : ''})` : null;
let wifiCache = { t: 0, v: null };
async function wifiInfo() {
  if (now() - wifiCache.t < 3500 && wifiCache.v) return wifiCache.v;
  let v = { ok: false };
  if (OS === 'mac') {
    try {
      const j = JSON.parse((await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA], 4000)).trim());
      const band = { 1: '2d4g', 2: '5g', 3: '6g' }[j.band] || null, width = { 1: 20, 2: 40, 3: 80, 4: 160, 5: 320 }[j.width] || null;
      v = { ok: !!(j.on && j.ch), channel: chTxt(j.ch, band, width), band, signal: j.rssi || null, noise: j.noise || null, rate: j.tx ? Math.round(j.tx) : null };
    } catch { }
    const m = (await run('/sbin/route', ['-n', 'get', 'default'], 3000)).match(/interface:\s*(\S+)/); v.defaultIf = m ? m[1] : null;
  } else if (OS === 'win') {
    const so = await run('netsh', ['wlan', 'show', 'interfaces'], 4000);
    const g = re => (so.match(re) || [])[1];
    const pct = +g(/^\s*Signal\s*:\s*(\d+)\s*%/mi), ch = +g(/^\s*(?:Channel|Canal)\s*:\s*(\d+)/mi);
    const rate = +g(/^\s*(?:Receive rate|D.bit de r.ception|Vitesse de r.ception)[^:]*:\s*([\d.,]+)/mi) || +g(/^\s*(?:Transmit rate|D.bit de transmission)[^:]*:\s*([\d.,]+)/mi);
    const bandTxt = g(/^\s*(?:Band|Bande)\s*:\s*(.+)$/mi) || '';
    const band = /6/.test(bandTxt) ? '6g' : /5/.test(bandTxt) ? '5g' : /2[.,]4/.test(bandTxt) ? '2d4g' : bandOfCh(ch);
    const connected = /^\s*(?:State|.tat)\s*:\s*(connected|connect)/mi.test(so);
    // Windows donne une qualité en % ; conversion habituelle : dBm ≈ % / 2 − 100
    v = { ok: connected && !!ch, channel: chTxt(ch, band), band, signal: pct ? Math.round(pct / 2 - 100) : null, signalApprox: true, noise: null, rate: rate ? Math.round(rate) : null };
    v.defaultIf = connected ? 'wifi' : 'ethernet';
  } else {
    const so = await run('iw', ['dev'], 3000); const ifc = (so.match(/Interface\s+(\S+)/) || [])[1];
    if (ifc) { const l = await run('iw', ['dev', ifc, 'link'], 3000); const sig = +(l.match(/signal:\s*(-?\d+)/) || [])[1]; const f = +(l.match(/freq:\s*([\d.]+)/) || [])[1]; const r = +(l.match(/tx bitrate:\s*([\d.]+)/) || [])[1]; if (sig) v = { ok: true, channel: f ? f + ' MHz' : null, band: f > 5900 ? '6g' : f > 4900 ? '5g' : '2d4g', signal: sig, rate: r ? Math.round(r) : null, defaultIf: ifc }; }
  }
  wifiCache = { t: now(), v }; return v;
}

// ---------------------------------------------------------------- passerelle et table ARP
async function gateway() {
  if (OS === 'mac') return ((await run('/sbin/route', ['-n', 'get', 'default'], 3000)).match(/gateway:\s*([\d.]+)/) || [])[1] || null;
  if (OS === 'win') { const so = await run('route', ['print', '-4', '0.0.0.0'], 4000); const m = so.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+([\d.]+)/m); return m ? m[1] : null; }
  return ((await run('ip', ['route', 'show', 'default'], 3000)).match(/via\s+([\d.]+)/) || [])[1] || null;
}
async function arpTable() {
  const out = [];
  if (OS === 'win') {
    for (const m of (await run('arp', ['-a'], 5000)).matchAll(/^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s+(\S+)/gmi)) if (!/static|statique/i.test(m[3])) out.push({ ip: m[1], mac: m[2].toUpperCase().replace(/-/g, ':') });
  } else if (OS === 'mac') {
    for (const m of (await run('/usr/sbin/arp', ['-an'], 5000)).matchAll(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+) on/gi)) { const mac = m[2].split(':').map(x => x.padStart(2, '0')).join(':').toUpperCase(); if (mac.length === 17) out.push({ ip: m[1], mac }); }
  } else {
    for (const m of (await run('ip', ['neigh'], 3000)).matchAll(/^(\d+\.\d+\.\d+\.\d+) .*lladdr ([0-9a-f:]{17}) (?!FAILED)/gmi)) out.push({ ip: m[1], mac: m[2].toUpperCase() });
  }
  return out.filter((x, i, a) => a.findIndex(y => y.mac === x.mac) === i);
}

// ---------------------------------------------------------------- coffre à secrets (mots de passe de box, jetons)
// Mac : trousseau d'accès · Windows : chiffrement DPAPI lié au compte · Linux : fichier lisible par l'utilisateur seul.
const SERVICE = 'fr.nesaris.sonde';
const SECDIR = path.join(dataDir, 'secrets'); fs.mkdirSync(SECDIR, { recursive: true, mode: 0o700 });
const cache = new Map();
const keyOk = k => /^[a-z0-9-]{1,40}$/.test(k);
const ps = (script, input) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 15000, input: input || '' }).trim();
const secrets = {
  get(k) {
    if (!keyOk(k)) return null;
    if (cache.has(k)) return cache.get(k);
    let v = null;
    try {
      if (OS === 'mac') v = execFileSync('/usr/bin/security', ['find-generic-password', '-a', k, '-s', SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
      else if (OS === 'win') { const f = path.join(SECDIR, k + '.dpapi'); if (fs.existsSync(f)) v = ps(`Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${fs.readFileSync(f, 'utf8').trim()}'),$null,'CurrentUser'))`); }
      else v = fs.readFileSync(path.join(SECDIR, k), 'utf8');
    } catch { v = null; }
    cache.set(k, v || null); return v || null;
  },
  set(k, v) {
    if (!keyOk(k)) throw new Error('clé invalide');
    v = String(v);
    if (OS === 'mac') {
      const q = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      // via stdin : le secret n'apparaît jamais dans la liste des processus
      execFileSync('/usr/bin/security', ['-i'], { input: `add-generic-password -U -a ${q(k)} -s ${q(SERVICE)} -l ${q('Sonde (' + k + ')')} -w ${q(v)}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
    } else if (OS === 'win') {
      const b64 = Buffer.from(v, 'utf8').toString('base64');
      fs.writeFileSync(path.join(SECDIR, k + '.dpapi'), ps(`Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()),$null,'CurrentUser'))`, b64)); // secret passé par stdin, jamais en argument
    } else fs.writeFileSync(path.join(SECDIR, k), v, { mode: 0o600 });
    cache.set(k, v);
  },
  del(k) {
    if (!keyOk(k)) return;
    try { if (OS === 'mac') execFileSync('/usr/bin/security', ['delete-generic-password', '-a', k, '-s', SERVICE], { stdio: 'ignore' }); else fs.rmSync(path.join(SECDIR, k + (OS === 'win' ? '.dpapi' : '')), { force: true }); } catch { }
    cache.delete(k);
  }
};

// ---------------------------------------------------------------- spécificités Mac
// Recherches Wi‑Fi lancées sur le Mac (ex. page Wi‑Fi des Réglages ouverte) : elles font décrocher la carte Wi‑Fi.
async function wifiScans() {
  if (OS !== 'mac') return null;
  const so = await run('/usr/bin/log', ['show', '--last', '30s', '--style', 'compact', '--predicate', 'process == "airportd" AND eventMessage CONTAINS "BEGIN REQ [SCAN]"'], 8000);
  const ls = so.split('\n').filter(l => l.includes('BEGIN REQ [SCAN]'));
  const procs = {}; for (const l of ls) { const m = l.match(/proc=([^ ]+)/); const b = l.match(/bundleID=([^ ]+)/); const n = (b && /wifi-settings/.test(b[1])) ? 'Réglages Wi‑Fi' : (m ? m[1] : '?'); procs[n] = (procs[n] || 0) + 1; }
  return { n: ls.length, procs: Object.entries(procs).map(([name, n]) => ({ name, n })), t: now() };
}
async function networkQuality() {
  if (OS !== 'mac') return { ok: false, error: 'Test Apple disponible seulement sur Mac' };
  try { const j = JSON.parse(await run('/usr/bin/networkQuality', ['-c', '-s'], 90000)); return { ok: true, down: Math.round(j.dl_throughput / 1e6), up: Math.round(j.ul_throughput / 1e6), idle: Math.round(j.base_rtt * 10) / 10, rpmDown: j.dl_responsiveness, rpmUp: j.ul_responsiveness, iface: j.interface_name }; }
  catch (e) { return { ok: false, error: 'sortie illisible' }; }
}
const label = process.env.SONDE_LABEL || (OS === 'mac' ? 'Mac' : OS === 'win' ? 'PC' : 'ordinateur');

module.exports = { OS, label, dataDir, parsePing, pingStream, pingBurst, wifiInfo, gateway, arpTable, secrets, wifiScans, networkQuality, hasNQ: OS === 'mac' };
