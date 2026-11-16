/**
 * @file Wallet encryption engine v4 — Argon2id + HKDF + XChaCha20-Poly1305.
 *
 * Provides authenticated encryption for wallet data using:
 * - Argon2id (RFC 9106) for memory-hard key derivation
 * - HKDF-SHA-256 (RFC 5869) for key hierarchy derivation
 * - XChaCha20-Poly1305 for authenticated encryption (confidentiality + integrity)
 * - HMAC-SHA-256 for key commitment (partitioning oracle resistance)
 *
 * Key derivation runs in a dedicated worker thread (argon-worker.mjs) to
 * avoid blocking the Electron main process.
 *
 * @module crypto
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { Worker } from "worker_threads";
import path from "path";
import fs from "fs";
import { EventEmitter } from "events";

const WORKER_PATH = path.join(__dirname, "lib", "argon-worker.mjs");

const PREFIX = new Uint8Array([0x76, 0x34]);
const SALT_LENGTH = 32;
const NONCE_LENGTH = 24;
const TAG_LENGTH = 16;
const HEADER_LENGTH = PREFIX.length + 4 + 4 + 4;
const WRAPPED_DEK_LENGTH = 32 + TAG_LENGTH;
const COMMIT_LENGTH = 32;
const MIN_CIPHERTEXT_LENGTH = HEADER_LENGTH + SALT_LENGTH + NONCE_LENGTH + WRAPPED_DEK_LENGTH + COMMIT_LENGTH + TAG_LENGTH;
const MAX_MEMORY_KIB = 2 ** 19;
const WORKER_MAX_OLD_SPACE_MB = 1024;

const TIERS = {
    low:    { t: 1, m: 2 ** 16, p: 4 },
    medium: { t: 2, m: 2 ** 17, p: 4 },
    high:   { t: 3, m: 2 ** 18, p: 4 },
    max:    { t: 4, m: 2 ** 19, p: 4 },
};

const DEFAULT_TIER = "medium";

const textDecoder = new TextDecoder();

/**
 * @typedef {Object} ArgonParams
 * @property {number} t - Time cost (iterations). Range: 1-10.
 * @property {number} m - Memory cost in KiB. Range: 2^14 - 2^19.
 * @property {number} p - Parallelism (lanes). Range: 1-4.
 * @property {number} [dkLen] - Desired key length in bytes. Default: 32.
 */

/**
 * Runs Argon2id synchronously in the current process.
 * Used only as a fallback when the worker cannot start (see {@link deriveKey}).
 *
 * @param {Uint8Array} passwordBytes
 * @param {Uint8Array} saltBytes
 * @param {ArgonParams} params
 * @returns {Uint8Array}
 */
function deriveKeyDirect(passwordBytes, saltBytes, params) {
    const key = argon2id(passwordBytes, saltBytes, params);
    if (!key || key.length !== 32) {
        throw new Error(`Argon2id produced invalid key: length=${key?.length}`);
    }
    return new Uint8Array(key);
}

/**
 * Largest Argon2id memory cost (KiB) the in-process fallback will run when
 * creating new ciphertext. Matches the `medium` tier (128 MiB). Decrypting
 * existing data above this still falls back, so wallets stay unlockable.
 * @type {number}
 */
const FALLBACK_MAX_MEMORY_KIB = 2 ** 17;

/**
 * Error carrying a stable code. The code is also the start of the message,
 * because errors crossing `ipcMain.handle` reach the renderer as text only.
 */
class ArgonError extends Error {
    /**
     * @param {"ARGON_WORKER_FAILED"|"ARGON_FALLBACK_REFUSED"} code
     * @param {string} [detail]
     */
    constructor(code, detail) {
        super(detail ? `${code}: ${detail}` : code);
        this.name = "ArgonError";
        this.code = code;
    }
}

/**
 * Emits `slow-path` with `{ memoryKiB, purpose, reason }` the first time the
 * in-process fallback runs in a session, so the UI can warn the user.
 * @type {EventEmitter}
 */
const cryptoEvents = new EventEmitter();

/** Set once the worker fails to load; later calls skip the spawn attempt. */
let workerUnavailable = false;

/** Whether the `slow-path` event has already been emitted this session. */
let slowPathReported = false;

/**
 * Runs the in-process fallback after the worker could not start.
 *
 * @param {Uint8Array} passwordBytes
 * @param {Uint8Array} saltBytes
 * @param {ArgonParams} params
 * @param {"encrypt"|"decrypt"} purpose
 * @param {string} reason - Why the worker was unavailable (for logs/UI).
 * @returns {Uint8Array}
 * @throws {ArgonError} ARGON_FALLBACK_REFUSED when creating ciphertext above the cap.
 */
function fallback(passwordBytes, saltBytes, params, purpose, reason) {
    if (purpose === "encrypt" && params.m > FALLBACK_MAX_MEMORY_KIB) {
        throw new ArgonError(
            "ARGON_FALLBACK_REFUSED",
            `worker unavailable (${reason}); ${params.m} KiB exceeds in-process cap`
        );
    }
    console.error(`[crypto] Argon2id worker unavailable (${reason}); deriving in-process`);
    if (!slowPathReported) {
        slowPathReported = true;
        cryptoEvents.emit("slow-path", { memoryKiB: params.m, purpose, reason });
    }
    return deriveKeyDirect(passwordBytes, saltBytes, params);
}

/**
 * Derive a 32-byte master key using Argon2id in a worker thread.
 *
 * Spawns a one-shot worker from the unpacked worker file so the main process
 * is never blocked. Only when the worker never loads (file missing, spawn
 * throws, or an error before its `{ ready: true }` message) does it fall back to in-process
 * derivation, capped for new ciphertext (see {@link FALLBACK_MAX_MEMORY_KIB}).
 * Failures after the worker has started are rejected, never retried
 * in-process: that would block the main process without the worker's
 * resource limits.
 *
 * @param {string|Uint8Array} password - Password or passphrase to derive from.
 * @param {Uint8Array} salt - 32-byte CSPRNG salt.
 * @param {ArgonParams} params - Argon2id parameters (t, m, p).
 * @param {"encrypt"|"decrypt"} [purpose="decrypt"] - Whether new ciphertext
 *   is being created; only `encrypt` is subject to the fallback cap.
 * @returns {Promise<Uint8Array>} Derived 32-byte master key.
 * @throws {ArgonError} ARGON_WORKER_FAILED if the worker fails after starting,
 *   or ARGON_FALLBACK_REFUSED if the capped fallback refuses.
 */
function deriveKey(password, salt, params, purpose = "decrypt") {
    const passwordBytes = typeof password === "string"
        ? utf8ToBytes(password)
        : new Uint8Array(password);
    const saltBytes = new Uint8Array(salt);

    const runFallback = (reason) => {
        workerUnavailable = true;
        try {
            return Promise.resolve(fallback(passwordBytes, saltBytes, params, purpose, reason));
        } catch (error) {
            return Promise.reject(error);
        }
    };

    if (workerUnavailable) {
        return runFallback("unavailable earlier this session");
    }

    const workerPath = WORKER_PATH.replace("app.asar", "app.asar.unpacked");
    if (!fs.existsSync(workerPath)) {
        return runFallback("worker file missing");
    }

    let worker;
    try {
        worker = new Worker(workerPath, {
            workerData: {
                password: Array.from(passwordBytes),
                salt: Array.from(saltBytes),
                params
            },
            resourceLimits: {
                maxOldGenerationSizeMb: WORKER_MAX_OLD_SPACE_MB
            }
        });
    } catch (spawnError) {
        return runFallback("spawn failed: " + spawnError.message);
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let started = false;
        const finish = (fn) => (...args) => {
            if (!settled) {
                settled = true;
                fn(...args);
            }
        };

        const onResult = finish((message) => {
            if (message && message.buffer) {
                resolve(new Uint8Array(message.buffer));
            } else if (message && message.success === false) {
                reject(new ArgonError("ARGON_WORKER_FAILED", message.error || "unknown error"));
            } else {
                reject(new ArgonError("ARGON_WORKER_FAILED", "unexpected message format"));
            }
        });
        // `online` fires before ESM imports resolve, so readiness comes from
        // the worker's own message once its imports have loaded
        worker.on("message", (message) => {
            if (message && message.ready === true) {
                started = true;
            } else {
                onResult(message);
            }
        });
        worker.on("error", finish((err) => {
            if (started) {
                reject(new ArgonError("ARGON_WORKER_FAILED", err.message));
            } else {
                runFallback("load error: " + err.message).then(resolve, reject);
            }
        }));
        worker.on("exit", finish((code) => {
            reject(new ArgonError("ARGON_WORKER_FAILED", `exited with code ${code} without result`));
        }));
    });
}

/**
 * Encode a 32-bit unsigned integer as 4 bytes in big-endian order.
 *
 * @param {number} value - Unsigned 32-bit integer.
 * @returns {Buffer} 4-byte big-endian buffer.
 */
function encodeUint32BE(value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value, 0);
    return buf;
}

/**
 * Decode a 32-bit unsigned integer from 4 bytes in big-endian order.
 *
 * @param {Buffer} buf - Buffer to read from.
 * @param {number} offset - Byte offset to start reading.
 * @returns {number} Decoded unsigned 32-bit integer.
 */
function decodeUint32BE(buf, offset) {
    return buf.readUInt32BE(offset);
}

/**
 * Constant-time comparison of two Uint8Arrays.
 *
 * @param {Uint8Array} a - First array.
 * @param {Uint8Array} b - Second array.
 * @returns {boolean} True if arrays are equal.
 */
function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a[i] ^ b[i];
    }
    return result === 0;
}

/**
 * Encrypt plaintext using Argon2id + HKDF + XChaCha20-Poly1305.
 *
 * Key hierarchy:
 *   Argon2id(password, salt) -> MK
 *     HKDF-Expand(MK, "beet:v4:kek")    -> KEK (wraps DEK)
 *     HKDF-Expand(MK, "beet:v4:commit") -> COMMIT_KEY (key commitment)
 *   DEK = randomBytes(32) (per-encryption data key)
 *
 * @param {string} plaintext - Data to encrypt (will be UTF-8 encoded).
 * @param {string} passphrase - Passphrase for Argon2id key derivation.
 * @param {string|ArgonParams} [tier="medium"] - Security tier label or raw parameters.
 * @returns {Promise<string>} Base64-encoded ciphertext in v4 wire format.
 * @throws {Error} If tier is invalid or parameters are out of range.
 */
export async function encrypt(plaintext, passphrase, tier = DEFAULT_TIER) {
    const params = typeof tier === "string" ? TIERS[tier] : tier;
    if (!params || !params.t || !params.m) {
        throw new Error("Invalid tier or parameters");
    }

    const salt = randomBytes(SALT_LENGTH);
    const nonce = randomBytes(NONCE_LENGTH);
    const nonceWrapped = randomBytes(NONCE_LENGTH);
    const MK = await deriveKey(passphrase, salt, params, "encrypt");

    const KEK = hkdf(sha256, MK, undefined, utf8ToBytes("beet:v4:kek"), 32);
    const COMMIT_KEY = hkdf(sha256, MK, undefined, utf8ToBytes("beet:v4:commit"), 32);

    const DEK = randomBytes(32);

    const header = Buffer.concat([
        Buffer.from(PREFIX),
        encodeUint32BE(params.t),
        encodeUint32BE(params.m),
        encodeUint32BE(params.p),
        Buffer.from(salt),
        Buffer.from(nonce),
        Buffer.from(nonceWrapped)
    ]);

    const wrappedDEK = xchacha20poly1305(KEK, nonceWrapped, header).encrypt(DEK);
    const cipherText = xchacha20poly1305(DEK, nonce, header).encrypt(utf8ToBytes(plaintext));

    const headerWithWrapped = Buffer.concat([
        header,
        Buffer.from(wrappedDEK)
    ]);

    const commitInput = new Uint8Array(headerWithWrapped.length + cipherText.length);
    commitInput.set(headerWithWrapped, 0);
    commitInput.set(cipherText, headerWithWrapped.length);
    const COMMIT_VALUE = hmac(sha256, COMMIT_KEY, commitInput);

    const output = Buffer.concat([
        headerWithWrapped,
        Buffer.from(COMMIT_VALUE),
        Buffer.from(cipherText)
    ]);

    MK.fill(0);
    DEK.fill(0);

    return output.toString("base64");
}

/**
 * Decrypt a v4 wire format ciphertext using Argon2id + HKDF + XChaCha20-Poly1305.
 *
 * Verifies the HMAC-SHA-256 key commitment before attempting decryption
 * to resist partitioning oracle attacks.
 *
 * @param {string} ciphertextBase64 - Base64-encoded v4 wire format ciphertext.
 * @param {string} passphrase - Passphrase for Argon2id key derivation.
 * @returns {Promise<string>} Decrypted plaintext string.
 * @throws {Error} If ciphertext is invalid, tampered, or passphrase is wrong.
 */
export async function decrypt(ciphertextBase64, passphrase) {
    const raw = Buffer.from(ciphertextBase64, "base64");

    if (raw.length < MIN_CIPHERTEXT_LENGTH) {
        throw new Error("Ciphertext too short");
    }

    if (raw[0] !== 0x76 || raw[1] !== 0x34) {
        throw new Error("Invalid v4 format");
    }

    const t = decodeUint32BE(raw, 2);
    const m = decodeUint32BE(raw, 6);
    const p = decodeUint32BE(raw, 10);

    if (t < 1 || t > 10) throw new Error("Invalid Argon2id t parameter: " + t);
    if (m < 2 ** 14 || m > MAX_MEMORY_KIB) throw new Error("Invalid Argon2id m parameter: " + m);
    if (p < 1 || p > 4) throw new Error("Invalid Argon2id p parameter: " + p);

    let offset = HEADER_LENGTH;
    const salt = raw.subarray(offset, offset + SALT_LENGTH); offset += SALT_LENGTH;
    const nonce = raw.subarray(offset, offset + NONCE_LENGTH); offset += NONCE_LENGTH;
    const nonceWrapped = raw.subarray(offset, offset + NONCE_LENGTH); offset += NONCE_LENGTH;
    const wrappedDEK = raw.subarray(offset, offset + WRAPPED_DEK_LENGTH); offset += WRAPPED_DEK_LENGTH;
    const storedCommit = raw.subarray(offset, offset + COMMIT_LENGTH); offset += COMMIT_LENGTH;
    const cipherText = raw.subarray(offset);

    const MK = await deriveKey(passphrase, salt, { t, m, p, dkLen: 32 });

    if (!MK || MK.length !== 32) {
        throw new Error(`Argon2id derivation produced invalid key: length=${MK?.length}`);
    }

    const KEK = hkdf(sha256, MK, undefined, utf8ToBytes("beet:v4:kek"), 32);
    const COMMIT_KEY = hkdf(sha256, MK, undefined, utf8ToBytes("beet:v4:commit"), 32);

    const header = raw.subarray(0, HEADER_LENGTH + SALT_LENGTH + NONCE_LENGTH + NONCE_LENGTH + WRAPPED_DEK_LENGTH);
    const commitInput = new Uint8Array(header.length + cipherText.length);
    commitInput.set(header, 0);
    commitInput.set(cipherText, header.length);
    const computedCommit = hmac(sha256, COMMIT_KEY, commitInput);

    if (!constantTimeEqual(storedCommit, computedCommit)) {
        MK.fill(0);
        throw new Error("Decryption failed: invalid passphrase or tampered data");
    }

    const aad = raw.subarray(0, HEADER_LENGTH + SALT_LENGTH + NONCE_LENGTH + NONCE_LENGTH);
    const DEK = xchacha20poly1305(KEK, nonceWrapped, aad).decrypt(wrappedDEK);
    const plainTextBytes = xchacha20poly1305(DEK, nonce, aad).decrypt(cipherText);

    MK.fill(0);
    DEK.fill(0);

    return textDecoder.decode(plainTextBytes);
}

/**
 * Wrap a data encryption key using a derived KEK.
 *
 * Used by sessionManager to efficiently encrypt multiple private keys
 * with a single Argon2id derivation.
 *
 * @param {Uint8Array} KEK - 32-byte key encryption key.
 * @param {Uint8Array} DEK - 32-byte data encryption key to wrap.
 * @param {Uint8Array} nonce - 24-byte nonce.
 * @param {Uint8Array} [aad] - Optional additional authenticated data.
 * @returns {Uint8Array} Wrapped DEK (48 bytes: 32 DEK + 16 tag).
 */
export function wrapKey(KEK, DEK, nonce, aad) {
    return xchacha20poly1305(KEK, nonce, aad).encrypt(DEK);
}

/**
 * Unwrap a data encryption key using a derived KEK.
 *
 * @param {Uint8Array} KEK - 32-byte key encryption key.
 * @param {Uint8Array} wrappedDEK - 48-byte wrapped DEK.
 * @param {Uint8Array} nonce - 24-byte nonce.
 * @param {Uint8Array} [aad] - Optional additional authenticated data.
 * @returns {Uint8Array} Unwrapped 32-byte DEK.
 */
export function unwrapKey(KEK, wrappedDEK, nonce, aad) {
    return xchacha20poly1305(KEK, nonce, aad).decrypt(wrappedDEK);
}

/**
 * Encrypt plaintext using a pre-derived DEK (no KDF).
 *
 * Used by sessionManager to encrypt multiple keys efficiently
 * after a single Argon2id derivation.
 *
 * @param {Uint8Array} DEK - 32-byte data encryption key.
 * @param {Uint8Array} nonce - 24-byte nonce.
 * @param {string} plaintext - Data to encrypt.
 * @param {Uint8Array} [aad] - Optional additional authenticated data.
 * @returns {Uint8Array} Ciphertext with appended tag.
 */
export function encryptWithKey(DEK, nonce, plaintext, aad) {
    return xchacha20poly1305(DEK, nonce, aad).encrypt(utf8ToBytes(plaintext));
}

/**
 * Decrypt ciphertext using a pre-derived DEK (no KDF).
 *
 * @param {Uint8Array} DEK - 32-byte data encryption key.
 * @param {Uint8Array} nonce - 24-byte nonce.
 * @param {Uint8Array} cipherText - Ciphertext with appended tag.
 * @param {Uint8Array} [aad] - Optional additional authenticated data.
 * @returns {string} Decrypted plaintext string.
 */
export function decryptWithKey(DEK, nonce, cipherText, aad) {
    return textDecoder.decode(xchacha20poly1305(DEK, nonce, aad).decrypt(cipherText));
}

/**
 * Derive KEK and COMMIT_KEY from a master key.
 *
 * @param {Uint8Array} MK - 32-byte master key.
 * @returns {{ KEK: Uint8Array, COMMIT_KEY: Uint8Array }} Derived keys.
 */
export function deriveKeysFromMaster(MK) {
    return {
        KEK: hkdf(sha256, MK, undefined, utf8ToBytes("beet:v4:kek"), 32),
        COMMIT_KEY: hkdf(sha256, MK, undefined, utf8ToBytes("beet:v4:commit"), 32)
    };
}

/**
 * Encrypt multiple plaintexts with a single Argon2id derivation.
 *
 * Derives MK + KEK + COMMIT_KEY once, then encrypts each plaintext
 * with its own random DEK and nonce. This avoids N×Argon2id cost when
 * encrypting multiple keys (e.g., active + owner + memo).
 *
 * All ciphertexts share the same Argon2id parameters and salt (encoded
 * in each blob), but use independent DEKs and nonces.
 *
 * @param {Array<{ keytype: string, plaintext: string }>} items - Items to encrypt.
 * @param {string} passphrase - Passphrase for Argon2id key derivation.
 * @param {string|ArgonParams} [tier="medium"] - Security tier label or raw parameters.
 * @returns {Promise<Object<string, string>>} Map of key types to Base64-encoded v4 ciphertexts.
 * @throws {Error} If tier is invalid or encryption fails.
 */
export async function encryptBatch(items, passphrase, tier = DEFAULT_TIER) {
    const params = typeof tier === "string" ? TIERS[tier] : tier;
    if (!params || !params.t || !params.m) {
        throw new Error("Invalid tier or parameters");
    }

    const salt = randomBytes(SALT_LENGTH);
    const MK = await deriveKey(passphrase, salt, params, "encrypt");
    const { KEK, COMMIT_KEY } = deriveKeysFromMaster(MK);

    const results = {};
    for (const { keytype, plaintext } of items) {
        const nonce = randomBytes(NONCE_LENGTH);
        const nonceWrapped = randomBytes(NONCE_LENGTH);
        const DEK = randomBytes(32);

        const header = Buffer.concat([
            Buffer.from(PREFIX),
            encodeUint32BE(params.t),
            encodeUint32BE(params.m),
            encodeUint32BE(params.p),
            Buffer.from(salt),
            Buffer.from(nonce),
            Buffer.from(nonceWrapped)
        ]);

        const wrappedDEK = xchacha20poly1305(KEK, nonceWrapped, header).encrypt(DEK);
        const cipherText = xchacha20poly1305(DEK, nonce, header).encrypt(utf8ToBytes(plaintext));

        const headerWithWrapped = Buffer.concat([
            header,
            Buffer.from(wrappedDEK)
        ]);

        const commitInput = new Uint8Array(headerWithWrapped.length + cipherText.length);
        commitInput.set(headerWithWrapped, 0);
        commitInput.set(cipherText, headerWithWrapped.length);
        const COMMIT_VALUE = hmac(sha256, COMMIT_KEY, commitInput);

        const output = Buffer.concat([
            headerWithWrapped,
            Buffer.from(COMMIT_VALUE),
            Buffer.from(cipherText)
        ]);

        DEK.fill(0);
        results[keytype] = output.toString("base64");
    }

    MK.fill(0);
    return results;
}

/**
 * Decrypt with optional KEK/COMMIT_KEY cache.
 *
 * If cached keys are provided (matching salt + params), skips Argon2id
 * derivation entirely. Otherwise derives keys and populates the cache.
 *
 * @param {string} ciphertextBase64 - Base64-encoded v4 ciphertext.
 * @param {string} passphrase - Passphrase for Argon2id key derivation.
 * @param {Object} [cache] - Optional cache object with `get` and `set` methods.
 * @returns {Promise<string>} Decrypted plaintext.
 * @throws {Error} If decryption fails.
 */
export async function decryptWithCache(ciphertextBase64, passphrase, cache) {
    const raw = Buffer.from(ciphertextBase64, "base64");

    if (raw.length < MIN_CIPHERTEXT_LENGTH) {
        throw new Error("Ciphertext too short");
    }

    if (raw[0] !== 0x76 || raw[1] !== 0x34) {
        throw new Error("Invalid v4 format");
    }

    const t = decodeUint32BE(raw, 2);
    const m = decodeUint32BE(raw, 6);
    const p = decodeUint32BE(raw, 10);

    if (t < 1 || t > 10) throw new Error("Invalid Argon2id t parameter: " + t);
    if (m < 2 ** 14 || m > MAX_MEMORY_KIB) throw new Error("Invalid Argon2id m parameter: " + m);
    if (p < 1 || p > 4) throw new Error("Invalid Argon2id p parameter: " + p);

    let offset = HEADER_LENGTH;
    const salt = raw.subarray(offset, offset + SALT_LENGTH); offset += SALT_LENGTH;
    const nonce = raw.subarray(offset, offset + NONCE_LENGTH); offset += NONCE_LENGTH;
    const nonceWrapped = raw.subarray(offset, offset + NONCE_LENGTH); offset += NONCE_LENGTH;
    const wrappedDEK = raw.subarray(offset, offset + WRAPPED_DEK_LENGTH); offset += WRAPPED_DEK_LENGTH;
    const storedCommit = raw.subarray(offset, offset + COMMIT_LENGTH); offset += COMMIT_LENGTH;
    const cipherText = raw.subarray(offset);

    const params = { t, m, p, dkLen: 32 };

    let KEK;
    let COMMIT_KEY;
    let header = raw.subarray(0, HEADER_LENGTH + SALT_LENGTH + NONCE_LENGTH + NONCE_LENGTH);

    const cached = cache ? cache.get(salt, params) : null;

    if (cached) {
        KEK = cached.KEK;
        COMMIT_KEY = cached.COMMIT_KEY;
    } else {
        const MK = await deriveKey(passphrase, salt, params);
        if (!MK || MK.length !== 32) {
            throw new Error(`Argon2id derivation produced invalid key: length=${MK?.length}`);
        }
        const derived = deriveKeysFromMaster(MK);
        KEK = derived.KEK;
        COMMIT_KEY = derived.COMMIT_KEY;
        MK.fill(0);

        if (cache) {
            cache.set(salt, params, KEK, COMMIT_KEY);
        }
    }

    const commitInput = new Uint8Array(header.length + WRAPPED_DEK_LENGTH + cipherText.length);
    commitInput.set(header, 0);
    commitInput.set(wrappedDEK, header.length);
    commitInput.set(cipherText, header.length + WRAPPED_DEK_LENGTH);
    const computedCommit = hmac(sha256, COMMIT_KEY, commitInput);

    if (!constantTimeEqual(storedCommit, computedCommit)) {
        throw new Error("Decryption failed: invalid passphrase or tampered data");
    }

    const DEK = xchacha20poly1305(KEK, nonceWrapped, header).decrypt(wrappedDEK);
    const plainTextBytes = xchacha20poly1305(DEK, nonce, header).decrypt(cipherText);

    DEK.fill(0);

    return textDecoder.decode(plainTextBytes);
}

export { deriveKey, cryptoEvents, ArgonError, TIERS, DEFAULT_TIER, randomBytes };
