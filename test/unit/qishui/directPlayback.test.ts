// test/unit/qishui/directPlayback.test.ts
// The Qishui playback resolution: a full plaintext URL wins, a preview is only
// kept when the full song has none, and protected-only audio is refused.

import { describe, expect, it, vi } from 'vitest';
import { QishuiDirectError } from '@/services/onlineMusic/qishui/direct/client';
import type { QishuiDirectClient } from '@/services/onlineMusic/qishui/direct/client';
import { resolveQishuiAudio } from '@/services/onlineMusic/qishui/direct/playback';

const client = (): QishuiDirectClient => ({
    http: vi.fn(),
    platform: vi.fn(),
    command: vi.fn(),
    sessions: null as unknown as QishuiDirectClient['sessions'],
    log: vi.fn(),
    warn: vi.fn(),
});

const plain = (url: string) => ({ main_url: url, video_meta: { quality: 'medium', bitrate: 128 } });
const encrypted = (url: string) => ({ main_url: url, encrypt_info: { encrypt: true }, video_meta: { quality: 'medium', bitrate: 128 } });
const model = (items: Record<string, unknown>[]) => ({ video_model: JSON.stringify({ video_list: items }) });
const track = (player: Record<string, unknown>) => ({ base_info: { id: '1', name: 'Song' }, player_info: player });

const FULL = 'https://v26.douyinvod.com/full.mp3';
const PREVIEW = 'https://v26.douyinvod.com/preview.mp3';

describe('resolveQishuiAudio', () => {
    it('returns the full plaintext URL when the full song has one', async () => {
        const source = await resolveQishuiAudio(client(), track({
            full: { video_model_info: model([plain(FULL)]) },
            preview: { video_model_info: model([plain(PREVIEW)]) },
        }), 'high');
        expect(source.url).toBe(FULL);
        expect(source.preview).toBe(false);
    });

    it('falls back to the preview when only the preview is plaintext', async () => {
        const source = await resolveQishuiAudio(client(), track({
            full: { video_model_info: model([encrypted(FULL)]) },
            preview: { video_model_info: model([plain(PREVIEW)]) },
        }), 'high');
        expect(source.url).toBe(PREVIEW);
        expect(source.preview).toBe(true);
    });

    it('throws unsupported when only protected audio exists', async () => {
        const error = await resolveQishuiAudio(client(), track({
            full: { video_model_info: model([encrypted(FULL)]) },
        }), 'high').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(QishuiDirectError);
        expect(error).toMatchObject({ code: 'unsupported' });
    });

    it('throws not-playable when there is no player information', async () => {
        const error = await resolveQishuiAudio(client(), { base_info: { id: '1', name: 'Song' } }, 'high').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(QishuiDirectError);
        expect(error).toMatchObject({ code: 'not-playable' });
    });
});
