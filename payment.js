/**
 * Génère le lien de paiement Wave.
 * Format : https://pay.wave.com/m/{MERCHANT_ID}/c/ci/?amount={MONTANT}
 * Si WAVE_MERCHANT_ID absent : fallback WhatsApp avec WAVE_PHONE
 */
function buildWaveLink(amount, refCommande) {
  const merchantId = process.env.WAVE_MERCHANT_ID;
  const phone = process.env.WAVE_PHONE || '';
  const amountStr = String(Math.round(Number(amount) || 0));

  if (merchantId && merchantId.trim()) {
    return `https://pay.wave.com/m/${merchantId.trim()}/c/ci/?amount=${amountStr}`;
  }
  // Fallback: lien WhatsApp avec le numéro Wave du marchand
  const phoneClean = phone.replace(/\D/g, '');
  const message = encodeURIComponent(`Paiement Wave - Ref: ${refCommande || 'N/A'} - Montant: ${amountStr} FCFA`);
  return `https://wa.me/${phoneClean}?text=${message}`;
}

module.exports = { buildWaveLink };
