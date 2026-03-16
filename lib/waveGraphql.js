/**
 * Wave Business — vérification des paiements via l'API GraphQL interne.
 * Sans navigateur : utilise WAVE_BUSINESS_TOKEN + WAVE_BUSINESS_WALLET_ID (récupérés une fois via le script scripts/wave-login.js ou DevTools).
 */

const WAVE_GRAPHQL_URL = 'https://ci.mmapp.wave.com/a/business_graphql';

let cachedToken = null;
let cachedWalletOpaqueId = null;

function getToken() {
  if (cachedToken) return cachedToken;
  const t = (process.env.WAVE_BUSINESS_TOKEN || '').trim();
  if (t) cachedToken = t;
  return cachedToken || null;
}

function getWalletOpaqueId() {
  if (cachedWalletOpaqueId) return cachedWalletOpaqueId;
  const w = (process.env.WAVE_BUSINESS_WALLET_ID || '').trim();
  if (w) cachedWalletOpaqueId = w;
  return cachedWalletOpaqueId || null;
}

function setCachedSession(token, walletOpaqueId) {
  if (token) cachedToken = token;
  if (walletOpaqueId) cachedWalletOpaqueId = walletOpaqueId;
}

function clearCache() {
  cachedToken = null;
  cachedWalletOpaqueId = null;
}

function entryHasTxId(entry, txId) {
  const id = String(txId || '').trim().toUpperCase();
  if (!id) return false;
  const summary = String(entry?.summary || '').toUpperCase();
  if (summary.includes(id)) return true;
  const receipt = Array.isArray(entry?.baseReceiptFields) ? entry.baseReceiptFields : [];
  for (const f of receipt) {
    const v = String(f?.value || '').toUpperCase();
    const lbl = String(f?.label || '').toUpperCase();
    if (v.includes(id) || lbl.includes(id)) return true;
  }
  return false;
}

function toEpochMs(whenEntered) {
  if (whenEntered == null) return 0;
  if (typeof whenEntered === 'number') return whenEntered;
  const t = new Date(whenEntered).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Appel GraphQL authentifié (Basic Auth avec token).
 */
async function graphqlRequest(query, variables = {}) {
  const token = getToken();
  if (!token) {
    throw new Error('Wave Business : WAVE_BUSINESS_TOKEN manquant. Lance scripts/wave-login.js ou définis-le dans .env');
  }
  const auth = Buffer.from(':' + token).toString('base64');
  const res = await fetch(WAVE_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Origin': 'https://business.wave.com',
      'Referer': 'https://business.wave.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Authorization': 'Basic ' + auth,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors && data.errors.length) {
    const msg = data.errors.map(e => e.message).join('; ');
    if (res.status === 401 || /unauthorized|auth/i.test(msg)) {
      clearCache();
      throw new Error('Wave Business : session expirée. Reconnecte-toi (scripts/wave-login.js) et mets à jour WAVE_BUSINESS_TOKEN.');
    }
    throw new Error('Wave Business GraphQL: ' + msg);
  }
  return data.data;
}

/**
 * Récupère l'historique du portefeuille business sur une plage de dates.
 * @param {string} start - YYYY-MM-DD
 * @param {string} end - YYYY-MM-DD
 * @param {{ walletOpaqueId?: string, limit?: number, transactionId?: string, customerMobileStr?: string }} options
 */
async function getWalletHistory(start, end, options = {}) {
  const walletOpaqueId = options.walletOpaqueId || getWalletOpaqueId();
  if (!walletOpaqueId) {
    throw new Error('Wave Business : WAVE_BUSINESS_WALLET_ID manquant. Définis-le dans .env (voir scripts/wave-login.js).');
  }
  const limit = options.limit ?? 100;
  const transactionId = options.transactionId || null;
  const customerMobileStr = options.customerMobileStr || null;
  const searchTerm = options.searchTerm || null;

  const query = `query HistoryEntries_BusinessWalletHistoryQuery(
    $start: Date!
    $end: Date!
    $walletOpaqueId: String!
    $limit: Int
    $transactionId: String
    $customerMobileStr: String
    $searchTerm: String
    $surrogateEmployeeId: String
    $includePending: Boolean
    $transactionType: TransactionType
  ) {
    me {
      merchant { canRefund name id }
      businessUser {
        rolePermissions
        user { merchant { needsPinToRefund id } id }
        business {
          name
          showGrossAmount
          showSurrogateOptions
          walletHistory(
            start: $start
            end: $end
            walletOpaqueId: $walletOpaqueId
            limit: $limit
            transactionId: $transactionId
            customerMobileStr: $customerMobileStr
            surrogateEmployeeId: $surrogateEmployeeId
            searchTerm: $searchTerm
            includePending: $includePending
            transactionType: $transactionType
          ) {
            batches { __typename id totalCost whenCreated senderName senderMobile }
            historyEntries {
              __typename
              id
              summary
              whenEntered
              amount
              isPending
              isCancelled
              baseReceiptFields { formatType label value }
              ... on MerchantSaleEntry {
                clientReference
                transferId
                customerMobile: unmaskedSenderMobile
                customerName: senderName
                grossAmount
                feeAmount
              }
              ... on TransferSentEntry {
                recipientName
                recipientMobile
                transferOpaqueId: transferId
              }
            }
          }
          id
        }
        id
      }
      id
    }
  }`;

  const variables = {
    start,
    end,
    walletOpaqueId,
    limit,
    transactionId,
    customerMobileStr,
    searchTerm,
    surrogateEmployeeId: null,
    includePending: true,
    transactionType: 'ALL',
  };

  const data = await graphqlRequest(query, variables);
  const history = data?.me?.businessUser?.business?.walletHistory;
  if (!history || !Array.isArray(history.historyEntries)) {
    return [];
  }
  return history.historyEntries;
}

/**
 * Trouve une entrée Wave qui correspond à une commande (réf + montant).
 * @param {Array} entries - historyEntries retournées par getWalletHistory
 * @param {{ refCommande: string, total: number }} order - refCommande et montant total (produit.total)
 * @returns {{ found: boolean, entry?: object, matchBy?: string }}
 */
function findMatchingEntry(entries, order) {
  const ref = String(order.refCommande || '').trim().toUpperCase();
  const amount = Number(order.total) || 0;
  if (!ref && !amount) return { found: false };

  for (const entry of entries) {
    if (entry.isCancelled) continue;
    const entryAmount = entry.grossAmount != null ? entry.grossAmount : entry.amount;
    const amountMatch = entryAmount != null && Math.abs(Number(entryAmount) - amount) < 1;
    const clientRef = (entry.clientReference || '').trim().toUpperCase();
    const refMatch = ref && clientRef && (clientRef.includes(ref) || ref.includes(clientRef));

    if (refMatch && amountMatch) return { found: true, entry, matchBy: 'ref_and_amount' };
    if (refMatch) return { found: true, entry, matchBy: 'ref' };
    if (amountMatch && entry.__typename === 'MerchantSaleEntry') return { found: true, entry, matchBy: 'amount' };
  }
  return { found: false };
}

/**
 * Vérifie qu'un ID de transaction Wave existe dans l'historique du compte Business et correspond au montant de la commande.
 * @param {string} transactionId - ex. T_7XLOVPCSWG34REBB
 * @param {object} order - commande avec produit.total, createdAt
 * @returns {Promise<{ valid: boolean, message: string, entry?: object }>}
 */
async function verifyTransactionIdInWave(transactionId, order) {
  try {
    if (!getToken() || !getWalletOpaqueId()) {
      return { valid: false, message: 'Wave non configuré. La vérification est désactivée.' };
    }
    const id = String(transactionId || '').trim();
    if (!id) return { valid: false, message: 'ID de transaction vide.' };

    const orderAmount = Number(order.produit?.total ?? order.produit?.prix) || 0;
    const created = order.createdAt;
    let startDate, endDate;
    if (created && typeof created.toMillis === 'function') {
      const t = created.toMillis();
      const d = new Date(t);
      d.setDate(d.getDate() - 1);
      startDate = d.toISOString().slice(0, 10);
      endDate = new Date().toISOString().slice(0, 10);
    } else {
      const d = new Date();
      endDate = d.toISOString().slice(0, 10);
      d.setDate(d.getDate() - 7);
      startDate = d.toISOString().slice(0, 10);
    }

    let entries = await getWalletHistory(startDate, endDate, { transactionId: id, limit: 10 });
    if (!entries || entries.length === 0) {
      // Fallback : récupérer les entrées récentes et chercher par transferId / id (l’API peut ne pas filtrer correctement par transactionId)
      const fallback = await getWalletHistory(startDate, endDate, { limit: 200 });
      const match =
        fallback &&
        fallback.find(
          (e) =>
            e.transferId === id ||
            e.id === id ||
            (e.transferId && String(e.transferId).toUpperCase().includes(id.toUpperCase())) ||
            (e.id && String(e.id).toUpperCase().includes(id.toUpperCase()))
        );
      if (match) entries = [match];
    }
    if (!entries || entries.length === 0) {
      return {
        valid: false,
        message:
          'Cette transaction n\'a pas été trouvée sur le compte Wave Business configuré. Vérifie que le paiement a bien été fait vers le même compte que le lien de paiement du bot, que l\'ID est correct (ex. T_xxx dans l’app Wave), et réessaye dans quelques minutes si le paiement vient d’être effectué.',
      };
    }
    const entry = entries[0];
    if (entry.isCancelled) {
      return { valid: false, message: 'Cette transaction Wave est annulée.' };
    }
    const rawAmount = entry.grossAmount != null ? entry.grossAmount : entry.amount; // ex. "CFA 100"
    const numericEntryAmount =
      rawAmount != null
        ? Number(String(rawAmount).replace(/[^\d.-]/g, '')) // "CFA 100" -> 100
        : null;
    if (
      orderAmount > 0 &&
      numericEntryAmount != null &&
      !Number.isNaN(numericEntryAmount) &&
      Math.abs(numericEntryAmount - orderAmount) > 1
    ) {
      return {
        valid: false,
        message: `Le montant Wave (${numericEntryAmount} F) ne correspond pas à la commande (${orderAmount} F). Vérifiez l'ID de transaction.`,
      };
    }

    // Fenêtre temporelle : la transaction doit être après la création de la commande (avec 10 min de marge) et pas dans le futur
    const orderCreatedMs = created && typeof created.toMillis === 'function' ? created.toMillis() : (created ? new Date(created).getTime() : 0);
    const whenEntered = entry.whenEntered;
    const entryMs = toEpochMs(whenEntered);
    const nowMs = Date.now();
    const tenMin = 10 * 60 * 1000;
    const twoMin = 2 * 60 * 1000;
    if (orderCreatedMs && entryMs) {
      if (entryMs < orderCreatedMs - tenMin) {
        return { valid: false, message: 'Cette transaction est antérieure à la commande. Utilisez l\'ID du paiement de cette commande.' };
      }
      if (entryMs > nowMs + twoMin) {
        return { valid: false, message: 'Date de transaction invalide.' };
      }
    }

    // Détection remboursement : si un refund lié à ce T_... existe, on refuse la confirmation
    // (Wave peut afficher un MerchantRefundEntry après une vente, parfois sans transferId direct)
    try {
      const around = await getWalletHistory(startDate, endDate, { limit: 300 });
      const refund = around.find((e) => {
        if (e.__typename !== 'MerchantRefundEntry') return false;
        if (entryHasTxId(e, id)) return true;
        const eAmtRaw = e.grossAmount != null ? e.grossAmount : e.amount;
        const eAmt = eAmtRaw != null ? Number(String(eAmtRaw).replace(/[^\d.-]/g, '')) : null;
        // Heuristique : montant négatif correspondant + refund proche en temps de la vente
        if (orderAmount > 0 && eAmt != null && !Number.isNaN(eAmt) && Math.abs(eAmt + orderAmount) <= 1) {
          const eMs = toEpochMs(e.whenEntered);
          if (eMs && entryMs && eMs >= entryMs && eMs - entryMs <= 48 * 60 * 60 * 1000) return true;
        }
        return false;
      });
      if (refund) {
        return { valid: false, message: '❌ Paiement remboursé sur Wave. Cette transaction ne peut pas confirmer la commande.' };
      }
    } catch (_) {
      // Si la détection refund échoue, on ne bloque pas la validation; la vérification principale reste valide.
    }

    return { valid: true, message: 'OK', entry };
  } catch (err) {
    return { valid: false, message: err.message || 'Erreur lors de la vérification Wave.' };
  }
}

/**
 * Vérifie une commande contre l'historique Wave (plage de dates autour de la date de la commande).
 * @param {object} order - commande avec refCommande, produit.total, createdAt
 * @returns {Promise<{ ok: boolean, found: boolean, message: string, entry?: object, error?: string }>}
 */
async function verifyOrderAgainstWave(order) {
  try {
    if (!getToken() || !getWalletOpaqueId()) {
      return {
        ok: false,
        found: false,
        message: 'Wave non configuré (WAVE_BUSINESS_TOKEN / WAVE_BUSINESS_WALLET_ID).',
      };
    }

    const created = order.createdAt;
    let startDate, endDate;
    if (created && typeof created.toMillis === 'function') {
      const t = created.toMillis();
      const d = new Date(t);
      startDate = d.toISOString().slice(0, 10);
      d.setDate(d.getDate() + 2);
      endDate = d.toISOString().slice(0, 10);
    } else {
      const d = new Date();
      endDate = d.toISOString().slice(0, 10);
      d.setDate(d.getDate() - 7);
      startDate = d.toISOString().slice(0, 10);
    }

    const entries = await getWalletHistory(startDate, endDate, { limit: 100 });
    const { found, entry, matchBy } = findMatchingEntry(entries, {
      refCommande: order.refCommande,
      total: order.produit?.total ?? order.produit?.prix,
    });

    if (found) {
      const when = entry.whenEntered ? new Date(entry.whenEntered).toLocaleString('fr-FR') : '-';
      return {
        ok: true,
        found: true,
        message: `Paiement trouvé sur Wave (${matchBy}). Montant: ${entry.grossAmount ?? entry.amount} F — ${when}`,
        entry: {
          id: entry.id,
          amount: entry.grossAmount ?? entry.amount,
          whenEntered: entry.whenEntered,
          clientReference: entry.clientReference,
          customerName: entry.customerName,
          customerMobile: entry.customerMobile,
        },
      };
    }

    return {
      ok: true,
      found: false,
      message: `Aucun paiement correspondant sur Wave pour la période ${startDate} → ${endDate}. Vérifie la réf. ou le montant.`,
    };
  } catch (err) {
    return {
      ok: false,
      found: false,
      message: err.message || 'Erreur Wave',
      error: err.message,
    };
  }
}

module.exports = {
  getToken,
  getWalletOpaqueId,
  setCachedSession,
  clearCache,
  getWalletHistory,
  findMatchingEntry,
  verifyTransactionIdInWave,
  verifyOrderAgainstWave,
  isConfigured: () => !!(getToken() && getWalletOpaqueId()),
};
