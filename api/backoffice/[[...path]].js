// Vercel serverless : /api/backoffice/xxx (ex. /admin/dashboard)
const { app } = require('../../backoffice');

module.exports = (req, res) => {
  let path = '/';
  if (req.url && req.url.startsWith('/api/backoffice')) {
    path = req.url.slice('/api/backoffice'.length) || '/';
  } else if (req.url && req.url.startsWith('/admin')) {
    path = req.url.slice('/admin'.length) || '/';
  }
  req.url = '/admin' + (path === '/' ? '' : path);
  app(req, res);
};
