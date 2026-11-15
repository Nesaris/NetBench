#!/usr/bin/env node
// Lanceur de Sonde : démarre la version installée, la relance après une mise à jour (code 75)
// et revient à la version précédente si la nouvelle plante trois fois de suite au démarrage.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const R = __dirname;
const read = f => { try { return fs.readFileSync(path.join(R, f), 'utf8').trim(); } catch { return null; } };
let crashes = 0;
function start() {
  const v = read('current');
  const entry = v && path.join(R, 'versions', v, 'server.js');
  if (!entry || !fs.existsSync(entry)) { console.error('Sonde : aucune version installée'); process.exit(1); }
  const t0 = Date.now();
  const p = spawn(process.execPath, [entry], { stdio: 'inherit', env: process.env, windowsHide: true });
  const fwd = s => { try { p.kill(s); } catch { } };
  process.on('SIGTERM', () => fwd('SIGTERM')); process.on('SIGINT', () => fwd('SIGINT'));
  p.on('exit', code => {
    process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT');
    if (code === 75) { crashes = 0; return start(); } // mise à jour installée
    if (code === 0 || code === null) return process.exit(0);
    if (Date.now() - t0 < 30000) {
      crashes++;
      const prev = read('previous');
      if (crashes >= 3 && prev && prev !== v && fs.existsSync(path.join(R, 'versions', prev, 'server.js'))) {
        console.error(`Sonde ${v} plante au démarrage : retour à ${prev}`);
        fs.writeFileSync(path.join(R, 'current'), prev); fs.writeFileSync(path.join(R, 'bad'), v); crashes = 0;
      }
      if (crashes < 6) return setTimeout(start, 1000);
    }
    process.exit(code);
  });
}
start();
