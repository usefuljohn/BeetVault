import queryString from 'query-string';
import path from 'path';
import { app } from 'electron';

/**
 * URL scheme BeetVault registers for raw deep links.
 *
 * Only BeetVault's own `rawbeetvault` scheme is claimed. The `beeteos` and
 * `rawbeeteos` schemes belong to other Beet-family wallets and stay released
 * (see `legacyProtocols.js`).
 *
 * @type {string}
 */
export const DEEPLINK_SCHEME = 'rawbeetvault';

/**
 * Prefix every accepted deep link must start with.
 * @type {string}
 * @private
 */
const DEEPLINK_PREFIX = `${DEEPLINK_SCHEME}://api/`;

/**
 * Maximum accepted length of the query portion of a deep link.
 * @type {number}
 * @private
 */
const MAX_DEEPLINK_LENGTH = 4096;

/**
 * Registers BeetVault as the default handler for `rawbeetvault://` links.
 *
 * On Windows/Linux in development (unpackaged), the protocol is registered
 * with the current executable path and the launch script path so the link
 * reaches this app rather than the bare Electron binary.
 *
 * @returns {void}
 */
export function registerDeeplinkProtocol() {
    try {
        if (process.defaultApp && process.argv[1]) {
            app.setAsDefaultProtocolClient(DEEPLINK_SCHEME, process.execPath, [
                path.resolve(process.argv[1]),
            ]);
        } else {
            app.setAsDefaultProtocolClient(DEEPLINK_SCHEME);
        }
    } catch (error) {
        console.log({ error, location: 'registerDeeplinkProtocol' });
    }
}

/**
 * Validates a deep link URL and forwards its parsed query string to the
 * renderer on the `rawdeeplink` channel.
 *
 * @param {Electron.BrowserWindow|null} mainWindow - The main application window.
 * @param {string} url - The full deep link (e.g. `rawbeetvault://api/?request=...`).
 * @returns {void}
 * @private
 */
function forwardDeeplink(mainWindow, url) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        console.error('Main window is not defined.');
        return;
    }

    if (typeof url !== 'string' || !url.startsWith(DEEPLINK_PREFIX)) {
        console.log('Invalid deep link format');
        return;
    }

    const deeplinkingUrl = url.slice(DEEPLINK_PREFIX.length);
    if (!deeplinkingUrl || deeplinkingUrl.length > MAX_DEEPLINK_LENGTH) {
        console.log('Deep link URL missing or too long');
        return;
    }

    let qs;
    try {
        qs = queryString.parse(deeplinkingUrl);
    } catch (error) {
        console.log(error);
        return;
    }

    if (qs) {
        mainWindow.webContents.send('rawdeeplink', qs);
    }
}

/**
 * Handles the `second-instance` event on Windows/Linux, which fires when
 * a `rawbeetvault://` link is opened while BeetVault is already running.
 *
 * Restores and focuses the main window, then forwards the deep link
 * (if present in argv) to the renderer.
 *
 * @param {Electron.BrowserWindow|null} mainWindow - The main application window.
 * @param {string[]} argv - Command-line arguments from the second instance.
 * @returns {void}
 */
export function handleSecondInstance(mainWindow, argv) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    mainWindow.focus();

    const deeplink = Array.isArray(argv)
        ? argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${DEEPLINK_SCHEME}://`))
        : undefined;

    if (!deeplink) {
        return;
    }

    forwardDeeplink(mainWindow, deeplink);
}

/**
 * Handles the `open-url` event on macOS, which is how the OS delivers
 * `rawbeetvault://` links to a running app.
 *
 * @param {Electron.BrowserWindow|null} mainWindow - The main application window.
 * @param {string} urlString - The full deep link URL.
 * @returns {void}
 */
export function handleOpenUrl(mainWindow, urlString) {
    forwardDeeplink(mainWindow, urlString);
}
