const { getDb } = require('./firebase');
const { withRetry } = require('./util/retry');
const { getCategoryById, getSubProductById } = require('./categories');
const { getAvailableCount, addCompte, reserveOneForOrder } = require('./comptes');

const COLLECTION = 'produits';

/** Cache court pour alléger Firestore sur Menu / Catalogue (TTL 25 s). */
const CACHE_TTL_MS = 25000;
let activeProductsCache = null;
let activeProductsCacheExpiry = 0;

async function getActiveProducts() {
  const now = Date.now();
  if (activeProductsCache != null && now < activeProductsCacheExpiry) {
    return activeProductsCache;
  }
  const list = await withRetry(async () => {
    const db = getDb();
    const snap = await db.collection(COLLECTION)
      .where('actif', '==', true)
      .get();
    let out = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    out.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    out = await enrichStockFromComptes(out);
    return out;
  });
  activeProductsCache = list;
  activeProductsCacheExpiry = now + CACHE_TTL_MS;
  return list;
}

function invalidateActiveProductsCache() {
  activeProductsCache = null;
  activeProductsCacheExpiry = 0;
}

async function enrichStockFromComptes(products) {
  return Promise.all(products.map(async (p) => {
    if (p.catalogueId != null) {
      const stock = await getAvailableCount(p.id);
      return { ...p, stock };
    }
    return { ...p };
  }));
}

/** Filtre une liste de produits par catégorie (pur, testable). */
function filterByCategory(products, categorie) {
  const cat = String(categorie || '').toLowerCase().trim();
  return cat ? products.filter(p => (p.categorie || '').toLowerCase() === cat) : products;
}

async function getActiveProductsByCategory(categorie) {
  const all = await getActiveProducts();
  return filterByCategory(all, categorie);
}

async function getAllProducts() {
  return withRetry(async () => {
    const db = getDb();
    const snap = await db.collection(COLLECTION).get();
    let list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    list.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    list = await enrichStockFromComptes(list);
    return list;
  });
}

async function updateProduct(id, data) {
  return withRetry(async () => {
    const db = getDb();
    const ref = db.collection(COLLECTION).doc(id);
    const doc = await ref.get();
    if (!doc.exists) return null;
    const allowed = ['titre', 'prix', 'description', 'imageUrl', 'stock', 'categorie', 'actif', 'E', 'P', 'dateExpiration', 'categoryId'];
    const updates = {};
    for (const key of allowed) {
      if (data[key] !== undefined) {
        if (key === 'prix') updates[key] = Number(data[key]) || 0;
        else if (key === 'stock') updates[key] = Math.max(0, Math.floor(Number(data[key]) || 0));
        else if (key === 'actif') updates[key] = Boolean(data[key]);
        else updates[key] = String(data[key] ?? '').trim();
      }
    }
    if (Object.keys(updates).length === 0) return doc.data();
    await ref.update(updates);
    invalidateActiveProductsCache();
    return getProductById(id);
  });
}

async function getProductById(id) {
  return withRetry(async () => {
    const db = getDb();
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) return null;
    const p = { id: doc.id, ...doc.data() };
    if (p.catalogueId != null) {
      p.stock = await getAvailableCount(p.id);
    }
    return p;
  });
}

async function getProductByCatalogueAndSub(catalogueId, subProductId = null) {
  return withRetry(async () => {
    const db = getDb();
    let q = db.collection(COLLECTION)
      .where('catalogueId', '==', String(catalogueId))
      .where('actif', '==', true);
    if (subProductId == null || subProductId === '') {
      q = q.where('subProductId', '==', null);
    } else {
      q = q.where('subProductId', '==', String(subProductId));
    }
    const snap = await q.limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    const p = { id: doc.id, ...doc.data() };
    p.stock = await getAvailableCount(p.id);
    return p;
  });
}

async function addProduct({ titre, prix, description = '', imageUrl = '', stock = 1, categorie = '', E = '', P = '', dateExpiration = '', categoryId = '' }) {
  return withRetry(async () => {
    const db = getDb();
    const data = {
      titre: String(titre).trim(),
      prix: Number(prix) || 0,
      description: String(description).trim(),
      imageUrl: String(imageUrl).trim(),
      actif: true,
      stock: Math.max(0, Math.floor(Number(stock) || 1)),
      categorie: String(categorie || '').toLowerCase().trim() || 'netflix',
      E: String(E || '').trim(),
      P: String(P || '').trim(),
      dateExpiration: String(dateExpiration || '').trim(),
      createdAt: new Date(),
    };
    if (categoryId) data.categoryId = String(categoryId).trim();
    const ref = await db.collection(COLLECTION).add(data);
    invalidateActiveProductsCache();
    return { id: ref.id, ...data };
  });
}

/**
 * Ajoute un compte (E, P, date) au produit lié au catalogue (sans sous-produit).
 */
async function addProductFromCategory(categoryId, { E = '', P = '', dateExpiration = '' }) {
  let product = await getProductByCatalogueAndSub(categoryId, null);
  if (!product) product = await createProductForCatalogue(categoryId);
  if (!product) throw new Error('Aucun produit pour ce catalogue. Créez d\'abord le catalogue.');
  const compte = await addCompte(product.id, { E, P, dateExpiration });
  invalidateActiveProductsCache();
  return { id: product.id, titre: product.titre, prix: product.prix, stock: (product.stock || 0) + 1, compteId: compte.id };
}

/**
 * Ajoute un compte au produit lié au catalogue + sous-produit.
 */
async function addProductFromSubProduct(catalogueId, subProductId, { E = '', P = '', dateExpiration = '' }) {
  const product = await getProductByCatalogueAndSub(catalogueId, subProductId);
  if (!product) throw new Error('Produit (catalogue + sous-produit) introuvable.');
  const compte = await addCompte(product.id, { E, P, dateExpiration });
  invalidateActiveProductsCache();
  return { id: product.id, titre: product.titre, prix: product.prix, stock: product.stock + 1, compteId: compte.id };
}

/**
 * Crée le document produit template pour un catalogue (sans sous-produit).
 */
async function createProductForCatalogue(categoryId) {
  const category = await getCategoryById(categoryId);
  if (!category) throw new Error('Catalogue introuvable');
  return withRetry(async () => {
    const db = getDb();
    const existing = await getProductByCatalogueAndSub(categoryId, null);
    if (existing) return existing;
    const data = {
      catalogueId: String(categoryId),
      subProductId: null,
      titre: category.titreDefaut || category.nom,
      prix: category.prixMois ?? 0,
      categorie: category.nom,
      actif: true,
      description: category.description || '',
      imageUrl: category.imageUrl || '',
      createdAt: new Date(),
    };
    const ref = await db.collection(COLLECTION).add(data);
    invalidateActiveProductsCache();
    return { id: ref.id, ...data, stock: 0 };
  });
}

/**
 * Crée le document produit template pour un sous-produit.
 */
async function createProductForSubProduct(catalogueId, subProductId) {
  const category = await getCategoryById(catalogueId);
  const sub = await getSubProductById(subProductId);
  if (!category || !sub) throw new Error('Catalogue ou sous-produit introuvable');
  return withRetry(async () => {
    const db = getDb();
    const existing = await getProductByCatalogueAndSub(catalogueId, subProductId);
    if (existing) return existing;
    const data = {
      catalogueId: String(catalogueId),
      subProductId: String(subProductId),
      titre: sub.nom,
      prix: sub.prixMois ?? 0,
      categorie: category.nom,
      actif: true,
      description: sub.description || '',
      imageUrl: '',
      createdAt: new Date(),
    };
    const ref = await db.collection(COLLECTION).add(data);
    invalidateActiveProductsCache();
    return { id: ref.id, ...data, stock: 0 };
  });
}

/**
 * Réserve un compte pour une commande (produit géré par comptes). Retourne { E, P, dateExpiration } ou null.
 */
async function reserveCompteForOrder(productId) {
  return reserveOneForOrder(productId);
}

async function decrementStock(productId, quantity) {
  return withRetry(async () => {
    const product = await getProductById(productId);
    if (!product) return false;
    if (product.catalogueId != null) return true;
    const db = getDb();
    const ref = db.collection(COLLECTION).doc(productId);
    const doc = await ref.get();
    if (!doc.exists) return false;
    const current = doc.data().stock ?? 0;
    const newStock = Math.max(0, current - quantity);
    await ref.update({ stock: newStock });
    invalidateActiveProductsCache();
    return true;
  });
}

async function incrementStock(productId, quantity) {
  return withRetry(async () => {
    const db = getDb();
    const ref = db.collection(COLLECTION).doc(productId);
    const doc = await ref.get();
    if (!doc.exists) return false;
    const data = doc.data();
    if (data.catalogueId != null) return true;
    const current = data.stock ?? 0;
    await ref.update({ stock: current + quantity });
    invalidateActiveProductsCache();
    return true;
  });
}

module.exports = {
  getActiveProducts,
  getActiveProductsByCategory,
  getProductById,
  getProductByCatalogueAndSub,
  getAllProducts,
  addProduct,
  addProductFromCategory,
  addProductFromSubProduct,
  createProductForCatalogue,
  createProductForSubProduct,
  reserveCompteForOrder,
  updateProduct,
  decrementStock,
  incrementStock,
  filterByCategory,
};
