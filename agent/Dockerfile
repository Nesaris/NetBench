# Sonde Agent — image minimale (Node officiel sur Alpine), aucune dépendance npm.
FROM node:22-alpine
RUN apk add --no-cache openssl iputils
WORKDIR /opt/sonde-agent
COPY agent.js services.js version.json ./
# moteur de mesure (ping continu, débit de la box, historique) : le même que celui de l'app
COPY engine ./engine
COPY docker-entrypoint.sh /usr/local/bin/sonde-agent-entrypoint
RUN chmod 0755 /usr/local/bin/sonde-agent-entrypoint
ENV SONDE_DATA=/data
VOLUME ["/data"]
# DNS (53/udp, 53/tcp) et API HTTPS (8443) — utiliser network_mode: host pour voir l'adresse de chaque appareil
EXPOSE 53/udp 53/tcp 8443/tcp
ENTRYPOINT ["/usr/local/bin/sonde-agent-entrypoint"]
