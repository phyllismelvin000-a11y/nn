/**
 * Vide toutes les collections Firestore du projet (repart à zéro).
 * Collections : commandes, comptes, produits, sousProduits, categories.
 * Usage : node reset-db.js   ou   npm run reset-db
 */
require('dotenv').config();
const { initFirebase, getDb } = require('./firebase');

const COLLECTIONS = ['commandes', 'comptes', 'produits', 'sousProduits', 'categories'];
const BATCH_SIZE = 500;

async function deleteCollection(db, name) {
  const col = db.collection(name);
  const snap = await col.get();
  const total = snap.size;
  if (total === 0) return 0;
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    docs.slice(i, i + BATCH_SIZE).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
  return total;
}

async function reset() {
  initFirebase();
  const db = getDb();
  console.log('Vidage des collections Firestore…\n');
  let totalDeleted = 0;
  for (const name of COLLECTIONS) {
    try {
      const n = await deleteCollection(db, name);
      if (n > 0) console.log(`  ${name} : ${n} document(s) supprimé(s)`);
      totalDeleted += n;
    } catch (e) {
      console.error(`  ${name} : erreur —`, e.message);
    }
  }
  console.log('\n✅ Base repart à zéro.');
  if (totalDeleted === 0) console.log('   (Les collections étaient déjà vides.)');
  console.log('\nRelancez : npm run seed-categories');
  process.exit(0);
}

reset().catch((err) => {
  console.error(err);
  process.exit(1);
});
