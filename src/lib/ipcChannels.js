/**
 * IPC Channel Allowlists
 * 
 * Static lists of valid channel names for each IPC direction.
 * Dynamic channels use regex patterns for ID-based channels.
 * 
 * IMPORTANT: These lists must be kept in sync with the preload scripts.
 * If a new IPC channel is added to preload.js or preloadmodal.js,
 * it must also be added here.
 */

// Channels that the renderer sends via ipcRenderer.send()
export const SEND_CHANNELS = Object.freeze([
    'openURL',
    'notify',
    'resetTimer',
    'seed',
    'clearSeed',
    'createPopup',
    'createReceipt',
    'createError',
    'createDoc',
    'sendError',
    'injectedCallResponse',
    'injectedCallError',
    'getSafeAccountResponse',
    'downloadBackup',
    'clickedAllow',
    'clickedDeny',
]);

// Channels that the renderer calls via ipcRenderer.invoke()
export const INVOKE_CHANNELS = Object.freeze([
    'blockchainRequest',
    'memoFromBuffer',
    'encryptPendingKeys',
    'decryptAndSign',
    'decryptAndCreateMemo',
    'decryptAndSignMessage',
    'unlockWallet',
    'encryptAndStore',
    'decryptWallet',
    'setSeedFromPassword',
    'getSafeStorageBackend',
    'id',
    'getSignature',
    'verifyCrypto',
    'readDoc',
    'readManifest',
    'restore',
    'derivePubkeys',
]);

// Channels that the renderer listens to via ipcRenderer.on()
export const LISTEN_CHANNELS = Object.freeze([
    'resetTimer',
    'setNode',
    'injectedCall',
    'getSafeAccount',
    'forceLogout',
    'rawdeeplink',
    'cryptoSlowPath',
]);

// Dynamic channels (contain UUIDs minted in the main process)
// These are validated via regex patterns. Request ids supplied by dApps never
// appear in channel names; parseRequest replaces them with a fresh UUID.
const ID_PATTERN = '[a-f0-9\\-]{36}';

export const DYNAMIC_SEND_PATTERNS = Object.freeze([
    new RegExp(`^get:prompt:${ID_PATTERN}$`),
    new RegExp(`^get:receipt:${ID_PATTERN}$`),
    new RegExp(`^get:error:${ID_PATTERN}$`),
]);

export const DYNAMIC_LISTEN_PATTERNS = Object.freeze([
    new RegExp(`^popupApproved_${ID_PATTERN}$`),
    new RegExp(`^popupRejected_${ID_PATTERN}$`),
    new RegExp(`^respond:prompt:${ID_PATTERN}$`),
    new RegExp(`^respond:receipt:${ID_PATTERN}$`),
    new RegExp(`^respond:error:${ID_PATTERN}$`),
]);
