import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/neteaseDirect.test.ts

const storage = new Map<string, string>();

const nativeRequest = (routes: Record<string, unknown>) => vi.fn(async (options: { url: string }) => {
    for (const [fragment, data] of Object.entries(routes)) {
        if (options.url.includes(fragment)) return { status: 200, headers: {}, data };
    }
    throw new Error(`unexpected native URL ${options.url}`);
});

describe('NetEase direct transport (no backend configured)', () => {
    beforeEach(() => {
        vi.resetModules();
        storage.clear();
        vi.stubEnv('VITE_NETEASE_API_BASE', '');
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        });
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch must not be called')));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('searches songs straight from the platform', async () => {
        const request = nativeRequest({
            'music.163.com/api/cloudsearch/pc': JSON.stringify({
                code: 200,
                result: {
                    songs: [{
                        id: 186016, name: '晴天',
                        ar: [{ id: 6452, name: '周杰伦' }],
                        al: { id: 8220, name: '叶惠美', picUrl: 'https://p1.music.126.net/cover.jpg' },
                        dt: 269000, fee: 8,
                    }],
                    songCount: 1,
                },
            }),
        });
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.cloudSearch('晴天', 30, 0);
        const songs = res.result?.songs;
        expect(songs).toHaveLength(1);
        expect(songs?.[0]).toMatchObject({ name: '晴天' });
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://music.163.com/api/cloudsearch/pc',
            method: 'POST',
        }));
    });

    it('takes a QR key straight from the platform', async () => {
        const request = nativeRequest({
            'interfacepc.music.163.com/eapi/login/qrcode/unikey': JSON.stringify({ code: 200, unikey: 'direct-unikey' }),
        });
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getQrKey();
        expect(res).toEqual({ code: 200, data: { unikey: 'direct-unikey' } });
        const sent = request.mock.calls[0][0] as unknown as { data: string; headers: Record<string, string> };
        // eapi sends only the hex `params` field (no weapi `encSecKey`).
        expect(sent.data).toContain('params=');
        expect(sent.data).not.toContain('encSecKey=');
        // eapi is the Android-app flow: the platform refuses the QR check with 8821
        // when the request carries a desktop UA (lx3), so it must be the app UA.
        expect(sent.headers['User-Agent']).toBe('NeteaseMusic/9.1.65.240305144431(91652404314431);Dalvik/2.1.0 (Linux; U; Android 14; Pixel 7 Build/UQ1A.240205.004)');
    });

    it('renders the QR image locally', async () => {
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request: vi.fn() } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.createQr('direct-unikey');
        expect(res.code).toBe(200);
        expect(res.data.qrurl).toBe('https://music.163.com/login?codekey=direct-unikey');
        expect(res.data.qrimg.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('checks a QR code straight from the platform', async () => {
        const request = nativeRequest({
            'interfacepc.music.163.com/eapi/login/qrcode/client/login': JSON.stringify({ code: 801, message: '等待扫码' }),
        });
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.checkQr('direct-unikey');
        expect(res.code).toBe(801);
        // The QR check is eapi too, so it carries the same Android-app UA.
        const sent = request.mock.calls[0][0] as unknown as { headers: Record<string, string> };
        expect(sent.headers['User-Agent']).toBe('NeteaseMusic/9.1.65.240305144431(91652404314431);Dalvik/2.1.0 (Linux; U; Android 14; Pixel 7 Build/UQ1A.240205.004)');
    });
});
