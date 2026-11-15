// src/services/onlineMusic/qishui/direct/catalog.ts
// Car catalogue reads preserve opaque playlist cursors and the search endpoint's fixed batch size.
//
// A port of qishui-music-api@0.2.2 src/catalog.cjs. Playlist resume cursors live
// in memory of this instance (as in the package); a fresh instance walks a
// playlist from its first page, which stays correct and only costs extra reads.

import type { QishuiDirectClient, QishuiDirectSessionStore } from './client';
import { QishuiDirectError } from './client';
import { qishuiText } from './protocol';

type JsonObject = Record<string, unknown>;
type JsonArray = unknown[];

const array = (value: unknown, field: string): JsonArray => {
    if (!Array.isArray(value)) throw new QishuiDirectError('invalid-response', `Qishui ${field} is missing`);
    return value;
};

// Player models may carry encryption material. Only catalogue and lyric data cross the boundary.
export const qishuiPublicTrack = (raw: unknown): JsonObject => {
    const record = (raw ?? {}) as JsonObject;
    const track = (record.track_entity
        || ((record.entity as JsonObject | undefined)?.media as JsonObject | undefined)?.track_entity
        || (record.entity as JsonObject | undefined)?.track
        || record.track
        || record) as JsonObject;
    const baseInfo = track.base_info as JsonObject | undefined;
    if (!baseInfo?.id && !track.id) throw new QishuiDirectError('invalid-response', 'Qishui track identity is missing');
    return {
        id: qishuiText(baseInfo?.id || track.id),
        base_info: track.base_info,
        related_info: track.related_info,
        display_info: track.display_info,
        commerce_info: track.commerce_info,
    };
};

const search = async (
    platform: QishuiDirectClient['platform'],
    query: string,
    type: 'track' | 'playlist',
    limit: number,
    offset: number,
): Promise<{ items: unknown[]; hasMore: boolean; nextOffset: number }> => {
    const items: unknown[] = [];
    const searchId = crypto.randomUUID();
    let cursor = offset;
    let more = false;
    while (items.length < limit) {
        const data = await platform('/search/', {
            q: query, cursor: String(cursor), search_id: searchId, from_search_id: searchId,
            search_method: 'input', search_type: type, search_scene: 'normal', scene_name: 'search',
            ab_param: '', last_viewed_media: {},
        });
        const groups = array(data.result_groups, 'search groups');
        const group = (groups.find(value => (value as JsonObject).id === `${type}s`) || groups[0]) as JsonObject | undefined;
        if (!group) break;
        const batch = array(group.data, 'search items')
            .map(value => ((value as JsonObject).entity as JsonObject | undefined)?.[type] as JsonObject | undefined)
            .filter((value): value is JsonObject => Boolean(value));
        const remaining = limit - items.length;
        items.push(...batch.slice(0, remaining));
        more = batch.length > remaining || group.has_more === true;
        if (!batch.length || !more || items.length === limit) break;
        const next = Number(group.next_cursor);
        if (!Number.isSafeInteger(next) || next <= cursor) throw new QishuiDirectError('invalid-response', 'Search cursor did not advance');
        cursor = next;
    }
    return { items: type === 'track' ? items.map(qishuiPublicTrack) : items, hasMore: more && items.length > 0, nextOffset: offset + items.length };
};

interface CursorMark {
    cursor: string;
    previous?: CursorMark;
}

interface CursorEntry {
    at: number;
    positions: Map<number, CursorMark>;
    collection?: JsonObject;
}

// Playlist cursors are not row numbers, so an offset is reached by walking from the beginning.
// `marks` remembers the cursor found after each row count so the next page can resume there.
const playlistPage = async (
    platform: QishuiDirectClient['platform'],
    id: string,
    ownerId: string,
    limit: number,
    offset: number,
    marks?: CursorEntry,
): Promise<{ items: unknown[]; collection?: JsonObject; hasMore: boolean; nextOffset: number }> => {
    let lineage: CursorMark = { cursor: '0' };
    let consumed = 0;
    for (const [position, mark] of marks?.positions || []) {
        if (position <= offset && position > consumed) { consumed = position; lineage = mark; }
    }
    let cursor = lineage.cursor;
    // Resume with this cursor's ancestors, not unrelated later marks.
    const seen = new Set<string>();
    for (let ancestor: CursorMark | undefined = lineage; ancestor; ancestor = ancestor.previous) seen.add(ancestor.cursor);
    const items: unknown[] = [];
    let collection = consumed ? marks?.collection : undefined;
    let hasMore = false;
    let pages = 0;
    while (items.length < limit && pages < 500) {
        pages++;
        seen.add(cursor);
        const data = await platform('/playlist/detail/', { playlist_id: id, owner_id: ownerId || '', count: 100, cursor, type: null });
        collection ||= data.playlist as JsonObject | undefined;
        if (marks && cursor === '0') marks.collection = data.playlist as JsonObject | undefined;
        const batch = array(data.media_entities, 'playlist tracks');
        const start = Math.max(0, offset - consumed);
        const remaining = limit - items.length;
        items.push(...batch.slice(start, start + remaining).map(qishuiPublicTrack));
        consumed += batch.length;
        const next = qishuiText(data.next_cursor);
        const upstreamMore = data.has_more === true;
        const unused = consumed > offset + items.length;
        hasMore = unused || upstreamMore;
        // Reject cycles before caching or returning a full page.
        if (upstreamMore && seen.has(next)) throw new QishuiDirectError('invalid-response', 'Playlist cursor did not advance');
        if (marks && upstreamMore && batch.length && next) {
            lineage = { cursor: next, previous: lineage };
            marks.positions.set(consumed, lineage);
        }
        if (!upstreamMore || items.length === limit) break;
        if (!batch.length || !next || seen.has(next)) throw new QishuiDirectError('invalid-response', 'Playlist cursor did not advance');
        cursor = next;
    }
    if (pages >= 500 && items.length < limit && hasMore) throw new QishuiDirectError('invalid-response', 'Playlist page limit reached');
    return { items, collection, hasMore: hasMore && items.length > 0, nextOffset: offset + items.length };
};

// Short-lived, per-account resume points for sequential playlist pages. Entries expire, are capped,
// are dropped after a failed walk or an edit through this API, and never outlive an account switch.
const CURSOR_TTL_MS = 5 * 60 * 1000;
const CURSOR_PLAYLISTS = 32;

const createPlaylistCursors = (sessions: QishuiDirectSessionStore): {
    get(id: string, ownerId: string): CursorEntry;
    forget(id?: string): void;
} => {
    const entries = new Map<string, CursorEntry>();
    let account: string | null = null;
    const keyOf = (id: string, ownerId: string): string => `${id}:${ownerId || ''}`;
    return {
        get(id, ownerId) {
            const user = sessions.get()?.userId || '';
            if (user !== account) { entries.clear(); account = user; }
            const key = keyOf(id, ownerId);
            let entry = entries.get(key);
            if (entry && Date.now() - entry.at > CURSOR_TTL_MS) entry = undefined;
            entries.delete(key);
            entry ||= { at: Date.now(), positions: new Map(), collection: undefined };
            entries.set(key, entry);
            while (entries.size > CURSOR_PLAYLISTS) {
                const oldest = entries.keys().next().value;
                if (oldest === undefined) break;
                entries.delete(oldest);
            }
            return entry;
        },
        forget(id) {
            for (const key of [...entries.keys()]) if (id == null || key.startsWith(`${id}:`)) entries.delete(key);
        },
    };
};

export interface QishuiDirectCatalog {
    forgetPlaylist(id?: string): void;
    search(params: { query: string; limit: number; offset: number }): Promise<{ items: unknown[]; hasMore: boolean; nextOffset: number }>;
    search_playlists(params: { query: string; limit: number; offset: number }): Promise<{ items: unknown[]; hasMore: boolean; nextOffset: number }>;
    track(id: string): Promise<JsonObject>;
    playlist_tracks(params: { id: string; ownerId: string; limit: number; offset: number }): Promise<{ items: unknown[]; collection?: JsonObject; hasMore: boolean; nextOffset: number }>;
    user_playlists(params: { limit: number; offset: number }): Promise<{ items: unknown[]; total: number; nextOffset: number; hasMore: boolean }>;
    artist_detail(params: { id: string }): Promise<unknown>;
    artist_songs(params: { id: string; limit: number; offset: number }): Promise<{ items: unknown[]; total: number; nextOffset: number; hasMore: boolean }>;
}

export const createQishuiDirectCatalog = (client: QishuiDirectClient): QishuiDirectCatalog => {
    const { sessions } = client;
    // Bound once for the helpers below, which take the request function as a parameter.
    const platform = client.platform.bind(client);
    const cursors = createPlaylistCursors(sessions);
    return {
        forgetPlaylist: id => cursors.forget(id),
        search: ({ query, limit, offset }) => search(platform, query, 'track', limit, offset),
        search_playlists: ({ query, limit, offset }) => search(platform, query, 'playlist', limit, offset),
        async track(id) {
            const data = await client.platform('/media/mget/', { media_list: [{ id, type: 'track' }], card_context: {} });
            const media = array(data.media_list, 'media list')
                .find(item => String((item as JsonObject).media_id
                    || (((item as JsonObject).track_entity as JsonObject | undefined)?.base_info as JsonObject | undefined)?.id) === id);
            const entity = (media as JsonObject | undefined)?.track_entity;
            if (!entity) throw new QishuiDirectError('not-playable', 'Qishui did not return the track');
            return entity as JsonObject;
        },
        async playlist_tracks({ id, ownerId, limit, offset }) {
            try { return await playlistPage(platform, id, ownerId, limit, offset, cursors.get(id, ownerId)); } catch (error) {
                cursors.forget(id);
                throw error;
            }
        },
        async user_playlists({ limit, offset }) {
            const items: JsonObject[] = [];
            for (const [path, field, owned] of [['/me/playlist/', 'playlists', true], ['/me/collection/mixed/', 'mixed_collections', false]] as const) {
                let cursor = '';
                const seen = new Set<string>();
                for (let page = 0; page < 500; page++) {
                    seen.add(cursor);
                    const data = await client.platform(path, { count: 100, cursor, item_types: ['playlist'] }, true);
                    const rows = array(data[field] ?? (path === '/me/playlist/' ? data.playlist_list : undefined), field);
                    for (const row of rows) {
                        const playlist = ((row as JsonObject).playlist || row) as JsonObject;
                        const base = playlist.base_info as JsonObject | undefined;
                        if (base?.id) items.push({ ...playlist, isOwned: owned });
                    }
                    if (!data.has_more) break;
                    const next = qishuiText(data.next_cursor);
                    if (!next || seen.has(next) || !rows.length || page === 499) {
                        throw new QishuiDirectError('invalid-response', 'Account playlist cursor did not advance');
                    }
                    cursor = next;
                }
            }
            const unique = [...new Map(items.map(item => [String((item.base_info as JsonObject).id), item])).values()];
            return {
                items: unique.slice(offset, offset + limit),
                total: unique.length,
                nextOffset: offset + Math.min(limit, Math.max(0, unique.length - offset)),
                hasMore: offset + limit < unique.length,
            };
        },
        async artist_detail({ id }) {
            const data = await client.platform('/artist/detail/', { artist_id: id });
            return data.artist_info;
        },
        async artist_songs({ id, limit, offset }) {
            // The car SDK reports has_more forever on empty artist pages. Its initial hot list is bounded.
            const data = await client.platform('/artist/tracks/', { artist_id: id, count: 50, cursor: '0' });
            const tracks = array(data.tracks, 'artist tracks').map(qishuiPublicTrack);
            return {
                items: tracks.slice(offset, offset + limit),
                total: tracks.length,
                nextOffset: Math.min(offset + limit, tracks.length),
                hasMore: offset + limit < tracks.length,
            };
        },
    };
};
