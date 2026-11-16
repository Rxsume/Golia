import { describe, expect, it, vi } from 'vitest';
import { applyPlaybackAudioSession, shouldResumeAudioContext } from '@/utils/audioSession';

// test/unit/utils/audioSession.test.ts

describe('shouldResumeAudioContext', () => {
    it.each([
        ['suspended', true, true],
        ['interrupted', true, true],
        ['running', true, false],
        ['closed', true, false],
        ['suspended', false, false],
        ['interrupted', false, false],
    ] as const)('state %s with playback wanted=%s resumes=%s', (state, wantsPlayback, expected) => {
        expect(shouldResumeAudioContext(state, wantsPlayback)).toBe(expected);
    });

    it('does not resume without a state', () => {
        expect(shouldResumeAudioContext(undefined, true)).toBe(false);
        expect(shouldResumeAudioContext(null, true)).toBe(false);
    });
});

describe('applyPlaybackAudioSession', () => {
    it('claims the playback session where the browser offers one', () => {
        const audioSession = { type: 'auto' };
        vi.stubGlobal('navigator', { audioSession });
        applyPlaybackAudioSession();
        expect(audioSession.type).toBe('playback');
        vi.unstubAllGlobals();
    });

    it('is a no-op where the browser offers no audio session', () => {
        vi.stubGlobal('navigator', {});
        expect(() => applyPlaybackAudioSession()).not.toThrow();
        vi.unstubAllGlobals();
    });
});
