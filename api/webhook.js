// Vercel serverless: reçoit les mises à jour Telegram en webhook (pas de long polling).
const { bot } = require('../index');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  try {
    await bot.handleUpdate(req.body, res);
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).end();
    return;
  }
  res.status(200).end();
};
