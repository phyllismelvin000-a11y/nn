/**
 * Script pour insérer des produits de démo (Netflix + Onoff) dans Firestore.
 * À lancer une fois : node seed-products.js
 */
require('dotenv').config();
const { initFirebase, getDb } = require('./firebase');
const { addProduct } = require('./catalogue');

const FAKE_PRODUCTS = [
  // Netflix : 1 produit, prix = par mois. Le client choisit le nombre de mois (1, 2, 3, 6, 12).
  { titre: 'Netflix', prix: 2500, description: 'Abonnement Netflix (prix par mois)', imageUrl: '', stock: 50, categorie: 'netflix', E: 'E-NETFLIX', P: 'P-NETFLIX', dateExpiration: '31-déc-2026' },
  // Onoff : 2 types. Le client choisit Premium (3000/mois) ou Start (2500/mois), puis 1, 2 ou 3 mois.
  { titre: 'Onoff Premium', prix: 3000, description: 'Onoff Premium (prix par mois)', imageUrl: '', stock: 30, categorie: 'onoff', E: 'E-ONOFF-PREM', P: 'P-ONOFF-PREM', dateExpiration: '31-déc-2026' },
  { titre: 'Onoff Start', prix: 2500, description: 'Onoff Start (prix par mois)', imageUrl: '', stock: 30, categorie: 'onoff', E: 'E-ONOFF-START', P: 'P-ONOFF-START', dateExpiration: '31-déc-2026' },
];

async function seed() {
  initFirebase();
  console.log('Ajout des produits de démo...\n');
  for (const p of FAKE_PRODUCTS) {
    const created = await addProduct(p);
    console.log(`  ✓ ${created.titre} — ${created.prix} FCFA (${created.categorie}, stock: ${created.stock})`);
  }
  console.log('\nTerminé. ' + FAKE_PRODUCTS.length + ' produits ajoutés.');
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
