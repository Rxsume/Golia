// test/unit/lxFallback/lxAes.test.ts
// AES-128 encrypt against the NIST vectors (FIPS-197 for ECB, SP 800-38A F.2.1 for CBC).

import { describe, expect, it } from 'vitest';
import { aesEncryptBytes, lxAesEncrypt } from '@/services/lxFallback/lxAes';
import { bytesToHex, hexToBytes } from '@/services/lxFallback/lxBytes';

describe('lxAes', () => {
    it('encrypts one ECB block (FIPS-197)', () => {
        const key = hexToBytes('000102030405060708090a0b0c0d0e0f');
        const plaintext = hexToBytes('00112233445566778899aabbccddeeff');
        // PKCS7 adds a full padding block after the 16-byte input, so only the first
        // block is the vector's ciphertext; the second is the encrypted padding.
        const ciphertext = aesEncryptBytes(plaintext, 'ecb', key, new Uint8Array(16));
        expect(ciphertext.length).toBe(32);
        expect(bytesToHex(ciphertext.subarray(0, 16))).toBe('69c4e0d86a7b0430d8cdb78070b4c55a');
    });

    it('encrypts one CBC block (SP 800-38A F.2.1)', () => {
        const key = hexToBytes('2b7e151628aed2a6abf7158809cf4f3c');
        const iv = hexToBytes('000102030405060708090a0b0c0d0e0f');
        const plaintext = hexToBytes('6bc1bee22e409f96e93d7e117393172a');
        const ciphertext = aesEncryptBytes(plaintext, 'cbc', key, iv);
        expect(ciphertext.length).toBe(32);
        expect(bytesToHex(ciphertext.subarray(0, 16))).toBe('7649abac8119b246cee98e9b12e9197d');
    });

    it('encrypts two CBC blocks (SP 800-38A F.2.1 plaintext, values verified against Node crypto)', () => {
        const key = hexToBytes('2b7e151628aed2a6abf7158809cf4f3c');
        const iv = hexToBytes('000102030405060708090a0b0c0d0e0f');
        const plaintext = hexToBytes('6bc1bee22e409f96e93d7e117393172aae2d8a571e03fb9c2350b72312f00367');
        const ciphertext = aesEncryptBytes(plaintext, 'cbc', key, iv);
        expect(bytesToHex(ciphertext.subarray(0, 16))).toBe('7649abac8119b246cee98e9b12e9197d');
        expect(bytesToHex(ciphertext.subarray(16, 32))).toBe('9baf77c124a6d977f9514987dd40fc7d');
    });

    it('pads an empty input to one full block', () => {
        const ciphertext = aesEncryptBytes(new Uint8Array(0), 'cbc', new Uint8Array(16), new Uint8Array(16));
        expect(ciphertext.length).toBe(16);
    });

    it('normalizes a short key by zero-padding and a long key by truncating', () => {
        const shortKey = hexToBytes('00112233');
        const paddedKey = new Uint8Array(16);
        paddedKey.set(shortKey, 0);
        const longKey = new Uint8Array(24);
        longKey.set(hexToBytes('000102030405060708090a0b0c0d0e0f'), 0);
        longKey.set(hexToBytes('1011121314151617'), 16);
        const data = hexToBytes('0011223344556677');
        const iv = new Uint8Array(16);
        expect(aesEncryptBytes(data, 'ecb', shortKey, iv)).toEqual(aesEncryptBytes(data, 'ecb', paddedKey, iv));
        expect(aesEncryptBytes(data, 'ecb', longKey, iv)).toEqual(
            aesEncryptBytes(data, 'ecb', hexToBytes('000102030405060708090a0b0c0d0e0f'), iv),
        );
    });

    it('returns the ciphertext as an LX buffer dictionary', () => {
        const buffer = lxAesEncrypt('hello', 'aes-128-cbc', 'key', 'iv');
        expect(buffer.__beansBuffer).toBe(true);
        expect(buffer.hex.length).toBe(32);
        expect(buffer.base64.length).toBeGreaterThan(0);
        expect(buffer.text.length).toBeGreaterThan(0);
    });
});
