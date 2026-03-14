/**
 * Tests de la logique métier orders.js (statuts et structure).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { STATUS } = require('../orders');

describe('orders.STATUS', () => {
  it('expose les 4 statuts attendus', () => {
    assert.strictEqual(STATUS.EN_ATTENTE, 'en_attente');
    assert.strictEqual(STATUS.CONFIRMEE, 'confirmee');
    assert.strictEqual(STATUS.LIVREE, 'livree');
    assert.strictEqual(STATUS.ANNULEE, 'annulee');
  });

  it('valeurs cohérentes pour filtrage Firestore', () => {
    const values = Object.values(STATUS);
    assert.strictEqual(values.length, 4);
    values.forEach(v => {
      assert.strictEqual(typeof v, 'string');
      assert.ok(v.length >= 2);
    });
  });
});
