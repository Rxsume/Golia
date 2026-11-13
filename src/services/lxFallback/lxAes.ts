// src/services/lxFallback/lxAes.ts
// AES-128 encrypt (CBC and ECB, PKCS7 padding), a synchronous pure-TypeScript port of the
// `lx.utils.crypto.aesEncrypt` bridge Golia's runner provides. Web Crypto has no synchronous
// AES and no ECB, so this is hand-rolled; it is verified against the NIST FIPS-197 vectors
// in test/unit/lxFallback/lxAes.test.ts. Keys and IVs are normalized to 16 bytes exactly
// like the native bridge (truncate when longer, zero-pad when shorter).

import { lxBufferOf, utf8ToBytes, type LxBuffer } from './lxBytes';

// The FIPS-197 substitution box, row-major.
const SBOX: readonly number[] = [
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
];

const RCON: readonly number[] = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

const xtime = (value: number): number => ((value << 1) ^ ((value & 0x80) !== 0 ? 0x1b : 0)) & 0xff;

const mul2 = (value: number): number => xtime(value);
const mul3 = (value: number): number => xtime(value) ^ value;

/** 11 round keys (176 bytes) for a 16-byte key. */
const expandKey = (key: Uint8Array): Uint8Array => {
    const words = new Uint8Array(176);
    words.set(key.subarray(0, 16), 0);
    for (let i = 4; i < 44; i += 1) {
        let t0 = words[(i - 1) * 4];
        let t1 = words[(i - 1) * 4 + 1];
        let t2 = words[(i - 1) * 4 + 2];
        let t3 = words[(i - 1) * 4 + 3];
        if (i % 4 === 0) {
            // RotWord + SubWord + Rcon.
            const r0 = SBOX[t1] ^ RCON[i / 4 - 1];
            const r1 = SBOX[t2];
            const r2 = SBOX[t3];
            const r3 = SBOX[t0];
            t0 = r0;
            t1 = r1;
            t2 = r2;
            t3 = r3;
        }
        words[i * 4] = words[(i - 4) * 4] ^ t0;
        words[i * 4 + 1] = words[(i - 4) * 4 + 1] ^ t1;
        words[i * 4 + 2] = words[(i - 4) * 4 + 2] ^ t2;
        words[i * 4 + 3] = words[(i - 4) * 4 + 3] ^ t3;
    }
    return words;
};

const addRoundKey = (state: Uint8Array, roundKeys: Uint8Array, round: number): void => {
    const offset = round * 16;
    for (let i = 0; i < 16; i += 1) state[i] ^= roundKeys[offset + i];
};

const subBytes = (state: Uint8Array): void => {
    for (let i = 0; i < 16; i += 1) state[i] = SBOX[state[i]];
};

const shiftRows = (state: Uint8Array): void => {
    // State is column-major: state[4 * col + row]. Row r rotates left by r.
    for (let row = 1; row < 4; row += 1) {
        const tmp = [state[row], state[4 + row], state[8 + row], state[12 + row]];
        for (let col = 0; col < 4; col += 1) state[4 * col + row] = tmp[(col + row) % 4];
    }
};

const mixColumns = (state: Uint8Array): void => {
    for (let col = 0; col < 4; col += 1) {
        const base = 4 * col;
        const a0 = state[base];
        const a1 = state[base + 1];
        const a2 = state[base + 2];
        const a3 = state[base + 3];
        state[base] = mul2(a0) ^ mul3(a1) ^ a2 ^ a3;
        state[base + 1] = a0 ^ mul2(a1) ^ mul3(a2) ^ a3;
        state[base + 2] = a0 ^ a1 ^ mul2(a2) ^ mul3(a3);
        state[base + 3] = mul3(a0) ^ a1 ^ a2 ^ mul2(a3);
    }
};

const encryptBlock = (block: Uint8Array, roundKeys: Uint8Array): Uint8Array => {
    const state = new Uint8Array(block);
    addRoundKey(state, roundKeys, 0);
    for (let round = 1; round < 10; round += 1) {
        subBytes(state);
        shiftRows(state);
        mixColumns(state);
        addRoundKey(state, roundKeys, round);
    }
    subBytes(state);
    shiftRows(state);
    addRoundKey(state, roundKeys, 10);
    return state;
};

/** Key and IV exactly like the native bridge: truncate to 16 bytes, zero-pad when shorter. */
const normalize16 = (bytes: Uint8Array): Uint8Array => {
    if (bytes.length === 16) return bytes;
    if (bytes.length > 16) return bytes.subarray(0, 16);
    const out = new Uint8Array(16);
    out.set(bytes, 0);
    return out;
};

/** AES-128 encrypt of raw bytes; `mode` containing 'ecb' selects ECB, anything else is CBC. */
export const aesEncryptBytes = (data: Uint8Array, mode: string, key: Uint8Array, iv: Uint8Array): Uint8Array => {
    const roundKeys = expandKey(normalize16(key));
    const useEcb = mode.toLowerCase().includes('ecb');
    const ivBlock = normalize16(iv);
    // PKCS7: always pad, a full block when the input is already a multiple of 16.
    const pad = 16 - (data.length % 16);
    const padded = new Uint8Array(data.length + pad);
    padded.set(data, 0);
    padded.fill(pad, data.length);
    const out = new Uint8Array(padded.length);
    let previous = ivBlock;
    for (let offset = 0; offset < padded.length; offset += 16) {
        const block = padded.subarray(offset, offset + 16);
        const input = new Uint8Array(16);
        for (let i = 0; i < 16; i += 1) input[i] = useEcb ? block[i] : block[i] ^ previous[i];
        const encrypted = encryptBlock(input, roundKeys);
        out.set(encrypted, offset);
        previous = encrypted;
    }
    return out;
};

/**
 * `lx.utils.crypto.aesEncrypt(data, mode, key, iv)`: all four are UTF-8 strings; the
 * ciphertext comes back as an LX buffer dictionary (base64 / hex / text).
 */
export const lxAesEncrypt = (data: string, mode: string, key: string, iv: string): LxBuffer => (
    lxBufferOf(aesEncryptBytes(utf8ToBytes(data), mode, utf8ToBytes(key), utf8ToBytes(iv)))
);
