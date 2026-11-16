// src/services/onlineMusic/qishui/direct/playback.ts
// Plays only plaintext resources issued by the car service. No key extraction or CENC decryption.
//
// A port of qishui-music-api@0.2.2 src/playback.cjs.

import type { QishuiDirectClient } from './client';
import { QishuiDirectError, qishuiMediaHost, qishuiMediaUrl } from './client';

export interface QishuiDirectAudioSource {
    url: string;
    quality: 'standard' | 'high' | 'lossless' | 'hires';
    fetchedAt: number;
    expiresAt?: number;
    preview: boolean;
    clipStartMs?: number;
}

type JsonObject = Record<string, unknown>;

const levels: Record<string, 'standard' | 'high' | 'lossless' | 'hires' | undefined> = {
    medium: 'standard', higher: 'high', highest: 'high', lossless: 'lossless', hi_res: 'hires',
};
const rank = (value: string): number => ['standard', 'high', 'lossless', 'hires'].indexOf(value);
const encrypted = (item: JsonObject): boolean => Boolean(
    (item.encrypt_info as JsonObject | undefined)?.encrypt
    || (item.encrypt_info as JsonObject | undefined)?.spade_a
    || item.PlayAuth
    || Number(item.Encrypt || 0),
);

/** Resolve one track's plaintext audio address, preferring the full song and falling back to its preview clip. */
export const resolveQishuiAudio = async (
    client: QishuiDirectClient,
    track: JsonObject,
    requested: string,
): Promise<QishuiDirectAudioSource> => {
    const player = track.player_info as JsonObject | undefined;
    if (!player) throw new QishuiDirectError('not-playable', 'Qishui returned no player information');
    // One unknown CDN must not fail a song another candidate can play; refused URLs are never returned.
    const refused = new Set<string>();
    const trusted = (raw: unknown): string | null => {
        try { return qishuiMediaUrl(raw); } catch { refused.add(qishuiMediaHost(raw)); return null; }
    };
    const report = (): void => {
        if (refused.size) client.warn(`[Qishui] Skipped untrusted media hosts: ${[...refused].join(', ')}`);
    };
    for (const variant of ['full', 'preview']) {
        const info = (player[variant] as JsonObject | undefined)?.video_model_info as JsonObject | undefined;
        if (!info) continue;
        const candidates: { url: string; quality: 'standard' | 'high' | 'lossless' | 'hires'; bitrate: number }[] = [];
        let skipped = false;
        const add = (raw: unknown, quality: unknown, bitrate: unknown): void => {
            const url = trusted(raw);
            if (url) {
                candidates.push({ url, quality: levels[String(quality)] || 'standard', bitrate: Number(bitrate || 0) });
            } else skipped = true;
        };
        if (info.video_model) {
            let model: JsonObject;
            try {
                model = typeof info.video_model === 'string' ? JSON.parse(info.video_model) as JsonObject : info.video_model as JsonObject;
            } catch {
                throw new QishuiDirectError('invalid-response', 'Invalid Qishui player model');
            }
            for (const item of (model.video_list || []) as JsonObject[]) {
                if (encrypted(item) || !item.main_url) continue;
                const meta = (item.video_meta || {}) as JsonObject;
                add(item.main_url, meta.quality, meta.bitrate);
            }
        }
        if (!candidates.length && info.url_player_info) {
            const playInfo = trusted(info.url_player_info);
            if (playInfo) {
                const { data } = await client.http(playInfo);
                const list = ((data.Result as JsonObject | undefined)?.Data as JsonObject | undefined)?.PlayInfoList
                    || (data.data as JsonObject | undefined)?.PlayInfoList
                    || data.PlayInfoList;
                if (!Array.isArray(list)) throw new QishuiDirectError('invalid-response', 'Qishui PlayInfoList is missing');
                for (const item of list as JsonObject[]) {
                    if (encrypted(item) || !item.MainPlayUrl) continue;
                    add(item.MainPlayUrl, item.Quality, item.Bitrate);
                }
            } else skipped = true;
        }
        if (!candidates.length) {
            // Plaintext existed but only on refused hosts: say so rather than quietly falling back to a preview.
            if (skipped) {
                report();
                throw new QishuiDirectError('invalid-response', 'Untrusted Qishui media host');
            }
            continue;
        }
        report();
        const allowed = candidates.filter(item => rank(item.quality) <= rank(requested));
        const source = (allowed.length ? allowed : candidates)
            .sort((a, b) => rank(b.quality) - rank(a.quality) || b.bitrate - a.bitrate)[0];
        client.log(`[Qishui] Plaintext audio issued: quality=${source.quality} preview=${variant === 'preview'}`);
        const previewInfo = player.preview as JsonObject | undefined;
        const duration = previewInfo?.duration as JsonObject | undefined;
        const clipStartMs = variant === 'preview' ? Number(duration?.start_ms) : 0;
        return {
            url: source.url,
            quality: source.quality,
            fetchedAt: Date.now(),
            ...(Number(info.expire_at) > Date.now() / 1000 ? { expiresAt: Number(info.expire_at) * 1000 } : {}),
            preview: variant === 'preview',
            ...(Number.isFinite(clipStartMs) && clipStartMs > 0 ? { clipStartMs } : {}),
        };
    }
    throw new QishuiDirectError('unsupported', 'Qishui returned protected audio only; decryption is disabled');
};
