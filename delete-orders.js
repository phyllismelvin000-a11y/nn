/**
 * Supprime toutes les commandes de la collection Firestore (commandes).
 * À lancer une seule fois pour repartir sur une base vide.
 * Usage : node delete-orders.js   ou   npm run delete-orders
 */
require('dotenv').config();
const { initFirebase, getDb } = require('./firebase');

const COLLECTION = 'commandes';
const BATCH_SIZE = 500;

async function deleteAllOrders() {
  initFirebase();
  const db = getDb();
  const col = db.collection(COLLECTION);

  const snap = await col.get();
  const total = snap.size;
  if (total === 0) {
    console.log('Aucune commande dans la base. Rien à supprimer.');
    process.exit(0);
    return;
  }

  let deleted = 0;
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = docs.slice(i, i + BATCH_SIZE);
    chunk.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += chunk.length;
    console.log(`Supprimé : ${deleted}/${total}`);
  }

  console.log(`\n✅ ${deleted} commande(s) supprimée(s). Base commandes vide.`);
  process.exit(0);
}

deleteAllOrders().catch((err) => {
  console.error(err);
  process.exit(1);
});
