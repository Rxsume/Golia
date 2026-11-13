// src/services/onlineMusic/netease/neteaseEapi.ts
// The platform's eapi request encryption, the Android-app flow the platform's own
// mobile client and the earlier 2.2.4 shell use: the request body is one AES-ECB
// encryption (key `e82ckenh8dichen8`, a published constant) of the api path, the JSON
// payload and an MD5 signature, sent as hex `params` to the platform's /eapi/ URL.
// Only public constants are copied here; no secret is involved. WebCrypto has no
// ECB, so the AES step uses the hand-rolled AES in lxFallback/lxAes.ts.
// The web (weapi) flow is refused at the QR-check step with code 8821 ("switch login
// method or upgrade"); the app (eapi) flow is the one the platform accepts there.

import md5 from 'blueimp-md5';
import { aesDecryptBytes, aesEncryptBytes } from '../../lxFallback/lxAes';

const EAPI_KEY = 'e82ckenh8dichen8';

const bytesToHex = (bytes: Uint8Array): string => {
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
};

/**
 * Encrypt one eapi request body. `apiPath` is the `/api/...` path (e.g.
 * `/api/login/qrcode/unikey`); the answer is the hex `params` form field of the
 * POST to `https://interfacepc.music.163.com/eapi/<path without /api/>`.
 * Uppercase hex, matching the earlier shell's eapi requests.
 */
export const eapiEncrypt = (apiPath: string, payload: Record<string, unknown>): string => {
    const body = JSON.stringify(payload);
    const message = `${apiPath}-36cd479b6b5-${body}-36cd479b6b5-${md5(`nobody${apiPath}use${body}md5forencrypt`)}`;
    const encrypted = aesEncryptBytes(
        new TextEncoder().encode(message),
        'ecb',
        new TextEncoder().encode(EAPI_KEY),
        new Uint8Array(16),
    );
    return bytesToHex(encrypted).toUpperCase();
};

/**
 * Decrypt one eapi answer body. The platform usually answers eapi in plain JSON,
 * but the earlier shell decrypted a hex body the same way it encrypts requests
 * (AES-ECB, key `e82ckenh8dichen8`); a hex answer lx7 cannot read would surface
 * as `invalid-response` on the QR check, so the reader falls back to this.
 * `hexBody` is the hex string with whitespace already stripped.
 */
export const eapiDecrypt = (hexBody: string): string => {
    const bytes = new Uint8Array(hexBody.length / 2);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hexBody.slice(i * 2, i * 2 + 2), 16);
    const decrypted = aesDecryptBytes(bytes, 'ecb', new TextEncoder().encode(EAPI_KEY), new Uint8Array(16));
    return new TextDecoder().decode(decrypted);
};
