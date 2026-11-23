import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQqCore } from '../helpers/qqSource';

// test/unit/onlineMusic/qqDirect.test.ts

const storage = new Map<string, string>();

const MUSICU_SEARCH_ANSWER = {
    code: 0,
    request: {
        code: 0,
        data: {
            body: {
                item_song: [{
                    id: 5105918, mid: '003rJSwm3TechU', title: '海阔天空', interval: 326,
                    singer: [{ id: 4558, mid: '0025NhlN2yWrP4', name: 'Beyond' }],
                    album: { id: 8112, mid: '0016l2F430zMux', name: '乐与怒' },
                }],
            },
        },
    },
};

const nativeRequest = (data: unknown) => vi.fn().mockResolvedValue({ status: 200, headers: {}, data });

describe('QQ direct transport (no backend configured)', () => {
    beforeEach(async () => {
        vi.resetModules();
        storage.clear();
        // The direct functions live in the Folium core now, so the source env has to exist
        // (createSource) before they are called, even on paths that never raise.
        await createQqCore();
        vi.stubEnv('VITE_QQ_API_BASE', '');
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('searches songs straight from the platform', async () => {
        const request = nativeRequest(JSON.stringify(MUSICU_SEARCH_ANSWER));
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch must not be called')));
        const { searchQQSongs } = await import('../../../sources/qq/core/qqLyricProvider');

        const songs = await searchQQSongs('海阔天空');
        expect(songs).toHaveLength(1);
        // The Folium core returns FoliumSourceSong DTOs, not the host SongResult the old
        // qqLyricProvider returned: the title is `title`, the mid is the `id`.
        expect(songs[0].title).toBe('海阔天空');
        expect(songs[0].id).toBe('003rJSwm3TechU');
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
            method: 'POST',
        }));
    });

    it('falls back to the relay when the native request fails', async () => {
        const request = vi.fn().mockRejectedValue(new Error('plugin down'));
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(MUSICU_SEARCH_ANSWER), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const { searchQQSongs } = await import('../../../sources/qq/core/qqLyricProvider');

        const songs = await searchQQSongs('海阔天空');
        expect(songs).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sends musicu calls straight from the platform', async () => {
        const request = nativeRequest(JSON.stringify({ code: 0, search: { code: 0, data: { body: {} } } }));
        vi.stubGlobal('window', { Capacitor: { Plugins: { CapacitorHttp: { request } } } });
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch must not be called')));
        const { requestQqMusicu } = await import('../../../sources/qq/core/qqTransport');

        const answers = await requestQqMusicu({
            search: { module: 'music.search.SearchCgiService', method: 'DoSearchForQQMusicLite', param: { query: 'x' } },
        });
        expect(answers.search.code).toBe(0);
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
        }));
    });
});
