#!/usr/bin/env node
// Crée la clé de signature des versions (une seule fois) et inscrit la clé publique dans les fichiers du projet.
// La clé privée reste sur la machine du mainteneur : ~/.config/sonde-release/ed25519.pem (droits 600).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(os.homedir(), '.config', 'sonde-release');
const KEY = path.join(DIR, 'ed25519.pem');
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(KEY)) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log('Nouvelle clé privée :', KEY, '(à sauvegarder hors ligne, ne jamais la publier)');
}
const pub = crypto.createPublicKey(fs.readFileSync(KEY)).export({ type: 'spki', format: 'pem' }).toString().split('\n').filter(l => l && !l.startsWith('-----')).join('');
const files = ['app/lib/updater.js', 'install/mac.sh', 'install/win.ps1', 'agent/install.sh'];
for (const f of files) {
  const p = path.join(ROOT, f); let s = fs.readFileSync(p, 'utf8');
  s = s.replace(/__SONDE_PUBLIC_KEY__|MCowBQYDK2VwAyEA[A-Za-z0-9+/=]{44}/g, pub);
  fs.writeFileSync(p, s);
}
console.log('Clé publique :', pub);
console.log('Inscrite dans :', files.join(', '));
