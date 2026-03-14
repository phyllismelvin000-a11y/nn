// Répond à la racine "/" par une redirection vers le backoffice (évite que Vercel serve index.js en brut).
module.exports = (req, res) => {
  res.writeHead(302, { Location: '/admin' });
  res.end();
};
