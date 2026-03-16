/**
 * Test : cherche une transaction Wave par ID dans l'historique.
 * Usage : node scripts/wave-test-transaction.js [TRANSACTION_ID]
 * Ex.   : node scripts/wave-test-transaction.js T_HB7QSB7MGCZ4CFSE
 */

require('dotenv').config();
const { getWalletHistory, isConfigured } = require('../lib/waveGraphql');

async function main() {
  const txId = process.argv[2] || 'T_HB7QSB7MGCZ4CFSE';
  if (!isConfigured()) {
    console.error('Définis WAVE_BUSINESS_TOKEN et WAVE_BUSINESS_WALLET_ID dans .env (voir scripts/wave-login.js).');
    process.exit(1);
  }

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  console.log('Recherche de la transaction', txId, 'entre', startStr, 'et', endStr, '…\n');

  try {
    const entries = await getWalletHistory(startStr, endStr, {
      limit: 100,
      transactionId: txId,
    });

    if (entries.length === 0) {
      console.log('Aucune transaction trouvée avec l’ID', txId);
      console.log('Vérifie que l’ID est correct et que la transaction est dans les 30 derniers jours.');
      return;
    }

    entries.forEach((e, i) => {
      console.log('--- Transaction', i + 1, '---');
      console.log('ID:', e.id);
      console.log('Type:', e.__typename);
      console.log('Montant:', e.grossAmount ?? e.amount);
      console.log('Date:', e.whenEntered ? new Date(e.whenEntered).toLocaleString('fr-FR') : '-');
      console.log('En attente:', e.isPending);
      console.log('Annulée:', e.isCancelled);
      if (e.clientReference) console.log('Réf. client:', e.clientReference);
      if (e.customerName) console.log('Client:', e.customerName);
      if (e.customerMobile) console.log('Téléphone:', e.customerMobile);
      if (e.transferId) console.log('Transfer ID:', e.transferId);
      console.log('');
    });
  } catch (err) {
    console.error('Erreur:', err.message);
    process.exit(1);
  }
}

main();
