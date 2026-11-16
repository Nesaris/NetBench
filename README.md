# NetBench

<img src="assets/icon.svg" width="96" alt="">

*Anciennement « Sonde ».*

**Banc de test du réseau de la maison, pour Mac et Windows.** Ping en continu de chaque appareil, tests de débit et de charge, détection des pics de latence et de leur cause, rapports à comparer avant/après un changement (répéteur, CPL, câble…), et ce que voit la box : appareils, signal Wi‑Fi, débit de la fibre.

*Home network test bench for macOS and Windows (French UI). Works with Freebox, Livebox, SFR Box and Bbox. Zero dependencies, local only, signed auto-updates.*

## Installation

### Télécharger l'app

Dans la [dernière release](https://github.com/Nesaris/NetBench/releases/latest) :

- **Mac** (macOS 11 ou plus récent, Apple Silicon et Intel) : `NetBench-mac.zip`. Décompresse, glisse **NetBench** dans Applications et ouvre-la. L'app n'est pas signée par un compte développeur Apple : la première fois, fais clic droit → **Ouvrir** (ou Réglages Système → Confidentialité et sécurité → **Ouvrir quand même**).
- **Windows 10 / 11** : `NetBench.exe`. Windows SmartScreen peut afficher « Windows a protégé votre ordinateur » : **Informations complémentaires → Exécuter quand même**.

Au premier lancement, l'app installe son moteur toute seule (Node.js vérifié par empreinte SHA-256, moteur vérifié par signature Ed25519). NetBench est une vraie app avec sa propre fenêtre : elle n'utilise aucun navigateur, seulement le moteur web intégré au système (WebKit sur Mac, WebView2 sur Windows).

### Ou en une ligne de commande

**Mac** (macOS 11 ou plus récent) — dans le Terminal :

```bash
curl -fsSL https://raw.githubusercontent.com/Nesaris/NetBench/main/install/mac.sh | bash
```

**Windows 10 / 11** — dans PowerShell :

```powershell
irm https://raw.githubusercontent.com/Nesaris/NetBench/main/install/win.ps1 | iex
```

Au premier lancement, NetBench cherche ta box tout seul, te demande si c'est bien elle, puis s'y connecte :

| Opérateur | Box | Connexion | Prise en charge |
|---|---|---|---|
| Free | Freebox Ultra, Delta, Pop, Révolution, Mini 4K | validation sur l'écran de la box | complète |
| Orange / Sosh | Livebox 4, 5, 6, 7 | mot de passe admin de la Livebox | expérimentale |
| SFR / RED | NB4, NB6, NB6V, NB6VAC | identifiant et mot de passe de la box | expérimentale |
| Bouygues / B&You | Bbox Ultym, Must, Fit, Wi‑Fi 6 | mot de passe admin de la Bbox | expérimentale |
| Autre | n'importe quelle box | — | ping et débit |

« Expérimentale » : écrit à partir de l'API de la box, pas encore testé sur toutes les versions. Retours bienvenus dans les *issues*.

Ce que chaque box permet :

| | Freebox | Livebox | Bbox | SFR Box |
|---|---|---|---|---|
| Liste des appareils | oui | oui | oui | oui |
| Signal Wi‑Fi par appareil | oui | oui | oui | non |
| Trafic par appareil | oui | non | non | non |
| Débit de la fibre en direct | oui | oui | oui | non |
| Renommer un appareil | oui | oui | oui | non |
| Bloquer un appareil | oui (Wi‑Fi) | oui | non | non |
| Optimiser le Wi‑Fi (canaux voisins, largeur, en un clic ou automatique) | oui | pas encore | pas encore | pas encore |

Le ping, les tests de débit, la surveillance des pics et les rapports marchent avec toutes les box, puisqu'ils sont mesurés depuis l'ordinateur.

## Agent DNS (facultatif) : quels services utilise chaque appareil

L'onglet **Services** montre en direct chaque site ou service consulté (Netflix, YouTube, jeux…) avec son logo, qui l'utilise, et permet de bloquer un site ou un service, de recevoir des alertes Discord ou Telegram, et de donner la priorité à un appareil. Il faut pour ça un petit serveur DNS local, l'agent. Trois façons de l'installer :

- **Sur l'ordinateur** : bouton « Activer sur cet ordinateur » dans l'onglet Services. Actif seulement quand NetBench est ouvert. Sur chaque appareil à surveiller : DNS 1 = l'ordinateur, DNS 2 = la box.
- **Docker** (NAS, serveur, Raspberry Pi) :
  ```bash
  curl -fsSL https://raw.githubusercontent.com/Nesaris/NetBench/main/agent/install.sh | sudo bash -s -- --docker
  ```
- **Debian / Ubuntu Server** (ou VM Debian sur une Freebox), en service systemd :
  ```bash
  curl -fsSL https://raw.githubusercontent.com/Nesaris/NetBench/main/agent/install.sh | sudo bash
  ```

L'agent ne lit que les **noms de domaine** demandés (pas les pages ni le contenu, qui sont chiffrés). Ses données restent sur ta machine. Un appareil qui utilise son propre DNS chiffré (navigateur avec « DNS sécurisé », VPN, Relais privé iCloud) ou le DNS IPv6 de la box n'apparaît pas.

## Sécurité et vie privée

- **Tout reste chez toi.** NetBench écoute seulement sur `127.0.0.1` ; l'agent répond seulement au réseau local. Aucune télémétrie.
- **Mots de passe de box** gardés dans le coffre du système : trousseau d'accès sur Mac, chiffrement DPAPI du compte sur Windows.
- **Agent** : API HTTPS en TLS 1.3 (certificat épinglé, empreinte affichée), compte créé avec un code d'installation à usage unique, mots de passe hachés (scrypt), blocage après 5 essais ratés, sessions révocables.
- **Interface** : accessible seulement à la fenêtre ouverte par l'icône (clé d'accès locale), politique de sécurité du contenu stricte, aucune ressource chargée depuis Internet (polices et pictogrammes inclus).
- **Mises à jour signées** : chaque version est signée (Ed25519) par le mainteneur. NetBench, les installeurs et l'agent vérifient la signature avant d'installer quoi que ce soit ; une version modifiée par quelqu'un d'autre est refusée. Node.js est téléchargé depuis nodejs.org et son empreinte SHA-256 est vérifiée.
- **Retour arrière automatique** : si une nouvelle version plante au démarrage, NetBench revient à la précédente.

Détails et signalement d'une faille : [SECURITY.md](SECURITY.md).

## Mises à jour

NetBench vérifie les nouvelles versions au démarrage puis toutes les 6 heures, et les installe toute seule quand aucun test n'est en cours (désactivable dans Réglages → Mises à jour). L'agent installé par script se met à jour chaque jour (minuteur systemd ou reconstruction Docker).

## Désinstaller

- Mac : `curl -fsSL https://raw.githubusercontent.com/Nesaris/NetBench/main/install/mac.sh | bash -s -- --uninstall`
- Windows : `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Nesaris/NetBench/main/install/win.ps1))) -Uninstall`
- Agent : `sudo /opt/sonde-agent/install.sh --uninstall`

## Développement

Aucune dépendance : Node.js 18 ou plus récent suffit.

```bash
node app/server.js          # puis http://127.0.0.1:47800
```

Structure : `app/` (moteur + interface), `native-src/` (fenêtres natives Mac en Swift et Windows en Go, construites par `tools/build-native.sh`), `app/lib/boxes/` (une couche par box), `app/lib/platform.js` (ping, Wi‑Fi, coffre à secrets selon le système), `agent/` (DNS local), `install/` (installeurs), `tools/` (signature et publication).

Publier une version (mainteneur) : `node tools/keygen.mjs` une seule fois, puis `node tools/release.mjs 1.0.1 "notes"`.

## Licence

MIT
