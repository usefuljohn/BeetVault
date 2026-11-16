import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';

/**
 * URL schemes that earlier BeetVault builds registered for deep links but
 * that BeetVault no longer handles. They are listed so the handler
 * registrations can be released for other Beet-family wallets.
 *
 * `rawbeetvault` is intentionally absent: it is still handled
 * (see `deeplink.js`) and must not be released here.
 * @type {string[]}
 */
const LEGACY_SCHEMES = ['beeteos', 'rawbeeteos', 'beetvault'];

/**
 * Matches desktop entry ids belonging to BeetVault (e.g. `beetvault.desktop`).
 * Other wallets such as `beeteos.desktop` never match.
 * @type {RegExp}
 */
const BEETVAULT_DESKTOP_ID = /beetvault[^;]*\.desktop$/i;

/**
 * Returns the mimeapps.list files that can hold per-user URL scheme defaults.
 *
 * @returns {string[]} Existing file paths.
 * @private
 */
function getMimeappsFiles() {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const candidates = [
        path.join(configHome, 'mimeapps.list'),
        path.join(os.homedir(), '.local', 'share', 'applications', 'mimeapps.list'),
    ];

    try {
        for (const name of fs.readdirSync(configHome)) {
            if (name.endsWith('-mimeapps.list')) {
                candidates.push(path.join(configHome, name));
            }
        }
    } catch (error) {
        // Config dir missing or unreadable - nothing to scan
    }

    return candidates.filter((file) => fs.existsSync(file));
}

/**
 * Removes BeetVault desktop ids from legacy scheme entries in a mimeapps.list
 * file. Entries owned by other applications are left untouched.
 *
 * @param {string} file - Path to a mimeapps.list file.
 * @returns {boolean} True if the file was rewritten.
 * @private
 */
function releaseFromMimeappsFile(file) {
    const original = fs.readFileSync(file, 'utf-8');
    const schemeKeys = LEGACY_SCHEMES.map((scheme) => `x-scheme-handler/${scheme}`);

    const lines = [];
    for (const line of original.split('\n')) {
        const eq = line.indexOf('=');
        const key = eq > -1 ? line.slice(0, eq).trim() : null;

        if (!key || !schemeKeys.includes(key)) {
            lines.push(line);
            continue;
        }

        const ids = line
            .slice(eq + 1)
            .split(';')
            .map((id) => id.trim())
            .filter(Boolean);
        const remaining = ids.filter((id) => !BEETVAULT_DESKTOP_ID.test(id));

        if (remaining.length === ids.length) {
            lines.push(line);
        } else if (remaining.length) {
            lines.push(`${key}=${remaining.join(';')};`);
        }
    }

    const updated = lines.join('\n');
    if (updated === original) {
        return false;
    }

    fs.writeFileSync(file, updated, 'utf-8');
    return true;
}

/**
 * Releases the URL scheme handler registrations made by earlier BeetVault
 * builds, so links meant for other Beet-family wallets are no longer routed
 * here. Only registrations that point at BeetVault are removed.
 *
 * Safe to call on every launch; it only writes when something changed.
 *
 * @returns {void}
 */
export function releaseLegacyProtocolClients() {
    if (process.platform === 'linux') {
        // Electron's removeAsDefaultProtocolClient is not implemented on Linux
        for (const file of getMimeappsFiles()) {
            try {
                if (releaseFromMimeappsFile(file)) {
                    console.log(`[Protocols] Released legacy scheme handlers in ${file}`);
                }
            } catch (error) {
                console.log({ error, location: 'releaseLegacyProtocolClients', file });
            }
        }
        return;
    }

    // Earlier Windows builds registered with the launch path as an argument
    const argVariants = [[]];
    if (process.platform === 'win32' && process.argv[1]) {
        try {
            argVariants.push([path.resolve(process.argv[1])]);
        } catch (error) {
            console.log(error);
        }
    }

    for (const scheme of LEGACY_SCHEMES) {
        for (const args of argVariants) {
            try {
                if (app.isDefaultProtocolClient(scheme, process.execPath, args)) {
                    app.removeAsDefaultProtocolClient(scheme, process.execPath, args);
                    console.log(`[Protocols] Released legacy scheme handler: ${scheme}`);
                }
            } catch (error) {
                console.log({ error, location: 'releaseLegacyProtocolClients', scheme });
            }
        }
    }
}
