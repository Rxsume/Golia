import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/capacitorHttp.test.ts

import { hasNativeHttp, requestNativeHttp } from '@/services/onlineMusic/capacitorHttp';

describe('requestNativeHttp', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('prefers the native bridge where the shell has one', async () => {
        const request = vi.fn().mockResolvedValue({ status: 200, headers: { 'x-test': '1' }, data: '{"a":1}' });
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        expect(hasNativeHttp()).toBe(true);
        const response = await requestNativeHttp('https://example.test/search', { method: 'GET' });
        expect(response).toEqual({ status: 200, headers: { 'x-test': '1' }, bodyText: '{"a":1}', ok: true });
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://example.test/search',
            method: 'GET',
            responseType: 'text',
        }));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('falls back to fetch where there is no native bridge', async () => {
        vi.stubGlobal('window', undefined);
        const fetchMock = vi.fn().mockResolvedValue(new Response('{"b":2}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        expect(hasNativeHttp()).toBe(false);
        const response = await requestNativeHttp('https://example.test/search', { method: 'POST', body: '{"q":1}' });
        expect(response.status).toBe(200);
        expect(response.bodyText).toBe('{"b":2}');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to fetch when the native request fails', async () => {
        const request = vi.fn().mockRejectedValue(new Error('plugin down'));
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const response = await requestNativeHttp('https://example.test/search');
        expect(response.bodyText).toBe('ok');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
