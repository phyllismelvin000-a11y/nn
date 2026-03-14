/**
 * Catégories (ex. netflix, onoff) : conteneur sans prix — nom, description, image.
 * Les prix sont sur les sous-produits (ex. Netflix 1 mois 3000 FCFA, Onoff Premium 3000 FCFA).
 */
const { getDb } = require('./firebase');
const { withRetry } = require('./util/retry');

const COLLECTION = 'categories';
const SOUS_PRODUITS_COLLECTION = 'sousProduits';

async function getCategories() {
  return withRetry(async () => {
    const db = getDb();
    const snap = await db.collection(COLLECTION).orderBy('nom').get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  });
}

async function getCategoryById(id) {
  return withRetry(async () => {
    const db = getDb();
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  });
}

async function addCategory({ nom, description = '', imageUrl = '' }) {
  return withRetry(async () => {
    const db = getDb();
    const data = {
      nom: String(nom || '').trim().toLowerCase(),
      description: String(description || '').trim(),
      imageUrl: String(imageUrl || '').trim(),
    };
    const ref = await db.collection(COLLECTION).add(data);
    return { id: ref.id, ...data };
  });
}

async function updateCategory(id, { nom, description, imageUrl }) {
  return withRetry(async () => {
    const db = getDb();
    const ref = db.collection(COLLECTION).doc(id);
    const doc = await ref.get();
    if (!doc.exists) return null;
    const updates = {};
    if (nom !== undefined) updates.nom = String(nom).trim().toLowerCase();
    if (description !== undefined) updates.description = String(description).trim();
    if (imageUrl !== undefined) updates.imageUrl = String(imageUrl).trim();
    if (Object.keys(updates).length === 0) return doc.data();
    await ref.update(updates);
    return getCategoryById(id);
  });
}

// ——— Sous-produits ———

async function getSubProducts(catalogueId) {
  return withRetry(async () => {
    const db = getDb();
    const snap = await db.collection(SOUS_PRODUITS_COLLECTION)
      .where('catalogueId', '==', String(catalogueId))
      .get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  });
}

async function getSubProductById(id) {
  return withRetry(async () => {
    const db = getDb();
    const doc = await db.collection(SOUS_PRODUITS_COLLECTION).doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  });
}

async function addSubProduct(catalogueId, { nom, prixMois, description = '' }) {
  return withRetry(async () => {
    const db = getDb();
    const cat = await getCategoryById(catalogueId);
    if (!cat) throw new Error('Catalogue introuvable');
    const data = {
      catalogueId: String(catalogueId),
      nom: String(nom || '').trim(),
      prixMois: Math.max(0, Number(prixMois) || 0),
      description: String(description || '').trim(),
    };
    const ref = await db.collection(SOUS_PRODUITS_COLLECTION).add(data);
    return { id: ref.id, ...data };
  });
}

async function updateSubProduct(subProductId, { nom, prixMois, description }) {
  return withRetry(async () => {
    const db = getDb();
    const ref = db.collection(SOUS_PRODUITS_COLLECTION).doc(subProductId);
    const doc = await ref.get();
    if (!doc.exists) return null;
    const updates = {};
    if (nom !== undefined) updates.nom = String(nom).trim();
    if (prixMois !== undefined) updates.prixMois = Math.max(0, Number(prixMois) || 0);
    if (description !== undefined) updates.description = String(description).trim();
    if (Object.keys(updates).length === 0) return doc.data();
    await ref.update(updates);
    return getSubProductById(subProductId);
  });
}

module.exports = {
  getCategories,
  getCategoryById,
  addCategory,
  updateCategory,
  getSubProducts,
  getSubProductById,
  addSubProduct,
  updateSubProduct,
};
