const path = require('path');
const fs = require('fs');
const { getLastPendingOrderByUser } = require('../orders');
const { isAdmin } = require('./auth');
const msg = require('../lib/messages');

const WAVE_ID_GUIDE_IMAGE_PATH = path.join(__dirname, '..', 'assets', 'wave-id-transaction.png');
function hasWaveIdGuideImage() {
  try {
    return fs.existsSync(WAVE_ID_GUIDE_IMAGE_PATH);
  } catch {
    return false;
  }
}

/** Format attendu : T_ suivi de lettres/chiffres (ex. T_5EPGALU ou T_HB7QSB7MGCZ4CFSE) */
const WAVE_TRANSACTION_ID_REGEX = /^T_[A-Za-z0-9]+$/;

/** Messages de navigation : pas besoin de vérifier la commande en attente (réponse plus rapide). */
const NAVIGATION_TEXTS = new Set(['📱 menu', 'menu', '🛒 catalogue', 'catalogue', '/start', '/menu', '/catalogue']);

/**
 * Si l'utilisateur a une commande en attente et envoie autre chose qu'une image ou un ID de transaction Wave,
 * lui demander d'envoyer l'ID de transaction. Ne pas intercepter l'admin ni les callback_query.
 */
async function pendingOrderImageOnly(ctx, next) {
  if (ctx.callbackQuery) return next();
  if (!ctx.message) return next();
  if (ctx.message.photo) return next();
  const text = ctx.message.text && ctx.message.text.trim();
  if (text && WAVE_TRANSACTION_ID_REGEX.test(text)) return next();
  if (text && NAVIGATION_TEXTS.has(text.toLowerCase())) return next();
  if (isAdmin(ctx)) return next();
  const userId = ctx.from?.id;
  if (!userId) return next();
  const order = await getLastPendingOrderByUser(userId);
  if (!order) return next();
  const ref = order.refCommande || order.id;
  const caption = msg.client.sendImageForOrder(ref) + '\n\n📍 <i>Voir l\'image ci-dessous : l\'ID est indiqué par la flèche dans l\'app Wave.</i>';
  if (hasWaveIdGuideImage()) {
    await ctx.replyWithPhoto({ source: fs.createReadStream(WAVE_ID_GUIDE_IMAGE_PATH) }, { caption, parse_mode: 'HTML' });
  } else {
    await ctx.reply(caption, { parse_mode: 'HTML' });
  }
}

module.exports = { pendingOrderImageOnly };
