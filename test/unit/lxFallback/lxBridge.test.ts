// The LX bridge end-to-end: a script that asks `lx.request` for a URL gets one back.
// The network is stubbed (no live backend): the fetch the bridge falls back to
// returns a canned Hbd-style answer.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.7.28';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LxScriptRuntime } from '@/services/lxFallback/lxRuntime';

const MINIMAL_SCRIPT = `
lx.on('request', async ({ action, source, info }) => {
    if (action !== 'musicUrl') return Promise.reject('unsupported');
    const musicInfo = info.musicInfo;
    const id = musicInfo.id || musicInfo.songmid || musicInfo.hash;
    const res = await new Promise((resolve, reject) => {
        lx.request('https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=' + id + '&br=320', { method: 'GET' }, (err, resp) => {
            if (err) reject(new Error(err.message || 'request failed'));
            else resolve(resp);
        });
    });
    const body = res.body;
    if (body && body.url) return body.url;
    throw new Error('no url');
});
lx.send('inited', { status: true, openDevTools: false, sources: { wy: { name: 'wy', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] } } });
`;

describe('LxScriptRuntime bridge', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('resolves a NetEase URL via a script', async () => {
        const payload = JSON.stringify({ url: 'https://m801.music.126.net/fake.mp3', br: 320, size: 1 });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(payload, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })));
        const runtime = new LxScriptRuntime({ id: 'hbd', name: 'hbd-test', source: MINIMAL_SCRIPT });
        const url = await runtime.resolveMusicUrl('wy', {
            id: '1907766514',
            title: '11',
            artist: '队长',
            album: '',
            source: 'wy',
        } as never, '320k', 8000);
        expect(url).toBe('https://m801.music.126.net/fake.mp3');
    }, 30000);
});
