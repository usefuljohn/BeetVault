/**
 * @file Size limits shared by the main process and the renderer.
 */

/**
 * Maximum accepted size of an uploaded JSON transaction file. Large batches
 * of BitShares operations stay well below this; the cap only guards against
 * accidentally selecting an unrelated large file. The renderer checks the
 * file's byte size and the main process checks the string length.
 *
 * @type {number}
 */
export const MAX_JSON_UPLOAD_SIZE = 10 * 1024 * 1024;

/**
 * Maximum accepted size, in bytes, of a `.bin` wallet backup sent to the
 * main process for decryption. Real backups are a few kilobytes.
 *
 * @type {number}
 */
export const MAX_BACKUP_FILE_SIZE = 5 * 1024 * 1024;
