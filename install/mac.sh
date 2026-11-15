#!/bin/bash
# Installe Rebond (anciennement Sonde) sur Mac (ou le met à jour, ou le désinstalle avec --uninstall).
#   curl -fsSL https://raw.githubusercontent.com/Nesaris/sonde/main/install/mac.sh | bash
# Rien n'est installé en dehors de ton dossier utilisateur, aucun mot de passe administrateur n'est demandé.
# Node.js est téléchargé depuis nodejs.org (empreinte SHA-256 vérifiée) et Sonde depuis les releases GitHub
# (signature Ed25519 du mainteneur vérifiée avant installation).
set -euo pipefail

REPO="${SONDE_REPO:-Nesaris/sonde}"
PUBKEY='MCowBQYDK2VwAyEAY03Xgj+jmh+tZbBD0cI+qQuVwLH+L6/0qAGwyCFflE4='
LABEL=fr.nesaris.sonde
SUP="$HOME/Library/Application Support/Sonde"
ROOT="$SUP/app"
APP="$HOME/Applications/Rebond.app"
OLDAPPS=("$HOME/Applications/Sonde.app" "$HOME/Applications/Pouls.app")
NOAPP=0; [ "${1:-}" = "--no-app" ] && NOAPP=1
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
D="gui/$(id -u)"

say() { printf '\033[1;36m›\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || die "Ce script est pour macOS."

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$D/$LABEL" 2>/dev/null || true
  rm -rf "$APP" "${OLDAPPS[@]}" "$PLIST" "$ROOT"
  say "Rebond est désinstallé. Tes rapports et réglages restent dans « $SUP » : supprime ce dossier pour tout effacer."
  exit 0
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$ROOT/versions" "$HOME/Applications" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# ---------------------------------------------------------------- Node.js
case "$(uname -m)" in arm64) NA=arm64 ;; x86_64) NA=x64 ;; *) die "Processeur non pris en charge" ;; esac
BASE="https://nodejs.org/dist/latest-v22.x"
curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/sums"
LINE="$(grep -E "node-v[0-9.]+-darwin-${NA}\.tar\.gz$" "$TMP/sums" | head -1)"; FILE="${LINE##* }"; SUM="${LINE%% *}"
[ -n "$FILE" ] || die "Version de Node introuvable"
if [ "$(cat "$ROOT/node/.file" 2>/dev/null)" != "$FILE" ]; then
  say "Téléchargement de Node.js ($FILE)"
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  [ "$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)" = "$SUM" ] || die "Empreinte de Node.js incorrecte : téléchargement refusé"
  rm -rf "$ROOT/node.new" && mkdir -p "$ROOT/node.new" && tar -xzf "$TMP/$FILE" -C "$ROOT/node.new" --strip-components=1
  echo "$FILE" > "$ROOT/node.new/.file"; rm -rf "$ROOT/node"; mv "$ROOT/node.new" "$ROOT/node"
fi
NODE="$ROOT/node/bin/node"

# ---------------------------------------------------------------- moteur de Rebond (paquet signé)
say "Téléchargement de la dernière version de Rebond"
curl -fsSL -H 'accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest" -o "$TMP/rel.json"
VER="$("$NODE" -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).tag_name.replace(/^v/,"")' "$TMP/rel.json")"
URL="https://github.com/$REPO/releases/download/v$VER/sonde-app-$VER.json"
curl -fsSL "$URL" -o "$TMP/app.json"; curl -fsSL "$URL.sig" -o "$TMP/app.json.sig"
PUB="$PUBKEY" DEST="$ROOT/versions/$VER" "$NODE" -e '
  const c=require("crypto"),fs=require("fs"),path=require("path");
  const buf=fs.readFileSync(process.argv[1]);
  const pub="-----BEGIN PUBLIC KEY-----\n"+process.env.PUB+"\n-----END PUBLIC KEY-----";
  if(!c.verify(null,buf,c.createPublicKey(pub),Buffer.from(fs.readFileSync(process.argv[2],"utf8").trim(),"base64"))){console.error("Signature invalide : installation annulée.");process.exit(1)}
  const b=JSON.parse(buf), dest=process.env.DEST, tmp=dest+".tmp";
  fs.rmSync(tmp,{recursive:true,force:true});
  for(const [rel,b64] of Object.entries(b.files)){ const n=path.normalize(rel); if(path.isAbsolute(n)||n.startsWith("..")||!/^[\w./-]+$/.test(rel)) throw new Error("chemin interdit "+rel); const f=path.join(tmp,n); fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,Buffer.from(b64,"base64")); }
  fs.rmSync(dest,{recursive:true,force:true}); fs.renameSync(tmp,dest);' "$TMP/app.json" "$TMP/app.json.sig" || die "Paquet refusé"
say "Signature vérifiée (version $VER)"
[ -f "$ROOT/current" ] && cp "$ROOT/current" "$ROOT/previous"
echo "$VER" > "$ROOT/current"
cp "$ROOT/versions/$VER/launcher.js" "$ROOT/launcher.js"

# ---------------------------------------------------------------- moteur (agent launchd de l'utilisateur, lancé à la demande)
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/launcher.js</string></array>
<key>RunAtLoad</key><false/><key>KeepAlive</key><false/>
<key>StandardOutPath</key><string>$HOME/Library/Logs/Sonde.log</string>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/Sonde.log</string>
</dict></plist>
PL
launchctl bootout "$D/$LABEL" 2>/dev/null || true
# le moteur peut mettre un instant à s'arrêter : on réessaie
for i in 1 2 3 4 5 6 7 8 9 10; do launchctl bootstrap "$D" "$PLIST" 2>/dev/null && break; sleep 0.5; done

# ---------------------------------------------------------------- application (fenêtre native, sans navigateur)
if [ "$NOAPP" = 1 ]; then say "Moteur de Rebond $VER installé."; exit 0; fi
rm -rf "$APP" "${OLDAPPS[@]}"
# Rebond.app native (vérifiée avec la même signature Ed25519) ; sinon, lanceur de secours
NURL="https://github.com/$REPO/releases/download/v$VER/Rebond-mac.zip"
if curl -fsSL "$NURL" -o "$TMP/Rebond-mac.zip" && curl -fsSL "$NURL.sig" -o "$TMP/Rebond-mac.zip.sig" && PUB="$PUBKEY" "$NODE" -e '
  const c=require("crypto"),fs=require("fs");
  const pub="-----BEGIN PUBLIC KEY-----\n"+process.env.PUB+"\n-----END PUBLIC KEY-----";
  process.exit(c.verify(null,fs.readFileSync(process.argv[1]),c.createPublicKey(pub),Buffer.from(fs.readFileSync(process.argv[2],"utf8").trim(),"base64"))?0:1)' "$TMP/Rebond-mac.zip" "$TMP/Rebond-mac.zip.sig"; then
  ditto -x -k "$TMP/Rebond-mac.zip" "$HOME/Applications"
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
  say "App native vérifiée (signature)"
else
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Rebond</string><key>CFBundleDisplayName</key><string>Rebond</string>
<key>CFBundleIdentifier</key><string>fr.nesaris.rebond</string><key>CFBundleExecutable</key><string>Rebond</string>
<key>CFBundleIconFile</key><string>icon</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VER</string><key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
PL
  [ -f "$ROOT/versions/$VER/assets/icon.icns" ] && cp "$ROOT/versions/$VER/assets/icon.icns" "$APP/Contents/Resources/icon.icns"
  "$NODE" -e 'process.stdout.write(require(process.argv[1]).mac())' "$ROOT/versions/$VER/lib/launchers.js" > "$APP/Contents/MacOS/Rebond"
  chmod 755 "$APP/Contents/MacOS/Rebond"
fi

touch "$APP"; /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
say "Rebond $VER est installé : ~/Applications/Rebond.app"
say "Les mises à jour suivantes s'installent toutes seules (Réglages → Mises à jour)."
open "$APP"
