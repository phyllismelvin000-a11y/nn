# Bot Telegram — Vente produits avec paiement Wave

Bot Telegram (Node.js, Telegraf, Firestore) pour vendre des abonnements ou produits : catalogue par catégories, paiement via lien Wave, backoffice web pour la gestion des commandes et du stock.

---

## Prérequis

- **Node.js** 18+
- **Telegram** : un bot créé via [@BotFather](https://t.me/BotFather)
- **Firebase** : un projet avec Firestore activé
- **Wave** : Merchant ID (ou numéro pour fallback WhatsApp)

---

## Installation

### 1. Cloner et installer les dépendances

```bash
cd telegram-bot
npm install
```

### 2. Créer le bot Telegram

- Ouvrir [@BotFather](https://t.me/BotFather) → `/newbot`
- Récupérer le **BOT_TOKEN**

### 3. Récupérer ton Chat ID (admin)

- Envoyer un message à [@userinfobot](https://t.me/userinfobot)
- Noter ton **ADMIN_CHAT_ID** (chiffres)

### 4. Configurer Firebase

1. [Firebase Console](https://console.firebase.google.com) → ton projet
2. **Firestore Database** → Créer une base (région ex. `europe-west1`)
3. **Paramètres du projet** → Comptes de service → **Générer une nouvelle clé privée**
4. Renommer le fichier téléchargé en **`serviceAccountKey.json`**
5. Le placer dans le dossier **`telegram-bot/`** (à la racine du projet)

### 5. Variables d’environnement

Copier l’exemple et remplir :

```bash
cp .env.example .env
```

Éditer `.env` avec au minimum :

```env
BOT_TOKEN=123456:ABC-DEF...
ADMIN_CHAT_ID=123456789
WAVE_MERCHANT_ID=M_xxx
WAVE_PHONE=221771234567
BACKOFFICE_PASSWORD=ton_mot_de_passe_secret
```

- **BACKOFFICE_PASSWORD** : mot de passe pour te connecter au backoffice web.
- **BACKOFFICE_PORT** : port du backoffice (défaut `3000`).
- **BACKOFFICE_URL** : en production, URL HTTPS du backoffice (ex. `https://ton-site.vercel.app`) pour que le bouton « Backoffice » dans le bot fonctionne partout.

### 6. Lancer le projet

```bash
npm run dev
```

- **Bot** : répond dans Telegram (menu, catalogue, commandes).
- **Backoffice** : [http://localhost:3000/admin](http://localhost:3000/admin) (connexion avec le mot de passe défini dans `.env`).

---

## Scripts npm

| Commande | Description |
|----------|-------------|
| `npm start` / `npm run dev` | Lance le bot + le backoffice (même chose) |
| `npm run backoffice` | Lance uniquement le backoffice (sans bot) |
| `npm run seed` | Insère des produits/catégories de démo |
| `npm run seed-categories` | Insère les catégories de démo |
| `node scripts/seed-vpn.js` | Ajoute un produit VPN de démo (optionnel) |
| `npm run delete-orders` | Script utilitaire suppression commandes |
| `npm run reset-db` | Réinitialisation base (à utiliser avec précaution) |
| `npm run start:whatsapp` | Lance le **bot WhatsApp** (même catalogue / commandes / Wave, connexion par QR) |
| `npm test` | Lance les tests |

---

## Bot WhatsApp (optionnel)

Un second point d’entrée permet d’utiliser **WhatsApp** avec la même logique que le bot Telegram (catalogue, commandes, paiement Wave, Firestore partagé).

- **Lancement** : `npm run start:whatsapp`. Au premier démarrage, un **QR code** s’affiche dans le terminal : scanne-le avec WhatsApp (Paramètres → Appareils connectés).
- **Utilisation** : les clients envoient *Menu*, *2* (catalogue), *Netflix* / *Onoff* / *VPN*, puis suivent les instructions (durée, quantité). Après paiement Wave, ils envoient l’ID de transaction (ex. T_xxx) au bot.
- **Admin** : optionnel. Si tu définis `ADMIN_WHATSAPP_PHONE=225071234567` (ton numéro avec indicatif), en envoyant *Menu* ou *Stock* sur ce numéro tu vois le stock. Les notifications de commandes confirmées restent envoyées sur **Telegram** (admin) si `BOT_TOKEN` et `ADMIN_CHAT_ID` sont définis.
- **Note** : le bot WhatsApp repose sur [whatsapp-web.js](https://wwebjs.dev/) (Puppeteer). En production (ex. serveur sans interface), prévoir un environnement avec Chrome/Chromium (buildpack ou image Docker adaptée).
- **« Impossible de se connecter » / chargement infini puis erreur sur le téléphone** : 1) Sur le téléphone, utilise **Paramètres → Appareils connectés → Lier un appareil** et scanne le QR rapidement. 2) Si tu vois un chargement infini puis « Impossible de connecter l’appareil », arrête le bot (Ctrl+C), supprime les dossiers **`.wwebjs_auth`** et **`.wwebjs_cache`** à la racine du projet, puis relance `npm run start:whatsapp`. Le bot utilise une version figée de WhatsApp Web (2.2412.54) pour limiter ce problème. 3) Si ça persiste, vérifie que ton WhatsApp est à jour sur le téléphone.

---

## Utilisation

### Côté utilisateur (Telegram)

- **Menu** : bouton « 📱 Menu » ou `/start` → accès catalogue, suivi commande, aide.
- **Catalogue** : choix de catégorie (Netflix, Onoff, **VPN**) puis produit → création commande + lien Wave.
- **Paiement** : le client paie via le lien Wave puis envoie l’**ID de transaction** (ex. T_xxx) au bot.
- **Livraison** : pour Netflix/Onoff, l’admin marque **Livré** (les identifiants sont envoyés au client). Pour **VPN**, voir ci‑dessous.

### Côté admin (Telegram)

- **Menu admin** : réservé à `ADMIN_CHAT_ID` (statistiques, commandes, stock, lien backoffice).
- **Commandes** : voir les commandes en cours, marquer **Livré** / **Annuler**, suivi des comptes disponibles. Pour les commandes **VPN**, bouton **Envoyer identifiants VPN** puis envoi d’un message au format `E: xxx`, `P: xxx`, `Expiration: jj/mm/aaaa`.
- **Ajout produit** : `/addproduit` puis message au format indiqué (ou ajout via le backoffice).

### Backoffice web

- **URL** : `http://localhost:3000/admin` (en local) ou ton URL de production.
- **Fonctions** : tableau de bord, gestion des **catégories** et **sous-produits**, ajout/édition de **produits**, gestion des **commandes** (statuts, livraison).
- **Vérifier Wave** : sur chaque commande (en attente / confirmée), bouton **Vérifier Wave** pour contrôler si le paiement apparaît sur ton compte Wave Business (sans ouvrir le navigateur). Nécessite `WAVE_BUSINESS_TOKEN` et `WAVE_BUSINESS_WALLET_ID` dans `.env` — voir ci‑dessous.

---

## Structure du projet

```
telegram-bot/
├── index.js           # Point d’entrée du bot (polling en local)
├── backoffice.js      # App Express du backoffice
├── firebase.js        # Connexion Firestore (fichier ou env)
├── catalogue.js       # Produits, catégories, stock
├── categories.js       # Catégories et sous-produits
├── orders.js          # Commandes
├── comptes.js         # Comptes (stock par produit)
├── payment.js         # Génération lien Wave / WhatsApp
├── api/
│   ├── webhook.js     # Endpoint webhook Telegram (Vercel)
│   └── backoffice/    # Route serverless backoffice (Vercel)
├── views/             # Templates EJS du backoffice
├── middleware/        # Auth, pending order, etc.
├── lib/               # Messages, timers paiement, waveGraphql (vérif. Wave Business)
├── scripts/           # Scripts utilitaires (ex. wave-login.js)
├── .env               # Variables d’environnement (ne pas committer)
├── serviceAccountKey.json  # Clé Firebase (ne pas committer)
└── vercel.json        # Config déploiement Vercel
```

---

## Déploiement

### Option 1 : Vercel (serverless, webhook)

Le bot fonctionne en **webhook** : Telegram envoie les mises à jour à ton URL. Pas de processus long à maintenir.

- **Guide détaillé** : [DEPLOY.md](./DEPLOY.md)
- En résumé : déployer avec `npx vercel`, configurer les variables d’environnement (dont **FIREBASE_SERVICE_ACCOUNT** = JSON complet de la clé Firebase), puis appeler l’API Telegram pour définir le webhook :
  ```bash
  curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://ton-projet.vercel.app/api/webhook"
  ```

### Option 2 : VPS / Railway / Render (polling)

Le bot tourne en continu et utilise le **long polling** (comme en local).

- Commande de démarrage : `node index.js` ou `npm start`
- Même variables que dans `.env`. **Sur Railway / Render** (pas de fichier sur le serveur) : tu **dois** définir les credentials Firebase via une variable d’environnement. **Deux options** :
  - **Option recommandée (base64)** — évite les soucis de guillemets sur Railway :
    1. En local, à la racine du projet : `node scripts/firebase-env-base64.js`
    2. Copie **toute** la ligne affichée (une longue chaîne base64).
    3. Railway → **Variables** → **New Variable** → Nom : `FIREBASE_SERVICE_ACCOUNT_BASE64`, Valeur : colle la chaîne.
    4. Redéploie.
  - **Option JSON** : Nom `FIREBASE_SERVICE_ACCOUNT`, valeur = contenu complet de `serviceAccountKey.json` **en une seule ligne** (minifier le JSON, pas de retours à la ligne). Si tu vois encore l’erreur Firebase, utilise l’option base64 ci‑dessus.
- **Token Wave Business** : `WAVE_BUSINESS_TOKEN` est un token de **session** (obtenu via `wave-login.js`), pas une clé API permanente. Il peut expirer après un certain temps. En cas d’expiration :
  1. Sur ton PC : lancer `node scripts/wave-login.js` (SMS requis), récupérer le nouveau `WAVE_BUSINESS_TOKEN`.
  2. Mettre à jour la variable d’environnement sur le serveur (ex. Railway → Variables → `WAVE_BUSINESS_TOKEN`).
  3. Redémarrer le service si besoin. Le bot envoie une alerte à l’admin (Telegram) quand le token Wave est détecté comme expiré, pour te rappeler de le renouveler.

---

## Sécurité

- Les commandes admin sont réservées à **ADMIN_CHAT_ID**.
- Ne **jamais** committer `.env` ni `serviceAccountKey.json` (présents dans `.gitignore`).
- En production, utiliser un **BACKOFFICE_PASSWORD** fort et, si possible, **HTTPS** pour le backoffice.

---

## Vérification des paiements Wave Business (optionnel)

Wave ne fournit pas d’API publique pour les comptes business. Ce projet utilise l’API GraphQL interne de Wave (sans navigateur) pour comparer l’historique de ton portefeuille aux commandes.

1. **Obtenir un token et le wallet ID** (une fois) :
   ```bash
   node scripts/wave-login.js
   ```
   Tu peux définir `WAVE_BUSINESS_MOBILE` et `WAVE_BUSINESS_PIN` dans `.env`, ou les saisir quand le script le demande. À la fin, le script affiche les lignes à ajouter dans `.env` :
   - `WAVE_BUSINESS_TOKEN=...`
   - `WAVE_BUSINESS_WALLET_ID=...`

2. **Dans le backoffice** : sur la page Commandes, clique sur **Vérifier Wave** à côté d’une commande. Le système compare la référence et le montant aux transactions Wave de la période concernée.

Si le token expire (erreur « session expirée »), relance `node scripts/wave-login.js` et mets à jour `WAVE_BUSINESS_TOKEN` dans `.env`.

---

## Catalogue VPN

Les produits **VPN** n’ont pas de limite de stock : tu les ajoutes comme les autres (backoffice ou script), avec la **catégorie** `vpn`. Le client commande, paie via Wave et envoie l’ID de transaction. Une fois le paiement validé par le système :

1. Le bot notifie l’admin avec un bouton **« Envoyer identifiants VPN »**.
2. L’admin clique sur le bouton, puis envoie un seul message au format :
   ```
   E: identifiant@exemple.com
   P: mot_de_passe
   Expiration: 31/12/2026
   ```
3. Le bot enregistre E, P et la date d’expiration, envoie ces identifiants au client et marque la commande comme **livrée**.

Pour créer des produits VPN : dans le backoffice (Produits), crée un produit avec **catégorie** = `vpn` (et sans lien catalogue/sous-produit type Netflix/Onoff). Les produits VPN s’affichent dans le catalogue bot sous **🔒 VPN** et sont proposés sans notion de stock (illimité).

---

## Dépannage

- **« Backoffice ne s’affiche pas »** : vérifier que `BACKOFFICE_PASSWORD` est bien défini dans `.env` (sans espace avant le nom de la variable).
- **« La base Firestore n’existe pas »** : créer la base dans la Firebase Console et, en local, placer `serviceAccountKey.json` au bon endroit.
- **Connexion refusée sur localhost:3000** : lancer une seule fois `npm run dev` (pas `npm run backoffice` dans un autre terminal en parallèle, pour éviter un conflit de port).
