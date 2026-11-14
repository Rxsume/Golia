// test/unit/services/hostExtensionHooks.test.ts
// The omni result hooks chain in install order: several layers install one
// (the Folium experimental hooks, the built-in LX fallback), and no install
// may silently replace another.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import type { ProviderAudioSource, ProviderLyricsResult } from '@/types/onlineMusic';
import {
    applyOmniAudioHook, applyOmniLyricsHook, installOmniResultHooks,
} from '@/services/hostExtensionHooks';

const song = { id: 1, name: 'S', artists: [], album: { id: 1, name: '' }, durationMs: 0 } as unknown as SongResult;
const audioSource = (url: string): ProviderAudioSource => ({ url, fetchedAt: 1, quality: 'high' });
const lyricsResult = (text: string): ProviderLyricsResult => ({
    lyrics: { lines: [{ words: [], startTime: 0, endTime: 1, fullText: text }] },
    isPureMusic: false,
});

describe('omni result hooks chain', () => {
    afterEach(() => {
        installOmniResultHooks(null);
        vi.restoreAllMocks();
    });

    it('runs installed audio hooks in install order, each on the previous result', async () => {
        installOmniResultHooks({ audio: async (_song, source) => (source ? { ...source, url: `${source.url}?a` } : source) });
        installOmniResultHooks({ audio: async (_song, source) => (source ? { ...source, url: `${source.url}&b` } : source) });
        const result = await applyOmniAudioHook(song, audioSource('https://a.example/x.mp3'));
        expect(result?.url).toBe('https://a.example/x.mp3?a&b');
    });

    it('runs installed lyrics hooks in install order', async () => {
        installOmniResultHooks({
            lyrics: async (_song, result) => ({
                ...result,
                lyrics: result.lyrics && {
                    ...result.lyrics,
                    lines: result.lyrics.lines.map(line => ({ ...line, fullText: `${line.fullText}!` })),
                },
            }),
        });
        installOmniResultHooks({
            lyrics: async (_song, result) => ({
                ...result,
                lyrics: result.lyrics && {
                    ...result.lyrics,
                    lines: result.lyrics.lines.map(line => ({ ...line, fullText: line.fullText.toUpperCase() })),
                },
            }),
        });
        const result = await applyOmniLyricsHook(song, lyricsResult('hi'));
        expect(result.lyrics?.lines[0].fullText).toBe('HI!');
    });

    it('keeps the chain going past a throwing hook', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        installOmniResultHooks({ audio: async () => { throw new Error('boom'); } });
        installOmniResultHooks({ audio: async (_song, source) => (source ? { ...source, url: 'https://b.example/y.mp3' } : source) });
        const result = await applyOmniAudioHook(song, audioSource('https://a.example/x.mp3'));
        expect(result?.url).toBe('https://b.example/y.mp3');
        expect(warn).toHaveBeenCalled();
    });

    it('skips only the hook whose isActive says no', async () => {
        installOmniResultHooks({
            isActive: () => false,
            audio: async (_song, source) => (source ? { ...source, url: 'https://skipped.example/x.mp3' } : source),
        });
        installOmniResultHooks({ audio: async (_song, source) => (source ? { ...source, url: 'https://b.example/y.mp3' } : source) });
        const result = await applyOmniAudioHook(song, audioSource('https://a.example/x.mp3'));
        expect(result?.url).toBe('https://b.example/y.mp3');
    });

    it('does not run the same hooks object twice', async () => {
        const audio = vi.fn(async (_song: SongResult, source: ProviderAudioSource | null) => source);
        const hooks = { audio };
        installOmniResultHooks(hooks);
        installOmniResultHooks(hooks);
        await applyOmniAudioHook(song, audioSource('https://a.example/x.mp3'));
        expect(audio).toHaveBeenCalledTimes(1);
    });

    it('clears the chain on null', async () => {
        const audio = vi.fn(async (_song: SongResult, source: ProviderAudioSource | null) => source);
        installOmniResultHooks({ audio });
        installOmniResultHooks(null);
        await applyOmniAudioHook(song, audioSource('https://a.example/x.mp3'));
        expect(audio).not.toHaveBeenCalled();
    });
});
