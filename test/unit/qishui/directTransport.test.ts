import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/qishui/directTransport.test.ts
//
// The iOS shell's direct Qishui path: no Electron bridge, the native HTTP
// plugin carries the car-protocol requests. The upstream hosts are replaced
// by a route table on the plugin; the network never leaves the test.

import { getQishuiAvailability, getQishuiLastFailure, QishuiRequestError, requestQishui, resetQishuiTransportRuntimeCache } from '@/services/onlineMusic/qishui/qishuiTransport';
import { qishuiProvider } from '@/services/onlineMusic/qishui/qishuiProvider';

type Route = [string, { json: unknown; headers?: Record<string, string> }];

const jsonBody = (json: unknown, headers: Record<string, string> = {}) => ({ json, headers });

// One memory store per test, as the browser's lasts from session to session.
// The storage primitives look for a window before they touch localStorage,
// so every window stub below carries the same store.
const memoryStorage = () => {
    const kept = new Map<string, string>();
    return {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => { kept.set(key, value); },
        removeItem: (key: string) => { kept.delete(key); },
        clear: () => { kept.clear(); },
        key: (index: number) => Array.from(kept.keys())[index] ?? null,
        get length() { return kept.size; },
    };
};

let storage = memoryStorage();
const stubWindow = (extra: Record<string, unknown> = {}) => {
    vi.stubGlobal('window', { localStorage: storage, ...extra });
};

const installNativeHttp = (routes: Route[]) => {
    const request = vi.fn(async (options: { url: string }) => {
        for (const [needle, answer] of routes) {
            if (options.url.includes(needle)) {
                return { status: 200, headers: answer.headers ?? {}, data: JSON.stringify(answer.json) };
            }
        }
        throw new Error(`unexpected native request: ${options.url}`);
    });
    stubWindow({ Capacitor: { Plugins: { CapacitorHttp: { request } } } });
    return request;
};

const tokenRoute: Route = ['client/token/get', jsonBody({ client_token: 'tok123' })];

const searchRoute: Route = ['/search/', jsonBody({
    err_no: 0,
    data: {
        result_groups: [{
            id: 'tracks',
            has_more: false,
            data: [{ entity: { track: {
                base_info: { id: '123', title: '蜗牛', artist: [{ name: '周杰伦' }], album: { name: '七里香' }, duration: 225000, is_vip: false },
                album_url: 'https://x.test/cover.jpg',
            } } }],
        }],
    },
})];

describe('Qishui direct transport', () => {
    beforeEach(() => {
        resetQishuiTransportRuntimeCache();
        storage = memoryStorage();
        vi.stubGlobal('localStorage', storage);
        stubWindow();
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in tests')));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        storage.clear();
    });

    it('reports the shell runtime as configured and searches through native HTTP', async () => {
        const request = installNativeHttp([tokenRoute, searchRoute]);

        expect(getQishuiAvailability()).toEqual({ configured: true });
        expect(qishuiProvider.aggregatedSearch).toBe(true);
        const result = await requestQishui<{ items: Array<{ id: string; base_info: { title: string } }> }>('search', { query: '周杰伦', limit: 5, offset: 0 });
        expect(result.items).toHaveLength(1);
        expect(result.items[0].id).toBe('123');
        expect(result.items[0].base_info.title).toBe('蜗牛');
        expect(request).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('open.douyin.com') }));
    });

    it('reports the plain web runtime as unavailable', async () => {
        stubWindow();

        expect(getQishuiAvailability()).toEqual({ configured: false, reason: 'runtime-unavailable' });
        await expect(requestQishui('search', { query: '周杰伦' })).rejects.toMatchObject({ code: 'unavailable', message: 'Qishui is not available outside the app' });
    });

    it('prefers the desktop bridge where one exists', async () => {
        const qishuiRequest = vi.fn().mockResolvedValue({ ok: true, data: { items: [] } });
        const pluginRequest = vi.fn();
        stubWindow({
            electron: { qishuiRequest },
            Capacitor: { Plugins: { CapacitorHttp: { request: pluginRequest } } },
        });

        expect(getQishuiAvailability()).toEqual({ configured: true });
        await expect(requestQishui('search', { query: '周杰伦' })).resolves.toEqual({ items: [] });
        expect(qishuiRequest).toHaveBeenCalledWith('search', { query: '周杰伦' });
        expect(pluginRequest).not.toHaveBeenCalled();
    });

    it('maps an upstream auth failure from the direct API', async () => {
        installNativeHttp([tokenRoute, ['/search/', jsonBody({ err_no: 28001003, data: {} })]]);

        await expect(requestQishui('search', { query: '周杰伦' })).rejects.toBeInstanceOf(QishuiRequestError);
        await expect(requestQishui('search', { query: '周杰伦' })).rejects.toMatchObject({ code: 'auth-required', upstreamCode: '28001003' });
        expect(getQishuiLastFailure()).toBeNull();
    });

    it('runs the QR sign-in through the direct API and persists the confirmed session', async () => {
        const guardServerData = Buffer.from(JSON.stringify({ ticket: 'TICKET1', ts_sign: 'TS1', client_cert: 'CERT1' })).toString('base64');
        installNativeHttp([
            ['oauth/get_qrcode', jsonBody({ err_no: 0, data: { token: '<redacted>', qrcode: 'iVBORw0KGgo=' } })],
            ['oauth/check_qrcode', jsonBody({ err_no: 0, data: { status: 'confirmed', code: 'AUTHCODE1' } })],
            ['access/code/get', jsonBody({ err_no: 0, data: { access_code: 'AC1', open_id: 'OID1', expires_time: Math.floor(Date.now() / 1000) + 7200 } })],
            ['get_access_ticket', { json: { err_no: 0, data: {} }, headers: { 'bd-ticket-guard-server-data': guardServerData } }],
            ['/me/info/', jsonBody({ err_no: 0, data: { my_info: { id: 'u1', nickname: '测试', medium_avatar_url: 'https://x.test/a.jpg', is_vip: false } } })],
        ]);

        const { key } = await requestQishui<{ key: string }>('login_qr_key');
        expect(key).toMatch(/^[a-f0-9]{32}$/);
        const { imageUrl } = await requestQishui<{ imageUrl: string }>('login_qr_create', { key });
        expect(imageUrl).toBe('data:image/png;base64,iVBORw0KGgo=');
        await expect(requestQishui('login_qr_check', { key })).resolves.toEqual({ state: 'confirmed' });
        const status = await requestQishui<{ id: string; nickname: string } | null>('login_status');
        expect(status?.id).toBe('u1');
        expect(status?.nickname).toBe('测试');
        const stored = storage.getItem('online_provider:qishui:session');
        expect(stored).toContain('"userId":"u1"');
        expect(stored).toContain('"ticket":"TICKET1"');
    });
});
