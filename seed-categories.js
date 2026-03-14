/**
 * Crée les catégories (netflix, onoff) et un sous-produit par catégorie.
 * Les prix sont sur les sous-produits, pas sur les catégories.
 * À lancer une fois : node seed-categories.js
 */
require('dotenv').config();
const { initFirebase } = require('./firebase');
const { getCategories, addCategory, getSubProducts, addSubProduct } = require('./categories');
const { createProductForSubProduct } = require('./catalogue');

async function seed() {
  initFirebase();
  const existing = await getCategories();
  const byNom = {};
  existing.forEach(c => { byNom[c.nom] = c; });

  let catNetflix = byNom.netflix;
  if (!catNetflix) {
    catNetflix = await addCategory({ nom: 'netflix' });
    console.log('Catégorie créée : netflix');
  } else {
    console.log('Catégorie netflix déjà présente');
  }
  let catOnoff = byNom.onoff;
  if (!catOnoff) {
    catOnoff = await addCategory({ nom: 'onoff' });
    console.log('Catégorie créée : onoff');
  } else {
    console.log('Catégorie onoff déjà présente');
  }

  const subsNetflix = await getSubProducts(catNetflix.id);
  if (subsNetflix.length === 0) {
    const sub = await addSubProduct(catNetflix.id, { nom: 'Netflix 1 mois', prixMois: 3000 });
    await createProductForSubProduct(catNetflix.id, sub.id);
    console.log('  Sous-produit créé : Netflix 1 mois — 3000 FCFA/mois');
  }
  const subsOnoff = await getSubProducts(catOnoff.id);
  if (subsOnoff.length === 0) {
    const sub = await addSubProduct(catOnoff.id, { nom: 'Onoff Premium', prixMois: 3000 });
    await createProductForSubProduct(catOnoff.id, sub.id);
    console.log('  Sous-produit créé : Onoff Premium — 3000 FCFA/mois');
  }
  process.exit(0);
}

seed().catch(e => {
  console.error(e);
  process.exit(1);
});
