# Déploiement sur Vercel

## Prérequis

- Compte [Vercel](https://vercel.com)
- Variables d’environnement prêtes (voir ci‑dessous)

## Étapes

### 1. Déployer le projet

- Soit : connecter le repo Git à Vercel (Import Project) et déployer.
- Soit : en local, dans le dossier du projet :
  ```bash
  npx vercel
  ```
  Suivre les questions (lien au projet, build, etc.).

**Important — Si tu as un 404 en prod :** Si le code (dossier `api/`, `vercel.json`, `package.json`) est dans un **sous-dossier** du repo (ex. `telegram-bot/`), dans Vercel va dans **Settings → General → Root Directory** et indique ce dossier (ex. `telegram-bot`). Puis redéploie. Sinon Vercel cherche les routes à la racine du repo et ne trouve rien.

### 2. Variables d’environnement (Vercel)

Dans le projet Vercel : **Settings → Environment Variables**, ajouter :

| Variable | Description |
|----------|-------------|
| `BOT_TOKEN` | Token du bot Telegram (@BotFather) |
| `ADMIN_CHAT_ID` | Ton chat_id Telegram (admin) |
| `BACKOFFICE_PASSWORD` | Mot de passe de connexion au backoffice |
| `BACKOFFICE_SECRET` | (optionnel) Secret de session, sinon = BACKOFFICE_PASSWORD |
| `WAVE_MERCHANT_ID` | ID marchand Wave |
| `WAVE_PHONE` | Numéro Wave (format 221771234567) |
| `FIREBASE_SERVICE_ACCOUNT` | **JSON complet** du compte de service Firebase (clé privée). Copier tout le contenu de `serviceAccountKey.json` en une seule ligne ou en chaîne JSON. |

Pour `FIREBASE_SERVICE_ACCOUNT` :  
Firebase Console → Paramètres du projet → Comptes de service → Générer une clé → copier le JSON et le coller comme valeur de la variable (tout le JSON, sans fichier).

### 3. Configurer le webhook Telegram

Une fois l’URL de production connue (ex. `https://ton-projet.vercel.app`) :

1. Définir le webhook (à faire une seule fois, ou après chaque changement de domaine) :
   ```bash
   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://ton-projet.vercel.app/api/webhook"
   ```
   Remplacer `<BOT_TOKEN>` et `ton-projet.vercel.app` par tes valeurs.

2. (Optionnel) Définir l’URL du backoffice pour le lien dans le menu admin du bot :
   - Variable d’environnement Vercel : `BACKOFFICE_URL=https://ton-projet.vercel.app`

### 4. URLs après déploiement

- **Bot** : Telegram envoie les mises à jour à `https://ton-projet.vercel.app/api/webhook`
- **Backoffice** : `https://ton-projet.vercel.app/admin` (connexion avec `BACKOFFICE_PASSWORD`)

## En local (inchangé)

En local tu continues à lancer le bot en long polling (pas de webhook) :

```bash
npm run dev
```

Le backoffice et le bot tournent comme avant ; le fichier `serviceAccountKey.json` reste utilisé s’il est présent (sinon la variable `FIREBASE_SERVICE_ACCOUNT` est utilisée).

## Limites Vercel

- **Sessions backoffice** : stockage en mémoire ; tu peux être déconnecté entre deux requêtes (cold start). Pour une persistance des sessions, il faudrait un store externe (Redis, etc.).
- **Timeouts** : les fonctions ont une durée max d’exécution (plan gratuit ~10 s). Les traitements lourds doivent rester courts.
