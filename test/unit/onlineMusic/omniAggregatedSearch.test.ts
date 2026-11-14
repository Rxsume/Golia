import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { omni } from '@/services/onlineMusic/omni';
import { registerOnlineMusicProvider, unregisterOnlineMusicProvider } from '@/services/onlineMusic/providerRegistry';
import { neteaseProvider } from '@/services/onlineMusic/netease/neteaseProvider';
import { qqProvider } from '@/services/onlineMusic/qq/qqProvider';
import { kugouProvider } from '@/services/onlineMusic/kugou/kugouProvider';
import type { UnifiedSong } from '@/types';
import type { OnlineMusicProvider, ProviderCapabilities } from '@/types/onlineMusic';

// test/unit/onlineMusic/omniAggregatedSearch.test.ts
// 聚合单曲搜索：一次问所有声明了聚合的平台，结果并进一个列表；一家失败不拖垮整体，
// 同一家同一首歌只留一条，不同平台的同名歌各留各的。

const capabilities: ProviderCapabilities = {
    search: true, playback: false, lyrics: false, auth: false, userLibrary: false,
    playlists: false, albums: false, artists: false, recommendations: false,
    mutations: false, wordByWordLyrics: false,
};

const song = (owner: string, mediaId: string, name = `${owner}:${mediaId}`): UnifiedSong => ({
    id: mediaId,
    name,
    artists: [],
    album: { id: '', name: '' },
    durationMs: 1,
    sourceRef: { kind: 'online', providerId: owner, mediaId },
});

const provider = (
    id: string,
    searchSongs: NonNullable<OnlineMusicProvider['search']>['searchSongs'],
    overrides: Partial<OnlineMusicProvider> = {},
): OnlineMusicProvider => ({
    id,
    displayName: id,
    capabilities,
    normalizeSong: raw => song(id, String((raw as { id?: string }).id || '1')),
    search: { searchSongs },
    ...overrides,
});

const ids = ['agg-a', 'agg-b', 'agg-c', 'agg-d'];

// The provider a merged song came from: its source ref names it (online songs only here).
const providerOf = (item: UnifiedSong): string => (
    item.sourceRef.kind === 'online' ? item.sourceRef.providerId : item.sourceRef.kind
);
const keyOf = (item: UnifiedSong): string => `${providerOf(item)}:${item.sourceRef.mediaId}`;

const realAggregatedProviders = [neteaseProvider, kugouProvider, qqProvider];

// The real providers join the aggregation too: take them out so these tests only ask the
// fakes below, and put them back afterwards.
beforeEach(() => {
    realAggregatedProviders.forEach(provider => unregisterOnlineMusicProvider(provider.id));
});

afterEach(() => {
    ids.forEach(id => unregisterOnlineMusicProvider(id));
    realAggregatedProviders.forEach(provider => registerOnlineMusicProvider(provider));
    vi.restoreAllMocks();
});

describe('omni aggregated song search', () => {
    it('asks every aggregated provider at once and interleaves the answers, keeping each song\'s provider', async () => {
        registerOnlineMusicProvider(provider('agg-a', async () => ({
            items: [song('agg-a', '1'), song('agg-a', '2')], total: 10, hasMore: true, nextOffset: 2,
        }), { aggregatedSearch: true }));
        registerOnlineMusicProvider(provider('agg-b', async () => ({
            items: [song('agg-b', '1'), song('agg-b', '2')], total: 20, hasMore: true, nextOffset: 2,
        }), { aggregatedSearch: true }));
        registerOnlineMusicProvider(provider('agg-c', async () => ({
            items: [song('agg-c', '1')], total: 1, hasMore: false, nextOffset: 1,
        }), { aggregatedSearch: true }));

        const page = await omni.searchAggregatedSongs('jay', 2);

        expect(page.items.map(keyOf)).toEqual([
            'agg-a:1', 'agg-b:1', 'agg-c:1', 'agg-a:2', 'agg-b:2',
        ]);
        expect(page).toMatchObject({
            total: 31,
            hasMore: true,
            nextOffsets: { 'agg-a': 2, 'agg-b': 2 },
            providerHasMore: { 'agg-a': true, 'agg-b': true, 'agg-c': false },
        });
    });

    it('pages each provider on from its own offset', async () => {
        const searchA = vi.fn(async (_query: string, _limit: number, offset: number) => ({
            items: [song('agg-a', String(offset + 1))], total: 4, hasMore: offset + 1 < 4, nextOffset: offset + 1,
        }));
        const searchB = vi.fn(async (_query: string, _limit: number, offset: number) => ({
            items: [song('agg-b', String(offset + 1))], total: 2, hasMore: offset + 1 < 2, nextOffset: offset + 1,
        }));
        registerOnlineMusicProvider(provider('agg-a', searchA, { aggregatedSearch: true }));
        registerOnlineMusicProvider(provider('agg-b', searchB, { aggregatedSearch: true }));

        const first = await omni.searchAggregatedSongs('jay', 1);
        expect(first.nextOffsets).toEqual({ 'agg-a': 1, 'agg-b': 1 });

        const second = await omni.searchAggregatedSongs('jay', 1, first.nextOffsets);
        expect(searchA).toHaveBeenLastCalledWith('jay', 1, 1);
        expect(searchB).toHaveBeenLastCalledWith('jay', 1, 1);
        expect(second.items.map(keyOf)).toEqual(['agg-a:2', 'agg-b:2']);
        expect(second.nextOffsets).toEqual({ 'agg-a': 2 });
        expect(second.hasMore).toBe(true);

        const third = await omni.searchAggregatedSongs('jay', 1, second.nextOffsets);
        expect(searchA).toHaveBeenLastCalledWith('jay', 1, 2);
        expect(searchB).toHaveBeenCalledTimes(2);
        expect(third.items.map(keyOf)).toEqual(['agg-a:3']);
    });

    it('skips a failing provider with a warning and still returns the others', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        registerOnlineMusicProvider(provider('agg-a', async () => ({
            items: [song('agg-a', '1')], total: 1, hasMore: false, nextOffset: 1,
        }), { aggregatedSearch: true }));
        registerOnlineMusicProvider(provider('agg-b', async () => {
            throw new Error('boom');
        }, { aggregatedSearch: true }));

        const page = await omni.searchAggregatedSongs('jay', 10);

        expect(page.items.map(providerOf)).toEqual(['agg-a']);
        expect(page).toMatchObject({ total: 1, hasMore: false, nextOffsets: {} });
        expect(warn).toHaveBeenCalledWith(
            '[Omni] Aggregated search skipped a provider',
            { providerId: 'agg-b' },
            expect.any(Error),
        );
    });

    it('fails the search when every provider that was asked fails, with the first failure', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        registerOnlineMusicProvider(provider('agg-a', async () => {
            throw new Error('first failure');
        }, { aggregatedSearch: true }));
        registerOnlineMusicProvider(provider('agg-b', async () => {
            throw new Error('second failure');
        }, { aggregatedSearch: true }));

        await expect(omni.searchAggregatedSongs('jay', 10)).rejects.toThrow('first failure');
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it('does not ask providers outside the aggregation: no flag, no search, or not set up', async () => {
        const searchA = vi.fn(async () => ({ items: [song('agg-a', '1')], total: 1, hasMore: false, nextOffset: 1 }));
        const searchB = vi.fn(async () => ({ items: [song('agg-b', '1')], total: 1, hasMore: false, nextOffset: 1 }));
        const searchC = vi.fn(async () => ({ items: [song('agg-c', '1')], total: 1, hasMore: false, nextOffset: 1 }));
        const searchD = vi.fn(async () => ({ items: [song('agg-d', '1')], total: 1, hasMore: false, nextOffset: 1 }));
        registerOnlineMusicProvider(provider('agg-a', searchA, { aggregatedSearch: true }));
        registerOnlineMusicProvider(provider('agg-b', searchB));
        registerOnlineMusicProvider(provider('agg-c', searchC, {
            aggregatedSearch: true,
            capabilities: { ...capabilities, search: false },
        }));
        registerOnlineMusicProvider(provider('agg-d', searchD, {
            aggregatedSearch: true,
            getAvailability: () => ({ configured: false, reason: 'not-configured' }),
        }));

        const page = await omni.searchAggregatedSongs('jay', 10);

        expect(searchA).toHaveBeenCalledTimes(1);
        expect(searchB).not.toHaveBeenCalled();
        expect(searchC).not.toHaveBeenCalled();
        expect(searchD).not.toHaveBeenCalled();
        expect(page.items).toHaveLength(1);
    });

    it('drops a song a provider answers twice but keeps the same song from another provider', async () => {
        registerOnlineMusicProvider(provider('agg-a', async () => ({
            items: [song('agg-a', '1', 'Same Name'), song('agg-a', '1', 'Same Name')],
            total: 2, hasMore: false, nextOffset: 2,
        }), { aggregatedSearch: true }));
        registerOnlineMusicProvider(provider('agg-b', async () => ({
            items: [song('agg-b', '9', 'Same Name')], total: 1, hasMore: false, nextOffset: 1,
        }), { aggregatedSearch: true }));

        const page = await omni.searchAggregatedSongs('same name', 10);

        expect(page.items.map(keyOf)).toEqual([
            'agg-a:1', 'agg-b:9',
        ]);
    });

    it('answers an empty page with no total when no provider joins', async () => {
        const page = await omni.searchAggregatedSongs('jay', 10);
        expect(page).toEqual({ items: [], total: null, hasMore: false, nextOffsets: {}, providerHasMore: {} });
    });
});
