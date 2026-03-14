/**
 * Comptes : une entrée par unité à vendre (E, P, date d'expiration).
 * Le stock d'un produit = nombre de comptes disponibles pour ce produit.
 */
const { getDb } = require('./firebase');
const { withRetry } = require('./util/retry');

const COLLECTION = 'comptes';
const STATUS_AVAILABLE = 'available';
const STATUS_SOLD = 'sold';

async function addCompte(productId, { E = '', P = '', dateExpiration = '' }) {
  return withRetry(async () => {
    const db = getDb();
    const data = {
      productId: String(productId),
      E: String(E || '').trim(),
      P: String(P || '').trim(),
      dateExpiration: String(dateExpiration || '').trim(),
      status: STATUS_AVAILABLE,
      createdAt: new Date(),
    };
    const ref = await db.collection(COLLECTION).add(data);
    return { id: ref.id, ...data };
  });
}

async function getAvailableCount(productId) {
  return withRetry(async () => {
    const db = getDb();
    const snap = await db.collection(COLLECTION)
      .where('productId', '==', String(productId))
      .where('status', '==', STATUS_AVAILABLE)
      .get();
    return snap.size;
  });
}

/**
 * Réserve un compte pour une commande : retourne { id, E, P, dateExpiration } et le marque vendu.
 */
async function reserveOneForOrder(productId) {
  return withRetry(async () => {
    const db = getDb();
    const snap = await db.collection(COLLECTION)
      .where('productId', '==', String(productId))
      .where('status', '==', STATUS_AVAILABLE)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    await doc.ref.update({ status: STATUS_SOLD, soldAt: new Date() });
    const d = doc.data();
    return {
      id: doc.id,
      E: d.E || '',
      P: d.P || '',
      dateExpiration: d.dateExpiration || '',
    };
  });
}

module.exports = {
  addCompte,
  getAvailableCount,
  reserveOneForOrder,
};
