const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

let db = null;

function initFirebase() {
  if (db) return db;
  let serviceAccount = null;

  // Option 1 : JSON en base64 (recommandé sur Railway/Render — évite les problèmes de guillemets)
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64) {
    try {
      const json = Buffer.from(base64, 'base64').toString('utf8');
      serviceAccount = JSON.parse(json);
    } catch (e) {
      console.error('FIREBASE_SERVICE_ACCOUNT_BASE64 invalide (base64 du JSON attendu).', e.message);
      process.exit(1);
    }
  }

  // Option 2 : JSON en clair
  if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (e) {
      const len = (process.env.FIREBASE_SERVICE_ACCOUNT || '').length;
      console.error('FIREBASE_SERVICE_ACCOUNT invalide (JSON attendu). Longueur reçue:', len, '-', e.message);
      if (process.env.VERCEL) throw e;
      process.exit(1);
    }
  }

  if (!serviceAccount) {
    const keyPath = path.join(__dirname, 'serviceAccountKey.json');
    if (!fs.existsSync(keyPath)) {
      const hasEnv = !!process.env.FIREBASE_SERVICE_ACCOUNT;
      const hasBase64 = !!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
      console.error('\n❌ Firebase : ni FIREBASE_SERVICE_ACCOUNT (env), ni FIREBASE_SERVICE_ACCOUNT_BASE64, ni serviceAccountKey.json.');
      if (hasEnv || hasBase64) {
        console.error('   (FIREBASE_SERVICE_ACCOUNT présent:', hasEnv, ', FIREBASE_SERVICE_ACCOUNT_BASE64 présent:', hasBase64, ')');
      }
      console.error('   Local : place serviceAccountKey.json dans le projet.');
      console.error('   En prod : ajoute FIREBASE_SERVICE_ACCOUNT (JSON) ou FIREBASE_SERVICE_ACCOUNT_BASE64 (base64 du JSON) dans les Variables d\'environnement.');
      console.error('');
      if (process.env.VERCEL) throw new Error('Firebase credentials missing. Set FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_BASE64.');
      process.exit(1);
    }
    serviceAccount = require(keyPath);
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  return db;
}

function getDb() {
  if (!db) return initFirebase();
  return db;
}

module.exports = { initFirebase, getDb };
