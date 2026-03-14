require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const _logPath = path.join(__dirname, '..', 'debug-29a20c.log');
function _dbg(payload) { try { fs.appendFileSync(_logPath, JSON.stringify(payload) + '\n'); } catch (_) {} }
const session = require('express-session');
const { initFirebase } = require('./firebase');
const {
  getAllProducts,
  getProductById,
  getProductByCatalogueAndSub,
  addProduct,
  addProductFromCategory,
  addProductFromSubProduct,
  createProductForCatalogue,
  createProductForSubProduct,
  updateProduct,
} = require('./catalogue');
const { getCategories, getCategoryById, addCategory, getSubProducts, getSubProductById, addSubProduct, updateSubProduct } = require('./categories');
const {
  getOrders,
  getOrderById,
  updateOrderStatus,
  STATUS,
  getLast10Orders,
} = require('./orders');
const { getProductById: getProductForOrder } = require('./catalogue');
const { incrementStock } = require('./catalogue');

initFirebase();

let botInstance = null;
function setBot(bot) {
  botInstance = bot;
}

const app = express();
// Port : d'abord celui du serveur (hébergeur), sinon .env BACKOFFICE_PORT, sinon 3000
const PORT = Number(process.env.PORT) || Number(process.env.BACKOFFICE_PORT) || 3000;
const PASSWORD = process.env.BACKOFFICE_PASSWORD || '';
const SECRET = process.env.BACKOFFICE_SECRET || process.env.BACKOFFICE_PASSWORD || 'change-me-in-production';

// Rate limit login : 5 tentatives max par IP sur 15 min
const loginAttempts = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
function isLoginRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (now >= entry.resetAt) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= RATE_LIMIT_MAX;
}
function recordFailedLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  entry.count++;
  if (entry.count === 1) entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  loginAttempts.set(ip, entry);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);

function requireAuth(req, res, next) {
  if (!PASSWORD) {
    return res.status(503).send('Backoffice désactivé : définir BACKOFFICE_PASSWORD dans .env');
  }
  if (req.session.authenticated) return next();
  res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/admin');
  res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (isLoginRateLimited(ip)) {
    return res.render('login', { error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
  }
  if (req.body.password === PASSWORD) {
    req.session.authenticated = true;
    return res.redirect('/admin');
  }
  recordFailedLogin(ip);
  res.render('login', { error: 'Mot de passe incorrect' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.use('/admin', requireAuth);
app.get('/admin', (req, res) => res.redirect('/admin/dashboard'));

app.get('/admin/dashboard', async (req, res) => {
  const orders = await getLast10Orders();
  const products = await getAllProducts();
  const byStatus = {};
  orders.forEach((o) => {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  });
  const totalOrders = orders.length;
  const enAttente = (await getOrders({ limit: 500, status: STATUS.EN_ATTENTE })).length;
  const confirmees = (await getOrders({ limit: 500, status: STATUS.CONFIRMEE })).length;
  const livrees = (await getOrders({ limit: 500, status: STATUS.LIVREE })).length;
  const annulees = (await getOrders({ limit: 500, status: STATUS.ANNULEE })).length;
  res.render('dashboard', {
    orders: orders.slice(0, 10),
    productsCount: products.length,
    enAttente,
    confirmees,
    livrees,
    annulees,
  });
});

app.get('/admin/products', async (req, res) => {
  const products = await getAllProducts();
  res.render('products', { products });
});

app.get('/admin/categories', async (req, res) => {
  const categories = await getCategories();
  res.render('categories', { categories });
});

app.get('/admin/categories/new', (req, res) => {
  res.render('category-form', { category: null });
});

app.post('/admin/categories/new', async (req, res) => {
  const { nom, description, imageUrl } = req.body;
  await addCategory({
    nom: (nom || '').trim().toLowerCase(),
    description: (description || '').trim(),
    imageUrl: (imageUrl || '').trim(),
  });
  res.redirect('/admin/categories');
});

app.get('/admin/products/new', async (req, res) => {
  res.redirect('/admin/products/quick');
});

app.get('/admin/products/quick', async (req, res) => {
  const categories = await getCategories();
  const categoriesWithSubs = await Promise.all(
    categories.map(async (c) => ({ ...c, subProducts: await getSubProducts(c.id) }))
  );
  res.render('product-quick', { categories: categoriesWithSubs });
});

app.post('/admin/products/quick', async (req, res) => {
  const { categoryId, subProductId, E, P, dateExpiration } = req.body;
  if (!categoryId) return res.redirect('/admin/products/quick');
  const subId = (subProductId || '').trim();
  if (!subId) {
    const categories = await getCategories();
    const categoriesWithSubs = await Promise.all(categories.map(async (c) => ({ ...c, subProducts: await getSubProducts(c.id) })));
    return res.render('product-quick', { categories: categoriesWithSubs, error: 'Choisissez un sous-produit.' });
  }
  await addProductFromSubProduct(categoryId, subId, { E: (E || '').trim(), P: (P || '').trim(), dateExpiration: (dateExpiration || '').trim() });
  res.redirect('/admin/products');
});

app.get('/admin/categories/:id/subs', async (req, res) => {
  const category = await getCategoryById(req.params.id);
  if (!category) return res.status(404).send('Catalogue introuvable');
  const subProducts = await getSubProducts(req.params.id);
  res.render('sub-products', { category, subProducts });
});

app.get('/admin/categories/:id/subs/new', async (req, res) => {
  const category = await getCategoryById(req.params.id);
  if (!category) return res.status(404).send('Catalogue introuvable');
  res.render('sub-product-form', { category, subProduct: null });
});

app.post('/admin/categories/:id/subs/new', async (req, res) => {
  const catalogueId = req.params.id;
  const { nom, prixMois, description } = req.body;
  const sub = await addSubProduct(catalogueId, {
    nom: (nom || '').trim(),
    prixMois: Math.max(0, Number(prixMois) || 0),
    description: (description || '').trim(),
  });
  await createProductForSubProduct(catalogueId, sub.id);
  res.redirect('/admin/categories/' + catalogueId + '/subs');
});

app.get('/admin/categories/:id/subs/:subId/edit', async (req, res) => {
  const category = await getCategoryById(req.params.id);
  if (!category) return res.status(404).send('Catalogue introuvable');
  const subProduct = await getSubProductById(req.params.subId);
  if (!subProduct || subProduct.catalogueId !== req.params.id) return res.status(404).send('Sous-produit introuvable');
  res.render('sub-product-form', { category, subProduct });
});

app.post('/admin/categories/:id/subs/:subId/edit', async (req, res) => {
  const catalogueId = req.params.id;
  const subId = req.params.subId;
  const { nom, prixMois, description } = req.body;
  await updateSubProduct(subId, {
    nom: (nom || '').trim(),
    prixMois: Math.max(0, Number(prixMois) || 0),
    description: (description || '').trim(),
  });
  const product = await getProductByCatalogueAndSub(catalogueId, subId);
  if (product) {
    await updateProduct(product.id, { titre: (nom || '').trim(), prix: Math.max(0, Number(prixMois) || 0), description: (description || '').trim() });
  }
  res.redirect('/admin/categories/' + catalogueId + '/subs');
});

app.post('/admin/products/new', async (req, res) => {
  const { titre, prix, description, imageUrl, stock, categorie, E, P, dateExpiration } = req.body;
  await addProduct({
    titre: titre || '',
    prix: Number(prix) || 0,
    description: description || '',
    imageUrl: imageUrl || '',
    stock: Math.max(0, parseInt(stock, 10) || 1),
    categorie: (categorie || 'netflix').toLowerCase().trim(),
    E: E || '',
    P: P || '',
    dateExpiration: dateExpiration || '',
  });
  res.redirect('/admin/products');
});

app.get('/admin/products/:id/edit', async (req, res) => {
  const product = await getProductById(req.params.id);
  if (!product) return res.status(404).send('Produit introuvable');
  res.render('product-form', { product });
});

app.post('/admin/products/:id/edit', async (req, res) => {
  const { titre, prix, description, imageUrl, stock, categorie, actif, E, P, dateExpiration } = req.body;
  await updateProduct(req.params.id, {
    titre,
    prix,
    description,
    imageUrl,
    stock,
    categorie,
    actif: actif === 'on' || actif === '1',
    E,
    P,
    dateExpiration,
  });
  res.redirect('/admin/products');
});

const ORDERS_PAGE_SIZE = 30;
const ORDERS_FETCH_MAX = 300;

app.get('/admin/orders', async (req, res) => {
  const status = req.query.status || null;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  let allOrders;
  if (status === 'en_cours') {
    const all = await getOrders({ limit: ORDERS_FETCH_MAX });
    allOrders = all.filter(o => o.status === STATUS.EN_ATTENTE || o.status === STATUS.CONFIRMEE);
  } else {
    allOrders = await getOrders({ limit: ORDERS_FETCH_MAX, status });
  }
  const totalCount = allOrders.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / ORDERS_PAGE_SIZE));
  const pageIndex = Math.min(page, totalPages);
  const orders = allOrders.slice((pageIndex - 1) * ORDERS_PAGE_SIZE, pageIndex * ORDERS_PAGE_SIZE);
  res.render('orders', {
    orders,
    currentStatus: status,
    STATUS,
    page: pageIndex,
    totalPages,
    totalCount,
    pageSize: ORDERS_PAGE_SIZE,
  });
});

app.post('/admin/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const order = await getOrderById(id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  if (status !== STATUS.LIVREE && status !== STATUS.ANNULEE) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  if (status === STATUS.ANNULEE && order.status === STATUS.CONFIRMEE && order.produit?.id) {
    const qte = order.produit?.quantite ?? 1;
    if (qte > 0) await incrementStock(order.produit.id, qte);
  }

  await updateOrderStatus(id, status);

  if (botInstance && order.userId) {
    try {
      if (status === STATUS.LIVREE) {
        const qte = order.produit?.quantite ?? 1;
        const detail = qte > 1 ? `${order.produit?.titre} x${qte}` : order.produit?.titre;
        let msg = `Votre commande ${order.refCommande} (${detail}) a été livrée. Merci !`;
        const product = order.produit?.id ? await getProductForOrder(order.produit.id) : null;
        if (product && (product.E || product.P || product.dateExpiration)) {
          const block = ['E: ' + (product.E || '-'), 'P: ' + (product.P || '-'), 'Date d\'expiration : ' + (product.dateExpiration || '-')].join('\n');
          msg += '\n\n' + block;
        }
        await botInstance.telegram.sendMessage(order.userId, msg);
      } else if (status === STATUS.ANNULEE) {
        await botInstance.telegram.sendMessage(
          order.userId,
          `Votre commande ${order.refCommande} (${order.produit?.titre}) a été annulée. Contactez-nous en cas de question.`
        );
      }
    } catch (e) {
      console.error('Backoffice: erreur envoi Telegram', e.message);
    }
  }

  if (res.headersSent) return;
  if (req.xhr || req.get('Accept') === 'application/json') {
    return res.json({ ok: true });
  }
  res.redirect('/admin/orders');
});

function startBackoffice(opts = {}) {
  // #region agent log
  _dbg({sessionId:'29a20c',location:'backoffice.js:startBackoffice',message:'entry',data:{hasPassword:!!PASSWORD,passwordLen:PASSWORD?PASSWORD.length:0},timestamp:Date.now(),hypothesisId:'A'});
  // #endregion
  const fromBot = opts.fromBot === true;
  if (!PASSWORD) {
    // #region agent log
    _dbg({sessionId:'29a20c',location:'backoffice.js:startBackoffice-early-return',message:'early return no PASSWORD',data:{},timestamp:Date.now(),hypothesisId:'A'});
    // #endregion
    if (!fromBot) console.log('  Backoffice non démarré (BACKOFFICE_PASSWORD non défini).');
    return;
  }
  // #region agent log
  _dbg({sessionId:'29a20c',location:'backoffice.js:before-listen',message:'calling app.listen',data:{port:PORT},timestamp:Date.now(),hypothesisId:'C'});
  // #endregion
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      // #region agent log
      _dbg({sessionId:'29a20c',location:'backoffice.js:listen-callback',message:'listen callback ran',data:{port:PORT},timestamp:Date.now(),hypothesisId:'C'});
      // #endregion
      console.log('  Backoffice démarré : http://localhost:' + PORT + '/admin');
      resolve();
    });
    server.on('error', (err) => {
      // #region agent log
      _dbg({sessionId:'29a20c',location:'backoffice.js:server-error',message:'server error',data:{code:err.code,message:err.message},timestamp:Date.now(),hypothesisId:'D'});
      // #endregion
      if (err.code === 'EADDRINUSE') {
        console.error('  Erreur backoffice : le port ' + PORT + ' est déjà utilisé. Ferme l\'autre processus ou change BACKOFFICE_PORT dans .env');
      } else {
        console.error('  Erreur backoffice :', err.message);
      }
      reject(err);
    });
  });
}

if (require.main === module) {
  startBackoffice();
}

module.exports = { startBackoffice, setBot, app };
