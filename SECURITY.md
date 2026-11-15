# Sécurité

## Signaler une faille

Utilise le signalement privé de GitHub (onglet **Security → Report a vulnerability**) ou écris à developer@nesaris.cloud. Merci de ne pas publier de détails avant le correctif.

## Modèle de sécurité

| Frontière | Protection |
|---|---|
| Internet → serveur Sonde | Aucun port ouvert ; l'agent refuse toute adresse hors réseau local (10/8, 172.16/12, 192.168/16). |
| Réseau local → serveur | API HTTPS en TLS 1.3, certificat épinglé par l'app au premier contact (empreinte affichée à l'installation et dans Réglages). Compte unique créé avec un code d'installation à usage unique. Mots de passe hachés (scrypt, sel aléatoire), 12 caractères minimum, blocage 15 min après 5 échecs. Jetons de session aléatoires (256 bits), stockés hachés côté serveur, révocables. |
| Réseau local → DNS | Répond seulement au réseau local. Requêtes amont depuis un port aléatoire renouvelé, réponses acceptées seulement si l'identifiant, l'adresse et la question correspondent. |
| Page web / autre compte de l'ordinateur → app | L'app n'écoute que sur 127.0.0.1, vérifie l'en-tête Host et l'origine, et exige une clé d'accès propre à l'installation (fichier lisible par l'utilisateur seul) que seule la fenêtre ouverte par l'icône reçoit. Politique de sécurité du contenu stricte (script à nonce, aucune ressource externe). |
| Secrets sur l'ordinateur | Mots de passe de box et jeton du serveur dans le trousseau (macOS) ou chiffrés par DPAPI (Windows). |
| Mises à jour | Paquets signés Ed25519, vérifiés avant écriture ; retour automatique à la version précédente si la nouvelle plante. Node.js vérifié par SHA-256. |
| Serveur (systemd) | Utilisateur dédié sans privilège, seule capacité : ouvrir le port 53. Système en lecture seule, filtre d'appels système, pas d'accès aux dossiers personnels. |
| Docker | `cap_drop: ALL` (+ port 53 et ping), système de fichiers en lecture seule, `no-new-privileges`. |

Ce que Sonde ne voit pas : le contenu des pages et des échanges (chiffrés). L'agent ne lit que les noms de domaine demandés.
