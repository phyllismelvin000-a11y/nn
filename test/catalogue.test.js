/**
 * Tests de la logique métier catalogue.js (filterByCategory).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { filterByCategory } = require('../catalogue');

describe('catalogue.filterByCategory', () => {
  it('filtre par catégorie netflix', () => {
    const products = [
      { id: '1', titre: 'Netflix 1 mois', categorie: 'netflix' },
      { id: '2', titre: 'Onoff 1 mois', categorie: 'onoff' },
      { id: '3', titre: 'Netflix 3 mois', categorie: 'Netflix' },
    ];
    const out = filterByCategory(products, 'netflix');
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].id, '1');
    assert.strictEqual(out[1].id, '3');
  });

  it('filtre par catégorie onoff', () => {
    const products = [
      { id: 'a', categorie: 'netflix' },
      { id: 'b', categorie: 'onoff' },
    ];
    const out = filterByCategory(products, 'onoff');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'b');
  });

  it('retourne tout si catégorie vide ou non fournie', () => {
    const products = [{ id: '1', categorie: 'netflix' }];
    assert.strictEqual(filterByCategory(products, '').length, 1);
    assert.strictEqual(filterByCategory(products, null).length, 1);
    assert.strictEqual(filterByCategory(products).length, 1);
  });

  it('gère produits sans categorie (exclu sauf si cat vide)', () => {
    const products = [
      { id: '1' },
      { id: '2', categorie: 'netflix' },
    ];
    assert.strictEqual(filterByCategory(products, 'netflix').length, 1);
    assert.strictEqual(filterByCategory(products, '').length, 2);
  });
});
