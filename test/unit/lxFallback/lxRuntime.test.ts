// test/unit/lxFallback/lxRuntime.test.ts
// The URL extraction and the song-identity payload the LX scripts receive.

import { describe, expect, it } from 'vitest';
import { buildLxMusicInfo, extractLxUrl } from '@/services/lxFallback/lxRuntime';

describe('extractLxUrl', () => {
    it('takes a plain URL string', () => {
        expect(extractLxUrl('https://example.com/a.mp3')).toBe('https://example.com/a.mp3');
    });

    it('adds https to a protocol-relative URL', () => {
        expect(extractLxUrl('//example.com/a.mp3')).toBe('https://example.com/a.mp3');
    });

    it('rejects a non-URL string', () => {
        expect(extractLxUrl('not a url')).toBeNull();
        expect(extractLxUrl('')).toBeNull();
    });

    it('parses a JSON string holding a URL', () => {
        expect(extractLxUrl('{"url":"https://example.com/a.mp3"}')).toBe('https://example.com/a.mp3');
        expect(extractLxUrl('{"code":0,"msg":"success","url":"https://example.com/a.mp3"}')).toBe('https://example.com/a.mp3');
    });

    it('reads the known object keys in order', () => {
        expect(extractLxUrl({ url: 'https://example.com/a.mp3' })).toBe('https://example.com/a.mp3');
        expect(extractLxUrl({ musicUrl: 'https://example.com/b.mp3' })).toBe('https://example.com/b.mp3');
        expect(extractLxUrl({ data: { url: 'https://example.com/c.mp3' } })).toBe('https://example.com/c.mp3');
        expect(extractLxUrl({ result: { playUrl: 'https://example.com/d.mp3' } })).toBe('https://example.com/d.mp3');
    });

    it('recurses into the likely containers only', () => {
        expect(extractLxUrl({ data: { music: 'https://example.com/e.mp3' } })).toBe('https://example.com/e.mp3');
        // A cover URL under an unrelated key is not picked up.
        expect(extractLxUrl({ cover: 'https://example.com/cover.jpg' })).toBeNull();
    });

    it('takes the first URL of an array', () => {
        expect(extractLxUrl(['https://example.com/a.mp3', 'https://example.com/b.mp3'])).toBe('https://example.com/a.mp3');
        expect(extractLxUrl([null, { url: 'https://example.com/b.mp3' }])).toBe('https://example.com/b.mp3');
    });

    it('returns null for anything else', () => {
        expect(extractLxUrl(null)).toBeNull();
        expect(extractLxUrl(undefined)).toBeNull();
        expect(extractLxUrl(42)).toBeNull();
        expect(extractLxUrl({})).toBeNull();
    });
});

describe('buildLxMusicInfo', () => {
    it('uses the plain song id for a wy song', () => {
        const info = buildLxMusicInfo({ source: 'wy', songId: '12345', name: 'Song', artists: 'A / B' });
        expect(info.musicId).toBe('12345');
        expect(info.id).toBe('12345');
        expect(info.hash).toBe('12345');
        expect(info.artists).toEqual(['A', 'B']);
        expect(info.source).toBe('wy');
    });

    it('uses the songmid as the primary id for a tx song', () => {
        const info = buildLxMusicInfo({
            source: 'tx', songId: '97773', songMid: '0039MnYb0qxYhV', mediaMid: '003Qui1q2u1Zho', name: '晴天', artists: '周杰伦',
        });
        expect(info.musicId).toBe('0039MnYb0qxYhV');
        expect(info.mid).toBe('0039MnYb0qxYhV');
        expect(info.songmid).toBe('0039MnYb0qxYhV');
        expect(info.mediaId).toBe('003Qui1q2u1Zho');
        expect(info.mediaMid).toBe('003Qui1q2u1Zho');
        expect(info.hash).toBe('97773');
    });

    it('falls back to the song id when a tx song has no songmid', () => {
        const info = buildLxMusicInfo({ source: 'tx', songId: '97773', name: '晴天', artists: '周杰伦' });
        expect(info.musicId).toBe('97773');
        expect(info.mid).toBe('97773');
        expect(info.mediaId).toBe('97773');
    });

    it('uses the hash for a kg song', () => {
        const info = buildLxMusicInfo({ source: 'kg', songId: 'abc123', hash: 'abc123', name: 'Song', artists: 'A' });
        expect(info.musicId).toBe('abc123');
        expect(info.hash).toBe('abc123');
    });

    it('splits artists on / & and ,', () => {
        const info = buildLxMusicInfo({ source: 'wy', songId: '1', name: 'S', artists: 'A & B, C/D' });
        expect(info.artists).toEqual(['A', 'B', 'C', 'D']);
    });
});
