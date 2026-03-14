/**
 * Tests de la logique métier payment.js (buildWaveLink).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

const originalEnv = { ...process.env };

function restoreEnv() {
  process.env.WAVE_MERCHANT_ID = originalEnv.WAVE_MERCHANT_ID;
  process.env.WAVE_PHONE = originalEnv.WAVE_PHONE;
}

describe('payment.buildWaveLink', () => {
  it('retourne une URL Wave quand WAVE_MERCHANT_ID est défini', () => {
    process.env.WAVE_MERCHANT_ID = 'merchant123';
    process.env.WAVE_PHONE = '';
    const { buildWaveLink } = require('../payment');
    const url = buildWaveLink(5000, 'REF-ABC');
    assert.ok(url.startsWith('https://pay.wave.com/m/merchant123/'));
    assert.ok(url.includes('amount=5000'));
    restoreEnv();
  });

  it('arrondit le montant et accepte les chaînes', () => {
    process.env.WAVE_MERCHANT_ID = 'm1';
    process.env.WAVE_PHONE = '';
    const { buildWaveLink } = require('../payment');
    const url = buildWaveLink('5999.7', 'X1');
    assert.ok(url.includes('amount=6000'));
    restoreEnv();
  });

  it('fallback WhatsApp quand WAVE_MERCHANT_ID absent', () => {
    delete process.env.WAVE_MERCHANT_ID;
    process.env.WAVE_PHONE = '221 77 123 45 67';
    const { buildWaveLink } = require('../payment');
    const url = buildWaveLink(1000, 'REF-X');
    assert.ok(url.startsWith('https://wa.me/'));
    assert.ok(url.includes('221771234567') || url.includes('221'));
    assert.ok(url.includes('REF-X') || url.includes('Montant'));
    restoreEnv();
  });

  it('fallback WhatsApp avec numéro sans espaces', () => {
    delete process.env.WAVE_MERCHANT_ID;
    process.env.WAVE_PHONE = '221771234567';
    const { buildWaveLink } = require('../payment');
    const url = buildWaveLink(500, 'R1');
    assert.ok(url.startsWith('https://wa.me/221771234567'));
    restoreEnv();
  });

  it('montant 0 ou invalide donne amount=0', () => {
    process.env.WAVE_MERCHANT_ID = 'm1';
    const { buildWaveLink } = require('../payment');
    assert.ok(buildWaveLink(0, 'R').includes('amount=0'));
    assert.ok(buildWaveLink(null, 'R').includes('amount=0'));
    restoreEnv();
  });
});
