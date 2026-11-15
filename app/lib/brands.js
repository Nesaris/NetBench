'use strict';
// Photos des box (Wikimedia Commons, licences libres CC BY / CC BY-SA, auteur affiché sous chaque photo)
// et logos des opérateurs (icône officielle de leur site). Téléchargés une seule fois, puis gardés sur l'ordinateur.
const fs = require('node:fs');
const path = require('node:path');

const PHOTOS = {
  'fbx-delta': { file: 'Freebox-deltat-avant.jpg', label: 'Freebox Delta', artist: 'Siyan38', license: 'CC BY-SA 4.0' },
  'fbx-pop': { file: 'Freebox Pop Server V8.jpg', label: 'Freebox Pop', artist: 'AmineDu60', license: 'CC BY-SA 4.0' },
  'fbx-revolution': { file: 'Freebox v6 -1010633.jpg', label: 'Freebox Révolution', artist: 'weweje', license: 'CC BY-SA 4.0' },
  'fbx-mini': { file: 'Freebox mini 4k.jpg', label: 'Freebox mini 4K', artist: 'Weweje', license: 'CC BY-SA 4.0' },
  'lb-6': { file: 'Livebox 6 - Devant & Coté droit - IMG 0056.jpg', label: 'Livebox 6', artist: 'Poudou99', license: 'CC BY-SA 4.0' },
  'lb-5': { file: 'Livebox 5.png', label: 'Livebox 5', artist: 'Théodu57', license: 'CC BY-SA 4.0' },
  'lb-4': { file: 'Livebox-Orange-V4 - IMG 6471.jpg', label: 'Livebox 4', artist: 'Poudou99', license: 'CC BY-SA 4.0' },
  'sfr-8': { file: 'SFR Box 8 (front).jpg', label: 'SFR Box 8', artist: 'RSVScribe', license: 'CC BY-SA 4.0' },
  'sfr-10': { file: 'SFR Box 10+ (front).png', label: 'SFR Box 10+', artist: 'RSVScribe', license: 'CC BY-SA 4.0' },
  'sfr-5g': { file: 'SFR Box 5G (front).jpg', label: 'SFR Box 5G', artist: 'RSVScribe', license: 'CC BY-SA 4.0' },
  'sfr-nb6': { file: 'SFR Box Plus NB6VAC-FXC-r0 avant.jpg', label: 'SFR Box NB6', artist: 'Don-vip', license: 'CC BY-SA 4.0' },
  'bbox-ultym': { file: 'IMG-20200709-WA0007.png', label: 'Bbox Ultym', artist: 'Batoucada', license: 'CC BY-SA 4.0' }
};
// Photo de l'opérateur (carte de choix) et logo (icône de son site)
const ISP_MEDIA = {
  free: { logo: 'free.fr', photo: 'fbx-delta' },
  orange: { logo: 'orange.fr', photo: 'lb-6' },
  sfr: { logo: 'sfr.fr', photo: 'sfr-8' },
  bouygues: { logo: 'bouyguestelecom.fr', photo: 'bbox-ultym' },
  other: { logo: null, photo: null }
};
// Modèle détecté → photo la plus proche (null = pas de photo libre : illustration neutre)
function photoKey(box, model) {
  const m = String(model || '').toLowerCase();
  if (box === 'freebox') {
    if (/ultra|v9/.test(m)) return null; // pas encore de photo libre de la Freebox Ultra
    if (/delta|v7/.test(m)) return 'fbx-delta';
    if (/pop|v8/.test(m)) return 'fbx-pop';
    if (/mini/.test(m)) return 'fbx-mini';
    if (/r[ée]volution|v6/.test(m)) return 'fbx-revolution';
    return null;
  }
  if (box === 'livebox') { if (/\b7\b/.test(m)) return null; if (/\b6\b/.test(m)) return 'lb-6'; if (/\b5\b/.test(m)) return 'lb-5'; if (/\b4\b/.test(m)) return 'lb-4'; return 'lb-6'; }
  if (box === 'sfr') { if (/nb6|nb4/.test(m)) return 'sfr-nb6'; if (/5g/.test(m)) return 'sfr-5g'; if (/10/.test(m)) return 'sfr-10'; return 'sfr-8'; }
  if (box === 'bbox') return 'bbox-ultym';
  return null;
}
const credit = k => PHOTOS[k] ? { label: PHOTOS[k].label, artist: PHOTOS[k].artist, license: PHOTOS[k].license, source: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(PHOTOS[k].file.replace(/ /g, '_')) } : null;

// Photo servie depuis le cache local ; premier affichage : téléchargée depuis Wikimedia Commons (600 px)
async function photo(dataDir, key, version) {
  const p = PHOTOS[key]; if (!p) return null;
  const dir = path.join(dataDir, 'brand'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, key + '.img');
  try { return { buf: await fs.promises.readFile(f), type: (await fs.promises.readFile(f + '.type', 'utf8')).trim() }; } catch { }
  const url = 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(p.file) + '?width=600';
  const r = await fetch(url, { headers: { 'user-agent': `Sonde/${version} (https://github.com/Nesaris/sonde)` }, signal: AbortSignal.timeout(15000) });
  const type = (r.headers.get('content-type') || '').split(';')[0];
  if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(type)) throw new Error('photo indisponible');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 3e6) throw new Error('photo trop lourde');
  await fs.promises.writeFile(f, buf); await fs.promises.writeFile(f + '.type', type);
  return { buf, type };
}
module.exports = { PHOTOS, ISP_MEDIA, photoKey, credit, photo };
