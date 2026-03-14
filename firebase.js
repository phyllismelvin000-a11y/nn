const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

let db = null;

function initFirebase() {
  if (db) return db;
  let serviceAccount = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (e) {
      console.error('FIREBASE_SERVICE_ACCOUNT invalide (JSON attendu).');
      if (process.env.VERCEL) throw e;
      process.exit(1);
    }
  }
  if (!serviceAccount) {
    const keyPath = path.join(__dirname, 'serviceAccountKey.json');
    if (!fs.existsSync(keyPath)) {
      console.error('\n❌ Firebase : ni FIREBASE_SERVICE_ACCOUNT (env), ni serviceAccountKey.json.');
      console.error('   Local : place serviceAccountKey.json dans le projet.');
      console.error('   En prod (Vercel, Railway, Render…) : ajoute la variable FIREBASE_SERVICE_ACCOUNT (JSON complet) dans les Variables d\'environnement du projet.');
      console.error('');
      if (process.env.VERCEL) throw new Error('Firebase credentials missing. Set FIREBASE_SERVICE_ACCOUNT in your host (Vercel/Railway/Render) → Environment Variables (full JSON key).');
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
