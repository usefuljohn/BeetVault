import fsPromises from 'fs/promises';
import path from 'path';
import { validateSender } from './securityGuards.js';
import { BTS_FAMILY, VAULTA_FAMILY, HIVE_FAMILY } from '../lib/blockchains/chainFamilies.js';
import * as Actions from '../lib/Actions.js';
import { SAFE_DOMAINS, MAX_JSON_UPLOAD_SIZE, MAX_BACKUP_FILE_SIZE } from './constants.js';
import { inject } from '../lib/inject.js';
import { decrypt } from '../lib/crypto.js';
import { v4 as uuidv4 } from 'uuid';
import { PrivateKey } from '../lib/blockchains/bitshares/library/index.js';
import { storePendingKey } from './sessionManager.js';
import getBlockchainAPIImport from '../lib/blockchains/blockchainFactory.js';
import BTSWalletHandler from '../lib/blockchains/bitshares/BTSWalletHandler.js';
import { getMainWindow } from './windows.js';
import { BASE_EOSIO_OPERATIONS, ATOMIC_ASSETS_OPERATIONS, ATOMIC_MARKET_OPERATIONS } from '../lib/blockchains/Antelope.js';
import { clearContractKitCache } from '../lib/blockchains/Antelope/contractKit.js';
import { decodeEsr, resolveEsrRequest, isEsrEncoded } from '../lib/blockchains/Antelope/esrHelper.js';

const ALL_KNOWN_OPERATIONS = [
    ...BASE_EOSIO_OPERATIONS,
    ...ATOMIC_ASSETS_OPERATIONS,
    ...ATOMIC_MARKET_OPERATIONS,
];

function isKnownOperation(opName) {
    return ALL_KNOWN_OPERATIONS.includes(opName);
}

/**
 * Stores the current RPC node URL per chain, set by the renderer via
 * the `blockchainRequest` handler. Used to persist the user's preferred
 * node across multiple API calls within a session.
 *
 * @type {Object<string, string>}
 * @private
 */
let _chainNodes = {};

/**
 * Updates the stored node URL for a given blockchain.
 *
 * @param {string} chain - The blockchain identifier (e.g., 'bitshares').
 * @param {string} node - The RPC node URL to store.
 * @returns {void}
 */
export function setChainNode(chain, node) {
    _chainNodes[chain] = node;
    clearContractKitCache();
}

/**
 * Returns the reference to the chain nodes map. Modifications to the
 * returned object are reflected across all consumers.
 *
 * @returns {Object<string, string>} Map of chain identifiers to RPC node URLs.
 */
export function getChainNodes() {
    return _chainNodes;
}

/**
 * Securely reads a file from the filesystem, restricted to `.bin` files
 * only. Prevents path traversal and null-byte injection attacks.
 *
 * @param {string} filePath - The absolute or relative path to the file.
 * @returns {Promise<Buffer>} The file contents as a Buffer.
 * @throws {string} If the path is invalid, not a .bin file, contains
 *   path traversal (`..`), or contains null bytes.
 */
export async function readFileSecure(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        throw 'Invalid file path';
    }

    const resolved = path.resolve(filePath);
    const ext = path.extname(resolved);

    if (ext !== '.bin') {
        throw 'Invalid file type';
    }

    if (resolved.includes('..') || resolved.includes('\0')) {
        throw 'Invalid file path';
    }

    return await fsPromises.readFile(resolved);
}

/**
 * Parses and validates a blockchain request from an uploaded JSON file.
 *
 * This function performs multi-layered validation:
 *   1. Parses the JSON request envelope
 *   2. Validates the request format (id, payload, chain, method)
 *   3. Verifies the chain matches the expected blockchain
 *   4. Checks the method is in the global Actions allowlist
 *   5. Checks the method is supported by the specific blockchain
 *   6. Checks the method is authorized by the user's settings
 *   7. For INJECTED_CALL methods, validates individual operations
 *
 * @param {string} requestContent - The request envelope as a JSON string.
 * @param {string} chain - The expected blockchain identifier.
 * @param {object} blockchain - The blockchain API instance (used for
 *   transaction parsing in INJECTED_CALL validation).
 * @param {string[]} blockchainActions - Actions supported by this blockchain.
 * @param {string[]|null} settingsRows - User-authorized operations from
 *   settings, or null if no restrictions.
 * @param {function(string): void} [onReject] - Called with a reason code
 *   (`invalidJson`, `invalidFormat`, `wrongChain`, `unsupportedMethod`,
 *   `invalidTransaction`, `outsideScope`) when validation fails.
 * @returns {Promise<{id: string, requestId: string, type: string, payload: object}|undefined>}
 *   The parsed and validated request object, or undefined if validation fails.
 *   `id` is a fresh UUID minted here and used for popup/IPC channel names;
 *   the sender's own `request.id` is kept as `requestId` and never reaches
 *   a channel name.
 */
export async function parseRequest(requestContent, chain, blockchain, blockchainActions, settingsRows, onReject = () => {}) {
    let request;
    try {
        request = JSON.parse(requestContent);
    } catch (error) {
        console.log(error);
        onReject('invalidJson');
        return;
    }

    if (
        !request ||
        !request.id ||
        !request.payload ||
        !request.payload.chain ||
        !request.payload.method ||
        (request.payload.method === Actions.INJECTED_CALL &&
            !request.payload.params)
    ) {
        console.log('invalid request format');
        onReject('invalidFormat');
        return;
    }

    if (chain !== request.payload.chain) {
        console.log('Incoming request for wrong chain');
        onReject('wrongChain');
        return;
    }

    if (
        !Object.keys(Actions)
            .map((key) => Actions[key])
            .includes(request.payload.method)
    ) {
        console.log('Unsupported request type rejected');
        onReject('unsupportedMethod');
        return;
    }

    if (!blockchainActions.includes(request.payload.method)) {
        console.log({
            msg: 'Unsupported request type rejected',
            request,
        });
        onReject('unsupportedMethod');
        return;
    }

    if (request.payload.method === Actions.INJECTED_CALL) {
        let authorizedUse = false;
        if (BTS_FAMILY.includes(chain)) {
            let tr;
            try {
                tr = await blockchain._parseTransactionBuilder(
                    request.payload.params
                );
            } catch (error) {
                console.log(error);
            }
            if (!tr) {
                onReject('invalidTransaction');
                return;
            }
            if (tr) {
                for (let i = 0; i < tr.operations.length; i++) {
                    let operation = tr.operations[i];
                    if (settingsRows && settingsRows.includes(operation[0])) {
                        authorizedUse = true;
                        break;
                    }
                }
            }
        } else if (VAULTA_FAMILY.includes(chain)) {
            if (request.payload.params && request.payload.params.length > 1) {
                let actions;
                let esrRequest = null;
                let esrResolved = null;

                const txData = request.payload.params[1];
                const isEsr = request.payload.encoding === 'esr' || isEsrEncoded(txData);

                if (isEsr) {
                    try {
                        esrRequest = decodeEsr(txData);

                        const rawActions = esrRequest.getRawActions();
                        const firstAuth = rawActions[0]?.authorization?.[0];
                        const isPlaceholderSigner = firstAuth
                            && String(firstAuth.actor) === '............1';

                        const nodeUrl = _chainNodes[chain];
                        if (!isPlaceholderSigner && blockchain && nodeUrl) {
                            try {
                                esrResolved = await resolveEsrRequest(
                                    esrRequest, chain, nodeUrl, blockchain
                                );
                            } catch (resolveErr) {
                                console.log({ error: resolveErr, location: 'parseRequest.esr.resolve' });
                            }
                        }

                        actions = esrResolved
                            ? esrResolved.resolvedActions
                            : rawActions.map((a) => ({
                                account: String(a.account),
                                name: String(a.name),
                                authorization: (a.authorization || []).map((auth) => ({
                                    actor: String(auth.actor),
                                    permission: String(auth.permission),
                                })),
                                data: a.data,
                            }));

                        request._esrRequest = esrRequest;
                        request._esrResolved = esrResolved;
                        request._resolvedSigner = esrResolved
                            ? String(esrResolved.resolvedActions[0]?.authorization?.[0]?.actor || '')
                            : '';
                        request._encoding = 'esr';
                    } catch (error) {
                        console.log({ error, location: 'parseRequest.esr.decode' });
                        onReject('invalidTransaction');
                        return;
                    }
                } else {
                    try {
                        const tx = JSON.parse(txData);
                        actions = tx.actions;

                        const hasPlaceholderAuth = actions && actions.some(a =>
                            a.authorization && a.authorization.some(auth =>
                                auth.actor === '............1' || auth.actor === '............2'
                            )
                        );
                        if (hasPlaceholderAuth) {
                            request._nullJson = true;
                        }
                    } catch (error) {
                        console.log({ error, location: 'parseRequest.VAULTA.parse' });
                        onReject('invalidTransaction');
                        return;
                    }
                }

                if (actions) {
                    const allowUnknown = settingsRows && settingsRows.includes('customOperations');
                    for (let i = 0; i < actions.length; i++) {
                        let operation = actions[i];
                        const opName = operation.name;
                        if (
                            settingsRows &&
                            settingsRows.includes(opName)
                        ) {
                            authorizedUse = true;
                            break;
                        }
                        if (
                            allowUnknown &&
                            !isKnownOperation(opName)
                        ) {
                            authorizedUse = true;
                            break;
                        }
                    }
                }
            }
        } else if (HIVE_FAMILY.includes(chain)) {
            if (request.payload.params && request.payload.params.length > 1) {
                let operations;
                try {
                    const parsed = JSON.parse(request.payload.params[1]);
                    operations = parsed.operations || parsed.actions;
                } catch (error) {
                    console.log({ error, location: 'parseRequest.HIVE.parse' });
                    onReject('invalidTransaction');
                    return;
                }

                if (operations) {
                    for (let i = 0; i < operations.length; i++) {
                        const opName = Array.isArray(operations[i])
                            ? operations[i][0]
                            : operations[i].name;
                        if (settingsRows && settingsRows.includes(opName)) {
                            authorizedUse = true;
                            break;
                        }
                    }
                }
            }
        }

        if (!authorizedUse) {
            console.log(
                `Unauthorized use of ${chain} blockchain operation`
            );
            onReject('outsideScope');
            return;
        }
        console.log('Authorized request');
    }

    return {
        id: uuidv4(),
        requestId: String(request.id),
        type: request.payload.method,
        payload: request.payload,
    };
}

/**
 * Handles blockchain API requests from the renderer process.
 *
 * This is the primary handler for the `blockchainRequest` IPC channel.
 * It dispatches to the appropriate blockchain API method based on the
 * requested methods array.
 *
 * Supported methods:
 *   - `calculateFee` — Calculate transaction fee
 *   - `supportsLocal` — Check if local signing is supported
 *   - `supportsQR` — Check if QR code processing is supported
 *   - `supportsWeb` — Check if web-based signing is supported
 *   - `getBalances` — Fetch account balances
 *   - `verifyMessage` — Verify a signed message
 *   - `getExplorer` — Get blockchain explorer URL
 *   - `getAccessType` — Get account access type
 *   - `getSignUpInput` — Get sign-up input requirements
 *   - `getImportOptions` — Get key import options
 *   - `getOperationTypes` — Get supported operation types
 *   - `broadcastTransaction` — Broadcast a signed transaction
 *   - `localFileUpload` — Process a local .bin file upload
 *   - `getRawLink` — Process a raw deep link (rawbeetvault://)
 *   - `processQR` — Process a QR code scan
 *   - `verifyAccount` — Verify account keys match
 *   - `verifyCloudAccount` — Verify cloud-backed account keys
 *   - `decryptBackup` — Decrypt and import a wallet backup
 *
 * @param {Electron.IpcMainEvent} event - The IPC event.
 * @param {object} arg - The request arguments.
 * @param {string[]} arg.methods - Array of method names to execute.
 * @param {object} [arg.account] - Account object with `name` or `accountName`.
 * @param {string} [arg.accountname] - Account name for verification methods.
 * @param {string} arg.chain - The blockchain identifier.
 * @param {string} [arg.node] - Custom RPC node URL to use.
 * @param {object} [arg.operation] - Operation data for fee/broadcast methods.
 * @param {object} [arg.request] - Request data for verifyMessage.
 * @param {string[]} [arg.allowedOperations] - User-authorized operations.
 * @param {string} [arg.qrChoice] - QR browser choice.
 * @param {string} [arg.qrData] - QR code data string.
 * @param {string} [arg.fileData] - File content for local upload.
 * @param {string} [arg.requestBody] - URL-encoded request envelope from a raw deep link.
 * @param {string} [arg.filePath] - File path for backup decryption.
 * @param {string} [arg.pass] - Password for backup/cloud account verification.
 * @param {boolean} [arg.legacy] - Whether to use legacy key derivation.
 * @param {string[]} [arg.authorities] - Key authorities for verification.
 * @returns {Promise<object>} Response object containing the results of
 *   all requested methods.
 */
export async function handleBlockchainRequest(event, arg) {
    const senderFrame = event.senderFrame;
    if (!senderFrame || !validateSender(senderFrame)) {
        throw new Error('Unauthorized');
    }
    const { methods, account, accountname, chain, node } = arg;

    console.log({ methods, accountname, chain });

    if (node) {
        _chainNodes[chain] = node;
    }

    let blockchain;
    try {
        blockchain = await getBlockchainAPIImport(chain, _chainNodes[chain] || null);
    } catch (error) {
        console.log(error);
    }

    if (!blockchain || !methods || !methods.length) {
        console.log('Unable to perform blockchain request');
        return;
    }

    let blockchainActions = [Actions.INJECTED_CALL];

    let responses = {
        chain,
    };

    if (methods.includes('calculateFee')) {
        const { operation } = arg;
        let fee;
        try {
            fee = await blockchain.calculateFee(operation);
        } catch (error) {
            console.log({ error, location: 'calculateFee' });
        }

        if (fee) {
            responses['calculateFee'] = fee;
        }
    }

    if (methods.includes('supportsLocal')) {
        responses['supportsLocal'] = blockchain.supportsLocal();
    }

    if (methods.includes('supportsQR')) {
        responses['supportsQR'] = blockchain.supportsQR();
    }

    if (methods.includes('supportsWeb')) {
        responses['supportsWeb'] = blockchain.supportsWeb();
    }

    if (methods.includes('getBalances')) {
        const _usr = account.name ? account.name : account.accountName;
        let _balances;
        try {
            _balances = await blockchain.getBalances(_usr);
        } catch (error) {
            console.log({ error, location: 'getBalances', user: _usr });
        }

        if (_balances) {
            responses['getBalances'] = JSON.stringify(_balances);
        }
    }

    if (methods.includes('verifyMessage')) {
        const { request } = arg;
        let _verifyMessage;
        try {
            _verifyMessage = await blockchain.verifyMessage(request);
        } catch (error) {
            console.log({ error, location: 'verifyMessage' });
        }
        if (_verifyMessage) {
            responses['verifyMessage'] = _verifyMessage;
        }
    }

    if (methods.includes('getExplorer')) {
        let _explorer;
        try {
            _explorer = await blockchain.getExplorer({
                accountName: account.name ? account.name : account.accountName,
                chain,
            });
        } catch (error) {
            console.log({ error, location: 'getExplorer' });
        }

        if (_explorer) {
            responses['getExplorer'] = _explorer;
        }
    }

    if (methods.includes('getAccessType')) {
        responses['getAccessType'] = blockchain.getAccessType();
    }

    if (methods.includes('getSignUpInput')) {
        responses['getSignUpInput'] = blockchain.getSignUpInput();
    }

    if (methods.includes('getImportOptions')) {
        responses['getImportOptions'] = blockchain.getImportOptions();
    }

    if (methods.includes('getOperationTypes')) {
        let _opTypes;
        try {
            _opTypes = await blockchain.getOperationTypes();
        } catch (error) {
            console.log({ error, location: 'getOperationTypes' });
        }
        if (_opTypes) {
            responses['getOperationTypes'] = _opTypes;
        }
    }

    if (methods.includes('broadcastTransaction')) {
        const { operation } = arg;
        let broadcastResponse;
        try {
            broadcastResponse = await blockchain.broadcast(operation);
        } catch (error) {
            const errData = {
                code: error.code,
                message: error.message || 'Transaction broadcast failed',
                data: error.data,
                digest: error.digest,
                transaction: error.transaction,
                location: 'broadcast',
            };
            const err = new Error(errData.message);
            err.message = JSON.stringify(errData);
            throw err;
        }
        if (broadcastResponse) {
            responses['broadcastTransaction'] = broadcastResponse;
        }
    }

    if (methods.includes('getRequiredSignatures')) {
        const { operation, availableKeys } = arg;
        if (typeof blockchain.getRequiredSignatures === 'function') {
            try {
                responses['getRequiredSignatures'] = await blockchain.getRequiredSignatures(operation, availableKeys);
            } catch (error) {
                console.log({ error, location: 'getRequiredSignatures' });
                throw error;
            }
        }
    }

    if (methods.includes('localFileUpload')) {
        const { allowedOperations, fileData } = arg;
        try {
            let apiobj;
            if (typeof fileData !== 'string' || fileData.length > MAX_JSON_UPLOAD_SIZE) {
                responses['localFileUploadError'] = 'tooLarge';
            } else {
                try {
                    apiobj = await parseRequest(
                        fileData,
                        chain,
                        blockchain,
                        blockchainActions,
                        allowedOperations,
                        (reason) => { responses['localFileUploadError'] = reason; }
                    );
                } catch (error) {
                    console.log(error);
                }
            }

            if (apiobj && apiobj.type === Actions.INJECTED_CALL) {
                const win = getMainWindow ? getMainWindow() : null;
                let status;
                try {
                    status = await inject(
                        blockchain,
                        apiobj,
                        win ? win.webContents : null,
                        allowedOperations,
                        account
                    );
                } catch (error) {
                    console.log({ error: error || 'No status' });
                }

                if (
                    status &&
                    status.result &&
                    !status.result.isError &&
                    !status.result.canceled
                ) {
                    responses['localFileUpload'] = status.result;
                } else {
                    // Declined by the user, or signing/broadcast failed (which shows its own error popup)
                    responses['localFileUploadError'] = 'notCompleted';
                }
            }
        } catch (error) {
            console.log({ error });
        }
    }

    if (methods.includes('getRawLink')) {
        const { requestBody, allowedOperations } = arg;

        // The query string is already decoded once in the main process; links
        // that were URL-encoded twice still need a second pass.
        let requestContent;
        if (typeof requestBody === 'string' && requestBody.trimStart().startsWith('{')) {
            requestContent = requestBody;
        } else {
            try {
                requestContent = decodeURIComponent(requestBody);
            } catch (error) {
                console.log({ error, location: 'getRawLink.decode' });
            }
        }

        let apiobj;
        if (typeof requestContent === 'string') {
            try {
                apiobj = await parseRequest(
                    requestContent,
                    chain,
                    blockchain,
                    blockchainActions,
                    allowedOperations
                );
            } catch (error) {
                console.log({ error, location: 'getRawLink.parse' });
            }
        }

        if (apiobj && apiobj.type === Actions.INJECTED_CALL) {
            const win = getMainWindow ? getMainWindow() : null;
            let status;
            try {
                status = await inject(
                    blockchain,
                    apiobj,
                    win ? win.webContents : null,
                    allowedOperations,
                    account
                );
            } catch (error) {
                console.log({ error: error || 'No status' });
            }

            if (
                status &&
                status.result &&
                !status.result.isError &&
                !status.result.canceled
            ) {
                responses['getRawLink'] = status.result;
            }
        }
    }

    if (methods.includes('processQR')) {
        const { qrChoice, qrData, allowedOperations } = arg;

        let apiobj = null;

        if (VAULTA_FAMILY.includes(chain) && isEsrEncoded(qrData)) {
            try {
                const esrRequest = decodeEsr(qrData);
                const rawActions = esrRequest.getRawActions();

                let authorizedUse = false;
                for (const action of rawActions) {
                    const opName = String(action.name);
                    if (allowedOperations && allowedOperations.includes(opName)) {
                        authorizedUse = true;
                        break;
                    }
                    const allowUnknown = allowedOperations && allowedOperations.includes('customOperations');
                    if (allowUnknown && !isKnownOperation(opName)) {
                        authorizedUse = true;
                        break;
                    }
                }

                if (authorizedUse) {
                    apiobj = {
                        type: Actions.INJECTED_CALL,
                        id: uuidv4(),
                        payload: {
                            origin: 'localhost',
                            appName: 'qr',
                            browser: qrChoice,
                            params: ['signAndBroadcast', qrData, []],
                            encoding: 'esr',
                            chain: chain,
                        },
                    };
                }
            } catch (error) {
                console.log({ error, location: 'processQR.esr' });
            }
        } else {
            let parsedData;
            try {
                parsedData = JSON.parse(qrData);
            } catch (error) {
                console.log({ error, location: 'processQR.parse' });
                return responses;
            }
            let authorizedUse = false;
            if (BTS_FAMILY.includes(chain)) {
                const ops = parsedData.operations[0].operations;
                for (let i = 0; i < ops.length; i++) {
                    let operation = ops[i];
                    if (
                        allowedOperations &&
                        allowedOperations.includes(operation[0])
                    ) {
                        authorizedUse = true;
                        break;
                    }
                }
            } else if (VAULTA_FAMILY.includes(chain)) {
                const ops = parsedData.actions;
                for (let i = 0; i < ops.length; i++) {
                    let operation = ops[i];
                    if (
                        allowedOperations &&
                        allowedOperations.includes(operation.name)
                    ) {
                        authorizedUse = true;
                        break;
                    }
                    const allowUnknown = allowedOperations && allowedOperations.includes('customOperations');
                    if (allowUnknown && !isKnownOperation(operation.name)) {
                        authorizedUse = true;
                        break;
                    }
                }
            } else if (HIVE_FAMILY.includes(chain)) {
                const ops = parsedData.operations || parsedData.actions;
                for (let i = 0; i < ops.length; i++) {
                    const opName = Array.isArray(ops[i]) ? ops[i][0] : ops[i].name;
                    if (allowedOperations && allowedOperations.includes(opName)) {
                        authorizedUse = true;
                        break;
                    }
                }
            }

            if (authorizedUse) {
                let qrTX;
                try {
                    qrTX = BTS_FAMILY.includes(chain)
                        ? await blockchain.handleQR(
                            JSON.stringify(parsedData.operations[0])
                        )
                        : parsedData;
                } catch (error) {
                    console.log({ error, location: 'background' });
                }

                apiobj = {
                    type: Actions.INJECTED_CALL,
                    id: uuidv4(),
                    payload: {
                        origin: 'localhost',
                        appName: 'qr',
                        browser: qrChoice,
                        params: BTS_FAMILY.includes(chain)
                            ? qrTX.toObject()
                            : ['signAndBroadcast', qrTX, []],
                        chain: chain,
                    },
                };
            }
        }

        if (apiobj) {
            console.log('Authorized use of QR codes');

            const win = getMainWindow ? getMainWindow() : null;
            let status;
            try {
                status = await inject(
                    blockchain,
                    apiobj,
                    win ? win.webContents : null,
                    allowedOperations,
                    account
                );
            } catch (error) {
                console.log({ error, location: 'processQR' });
            }

            if (
                status &&
                status.result &&
                !status.result.isError &&
                !status.result.canceled
            ) {
                responses['qrData'] = status.result;
            }
        }
    }

    if (methods.includes('verifyAccount')) {
        const { accountname, authorities } = arg;
        let account;
        let error;
        try {
            account = await blockchain.verifyAccount(
                accountname,
                authorities,
                chain
            );
        } catch (e) {
            console.log(e);
            error = e;
        }

        if (account) {
            const token = storePendingKey(accountname, chain, authorities);
            responses['verifyAccount'] = { account, token };
        } else if (error) {
            responses['verifyAccountError'] = error;
        }
    }

    if (methods.includes('verifyCloudAccount')) {
        const { accountname, pass, legacy } = arg;

        const active_seed = accountname + 'active' + pass;
        const owner_seed = accountname + 'owner' + pass;
        const memo_seed = accountname + 'memo' + pass;

        let authorities;
        try {
            authorities = legacy
                ? {
                      active: PrivateKey.fromSeed(active_seed).toWif(),
                      memo: PrivateKey.fromSeed(active_seed).toWif(),
                      owner: PrivateKey.fromSeed(owner_seed).toWif(),
                }
                : {
                      active: PrivateKey.fromSeed(active_seed).toWif(),
                      memo: PrivateKey.fromSeed(memo_seed).toWif(),
                      owner: PrivateKey.fromSeed(owner_seed).toWif(),
                };
        } catch (error) {
            console.log(error);
        }

        if (authorities) {
            let account;
            let error;
            try {
                account = await blockchain.verifyAccount(
                    accountname,
                    authorities
                );
            } catch (e) {
                console.log(e);
                error = e;
            }

            if (account) {
                const token = storePendingKey(accountname, chain, authorities);
                responses['verifyCloudAccount'] = { account, token };
            } else if (error) {
                responses['verifyCloudAccountError'] = error;
            }
        }
    }

    if (methods.includes('decryptBackup')) {
        const { fileData, filePath, pass } = arg;

        let _data;
        if (fileData) {
            if (fileData.length > MAX_BACKUP_FILE_SIZE) {
                console.log('Backup file too large');
            } else {
                try {
                    _data = Buffer.isBuffer(fileData) ? fileData : Buffer.from(fileData);
                } catch (error) {
                    console.log({ error });
                }
            }
        } else if (filePath) {
            try {
                _data = await readFileSecure(filePath);
            } catch (error) {
                console.log({ error });
            }
        }

        if (_data) {
            const wh = new BTSWalletHandler(_data);

            let unlocked;
            try {
                unlocked = await wh.unlock(pass);
            } catch (error) {
                console.log({ error });
            }

            if (unlocked) {
                let retrievedAccounts;
                try {
                    retrievedAccounts = await blockchain.lookupAccounts(
                        wh.public,
                        wh.keypairs
                    );
                } catch (error) {
                    console.log({ error });
                }

                if (retrievedAccounts) {
                    for (let account of retrievedAccounts) {
                        const accountKeys = {};
                        if (account.active && account.active.key) {
                            accountKeys.active = account.active.key;
                            delete account.active.key;
                        }
                        if (account.owner && account.owner.key) {
                            accountKeys.owner = account.owner.key;
                            delete account.owner.key;
                        }
                        if (account.memo && account.memo.key) {
                            accountKeys.memo = account.memo.key;
                            delete account.memo.key;
                        }
                        if (Object.keys(accountKeys).length > 0) {
                            account._vaultToken = storePendingKey(account.name, chain, accountKeys);
                        }
                    }
                    responses['decryptBackup'] = retrievedAccounts;
                }
            }
        }
    }

    return responses;
}
