'use strict';
// Catalogue des services reconnus à partir des domaines demandés au DNS.
// heavy : poids pour répartir le volume d'un appareil entre ses services actifs
// (une vidéo consomme beaucoup plus qu'un réseau social pour le même nombre de requêtes DNS).
// icon : identifiant simple-icons (logo), null = monogramme.
const S = [
  // vidéo
  ['netflix', 'Netflix', 'Vidéo', '#E50914', 'netflix', 25, ['netflix.com', 'netflix.net', 'nflxvideo.net', 'nflximg.net', 'nflxext.com', 'nflxso.net']],
  ['youtube', 'YouTube', 'Vidéo', '#FF0000', 'youtube', 25, ['youtube.com', 'googlevideo.com', 'ytimg.com', 'youtu.be', 'youtubei.googleapis.com', 'yt3.ggpht.com']],
  ['primevideo', 'Prime Video', 'Vidéo', '#00A8E1', 'primevideo', 25, ['primevideo.com', 'aiv-cdn.net', 'aiv-delivery.net', 'pv-cdn.net', 'media-amazon.com']],
  ['disney', 'Disney+', 'Vidéo', '#113CCF', 'disneyplus', 25, ['disneyplus.com', 'disney-plus.net', 'dssott.com', 'bamgrid.com', 'disneystreaming.com']],
  ['twitch', 'Twitch', 'Vidéo', '#9146FF', 'twitch', 25, ['twitch.tv', 'ttvnw.net', 'jtvnw.net', 'twitchcdn.net']],
  ['canal', 'Canal+', 'Vidéo', '#000000', 'canalplus', 25, ['canalplus.com', 'canal-plus.com', 'canalplus-cdn.net', 'mycanal.fr']],
  ['appletv', 'Apple TV+', 'Vidéo', '#000000', 'appletv', 25, ['tv.apple.com', 'play-edge.itunes.apple.com', 'hls.itunes.apple.com']],
  ['freetv', 'TV Freebox', 'Vidéo', '#CD1E25', null, 20, ['freebox.fr', 'free.fr', 'oqee.net', 'oqee.tv', 'proxad.net']],
  ['tf1', 'TF1+', 'Vidéo', '#0A52BF', null, 25, ['tf1.fr', 'tf1info.fr', 'tf1plus.fr']],
  ['m6', 'M6+', 'Vidéo', '#2E2E8F', null, 25, ['6play.fr', 'm6plus.fr', 'm6web.fr']],
  ['francetv', 'france.tv', 'Vidéo', '#1C1C3C', null, 25, ['france.tv', 'francetv.fr', 'ftven.fr']],
  ['crunchyroll', 'Crunchyroll', 'Vidéo', '#F47521', 'crunchyroll', 25, ['crunchyroll.com', 'vrv.co']],
  ['plex', 'Plex', 'Vidéo', '#EBAF00', 'plex', 25, ['plex.tv', 'plex.direct']],
  // réseaux sociaux
  ['tiktok', 'TikTok', 'Réseaux sociaux', '#000000', 'tiktok', 15, ['tiktok.com', 'tiktokv.com', 'tiktokcdn.com', 'tiktokcdn-eu.com', 'byteoversea.com', 'ibytedtos.com', 'musical.ly', 'ttwstatic.com']],
  ['instagram', 'Instagram', 'Réseaux sociaux', '#E4405F', 'instagram', 10, ['instagram.com', 'cdninstagram.com']],
  ['facebook', 'Facebook', 'Réseaux sociaux', '#0866FF', 'facebook', 6, ['facebook.com', 'fbcdn.net', 'fb.com', 'facebook.net', 'fbsbx.com']],
  ['snapchat', 'Snapchat', 'Réseaux sociaux', '#FFFC00', 'snapchat', 10, ['snapchat.com', 'snapkit.com', 'sc-cdn.net', 'snap-dev.net', 'snapads.com', 'feelinsonice-hrd.appspot.com']],
  ['x', 'X (Twitter)', 'Réseaux sociaux', '#000000', 'x', 6, ['twitter.com', 'x.com', 'twimg.com', 't.co']],
  ['reddit', 'Reddit', 'Réseaux sociaux', '#FF4500', 'reddit', 5, ['reddit.com', 'redd.it', 'redditmedia.com', 'redditstatic.com']],
  ['pinterest', 'Pinterest', 'Réseaux sociaux', '#BD081C', 'pinterest', 5, ['pinterest.com', 'pinimg.com']],
  ['bereal', 'BeReal', 'Réseaux sociaux', '#000000', null, 4, ['bereal.com', 'bere.al']],
  // messagerie / appels
  ['whatsapp', 'WhatsApp', 'Messagerie', '#25D366', 'whatsapp', 3, ['whatsapp.com', 'whatsapp.net']],
  ['messenger', 'Messenger', 'Messagerie', '#00B2FF', 'messenger', 3, ['messenger.com']],
  ['discord', 'Discord', 'Messagerie', '#5865F2', 'discord', 4, ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media']],
  ['telegram', 'Telegram', 'Messagerie', '#26A5E4', 'telegram', 3, ['telegram.org', 't.me', 'telegram.me']],
  ['facetime', 'FaceTime / iMessage', 'Messagerie', '#34C759', null, 3, ['facetime.apple.com', 'ess.apple.com', 'identity.apple.com', 'push.apple.com']],
  ['teams', 'Teams', 'Messagerie', '#6264A7', null, 4, ['teams.microsoft.com', 'teams.live.com', 'skype.com']],
  ['zoom', 'Zoom', 'Messagerie', '#0B5CFF', 'zoom', 6, ['zoom.us', 'zoom.com']],
  // musique
  ['spotify', 'Spotify', 'Musique', '#1DB954', 'spotify', 6, ['spotify.com', 'scdn.co', 'spotifycdn.com', 'spotify.net', 'pscdn.co']],
  ['deezer', 'Deezer', 'Musique', '#A238FF', 'deezer', 6, ['deezer.com', 'dzcdn.net']],
  ['applemusic', 'Apple Music', 'Musique', '#FA243C', 'applemusic', 6, ['music.apple.com', 'aod.itunes.apple.com', 'audio-ssl.itunes.apple.com']],
  ['soundcloud', 'SoundCloud', 'Musique', '#FF5500', 'soundcloud', 6, ['soundcloud.com', 'sndcdn.com']],
  // jeux
  ['psn', 'PlayStation Network', 'Jeux', '#0070D1', 'playstation', 20, ['playstation.net', 'playstation.com', 'sonyentertainmentnetwork.com', 'psn.com', 'scea.com', 'ribob01.net']],
  ['xbox', 'Xbox Live', 'Jeux', '#107C10', 'xbox', 20, ['xboxlive.com', 'xbox.com', 'xboxab.com', 'gamepass.com']],
  ['steam', 'Steam', 'Jeux', '#000000', 'steam', 20, ['steampowered.com', 'steamcommunity.com', 'steamcontent.com', 'steamstatic.com', 'steamserver.net', 'valvesoftware.com']],
  ['epic', 'Epic Games / Fortnite', 'Jeux', '#313131', 'epicgames', 20, ['epicgames.com', 'epicgames.dev', 'unrealengine.com', 'fortnite.com', 'ol.epicgames.com']],
  ['cod', 'Call of Duty', 'Jeux', '#000000', 'activision', 20, ['callofduty.com', 'activision.com', 'demonware.net', 'blizzard.com', 'battle.net']],
  ['ea', 'EA (FC, Apex…)', 'Jeux', '#000000', 'ea', 20, ['ea.com', 'origin.com', 'eaplay.com', 'easports.com']],
  ['riot', 'Riot (LoL, Valorant)', 'Jeux', '#D32936', 'riotgames', 15, ['riotgames.com', 'riotcdn.net', 'leagueoflegends.com', 'playvalorant.com']],
  ['roblox', 'Roblox', 'Jeux', '#000000', 'roblox', 15, ['roblox.com', 'rbxcdn.com', 'rbx.com']],
  ['rockstar', 'Rockstar / GTA', 'Jeux', '#FCAF17', 'rockstargames', 20, ['rockstargames.com', 'rsg.sc']],
  ['ubisoft', 'Ubisoft', 'Jeux', '#000000', 'ubisoft', 20, ['ubisoft.com', 'ubi.com', 'ubisoftconnect.com']],
  ['nintendo', 'Nintendo', 'Jeux', '#E60012', 'nintendo', 20, ['nintendo.net', 'nintendo.com', 'nintendo.co.jp']],
  ['minecraft', 'Minecraft', 'Jeux', '#62B47A', null, 10, ['minecraft.net', 'mojang.com', 'minecraftservices.com']],
  // mises à jour / cloud
  ['apple', 'Apple (iCloud, mises à jour)', 'Système et cloud', '#A2AAAD', 'apple', 8, ['apple.com', 'icloud.com', 'icloud-content.com', 'mzstatic.com', 'cdn-apple.com', 'apple-cloudkit.com', 'aaplimg.com', 'apple.news']],
  ['google', 'Google', 'Système et cloud', '#4285F4', 'google', 3, ['google.com', 'google.fr', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'gvt1.com', 'gvt2.com', '1e100.net', 'android.com', 'googlesyndication.com', 'doubleclick.net', 'app-measurement.com']],
  ['microsoft', 'Microsoft (Windows, Office)', 'Système et cloud', '#00A4EF', null, 8, ['microsoft.com', 'windowsupdate.com', 'windows.com', 'office.com', 'office.net', 'live.com', 'msftconnecttest.com', 'msn.com', 'bing.com', 'azureedge.net', 'onedrive.com', 'sharepoint.com']],
  ['amazon', 'Amazon / Alexa', 'Système et cloud', '#FF9900', null, 3, ['amazon.com', 'amazon.fr', 'amazonalexa.com', 'alexa.com', 'a2z.com', 'amazonaws.com', 'cloudfront.net']],
  ['samsung', 'Samsung', 'Système et cloud', '#1428A0', 'samsung', 4, ['samsung.com', 'samsungcloud.com', 'samsungapps.com', 'samsungosp.com']],
  ['meross', 'Objets connectés', 'Système et cloud', '#7A8A99', null, 1, ['meross.com', 'home-connect.com', 'bosch-home.com', 'tuya.com', 'tuyaeu.com', 'smartthings.com']],
  ['mozilla', 'Firefox / Mozilla', 'Système et cloud', '#FF7139', null, 2, ['mozilla.com', 'mozilla.org', 'mozilla.net', 'firefox.com']],
  ['openai', 'ChatGPT', 'Web', '#10A37F', 'openai', 2, ['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com']],
  ['claude', 'Claude', 'Web', '#D97757', 'anthropic', 2, ['anthropic.com', 'claude.ai']],
  ['wikipedia', 'Wikipédia', 'Web', '#000000', 'wikipedia', 1, ['wikipedia.org', 'wikimedia.org']],
  ['pronote', 'Pronote / ENT', 'Web', '#2C5F2D', null, 1, ['index-education.net', 'index-education.com', 'monlycee.net', 'ent.fr']]
].map(([id, name, cat, color, icon, heavy, domains]) => ({ id, name, cat, color, icon, heavy, domains }));

const bySuffix = new Map();
for (const s of S) for (const d of s.domains) bySuffix.set(d, s);

// Domaines techniques qu'on ignore (pas une activité de la personne)
const IGNORE = /(^|\.)(local|lan|home|arpa|in-addr\.arpa|ip6\.arpa|localdomain|fbxos\.fr|freeboxos\.fr)$|^(wpad|_dns|time|ntp|captive|connectivitycheck|clients\d?\.google\.com)$/i;

// Mots-clés de marque : reconnaissent les domaines servis par un CDN
// (ex. cma.itunes-apple.com.akadns.net = Apple, mask.apple-dns.net = Apple, a1234.nflxso.akamaized.net = Netflix)
const KEYWORDS = [
  [/(^|[.-])(itunes|apple|icloud|mzstatic|aaplimg|apple-dns|me\.com)([.-]|$)/, 'apple'],
  [/(^|[.-])(nflx|netflix)/, 'netflix'], [/(youtube|googlevideo|ytimg)/, 'youtube'], [/(^|[.-])(google|gstatic|gvt\d|doubleclick|googleapis)([.-]|$)/, 'google'],
  [/(xbox|xboxlive)/, 'xbox'], [/(microsoft|windowsupdate|msedge|office365|live\.com|msn\.)/, 'microsoft'],
  [/(playstation|sonyentertainment|\.psn\.|scea|np\.dl)/, 'psn'], [/(epicgames|fortnite|unrealengine)/, 'epic'], [/(steam|valve)/, 'steam'],
  [/(spotify|scdn)/, 'spotify'], [/(tiktok|bytedance|byteoversea|ibyte|musical\.ly)/, 'tiktok'], [/(fbcdn|facebook)/, 'facebook'], [/(instagram|cdninstagram)/, 'instagram'],
  [/(whatsapp)/, 'whatsapp'], [/(snapchat|sc-cdn|snap-dev)/, 'snapchat'], [/(primevideo|aiv-cdn|aiv-delivery)/, 'primevideo'], [/(amazon|alexa|a2z\.com)/, 'amazon'],
  [/(disney|bamgrid|dssott)/, 'disney'], [/(twitch|ttvnw|jtvnw)/, 'twitch'], [/(discord)/, 'discord'], [/(roblox|rbxcdn)/, 'roblox'], [/(activision|callofduty|demonware|blizzard|battle\.net)/, 'cod'],
  [/(riotgames|riotcdn|leagueoflegends)/, 'riot'], [/(rockstargames)/, 'rockstar'], [/(ubisoft|ubi\.com)/, 'ubisoft'], [/(nintendo)/, 'nintendo'], [/(samsung)/, 'samsung'],
  [/(mozilla|firefox)/, 'mozilla']
];
const CDN = /(akadns|akamai|akamaized|edgekey|edgesuite|cloudfront|fastly|cloudflare|azureedge|llnwd|cdn77|edgecast)\./;
const byId = id => S.find(s => s.id === id);
function classify(domain) {
  const d = String(domain || '').toLowerCase().replace(/\.$/, '');
  if (!d || IGNORE.test(d)) return null;
  const parts = d.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const s = bySuffix.get(parts.slice(i).join('.'));
    if (s) return s;
  }
  for (const [re, id] of KEYWORDS) if (re.test(d)) { const s = byId(id); if (s) return s; }
  if (CDN.test(d)) return CDNSVC;
  return OTHER;
}
// domaine « racine » pour l'affichage des sites non reconnus (ex. cdn.lemonde.fr -> lemonde.fr)
function rootDomain(domain) {
  const p = String(domain || '').toLowerCase().replace(/\.$/, '').split('.');
  if (p.length <= 2) return p.join('.');
  const sld = p[p.length - 2];
  return (/^(co|com|org|gouv|net|ac)$/.test(sld) ? p.slice(-3) : p.slice(-2)).join('.');
}
const CDNSVC = { id: 'cdn', name: 'CDN (contenu non identifié)', cat: 'Système et cloud', color: '#55606B', icon: null, heavy: 4, domains: [] };
const OTHER = { id: 'autres', name: 'Autres sites', cat: 'Web', color: '#6F7681', icon: null, heavy: 1 };
const UNKNOWN = { id: 'inconnu', name: 'Non identifié', cat: 'Autre', color: '#3A3F47', icon: null, heavy: 1 };
module.exports = { SERVICES: [...S, CDNSVC], OTHER, UNKNOWN, classify, rootDomain };
