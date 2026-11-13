// test/unit/lxFallback/lxFallback.test.ts
// The fallback's song identity (including the tx songmid) and its first-success race.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { omni } from '@/services/onlineMusic/omni';
import {
    firstLxSuccess, numericSongIdFromRef, resolveLxSongIdentity, songMidFromRef,
} from '@/services/lxFallback/lxFallback';
import type { UnifiedSong } from '@/types';
import type { PlaybackSourceRef } from '@/types/onlineMusic';

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: { getSongDetail: vi.fn() },
}));

const mockedGetSongDetail = vi.mocked(omni.getSongDetail);

// omni.getSongDetail resolves a UnifiedSong (sourceRef required), so the
// helper builds one; callers override the fields they care about.
const song = (overrides: Partial<UnifiedSong>): UnifiedSong => ({
    id: 1,
    name: 'Song',
    artists: [{ id: 1, name: 'Artist' }],
    album: { id: '1', name: 'Album' },
    durationMs: 200000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' },
    ...overrides,
});

describe('songMidFromRef', () => {
    it('reads the songmid from providerData', () => {
        const ref: PlaybackSourceRef = {
            kind: 'online', providerId: 'qq', mediaId: '0039MnYb0qxYhV',
            providerData: { songMid: '0039MnYb0qxYhV', mediaMid: '003Qui1q2u1Zho', songId: 97773 },
        };
        expect(songMidFromRef(ref)).toEqual({ songMid: '0039MnYb0qxYhV', mediaMid: '003Qui1q2u1Zho' });
    });

    it('treats a lettered media id as the songmid', () => {
        const ref: PlaybackSourceRef = { kind: 'online', providerId: 'qq', mediaId: '0039MnYb0qxYhV' };
        expect(songMidFromRef(ref).songMid).toBe('0039MnYb0qxYhV');
    });

    it('treats a numeric media id as a song id, not a songmid', () => {
        const ref: PlaybackSourceRef = { kind: 'online', providerId: 'qq', mediaId: '97773', providerData: { songId: 97773 } };
        expect(songMidFromRef(ref)).toEqual({ songMid: '', mediaMid: '' });
    });

    it('returns empty for a non-online ref', () => {
        expect(songMidFromRef({ kind: 'local', mediaId: 'x' })).toEqual({ songMid: '', mediaMid: '' });
    });
});

describe('numericSongIdFromRef', () => {
    it('reads the numeric id from the song or the stored id', () => {
        const ref: PlaybackSourceRef = { kind: 'online', providerId: 'qq', mediaId: '97773', providerData: { songId: 97773 } };
        expect(numericSongIdFromRef(song({ id: 97773, sourceRef: ref }), ref)).toBe(97773);
    });

    it('returns null for a songmid id', () => {
        const ref: PlaybackSourceRef = { kind: 'online', providerId: 'qq', mediaId: '0039MnYb0qxYhV' };
        expect(numericSongIdFromRef(song({ id: '0039MnYb0qxYhV', sourceRef: ref }), ref)).toBeNull();
    });

    it('rejects an id above int32', () => {
        const ref: PlaybackSourceRef = { kind: 'online', providerId: 'qq', mediaId: '3000000000' };
        expect(numericSongIdFromRef(song({ id: 3000000000, sourceRef: ref }), ref)).toBeNull();
    });
});

describe('resolveLxSongIdentity', () => {
    beforeEach(() => {
        mockedGetSongDetail.mockReset();
    });

    it('maps a wy song to its numeric id', async () => {
        const identity = await resolveLxSongIdentity(song({
            id: 12345, sourceRef: { kind: 'online', providerId: 'netease', mediaId: '12345' },
        }));
        expect(identity).toMatchObject({ source: 'wy', songId: '12345' });
        expect(mockedGetSongDetail).not.toHaveBeenCalled();
    });

    it('maps a kg song to its hash', async () => {
        const identity = await resolveLxSongIdentity(song({
            id: 'abc123', kgHash: 'abc123', sourceRef: { kind: 'online', providerId: 'kugou', mediaId: 'abc123' },
        }));
        expect(identity).toMatchObject({ source: 'kg', songId: 'abc123', hash: 'abc123' });
    });

    it('takes the songmid straight from a tx song', async () => {
        const identity = await resolveLxSongIdentity(song({
            id: 97773, name: '晴天',
            sourceRef: {
                kind: 'online', providerId: 'qq', mediaId: '0039MnYb0qxYhV',
                providerData: { songMid: '0039MnYb0qxYhV', mediaMid: '003Qui1q2u1Zho', songId: 97773 },
            },
        }));
        expect(identity).toMatchObject({ source: 'tx', songId: '97773', songMid: '0039MnYb0qxYhV', mediaMid: '003Qui1q2u1Zho' });
        expect(mockedGetSongDetail).not.toHaveBeenCalled();
    });

    it('looks the songmid up by numeric id when the tx song has none', async () => {
        mockedGetSongDetail.mockResolvedValue(song({
            id: 97773, qqMid: '0039MnYb0qxYhV',
            sourceRef: {
                kind: 'online', providerId: 'qq', mediaId: '0039MnYb0qxYhV',
                providerData: { songMid: '0039MnYb0qxYhV', mediaMid: '003Qui1q2u1Zho', songId: 97773 },
            },
        }));
        const identity = await resolveLxSongIdentity(song({
            id: 97773,
            sourceRef: { kind: 'online', providerId: 'qq', mediaId: '97773', providerData: { songId: 97773 } },
        }));
        expect(mockedGetSongDetail).toHaveBeenCalledWith('qq', 97773);
        expect(identity).toMatchObject({ source: 'tx', songMid: '0039MnYb0qxYhV', mediaMid: '003Qui1q2u1Zho' });
    });

    it('gives up on a tx song with neither songmid nor numeric id', async () => {
        const identity = await resolveLxSongIdentity(song({
            id: '', sourceRef: { kind: 'online', providerId: 'qq', mediaId: '' },
        }));
        expect(identity).toBeNull();
        expect(mockedGetSongDetail).not.toHaveBeenCalled();
    });

    it('gives up when the detail lookup finds nothing', async () => {
        mockedGetSongDetail.mockResolvedValue(null);
        const identity = await resolveLxSongIdentity(song({
            id: 97773,
            sourceRef: { kind: 'online', providerId: 'qq', mediaId: '97773', providerData: { songId: 97773 } },
        }));
        expect(identity).toBeNull();
    });

    it('returns null for an unsupported provider and for a non-online song', async () => {
        expect(await resolveLxSongIdentity(song({
            sourceRef: { kind: 'online', providerId: 'spotify', mediaId: 'x' },
        }))).toBeNull();
        expect(await resolveLxSongIdentity(song({
            sourceRef: { kind: 'local', mediaId: 'x' },
        }))).toBeNull();
    });
});

describe('firstLxSuccess', () => {
    it('takes the first non-null result', async () => {
        const slow = new Promise<string | null>(resolve => setTimeout(() => resolve('slow'), 30));
        const fast = Promise.resolve('fast');
        const failing = Promise.resolve(null);
        await expect(firstLxSuccess([slow, fast, failing])).resolves.toBe('fast');
    });

    it('returns null when every attempt fails', async () => {
        await expect(firstLxSuccess([Promise.resolve(null), Promise.resolve(null)])).resolves.toBeNull();
    });

    it('treats a rejection as a failure, not a crash', async () => {
        const rejected = Promise.reject(new Error('boom'));
        await expect(firstLxSuccess([rejected, Promise.resolve('ok')])).resolves.toBe('ok');
        await expect(firstLxSuccess([Promise.reject(new Error('boom'))])).resolves.toBeNull();
    });

    it('returns null for no attempts', async () => {
        await expect(firstLxSuccess([])).resolves.toBeNull();
    });
});
