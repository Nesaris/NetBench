#!/bin/sh
# Crée le certificat HTTPS de l'agent au premier démarrage, puis lance l'agent.
set -e
mkdir -p "$SONDE_DATA"
if [ ! -s "$SONDE_DATA/tls.key" ] || [ ! -s "$SONDE_DATA/tls.crt" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -subj "/CN=sonde-agent" -keyout "$SONDE_DATA/tls.key" -out "$SONDE_DATA/tls.crt" 2>/dev/null
  chmod 600 "$SONDE_DATA/tls.key"
fi
exec node /opt/sonde-agent/agent.js
