// test/unit/lxFallback/lxFallback.test.ts
// The fallback's song identity (including the tx songmid) and its first-success race.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { omni } from '@/services/onlineMusic/omni';
import {
    findTxEquivalent, firstLxSuccess, isTxEquivalent, numericSongIdFromRef, resolveLxSongIdentity, songMidFromRef,
} from '@/services/lxFallback/lxFallback';
import type { UnifiedSong } from '@/types';
import type { PlaybackSourceRef } from '@/types/onlineMusic';

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: { getSongDetail: vi.fn(), searchProviderSongs: vi.fn() },
}));

const mockedGetSongDetail = vi.mocked(omni.getSongDetail);
const mockedSearchProviderSongs = vi.mocked(omni.searchProviderSongs);

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

describe('isTxEquivalent', () => {
    const qishui = song({
        id: '7676337516358617115', name: '瞬',
        artists: [{ id: 1, name: '郑润泽' }],
        sourceRef: { kind: 'online', providerId: 'qishui', mediaId: '7676337516358617115' },
    });
    const qq = (overrides: Partial<UnifiedSong> = {}): UnifiedSong => song({
        id: 422061155, name: '瞬',
        artists: [{ id: 1, name: '郑润泽' }],
        sourceRef: {
            kind: 'online', providerId: 'qq', mediaId: '0040SY053uSb7r',
            providerData: { songMid: '0040SY053uSb7r', songId: 422061155 },
        },
        ...overrides,
    });

    it('matches the same title and artist', () => {
        expect(isTxEquivalent(qq(), qishui)).toBe(true);
    });

    it('rejects a versioned recording of the same title by the same singer', () => {
        expect(isTxEquivalent(qq({ name: '瞬 (Live)' }), qishui)).toBe(false);
    });

    it('rejects the same title by another singer', () => {
        expect(isTxEquivalent(qq({ artists: [{ id: 2, name: '小萧' }] }), qishui)).toBe(false);
    });

    it('rejects another title by the same singer', () => {
        expect(isTxEquivalent(qq({ name: '瞬 (回头再望你Speed up版)', artists: [{ id: 1, name: '郑润泽' }] }), qishui)).toBe(false);
    });
});

describe('resolveLxSongIdentity for qishui', () => {
    const qishui = song({
        id: '7676337516358617115', name: '瞬',
        artists: [{ id: 1, name: '郑润泽' }],
        sourceRef: { kind: 'online', providerId: 'qishui', mediaId: '7676337516358617115' },
    });
    const qqMatch = song({
        id: 422061155, name: '瞬',
        artists: [{ id: 1, name: '郑润泽' }],
        sourceRef: {
            kind: 'online', providerId: 'qq', mediaId: '0040SY053uSb7r',
            providerData: { songMid: '0040SY053uSb7r', mediaMid: '0006oypR46bcLX', songId: 422061155 },
        },
    });

    beforeEach(() => {
        mockedGetSongDetail.mockReset();
        mockedSearchProviderSongs.mockReset();
    });

    it('resolves a qishui song to its QQ equivalent and races as tx', async () => {
        mockedSearchProviderSongs.mockResolvedValue({ items: [qqMatch], hasMore: false, nextOffset: 0 });
        const identity = await resolveLxSongIdentity(qishui);
        expect(mockedSearchProviderSongs).toHaveBeenCalledWith('qq', '瞬 郑润泽', { limit: 10, offset: 0 });
        expect(identity).toMatchObject({ source: 'tx', songId: '422061155', songMid: '0040SY053uSb7r', mediaMid: '0006oypR46bcLX' });
        expect(mockedGetSongDetail).not.toHaveBeenCalled();
    });

    it('finds the equivalent past other singers with the same title', async () => {
        const otherSinger = song({
            id: 530448471, name: '瞬',
            artists: [{ id: 2, name: '小萧' }],
            sourceRef: {
                kind: 'online', providerId: 'qq', mediaId: '003a083F469PYj',
                providerData: { songMid: '003a083F469PYj', songId: 530448471 },
            },
        });
        mockedSearchProviderSongs.mockResolvedValue({ items: [otherSinger, qqMatch], hasMore: false, nextOffset: 0 });
        const identity = await resolveLxSongIdentity(qishui);
        expect(identity).toMatchObject({ songMid: '0040SY053uSb7r' });
    });

    it('looks the songmid up when the equivalent carries only a numeric id', async () => {
        const numericMatch = song({
            id: 422061155, name: '瞬',
            artists: [{ id: 1, name: '郑润泽' }],
            sourceRef: {
                kind: 'online', providerId: 'qq', mediaId: '422061155',
                providerData: { songId: 422061155 },
            },
        });
        mockedSearchProviderSongs.mockResolvedValue({ items: [numericMatch], hasMore: false, nextOffset: 0 });
        mockedGetSongDetail.mockResolvedValue(qqMatch);
        const identity = await resolveLxSongIdentity(qishui);
        expect(mockedGetSongDetail).toHaveBeenCalledWith('qq', 422061155);
        expect(identity).toMatchObject({ source: 'tx', songMid: '0040SY053uSb7r' });
    });

    it('returns null when QQ has no song with that title and artist', async () => {
        mockedSearchProviderSongs.mockResolvedValue({ items: [], hasMore: false, nextOffset: 0 });
        expect(await resolveLxSongIdentity(qishui)).toBeNull();
        expect(await findTxEquivalent(qishui)).toBeNull();
        expect(mockedGetSongDetail).not.toHaveBeenCalled();
    });

    it('returns null when the QQ search fails', async () => {
        mockedSearchProviderSongs.mockRejectedValue(new Error('search refused'));
        expect(await resolveLxSongIdentity(qishui)).toBeNull();
    });

    it('never sends the qishui id as a songmid', async () => {
        mockedSearchProviderSongs.mockResolvedValue({ items: [qqMatch], hasMore: false, nextOffset: 0 });
        const identity = await resolveLxSongIdentity(qishui);
        expect(identity?.songMid).not.toBe('7676337516358617115');
        expect(identity?.songId).not.toBe('7676337516358617115');
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
