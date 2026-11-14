// test/unit/lxFallback/lxFallbackPreview.test.ts
// The LX hook on a trial clip: a provider preview is not a playable full song, so
// the scripts race for a full URL first; the trial is only kept when none has one.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyOmniAudioHook, installOmniResultHooks } from '@/services/hostExtensionHooks';
import { installLxFallbackHook } from '@/services/lxFallback/lxFallback';
import type { UnifiedSong } from '@/types';
import type { ProviderAudioSource } from '@/types/onlineMusic';

// The three scripts all resolve through this one stubbed runtime.
const { resolveMusicUrl } = vi.hoisted(() => ({
    resolveMusicUrl: vi.fn(async (): Promise<string | null> => 'https://m801.music.126.net/full.mp3'),
}));

vi.mock('@/services/lxFallback/lxRuntime', async (importOriginal) => {
    const orig = (await importOriginal()) as Record<string, unknown>;
    return {
        ...orig,
        getLxRuntime: () => ({ resolveMusicUrl }),
    };
});

const song = (): UnifiedSong => ({
    id: 1907766514,
    name: '11',
    artists: [{ id: 1143033, name: '队长' }],
    album: { id: '1', name: 'Album' },
    durationMs: 200000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1907766514' },
});

const previewSource = (): ProviderAudioSource => ({
    url: 'https://m801.music.126.net/trial.mp3',
    fetchedAt: Date.now(),
    quality: 'standard',
    preview: true,
});

describe('LX hook on a preview (trial) source', () => {
    afterEach(() => {
        installOmniResultHooks(null);
        resolveMusicUrl.mockReset();
        resolveMusicUrl.mockResolvedValue('https://m801.music.126.net/full.mp3');
    });

    it('replaces a trial clip with a full LX URL', async () => {
        installLxFallbackHook();
        const result = await applyOmniAudioHook(song(), previewSource());
        expect(result?.url).toBe('https://m801.music.126.net/full.mp3');
        expect(result?.preview).toBe(false);
        expect(resolveMusicUrl).toHaveBeenCalled();
    });

    it('keeps the trial when no script has a full URL', async () => {
        resolveMusicUrl.mockResolvedValue(null);
        installLxFallbackHook();
        const preview = previewSource();
        const result = await applyOmniAudioHook(song(), preview);
        expect(result).toBe(preview);
    });

    it('leaves a full provider URL untouched', async () => {
        installLxFallbackHook();
        const full: ProviderAudioSource = { url: 'https://m801.music.126.net/full.mp3', fetchedAt: Date.now(), quality: 'standard' };
        const result = await applyOmniAudioHook(song(), full);
        expect(result).toBe(full);
        expect(resolveMusicUrl).not.toHaveBeenCalled();
    });

    it('still fills in when the provider gave no URL', async () => {
        installLxFallbackHook();
        const result = await applyOmniAudioHook(song(), null);
        expect(result?.url).toBe('https://m801.music.126.net/full.mp3');
        expect(result?.preview).toBe(false);
    });

    // The bug this guards: the omni hook used to be a single slot, so a mod
    // that opted into the experimental hooks after startup silently replaced
    // the LX hook and the fallback never fired. A pass-through hook stands in
    // for the Folium one with nobody listening.
    it('still races when another hook was installed before it', async () => {
        installOmniResultHooks({ audio: async (_song, source) => source });
        installLxFallbackHook();
        const result = await applyOmniAudioHook(song(), null);
        expect(result?.url).toBe('https://m801.music.126.net/full.mp3');
        expect(result?.preview).toBe(false);
    });

    it('still races when another hook is installed after it', async () => {
        installLxFallbackHook();
        installOmniResultHooks({ audio: async (_song, source) => source });
        const result = await applyOmniAudioHook(song(), null);
        expect(result?.url).toBe('https://m801.music.126.net/full.mp3');
        expect(result?.preview).toBe(false);
    });

    it('logs when a song the fallback should cover has no identity', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            installLxFallbackHook();
            const noIdentity: UnifiedSong = {
                ...song(),
                id: '',
                sourceRef: { kind: 'online', providerId: 'qq', mediaId: '' },
            };
            const result = await applyOmniAudioHook(noIdentity, null);
            expect(result).toBeNull();
            expect(resolveMusicUrl).not.toHaveBeenCalled();
            expect(info.mock.calls.map(call => String(call[0])).some(
                line => line.startsWith('[lxFallback] no song identity for qq'),
            )).toBe(true);
        } finally {
            info.mockRestore();
        }
    });

    it('stays quiet about identity for a song the fallback does not cover', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            installLxFallbackHook();
            const localSong = {
                ...song(),
                sourceRef: { kind: 'local', mediaId: 'x' },
            } as unknown as UnifiedSong;
            await applyOmniAudioHook(localSong, null);
            expect(info.mock.calls.map(call => String(call[0])).some(
                line => line.includes('no song identity'),
            )).toBe(false);
        } finally {
            info.mockRestore();
        }
    });
});
