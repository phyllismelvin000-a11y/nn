/**
 * Exécute une fonction async avec retries en cas d'échec (ex: coupure réseau Firestore).
 * @param {Function} fn - async () => result
 * @param {{ maxAttempts?: number, delayMs?: number }} opts - maxAttempts (défaut 3), delayMs (défaut 1000)
 * @returns {Promise<*>}
 */
async function withRetry(fn, opts = {}) {
  const max = opts.maxAttempts ?? 3;
  const delayMs = opts.delayMs ?? 1000;
  let lastErr;
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < max - 1) {
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
