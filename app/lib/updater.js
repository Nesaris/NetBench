'use strict';
// Mises à jour automatiques depuis les releases GitHub de Nesaris/sonde.
// Chaque version est un « paquet » JSON signé (Ed25519). La signature est vérifiée avec la clé publique
// ci-dessous avant d'écrire le moindre fichier : une version non signée par le mainteneur est refusée.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = process.env.SONDE_REPO || 'Nesaris/sonde';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAY03Xgj+jmh+tZbBD0cI+qQuVwLH+L6/0qAGwyCFflE4=
-----END PUBLIC KEY-----`;
const HAS_KEY = /MCowBQYDK2VwAyEA[A-Za-z0-9+/=]{44}/.test(PUBLIC_KEY);
const CHECK_EVERY = 6 * 3600e3;

let C = null; // contexte
const S = { state: 'idle', latest: null, error: null, checked: 0, applying: false, notes: null };

const cmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
const prefsFile = () => path.join(C.dataDir, 'update.json');
const prefs = () => { try { return { auto: true, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch { return { auto: true }; } };
// Racine d'installation : …/app/versions/<version>/server.js → …/app
function root() { const v = path.dirname(C.appDir); return path.basename(v) === 'versions' ? path.dirname(v) : null; }

function verify(bundleBuf, sigB64) {
  if (!HAS_KEY) return false;
  try { return crypto.verify(null, bundleBuf, crypto.createPublicKey(PUBLIC_KEY), Buffer.from(String(sigB64).trim(), 'base64')); } catch { return false; }
}
async function getJSON(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Sonde/' + C.version, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('GitHub a répondu ' + r.status);
  return r.json();
}
async function getBuf(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Sonde/' + C.version, accept: 'application/octet-stream' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('Téléchargement refusé (' + r.status + ')');
  return Buffer.from(await r.arrayBuffer());
}

async function check(force) {
  if (!force && Date.now() - S.checked < CHECK_EVERY) return status();
  S.state = 'checking'; S.error = null;
  try {
    const rel = await getJSON(`${process.env.SONDE_UPDATE_API || 'https://api.github.com'}/repos/${REPO}/releases/latest`);
    const ver = String(rel.tag_name || '').replace(/^v/, '');
    const asset = (rel.assets || []).find(a => a.name === `sonde-app-${ver}.json`);
    const sig = (rel.assets || []).find(a => a.name === `sonde-app-${ver}.json.sig`);
    S.checked = Date.now();
    if (!asset || !sig) { S.state = 'idle'; S.latest = null; return status(); }
    S.latest = { version: ver, url: asset.browser_download_url, sig: sig.browser_download_url, notes: String(rel.body || '').slice(0, 4000), date: rel.published_at };
    S.state = cmp(ver, C.version) > 0 ? 'available' : 'uptodate';
    if (S.state === 'available') C.broadcast('update', status());
  } catch (e) { S.state = 'error'; S.error = e.message; }
  return status();
}

async function apply() {
  if (S.applying) return { ok: false, error: 'Mise à jour déjà en cours' };
  if (!S.latest || cmp(S.latest.version, C.version) <= 0) await check(true);
  if (!S.latest || cmp(S.latest.version, C.version) <= 0) return { ok: false, error: 'Déjà à jour' };
  const R = root();
  if (!R) return { ok: false, error: 'Version de développement : mise à jour automatique désactivée.' };
  S.applying = true; S.state = 'downloading';
  try {
    const [buf, sig] = await Promise.all([getBuf(S.latest.url), getBuf(S.latest.sig)]);
    if (!verify(buf, sig.toString('utf8'))) throw new Error('Signature invalide : mise à jour refusée.');
    const b = JSON.parse(buf.toString('utf8'));
    if (b.name !== 'sonde-app' || String(b.version) !== S.latest.version || typeof b.files !== 'object') throw new Error('Paquet inattendu');
    const dest = path.join(R, 'versions', b.version), tmp = dest + '.tmp-' + process.pid;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [rel, b64] of Object.entries(b.files)) {
      const norm = path.normalize(rel);
      if (path.isAbsolute(norm) || norm.startsWith('..') || !/^[\w./-]+$/.test(rel)) throw new Error('Chemin interdit dans le paquet : ' + rel);
      const f = path.join(tmp, norm); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    }
    fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(tmp, dest);
    // le lanceur, lui aussi signé, est mis à jour à côté
    if (fs.existsSync(path.join(dest, 'launcher.js'))) fs.copyFileSync(path.join(dest, 'launcher.js'), path.join(R, 'launcher.js'));
    fs.writeFileSync(path.join(R, 'previous'), C.version);
    fs.writeFileSync(path.join(R, 'current'), b.version);
    // on garde seulement les 3 dernières versions
    const vs = fs.readdirSync(path.join(R, 'versions')).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp);
    for (const v of vs.slice(0, -3)) if (v !== b.version && v !== C.version) fs.rmSync(path.join(R, 'versions', v), { recursive: true, force: true });
    S.state = 'restarting'; C.log('mise à jour installée :', b.version);
    return { ok: true, version: b.version };
  } catch (e) { S.state = 'error'; S.error = e.message; return { ok: false, error: e.message }; }
  finally { S.applying = false; }
}

function status() { return { current: C?.version, repo: REPO, installed: !!(C && root()), auto: C ? prefs().auto : true, signed: HAS_KEY, ...S, applying: undefined }; }
function setAuto(v) { fs.writeFileSync(prefsFile(), JSON.stringify({ ...prefs(), auto: v })); return status(); }

function init(ctx) {
  C = ctx;
  if (process.env.SONDE_NO_UPDATE) return;
  // Vérifie au démarrage puis toutes les 6 h ; en mode automatique, installe tout de suite et redémarre.
  const tick = async () => {
    await check(false);
    const bad = (() => { try { return fs.readFileSync(path.join(root() || '', 'bad'), 'utf8').trim(); } catch { return null; } })();
    if (S.state === 'available' && S.latest.version !== bad && prefs().auto && root() && (!C.idle || C.idle())) { const r = await apply(); if (r.ok) { C.broadcast('updated', { version: r.version }); setTimeout(() => process.exit(75), 1500); } }
  };
  setTimeout(tick, 8000); setInterval(tick, CHECK_EVERY).unref();
}
module.exports = { init, check, apply, status, setAuto, busy: () => S.applying, verify, cmp };
