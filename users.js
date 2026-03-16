const { getDb } = require('./firebase');
const { withRetry } = require('./util/retry');

const COLLECTION = 'users';

/**
 * Enregistre ou met à jour un utilisateur (après partage du contact ou premier message WhatsApp).
 * @param {{ userId: string, phone_number: string, firstName?: string, username?: string, countryAllowed: boolean, welcomed?: boolean }} data
 */
async function saveUser(data) {
  return withRetry(async () => {
    const db = getDb();
    const ref = db.collection(COLLECTION).doc(String(data.userId));
    const now = new Date();
    const doc = await ref.get();
    const payload = {
      userId: String(data.userId),
      phone_number: String(data.phone_number || ''),
      firstName: String(data.firstName || ''),
      username: String(data.username || ''),
      countryAllowed: Boolean(data.countryAllowed),
      updatedAt: now,
    };
    if (data.welcomed !== undefined) payload.welcomed = Boolean(data.welcomed);
    if (!doc.exists) {
      payload.createdAt = now;
      if (payload.welcomed === undefined) payload.welcomed = false;
      await ref.set(payload);
    } else {
      await ref.update(payload);
    }
    return { id: ref.id, ...payload };
  });
}

/** Marque l'utilisateur comme ayant reçu le message de premier contact. */
async function setUserWelcomed(userId) {
  return withRetry(async () => {
    const db = getDb();
    await db.collection(COLLECTION).doc(String(userId)).update({
      welcomed: true,
      updatedAt: new Date(),
    });
  });
}

/**
 * Récupère un utilisateur par son ID (Telegram ou WhatsApp wa_xxx).
 * @param {string} userId
 * @returns {Promise<{ userId, phone_number, firstName, username, countryAllowed, welcomed } | null>}
 */
async function getUserByUserId(userId) {
  const db = getDb();
  const doc = await db.collection(COLLECTION).doc(String(userId)).get();
  if (!doc.exists) return null;
  const d = doc.data();
  return {
    userId: d.userId,
    phone_number: d.phone_number || '',
    firstName: d.firstName || '',
    username: d.username || '',
    countryAllowed: Boolean(d.countryAllowed),
    welcomed: d.welcomed === true,
  };
}

/**
 * Liste tous les utilisateurs (pour backoffice et admin bot).
 * @param {{ limit?: number }} opts
 * @returns {Promise<Array<{ userId, phone_number, firstName, username, countryAllowed }>>}
 */
async function getUsers(opts = {}) {
  const limit = Math.min(Number(opts.limit) || 500, 1000);
  const db = getDb();
  const snap = await db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((doc) => {
    const d = doc.data();
    return {
      userId: d.userId,
      phone_number: d.phone_number || '',
      firstName: d.firstName || '',
      username: d.username || '',
      countryAllowed: Boolean(d.countryAllowed),
    };
  });
}

/**
 * Nombre total d'utilisateurs (pour les stats).
 */
async function getUsersCount() {
  const db = getDb();
  try {
    const snap = await db.collection(COLLECTION).count().get();
    return snap.data().count ?? 0;
  } catch (_) {
    const all = await getUsers({ limit: 2000 });
    return all.length;
  }
}

module.exports = { saveUser, getUserByUserId, setUserWelcomed, getUsers, getUsersCount };
