/**
 * Vérification admin (Telegram user id vs ADMIN_CHAT_ID).
 */
function getAdminChatId() {
  return (process.env.ADMIN_CHAT_ID || '').trim();
}

function isAdmin(ctx) {
  const id = ctx.from?.id;
  if (id == null) return false;
  return String(id).trim() === getAdminChatId();
}

module.exports = { isAdmin, getAdminChatId };
