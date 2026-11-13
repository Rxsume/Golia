import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/neteaseDeviceCookie.test.ts
// lx8: the eapi QR sign-in carries a stable Android device identity (the earlier
// 2.2.4 shell sent its `folia_inapp_netease_cookie` jar on every request); lx7
// sent no Cookie at all on a fresh sign-in, so the platform refused the QR
// confirmation as "device environment abnormal".

const storage = new Map<string, string>();

const deviceJar = (): Record<string, unknown> => {
    const raw = storage.get('online_provider:netease:device');
    return raw ? JSON.parse(raw) as Record<string, unknown> : {};
};

describe('NetEase device cookie jar (lx8)', () => {
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

    const stubNative = (routes: Record<string, { body: string; headers?: Record<string, string> }>) => {
        const request = vi.fn(async (options: { url: string }) => {
            for (const [fragment, response] of Object.entries(routes)) {
                if (options.url.includes(fragment)) {
                    return { status: 200, headers: response.headers ?? {}, data: response.body };
                }
            }
            throw new Error(`unexpected native URL ${options.url}`);
        });
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        return request;
    };

    const sentCookie = (request: ReturnType<typeof vi.fn>, callIndex = 0): string => {
        const call = request.mock.calls[callIndex][0] as unknown as { headers: Record<string, string> };
        return call.headers.Cookie ?? '';
    };

    it('sends a device Cookie on the QR key request with no sign-in yet', async () => {
        const request = stubNative({
            'interfacepc.music.163.com/eapi/login/qrcode/unikey': {
                body: JSON.stringify({ code: 200, unikey: 'device-unikey' }),
            },
        });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getQrKey();
        expect(res).toEqual({ code: 200, data: { unikey: 'device-unikey' } });

        const cookie = sentCookie(request);
        expect(cookie).toContain('os=android');
        expect(cookie).toContain('appver=9.1.65');
        expect(cookie).toContain('osver=14');
        expect(cookie).toContain('channel=netease');
        expect(cookie).toContain('resolution=1920x1080');
        expect(cookie).toContain('mobilename=Pixel 7');
        const deviceId = /deviceId=([0-9a-f]{32})/.exec(cookie)?.[1];
        expect(deviceId).toMatch(/^[0-9a-f]{32}$/);
        expect(cookie).not.toContain('MUSIC_U');
    });

    it('reuses the same deviceId across requests (generated once, persisted)', async () => {
        const request = stubNative({
            'interfacepc.music.163.com/eapi/login/qrcode/unikey': {
                body: JSON.stringify({ code: 200, unikey: 'stable-unikey' }),
            },
        });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        await neteaseApi.getQrKey();
        await neteaseApi.getQrKey();

        const first = /deviceId=([0-9a-f]{32})/.exec(sentCookie(request, 0))?.[1];
        const second = /deviceId=([0-9a-f]{32})/.exec(sentCookie(request, 1))?.[1];
        expect(first).toBeTruthy();
        expect(second).toBe(first);
        expect(deviceJar().deviceId).toBe(first);
        expect(typeof deviceJar().buildver).toBe('string');
    });

    it('keeps buildver stable across reads (stamped once at first creation, lx8 review)', async () => {
        stubNative({
            'interfacepc.music.163.com/eapi/login/qrcode/unikey': {
                body: JSON.stringify({ code: 200, unikey: 'buildver-unikey' }),
            },
        });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        await neteaseApi.getQrKey();
        const firstBuildver = deviceJar().buildver;
        const firstDeviceId = deviceJar().deviceId;
        expect(typeof firstBuildver).toBe('string');

        await neteaseApi.getQrKey();
        expect(deviceJar().buildver).toBe(firstBuildver);
        expect(deviceJar().deviceId).toBe(firstDeviceId);
    });

    it('merges the answer NMTID into the jar and carries it on the next request', async () => {
        const request = stubNative({
            'interfacepc.music.163.com/eapi/login/qrcode/unikey': {
                body: JSON.stringify({ code: 200, unikey: 'nmtid-unikey' }),
                headers: { 'set-cookie': 'NMTID=00Oabc123; Max-Age=315360000; Domain=.music.163.com' },
            },
            'interfacepc.music.163.com/eapi/login/qrcode/client/login': {
                body: JSON.stringify({ code: 801, message: '等待扫码' }),
            },
        });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        await neteaseApi.getQrKey();
        expect(deviceJar().NMTID).toBe('00Oabc123');

        await neteaseApi.checkQr('nmtid-unikey');
        expect(sentCookie(request, 1)).toContain('NMTID=00Oabc123');
        expect(sentCookie(request, 1)).toContain('deviceId=');
    });

    it('merges the NMTID from a song-URL answer too, so the jar does not go stale after sign-in (lx8 review)', async () => {
        const request = stubNative({
            'interfacepc.music.163.com/eapi/song/enhance/player/url/v1': {
                body: JSON.stringify({ code: 200, data: [{ id: 108485, url: 'https://m801.music.126.net/song.mp3' }] }),
                headers: { 'set-cookie': 'NMTID=00Osongurl9; Max-Age=315360000; Domain=.music.163.com' },
            },
        });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getSongUrl(108485) as { data?: Array<{ url?: string }> };
        expect(res.data?.[0]?.url).toContain('m801.music.126.net');
        expect(deviceJar().NMTID).toBe('00Osongurl9');
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: expect.stringContaining('interfacepc.music.163.com/eapi/song/enhance/player/url/v1'),
        }));
    });

    it('keeps sign-in items out of the device jar (logout must not leave them behind)', async () => {
        stubNative({
            'interfacepc.music.163.com/eapi/login/qrcode/client/login': {
                body: JSON.stringify({ code: 801, message: '等待扫码' }),
                headers: { 'set-cookie': 'NMTID=n2value; Max-Age=315360000, MUSIC_U=secret123; Max-Age=86400' },
            },
        });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.checkQr('some-key');
        expect(res.code).toBe(801);
        expect(deviceJar().NMTID).toBe('n2value');
        expect(JSON.stringify(deviceJar())).not.toContain('MUSIC_U');
        expect(JSON.stringify(deviceJar())).not.toContain('secret123');
    });

    it('merges a stored sign-in cookie into the header, sign-in winning on a clash', async () => {
        storage.set('online_provider:netease:cookie', 'MUSIC_U=login123; __csrf=csrf1');
        const request = stubNative({
            'interfacepc.music.163.com/eapi/login/qrcode/unikey': {
                body: JSON.stringify({ code: 200, unikey: 'login-unikey' }),
            },
        });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        await neteaseApi.getQrKey();
        const cookie = sentCookie(request);
        expect(cookie).toContain('MUSIC_U=login123');
        expect(cookie).toContain('__csrf=csrf1');
        expect(cookie).toContain('deviceId=');
        expect(cookie).toContain('os=android');
    });

    it('reads a hex-encrypted answer body (earlier shell behaviour)', async () => {
        const { aesEncryptBytes } = await import('@/services/lxFallback/lxAes');
        const { bytesToHex } = await import('@/services/lxFallback/lxBytes');
        const key = new TextEncoder().encode('e82ckenh8dichen8');
        const hexBody = bytesToHex(
            aesEncryptBytes(
                new TextEncoder().encode('{"code":200,"unikey":"hex-unikey"}'),
                'ecb',
                key,
                new Uint8Array(16),
            ),
        ).toUpperCase();
        stubNative({
            'interfacepc.music.163.com/eapi/login/qrcode/unikey': { body: hexBody },
        });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getQrKey();
        expect(res).toEqual({ code: 200, data: { unikey: 'hex-unikey' } });
    });
});
