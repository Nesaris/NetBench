'use strict';
// Lanceurs de la fenêtre Sonde (icône Mac, raccourci Windows). Ils sont réécrits à chaque démarrage de l'app :
// une mise à jour peut ainsi les corriger. La fenêtre s'ouvre avec la clé d'accès de l'interface (ui.key).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mac() {
  return `#!/bin/bash
# Démarre le moteur s'il ne tourne pas, puis ouvre la fenêtre de Sonde avec sa clé d'accès.
URL=http://127.0.0.1:47800
LABEL=fr.nesaris.sonde
SUP="$HOME/Library/Application Support/Sonde"
if ! /usr/bin/curl -s -m 1 -o /dev/null "$URL/"; then
  launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LABEL.plist"
  for i in $(seq 1 50); do /usr/bin/curl -s -m 1 -o /dev/null "$URL/" && break; sleep 0.2; done
fi
K="$(cat "$SUP/ui.key" 2>/dev/null)"
for B in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if [ -d "/Applications/$B.app" ] || [ -d "$HOME/Applications/$B.app" ]; then
    exec open -na "$B" --args --app="$URL/?k=$K" --user-data-dir="$SUP/window" --window-size=1480,940 --no-first-run --no-default-browser-check
  fi
done
open "$URL/?k=$K"
`;
}
function win(root, node, dataDir) {
  return `' Démarre le moteur de Sonde s'il ne tourne pas, puis ouvre la fenêtre avec sa clé d'accès.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Function Up()
  On Error Resume Next
  Set x = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  x.setTimeouts 500, 500, 500, 500
  x.Open "GET", "http://127.0.0.1:47800/", False
  x.Send
  Up = (Err.Number = 0 And x.Status > 0)
End Function
If Not Up() Then
  sh.Run """${node}"" ""${path.join(root, 'launcher.js')}""", 0, False
  For i = 1 To 50
    WScript.Sleep 200
    If Up() Then Exit For
  Next
End If
k = ""
On Error Resume Next
k = Trim(fso.OpenTextFile("${path.join(dataDir, 'ui.key')}", 1).ReadLine)
On Error GoTo 0
sh.Run "msedge --app=http://127.0.0.1:47800/?k=" & k & " --user-data-dir=""${path.join(process.env.LOCALAPPDATA || os.homedir(), 'Sonde', 'window')}"" --window-size=1480,940 --no-first-run", 1, False
`.replace(/\r?\n/g, '\r\n');
}
function write(file, content, mode) {
  try { if (fs.readFileSync(file, 'utf8') === content) return false; } catch { return false; } // seulement s'il existe déjà
  fs.writeFileSync(file, content, mode ? { mode } : undefined); return true;
}
function refresh({ root, node, dataDir, log }) {
  if (process.platform === 'darwin') {
    const f = path.join(os.homedir(), 'Applications', 'Sonde.app', 'Contents', 'MacOS', 'Sonde');
    if (write(f, mac(), 0o755)) log('lanceur Mac mis à jour');
  } else if (process.platform === 'win32') {
    const f = path.join(root, 'Sonde.vbs');
    if (fs.existsSync(f)) { const c = win(root, node, dataDir); try { if (fs.readFileSync(f, 'utf16le').replace(/^﻿/, '') !== c) { fs.writeFileSync(f, '﻿' + c, 'utf16le'); log('lanceur Windows mis à jour'); } } catch { } }
  }
}
module.exports = { refresh, mac, win };
