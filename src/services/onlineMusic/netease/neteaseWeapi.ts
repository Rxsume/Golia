// src/services/onlineMusic/netease/neteaseWeapi.ts
// The platform's weapi request encryption, ported from the bundled API backend
// (NeteaseCloudMusicApi util/crypto.js): the request body is AES-CBC encrypted twice — once with
// the fixed preset key, once with a random 16-character secret — and that secret is RSA-encrypted
// with the platform's public key. Only public constants are copied here; no secret is involved.
// WebCrypto does the AES; the RSA step is raw modular exponentiation (see utils/rsaRaw.ts).

import { rsaRawEncrypt } from '../../../utils/rsaRaw';

const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// The platform's public RSA key (1024-bit, exponent 65537), as published in the backend's source.
const PUBLIC_MODULUS_HEX = 'e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';

const textEncoder = new TextEncoder();

const toBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return btoa(binary);
};

const aesCbcBase64 = async (text: string, key: string): Promise<string> => {
    const subtle = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto.subtle : undefined;
    if (!subtle) throw new Error('NetEase weapi encryption needs WebCrypto (crypto.subtle)');
    const cryptoKey = await subtle.importKey(
        'raw',
        textEncoder.encode(key),
        { name: 'AES-CBC' },
        false,
        ['encrypt'],
    );
    const encrypted = await subtle.encrypt(
        { name: 'AES-CBC', iv: textEncoder.encode(IV) },
        cryptoKey,
        textEncoder.encode(text),
    );
    return toBase64(new Uint8Array(encrypted));
};

const randomSecretKey = (): string => {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => BASE62[byte % BASE62.length]).join('');
};

export interface WeapiEncrypted {
    params: string;
    encSecKey: string;
}

/**
 * Encrypt one weapi request body. The payload is the plain JSON object the backend would send;
 * the answer is the params and encSecKey form fields of the POST to the platform's /weapi/ URL.
 * `secretKey` is a testing seam: a fixed 16-character secret makes the encryption deterministic.
 */
export const weapiEncrypt = async (
    payload: Record<string, unknown>,
    secretKey: string = randomSecretKey(),
): Promise<WeapiEncrypted> => {
    const once = await aesCbcBase64(JSON.stringify(payload), PRESET_KEY);
    const params = await aesCbcBase64(once, secretKey);
    const reversed = secretKey.split('').reverse().join('');
    const encSecKey = rsaRawEncrypt(textEncoder.encode(reversed), PUBLIC_MODULUS_HEX);
    return { params, encSecKey };
};
