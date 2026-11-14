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

    it('fetches lyrics straight from the platform (lx8)', async () => {
        const request = nativeRequest({
            'music.163.com/api/song/lyric': JSON.stringify({
                code: 200,
                lrc: { lyric: '[00:16.91]变色的生活任性的挑拨\n[00:20.00]下一句\n' },
            }),
        });
        const fetchMock = vi.fn().mockRejectedValue(new Error('fetch must not be called'));
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getLyric(108485);
        expect(res.lrc?.lyric).toContain('变色的生活任性的挑拨');
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://music.163.com/api/song/lyric?id=108485&lv=-1&kv=-1&tv=-1',
            method: 'GET',
        }));
        // No backend is configured, so the backend fetch is never touched.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still uses the backend lyric endpoint when one is configured (lx8)', async () => {
        vi.stubEnv('VITE_NETEASE_API_BASE', 'https://netease.example.test');
        storage.set('online_provider:netease:cookie', 'MUSIC_U=test-cookie');
        const fetchMock = vi.fn().mockResolvedValue(Response.json({
            code: 200,
            lrc: { lyric: '[00:00.00]backend lyric\n' },
        }));
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request: vi.fn() } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getLyric(108485);
        expect(res.lrc?.lyric).toContain('backend lyric');
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('https://netease.example.test/lyric/new?id=108485'),
            expect.anything(),
        );
    });

    it('reads the account playlists straight from the platform (lx9)', async () => {
        // Shape of the live answer, 2026-11-14 (uid 306805682, anonymous: code 200,
        // 4 playlists, the first its "我喜欢的音乐", specialType 5).
        const request = nativeRequest({
            'music.163.com/weapi/user/playlist': JSON.stringify({
                code: 200,
                more: false,
                playlist: [{
                    id: 425829857, name: 'gumson喜欢的音乐', specialType: 5,
                    coverImgUrl: 'https://p1.music.126.net/cover.jpg',
                    creator: { userId: 306805682, nickname: 'gumson', avatarUrl: 'https://p1.music.126.net/avatar.jpg' },
                }],
            }),
        });
        const fetchMock = vi.fn().mockRejectedValue(new Error('fetch must not be called'));
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getUserPlaylists(306805682, 50, 0);
        expect(res.playlist).toHaveLength(1);
        expect(res.playlist[0]).toMatchObject({ name: 'gumson喜欢的音乐', specialType: 5 });
        const sent = request.mock.calls[0][0] as unknown as { url: string; method: string; data: string };
        expect(sent.url).toBe('https://music.163.com/weapi/user/playlist');
        expect(sent.method).toBe('POST');
        // weapi: the body is the encrypted params pair, not a plain query string.
        expect(sent.data).toContain('params=');
        expect(sent.data).toContain('encSecKey=');
        // No backend is configured, so the backend fetch is never touched.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reads the liked songs straight from the platform (lx9)', async () => {
        const request = nativeRequest({
            'music.163.com/weapi/song/like/get': JSON.stringify({ code: 200, ids: [186016, 123456] }),
        });
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getLikedSongs(306805682);
        expect(res.ids).toEqual([186016, 123456]);
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://music.163.com/weapi/song/like/get',
            method: 'POST',
        }));
    });

    it('reads the daily recommendations straight from the platform (lx9)', async () => {
        // Shape of the live answer, 2026-11-14 (anonymous: code 200, 30 songs in data.dailySongs).
        const request = nativeRequest({
            'music.163.com/weapi/v3/discovery/recommend/songs': JSON.stringify({
                code: 200,
                data: {
                    dailySongs: [{
                        id: 186016, name: '晴天',
                        ar: [{ id: 6452, name: '周杰伦' }],
                        al: { id: 8220, name: '叶惠美', picUrl: 'https://p1.music.126.net/cover.jpg' },
                        dt: 269000, fee: 8,
                    }],
                },
            }),
        });
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getDailyRecommendedSongs(false);
        expect(res.songs).toHaveLength(1);
        expect(res.songs[0]).toMatchObject({ name: '晴天' });
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://music.163.com/weapi/v3/discovery/recommend/songs',
            method: 'POST',
        }));
    });

    it('reads private FM straight from the platform (lx9)', async () => {
        const request = nativeRequest({
            'music.163.com/weapi/v1/radio/get': JSON.stringify({
                code: 200,
                data: [{
                    id: 186016, name: '晴天',
                    ar: [{ id: 6452, name: '周杰伦' }],
                    al: { id: 8220, name: '叶惠美', picUrl: 'https://p1.music.126.net/cover.jpg' },
                    dt: 269000, fee: 8,
                }],
            }),
        });
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getPersonalFm();
        expect(res.data).toHaveLength(1);
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://music.163.com/weapi/v1/radio/get',
            method: 'POST',
        }));
    });

    it('reads the recommended playlists straight from the platform (lx9)', async () => {
        // Shape of the live answer, 2026-11-14 (anonymous: code 200, 35 entries in result).
        const request = nativeRequest({
            'music.163.com/weapi/personalized/playlist': JSON.stringify({
                code: 200,
                result: [{ id: 1, name: '推荐歌单', picUrl: 'https://p1.music.126.net/cover.jpg' }],
            }),
        });
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getPersonalizedPlaylists(35);
        expect(res.result).toHaveLength(1);
        expect(res.result[0]).toMatchObject({ name: '推荐歌单' });
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://music.163.com/weapi/personalized/playlist',
            method: 'POST',
        }));
    });

    it('still uses the backend for the account playlists when one is configured (lx9)', async () => {
        vi.stubEnv('VITE_NETEASE_API_BASE', 'https://netease.example.test');
        storage.set('online_provider:netease:cookie', 'MUSIC_U=test-cookie');
        const fetchMock = vi.fn().mockResolvedValue(Response.json({
            code: 200,
            playlist: [{ id: 425829857, name: 'gumson喜欢的音乐', specialType: 5 }],
        }));
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request: vi.fn() } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getUserPlaylists(306805682, 50, 0);
        expect(res.playlist).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('https://netease.example.test/user/playlist?uid=306805682'),
            expect.anything(),
        );
    });

    it('reads a playlist\'s tracks straight from the platform (lx10)', async () => {
        // The backend's /playlist/track/all does the same two steps (upstream
        // module/playlist_track_all.js): v6/playlist/detail for the track ids,
        // then v3/song/detail for the page's songs. Shapes of the live answers,
        // 2026-11-14 (public playlist 3778678, 200 tracks).
        const request = nativeRequest({
            'music.163.com/weapi/v6/playlist/detail': JSON.stringify({
                code: 200,
                playlist: {
                    id: 3778678, name: '热歌榜', trackCount: 200,
                    trackIds: Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i })),
                },
            }),
            'music.163.com/weapi/v3/song/detail': JSON.stringify({
                code: 200,
                songs: Array.from({ length: 5 }, (_, i) => ({
                    id: 1010 + i, name: `Song ${1010 + i}`,
                    ar: [{ id: 1, name: 'Singer' }],
                    al: { id: 1, name: 'Album', picUrl: 'https://p1.music.126.net/cover.jpg' },
                    dt: 200000, fee: 0,
                })),
                privileges: Array.from({ length: 5 }, (_, i) => ({ id: 1010 + i, fee: 0 })),
            }),
        });
        const fetchMock = vi.fn().mockRejectedValue(new Error('fetch must not be called'));
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        // Page 3 of 5 (offset 10, limit 5): the ids come from the detail's trackIds.
        const res = await neteaseApi.getPlaylistTracks(3778678, 5, 10);
        expect(res.songs).toHaveLength(5);
        expect(res.songs.map((song: { id: number }) => song.id)).toEqual([1010, 1011, 1012, 1013, 1014]);
        const urls = request.mock.calls.map(call => (call[0] as { url: string }).url);
        expect(urls).toEqual([
            'https://music.163.com/weapi/v6/playlist/detail',
            'https://music.163.com/weapi/v3/song/detail',
        ]);
        for (const call of request.mock.calls) {
            const sent = call[0] as unknown as { method: string; data: string };
            expect(sent.method).toBe('POST');
            expect(sent.data).toContain('params=');
            expect(sent.data).toContain('encSecKey=');
        }
        // No backend is configured, so the backend fetch is never touched.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns an empty page for an empty playlist (lx10)', async () => {
        const request = nativeRequest({
            'music.163.com/weapi/v6/playlist/detail': JSON.stringify({
                code: 200, playlist: { id: 1, name: 'Empty', trackCount: 0, trackIds: [] },
            }),
        });
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getPlaylistTracks(1, 50, 0);
        expect(res.songs).toEqual([]);
        // No ids, so the song/detail step is never asked for.
        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://music.163.com/weapi/v6/playlist/detail',
        }));
    });

    it('hands a refusing detail answer back (lx10)', async () => {
        const request = nativeRequest({
            'music.163.com/weapi/v6/playlist/detail': JSON.stringify({ code: 403, msg: 'no such playlist' }),
        });
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const { neteaseApi } = await import('@/services/onlineMusic/netease/netease');

        const res = await neteaseApi.getPlaylistTracks(1, 50, 0);
        expect(res.code).toBe(403);
        // The refusal is the detail's own verdict: the song/detail step is not asked for,
        // and the provider's refusal check throws the right error from this answer.
        expect(request).toHaveBeenCalledTimes(1);
    });
});
