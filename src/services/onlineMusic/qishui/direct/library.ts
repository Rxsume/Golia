// src/services/onlineMusic/qishui/direct/library.ts
// Account reads and writes the car client exposes through /luna/v1/platform.
// Albums are not part of the car protocol: `/media/mget/` rejects type "album",
// `/search/` has no album results, and there is no album endpoint.
//
// A port of qishui-music-api@0.2.2 src/library.cjs.

import type { QishuiDirectClient } from './client';
import { QishuiDirectError } from './client';
import { qishuiPublicTrack } from './catalog';
import { qishuiText } from './protocol';

type JsonObject = Record<string, unknown>;

const MAX_BATCH = 100;
const PAGE_SIZE = 100;
const PAGE_LIMIT = 500;

const mediaId = (value: unknown): string => {
    if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) throw new QishuiDirectError('invalid-response', 'Invalid Qishui media ID');
    return value;
};

const mediaIds = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length === 0) throw new QishuiDirectError('invalid-response', 'Qishui media IDs are required');
    if (value.length > MAX_BATCH) throw new QishuiDirectError('unsupported', `Select at most ${MAX_BATCH} tracks per operation`);
    return [...new Set(value.map(mediaId))];
};

const trackRef = (id: string): { id: string; type: string } => ({ id, type: 'track' });

const booleanValue = (value: unknown): boolean => {
    if (typeof value !== 'boolean') throw new QishuiDirectError('invalid-response', 'Invalid Qishui boolean');
    return value;
};

// A missing list is a protocol failure; an explicitly empty array is a valid empty result.
const requiredList = (data: JsonObject, fields: string[], label: string): unknown[] => {
    const rows = fields.map(field => data[field]).find(Array.isArray);
    if (!rows) throw new QishuiDirectError('invalid-response', `Qishui ${label} is missing`);
    return rows as unknown[];
};

// The liked playlist is a regular playlist of type 1; its id is not fixed per account.
const likedPlaylist = async (platform: QishuiDirectClient['platform']): Promise<{ id: string; ownerId: string } | null> => {
    let cursor = '';
    const seen = new Set<string>();
    for (let count = 0; count < 20; count++) {
        seen.add(cursor);
        const data = await platform('/me/playlist/', { count: PAGE_SIZE, cursor }, true);
        const rows = requiredList(data, ['playlists', 'playlist_list'], 'account playlists');
        for (const row of rows) {
            const playlist = (((row as JsonObject | undefined)?.playlist || row || {}) as JsonObject);
            const base = (playlist.base_info || {}) as JsonObject;
            if (Number(base.type) === 1 && base.id) return { id: qishuiText(base.id), ownerId: qishuiText(base.owner_id) };
        }
        if (data.has_more !== true) return null;
        const next = qishuiText(data.next_cursor);
        if (!next || seen.has(next)) throw new QishuiDirectError('invalid-response', 'Account playlist cursor did not advance');
        cursor = next;
    }
    throw new QishuiDirectError('invalid-response', 'Account playlist page limit reached');
};

const likedSongs = async (platform: QishuiDirectClient['platform']): Promise<{ ids: string[]; whole: boolean; total: number }> => {
    const liked = await likedPlaylist(platform);
    // Not finding the liked playlist is not proof the account likes nothing; a complete empty
    // answer would let a host drop every liked song it has synced.
    if (!liked) throw new QishuiDirectError('invalid-response', 'Qishui liked playlist was not found');
    const ids = new Set<string>();
    let cursor = '';
    let whole = false;
    const seen = new Set<string>();
    for (let count = 0; count < PAGE_LIMIT; count++) {
        seen.add(cursor);
        const data = await platform('/playlist/detail/', {
            playlist_id: liked.id, owner_id: liked.ownerId, count: PAGE_SIZE, cursor, type: 1,
        });
        const media = requiredList(data, ['media_entities', 'media_list'], 'liked playlist tracks');
        for (const item of media) {
            const id = qishuiText(qishuiPublicTrack(item).id);
            if (id) ids.add(id);
        }
        if (data.has_more !== true) { whole = true; break; }
        const next = qishuiText(data.next_cursor);
        if (!next || seen.has(next)) throw new QishuiDirectError('invalid-response', 'Liked playlist cursor did not advance');
        cursor = next;
    }
    return { ids: [...ids], whole, total: ids.size };
};

const recentPlayed = async (
    platform: QishuiDirectClient['platform'],
    limit: number,
    offset: number,
): Promise<{ items: unknown[]; hasMore: boolean; nextOffset: number }> => {
    const items: unknown[] = [];
    let cursor = '';
    let consumed = 0;
    let hasMore = false;
    for (let count = 0; count < PAGE_LIMIT; count++) {
        const data = await platform('/me/recent-played/', {
            count: PAGE_SIZE, cursor, media_type: 'track', scene: 'me_tab',
        }, true);
        // A page without its list cannot also claim more pages; that would walk the cursor for nothing.
        if (!Array.isArray(data.media) && data.has_more === true) {
            throw new QishuiDirectError('invalid-response', 'Qishui recent tracks are missing');
        }
        const rows = Array.isArray(data.media) ? data.media as JsonObject[] : [];
        for (const row of rows) {
            const media = row.media as JsonObject | undefined;
            if (!media?.track_entity) continue;
            const track = qishuiPublicTrack(media);
            const rawPlayedAt = Number(row.play_start_timestamp);
            const playedAt = rawPlayedAt > 1e12 ? rawPlayedAt : rawPlayedAt * 1000;
            if (consumed >= offset && items.length < limit) {
                items.push({ ...track, ...(Number.isFinite(playedAt) && playedAt > 0 ? { playedAt } : {}) });
            }
            consumed++;
        }
        const upstreamMore = data.has_more === true;
        hasMore = consumed > offset + items.length || upstreamMore;
        if (!upstreamMore || items.length >= limit) break;
        const next = qishuiText(data.next_cursor);
        if (!next || next === cursor) throw new QishuiDirectError('invalid-response', 'Recent-played cursor did not advance');
        cursor = next;
    }
    return { items, hasMore: hasMore && items.length > 0, nextOffset: offset + items.length };
};

const checkTracks = async (
    platform: QishuiDirectClient['platform'],
    ids: string[],
): Promise<{ statuses: { id: string; riskResult: number; status: number }[] }> => {
    const data = await platform('/media/mcheck/', { media_list: ids.map(trackRef) });
    const rows = Array.isArray(data.media_status_list) ? data.media_status_list as JsonObject[] : [];
    return {
        statuses: rows.map(row => ({
            id: qishuiText(row.id),
            riskResult: Number((row.risk_info as JsonObject | undefined)?.risk_result ?? -1),
            status: Number((row.risk_info as JsonObject | undefined)?.status ?? 0),
        })),
    };
};

export interface QishuiDirectLibrary {
    likedSongs(): Promise<{ ids: string[]; whole: boolean; total: number }>;
    recentPlayed(params: { limit?: number; offset?: number }): Promise<{ items: unknown[]; hasMore: boolean; nextOffset: number }>;
    checkTracks(params: { ids: unknown }): Promise<{ statuses: { id: string; riskResult: number; status: number }[] }>;
    likeSong(params: { id: unknown; liked: unknown }): Promise<void>;
    editPlaylist(params: { operation: string; id: unknown; ids: unknown }): Promise<void>;
    dislikeSong(params: { id: unknown; disliked: unknown }): Promise<void>;
}

export const createQishuiDirectLibrary = (client: QishuiDirectClient): QishuiDirectLibrary => {
    // Bound once for the helpers below, which take the request function as a parameter.
    const platform = client.platform.bind(client);
    return {
        likedSongs: () => likedSongs(platform),
        recentPlayed: ({ limit = 30, offset = 0 }) => recentPlayed(platform, limit, offset),
        checkTracks: ({ ids }) => checkTracks(platform, mediaIds(ids)),
        async likeSong({ id, liked }) {
            const trackId = mediaId(id);
            if (booleanValue(liked)) {
                await client.command('/media/collect/', { media: [trackRef(trackId)], scene: '', collect_action: 1 });
            } else {
                await client.command('/media/cancel/collect/', { media: [trackRef(trackId)] });
            }
        },
        async editPlaylist({ operation, id, ids }) {
            const playlistId = mediaId(id);
            const tracks = mediaIds(ids);
            const path = operation === 'add' ? '/playlist/append/' : '/playlist/delete/';
            if (operation !== 'add' && operation !== 'remove') throw new QishuiDirectError('unsupported', 'Unsupported playlist operation');
            await client.command(path, { playlist_id: playlistId, media: tracks.map(trackRef) });
        },
        async dislikeSong({ id, disliked }) {
            const trackId = mediaId(id);
            await client.command('/dislike/', {
                item_id: trackId, author_ids: [], dislike_item_type: 'track', action_type: booleanValue(disliked) ? 0 : 1,
            });
        },
    };
};
