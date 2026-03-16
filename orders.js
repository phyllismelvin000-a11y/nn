const { getDb } = require('./firebase');
const { v4: uuidv4 } = require('uuid');
const { withRetry } = require('./util/retry');

const COLLECTION = 'commandes';

const STATUS = {
  EN_ATTENTE: 'en_attente',
  CONFIRMEE: 'confirmee',
  LIVREE: 'livree',
  ANNULEE: 'annulee',
};

async function createOrder({ userId, username, product }) {
  return withRetry(async () => {
    const db = getDb();
    const now = new Date();
    const refCommande = uuidv4().slice(0, 8);
    const quantite = Math.max(1, Math.floor(Number(product.quantite) || 1));
    const prixUnitaire = Number(product.prix) || 0;
    const dureeMois = product.dureeMois != null ? Math.max(1, Math.floor(Number(product.dureeMois))) : null;
    const total = dureeMois != null ? prixUnitaire * dureeMois * quantite : prixUnitaire * quantite;
    const produitData = {
      id: product.id,
      titre: product.titre,
      prix: prixUnitaire,
      quantite,
      total,
    };
    if (dureeMois != null) produitData.dureeMois = dureeMois;
    if (product.categorie != null) produitData.categorie = String(product.categorie);
    const data = {
      userId: String(userId),
      username: String(username || ''),
      produit: produitData,
      status: STATUS.EN_ATTENTE,
      refCommande,
      createdAt: now,
      updatedAt: now,
    };
    const ref = await db.collection(COLLECTION).add(data);
    return { id: ref.id, refCommande, ...data };
  });
}

async function getLastPendingOrderByUser(userId) {
  return withRetry(async () => {
    const db = getDb();
    const snap = await db.collection(COLLECTION)
      .where('userId', '==', String(userId))
      .where('status', '==', STATUS.EN_ATTENTE)
      .get();
    if (snap.empty) return null;
    const sorted = snap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    return sorted[0] || null;
  });
}

async function getOrderById(orderId) {
  return withRetry(async () => {
    const db = getDb();
    const doc = await db.collection(COLLECTION).doc(orderId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  });
}

async function updateOrderStatus(orderId, newStatus) {
  return withRetry(async () => {
    const db = getDb();
    const now = new Date();
    await db.collection(COLLECTION).doc(orderId).update({
      status: newStatus,
      updatedAt: now,
    });
    return getOrderById(orderId);
  });
}

async function updateOrderDeliveryData(orderId, deliveryData) {
  return withRetry(async () => {
    const db = getDb();
    const now = new Date();
    await db.collection(COLLECTION).doc(orderId).update({
      deliveryData: deliveryData || null,
      updatedAt: now,
    });
    return getOrderById(orderId);
  });
}

async function updateOrderWaveTransactionId(orderId, waveTransactionId) {
  return withRetry(async () => {
    const db = getDb();
    const now = new Date();
    await db.collection(COLLECTION).doc(orderId).update({
      waveTransactionId: waveTransactionId ? String(waveTransactionId).trim() : null,
      updatedAt: now,
    });
    return getOrderById(orderId);
  });
}

/**
 * Indique si cet ID de transaction Wave est déjà utilisé par une autre commande.
 * @param {string} waveTransactionId - ex. T_NMZJ7AZOTQ2ZXNVT
 * @param {string} excludeOrderId - ID de commande à exclure (celle qu'on est en train de confirmer)
 * @returns {Promise<{ alreadyUsed: boolean, order?: object }>}
 */
async function findOrderByWaveTransactionId(waveTransactionId, excludeOrderId = null) {
  return withRetry(async () => {
    const db = getDb();
    const id = (waveTransactionId || '').trim();
    if (!id) return { alreadyUsed: false, order: null };
    const snap = await db.collection(COLLECTION)
      .where('waveTransactionId', '==', id)
      .limit(5)
      .get();
    if (snap.empty) return { alreadyUsed: false, order: null };
    const orders = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const other = orders.find(o => o.id !== excludeOrderId);
    if (other) return { alreadyUsed: true, order: other };
    return { alreadyUsed: false, order: null };
  });
}

async function getLast10Orders() {
  return withRetry(async () => {
    const db = getDb();
    const snap = await db.collection(COLLECTION)
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  });
}

async function getOrders({ limit = 50, status = null } = {}) {
  return withRetry(async () => {
    const db = getDb();
    const cap = Math.min(limit, 200);
    const snap = await db.collection(COLLECTION)
      .orderBy('createdAt', 'desc')
      .limit(status ? 500 : cap)
      .get();
    let list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    if (status) {
      list = list.filter(o => o.status === status).slice(0, cap);
    }
    return list;
  });
}

async function getLastOrderByUser(userId) {
  return withRetry(async () => {
    const db = getDb();
    const snap = await db.collection(COLLECTION)
      .where('userId', '==', String(userId))
      .limit(50)
      .get();
    if (snap.empty) return null;
    const list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    list.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    return list[0] || null;
  });
}

/**
 * Historique des commandes d'un utilisateur (pour afficher "Historique des paiements").
 * Pas d'orderBy Firestore pour éviter l'index composite ; tri en mémoire.
 * @param {string} userId - Telegram user id
 * @param {{ limit?: number }} opts - limit (défaut 20)
 */
async function getOrdersByUser(userId, { limit = 20 } = {}) {
  return withRetry(async () => {
    const db = getDb();
    const cap = Math.min(limit, 50);
    const snap = await db.collection(COLLECTION)
      .where('userId', '==', String(userId))
      .limit(100)
      .get();
    let list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    list.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    return list.slice(0, cap);
  });
}

/**
 * Liste des userId distincts ayant passé au moins une commande (pour envoi d'alertes).
 */
async function getDistinctOrderUserIds(limit = 3000) {
  return withRetry(async () => {
    const db = getDb();
    const snap = await db.collection(COLLECTION)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    const ids = new Set();
    snap.docs.forEach(doc => {
      const uid = doc.data().userId;
      if (uid) ids.add(String(uid));
    });
    return Array.from(ids);
  });
}

module.exports = {
  STATUS,
  createOrder,
  getLastPendingOrderByUser,
  getLastOrderByUser,
  getOrdersByUser,
  getOrderById,
  updateOrderStatus,
  updateOrderDeliveryData,
  updateOrderWaveTransactionId,
  findOrderByWaveTransactionId,
  getLast10Orders,
  getOrders,
  getDistinctOrderUserIds,
};
