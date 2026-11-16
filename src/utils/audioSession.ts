// src/utils/audioSession.ts

// The web audio session and the AudioContext resume decision, shared by the playback
// transport (which resumes on a user gesture) and the audio bridge (which listens for
// interruptions). Kept here so both read one definition of "the session is ours".

// Claims the playback audio session for web audio (Safari 16.4+; a silent no-op before
// that). Web Audio otherwise stays on the ambient/ringer channel and is muted by the
// silent switch, and a lock or an interruption drops the session — so this is
// re-applied on every resume, not only when the graph is first built.
export const applyPlaybackAudioSession = (): void => {
    try {
        const nav = navigator as Navigator & { audioSession?: { type: string } };
        if (nav.audioSession) nav.audioSession.type = 'playback';
    } catch { /* audioSession unsupported */ }
};

// Whether a context in this state should be resumed when playback is wanted. iOS
// reports 'interrupted' (not 'suspended') while another app holds the session, and a
// resume that only checks 'suspended' never fires after a lock or an interruption —
// the element then plays into a dead graph and lock-screen Play cannot revive it.
export const shouldResumeAudioContext = (
    state: AudioContextState | null | undefined,
    wantsPlayback: boolean,
): boolean => {
    if (!wantsPlayback) return false;
    return state === 'suspended' || state === 'interrupted';
};
