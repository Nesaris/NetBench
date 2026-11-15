'use strict';
// Outils partagés par les adaptateurs de box.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = (v, d = 1) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// fetch avec délai, sans dépendance
async function http(url, opt = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opt.timeout || 6000);
  try {
    const r = await fetch(url, { ...opt, signal: ctl.signal, redirect: 'manual' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { }
    return { status: r.status, headers: r.headers, text, json };
  } finally { clearTimeout(t); }
}
const err = (msg, code, extra) => Object.assign(new Error(msg), { code, ...extra });

const GENERIC = /^(android(-\d+|_[a-z0-9]+)?|localhost|iphone|ipad|unknown|inconnu|esp_[0-9a-f]+|[0-9a-f]{8}-[0-9a-f]{4}-.*|mac-[0-9a-f]+|pc-?[0-9a-f]{6,}|.*\(\d+\.\d+\.\d+\.\d+\))$/i;
const clean = n => String(n || '').replace(/\(\d+\.\d+\.\d+\.\d+\)/, '').trim();
const dashify = n => clean(n).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const normMac = m => String(m || '').toUpperCase().replace(/-/g, ':');
const randomMac = mac => /^.[26AE]/i.test(mac || '');

// Devine la famille d'un appareil à partir de son nom réseau (box sans mDNS/UPnP détaillés)
function guessModel(host, vendor) {
  const h = String(host || '') + ' ' + String(vendor || '');
  if (/^PS5|PlayStation ?5/i.test(h)) return 'PlayStation 5';
  if (/^PS4|PlayStation ?4/i.test(h)) return 'PlayStation 4';
  if (/xbox/i.test(h)) return 'Xbox';
  if (/nintendo|switch/i.test(h)) return 'Nintendo Switch';
  if (/iphone/i.test(h)) return 'iPhone';
  if (/ipad/i.test(h)) return 'iPad';
  if (/macbook/i.test(h)) return 'MacBook';
  if (/homepod/i.test(h)) return 'Apple HomePod';
  if (/apple-?tv/i.test(h)) return 'Apple TV';
  if (/galaxy|^SM-|samsung/i.test(h)) return 'Samsung';
  if (/^amazon-|echo|fire ?tv/i.test(h)) return 'Amazon Echo / Fire';
  if (/chromecast|google-?home|nest/i.test(h)) return 'Appareil Google';
  if (/^android/i.test(h)) return 'Appareil Android';
  if (/^(DESKTOP|LAPTOP)-/i.test(h)) return 'PC Windows';
  return null;
}
const isConsoleName = n => /ps5|ps4|playstation|xbox|switch|nintendo/i.test(n || '');

module.exports = { sleep, round, http, err, GENERIC, clean, dashify, normMac, randomMac, guessModel, isConsoleName };
