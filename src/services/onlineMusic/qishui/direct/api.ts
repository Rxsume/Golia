// src/services/onlineMusic/qishui/direct/api.ts
// The direct Qishui API: one operation in, the package's bridge result out.
//
// A port of qishui-music-api@0.2.2 src/api.cjs `request()`, with the session
// store and the catalogue/feed/library/playback pieces wired to the renderer
// client. Public operations never accept an arbitrary host, token, raw request
// or signing key: only the operations below, with validated parameters.

import type { QishuiDirectClient } from './client';
import { createQishuiDirectClient, QishuiDirectError } from './client';
import { createQishuiDirectAuth } from './auth';
import { createQishuiDirectCatalog, qishuiPublicTrack } from './catalog';
import { createQishuiDirectFeed } from './feed';
import { createQishuiDirectLibrary } from './library';
import { resolveQishuiAudio } from './playback';
import { createQishuiDirectSessionStore } from './sessionStore';
import { isAccountId, isQishuiDeviceId, qishuiText } from './protocol';

// Host-neutral contract: the transport reads only the bridge result shape, as with the desktop bridge.
export type QishuiDirectOperation =
    | 'login_status' | 'logout' | 'login_qr_key' | 'login_qr_create'
    | 'login_qr_check' | 'login_qr_cancel' | 'search' | 'search_playlists' | 'song_detail'
    | 'audio' | 'lyrics' | 'user_playlists' | 'playlist_detail' | 'playlist_tracks'
    | 'artist_detail' | 'artist_songs' | 'feed' | 'feed_modes'
    | 'liked_songs' | 'like_song' | 'playlist_add_tracks' | 'playlist_remove_tracks'
    | 'recent_played' | 'check_tracks' | 'dislike_song';

export const QISHUI_DIRECT_OPERATIONS: readonly QishuiDirectOperation[] = [
    'login_status', 'logout', 'login_qr_key', 'login_qr_create', 'login_qr_check', 'login_qr_cancel',
    'search', 'search_playlists', 'song_detail', 'audio', 'lyrics', 'user_playlists', 'playlist_detail', 'playlist_tracks',
    'artist_detail', 'artist_songs', 'feed', 'feed_modes',
    'liked_songs', 'like_song', 'playlist_add_tracks', 'playlist_remove_tracks', 'recent_played', 'check_tracks', 'dislike_song',
];

export type QishuiDirectParams = Record<string, unknown>;

export type QishuiDirectBridgeResult<T = unknown> = { ok: true; data: T } | {
    ok: false;
    error: {
        code: 'unsupported' | 'invalid-response' | 'auth-required' | 'unavailable' | 'network' | 'not-playable';
        message: string;
        upstreamCode?: string;
        stage?: 'access-code' | 'ticket' | 'account';
    };
};

export interface QishuiDirectApi {
    request<T = unknown>(operation: QishuiDirectOperation, params?: QishuiDirectParams | null): Promise<QishuiDirectBridgeResult<T>>;
}

export const createQishuiDirectApi = (options: {
    client?: QishuiDirectClient;
    log?: (message: string) => void;
    warn?: (message: string) => void;
} = {}): QishuiDirectApi => {
    const sessions = createQishuiDirectSessionStore();
    if (!isQishuiDeviceId(sessions.deviceId)
        || (options.client && options.client.sessions.deviceId !== sessions.deviceId)) {
        throw new TypeError('A valid device ID and session repository are required');
    }
    const log = typeof options.log === 'function' ? options.log : console.info;
    const warn = typeof options.warn === 'function' ? options.warn : typeof options.log === 'function' ? options.log : console.warn;
    const resolvedClient = options.client ?? createQishuiDirectClient({ sessions, log, warn });
    const catalog = createQishuiDirectCatalog(resolvedClient);
    const feed = createQishuiDirectFeed(resolvedClient);
    const library = createQishuiDirectLibrary(resolvedClient);
    const auth = createQishuiDirectAuth(resolvedClient, {
        log,
        // A newly authorized account starts a fresh stream.
        onSignOut: () => { feed.clear(); },
    });

    return {
        async request<T = unknown>(operation: QishuiDirectOperation, raw: QishuiDirectParams | null = {}): Promise<QishuiDirectBridgeResult<T>> {
            try {
                if (!QISHUI_DIRECT_OPERATIONS.includes(operation)) throw new QishuiDirectError('unsupported', 'Unsupported Qishui operation');
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new QishuiDirectError('invalid-response', 'Invalid Qishui parameters');
                const limit = Math.min(typeof raw.limit === 'number' ? raw.limit : 30, 100);
                const offset = typeof raw.offset === 'number' ? raw.offset : 0;
                if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0 || offset > 50000) {
                    throw new QishuiDirectError('invalid-response', 'Invalid Qishui page');
                }
                const p: { limit: number; offset: number; id?: string; query?: string } = { limit, offset };
                const idOf = (value: unknown): string => {
                    if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) throw new QishuiDirectError('invalid-response', 'Invalid Qishui media ID');
                    return value;
                };
                if (['song_detail', 'audio', 'lyrics', 'playlist_detail', 'playlist_tracks', 'artist_detail', 'artist_songs'].includes(operation)) {
                    p.id = idOf(raw.id);
                }
                if (raw.ownerId && !isAccountId(raw.ownerId)) throw new QishuiDirectError('invalid-response', 'Invalid Qishui owner ID');
                if (operation.startsWith('search')) {
                    if (typeof raw.query !== 'string' || raw.query.length > 500) throw new QishuiDirectError('invalid-response', 'Invalid Qishui search');
                    p.query = raw.query.trim();
                }
                if (operation.startsWith('login_qr_') && operation !== 'login_qr_key'
                    && (typeof raw.key !== 'string' || !/^[a-f0-9]{32}$/.test(raw.key))) {
                    throw new QishuiDirectError('invalid-response', 'Invalid QR key');
                }
                let data: unknown;
                // The account in force, normalized the same way at both ends: a
                // signed-out session reads as null, never as undefined.
                const nowUser = (): string | null => sessions.get()?.userId || null;
                const userId = nowUser();
                switch (operation) {
                    case 'login_qr_key': data = await auth.start(); break;
                    case 'login_qr_create': data = auth.qr(qishuiText(raw.key)); break;
                    case 'login_qr_check':
                        data = await auth.check(qishuiText(raw.key));
                        // A newly authorized account starts a fresh stream and invalidates guest reads in flight.
                        if ((data as { state?: string }).state === 'confirmed') feed.clear();
                        break;
                    case 'login_qr_cancel': auth.cancel(qishuiText(raw.key)); data = null; break;
                    case 'login_status': data = await auth.status(); break;
                    case 'logout': auth.logout(); feed.clear(); data = null; break;
                    case 'song_detail': data = qishuiPublicTrack(await catalog.track(p.id as string)); break;
                    case 'lyrics': {
                        const track = await catalog.track(p.id as string);
                        const display = track.display_info as Record<string, unknown> | undefined;
                        data = display?.lyric_info || {};
                        break;
                    }
                    case 'audio': {
                        if (!['standard', 'high', 'lossless', 'hires'].includes(qishuiText(raw.quality))) {
                            throw new QishuiDirectError('invalid-response', 'Invalid Qishui audio quality');
                        }
                        data = await resolveQishuiAudio(resolvedClient, await catalog.track(p.id as string), qishuiText(raw.quality));
                        break;
                    }
                    case 'playlist_detail': case 'playlist_tracks': {
                        data = await catalog.playlist_tracks({
                            id: p.id as string,
                            ownerId: qishuiText(raw.ownerId),
                            limit,
                            offset,
                        });
                        if (operation === 'playlist_detail') data = (data as { collection?: unknown }).collection || null;
                        break;
                    }
                    case 'feed_modes': data = await feed.modes(); break;
                    case 'feed': data = await feed.songs({
                        scene: raw.scene as string | undefined,
                        preference: raw.preference as string | undefined,
                        queue: raw.queue === 'explore' ? 'explore' : 'fm',
                        first: raw.first === true,
                        count: limit,
                    }); break;
                    case 'liked_songs': data = await library.likedSongs(); break;
                    // Edits shift playlist rows, so remembered page cursors are dropped even if the edit fails.
                    case 'like_song':
                        try { await library.likeSong({ id: idOf(raw.id), liked: raw.liked }); } finally { catalog.forgetPlaylist(); }
                        data = null;
                        break;
                    case 'playlist_add_tracks': case 'playlist_remove_tracks': {
                        const id = idOf(raw.id);
                        try {
                            await library.editPlaylist({
                                operation: operation === 'playlist_add_tracks' ? 'add' : 'remove',
                                id,
                                ids: raw.ids,
                            });
                        } finally { catalog.forgetPlaylist(id); }
                        data = null;
                        break;
                    }
                    case 'recent_played': data = await library.recentPlayed({ limit, offset }); break;
                    case 'check_tracks': data = await library.checkTracks({ ids: raw.ids }); break;
                    case 'dislike_song':
                        if (typeof raw.disliked !== 'boolean') throw new QishuiDirectError('invalid-response', 'Invalid Qishui dislike');
                        await library.dislikeSong({ id: idOf(raw.id), disliked: raw.disliked });
                        data = null;
                        break;
                    case 'search': case 'search_playlists': {
                        const query = qishuiText(p.query);
                        data = query === '' ? { items: [], hasMore: false, nextOffset: offset } : operation === 'search_playlists'
                            ? await catalog.search_playlists({ query, limit, offset })
                            : await catalog.search({ query, limit, offset });
                        break;
                    }
                    case 'user_playlists': data = await catalog.user_playlists({ limit, offset }); break;
                    case 'artist_detail': data = await catalog.artist_detail({ id: p.id as string }); break;
                    case 'artist_songs': data = await catalog.artist_songs({ id: p.id as string, limit, offset }); break;
                    default: throw new QishuiDirectError('unsupported', 'Unsupported Qishui operation');
                }
                if (!['logout', 'login_status', 'login_qr_check'].includes(operation) && nowUser() !== userId) {
                    throw new QishuiDirectError('unavailable', 'Qishui account changed during the request');
                }
                return { ok: true, data: data as T };
            } catch (error) {
                // Only safe protocol errors cross the boundary. Fetch exceptions may embed credential-bearing URLs.
                if (error instanceof QishuiDirectError && typeof operation === 'string' && operation.startsWith('login')) {
                    warn(`[Qishui] Sign-in operation failed: ${[error.code, error.stage, error.upstreamCode].filter(Boolean).join(' ')}`);
                }
                if (error instanceof QishuiDirectError) {
                    return {
                        ok: false,
                        error: {
                            code: error.code,
                            message: error.message,
                            upstreamCode: error.upstreamCode,
                            stage: error.stage,
                        },
                    };
                }
                return { ok: false, error: { code: 'invalid-response', message: 'Qishui operation failed' } };
            }
        },
    };
};
