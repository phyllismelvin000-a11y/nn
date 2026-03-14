const { getOrderById, updateOrderStatus, getOrders, STATUS } = require('../orders');
const msg = require('./messages');

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
 */
function schedulePaymentReminderAndCancel(bot, order) {
  const orderId = order.id;
  const userId = order.userId;
  const refCommande = order.refCommande || orderId;
  const totalF = order.produit?.total ?? order.produit?.prix ?? 0;

  setTimeout(async () => {
    const o = await getOrderById(orderId);
    if (o && o.status === STATUS.EN_ATTENTE) {
      try {
        await bot.telegram.sendMessage(userId, msg.client.paymentReminder(refCommande, totalF));
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
 */
async function runPaymentTimeoutRecovery(bot) {
  const pending = await getOrders({ limit: 500, status: STATUS.EN_ATTENTE });
  const now = Date.now();
  for (const order of pending) {
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
          await bot.telegram.sendMessage(userId, msg.client.paymentReminder(refCommande, totalF));
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
