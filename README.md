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
| `npm run delete-orders` | Script utilitaire suppression commandes |
| `npm run reset-db` | Réinitialisation base (à utiliser avec précaution) |
| `npm test` | Lance les tests |

---

## Utilisation

### Côté utilisateur (Telegram)

- **Menu** : bouton « 📱 Menu » ou `/start` → accès catalogue, suivi commande, aide.
- **Catalogue** : choix de catégorie puis produit, bouton **Commander** → création commande + lien Wave.
- **Paiement** : le client paie via le lien Wave (ou WhatsApp en fallback selon config).
- **Livraison** : après paiement, envoi d’une capture/photo au bot pour confirmer ; l’admin peut marquer la commande comme livrée.

### Côté admin (Telegram)

- **Menu admin** : réservé à `ADMIN_CHAT_ID` (statistiques, commandes, stock, lien backoffice).
- **Commandes** : voir les commandes en cours, marquer **Livré** / **Annuler**, suivi des comptes disponibles.
- **Ajout produit** : `/addproduit` puis message au format indiqué (ou ajout via le backoffice).

### Backoffice web

- **URL** : `http://localhost:3000/admin` (en local) ou ton URL de production.
- **Fonctions** : tableau de bord, gestion des **catégories** et **sous-produits**, ajout/édition de **produits**, gestion des **commandes** (statuts, livraison).

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
├── lib/               # Messages, timers paiement
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
- Même variables que dans `.env` ; pour Firebase, fournir `serviceAccountKey.json` ou la variable **FIREBASE_SERVICE_ACCOUNT** (JSON).

---

## Sécurité

- Les commandes admin sont réservées à **ADMIN_CHAT_ID**.
- Ne **jamais** committer `.env` ni `serviceAccountKey.json` (présents dans `.gitignore`).
- En production, utiliser un **BACKOFFICE_PASSWORD** fort et, si possible, **HTTPS** pour le backoffice.

---

## Dépannage

- **« Backoffice ne s’affiche pas »** : vérifier que `BACKOFFICE_PASSWORD` est bien défini dans `.env` (sans espace avant le nom de la variable).
- **« La base Firestore n’existe pas »** : créer la base dans la Firebase Console et, en local, placer `serviceAccountKey.json` au bon endroit.
- **Connexion refusée sur localhost:3000** : lancer une seule fois `npm run dev` (pas `npm run backoffice` dans un autre terminal en parallèle, pour éviter un conflit de port).
