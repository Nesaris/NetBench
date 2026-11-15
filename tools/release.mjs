#!/usr/bin/env node
// Publie une version signée de Sonde sur GitHub.
//   node tools/release.mjs 1.0.1 "Ce qui change"
// 1. inscrit la version dans app/version.json et agent/version.json
// 2. construit le paquet de l'app (JSON) et l'archive de l'agent (tar.gz)
// 3. les signe avec la clé privée Ed25519 (~/.config/sonde-release/ed25519.pem)
// 4. vérifie les signatures avec la clé publique inscrite dans le code
// 5. commit, tag, push, puis crée la release GitHub avec les fichiers (gh)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [ver, notes = ''] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(ver || '')) { console.error('Usage : node tools/release.mjs X.Y.Z "notes"'); process.exit(1); }
const KEY = path.join(os.homedir(), '.config', 'sonde-release', 'ed25519.pem');
if (!fs.existsSync(KEY)) { console.error('Clé privée absente : lance d\'abord  node tools/keygen.mjs'); process.exit(1); }
const priv = crypto.createPrivateKey(fs.readFileSync(KEY));
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opt }).trim();

for (const f of ['app/version.json', 'agent/version.json']) fs.writeFileSync(path.join(ROOT, f), JSON.stringify({ version: ver }, null, 2) + '\n');

// ---- paquet de l'app : tout app/ + l'agent (mode « sur l'ordinateur »)
const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name))]);
const files = {};
for (const rel of walk(path.join(ROOT, 'app'))) if (!/(^|\/)\.|\.DS_Store$/.test(rel)) files[rel.split(path.sep).join('/')] = fs.readFileSync(path.join(ROOT, 'app', rel)).toString('base64');
for (const f of ['agent.js', 'services.js', 'version.json']) files['agent/' + f] = fs.readFileSync(path.join(ROOT, 'agent', f)).toString('base64');
if (fs.existsSync(path.join(ROOT, 'assets'))) for (const rel of walk(path.join(ROOT, 'assets'))) files['assets/' + rel.split(path.sep).join('/')] = fs.readFileSync(path.join(ROOT, 'assets', rel)).toString('base64');
const OUT = path.join(ROOT, 'dist'); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT);
const appFile = path.join(OUT, `sonde-app-${ver}.json`);
fs.writeFileSync(appFile, JSON.stringify({ name: 'sonde-app', version: ver, date: new Date().toISOString(), files }));

// ---- archive de l'agent (Docker, Debian/Ubuntu)
const agentFile = path.join(OUT, `sonde-agent-${ver}.tar.gz`);
sh('tar', ['-czf', agentFile, '-C', path.join(ROOT, 'agent'), 'agent.js', 'services.js', 'version.json', 'Dockerfile', 'docker-entrypoint.sh', 'docker-compose.yml', 'install.sh'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });

// ---- signatures + vérification avec la clé publique du code
const pubB64 = (fs.readFileSync(path.join(ROOT, 'app/lib/updater.js'), 'utf8').match(/MCowBQYDK2VwAyEA[A-Za-z0-9+/=]{44}/) || [])[0];
if (!pubB64) { console.error('Clé publique absente du code : lance  node tools/keygen.mjs'); process.exit(1); }
const pub = crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----\n${pubB64}\n-----END PUBLIC KEY-----`);
for (const f of [appFile, agentFile]) {
  const buf = fs.readFileSync(f), sig = crypto.sign(null, buf, priv);
  if (!crypto.verify(null, buf, pub, sig)) { console.error('La clé privée ne correspond pas à la clé publique du code.'); process.exit(1); }
  fs.writeFileSync(f + '.sig', sig.toString('base64') + '\n');
}
console.log('Paquets signés dans dist/ :', fs.readdirSync(OUT).join(', '));

// ---- git + release GitHub
if (process.env.SONDE_DRY) process.exit(0);
sh('git', ['add', '-A']);
try { sh('git', ['commit', '-m', `Sonde ${ver}${notes ? '\n\n' + notes : ''}${process.env.SONDE_TRAILER ? '\n\n' + process.env.SONDE_TRAILER : ''}`]); } catch { }
sh('git', ['tag', '-a', 'v' + ver, '-m', 'Sonde ' + ver]);
sh('git', ['push', '--follow-tags']);
sh('gh', ['release', 'create', 'v' + ver, '--title', 'Sonde ' + ver, '--notes', notes || 'Nouvelle version de Sonde.', appFile, appFile + '.sig', agentFile, agentFile + '.sig']);
console.log('Release publiée : v' + ver);
