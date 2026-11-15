// src/services/onlineMusic/qishui/direct/feed.ts
// Separate recommendation queues keep scene switches and exploration from consuming each other's stream.
//
// A port of qishui-music-api@0.2.2 src/feed.cjs. Queue state lives in memory of
// this instance (as in the package); a fresh instance restarts each stream's
// counters, and the explore reads dedupe repeated songs on their side.

import type { QishuiDirectClient } from './client';
import { QishuiDirectError } from './client';
import { qishuiPublicTrack } from './catalog';
import { qishuiText } from './protocol';

type JsonObject = Record<string, unknown>;

export interface QishuiFeedMode {
    id: string;
    name: string;
    group: string;
    coverUrl?: unknown;
}

interface FeedQueueState {
    count: number;
    selectedAt: number;
}

export interface QishuiDirectFeed {
    clear(): void;
    modes(): Promise<QishuiFeedMode[]>;
    songs(options?: {
        scene?: string;
        preference?: string;
        queue?: string;
        first?: boolean;
        count?: number;
    }): Promise<{ items: unknown[]; hasMore: boolean }>;
}

export const createQishuiDirectFeed = (client: QishuiDirectClient): QishuiDirectFeed => {
    const queues = new Map<string, FeedQueueState>();
    let total = 0;
    let generation = 0;
    const activeKeys = new Map<string, string>();
    let pending: Promise<unknown> = Promise.resolve();
    return {
        clear() {
            generation++;
            queues.clear();
            activeKeys.clear();
            total = 0;
        },
        async modes() {
            const data = await client.platform('/feed/mode/');
            // An explicitly empty catalogue is valid; a missing one is a protocol failure the host can retry.
            if (!Array.isArray(data.feed_mode_block)) throw new QishuiDirectError('invalid-response', 'Qishui feed modes are missing');
            return (data.feed_mode_block as JsonObject[]).flatMap(block => ((block.feed_mode || []) as JsonObject[]).flatMap(item => {
                const mode = (item.entity as JsonObject | undefined)?.feed_mode as JsonObject | undefined;
                const id = (mode?.scene_mode as JsonObject | undefined)?.scene_mode_id;
                return id == null ? [] : [{
                    id: qishuiText(id),
                    name: qishuiText(mode?.text),
                    group: qishuiText(block.title),
                    coverUrl: (mode as JsonObject).url_info,
                }];
            }));
        },
        songs(options = {}) {
            const mine = generation;
            const run = async (): Promise<{ items: unknown[]; hasMore: boolean }> => {
                if (mine !== generation) throw new QishuiDirectError('unavailable', 'Qishui account changed');
                const { scene, preference, queue = 'fm', first = false, count = 20 } = options;
                // preference_mode is a short mode name such as `familiar` or `fresh`, never an object or free text.
                if (preference != null && (typeof preference !== 'string' || !/^[a-z][a-z_]{0,31}$/.test(preference))) {
                    throw new QishuiDirectError('invalid-response', 'Invalid preference');
                }
                if (scene != null && preference) throw new QishuiDirectError('invalid-response', 'Scene and preference are mutually exclusive');
                if (scene != null && (!/^\d+$/.test(scene) || !Number.isSafeInteger(Number(scene)))) {
                    throw new QishuiDirectError('invalid-response', 'Invalid scene');
                }
                const key = `${queue}:${scene ?? preference ?? 'default'}`;
                if (queues.size > 100) queues.clear();
                const previous = queues.get(key);
                const state = first || !previous || activeKeys.get(queue) !== key ? { count: 0, selectedAt: Date.now() } : previous;
                const data = await client.platform('/feed/song-tab/', {
                    played_media: [],
                    is_first_request: state.count === 0,
                    with_client_cache: state.count !== 0,
                    is_did_first_request: false,
                    count,
                    feed_preference: {
                        scene_mode_id: scene == null ? null : Number(scene),
                        scene_mode_select_time: scene == null ? null : state.selectedAt,
                        preference_mode: preference || null,
                        total_request_count: ++total,
                        preference_mode_request_count: state.count + 1,
                        current_mode_request_count: state.count + 1,
                    },
                });
                if (!Array.isArray(data.items)) throw new QishuiDirectError('invalid-response', 'Qishui feed items are missing');
                if (mine !== generation) throw new QishuiDirectError('unavailable', 'Qishui account changed');
                activeKeys.set(queue, key);
                state.count++;
                queues.set(key, state);
                return {
                    items: (data.items as unknown[]).filter(item => !item || (item as JsonObject).type == null || (item as JsonObject).type === 'track').map(qishuiPublicTrack),
                    hasMore: data.has_more === true,
                };
            };
            const result = pending.then(run, run) as Promise<{ items: unknown[]; hasMore: boolean }>;
            pending = result.catch(() => undefined);
            return result;
        },
    };
};
