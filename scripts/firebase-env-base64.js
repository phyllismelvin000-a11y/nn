#!/usr/bin/env node
/**
 * Affiche le contenu de serviceAccountKey.json encodé en base64.
 * À copier-coller dans la variable FIREBASE_SERVICE_ACCOUNT_BASE64 sur Railway/Render.
 *
 * Usage (depuis la racine du projet) :
 *   node scripts/firebase-env-base64.js
 */
const fs = require('fs');
const path = require('path');

const keyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
if (!fs.existsSync(keyPath)) {
  console.error('Fichier serviceAccountKey.json introuvable dans le projet.');
  process.exit(1);
}
const json = fs.readFileSync(keyPath, 'utf8').trim();
const base64 = Buffer.from(json, 'utf8').toString('base64');
console.log(base64);
