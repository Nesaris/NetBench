'use strict';
// Registre des box prises en charge et détection automatique.
const ADAPTERS = {
  freebox: require('./freebox'),
  bbox: require('./bbox'),
  livebox: require('./livebox'),
  sfr: require('./sfr'),
  generic: require('./generic')
};
const ISPS = [
  { id: 'free', label: 'Free', box: 'freebox', models: 'Freebox Ultra, Delta, Pop, Révolution, Mini 4K', auth: 'Validation sur l\'écran de la box', level: 'complet' },
  { id: 'orange', label: 'Orange / Sosh', box: 'livebox', models: 'Livebox 4, 5, 6, 7', auth: 'Mot de passe d\'administration de la Livebox', level: 'expérimental' },
  { id: 'sfr', label: 'SFR / RED', box: 'sfr', models: 'NB4, NB6, NB6V, NB6VAC (les SFR Box 8 passent en mode générique)', auth: 'Identifiant et mot de passe de la box', level: 'expérimental' },
  { id: 'bouygues', label: 'Bouygues Telecom / B&You', box: 'bbox', models: 'Bbox Ultym, Must, Fit, Wi‑Fi 6', auth: 'Mot de passe d\'administration de la Bbox', level: 'expérimental' },
  { id: 'other', label: 'Autre / je ne sais pas', box: 'generic', models: 'N\'importe quelle box', auth: 'Aucune', level: 'ping et débit seulement' }
];

// Détecte la box : d'abord celle de l'opérateur choisi, puis toutes les autres.
async function detect(gateway, isp) {
  const want = ISPS.find(i => i.id === isp)?.box;
  const order = [want, 'freebox', 'livebox', 'bbox', 'sfr'].filter((v, i, a) => v && v !== 'generic' && a.indexOf(v) === i);
  for (const id of order) {
    try { const r = await ADAPTERS[id].probe(gateway); if (r.ok) return { box: id, isp: ADAPTERS[id].isp, ...r, host: r.host || gateway, expected: id === want }; } catch { }
  }
  return { box: 'generic', isp: 'other', host: gateway, model: null, ok: true, expected: want === 'generic' };
}
module.exports = { ADAPTERS, ISPS, detect };
