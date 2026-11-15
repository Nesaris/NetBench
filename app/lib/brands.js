'use strict';
// Logos des opérateurs et photos officielles des box, prises sur les sites des marques elles-mêmes.
// Rien n'est inclus dans le dépôt : l'image est téléchargée une seule fois depuis le site de la marque,
// puis gardée sur l'ordinateur (ou le serveur) et servie depuis ce cache.
const fs = require('node:fs');
const path = require('node:path');

const IL = 'https://assistance.cdn.scw.iliad.fr/';
const WOO = 'https://proxymedia.woopic.com/api/v1/images/2709%2F';
const BYT = 'https://www.bouyguestelecom.fr/';
// Photos de face, fond blanc ou transparent (affichées sur fond blanc)
const PHOTOS = {
  'fbx-ultra': { url: 'https://www.free.fr/assets/univers-freebox/freebox-ultra-player-tv.png', label: 'Freebox Ultra' },
  'fbx-pop': { url: IL + 'freebox_pop_materiel_presentation_1_7177ffe5ab.webp', label: 'Freebox Pop' },
  'fbx-revolution': { url: IL + 'freebox_revolution_800_450_72dpi_RVB_presentation_378_001_a5eab929d6.png', label: 'Freebox Révolution' },
  'fbx-mini': { url: IL + 'freebox_mini_4k_800_450_72dpi_RVB_presentation_384_001_bea55d4730.png', label: 'Freebox mini 4K' },
  'lb-4': { url: WOO + 'internet-orange%2FLivebox_4_6512a720055f9f693fd4949b.jpg', label: 'Livebox 4' },
  'lb-5': { url: WOO + 'internet-orange%2Flivebox5_6512a73546f77f0724591b41.jpg', label: 'Livebox 5' },
  'lb-6': { url: WOO + 'internet-orange%2Flivebox6_6512a74346f77f0724591b44.jpg', label: 'Livebox 6' },
  'lb-7': { url: WOO + 'equipements%2FLivebox7_1_68d10cfe88a51d08ad3fb611.png', label: 'Livebox 7' },
  'bbox-fit': { url: BYT + 'assets/media/full/CMS/ecommerce/box-fai/fit-desktop@2x.webp', label: 'Bbox Fit' },
  'bbox-must': { url: BYT + 'assets/media/full/CMS/ecommerce/box-fai/must-desktop@2x.webp', label: 'Bbox Must' },
  'bbox-ultym': { url: BYT + 'assets/media/full/CMS/ECOMMERCE/box-fai/ultym-de_codeur-desktop@2x.webp', label: 'Bbox Ultym' },
  'bbox-5g': { url: BYT + 'static/wbm/media/fai/5g-box.webp', label: 'Bbox 5G' }
};
// Logo officiel de chaque opérateur
const LOGOS = {
  free: 'https://www.free.fr/assets/img/freebox/freebox-ultra/applications/logo-free.svg',
  orange: 'https://myshop.cdn.s.woopic.com/myshop-myshop-prod-a0fe7292/images/orange/favicons/apple-touch-icon.png',
  sfr: 'https://static.s-sfr.fr/assets/logos/SFR.svg',
  bouygues: 'https://www.bouyguestelecom.fr/static/logo-bouygues-telecom.png'
};
const HOSTS = new Set(['www.free.fr', 'assistance.cdn.scw.iliad.fr', 'proxymedia.woopic.com', 'myshop.cdn.s.woopic.com', 'www.bouyguestelecom.fr', 'static.s-sfr.fr']);

// Modèle détecté → photo officielle (null : pas de photo propre de la marque, l'app montre une illustration neutre)
function photoKey(box, model) {
  const m = String(model || '').toLowerCase();
  if (box === 'freebox') {
    if (/ultra|v9/.test(m)) return 'fbx-ultra';
    if (/pop|v8/.test(m)) return 'fbx-pop';
    if (/mini/.test(m)) return 'fbx-mini';
    if (/r[ée]volution|v6/.test(m)) return 'fbx-revolution';
    return null; // Delta : la marque ne publie qu'une photo sur fond noir
  }
  if (box === 'livebox') { for (const n of ['7', '6', '5', '4']) if (new RegExp('\\b' + n + '\\b').test(m)) return 'lb-' + n; return null; }
  if (box === 'bbox') { if (/5g/.test(m)) return 'bbox-5g'; if (/fit/.test(m)) return 'bbox-fit'; if (/must/.test(m)) return 'bbox-must'; if (/ultym/.test(m)) return 'bbox-ultym'; return null; }
  return null; // SFR : pas de photo officielle propre en grand format
}

// SVG : refusé s'il contient du script, des gestionnaires d'évènements ou des liens externes
const svgSafe = s => !/<script|<foreignObject|\bon[a-z]+\s*=|javascript:|<!ENTITY|(?:xlink:)?href\s*=\s*["'](?!#)/i.test(s);

async function cached(dataDir, name, url, version) {
  const dir = path.join(dataDir, 'brand'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, 'o-' + name + '.img'); // « o- » : photos officielles (les anciennes sont ignorées)
  try { return { buf: await fs.promises.readFile(f), type: (await fs.promises.readFile(f + '.type', 'utf8')).trim() }; } catch { }
  const u = new URL(url); if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) throw new Error('source refusée');
  const r = await fetch(u, { redirect: 'error', headers: { 'user-agent': `Mozilla/5.0 (Sonde/${version})` }, signal: AbortSignal.timeout(15000) });
  const type = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!r.ok || !/^image\/(jpeg|png|webp|svg\+xml)$/.test(type)) throw new Error('image indisponible');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 3e6) throw new Error('image trop lourde');
  if (type === 'image/svg+xml' && !svgSafe(buf.toString('utf8'))) throw new Error('SVG refusé');
  await fs.promises.writeFile(f, buf); await fs.promises.writeFile(f + '.type', type);
  return { buf, type };
}
const photo = (dataDir, key, version) => PHOTOS[key] ? cached(dataDir, key, PHOTOS[key].url, version) : null;
const logo = (dataDir, isp, version) => LOGOS[isp] ? cached(dataDir, 'logo-' + isp, LOGOS[isp], version) : null;
const label = k => PHOTOS[k]?.label || null;
module.exports = { PHOTOS, LOGOS, photoKey, photo, logo, label };
