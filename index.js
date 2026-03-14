require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { initFirebase, getDb } = require('./firebase');
const { getActiveProducts, getActiveProductsByCategory, getProductById, addProduct, addProductFromCategory, addProductFromSubProduct, reserveCompteForOrder, decrementStock, incrementStock } = require('./catalogue');
const { getCategories, getSubProducts } = require('./categories');
const { updateOrderDeliveryData } = require('./orders');
const {
  createOrder,
  getLastPendingOrderByUser,
  getLastOrderByUser,
  getOrderById,
  updateOrderStatus,
  getLast10Orders,
  getOrders,
  STATUS,
} = require('./orders');
const { buildWaveLink } = require('./payment');
const { isAdmin, getAdminChatId } = require('./middleware/auth');
const { pendingOrderImageOnly } = require('./middleware/pendingOrder');
const { saveUser, getUserByUserId, getUsers, getUsersCount } = require('./users');
const { schedulePaymentReminderAndCancel, runPaymentTimeoutRecovery } = require('./lib/paymentTimers');
const msg = require('./lib/messages');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = getAdminChatId();

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN manquant dans .env');
  process.exit(1);
}

initFirebase();
const bot = new Telegraf(BOT_TOKEN);

// Historique : tout ce qui arrive au bot s'affiche dans le terminal
function logHorodatage() {
  const d = new Date();
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
bot.use((ctx, next) => {
  const from = ctx.from;
  const user = from ? `${from.first_name || ''} (@${from.username || 'sans pseudo'}) [${from.id}]` : '?';
  let action = '';
  if (ctx.message) {
    if (ctx.message.text) action = `Texte: ${ctx.message.text.slice(0, 80)}${ctx.message.text.length > 80 ? '…' : ''}`;
    else if (ctx.message.photo) action = 'Photo (reçu)';
    else if (ctx.message.document) action = 'Document';
    else action = 'Message (autre)';
  } else if (ctx.callbackQuery) {
    action = `Callback: ${ctx.callbackQuery.data}`;
  } else {
    action = 'Update';
  }
  console.log(`[${logHorodatage()}] ${user} → ${action}`);
  return next();
});

bot.use(pendingOrderImageOnly);

// Éviter que le bot ne plante sur une erreur (ex: Firestore désactivé)
bot.catch((err, ctx) => {
  const isUnchangedMessage =
    (err.message && err.message.includes('message is not modified')) ||
    (err.response?.description && err.response.description.includes('message is not modified'));
  if (isUnchangedMessage) {
    try { if (ctx?.answerCbQuery) ctx.answerCbQuery().catch(() => {}); } catch (_) {}
    return;
  }
  console.error('Erreur bot:', err.message);
  if (err.code === 5 || (err.message && err.message.includes('NOT_FOUND'))) {
    console.error('\n❌ NOT_FOUND = la base Firestore n’existe pas encore.');
    console.error('   Crée-la ici : https://console.firebase.google.com');
    console.error('   → Ton projet → Firestore Database → "Créer une base de données"');
    console.error('   → Choisir une région (ex. europe-west1) → Activer.\n');
  }
  try {
    ctx.reply(msg.errors.generic).catch(() => {});
  } catch (_) {}
});

// ——— Client ———

// Clavier persistant sous la zone de saisie (bouton Menu)
const mainMenuKeyboard = Markup.keyboard([['📱 Menu'], ['🛒 Catalogue']])
  .resize()
  .persistent();

// Clavier pour demander le partage du numéro (nouveaux utilisateurs)
const contactRequestKeyboard = Markup.keyboard([
  [Markup.button.contactRequest('📱 Partager mon numéro')],
]).resize().oneTime();

async function isUserAllowed(ctx) {
  if (isAdmin(ctx)) return true;
  const userId = ctx.from?.id;
  if (!userId) return false;
  const user = await getUserByUserId(userId);
  return user && user.countryAllowed === true;
}

function getMenuContent() {
  const text = [
    msg.client.menuTitle,
    '',
    msg.client.menuCatalogue,
    msg.client.menuWave,
    msg.client.menuSuivi,
    '',
    msg.client.menuAbonnement,
    '',
  ].join('\n');
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📂 Voir le catalogue', 'menu_catalogue')],
    [Markup.button.callback('📋 Où en est ma commande ?', 'client_ma_commande')],
    [
      Markup.button.callback('🛒 Catalogue', 'menu_catalogue'),
      Markup.button.callback('ℹ️ Aide', 'menu_aide'),
    ],
    [Markup.button.callback('Fermer le shop', 'menu_fermer')],
  ]);
  return { text, keyboard };
}

function getAdminMenuContent() {
  const port = Number(process.env.PORT) || Number(process.env.BACKOFFICE_PORT) || 3000;
  const backofficeUrl = (process.env.BACKOFFICE_URL || `http://localhost:${port}`).trim().replace(/\/+$/, '') + '/admin';
  const text = [
    msg.admin.menuTitle,
    '',
    msg.admin.menuStats,
    msg.admin.menuOrders,
    msg.admin.menuBackoffice,
    backofficeUrl.startsWith('https://') ? '' : `\n💻 Backoffice (sur PC) : ${backofficeUrl}`,
    '',
  ].join('\n');
  const rows = [
    [Markup.button.callback('📊 Statistiques', 'admin_stats')],
    [
      Markup.button.callback('📦 Commandes', 'admin_commandes'),
      Markup.button.callback('🔄 En cours', 'admin_en_cours'),
    ],
    [Markup.button.callback('✅ Traitées (livrées)', 'admin_traitees')],
  ];
  if (backofficeUrl.startsWith('https://')) {
    rows.push([Markup.button.url('🔗 Backoffice', backofficeUrl)]);
  }
  rows.push([Markup.button.callback('📦 Stock / comptes disponibles', 'admin_stock')]);
  rows.push([Markup.button.callback('👥 Voir utilisateurs', 'admin_users')]);
  const keyboard = Markup.inlineKeyboard(rows);
  return { text, keyboard };
}

async function showMenu(ctx) {
  if (isAdmin(ctx)) {
    const { text, keyboard } = getAdminMenuContent();
    return ctx.replyWithHTML(text, keyboard);
  }
  if (!(await isUserAllowed(ctx))) {
    return ctx.reply(msg.client.sharePhone, contactRequestKeyboard);
  }
  const { text, keyboard } = getMenuContent();
  return ctx.replyWithHTML(text, keyboard);
}

bot.start(async (ctx) => {
  if (isAdmin(ctx)) {
    const { text, keyboard } = getAdminMenuContent();
    return ctx.replyWithHTML(msg.client.welcomeAdmin + '\n\n' + text, keyboard);
  }
  if (!(await isUserAllowed(ctx))) {
    return ctx.reply(msg.client.sharePhone, contactRequestKeyboard);
  }
  return ctx.reply(msg.client.welcome, mainMenuKeyboard);
});

// Partage du contact : vérification +225 puis enregistrement ou refus
bot.on('contact', async (ctx) => {
  const from = ctx.from;
  const contact = ctx.message?.contact;
  if (!contact?.phone_number || !from?.id) {
    return ctx.reply(msg.errors.generic);
  }
  if (isAdmin(ctx)) {
    return ctx.reply(msg.client.welcome, mainMenuKeyboard);
  }
  const raw = contact.phone_number.replace(/\D/g, '');
  const isIvorian = raw.startsWith('225') && raw.length >= 9;
  const firstName = from.first_name || '';
  const username = from.username || '';
  if (isIvorian) {
    await saveUser({
      userId: String(from.id),
      phone_number: contact.phone_number,
      firstName,
      username,
      countryAllowed: true,
    });
    return ctx.reply(msg.client.welcome, mainMenuKeyboard);
  }
  return ctx.reply(msg.client.countryNotAllowed);
});

// Tap sur le bouton "Menu" ou "Catalogue" du clavier = pas besoin de taper /menu ou /catalogue
bot.hears(['📱 Menu', 'Menu'], showMenu);
bot.hears(['🛒 Catalogue', 'Catalogue'], sendCatalogue);

bot.command('menu', showMenu);
function replyMyOrderStatus(ctx, order) {
  const ref = order.refCommande || order.id;
  const label = msg.client.myOrderStatus[order.status] || order.status;
  const detail = order.produit?.titre ? ` — ${order.produit.titre}` : '';
  return ctx.replyWithHTML(
    `<b>${msg.client.myOrderTitle}</b>\n\nRéf. <b>${ref}</b>${detail}\n\nStatut : ${label}`
  );
}

bot.command('commande', async (ctx) => {
  if (isAdmin(ctx)) return;
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply(msg.errors.generic);
  const order = await getLastOrderByUser(userId);
  if (!order) return ctx.reply(msg.client.myOrderNone);
  return replyMyOrderStatus(ctx, order);
});

bot.action('client_ma_commande', async (ctx) => {
  await ctx.answerCbQuery();
  if (isAdmin(ctx)) return ctx.reply(msg.client.adminNoOrderHereShort);
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply(msg.errors.generic);
  const order = await getLastOrderByUser(userId);
  if (!order) return ctx.reply(msg.client.myOrderNone);
  return replyMyOrderStatus(ctx, order);
});

// ——— Actions du menu admin ———
bot.action('admin_stats', async (ctx) => {
  await ctx.answerCbQuery();
  const [enAttente, confirmees, livrees, annulees, usersCount] = await Promise.all([
    getOrders({ limit: 500, status: STATUS.EN_ATTENTE }),
    getOrders({ limit: 500, status: STATUS.CONFIRMEE }),
    getOrders({ limit: 500, status: STATUS.LIVREE }),
    getOrders({ limit: 500, status: STATUS.ANNULEE }),
    getUsersCount(),
  ]);
  const total = enAttente.length + confirmees.length + livrees.length + annulees.length;
  const text = [
    '📊 <b>Statistiques</b>',
    '',
    `👥 Utilisateurs : <b>${usersCount}</b>`,
    '',
    `📥 En attente (reçu) : <b>${enAttente.length}</b>`,
    `✅ Confirmées (à livrer) : <b>${confirmees.length}</b>`,
    `📤 Livrées : <b>${livrees.length}</b>`,
    `❌ Annulées : <b>${annulees.length}</b>`,
    '',
    `Total : <b>${total}</b> commandes`,
  ].join('\n');
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('👥 Voir utilisateurs', 'admin_users')],
  ]);
  await ctx.replyWithHTML(text, keyboard);
});

bot.action('admin_users', async (ctx) => {
  await ctx.answerCbQuery();
  const users = await getUsers({ limit: 200 });
  if (!users.length) {
    return ctx.replyWithHTML('👥 <b>Utilisateurs</b>\n\nAucun utilisateur enregistré.');
  }
  const lines = users.map((u) => {
    const name = [u.firstName, u.username ? `@${u.username}` : ''].filter(Boolean).join(' ') || `ID ${u.userId}`;
    const phone = u.phone_number || '—';
    return `• ${name} — ${phone}`;
  });
  const header = `👥 <b>Utilisateurs</b> (${users.length})\n\n`;
  const body = lines.join('\n');
  const msgText = header + body;
  if (msgText.length > 4000) {
    const chunks = [];
    let current = header;
    for (const line of lines) {
      if (current.length + line.length + 1 > 4000) {
        chunks.push(current);
        current = line;
      } else {
        current += '\n' + line;
      }
    }
    if (current) chunks.push(current);
    for (const chunk of chunks) await ctx.replyWithHTML(chunk);
  } else {
    await ctx.replyWithHTML(msgText);
  }
});

bot.action('admin_commandes', async (ctx) => {
  await ctx.answerCbQuery();
  const orders = await getLast10Orders();
  if (!orders.length) {
    return ctx.reply(msg.admin.noOrders);
  }
  const backofficeUrl = process.env.BACKOFFICE_URL || `http://localhost:${Number(process.env.PORT) || Number(process.env.BACKOFFICE_PORT) || 3000}`;
  const lines = orders.map(o => {
    const qte = o.produit?.quantite ?? 1;
    const total = o.produit?.total ?? o.produit?.prix;
    const p = qte > 1 ? `${o.produit?.titre} x${qte}=${total}F` : `${o.produit?.titre} ${total}F`;
    return `• ${o.refCommande || o.id} | ${p} | ${o.status} | @${o.username || o.userId}`;
  });
  await ctx.replyWithHTML(
    '<b>📦 Dernières 10 commandes</b>\n\n' + lines.join('\n') + '\n\n🔗 Tout gérer : ' + backofficeUrl + '/admin/orders'
  );
});

bot.action('admin_en_cours', async (ctx) => {
  await ctx.answerCbQuery();
  const [enAttente, confirmees] = await Promise.all([
    getOrders({ limit: 100, status: STATUS.EN_ATTENTE }),
    getOrders({ limit: 100, status: STATUS.CONFIRMEE }),
  ]);
  const orders = [...enAttente, ...confirmees].sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)).slice(0, 15);
  if (!orders.length) {
    return ctx.reply(msg.admin.enCoursNone);
  }
  const lines = orders.map(o => {
    const qte = o.produit?.quantite ?? 1;
    const total = o.produit?.total ?? o.produit?.prix;
    const p = qte > 1 ? `${o.produit?.titre} x${qte}=${total}F` : `${o.produit?.titre} ${total}F`;
    return `• ${o.refCommande || o.id} | ${p} | ${o.status} | @${o.username || o.userId}`;
  });
  await ctx.replyWithHTML(
    '<b>🔄 Commandes en cours</b> (en attente reçu + confirmées)\n\n' + lines.join('\n')
  );
});

bot.action('admin_traitees', async (ctx) => {
  await ctx.answerCbQuery();
  const livrees = await getOrders({ limit: 20, status: STATUS.LIVREE });
  if (!livrees.length) {
    return ctx.reply(msg.admin.traiteesNone);
  }
  const lines = livrees.map(o => {
    const qte = o.produit?.quantite ?? 1;
    const total = o.produit?.total ?? o.produit?.prix;
    const p = qte > 1 ? `${o.produit?.titre} x${qte}=${total}F` : `${o.produit?.titre} ${total}F`;
    return `• ${o.refCommande || o.id} | ${p} | @${o.username || o.userId}`;
  });
  await ctx.replyWithHTML('<b>✅ Commandes livrées</b>\n\n' + lines.join('\n'));
});

bot.action('admin_stock', async (ctx) => {
  await ctx.answerCbQuery();
  const netflix = await getActiveProductsByCategory('netflix');
  const onoff = await getActiveProductsByCategory('onoff');
  const lines = ['<b>📦 Comptes disponibles</b>', ''];
  netflix.forEach(p => { lines.push(`• ${p.titre || 'Netflix'} : <b>${p.stock ?? 0}</b> en stock`); });
  onoff.forEach(p => { lines.push(`• ${p.titre || 'Onoff'} : <b>${p.stock ?? 0}</b> en stock`); });
  if (netflix.length === 0 && onoff.length === 0) lines.push(msg.admin.noProduct);
  await ctx.replyWithHTML(lines.join('\n'));
});

// Catalogue : d'abord choix de catégorie (Netflix / Onoff)
const CATEGORIES = [
  { id: 'netflix', label: 'Netflix' },
  { id: 'onoff', label: 'Onoff' },
];

function getCategoryChoiceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Netflix', 'cat_netflix'), Markup.button.callback('Onoff', 'cat_onoff')],
    [Markup.button.callback('◀️ Retour au menu', 'menu_back')],
  ]);
}

const NETFLIX_MOIS = [1, 2, 3, 6, 12];
const ONOFF_MOIS = [1, 2, 3];

async function sendOrderWithWave(ctx, product, quantity, dureeMois = null) {
  if (isAdmin(ctx)) {
    await ctx.reply(msg.client.adminNoOrderHere);
    return;
  }
  // Avant d'envoyer le lien de paiement : vérifier le stock. Pas de lien si rupture.
  const freshProduct = await getProductById(product.id);
  if (!freshProduct) {
    return ctx.reply('Produit indisponible.');
  }
  const stock = Math.max(0, freshProduct.stock ?? 0);
  if (stock < quantity) {
    const text = stock === 0 ? msg.catalogue.noStockNoLink : msg.catalogue.noStockNoLinkCount(stock);
    return ctx.reply(text);
  }
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name || 'Client';
  const order = await createOrder({
    userId,
    username,
    product: {
      id: product.id,
      titre: product.titre,
      prix: product.prix,
      quantite: quantity,
      ...(dureeMois != null && { dureeMois }),
    },
  });
  const total = order.produit.total;
  const detail = dureeMois != null
    ? `${product.titre} — ${dureeMois} mois x ${quantity} = <b>${total} FCFA</b>`
    : `${product.titre} x${quantity} mois = <b>${total} FCFA</b>`;

  schedulePaymentReminderAndCancel(bot, order);
  const link = buildWaveLink(total, order.refCommande);
  console.log(`[${logHorodatage()}] Commande créée ref=${order.refCommande} par ${username} (${product.titre} ${dureeMois != null ? dureeMois + ' mois x' + quantity : quantity} = ${total} FCFA)`);
  await ctx.reply(
    msg.catalogue.orderCreated(order.refCommande, detail) + `\n${link}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.url('Payer via Wave', link)],
        [Markup.button.callback('❌ Annuler la commande', `cancel_order_${order.id}`)],
      ]),
    }
  );
}

bot.action('menu_catalogue', async (ctx) => {
  await ctx.answerCbQuery();
  if (isAdmin(ctx)) {
    const netflix = await getActiveProductsByCategory('netflix');
    const onoff = await getActiveProductsByCategory('onoff');
    const lines = [msg.admin.stockTitle, ''];
    netflix.forEach(p => { lines.push(`• ${p.titre || 'Netflix'} : <b>${p.stock ?? 0}</b> en stock`); });
    onoff.forEach(p => { lines.push(`• ${p.titre || 'Onoff'} : <b>${p.stock ?? 0}</b> en stock`); });
    if (netflix.length === 0 && onoff.length === 0) lines.push(msg.admin.noProduct);
    return ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML' });
  }
  if (!(await isUserAllowed(ctx))) {
    return ctx.reply(msg.client.sharePhone, contactRequestKeyboard);
  }
  return ctx.editMessageText(msg.catalogue.chooseCategory, {
    parse_mode: 'HTML',
    ...getCategoryChoiceKeyboard(),
  });
});

// Netflix : image en haut, puis contenu (catégorie + instruction) + boutons en bas (comme référence XBOX)
const CAPTION_NETFLIX = `📄 Catégorie: Netflix

- - - - - - - - - -

➡ Cliquez sur le bouton ci-dessous pour choisir la durée de votre abonnement (nombre de mois).`;

bot.action('cat_netflix', async (ctx) => {
  await ctx.answerCbQuery();
  const products = await getActiveProductsByCategory('netflix');
  const product = products[0];
  if (!product) {
    return ctx.editMessageText(msg.catalogue.noNetflix, getCategoryChoiceKeyboard());
  }
  const netflixImg = process.env.NETFLIX_CAT_IMAGE_URL;
  const keyboard = Markup.inlineKeyboard([
    NETFLIX_MOIS.map(m => Markup.button.callback(`${m} mois`, `netflix_${m}`)),
    [Markup.button.callback('◀️ Retour aux catégories', 'cat_back')],
  ]);
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  if (netflixImg && netflixImg.startsWith('http')) {
    await ctx.replyWithPhoto(netflixImg, { caption: CAPTION_NETFLIX, ...keyboard });
  } else {
    await ctx.reply(CAPTION_NETFLIX, keyboard);
  }
});

bot.action(/^netflix_(1|2|3|6|12)$/, async (ctx) => {
  const months = parseInt(ctx.match[1], 10);
  const products = await getActiveProductsByCategory('netflix');
  const product = products[0];
  if (!product) return ctx.answerCbQuery('Indisponible.');
  const stock = Math.max(0, product.stock ?? 0);
  if (stock === 0) return ctx.answerCbQuery('Rupture de stock.');
  if (months > stock) return ctx.answerCbQuery(`Stock insuffisant (${stock}).`);
  await ctx.answerCbQuery();
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  await sendOrderWithWave(ctx, product, months);
});

function getOnoffTypeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Onoff Premium — 3000 FCFA/mois', 'onoff_premium')],
    [Markup.button.callback('Onoff Start — 2500 FCFA/mois', 'onoff_start')],
    [Markup.button.callback('◀️ Retour aux catégories', 'cat_back')],
  ]);
}

// Onoff : image en haut, puis contenu (catégorie + instruction) + boutons en bas (comme référence XBOX)
const CAPTION_ONOFF = `📄 Catégorie: Onoff

- - - - - - - - - -

➡ Cliquez sur le bouton ci-dessous pour choisir le type d'abonnement (Premium ou Start).`;

bot.action('cat_onoff', async (ctx) => {
  await ctx.answerCbQuery();
  const products = await getActiveProductsByCategory('onoff');
  if (!products.length) {
    return ctx.editMessageText(msg.catalogue.noOnoff, getCategoryChoiceKeyboard());
  }
  const onoffImg = process.env.ONOFF_CAT_IMAGE_URL;
  const keyboard = getOnoffTypeKeyboard();
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  if (onoffImg && onoffImg.startsWith('http')) {
    await ctx.replyWithPhoto(onoffImg, { caption: CAPTION_ONOFF, ...keyboard });
  } else {
    await ctx.reply(CAPTION_ONOFF, keyboard);
  }
});

function getOnoffTypeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Onoff Premium — 3000 FCFA/mois', 'onoff_premium')],
    [Markup.button.callback('Onoff Start — 2500 FCFA/mois', 'onoff_start')],
    [Markup.button.callback('◀️ Retour aux catégories', 'cat_back')],
  ]);
}

function editCaptionOrText(ctx, text, keyboard) {
  const hasPhoto = ctx.callbackQuery?.message?.photo;
  if (hasPhoto) {
    return ctx.editMessageCaption({ caption: text, parse_mode: 'HTML', ...keyboard });
  }
  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
}

bot.action('onoff_premium', async (ctx) => {
  await ctx.answerCbQuery();
  const text = 'Choisissez la durée (Onoff Premium — 3000 FCFA/mois) :';
  const keyboard = Markup.inlineKeyboard([
    ONOFF_MOIS.map(m => Markup.button.callback(`${m} mois`, `onoff_premium_${m}`)),
    [Markup.button.callback('◀️ Retour', 'onoff_back')],
  ]);
  return editCaptionOrText(ctx, text, keyboard);
});

bot.action('onoff_start', async (ctx) => {
  await ctx.answerCbQuery();
  const text = 'Choisissez la durée (Onoff Start — 2500 FCFA/mois) :';
  const keyboard = Markup.inlineKeyboard([
    ONOFF_MOIS.map(m => Markup.button.callback(`${m} mois`, `onoff_start_${m}`)),
    [Markup.button.callback('◀️ Retour', 'onoff_back')],
  ]);
  return editCaptionOrText(ctx, text, keyboard);
});

bot.action('onoff_back', async (ctx) => {
  await ctx.answerCbQuery();
  return editCaptionOrText(ctx, CAPTION_ONOFF, getOnoffTypeKeyboard());
});

const ONOFF_MAX_QTY = 10;

// Clic sur une durée (1, 2 ou 3 mois) → remplacer par stock + choix quantité
bot.action(/^onoff_premium_(1|2|3)$/, async (ctx) => {
  const months = parseInt(ctx.match[1], 10);
  await ctx.answerCbQuery();
  const products = await getActiveProductsByCategory('onoff');
  const product = products.find(p => (p.titre || '').toLowerCase().includes('premium'));
  if (!product) return ctx.answerCbQuery('Indisponible.');
  const stock = Math.max(0, product.stock ?? 0);
  if (stock === 0) {
    const text = `📦 <b>Onoff Premium</b> — ${product.prix} FCFA/mois\n\n⚠️ Rupture de stock. Plus disponible pour le moment.`;
    return editCaptionOrText(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'onoff_show_duration_premium')]]));
  }
  const maxQty = Math.min(ONOFF_MAX_QTY, stock);
  const text = `📦 <b>Onoff Premium</b> — ${product.prix} FCFA/mois\n<b>Durée :</b> ${months} mois\n<b>Stock disponible :</b> ${stock}\n\nChoisissez la quantité (max ${ONOFF_MAX_QTY}) :`;
  const row = [];
  for (let q = 1; q <= maxQty; q++) row.push(Markup.button.callback(String(q), `onoff_premium_${months}_${q}`));
  const keyboard = Markup.inlineKeyboard([
    row,
    [Markup.button.callback('◀️ Retour', 'onoff_show_duration_premium')],
  ]);
  return editCaptionOrText(ctx, text, keyboard);
});

bot.action('onoff_show_duration_premium', async (ctx) => {
  await ctx.answerCbQuery();
  const text = 'Choisissez la durée (Onoff Premium — 3000 FCFA/mois) :';
  const keyboard = Markup.inlineKeyboard([
    ONOFF_MOIS.map(m => Markup.button.callback(`${m} mois`, `onoff_premium_${m}`)),
    [Markup.button.callback('◀️ Retour', 'onoff_back')],
  ]);
  return editCaptionOrText(ctx, text, keyboard);
});

bot.action(/^onoff_start_(1|2|3)$/, async (ctx) => {
  const months = parseInt(ctx.match[1], 10);
  await ctx.answerCbQuery();
  const products = await getActiveProductsByCategory('onoff');
  const product = products.find(p => (p.titre || '').toLowerCase().includes('start'));
  if (!product) return ctx.answerCbQuery('Indisponible.');
  const stock = Math.max(0, product.stock ?? 0);
  if (stock === 0) {
    const text = `📦 <b>Onoff Start</b> — ${product.prix} FCFA/mois\n\n⚠️ Rupture de stock. Plus disponible pour le moment.`;
    return editCaptionOrText(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'onoff_show_duration_start')]]));
  }
  const maxQty = Math.min(ONOFF_MAX_QTY, stock);
  const text = `📦 <b>Onoff Start</b> — ${product.prix} FCFA/mois\n<b>Durée :</b> ${months} mois\n<b>Stock disponible :</b> ${stock}\n\nChoisissez la quantité (max ${ONOFF_MAX_QTY}) :`;
  const row = [];
  for (let q = 1; q <= maxQty; q++) row.push(Markup.button.callback(String(q), `onoff_start_${months}_${q}`));
  const keyboard = Markup.inlineKeyboard([
    row,
    [Markup.button.callback('◀️ Retour', 'onoff_show_duration_start')],
  ]);
  return editCaptionOrText(ctx, text, keyboard);
});

bot.action('onoff_show_duration_start', async (ctx) => {
  await ctx.answerCbQuery();
  const text = 'Choisissez la durée (Onoff Start — 2500 FCFA/mois) :';
  const keyboard = Markup.inlineKeyboard([
    ONOFF_MOIS.map(m => Markup.button.callback(`${m} mois`, `onoff_start_${m}`)),
    [Markup.button.callback('◀️ Retour', 'onoff_back')],
  ]);
  return editCaptionOrText(ctx, text, keyboard);
});

// Clic sur une quantité → supprimer le message puis envoyer la commande (remplace)
bot.action(/^onoff_premium_(1|2|3)_(\d+)$/, async (ctx) => {
  const months = parseInt(ctx.match[1], 10);
  const qty = Math.min(ONOFF_MAX_QTY, Math.max(1, parseInt(ctx.match[2], 10)));
  const products = await getActiveProductsByCategory('onoff');
  const product = products.find(p => (p.titre || '').toLowerCase().includes('premium'));
  if (!product) return ctx.answerCbQuery('Indisponible.');
  const stock = Math.max(0, product.stock ?? 0);
  if (qty > stock) return ctx.answerCbQuery(`Stock insuffisant (${stock}).`);
  await ctx.answerCbQuery();
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  await sendOrderWithWave(ctx, product, qty, months);
});

bot.action(/^onoff_start_(1|2|3)_(\d+)$/, async (ctx) => {
  const months = parseInt(ctx.match[1], 10);
  const qty = Math.min(ONOFF_MAX_QTY, Math.max(1, parseInt(ctx.match[2], 10)));
  const products = await getActiveProductsByCategory('onoff');
  const product = products.find(p => (p.titre || '').toLowerCase().includes('start'));
  if (!product) return ctx.answerCbQuery('Indisponible.');
  const stock = Math.max(0, product.stock ?? 0);
  if (qty > stock) return ctx.answerCbQuery(`Stock insuffisant (${stock}).`);
  await ctx.answerCbQuery();
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  await sendOrderWithWave(ctx, product, qty, months);
});

bot.action('cat_back', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  await ctx.reply('Choisissez une catégorie :', getCategoryChoiceKeyboard());
});
bot.action('menu_aide', async (ctx) => {
  await ctx.answerCbQuery();
  const text = 'ℹ️ <b>Aide</b>\n\nUtilise le catalogue pour voir les produits et commander. Après paiement Wave, envoie la capture du reçu ici.';
  return ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour au menu', 'menu_back')]]),
  });
});
bot.action('menu_back', async (ctx) => {
  await ctx.answerCbQuery();
  const { text, keyboard } = getMenuContent();
  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
});
bot.action('menu_fermer', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.deleteMessage();
  } catch (_) {
    await ctx.reply('Shop fermé.');
  }
});

async function sendCatalogue(ctx) {
  if (isAdmin(ctx)) {
    const netflix = await getActiveProductsByCategory('netflix');
    const onoff = await getActiveProductsByCategory('onoff');
    const lines = ['<b>📦 Comptes disponibles</b>', ''];
    netflix.forEach(p => { lines.push(`• ${p.titre || 'Netflix'} : <b>${p.stock ?? 0}</b> en stock`); });
    onoff.forEach(p => { lines.push(`• ${p.titre || 'Onoff'} : <b>${p.stock ?? 0}</b> en stock`); });
    if (netflix.length === 0 && onoff.length === 0) lines.push('Aucun produit actif.');
    return ctx.replyWithHTML(lines.join('\n'));
  }
  if (!(await isUserAllowed(ctx))) {
    return ctx.reply(msg.client.sharePhone, contactRequestKeyboard);
  }
  console.log(`[${logHorodatage()}] Catalogue demandé → choix catégorie`);
  const netflixImg = process.env.NETFLIX_CAT_IMAGE_URL;
  const onoffImg = process.env.ONOFF_CAT_IMAGE_URL;
  if (netflixImg && onoffImg && netflixImg.startsWith('http') && onoffImg.startsWith('http')) {
    await ctx.replyWithPhoto(netflixImg, {
      caption: 'Netflix',
      ...Markup.inlineKeyboard([[Markup.button.callback('Voir les produits Netflix', 'cat_netflix')]]),
    });
    await ctx.replyWithPhoto(onoffImg, {
      caption: 'Onoff',
      ...Markup.inlineKeyboard([[Markup.button.callback('Voir les produits Onoff', 'cat_onoff')]]),
    });
  }
  return ctx.reply('Choisissez une catégorie :', getCategoryChoiceKeyboard());
}

bot.command('catalogue', sendCatalogue);

// Clic Commander → afficher le choix de quantité (stock)
bot.action(/^cmd_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const product = await getProductById(productId);
  if (!product) {
    return ctx.answerCbQuery('Produit indisponible.');
  }
  const stock = Math.max(0, product.stock ?? 0);
  if (stock === 0) {
    return ctx.answerCbQuery('Rupture de stock.');
  }
  const maxQty = Math.min(stock, 10);
  const row = [];
  for (let i = 1; i <= maxQty; i++) row.push(Markup.button.callback(String(i), `qty_${productId}_${i}`));
  const keyboard = Markup.inlineKeyboard([row]);
  await ctx.answerCbQuery();
  await ctx.reply(`📦 <b>${product.titre}</b> — ${product.prix} FCFA\n\nChoisissez la quantité (stock: ${stock}) :`, {
    parse_mode: 'HTML',
    ...keyboard,
  });
});

// Rupture : ne rien faire
bot.action(/^rupture_(.+)$/, (ctx) => ctx.answerCbQuery('Rupture de stock.'));

// Choix quantité → créer la commande (Wave pour client uniquement)
bot.action(/^qty_(.+)_(\d+)$/, async (ctx) => {
  if (isAdmin(ctx)) {
    await ctx.answerCbQuery();
    return ctx.reply(msg.client.adminNoOrderHereShort);
  }
  const productId = ctx.match[1];
  const quantity = Math.max(1, parseInt(ctx.match[2], 10));
  const product = await getProductById(productId);
  if (!product) {
    return ctx.answerCbQuery('Produit indisponible.');
  }
  const stock = Math.max(0, product.stock ?? 0);
  if (quantity > stock) {
    return ctx.answerCbQuery(`Stock insuffisant (disponible: ${stock}).`);
  }
  // Avant d'envoyer le lien de paiement : vérifier le stock. Pas de lien si rupture.
  const freshProduct = await getProductById(productId);
  const freshStock = Math.max(0, freshProduct?.stock ?? 0);
  if (freshStock < quantity) {
    await ctx.answerCbQuery();
    const text = freshStock === 0 ? msg.catalogue.noStockNoLink : msg.catalogue.noStockNoLinkCount(freshStock);
    return ctx.reply(text);
  }
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name || 'Client';
  const order = await createOrder({
    userId,
    username,
    product: { id: product.id, titre: product.titre, prix: product.prix, quantite: quantity },
  });
  const total = order.produit.total;
  await ctx.answerCbQuery();

  schedulePaymentReminderAndCancel(bot, order);
  const link = buildWaveLink(total, order.refCommande);
  const detailOnoff = `${product.titre} x${quantity} = <b>${total} FCFA</b>`;
  console.log(`[${logHorodatage()}] Commande créée ref=${order.refCommande} par ${username} (${product.titre} x${quantity} = ${total} FCFA)`);
  await ctx.reply(
    msg.catalogue.orderCreated(order.refCommande, detailOnoff) + `\n${link}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.url('Payer via Wave', link)],
        [Markup.button.callback('❌ Annuler la commande', `cancel_order_${order.id}`)],
      ]),
    }
  );
});

// Le client annule sa commande (en attente uniquement)
bot.action(/^cancel_order_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = await getOrderById(orderId);
  if (!order) {
    return ctx.answerCbQuery(msg.admin.orderNotFound);
  }
  if (String(order.userId) !== String(ctx.from.id)) {
    return ctx.answerCbQuery(msg.admin.notYours);
  }
  if (order.status !== STATUS.EN_ATTENTE) {
    return ctx.answerCbQuery(msg.admin.cannotCancel);
  }
  await updateOrderStatus(orderId, STATUS.ANNULEE);
  console.log(`[${logHorodatage()}] Commande ${order.refCommande} annulée par le client`);
  await ctx.answerCbQuery('Commande annulée.');
  try {
    await ctx.editMessageText(
      (ctx.callbackQuery.message?.text || '') + '\n\n❌ ' + msg.client.orderCancelled(order.refCommande),
      { parse_mode: 'HTML' }
    );
  } catch (_) {}
  await ctx.reply(msg.client.orderCancelledByYou(order.refCommande));
});

// Photo (reçu) : confirmer la dernière commande en_attente
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name || 'Client';
  const order = await getLastPendingOrderByUser(userId);
  if (!order) {
    return ctx.reply(msg.client.noPendingOrder);
  }
  const photo = ctx.message.photo.at(-1);
  const fileId = photo?.file_id;

  const product = order.produit?.id ? await getProductById(order.produit.id) : null;
  const qteToDeduct = order.produit?.quantite ?? 1;
  if (product?.catalogueId != null) {
    const deliveryData = await reserveCompteForOrder(order.produit.id);
    if (!deliveryData) {
      await updateOrderStatus(order.id, STATUS.ANNULEE);
      await ctx.reply(msg.client.outOfStockCancelled(order.refCommande));
      console.log(`[${logHorodatage()}] Commande ${order.refCommande} annulée (rupture de stock, pas de compte disponible)`);
      return;
    }
    await updateOrderDeliveryData(order.id, { E: deliveryData.E, P: deliveryData.P, dateExpiration: deliveryData.dateExpiration });
  } else if (order.produit?.id && qteToDeduct > 0) {
    const productForStock = await getProductById(order.produit.id);
    const available = Math.max(0, productForStock?.stock ?? 0);
    if (available < qteToDeduct) {
      await updateOrderStatus(order.id, STATUS.ANNULEE);
      await ctx.reply(msg.client.outOfStockCancelled(order.refCommande));
      console.log(`[${logHorodatage()}] Commande ${order.refCommande} annulée (rupture de stock)`);
      return;
    }
    await decrementStock(order.produit.id, qteToDeduct);
  }
  await updateOrderStatus(order.id, STATUS.CONFIRMEE);
  console.log(`[${logHorodatage()}] Commande ${order.refCommande} confirmée (reçu reçu)${product?.catalogueId != null ? ' — compte réservé' : ` → stock -${qteToDeduct}`} → admin notifié`);

  try {
    await ctx.reply(msg.client.paymentReceived(order.refCommande));
  } catch (e) {
    console.error('Erreur envoi confirmation client:', e.message);
  }

  const qte = order.produit?.quantite ?? 1;
  const total = order.produit?.total ?? order.produit?.prix;
  const produitLine = qte > 1 ? `${order.produit.titre} x${qte} = ${total} FCFA` : `${order.produit.titre} — ${total} FCFA`;
  const adminText = `📦 Nouvelle commande confirmée\nRef: ${order.refCommande}\nClient: ${username} (${userId})\nProduit: ${produitLine}`;
  const adminKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Livré', `livree_${order.id}`), Markup.button.callback('Annuler', `annulee_${order.id}`)],
  ]);
  try {
    if (fileId) {
      await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, fileId, {
        caption: adminText + '\n\n🖼 Reçu Wave',
        ...adminKeyboard,
      });
    } else {
      await ctx.telegram.sendMessage(ADMIN_CHAT_ID, adminText, adminKeyboard);
    }
  } catch (e) {
    console.error('Erreur envoi notification admin:', e.message);
  }
});

// ——— Admin ———

// État d'ajout de produit par catégorie (catégorie → E → P → date)
const addingProductState = {};
function getAddingState(chatId) {
  return addingProductState[String(chatId)];
}
function setAddingState(chatId, data) {
  if (data == null) delete addingProductState[String(chatId)];
  else addingProductState[String(chatId)] = data;
}

bot.command('addproduit', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const categories = await getCategories();
  if (!categories.length) {
    return ctx.reply('Aucune catégorie. Créez d\'abord des catégories (backoffice ou script seed-categories.js).');
  }
  setAddingState(ctx.chat?.id, { step: 'category' });
  const rows = categories.map(c => [Markup.button.callback(c.nom, `addprod_cat_${c.id}`)]);
  await ctx.reply('Choisis la catégorie :', Markup.inlineKeyboard(rows));
});

bot.command('commandes', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const orders = await getLast10Orders();
  console.log(`[${logHorodatage()}] Admin /commandes → ${orders.length} commande(s)`);
  if (!orders.length) {
    return ctx.reply(msg.admin.noOrders);
  }
  for (const o of orders) {
    const qte = o.produit?.quantite ?? 1;
    const total = o.produit?.total ?? o.produit?.prix;
    const produitStr = qte > 1 ? `${o.produit?.titre} x${qte}=${total}` : `${o.produit?.titre} ${o.produit?.prix}`;
    const text = `Ref: ${o.refCommande || o.id} | ${produitStr} FCFA | ${o.status} | @${o.username || o.userId}`;
    await ctx.reply(text, Markup.inlineKeyboard([
      [Markup.button.callback('Livré', `livree_${o.id}`), Markup.button.callback('Annuler', `annulee_${o.id}`)],
    ]));
  }
});


// Callback : choix de catégorie pour ajout produit
bot.action(/^addprod_cat_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  const state = getAddingState(chatId);
  if (state?.step !== 'category') return ctx.answerCbQuery();
  const categoryId = ctx.match[1];
  const subs = await getSubProducts(categoryId);
  if (subs && subs.length > 0) {
    setAddingState(chatId, { step: 'sub', categoryId });
    await ctx.answerCbQuery();
    const rows = subs.map(s => [Markup.button.callback(`${s.nom} — ${s.prixMois} FCFA/mois`, `addprod_sub_${s.id}`)]);
    return ctx.reply('Choisis le sous-produit :', Markup.inlineKeyboard(rows));
  }
  await ctx.answerCbQuery();
  await ctx.reply('Aucun sous-produit pour cette catégorie. Créez-en un dans le backoffice (Catalogues → Sous-produits).');
});

bot.action(/^addprod_sub_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  const state = getAddingState(chatId);
  if (state?.step !== 'sub') return ctx.answerCbQuery();
  const subProductId = ctx.match[1];
  setAddingState(chatId, { ...state, step: 'E', subProductId });
  await ctx.answerCbQuery();
  await ctx.reply('E : (identifiant du compte, ou - si vide)');
});

// Texte : étapes E → P → date pour ajout produit par catégorie
bot.on('text', async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (ctx.message.text?.startsWith('/')) {
    setAddingState(ctx.chat?.id, null);
    return;
  }
  const chatId = ctx.chat?.id;
  const state = getAddingState(chatId);
  if (!state || state.step === 'category') return;
  const text = ctx.message.text?.trim() ?? '';
  if (state.step === 'E') {
    setAddingState(chatId, { ...state, step: 'P', E: text });
    return ctx.reply('P : (mot de passe du compte, ou - si vide)');
  }
  if (state.step === 'P') {
    setAddingState(chatId, { ...state, step: 'date', P: text });
    return ctx.reply("Date d'expiration : (ex. 15-mars-2026)");
  }
  if (state.step === 'date') {
    setAddingState(chatId, null);
    const dateExpiration = text.replace(/^-$/, '').trim();
    const payload = {
      E: (state.E || '').replace(/^-$/, '').trim(),
      P: (state.P || '').replace(/^-$/, '').trim(),
      dateExpiration,
    };
    try {
      if (!state.subProductId) {
        return ctx.reply('Erreur : sous-produit requis. Recommence avec /addproduit.');
      }
      const product = await addProductFromSubProduct(state.categoryId, state.subProductId, payload);
      console.log(`[${logHorodatage()}] Produit ajouté : ${product.titre} — ${product.prix} FCFA, stock ${product.stock}`);
      return ctx.reply(`Produit ajouté : ${product.titre} — ${product.prix} FCFA (stock ${product.stock}). E/P/date enregistrés.`);
    } catch (e) {
      console.error('Erreur ajout produit:', e.message);
      return ctx.reply('Erreur : ' + (e.message || 'catégorie/sous-produit introuvable'));
    }
  }
});

// Éditer le message (texte ou légende si photo) après action Livré/Annuler
async function editOrderMessage(ctx, suffix) {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  const content = (msg.caption ?? msg.text ?? '') + suffix;
  const chatId = ctx.chat.id;
  const messageId = msg.message_id;
  if (msg.caption !== undefined) {
    await ctx.telegram.editMessageCaption(chatId, messageId, null, content);
  } else {
    await ctx.telegram.editMessageText(chatId, messageId, null, content);
  }
}

// Callbacks Livré / Annuler
bot.action(/^livree_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Non autorisé.');
  const orderId = ctx.match[1];
  const order = await getOrderById(orderId);
  if (!order) return ctx.answerCbQuery('Commande introuvable.');
  // Ne pas renvoyer le compte si déjà livrée (double clic ou rappel)
  if (order.status === STATUS.LIVREE) {
    await ctx.answerCbQuery('Déjà livrée.');
    return;
  }
  await updateOrderStatus(orderId, STATUS.LIVREE);
  console.log(`[${logHorodatage()}] Commande ${orderId} → livrée (client notifié)`);
  await ctx.answerCbQuery('Marquée livrée.');
  try {
    await editOrderMessage(ctx, '\n✅ Livrée');
  } catch (e) {
    console.error('Erreur édition message livrée:', e.message);
  }
  const qte = order.produit?.quantite ?? 1;
  const detail = qte > 1 ? `${order.produit?.titre} x${qte}` : order.produit?.titre;
  let livraisonMsg = msg.delivery.livree(order.refCommande, detail);
  const deliveryData = order.deliveryData;
  const product = !deliveryData && order.produit?.id ? await getProductById(order.produit.id) : null;
  const blockData = deliveryData || (product && (product.E || product.P || product.dateExpiration) ? product : null);
  if (blockData && (blockData.E || blockData.P || blockData.dateExpiration)) {
    const block = ['E: ' + (blockData.E || '-'), 'P: ' + (blockData.P || '-'), 'Date d\'expiration : ' + (blockData.dateExpiration || '-')].join('\n');
    const blocks = Array(qte).fill(block).join('\n\n');
    livraisonMsg += '\n\n' + blocks;
  }
  try {
    await ctx.telegram.sendMessage(order.userId, livraisonMsg);
  } catch (e) {
    console.error('Erreur envoi livraison au client:', e.message);
  }
});

bot.action(/^annulee_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Non autorisé.');
  const orderId = ctx.match[1];
  const order = await getOrderById(orderId);
  if (!order) return ctx.answerCbQuery('Commande introuvable.');
  // Remettre le stock seulement si la commande avait été confirmée (reçu reçu) → on avait déduit
  const qte = order.produit?.quantite ?? 1;
  if (order.status === STATUS.CONFIRMEE && order.produit?.id && qte > 0) {
    await incrementStock(order.produit.id, qte);
  }
  await updateOrderStatus(orderId, STATUS.ANNULEE);
  console.log(`[${logHorodatage()}] Commande ${orderId} → annulée par admin${order.status === STATUS.CONFIRMEE ? ` (stock remis +${qte})` : ''} — client notifié`);
  await ctx.answerCbQuery('Annulée.');
  try {
    await editOrderMessage(ctx, '\n❌ Annulée');
  } catch (e) {
    console.error('Erreur édition message annulée:', e.message);
  }
  try {
    await ctx.telegram.sendMessage(order.userId, msg.delivery.annulee(order.refCommande, order.produit?.titre || ''));
  } catch (e) {
    console.error('Erreur envoi annulation au client:', e.message);
  }
});

// Vérifier que la base Firestore existe au démarrage, puis lancer le bot
async function start() {
  console.log('');
  console.log('  Démarrage...');
  try {
    await getDb().collection('produits').limit(1).get();
    console.log('  Firestore OK');
  } catch (e) {
    if (e.code === 5 || (e.message && e.message.includes('NOT_FOUND'))) {
      console.error('\n❌ La base Firestore n\'existe pas encore.');
      console.error('   Crée-la : https://console.firebase.google.com');
      console.error('   → Ton projet → Firestore Database → "Créer une base de données"');
      console.error('   → Choisir une région (ex. europe-west1) → Activer.\n');
      process.exit(1);
    }
    throw e;
  }
  // Démarrer le backoffice tout de suite (avant le bot) pour qu'il soit dispo même si le bot bloque
  const backoffice = require('./backoffice');
  await (backoffice.startBackoffice({ fromBot: true }) || Promise.resolve());
  const backofficePort = Number(process.env.PORT) || Number(process.env.BACKOFFICE_PORT) || 3000;
  if (process.env.BACKOFFICE_PASSWORD) {
    console.log('  Backoffice : http://localhost:' + backofficePort + '/admin');
  }
  console.log('  Lancement du bot Telegram...');
  const launchOpts = { dropPendingUpdates: true };
  const maxLaunchAttempts = 5;
  const launchDelayMs = 8000;
  for (let attempt = 1; attempt <= maxLaunchAttempts; attempt++) {
    try {
      await bot.launch(launchOpts);
      break;
    } catch (e) {
      const is409 = e.response?.error_code === 409 || (e.message && e.message.includes('409'));
      if (is409 && attempt < maxLaunchAttempts) {
        console.log('  Conflit 409 (autre instance en cours). Nouvelle tentative dans ' + launchDelayMs / 1000 + ' s...');
        await new Promise((r) => setTimeout(r, launchDelayMs));
      } else {
        throw e;
      }
    }
  }
  backoffice.setBot(bot);
  await runPaymentTimeoutRecovery(bot);
  console.log('');
  console.log('  Bot start');
  console.log('  Arrêt : Ctrl+C');
  console.log('');
}
if (require.main === module) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

module.exports = { bot };
