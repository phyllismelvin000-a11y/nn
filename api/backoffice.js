// Vercel : route exacte /api/backoffice (quand on ouvre /admin)
const { app } = require('../backoffice');

module.exports = (req, res) => {
  req.url = '/admin';
  app(req, res);
};
