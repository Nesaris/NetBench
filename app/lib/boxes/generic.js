'use strict';
// Box générique : aucune API utilisée. Les appareils viennent de la table ARP de l'ordinateur
// (ceux avec qui il a échangé récemment) et de leur nom DNS local. Ping, débit et rapports marchent normalement.
const dns = require('node:dns').promises;
const { randomMac, guessModel, isConsoleName, dashify, GENERIC } = require('./common');

function create(ctx, cfg) {
  const names = new Map();
  async function nameOf(ip) {
    const c = names.get(ip); if (c && Date.now() - c.t < 600_000) return c.n;
    let n = null; try { n = (await dns.reverse(ip))[0]?.replace(/\.(home|lan|local|box|localdomain)\.?$/i, '') || null; } catch { }
    names.set(ip, { n, t: Date.now() }); return n;
  }
  return {
    id: 'generic', label: cfg.label || 'Box', host: cfg.host,
    features: { signal: false, perDeviceRate: false, wanRate: false, rename: false, block: false, ports: false, repeater: false, vm: false, auth: 'none' },
    async authState() { return { ok: true, kind: 'none' }; },
    async authorize() { return { status: 'granted' }; },
    async devices() {
      const arp = (await ctx.platform.arpTable()).filter(x => x.ip !== cfg.host && !/^(FF:|01:00:5E|33:33)/i.test(x.mac));
      const out = [];
      for (const a of arp) {
        const n = await nameOf(a.ip);
        const name = n || a.ip, model = guessModel(n || '', '');
        out.push({ id: 'arp-' + a.mac, mac: a.mac, name, ip: a.ip, type: 'other', vendor: '', via: 'box', band: null, signal: null, standard: null, linkTx: null, linkRx: null, ethMax: null, port: null, totDown: 0, totUp: 0, down: 0, up: 0, lastAct: null, isConsole: isConsoleName(name), manual: false, model, suggest: n && !GENERIC.test(n) ? dashify(n) : null, source: 'DNS local', randomMac: randomMac(a.mac), viaUnknown: true });
      }
      return out;
    },
    async wan() { return { down: null, up: null, state: 'up' }; },
    async overview() { return { system: { model: cfg.label || 'Box' } }; }
  };
}
module.exports = { id: 'generic', isp: 'other', label: 'Autre box', probe: async () => ({ ok: true }), create };
