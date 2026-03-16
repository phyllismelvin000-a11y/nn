require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const { initFirebase, getDb } = require('./firebase');
const { getActiveProducts, getActiveProductsByCategory, getProductById, addProduct, addProductFromCategory, addProductFromSubProduct, reserveCompteForOrder, decrementStock, incrementStock } = require('./catalogue');
const { getCategories, getSubProducts } = require('./categories');
const { updateOrderDeliveryData, updateOrderWaveTransactionId, findOrderByWaveTransactionId } = require('./orders');
const {
  createOrder,
  getLastPendingOrderByUser,
  getLastOrderByUser,
  getOrdersByUser,
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
const { checkAndSendReplenishmentAlert, getAllUserIdsToNotify } = require('./lib/stockAlert');
const { verifyTransactionIdInWave, isConfigured: isWaveConfigured } = require('./lib/waveGraphql');
const msg = require('./lib/messages');

/** Image pour montrer où trouver l'ID de transaction dans l'app Wave (flèche orange) */
const WAVE_ID_GUIDE_IMAGE_PATH = path.join(__dirname, 'assets', 'wave-id-transaction.png');
function hasWaveIdGuideImage() {
  try {
    return fs.existsSync(WAVE_ID_GUIDE_IMAGE_PATH);
  } catch {
    return false;
  }
}
function sendPhotoOrText(ctx, text, extra = {}) {
  const opts = { parse_mode: 'HTML', ...extra };
  if (hasWaveIdGuideImage()) {
    return ctx.replyWithPhoto({ source: fs.createReadStream(WAVE_ID_GUIDE_IMAGE_PATH) }, { ...opts, caption: text });
  }
  return ctx.reply(text, opts);
}

const announcementState = { step: null, text: null };

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = getAdminChatId();

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN manquant dans .env');
  process.exit(1);
}

initFirebase();
const bot = new Telegraf(BOT_TOKEN);

// Mode maintenance : seuls l'admin et les utilisateurs dans ALLOWED_USER_IDS peuvent utiliser le bot
const MAINTENANCE_MODE = /^(true|1|yes)$/i.test((process.env.MAINTENANCE_MODE || '').trim());
bot.use((ctx, next) => {
  if (!MAINTENANCE_MODE) return next();
  const userId = ctx.from?.id;
  if (userId == null) return next();
  if (isAdmin(ctx)) return next();
  if (ALLOWED_USER_IDS.has(String(userId))) return next();
  const maintenanceMsg = msg.client.maintenance;
  if (ctx.callbackQuery) {
    ctx.answerCbQuery(maintenanceMsg).catch(() => {});
  }
  return ctx.reply(maintenanceMsg).then(() => {}).catch(() => {});
});

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
  // Callback cliqué il y a trop longtemps : Telegram n'accepte plus la réponse (timeout ~30 s). Ignorer sans faire planter le bot.
  const isQueryTooOld =
    (err.message && (err.message.includes('query is too old') || err.message.includes('query ID is invalid'))) ||
    (err.response?.description && (err.response.description.includes('query is too old') || err.response.description.includes('query ID is invalid')));
  if (isQueryTooOld) {
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

// Utilisateurs autorisés sans numéro ivoirien (ex. 2e compte) — variable d'env ALLOWED_USER_IDS=123,456
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

async function isUserAllowed(ctx) {
  if (isAdmin(ctx)) return true;
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (ALLOWED_USER_IDS.has(String(userId))) return true;
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
    [Markup.button.callback('📜 Historique des paiements', 'client_historique')],
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
    [Markup.button.callback('📋 Comptes livrés (qui a reçu quoi)', 'admin_livraisons')],
  ];
  if (backofficeUrl.startsWith('https://')) {
    rows.push([Markup.button.url('🔗 Backoffice', backofficeUrl)]);
  }
  rows.push([Markup.button.callback('📦 Stock / comptes disponibles', 'admin_stock')]);
  rows.push([Markup.button.callback('👥 Voir utilisateurs', 'admin_users')]);
  rows.push([Markup.button.callback('📢 Créer une annonce', 'admin_annonce')]);
  const keyboard = Markup.inlineKeyboard(rows);
  return { text, keyboard };
}

async function showMenu(ctx) {
  ctx.sendChatAction('typing').catch(() => {});
  if (isAdmin(ctx)) {
    const { text, keyboard } = getAdminMenuContent();
    await ctx.replyWithHTML(text, keyboard);
    return ctx.reply('📱 Accès rapide :', mainMenuKeyboard);
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
    await ctx.replyWithHTML(msg.client.welcomeAdmin + '\n\n' + text, keyboard);
    await ctx.reply('📱 Accès rapide :', mainMenuKeyboard);
    return;
  }
  if (!(await isUserAllowed(ctx))) {
    return ctx.reply(msg.client.sharePhone, contactRequestKeyboard);
  }
  return ctx.reply(msg.client.welcome, mainMenuKeyboard);
});

// Partage du contact : vérification +225 ou utilisateur dans ALLOWED_USER_IDS
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
  const isAllowedException = ALLOWED_USER_IDS.has(String(from.id));
  const firstName = from.first_name || '';
  const username = from.username || '';
  if (isIvorian || isAllowedException) {
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

// ——— Annonce admin : en attente du texte
bot.use((ctx, next) => {
  if (ctx.message?.text && isAdmin(ctx) && announcementState.step === 'awaiting_text') {
    announcementState.text = ctx.message.text;
    announcementState.step = 'awaiting_confirm';
    const raw = ctx.message.text.slice(0, 300) + (ctx.message.text.length > 300 ? '…' : '');
    const preview = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return ctx.reply(
      `📢 <b>Annonce à envoyer à tous les utilisateurs</b>\n\n<pre>${preview}</pre>\n\nConfirmer l'envoi ?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Envoyer l\'annonce', 'annonce_confirm')],
          [Markup.button.callback('❌ Annuler', 'annonce_cancel')],
        ]),
      }
    );
  }
  return next();
});

bot.command('annonce', (ctx) => {
  if (!isAdmin(ctx)) return;
  announcementState.step = 'awaiting_text';
  announcementState.text = null;
  return ctx.reply('📢 Envoyez le texte de l\'annonce (un seul message). Elle sera diffusée à tous les utilisateurs du bot.');
});

bot.action('admin_annonce', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  announcementState.step = 'awaiting_text';
  announcementState.text = null;
  return ctx.reply('📢 Envoyez le texte de l\'annonce (un seul message). Elle sera diffusée à tous les utilisateurs du bot.');
});

bot.action('annonce_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  if (announcementState.step !== 'awaiting_confirm' || !announcementState.text) {
    announcementState.step = null;
    announcementState.text = null;
    return ctx.reply('Annonce annulée ou expirée.');
  }
  const text = announcementState.text;
  announcementState.step = null;
  announcementState.text = null;
  const userIds = await getAllUserIdsToNotify();
  let sent = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      await ctx.telegram.sendMessage(userId, text);
      sent++;
    } catch (e) {
      failed++;
    }
  }
  await ctx.reply(`✅ Annonce envoyée à <b>${sent}</b> utilisateur(s)${failed ? ` (${failed} échec(s))` : ''}.`, { parse_mode: 'HTML' });
});

bot.action('annonce_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  const wasPending = announcementState.step != null;
  announcementState.step = null;
  announcementState.text = null;
  if (!wasPending) return;
  await ctx.reply('Annonce annulée.');
  const { text, keyboard } = getAdminMenuContent();
  await ctx.replyWithHTML(text, keyboard);
  await ctx.reply('📱 Accès rapide :', mainMenuKeyboard);
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

bot.action('client_historique', async (ctx) => {
  await ctx.answerCbQuery();
  if (isAdmin(ctx)) return ctx.reply(msg.client.adminNoOrderHereShort);
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply(msg.errors.generic);
  const orders = await getOrdersByUser(userId, { limit: 20 });
  if (!orders.length) return ctx.replyWithHTML(msg.client.paymentHistoryNone);
  const statusLabels = msg.client.myOrderStatus;
  const lines = orders.map(o => {
    const ref = o.refCommande || o.id.slice(0, 8);
    const created = o.createdAt;
    const dateStr = created && typeof created.toMillis === 'function'
      ? new Date(created.toMillis()).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : (created ? new Date(created).toLocaleDateString('fr-FR') : '—');
    const p = o.produit || {};
    const titre = p.titre || 'Commande';
    const qte = p.quantite ?? 1;
    const duree = p.dureeMois != null ? ` ${p.dureeMois} mois` : '';
    const productLabel = qte > 1 ? `${titre} x${qte}${duree}` : `${titre}${duree}`;
    const total = p.total ?? p.prix ?? 0;
    const statusLabel = statusLabels[o.status] || o.status;
    return msg.client.paymentHistoryLine(ref, dateStr, productLabel, total, statusLabel);
  });
  const header = `${msg.client.paymentHistoryTitle}\n\n`;
  const body = lines.join('\n');
  const text = header + body;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour au menu', 'menu_back')]]);
  if (text.length > 4000) {
    const chunk = header + lines.slice(0, 15).join('\n') + '\n\n… (20 dernières commandes max)';
    return ctx.replyWithHTML(chunk, keyboard);
  }
  return ctx.replyWithHTML(text, keyboard);
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

bot.action('admin_livraisons', async (ctx) => {
  await ctx.answerCbQuery();
  const livrees = await getOrders({ limit: 50, status: STATUS.LIVREE });
  if (!livrees.length) {
    return ctx.reply('Aucune livraison. Voir « Traitées (livrées) » pour la liste simple.');
  }
  const header = '📋 <b>Comptes livrés (qui a reçu quel compte)</b>\n\n';
  const lines = livrees.map(o => {
    const d = o.deliveryData || {};
    const client = `@${o.username || o.userId}`;
    const produit = o.produit?.titre || '-';
    const e = d.E ? `E: ${d.E}` : '';
    const p = d.P ? `P: ${d.P}` : '';
    const exp = d.dateExpiration ? `Exp: ${d.dateExpiration}` : '';
    const compte = [e, p, exp].filter(Boolean).join(' | ') || '—';
    return `• ${o.refCommande || o.id} | ${client} | ${produit}\n  ${compte}`;
  });
  let text = header + lines.join('\n\n');
  if (text.length > 4000) {
    const chunks = [header];
    for (const line of lines) {
      if (chunks[chunks.length - 1].length + line.length + 2 > 4000) chunks.push(line);
      else chunks[chunks.length - 1] += '\n\n' + line;
    }
    for (const chunk of chunks) await ctx.replyWithHTML(chunk);
  } else {
    await ctx.replyWithHTML(text);
  }
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
    [Markup.button.callback('🔒 VPN', 'cat_vpn')],
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
  const orderText = msg.catalogue.orderCreated(order.refCommande, detail) + `\n${link}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('Payer via Wave', link)],
    [Markup.button.callback('❌ Annuler la commande', `cancel_order_${order.id}`)],
  ]);
  await sendPhotoOrText(ctx, orderText + '\n\n📍 <i>Voir l\'image ci-dessous pour savoir où trouver l\'ID de transaction dans l\'app Wave.</i>', keyboard);
}

bot.action('menu_catalogue', async (ctx) => {
  await ctx.answerCbQuery();
  if (isAdmin(ctx)) {
    const [netflix, onoff, vpn] = await Promise.all([
      getActiveProductsByCategory('netflix'),
      getActiveProductsByCategory('onoff'),
      getActiveProductsByCategory('vpn'),
    ]);
    const lines = [msg.admin.stockTitle, ''];
    netflix.forEach(p => { lines.push(`• ${p.titre || 'Netflix'} : <b>${p.stock ?? 0}</b> en stock`); });
    onoff.forEach(p => { lines.push(`• ${p.titre || 'Onoff'} : <b>${p.stock ?? 0}</b> en stock`); });
    vpn.forEach(p => { lines.push(`• 🔒 ${p.titre || 'VPN'} : illimité`); });
    if (netflix.length === 0 && onoff.length === 0 && vpn.length === 0) lines.push(msg.admin.noProduct);
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
function getNetflixCaption(stock) {
  const n = Math.max(0, stock ?? 0);
  return `📄 Catégorie: Netflix — 📦 ${n} en stock

- - - - - - - - - -

➡ Cliquez sur le bouton ci-dessous pour choisir la durée de votre abonnement (nombre de mois).`;
}

bot.action('cat_netflix', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.sendChatAction('typing').catch(() => {});
  const products = await getActiveProductsByCategory('netflix');
  const product = products[0];
  if (!product) {
    return ctx.editMessageText(msg.catalogue.noNetflix, getCategoryChoiceKeyboard());
  }
  const stock = Math.max(0, product.stock ?? 0);
  const netflixImg = process.env.NETFLIX_CAT_IMAGE_URL;
  const keyboard = Markup.inlineKeyboard([
    NETFLIX_MOIS.map(m => Markup.button.callback(`${m} mois`, `netflix_${m}`)),
    [Markup.button.callback('◀️ Retour aux catégories', 'cat_back')],
  ]);
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  const caption = getNetflixCaption(stock);
  if (netflixImg && netflixImg.startsWith('http')) {
    await ctx.replyWithPhoto(netflixImg, { caption, ...keyboard });
  } else {
    await ctx.reply(caption, keyboard);
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
function getOnoffCaption(premiumStock, startStock) {
  const p = Math.max(0, premiumStock ?? 0);
  const s = Math.max(0, startStock ?? 0);
  return `📄 Catégorie: Onoff — 📦 Premium : ${p} | Start : ${s} en stock

- - - - - - - - - -

➡ Cliquez sur le bouton ci-dessous pour choisir le type d'abonnement (Premium ou Start).`;
}

bot.action('cat_onoff', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.sendChatAction('typing').catch(() => {});
  const products = await getActiveProductsByCategory('onoff');
  if (!products.length) {
    return ctx.editMessageText(msg.catalogue.noOnoff, getCategoryChoiceKeyboard());
  }
  const onoffPremium = products.find(p => (p.titre || '').toLowerCase().includes('premium'));
  const onoffStart = products.find(p => (p.titre || '').toLowerCase().includes('start'));
  const premiumStock = onoffPremium ? (onoffPremium.stock ?? 0) : 0;
  const startStock = onoffStart ? (onoffStart.stock ?? 0) : 0;
  const onoffImg = process.env.ONOFF_CAT_IMAGE_URL;
  const keyboard = getOnoffTypeKeyboard();
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  const caption = getOnoffCaption(premiumStock, startStock);
  if (onoffImg && onoffImg.startsWith('http')) {
    await ctx.replyWithPhoto(onoffImg, { caption, ...keyboard });
  } else {
    await ctx.reply(caption, keyboard);
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
  const products = await getActiveProductsByCategory('onoff');
  const product = products.find(p => (p.titre || '').toLowerCase().includes('premium'));
  const stock = Math.max(0, product?.stock ?? 0);
  const text = `Choisissez la durée (Onoff Premium — 3000 FCFA/mois) — 📦 ${stock} en stock :`;
  const keyboard = Markup.inlineKeyboard([
    ONOFF_MOIS.map(m => Markup.button.callback(`${m} mois`, `onoff_premium_${m}`)),
    [Markup.button.callback('◀️ Retour', 'onoff_back')],
  ]);
  return editCaptionOrText(ctx, text, keyboard);
});

bot.action('onoff_start', async (ctx) => {
  await ctx.answerCbQuery();
  const products = await getActiveProductsByCategory('onoff');
  const product = products.find(p => (p.titre || '').toLowerCase().includes('start'));
  const stock = Math.max(0, product?.stock ?? 0);
  const text = `Choisissez la durée (Onoff Start — 2500 FCFA/mois) — 📦 ${stock} en stock :`;
  const keyboard = Markup.inlineKeyboard([
    ONOFF_MOIS.map(m => Markup.button.callback(`${m} mois`, `onoff_start_${m}`)),
    [Markup.button.callback('◀️ Retour', 'onoff_back')],
  ]);
  return editCaptionOrText(ctx, text, keyboard);
});

bot.action('onoff_back', async (ctx) => {
  await ctx.answerCbQuery();
  const products = await getActiveProductsByCategory('onoff');
  const onoffPremium = products.find(p => (p.titre || '').toLowerCase().includes('premium'));
  const onoffStart = products.find(p => (p.titre || '').toLowerCase().includes('start'));
  const premiumStock = onoffPremium ? (onoffPremium.stock ?? 0) : 0;
  const startStock = onoffStart ? (onoffStart.stock ?? 0) : 0;
  const caption = getOnoffCaption(premiumStock, startStock);
  return editCaptionOrText(ctx, caption, getOnoffTypeKeyboard());
});

// ——— VPN (produits sans limite de stock : admin envoie E, P, date après paiement) ———
bot.action('cat_vpn', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.sendChatAction('typing').catch(() => {});
  const products = await getActiveProductsByCategory('vpn');
  if (!products.length) {
    return ctx.editMessageText(msg.catalogue.noVpn, getCategoryChoiceKeyboard());
  }
  try {
    await ctx.deleteMessage();
  } catch (_) {}
  const rows = products.map(p => [Markup.button.callback(`${p.titre || 'VPN'} — ${p.prix || 0} FCFA`, `vpn_cmd_${p.id}`)]);
  rows.push([Markup.button.callback('◀️ Retour aux catégories', 'cat_back')]);
  const keyboard = Markup.inlineKeyboard(rows);
  await ctx.reply('🔒 <b>VPN</b> — Choisissez un produit (livraison des identifiants après paiement) :', { parse_mode: 'HTML', ...keyboard });
});

const VPN_MOIS = [1, 2, 3, 4, 5, 6];
const VPN_MAX_QTY = 10;

bot.action(/^vpn_cmd_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  await ctx.answerCbQuery();
  const product = await getProductById(productId);
  if (!product || (product.categorie || '').toLowerCase() !== 'vpn') return ctx.answerCbQuery(msg.catalogue.indisponible);
  const prix = product.prix || 0;
  const row = VPN_MOIS.map(m => Markup.button.callback(`${m} mois`, `vpn_mois_${productId}_${m}`));
  const keyboard = Markup.inlineKeyboard([
    row.slice(0, 3),
    row.slice(3, 6),
    [Markup.button.callback('◀️ Retour', 'cat_vpn')],
  ]);
  await ctx.reply(`🔒 <b>${product.titre || 'VPN'}</b> — ${prix} FCFA/mois\n\nChoisissez la durée (1 à 6 mois) :`, { parse_mode: 'HTML', ...keyboard });
});

bot.action(/^vpn_mois_(.+)_(\d+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const months = Math.max(1, Math.min(6, parseInt(ctx.match[2], 10)));
  await ctx.answerCbQuery();
  const product = await getProductById(productId);
  if (!product || (product.categorie || '').toLowerCase() !== 'vpn') return ctx.answerCbQuery(msg.catalogue.indisponible);
  const row = [];
  for (let q = 1; q <= VPN_MAX_QTY; q++) row.push(Markup.button.callback(String(q), `vpn_qty_${productId}_${months}_${q}`));
  const keyboard = Markup.inlineKeyboard([
    row,
    [Markup.button.callback('◀️ Retour', `vpn_cmd_${productId}`)],
  ]);
  const prix = product.prix || 0;
  const totalMois = prix * months;
  await ctx.reply(`🔒 <b>${product.titre || 'VPN'}</b> — ${prix} FCFA/mois × ${months} mois = <b>${totalMois} FCFA</b>\n\nChoisissez la quantité (1 à ${VPN_MAX_QTY}) :`, { parse_mode: 'HTML', ...keyboard });
});

bot.action(/^vpn_qty_(.+)_(\d+)_(\d+)$/, async (ctx) => {
  if (isAdmin(ctx)) {
    await ctx.answerCbQuery();
    return ctx.reply(msg.client.adminNoOrderHereShort);
  }
  const productId = ctx.match[1];
  const months = Math.max(1, Math.min(6, parseInt(ctx.match[2], 10)));
  const quantity = Math.max(1, Math.min(VPN_MAX_QTY, parseInt(ctx.match[3], 10)));
  const product = await getProductById(productId);
  if (!product || (product.categorie || '').toLowerCase() !== 'vpn') return ctx.answerCbQuery(msg.catalogue.indisponible);
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
      dureeMois: months,
      categorie: 'vpn',
    },
  });
  const total = order.produit.total;
  await ctx.answerCbQuery();
  schedulePaymentReminderAndCancel(bot, order);
  const link = buildWaveLink(total, order.refCommande);
  const detail = `${product.titre} — ${months} mois × ${quantity} = <b>${total} FCFA</b>`;
  console.log(`[${logHorodatage()}] Commande VPN créée ref=${order.refCommande} par ${username} (${product.titre} ${months} mois x${quantity} = ${total} FCFA)`);
  const orderText = msg.catalogue.orderCreated(order.refCommande, detail) + `\n${link}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('Payer via Wave', link)],
    [Markup.button.callback('❌ Annuler la commande', `cancel_order_${order.id}`)],
  ]);
  await sendPhotoOrText(ctx, orderText + '\n\n📍 <i>Voir l\'image ci-dessous pour savoir où trouver l\'ID de transaction dans l\'app Wave.</i>', keyboard);
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
  const text = 'ℹ️ <b>Aide</b>\n\nUtilise le catalogue pour voir les produits et commander. Après paiement Wave, envoie l\'ID de transaction (ex. T_5EPGALU...) ici.';
  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour au menu', 'menu_back')]]),
  });
  const caption = '📍 <b>Où trouver l\'ID de transaction ?</b>\nDans l\'app Wave : détail du paiement → <b>ID de transaction</b> (voir la flèche sur l\'image).';
  if (hasWaveIdGuideImage()) {
    await ctx.replyWithPhoto({ source: fs.createReadStream(WAVE_ID_GUIDE_IMAGE_PATH) }, { caption, parse_mode: 'HTML' });
  }
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
  ctx.sendChatAction('typing').catch(() => {});
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
  const [netflix, onoff, vpn] = await Promise.all([
    getActiveProductsByCategory('netflix'),
    getActiveProductsByCategory('onoff'),
    getActiveProductsByCategory('vpn'),
  ]);
  const netflixStock = netflix.length ? (netflix[0].stock ?? 0) : 0;
  const onoffPremium = onoff.find(p => (p.titre || '').toLowerCase().includes('premium'));
  const onoffStart = onoff.find(p => (p.titre || '').toLowerCase().includes('start'));
  const onoffPremiumStock = onoffPremium ? (onoffPremium.stock ?? 0) : 0;
  const onoffStartStock = onoffStart ? (onoffStart.stock ?? 0) : 0;
  const netflixImg = process.env.NETFLIX_CAT_IMAGE_URL;
  const onoffImg = process.env.ONOFF_CAT_IMAGE_URL;
  if (netflixImg && onoffImg && netflixImg.startsWith('http') && onoffImg.startsWith('http')) {
    await ctx.replyWithPhoto(netflixImg, {
      caption: `Netflix — 📦 ${netflixStock} en stock`,
      ...Markup.inlineKeyboard([[Markup.button.callback('Voir les produits Netflix', 'cat_netflix')]]),
    });
    await ctx.replyWithPhoto(onoffImg, {
      caption: `Onoff — 📦 Premium : ${onoffPremiumStock} | Start : ${onoffStartStock} en stock`,
      ...Markup.inlineKeyboard([[Markup.button.callback('Voir les produits Onoff', 'cat_onoff')]]),
    });
  }
  const stockLines = [
    '📦 <b>Stock</b>',
    `• Netflix : ${netflixStock} en stock`,
    `• Onoff Premium : ${onoffPremiumStock} en stock`,
    `• Onoff Starter : ${onoffStartStock} en stock`,
    '• 🔒 VPN : illimité',
  ].join('\n');
  return ctx.reply(`Choisissez une catégorie :\n\n${stockLines}`, { parse_mode: 'HTML', ...getCategoryChoiceKeyboard() });
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
  const orderText = msg.catalogue.orderCreated(order.refCommande, detailOnoff) + `\n${link}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('Payer via Wave', link)],
    [Markup.button.callback('❌ Annuler la commande', `cancel_order_${order.id}`)],
  ]);
  await sendPhotoOrText(ctx, orderText + '\n\n📍 <i>Voir l\'image ci-dessous pour savoir où trouver l\'ID de transaction dans l\'app Wave.</i>', keyboard);
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

const WAVE_TRANSACTION_ID_REGEX = /^T_[A-Za-z0-9]+$/;
let lastWaveExpiryNotify = 0;
const WAVE_EXPIRY_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // 1 h
async function notifyAdminWaveTokenExpired() {
  const now = Date.now();
  if (now - lastWaveExpiryNotify < WAVE_EXPIRY_NOTIFY_COOLDOWN_MS) return;
  lastWaveExpiryNotify = now;
  try {
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      '⚠️ <b>Wave Business : token expiré</b>\n\nLa vérification des paiements est temporairement désactivée.\n\nSur ton PC : lance <code>node scripts/wave-login.js</code>, récupère le nouveau <code>WAVE_BUSINESS_TOKEN</code>, puis mets à jour la variable d\'environnement sur ton serveur (ex. Railway → Variables).',
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Erreur envoi alerte admin (token Wave expiré):', e.message);
  }
}

async function confirmPendingOrderWithReceipt(ctx, order, { fileId = null, waveTransactionId = null } = {}) {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name || 'Client';
  const product = order.produit?.id ? await getProductById(order.produit.id) : null;
  const qteToDeduct = order.produit?.quantite ?? 1;
  const isVpn = (order.produit?.categorie || '').toLowerCase() === 'vpn';

  if (isVpn) {
    // VPN : pas de stock, pas de compte à réserver ; l'admin enverra E, P, date plus tard
  } else if (product?.catalogueId != null) {
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
  if (waveTransactionId) await updateOrderWaveTransactionId(order.id, waveTransactionId);

  console.log(`[${logHorodatage()}] Commande ${order.refCommande} confirmée (reçu)${isVpn ? ' — VPN (en attente E/P)' : product?.catalogueId != null ? ' — compte réservé' : ` → stock -${qteToDeduct}`} → admin notifié`);

  try {
    await ctx.reply(msg.client.paymentReceived(order.refCommande));
  } catch (e) {
    console.error('Erreur envoi confirmation client:', e.message);
  }

  const qte = order.produit?.quantite ?? 1;
  const total = order.produit?.total ?? order.produit?.prix;
  const produitLine = qte > 1 ? `${order.produit.titre} x${qte} = ${total} FCFA` : `${order.produit.titre} — ${total} FCFA`;
  let adminText = `📦 Nouvelle commande confirmée\nRef: ${order.refCommande}\nClient: ${username} (${userId})\nProduit: ${produitLine}`;
  if (waveTransactionId) adminText += `\n\n🆔 ID transaction Wave: <code>${waveTransactionId}</code>`;
  const adminKeyboard = isVpn
    ? Markup.inlineKeyboard([
        [Markup.button.callback('🔐 Envoyer identifiants VPN', `vpn_creds_${order.id}`)],
        [Markup.button.callback('Annuler', `annulee_${order.id}`)],
      ])
    : Markup.inlineKeyboard([
        [Markup.button.callback('Livré', `livree_${order.id}`), Markup.button.callback('Annuler', `annulee_${order.id}`)],
      ]);
  if (isVpn) adminText += '\n\n🔐 Envoyez E, P et date d\'expiration au client via le bouton ci-dessous.';
  try {
    if (fileId) {
      await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, fileId, {
        caption: adminText + '\n\n🖼 Reçu Wave (capture)',
        parse_mode: 'HTML',
        ...adminKeyboard,
      });
    } else {
      await ctx.telegram.sendMessage(ADMIN_CHAT_ID, adminText, { parse_mode: 'HTML', ...adminKeyboard });
    }
  } catch (e) {
    console.error('Erreur envoi notification admin:', e.message);
  }
}

// ID de transaction Wave (ex. T_5EPGALU...) : vérifier sur Wave Business puis confirmer la commande
bot.on('text', async (ctx, next) => {
  const text = ctx.message?.text?.trim();
  if (!text || !WAVE_TRANSACTION_ID_REGEX.test(text)) return next();
  if (isAdmin(ctx)) return next();
  const order = await getLastPendingOrderByUser(ctx.from.id);
  if (!order) return next();

  const ref = order.refCommande || order.id;
  const waveConfigured = isWaveConfigured();
  console.log(`[Wave] Ref ${ref}: ID reçu ${text}. Wave configuré: ${waveConfigured}`);

  if (waveConfigured) {
    const verification = await verifyTransactionIdInWave(text, order);
    console.log(`[Wave] Ref ${ref}: vérification API → valid=${verification.valid}, message=${verification.message}`);
    if (!verification.valid) {
      await ctx.reply('❌ ' + verification.message);
      if (/session expirée|expirée/i.test(verification.message)) {
        notifyAdminWaveTokenExpired();
      }
      return;
    }
    const { alreadyUsed } = await findOrderByWaveTransactionId(text, order.id);
    if (alreadyUsed) {
      await ctx.reply('❌ Cette transaction a déjà été utilisée pour une autre commande. Utilisez l\'ID du paiement de cette commande.');
      return;
    }
  } else {
    console.log(`[Wave] Ref ${ref}: confirmation SANS vérification (WAVE_BUSINESS_TOKEN ou WAVE_BUSINESS_WALLET_ID manquant dans .env)`);
  }

  await confirmPendingOrderWithReceipt(ctx, order, { waveTransactionId: text });
});

// Photo (capture) : encore acceptée pour confirmer la commande (optionnel)
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const order = await getLastPendingOrderByUser(userId);
  if (!order) return ctx.reply(msg.client.noPendingOrder);
  const fileId = ctx.message.photo?.at(-1)?.file_id;
  await confirmPendingOrderWithReceipt(ctx, order, { fileId });
});

// ——— Admin ———

// État pour envoi des identifiants VPN (orderId en attente du message E/P/Expiration)
let vpnCredsOrderId = null;

bot.action(/^vpn_creds_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Non autorisé.');
  const orderId = ctx.match[1];
  const order = await getOrderById(orderId);
  if (!order) return ctx.answerCbQuery(msg.admin.orderNotFound);
  if (order.status !== STATUS.CONFIRMEE) return ctx.answerCbQuery('Commande déjà livrée ou annulée.');
  if ((order.produit?.categorie || '').toLowerCase() !== 'vpn') return ctx.answerCbQuery('Pas une commande VPN.');
  vpnCredsOrderId = orderId;
  await ctx.answerCbQuery();
  await ctx.reply(msg.admin.vpnSendCredentialsHint, { parse_mode: 'HTML' });
});

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
    const isVpn = (o.produit?.categorie || '').toLowerCase() === 'vpn';
    const text = `Ref: ${o.refCommande || o.id} | ${produitStr} FCFA | ${o.status} | @${o.username || o.userId}`;
    const keyboard = isVpn && o.status === STATUS.CONFIRMEE
      ? Markup.inlineKeyboard([[Markup.button.callback('🔐 Envoyer identifiants VPN', `vpn_creds_${o.id}`), Markup.button.callback('Annuler', `annulee_${o.id}`)]])
      : Markup.inlineKeyboard([[Markup.button.callback('Livré', `livree_${o.id}`), Markup.button.callback('Annuler', `annulee_${o.id}`)]]);
    await ctx.reply(text, keyboard);
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

// Texte : étapes E → P → date pour ajout produit par catégorie ; ou envoi identifiants VPN
bot.on('text', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const text = (ctx.message.text?.trim() ?? '').replace(/\r/g, '');
  if (vpnCredsOrderId) {
    const orderId = vpnCredsOrderId;
    vpnCredsOrderId = null;
    const eMatch = text.match(/E:\s*([^\n]+)/i);
    const pMatch = text.match(/P:\s*([^\n]+)/i);
    const expMatch = text.match(/Expiration:\s*([^\n]+)/i);
    const E = eMatch ? eMatch[1].trim() : '';
    const P = pMatch ? pMatch[1].trim() : '';
    const dateExpiration = expMatch ? expMatch[1].trim() : '';
    const order = await getOrderById(orderId);
    if (!order || order.status !== STATUS.CONFIRMEE) {
      return ctx.reply('Commande introuvable ou déjà traitée.');
    }
    await updateOrderDeliveryData(orderId, { E, P, dateExpiration });
    await updateOrderStatus(orderId, STATUS.LIVREE);
    const livraisonMsg = msg.delivery.vpnCredentials(order.refCommande || orderId, E, P, dateExpiration);
    try {
      await ctx.telegram.sendMessage(order.userId, livraisonMsg, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('Erreur envoi identifiants VPN au client:', e.message);
      await ctx.reply('Identifiants enregistrés mais envoi au client en échec (utilisateur bloqué ?).');
      return;
    }
    console.log(`[${logHorodatage()}] Commande ${order.refCommande} → identifiants VPN envoyés au client`);
    return ctx.reply(msg.admin.vpnCredentialsSent(order.refCommande || orderId));
  }
  if (ctx.message.text?.startsWith('/')) {
    setAddingState(ctx.chat?.id, null);
    return;
  }
  const chatId = ctx.chat?.id;
  const state = getAddingState(chatId);
  if (!state || state.step === 'category') return;
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
      checkAndSendReplenishmentAlert(bot, product.id, product.titre, product.stock).catch(e => console.error('Erreur alerte réassort:', e.message));
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
  if (order.status === STATUS.LIVREE) {
    await ctx.answerCbQuery('Déjà livrée.');
    return;
  }
  const isVpn = (order.produit?.categorie || '').toLowerCase() === 'vpn';
  if (isVpn && !order.deliveryData) {
    await ctx.answerCbQuery();
    return ctx.reply('Pour une commande VPN, utilisez le bouton « Envoyer identifiants VPN » pour envoyer E, P et date d\'expiration au client.');
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
        console.log('  → Assure-toi qu\'une seule instance tourne (arrête le bot en local ou l’autre déploiement qui utilise le même BOT_TOKEN).');
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
