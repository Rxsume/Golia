import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, publicEncrypt } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// test/unit/onlineMusic/neteaseWeapi.test.ts

import { weapiEncrypt } from '@/services/onlineMusic/netease/neteaseWeapi';
import { rsaRawEncrypt } from '@/utils/rsaRaw';

const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';
const NETEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

const aesCbcDecryptBase64 = (ciphertext: string, key: string): string => {
    const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(IV, 'utf8'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
};

describe('weapiEncrypt', () => {
    it('decrypts back to the payload with a fixed secret key', async () => {
        const secret = 'abcdefghijklmnop';
        const { params, encSecKey } = await weapiEncrypt({ type: 3 }, secret);
        // Outer layer: AES-CBC with the secret; inner layer: AES-CBC with the preset key.
        const inner = aesCbcDecryptBase64(params, secret);
        expect(JSON.parse(aesCbcDecryptBase64(inner, PRESET_KEY))).toEqual({ type: 3 });
        // The secret, reversed and raw-RSA-encrypted with the platform's public key: Node's
        // own no-padding RSA encryption of the same bytes must give the same hex.
        const reversed = Buffer.from(secret.split('').reverse().join(''), 'utf8');
        const padded = Buffer.alloc(128);
        reversed.copy(padded, 128 - reversed.length);
        const expected = publicEncrypt({ key: NETEASE_PUBLIC_KEY, padding: constants.RSA_NO_PADDING }, padded);
        expect(encSecKey).toBe(expected.toString('hex'));
    });

    it('mints a different secret key on every call', async () => {
        const first = await weapiEncrypt({ type: 3 });
        const second = await weapiEncrypt({ type: 3 });
        expect(first.params).not.toBe(second.params);
        expect(first.encSecKey).not.toBe(second.encSecKey);
        expect(first.encSecKey).toMatch(/^[0-9a-f]{256}$/);
    });
});

describe('rsaRawEncrypt', () => {
    it('encrypts the textbook RSA example (n=3233, e=17, m=65 -> 2790)', () => {
        // 3233 = 61 * 53, 0xca1. A 12-bit key, so the message is padded to 2 bytes.
        const encrypted = rsaRawEncrypt(new Uint8Array([65]), 'ca1', 17n);
        expect(encrypted).toBe('0ae6');
    });

    it('round-trips through a fresh keypair with no padding', () => {
        const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
        const publicJwk = publicKey.export({ format: 'jwk' });
        const modulusHex = Buffer.from(publicJwk.n as string, 'base64url').toString('hex');
        const exponent = BigInt(`0x${Buffer.from(publicJwk.e as string, 'base64url').toString('hex')}`);
        const message = new TextEncoder().encode('hello-rsa');
        const encrypted = rsaRawEncrypt(message, modulusHex, exponent);
        expect(encrypted).toMatch(/^[0-9a-f]{256}$/);
        const decrypted = privateDecrypt(
            { key: privateKey, padding: constants.RSA_NO_PADDING },
            Buffer.from(encrypted, 'hex'),
        );
        expect(Buffer.from(decrypted.subarray(decrypted.length - message.length)).toString('utf8')).toBe('hello-rsa');
    });

    it('throws where the data is longer than the key', () => {
        expect(() => rsaRawEncrypt(new Uint8Array([1, 2, 3]), 'ca1', 17n)).toThrow();
    });
});
