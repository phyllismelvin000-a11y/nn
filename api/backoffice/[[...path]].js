// Vercel serverless : sert le backoffice Express. Rewrite /admin* -> /api/backoffice*
const { app } = require('../../backoffice');

module.exports = (req, res) => {
  const base = '/api/backoffice';
  const path = (req.url && req.url.startsWith(base)) ? req.url.slice(base.length) || '/' : '/';
  req.url = '/admin' + (path === '/' ? '' : path);
  app(req, res);
};
