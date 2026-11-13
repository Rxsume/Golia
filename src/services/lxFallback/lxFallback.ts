// src/services/lxFallback/lxFallback.ts
// The LX fallback: when a native provider cannot produce an audio URL, three built-in
// LX scripts race in parallel for one, and the first URL wins. It is installed on the
// omni audio hook, so it only runs after the native provider has already failed; the
// native chain is never bypassed. A 'tx' song is never sent to the backends with its
// numeric id (one backend answers that with another song's URL), so the songmid is
// resolved first, from the song itself or, failing that, from a detail lookup.

import type { SongResult } from '../../types';
import type { PlaybackSourceRef } from '../../types/onlineMusic';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { installOmniResultHooks } from '../hostExtensionHooks';
import { omni } from '../onlineMusic/omni';
import { lxHasNativeHttp } from './lxHttp';
import { buildLxMusicInfo, getLxRuntime, LX_SCRIPTS, type LxScriptId, type LxSource } from './lxRuntime';

// The provider id each LX source code stands for. This is the one place that names a
// platform: the fallback is explicitly cross-provider, and the mapping is its core.
// (Counts are pinned in test/unit/onlineMusic/platformNamePlaces.ts.)
const LX_SOURCE_BY_PROVIDER_ID: Record<string, LxSource | undefined> = {
    netease: 'wy',
    qq: 'tx',
    kugou: 'kg',
};

/** The audio quality the hook asks the scripts for. */
const LX_QUALITY = '320k';
/** One backend gets this long before it is out of the race. */
const LX_BACKEND_TIMEOUT_MS = 1200;
/** The whole race gives up after this long. */
const LX_RACE_TIMEOUT_MS = 2000;

interface LxSongIdentity {
    source: LxSource;
    songId: string;
    songMid?: string;
    mediaMid?: string;
    hash?: string;
    name: string;
    artists: string;
}

/** The songmid a 'tx' song carries in its source ref, if any. */
export const songMidFromRef = (ref: PlaybackSourceRef): { songMid: string; mediaMid: string } => {
    if (ref.kind !== 'online') return { songMid: '', mediaMid: '' };
    const data = ref.providerData;
    const songMid = typeof data?.songMid === 'string' ? data.songMid.trim() : '';
    const mediaMid = typeof data?.mediaMid === 'string' ? data.mediaMid.trim() : '';
    if (songMid) return { songMid, mediaMid };
    // The 'tx' media id IS the songmid when it carries a letter; a pure number is the song id.
    const mediaId = ref.mediaId.trim();
    if (/[A-Za-z]/.test(mediaId)) return { songMid: mediaId, mediaMid };
    return { songMid: '', mediaMid: '' };
};

/** The numeric song id a 'tx' song carries, for the detail lookup that finds its songmid. */
export const numericSongIdFromRef = (song: SongResult, ref: PlaybackSourceRef): number | null => {
    const storedId = ref.kind === 'online' ? ref.providerData?.songId : undefined;
    for (const candidate of [song.id, storedId]) {
        const text = typeof candidate === 'string' || typeof candidate === 'number'
            ? String(candidate).trim()
            : '';
        if (!/^[1-9]\d*$/.test(text)) continue;
        const value = Number(text);
        // The provider reads the id as int32; anything larger is not a song id.
        if (value <= 2_147_483_647) return value;
    }
    return null;
};

export const resolveLxSongIdentity = async (song: SongResult): Promise<LxSongIdentity | null> => {
    const ref = getPlaybackSourceRef(song);
    if (ref.kind !== 'online') return null;
    const source = LX_SOURCE_BY_PROVIDER_ID[ref.providerId];
    if (!source) return null;
    const name = song.name || '';
    const artists = song.artists.map(artist => artist.name).join(' / ');
    if (source === 'wy') return { source, songId: String(song.id), name, artists };
    if (source === 'kg') {
        const hash = song.kgHash || ref.mediaId || String(song.id);
        return { source, songId: String(song.id), hash, name, artists };
    }
    // 'tx': resolve the songmid before the backends see the song.
    let { songMid, mediaMid } = songMidFromRef(ref);
    if (!songMid) {
        const numericId = numericSongIdFromRef(song, ref);
        if (numericId === null) return null;
        // The detail lookup asks the provider for the song by its numeric id (the same
        // call the Golia port makes for a numeric id) and returns it with its songmid.
        const detail = await omni.getSongDetail(ref.providerId, numericId).catch((error: unknown) => {
            console.warn('[lxFallback] song detail lookup failed', error);
            return null;
        });
        if (!detail) return null;
        const found = songMidFromRef(getPlaybackSourceRef(detail));
        if (!found.songMid) return null;
        songMid = found.songMid;
        mediaMid = found.mediaMid || mediaMid;
    }
    return { source, songId: String(song.id), songMid, mediaMid, name, artists };
};

/** The first non-null result of the attempts, or null once they have all settled. */
export const firstLxSuccess = <T>(attempts: Array<Promise<T | null>>): Promise<T | null> => {
    if (attempts.length === 0) return Promise.resolve(null);
    return new Promise(resolve => {
        let remaining = attempts.length;
        let done = false;
        const onSettled = (value: T | null): void => {
            if (done) return;
            if (value !== null && value !== undefined) {
                done = true;
                resolve(value);
                return;
            }
            remaining -= 1;
            if (remaining === 0) {
                done = true;
                resolve(null);
            }
        };
        for (const attempt of attempts) attempt.then(onSettled, () => onSettled(null));
    });
};

const resolveViaScript = async (
    scriptId: LxScriptId,
    identity: LxSongIdentity,
    quality: string,
    timeoutMs: number,
): Promise<{ scriptId: LxScriptId; url: string } | null> => {
    const musicInfo = buildLxMusicInfo({
        source: identity.source,
        songId: identity.songId,
        songMid: identity.songMid,
        mediaMid: identity.mediaMid,
        hash: identity.hash,
        name: identity.name,
        artists: identity.artists,
    });
    try {
        const url = await getLxRuntime(scriptId).resolveMusicUrl(identity.source, musicInfo, quality, timeoutMs);
        return url ? { scriptId, url } : null;
    } catch (error) {
        console.warn(`[lxFallback] script ${scriptId} failed`, error);
        return null;
    }
};

/** One playback URL from the three built-in scripts, or null when none has one. */
export const resolveLxAudioUrl = async (song: SongResult): Promise<string | null> => {
    const startedAt = Date.now();
    const identity = await resolveLxSongIdentity(song);
    if (!identity) return null;
    const attempts = LX_SCRIPTS.map(script => resolveViaScript(script.id, identity, LX_QUALITY, LX_BACKEND_TIMEOUT_MS));
    const winner = await Promise.race([
        firstLxSuccess(attempts),
        new Promise<null>(resolve => setTimeout(() => resolve(null), LX_RACE_TIMEOUT_MS)),
    ]);
    if (winner) {
        console.info(`[lxFallback] ${winner.scriptId} resolved ${identity.source} in ${Date.now() - startedAt}ms`);
        return winner.url;
    }
    console.info(`[lxFallback] no URL for ${identity.source} ${identity.songId} in ${Date.now() - startedAt}ms`);
    return null;
};

/**
 * Install the fallback on the omni audio hook. It only fills in when the native provider
 * produced no URL; anything it returns is recorded as a standard-quality hook URL.
 * Installs last at startup so no earlier hook can overwrite it.
 */
export const installLxFallbackHook = (): void => {
    installOmniResultHooks({
        audio: async (song, source) => {
            if (source) return source;
            try {
                const url = await resolveLxAudioUrl(song);
                if (!url) return null;
                return { quality: 'standard', url, fetchedAt: Date.now(), preview: false };
            } catch (error) {
                console.warn('[lxFallback] fallback failed', error);
                return null;
            }
        },
    });
    console.info(`[lxFallback] installed (native http: ${lxHasNativeHttp() ? 'yes' : 'no'})`);
};
