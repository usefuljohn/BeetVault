/**
 * @file Maps Argon2id error codes from the main process to translation keys.
 *
 * Errors thrown by `ipcMain.handle` reach the renderer as message text only,
 * so the codes set by `ArgonError` in `crypto.js` are matched by substring.
 */

const CODE_KEYS = Object.freeze({
    ARGON_FALLBACK_REFUSED: 'common.crypto.fallbackRefused',
    ARGON_WORKER_FAILED: 'common.crypto.workerFailed',
});

/**
 * Returns the translation key for a crypto error, or null if the error does
 * not carry a known code.
 *
 * @param {unknown} err - An Error, a string, or anything thrown.
 * @returns {string|null}
 */
export function cryptoErrorKey(err) {
    const text = String((err && err.message) || err || '');
    const code = Object.keys(CODE_KEYS).find((c) => text.includes(c));
    return code ? CODE_KEYS[code] : null;
}
