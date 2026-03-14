const { getLastPendingOrderByUser } = require('../orders');
const { isAdmin } = require('./auth');
const msg = require('../lib/messages');

/**
 * Si l'utilisateur a une commande en attente de reçu et envoie autre chose qu'une image,
 * lui demander d'envoyer une image. Ne pas intercepter l'admin ni les callback_query.
 */
async function pendingOrderImageOnly(ctx, next) {
  if (ctx.callbackQuery) return next();
  if (!ctx.message || ctx.message.photo) return next();
  if (isAdmin(ctx)) return next();
  const userId = ctx.from?.id;
  if (!userId) return next();
  const order = await getLastPendingOrderByUser(userId);
  if (!order) return next();
  const ref = order.refCommande || order.id;
  await ctx.reply(msg.client.sendImageForOrder(ref), { parse_mode: 'HTML' });
}

module.exports = { pendingOrderImageOnly };
