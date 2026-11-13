// src/utils/rsaRaw.ts
// Raw RSA encryption (no padding): the message, left-padded with zero bytes to the key length,
// raised to the public exponent modulo the public modulus. Some music-service request signatures
// use exactly this (their server-side libraries call it RSA with 'NONE' padding); the modulus
// here is always a public key, never a secret.

const hexToBigInt = (hex: string): bigint => BigInt(`0x${hex}`);

const modPow = (base: bigint, exponent: bigint, modulus: bigint): bigint => {
    let result = 1n;
    let current = base % modulus;
    let remaining = exponent;
    while (remaining > 0n) {
        if (remaining & 1n) result = (result * current) % modulus;
        remaining >>= 1n;
        current = (current * current) % modulus;
    }
    return result;
};

/**
 * Raw-RSA-encrypt `data` with the public key (`modulusHex`, `exponent`, default 65537).
 * Returns lower-case hex, padded to the key length. Throws where the data is longer than the key.
 */
export const rsaRawEncrypt = (data: Uint8Array, modulusHex: string, exponent = 65537n): string => {
    const modulus = hexToBigInt(modulusHex);
    const keyLength = Math.ceil(modulus.toString(2).length / 8);
    if (data.length > keyLength) throw new Error('RSA raw encryption: data is longer than the key');
    const padded = new Uint8Array(keyLength);
    padded.set(data, keyLength - data.length);
    const message = hexToBigInt(Array.from(padded, byte => byte.toString(16).padStart(2, '0')).join(''));
    return modPow(message, exponent, modulus).toString(16).padStart(keyLength * 2, '0');
};
