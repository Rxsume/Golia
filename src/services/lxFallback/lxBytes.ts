// src/services/lxFallback/lxBytes.ts
// Byte codecs for the LX bridge (lx.utils.buffer / lx.utils.crypto): UTF-8, base64 and hex,
// kept here so the buffer and crypto helpers share one implementation.

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export const utf8ToBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

export const bytesToUtf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(bytes);

export const bytesToHex = (bytes: Uint8Array): string => {
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
};

export const hexToBytes = (text: string): Uint8Array => {
    const cleaned = text.replace(/0x/g, '').replace(/\s+/g, '');
    const padded = cleaned.length % 2 === 1 ? `0${cleaned}` : cleaned;
    const out = new Uint8Array(padded.length / 2);
    for (let i = 0; i < out.length; i += 1) {
        out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16) || 0;
    }
    return out;
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += BASE64_ALPHABET[b0 >> 2];
        out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
        out += i + 1 < bytes.length ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
        out += i + 2 < bytes.length ? BASE64_ALPHABET[b2 & 0x3f] : '=';
    }
    return out;
};

export const base64ToBytes = (text: string): Uint8Array => {
    const cleaned = text.replace(/[^A-Za-z0-9+/=]/g, '');
    const out: number[] = [];
    for (let i = 0; i + 3 < cleaned.length + 1; i += 4) {
        const chunk = cleaned.slice(i, i + 4);
        const n0 = BASE64_ALPHABET.indexOf(chunk[0]);
        const n1 = BASE64_ALPHABET.indexOf(chunk[1]);
        const n2 = chunk[2] === '=' ? 0 : BASE64_ALPHABET.indexOf(chunk[2]);
        const n3 = chunk[3] === '=' ? 0 : BASE64_ALPHABET.indexOf(chunk[3]);
        if (n0 < 0 || n1 < 0) break;
        out.push((n0 << 2) | (n1 >> 4));
        if (chunk[2] !== '=') out.push(((n1 & 0x0f) << 4) | (n2 >> 2));
        if (chunk[3] !== '=') out.push(((n2 & 0x03) << 6) | n3);
    }
    return new Uint8Array(out);
};

/** A byte buffer as the LX scripts see it: Golia's `lx.utils.buffer` dictionary shape. */
export interface LxBuffer {
    __beansBuffer: true;
    base64: string;
    hex: string;
    text: string;
}

export const lxBufferOf = (bytes: Uint8Array): LxBuffer => ({
    __beansBuffer: true,
    base64: bytesToBase64(bytes),
    hex: bytesToHex(bytes),
    text: bytesToUtf8(bytes),
});

export const lxBufferIs = (value: unknown): value is LxBuffer => (
    typeof value === 'object' && value !== null && (value as { __beansBuffer?: unknown }).__beansBuffer === true
);

/** Bytes held by a buffer dictionary, a string, or a raw byte array; null when unreadable. */
export const lxBufferBytes = (value: unknown): Uint8Array | null => {
    if (value instanceof Uint8Array) return value;
    if (typeof value === 'string') return utf8ToBytes(value);
    if (typeof value !== 'object' || value === null) return null;
    const dict = value as { base64?: unknown; hex?: unknown; text?: unknown };
    if (typeof dict.base64 === 'string' && dict.base64.length > 0) {
        const bytes = base64ToBytes(dict.base64);
        if (bytes.length > 0) return bytes;
    }
    if (typeof dict.hex === 'string' && dict.hex.length > 0) return hexToBytes(dict.hex);
    if (typeof dict.text === 'string') return utf8ToBytes(dict.text);
    return null;
};
