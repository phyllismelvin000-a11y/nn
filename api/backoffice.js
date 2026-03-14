// Vercel : route exacte /api/backoffice (quand on ouvre /admin)
let app;
try {
  app = require('../backoffice').app;
} catch (err) {
  console.error('Backoffice load error:', err.message);
  module.exports = (req, res) => {
    res.status(500).setHeader('Content-Type', 'text/html; charset=utf-8').end(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Erreur</title></head><body>' +
      '<h1>Erreur de configuration</h1><p>Le backoffice n\'a pas pu démarrer. Vérifiez les logs de la fonction Vercel (Dashboard → Deployments → Function logs).</p>' +
      '<p>Cause fréquente : variable <strong>FIREBASE_SERVICE_ACCOUNT</strong> manquante ou invalide dans les Environment Variables du projet Vercel.</p>' +
      '</body></html>'
    );
  };
  return;
}

module.exports = (req, res) => {
  try {
    req.url = '/admin';
    app(req, res);
  } catch (err) {
    console.error('Backoffice handler error:', err.message);
    res.status(500).send('Erreur serveur.');
  }
};
