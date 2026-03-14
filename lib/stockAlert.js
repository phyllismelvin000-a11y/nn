/**
 * Alerte réassort : quand le stock d'un produit catalogue atteint >= seuil (ex. 5)
 * après ajout de comptes, envoi d'un message à tous les utilisateurs du bot.
 * Cooldown 24h par produit pour éviter le spam.
 */
const { getDb } = require('../firebase');
const { getAvailableCount } = require('../comptes');
const { getUsers } = require('../users');
const { getDistinctOrderUserIds } = require('../orders');
const msg = require('./messages');

const ALERT_COLLECTION = 'stock_alerts';
const THRESHOLD = Math.max(0, parseInt(process.env.STOCK_ALERT_THRESHOLD, 10) || 5);
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h entre deux alertes pour un même produit (pas de spam)
const STOCK_ALERT_ENABLED = process.env.STOCK_ALERT_ENABLED !== 'false';

/**
 * Liste de tous les userId à notifier (utilisateurs enregistrés + ayant passé commande).
 */
async function getAllUserIdsToNotify() {
  const [fromUsers, fromOrders] = await Promise.all([
    getUsers({ limit: 3000 }).then(list => list.map(u => u.userId)),
    getDistinctOrderUserIds(3000),
  ]);
  const set = new Set([...fromUsers, ...fromOrders].filter(Boolean).map(String));
  return Array.from(set);
}

/**
 * Vérifie si on peut envoyer une alerte pour ce produit (cooldown 24h).
 */
async function shouldSendAlert(productId) {
  if (!STOCK_ALERT_ENABLED) return false;
  const db = getDb();
  const doc = await db.collection(ALERT_COLLECTION).doc(String(productId)).get();
  if (!doc.exists) return true;
  const lastSentAt = doc.data().lastSentAt?.toMillis?.() ?? 0;
  return Date.now() - lastSentAt >= COOLDOWN_MS;
}

/**
 * Enregistre qu'une alerte a été envoyée pour ce produit.
 */
async function markAlertSent(productId, productTitle) {
  const db = getDb();
  await db.collection(ALERT_COLLECTION).doc(String(productId)).set({
    productId: String(productId),
    productTitle: String(productTitle || ''),
    lastSentAt: new Date(),
  });
}

/**
 * Envoie le message d'alerte réassort à tous les utilisateurs (dans le bot).
 */
async function sendStockAlertToUsers(bot, productId, productTitle, currentStock) {
  const userIds = await getAllUserIdsToNotify();
  const text = msg.catalogue.stockAlertReplenishment(productTitle, currentStock);
  let sent = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      await bot.telegram.sendMessage(userId, text);
      sent++;
    } catch (e) {
      failed++;
      if (e.code !== 403 && !e.message?.includes('blocked')) {
        console.error('[stockAlert] Envoi à', userId, e.message);
      }
    }
  }
  if (sent > 0) {
    console.log(`[stockAlert] Réassort "${productTitle}" (${currentStock} dispo) → ${sent} utilisateur(s)${failed ? `, ${failed} échec(s)` : ''}`);
  }
}

/**
 * À appeler après ajout de comptes : si stock >= seuil et cooldown ok, envoie une alerte à tous (max 1 fois / 24h / produit).
 */
async function checkAndSendReplenishmentAlert(bot, productId, productTitle) {
  if (!STOCK_ALERT_ENABLED || !bot || !productId) return;
  const currentStock = await getAvailableCount(productId);
  if (currentStock < THRESHOLD) return;
  const ok = await shouldSendAlert(productId);
  if (!ok) return;
  await sendStockAlertToUsers(bot, productId, productTitle, currentStock);
  await markAlertSent(productId, productTitle);
}

module.exports = {
  checkAndSendReplenishmentAlert,
  getAllUserIdsToNotify,
  THRESHOLD,
  STOCK_ALERT_ENABLED,
};
