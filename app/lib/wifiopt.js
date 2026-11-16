'use strict';
// Optimisation du Wi‑Fi : pour chaque bande de la box, note chaque canal possible d'après
//  - les réseaux voisins (canal, largeur, force du signal) vus par la box,
//  - l'occupation mesurée de chaque canal (% du temps où l'air est déjà pris),
// puis propose le canal et la largeur qui donnent le plus de débit utile.

const BAND_LABEL = { '2d4g': '2,4 GHz', '5g': '5 GHz', '6g': '6 GHz' };

// Canaux de 20 MHz couverts par un bloc (canal principal + largeur)
const B5 = {
  40: [[36, 40], [44, 48], [52, 56], [60, 64], [100, 104], [108, 112], [116, 120], [124, 128], [132, 136], [140, 144], [149, 153], [157, 161]],
  80: [[36, 40, 44, 48], [52, 56, 60, 64], [100, 104, 108, 112], [116, 120, 124, 128], [132, 136, 140, 144], [149, 153, 157, 161]],
  160: [[36, 40, 44, 48, 52, 56, 60, 64], [100, 104, 108, 112, 116, 120, 124, 128]]
};
function block(band, primary, width) {
  width = +width || 20; primary = +primary;
  if (!primary) return [];
  if (band === '2d4g') {
    // 2,4 GHz : un canal de 20 MHz déborde sur ±2 canaux voisins (pas de 5 MHz)
    return width >= 40 ? [primary, primary + (primary <= 7 ? 4 : -4)].sort((a, b) => a - b) : [primary];
  }
  if (band === '5g') {
    if (width <= 20) return [primary];
    const b = (B5[width] || []).find(g => g.includes(primary));
    return b || [primary];
  }
  if (band === '6g') {
    const n = Math.max(1, width / 20), i = (primary - 1) / 4, s = Math.floor(i / n) * n;
    return Array.from({ length: n }, (_, k) => 1 + 4 * (s + k));
  }
  return [primary];
}
// Part de notre bloc gênée par un bloc voisin
function overlap(band, ours, theirs) {
  if (!ours.length || !theirs.length) return 0;
  if (band === '2d4g') {
    // deux canaux 2,4 GHz se gênent tant qu'ils sont à moins de 5 canaux d'écart
    let best = 0;
    for (const a of ours) for (const b of theirs) best = Math.max(best, Math.max(0, 1 - Math.abs(a - b) / 5));
    return best;
  }
  const hit = ours.filter(c => theirs.includes(c)).length;
  return hit / ours.length;
}
// Force d'un voisin : 0 à -92 dBm (inaudible), 1 à -62 dBm ou plus fort
const strength = dbm => Math.max(0, Math.min(1, ((+dbm || -100) + 92) / 30));
// Débit relatif selon la largeur : doubler la largeur ne double pas le débit réel (bruit +3 dB, et la plupart
// des téléphones plafonnent à 80 MHz en 5 GHz) ; au-delà de 80 MHz le gain est faible.
const WIDTH_GAIN = { 20: 1, 40: 1.9, 80: 3.4, 160: 3.9, 320: 4.4 };

function scoreCombo(radio, c, siblings = []) {
  const band = radio.band;
  const ch = block(band, c.primary, c.width);
  const cur = block(band, radio.status.primary, radio.status.width);
  let neigh = 0; const who = [];
  for (const n of radio.neighbors) {
    const o = overlap(band, ch, block(band, n.channel, n.width));
    if (o > 0) { const w = strength(n.signal) * o; neigh += w; if (w > 0.05) who.push(n); }
  }
  // les autres antennes de la box sur la même bande se gênent à coup sûr
  for (const s of siblings) { const o = overlap(band, ch, block(band, s.status.primary, s.status.width)); if (o > 0) { neigh += 2 * o; who.push({ ssid: 'autre antenne ' + s.name }); } }
  // occupation de l'air : sur le canal actuel, une partie vient de nos propres appareils, on la compte à moitié
  const busyOf = x => { const u = radio.usage.find(y => y.channel === x); if (!u) return 0; return cur.includes(x) ? u.busy * 0.5 : u.busy; };
  const busy = ch.length ? ch.reduce((a, x) => a + busyOf(x), 0) / ch.length : 0;
  const congestion = Math.min(0.95, neigh * 0.5 + busy / 100);
  const width = +c.width || 20;
  let score = 20 * (band === '2d4g' && width > 20 ? 0.8 : WIDTH_GAIN[width] || 1) * (1 - congestion); // 40 MHz en 2,4 GHz : gain illusoire
  if (c.dfs) score *= 0.88; // canaux radar : risque de coupure si un radar est détecté
  if (band === '2d4g' && ![1, 6, 11].includes(+c.primary)) score *= 0.9; // 1, 6 et 11 ne se chevauchent pas
  return { ...c, block: ch, congestion: Math.round(congestion * 100), busy: Math.round(busy), neighbors: who.length, score: Math.round(score * 10) / 10 };
}

// Analyse d'une bande : note de la config actuelle, meilleur choix, liste triée des possibilités
function analyse(radio, siblings = []) {
  const curC = { primary: radio.status.primary, secondary: radio.status.secondary, width: +radio.status.width || 20, dfs: false };
  const combos = (radio.allowed || []).filter(c => radio.band !== '2d4g' || +c.width === 20);
  const scored = combos.map(c => scoreCombo(radio, { primary: c.primary, secondary: c.secondary, width: +c.width, dfs: !!c.dfs }, siblings));
  const cur = scoreCombo(radio, { ...curC, dfs: !!(radio.allowed || []).find(c => c.primary === curC.primary && +c.width === curC.width && c.dfs) }, siblings);
  // à note égale : garder le canal actuel, puis préférer les canaux sans radar
  const isCur = x => x.primary === cur.primary && x.width === cur.width;
  scored.sort((a, b) => b.score - a.score || isCur(b) - isCur(a) || a.dfs - b.dfs);
  const best = scored[0] || cur;
  const gain = cur.score > 0 ? Math.round((best.score / cur.score - 1) * 100) : (best.score > 0 ? 100 : 0);
  const sameBlock = best.block.join() === cur.block.join() && best.width === cur.width;
  let verdict = 'optimal', reason = 'Le canal actuel est déjà le meilleur choix d\'après les réseaux voisins et l\'occupation mesurée.';
  if (!radio.enabled) { verdict = 'off'; reason = 'Bande coupée.'; }
  else if (!sameBlock && gain >= 15) {
    verdict = gain >= 35 ? 'fort' : 'ameliorable';
    reason = `Canal ${best.primary} en ${best.width} MHz : environ ${Math.min(300, gain)} % de débit utile en plus (${best.neighbors ? best.neighbors + ' voisin' + (best.neighbors > 1 ? 's' : '') + ' gênant' + (best.neighbors > 1 ? 's' : '') : 'aucun voisin gênant'}, air occupé ${best.busy} %).`;
    if (best.dfs) reason += ' Canal radar (DFS) : la box écoute 1 minute avant d\'émettre, et doit changer de canal si un radar (météo, aviation) passe.';
    if (best.dfs && radio.auto) { verdict = 'ameliorable'; reason += ' La box a peut‑être évité ces canaux à cause d\'un radar : à tester.'; }
  } else if (radio.auto) reason = 'La box choisit le canal toute seule et son choix est bon.';
  return { current: cur, best, gain: Math.min(300, Math.max(0, gain)), verdict, reason, ranking: scored.slice(0, 12) };
}

// Réglages généraux recommandés
function globalAdvice(g) {
  const out = [];
  if (g.powerSaving) out.push({ key: 'powerSaving', value: false, title: 'Couper l\'économie d\'énergie du Wi‑Fi', why: 'La box baisse sa puissance et coupe des antennes : moins de portée et des pics de latence.' });
  if (g.wps) out.push({ key: 'wps', value: false, title: 'Désactiver le WPS', why: 'Le WPS (appairage par bouton/PIN) est une faille connue et ne sert plus aux appareils récents.' });
  if (g.encryption && /wep|^wpa_|tkip|open/i.test(g.encryption)) out.push({ key: 'encryption', info: true, title: 'Chiffrement ancien', why: 'Passe en WPA2/WPA3 dans Freebox OS : plus sûr et plus rapide (le TKIP limite le débit à 54 Mb/s).' });
  return out;
}

module.exports = { BAND_LABEL, block, overlap, analyse, globalAdvice, strength };
