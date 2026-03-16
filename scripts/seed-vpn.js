/**
 * Ajoute un produit VPN de démo (sans stock limité).
 * À lancer une fois : node scripts/seed-vpn.js
 * Puis le produit apparaît dans le catalogue bot sous 🔒 VPN.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { initFirebase } = require('../firebase');
const { addProduct, getActiveProductsByCategory } = require('../catalogue');

async function main() {
  initFirebase();
  const existing = await getActiveProductsByCategory('vpn');
  if (existing.length > 0) {
    console.log('Des produits VPN existent déjà :', existing.map(p => p.titre).join(', '));
    process.exit(0);
    return;
  }
  const product = await addProduct({
    titre: 'VPN Premium',
    prix: 5000,
    description: 'Accès VPN 1 an — identifiants envoyés après paiement',
    imageUrl: '',
    stock: 0,
    categorie: 'vpn',
    E: '',
    P: '',
    dateExpiration: '',
  });
  console.log('✓ Produit VPN ajouté :', product.titre, '—', product.prix, 'FCFA');
  console.log('  Catégorie: vpn (affiché dans le bot sous 🔒 VPN, sans limite de stock)');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
