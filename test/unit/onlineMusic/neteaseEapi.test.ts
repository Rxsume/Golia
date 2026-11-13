// The NetEase eapi encryption (lx3, Bug B): AES-ECB of the api path, the JSON payload
// and an MD5 signature, as uppercase hex `params`. Deterministic (no random secret,
// unlike weapi), so the same input always gives the same output. Correctness of the
// construction itself is proven live: the encrypted `login/qrcode/unikey` request
// answers code 200 with a unikey.
import { describe, expect, it } from 'vitest';
import { eapiEncrypt } from '@/services/onlineMusic/netease/neteaseEapi';

describe('eapiEncrypt', () => {
    it('is deterministic uppercase hex in whole AES blocks', () => {
        const first = eapiEncrypt('/api/login/qrcode/unikey', { type: 3 });
        const second = eapiEncrypt('/api/login/qrcode/unikey', { type: 3 });
        expect(first).toBe(second);
        expect(first).toMatch(/^[0-9A-F]+$/);
        expect(first.length % 32).toBe(0);
        expect(first.length).toBeGreaterThan(0);
    });

    it('changes with the payload', () => {
        const a = eapiEncrypt('/api/song/enhance/player/url/v1', { ids: '[1]', level: 'exhigh', encodeType: 'flac' });
        const b = eapiEncrypt('/api/song/enhance/player/url/v1', { ids: '[2]', level: 'exhigh', encodeType: 'flac' });
        expect(a).not.toBe(b);
    });
});
