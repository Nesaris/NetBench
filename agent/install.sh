#!/usr/bin/env bash
# Installe ou met à jour Sonde Agent (DNS local qui montre quels services utilise chaque appareil).
#   curl -fsSL https://raw.githubusercontent.com/Nesaris/sonde/main/agent/install.sh | sudo bash              # service systemd
#   curl -fsSL https://raw.githubusercontent.com/Nesaris/sonde/main/agent/install.sh | sudo bash -s -- --docker
# Options : --docker | --systemd | --update | --uninstall
# Chaque version est vérifiée avec la signature Ed25519 du mainteneur avant installation.
set -euo pipefail

REPO="${SONDE_REPO:-Nesaris/sonde}"
DIR=/opt/sonde-agent
DATA=/var/lib/sonde-agent
PUBKEY='MCowBQYDK2VwAyEAY03Xgj+jmh+tZbBD0cI+qQuVwLH+L6/0qAGwyCFflE4='
NODE_MAJOR=22

say() { printf '\033[1;36m›\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "Lance ce script avec sudo."
[ "$(uname -s)" = Linux ] || die "Ce script est pour Linux (Debian, Ubuntu, Raspberry Pi OS…)."

MODE=""; ACTION=install
for a in "$@"; do case "$a" in
  --docker) MODE=docker ;; --systemd) MODE=systemd ;; --update) ACTION=update ;; --uninstall) ACTION=uninstall ;;
  *) die "Option inconnue : $a" ;; esac; done
[ -z "$MODE" ] && [ -f "$DIR/mode" ] && MODE="$(cat "$DIR/mode")"
[ -z "$MODE" ] && MODE=systemd

if [ "$ACTION" = uninstall ]; then
  say "Désinstallation de Sonde Agent"
  systemctl disable --now sonde-agent sonde-agent-update.timer 2>/dev/null || true
  rm -f /etc/systemd/system/sonde-agent.service /etc/systemd/system/sonde-agent-update.{service,timer}
  if command -v docker >/dev/null && [ -f "$DIR/app/docker-compose.yml" ]; then (cd "$DIR/app" && docker compose down) || true; fi
  systemctl daemon-reload || true
  rm -rf "$DIR"; say "Fait. Les données ($DATA) sont gardées : supprime-les avec  sudo rm -rf $DATA"
  exit 0
fi

for c in curl tar; do command -v $c >/dev/null || { say "Installation de $c"; apt-get update -qq && apt-get install -y -qq $c; }; done
command -v openssl >/dev/null || { apt-get update -qq && apt-get install -y -qq openssl; }
mkdir -p "$DIR" "$DATA"; chmod 700 "$DATA"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- Node.js officiel (vérifié par SHA-256)
case "$(uname -m)" in x86_64) NA=x64 ;; aarch64|arm64) NA=arm64 ;; armv7l) NA=armv7l ;; *) die "Processeur non pris en charge : $(uname -m)" ;; esac
install_node() {
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  curl -fsSL "$base/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  local line; line="$(grep -E "node-v[0-9.]+-linux-${NA}\.tar\.xz$" "$TMP/SHASUMS256.txt" | head -1)"
  local file="${line##* }" sum="${line%% *}"
  [ -n "$file" ] || die "Version de Node introuvable"
  if [ -x "$DIR/node/bin/node" ] && [ "$(cat "$DIR/node/.file" 2>/dev/null)" = "$file" ]; then return; fi
  say "Téléchargement de Node.js ($file)"
  curl -fsSL "$base/$file" -o "$TMP/$file"
  echo "$sum  $TMP/$file" | sha256sum -c --status || die "Empreinte de Node.js incorrecte : téléchargement refusé"
  command -v xz >/dev/null || apt-get install -y -qq xz-utils
  rm -rf "$DIR/node.new" && mkdir -p "$DIR/node.new" && tar -xJf "$TMP/$file" -C "$DIR/node.new" --strip-components=1
  echo "$file" > "$DIR/node.new/.file"; rm -rf "$DIR/node"; mv "$DIR/node.new" "$DIR/node"
}
install_node
NODE="$DIR/node/bin/node"

# ---------------------------------------------------------------- dernière version signée
say "Recherche de la dernière version"
REL="$(curl -fsSL -H 'accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest")"
VER="$(printf '%s' "$REL" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tag_name.replace(/^v/,"")))')"
CUR="$(cat "$DIR/app/version.json" 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("")}})' || true)"
if [ "$ACTION" = update ] && [ "$CUR" = "$VER" ]; then say "Déjà à jour ($VER)"; exit 0; fi
URL="https://github.com/$REPO/releases/download/v$VER/sonde-agent-$VER.tar.gz"
curl -fsSL "$URL" -o "$TMP/agent.tgz"; curl -fsSL "$URL.sig" -o "$TMP/agent.tgz.sig"
PUB="$PUBKEY" "$NODE" -e '
  const c=require("crypto"),fs=require("fs");
  const pub="-----BEGIN PUBLIC KEY-----\n"+process.env.PUB+"\n-----END PUBLIC KEY-----";
  const ok=c.verify(null,fs.readFileSync(process.argv[1]),c.createPublicKey(pub),Buffer.from(fs.readFileSync(process.argv[2],"utf8").trim(),"base64"));
  process.exit(ok?0:1)' "$TMP/agent.tgz" "$TMP/agent.tgz.sig" || die "Signature invalide : cette version n'a pas été publiée par le mainteneur. Installation annulée."
say "Signature vérifiée (version $VER)"
rm -rf "$DIR/app.new" && mkdir -p "$DIR/app.new" && tar -xzf "$TMP/agent.tgz" -C "$DIR/app.new"
rm -rf "$DIR/app.old"; [ -d "$DIR/app" ] && mv "$DIR/app" "$DIR/app.old"; mv "$DIR/app.new" "$DIR/app"
echo "$MODE" > "$DIR/mode"
# le script lui-même (dans le paquet signé), pour les mises à jour automatiques
[ -f "$DIR/app/install.sh" ] && install -m 755 "$DIR/app/install.sh" "$DIR/install.sh"

# ---------------------------------------------------------------- ping sans droits root (mesures en continu)
command -v ping >/dev/null || apt-get install -y -qq iputils-ping >/dev/null
echo 'net.ipv4.ping_group_range = 0 2147483647' > /etc/sysctl.d/60-sonde-ping.conf
sysctl -q -p /etc/sysctl.d/60-sonde-ping.conf || true

# ---------------------------------------------------------------- certificat HTTPS de l'agent
if [ ! -s "$DATA/tls.key" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -subj "/CN=sonde-agent" -keyout "$DATA/tls.key" -out "$DATA/tls.crt" 2>/dev/null
fi

# ---------------------------------------------------------------- port 53 : le DNS local d'Ubuntu (systemd-resolved) l'occupe
if ss -lunp 2>/dev/null | grep -q '127.0.0.53:53'; then
  say "Libération du port 53 (désactivation du relais DNS local de systemd-resolved)"
  mkdir -p /etc/systemd/resolved.conf.d
  printf '[Resolve]\nDNSStubListener=no\n' > /etc/systemd/resolved.conf.d/sonde.conf
  ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
  systemctl restart systemd-resolved
fi
OTHER="$(ss -lunp 2>/dev/null | awk '$5 ~ /:53$/ && $0 !~ /node/ {print $0}' | head -1)"
[ -n "$OTHER" ] && [ "$ACTION" = install ] && die "Le port 53 est déjà utilisé par un autre programme (Pi-hole, dnsmasq, AdGuard ?) : $OTHER"

if [ "$MODE" = docker ]; then
  command -v docker >/dev/null || die "Docker n'est pas installé (https://docs.docker.com/engine/install/)."
  docker compose version >/dev/null 2>&1 || die "Le module « docker compose » est requis."
  say "Construction et démarrage du conteneur"
  (cd "$DIR/app" && docker compose up -d --build)
else
  id sonde-agent >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin sonde-agent
  chown -R sonde-agent:sonde-agent "$DATA"
  cat > /etc/systemd/system/sonde-agent.service <<UNIT
[Unit]
Description=Sonde Agent (DNS local et services par appareil)
After=network-online.target
Wants=network-online.target

[Service]
User=sonde-agent
Group=sonde-agent
ExecStart=$NODE $DIR/app/agent.js
Environment=SONDE_DATA=$DATA
Environment=SONDE_MIN_FREE_GB=1
Environment=SONDE_JOURNAL_MB=1500
Restart=always
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=no
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT
  cat > /etc/systemd/system/sonde-agent-update.service <<UNIT
[Unit]
Description=Mise à jour de Sonde Agent
[Service]
Type=oneshot
ExecStart=$DIR/install.sh --update
UNIT
  cat > /etc/systemd/system/sonde-agent-update.timer <<UNIT
[Unit]
Description=Vérifie chaque jour les mises à jour de Sonde Agent
[Timer]
OnCalendar=daily
RandomizedDelaySec=2h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now sonde-agent sonde-agent-update.timer >/dev/null
  systemctl restart sonde-agent
fi

# pare-feu : si ufw est actif, on n'ouvre le DNS et l'API qu'au réseau local
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  for net in 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12; do ufw allow from $net to any port 53 >/dev/null; ufw allow from $net to any port 8443 proto tcp >/dev/null; done
fi

for i in $(seq 1 20); do [ -s "$DATA/setup-code" ] || [ -s "$DATA/users.json" ] && break; sleep 1; done
IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
say "Sonde Agent $VER installé ($MODE)."
echo
echo "  Dans Sonde : onglet Services → adresse de l'agent :  https://${IP:-IP-de-cette-machine}:8443"
if [ -s "$DATA/setup-code" ]; then
  echo "  Puis crée ton identifiant et ton mot de passe dans l'app, avec ce code d'installation :  $(cat "$DATA/setup-code")"
  echo "  (sans ce code, personne d'autre sur le réseau ne peut créer le compte à ta place)"
else
  echo "  Puis connecte-toi avec ton identifiant et ton mot de passe."
fi
echo "  Pour que les appareils l'utilisent : DNS 1 = ${IP:-cette machine}, DNS 2 = ta box (réglage DHCP de la box, ou sur chaque appareil)."
echo
