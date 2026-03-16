const path = require('path');
const fs = require('fs');
const { getOrderById, updateOrderStatus, getOrders, STATUS } = require('../orders');
const msg = require('./messages');

const WAVE_ID_GUIDE_IMAGE_PATH = path.join(__dirname, '..', 'assets', 'wave-id-transaction.png');
function hasWaveIdGuideImage() {
  try {
    return fs.existsSync(WAVE_ID_GUIDE_IMAGE_PATH);
  } catch {
    return false;
  }
}

const MIN_15_MS = 15 * 60 * 1000;
const MIN_20_MS = 20 * 60 * 1000;

function getCreatedAtMs(order) {
  const t = order.createdAt;
  if (!t) return 0;
  return typeof t.toMillis === 'function' ? t.toMillis() : (t._seconds ? t._seconds * 1000 : 0);
}

function logHorodatage() {
  const d = new Date();
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Planifie rappel à 15 min et annulation à 20 min pour une commande en attente.
 * @param {object} bot - Doit avoir bot.telegram.sendMessage(userId, text) et bot.telegram.sendPhoto(userId, photo, opts)
 * @param {object} order - Commande avec userId (Telegram: id numérique, WhatsApp: "wa_225...")
 */
function schedulePaymentReminderAndCancel(bot, order) {
  const orderId = order.id;
  const userId = String(order.userId);
  const refCommande = order.refCommande || orderId;
  const totalF = order.produit?.total ?? order.produit?.prix ?? 0;

  setTimeout(async () => {
    const o = await getOrderById(orderId);
    if (o && o.status === STATUS.EN_ATTENTE) {
      try {
        const reminderText = msg.client.paymentReminder(refCommande, totalF) + '\n\n📍 Voir l\'image dans le message de la commande pour savoir où trouver l\'ID de transaction dans l\'app Wave.';
        if (hasWaveIdGuideImage()) {
          await bot.telegram.sendPhoto(userId, { source: fs.createReadStream(WAVE_ID_GUIDE_IMAGE_PATH) }, { caption: reminderText });
        } else {
          await bot.telegram.sendMessage(userId, reminderText);
        }
      } catch (e) {
        console.error('Erreur envoi rappel paiement:', e.message);
      }
    }
  }, MIN_15_MS);

  setTimeout(async () => {
    const o = await getOrderById(orderId);
    if (o && o.status === STATUS.EN_ATTENTE) {
      await updateOrderStatus(orderId, STATUS.ANNULEE);
      try {
        await bot.telegram.sendMessage(userId, msg.client.paymentCancelled(refCommande));
      } catch (e) {
        console.error('Erreur envoi annulation:', e.message);
      }
      console.log(`[${logHorodatage()}] Commande ${refCommande} annulée (timeout paiement)`);
    }
  }, MIN_20_MS);
}

/**
 * Au redémarrage : replanifier timers pour les commandes encore en_attente.
 * @param {object} bot - Même interface que schedulePaymentReminderAndCancel
 * @param {{ userIdFilter?: (userId: string) => boolean }} opts - Si fourni, ne traiter que les commandes dont userIdFilter(order.userId) est true (ex: Telegram id => !id.startsWith('wa_'), WhatsApp id => id.startsWith('wa_'))
 */
async function runPaymentTimeoutRecovery(bot, opts = {}) {
  const pending = await getOrders({ limit: 500, status: STATUS.EN_ATTENTE });
  const userIdFilter = opts.userIdFilter || (() => true);
  const now = Date.now();
  for (const order of pending) {
    if (!userIdFilter(String(order.userId))) continue;
    const created = getCreatedAtMs(order);
    if (!created) continue;
    const elapsed = now - created;
    const orderId = order.id;
    const userId = order.userId;
    const refCommande = order.refCommande || orderId;

    if (elapsed >= MIN_20_MS) {
      const o = await getOrderById(orderId);
      if (o && o.status === STATUS.EN_ATTENTE) {
        await updateOrderStatus(orderId, STATUS.ANNULEE);
        try {
          await bot.telegram.sendMessage(userId, msg.client.paymentCancelled(refCommande));
        } catch (e) {
          console.error('Erreur envoi annulation (recovery):', e.message);
        }
        console.log(`[${logHorodatage()}] Commande ${refCommande} annulée (timeout paiement, recovery)`);
      }
      continue;
    }
    if (elapsed >= MIN_15_MS) {
      setTimeout(async () => {
        const o = await getOrderById(orderId);
        if (o && o.status === STATUS.EN_ATTENTE) {
          await updateOrderStatus(orderId, STATUS.ANNULEE);
          try {
            await bot.telegram.sendMessage(userId, msg.client.paymentCancelled(refCommande));
          } catch (e) {
            console.error('Erreur envoi annulation:', e.message);
          }
          console.log(`[${logHorodatage()}] Commande ${refCommande} annulée (timeout paiement)`);
        }
      }, MIN_20_MS - elapsed);
      continue;
    }
    const totalF = order.produit?.total ?? order.produit?.prix ?? 0;
    const tReminder = MIN_15_MS - elapsed;
    const tCancel = MIN_20_MS - elapsed;
    setTimeout(async () => {
      const o = await getOrderById(orderId);
      if (o && o.status === STATUS.EN_ATTENTE) {
        try {
          const reminderText = msg.client.paymentReminder(refCommande, totalF) + '\n\n📍 Voir l\'image dans le message de la commande pour savoir où trouver l\'ID de transaction dans l\'app Wave.';
          if (hasWaveIdGuideImage()) {
            await bot.telegram.sendPhoto(userId, { source: fs.createReadStream(WAVE_ID_GUIDE_IMAGE_PATH) }, { caption: reminderText });
          } else {
            await bot.telegram.sendMessage(userId, reminderText);
          }
        } catch (e) {
          console.error('Erreur envoi rappel paiement:', e.message);
        }
      }
    }, tReminder);
    setTimeout(async () => {
      const o = await getOrderById(orderId);
      if (o && o.status === STATUS.EN_ATTENTE) {
        await updateOrderStatus(orderId, STATUS.ANNULEE);
        try {
          await bot.telegram.sendMessage(userId, msg.client.paymentCancelled(refCommande));
        } catch (e) {
          console.error('Erreur envoi annulation:', e.message);
        }
        console.log(`[${logHorodatage()}] Commande ${refCommande} annulée (timeout paiement)`);
      }
    }, tCancel);
  }
  if (pending.length > 0) {
    console.log(`  ${pending.length} commande(s) en attente → timers rappel/annulation replanifiés`);
  }
}

module.exports = { schedulePaymentReminderAndCancel, runPaymentTimeoutRecovery };
