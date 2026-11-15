// src/services/lxFallback/lxFallback.ts
// The LX fallback: when a native provider cannot produce an audio URL, or only
// produces a trial clip (`preview`), the built-in LX scripts are asked for a
// full one. They race in parallel and the first success wins; the fallback is installed on the omni audio hook,
// so it only runs after the native provider has already answered; a full URL from
// the provider is never bypassed, and a trial is only kept when no script has a
// full one. A 'tx' song's songmid is resolved first, from the song itself or,
// failing that, from a detail lookup, because one backend answers a numeric id
// with another song's URL; the scripts receive the songmid in the musicInfo and
// are expected to send it for tx (huibq is patched to do so). A Qishui song has
// no songmid of its own, so it first resolves to its tx equivalent by exact
// title and artist (findTxEquivalent) and only then enters the 'tx' race; its
// own id is never sent to a backend as a songmid.

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
// Qishui has no LX source of its own: it enters the 'tx' race only as its tx
// equivalent (see resolveLxSongIdentity), never under its own id.
const LX_SOURCE_BY_PROVIDER_ID: Record<string, LxSource | undefined> = {
    netease: 'wy',
    qq: 'tx',
    kugou: 'kg',
    qishui: 'tx',
};

/** The audio quality the hook asks the scripts for. */
const LX_QUALITY = '320k';
/**
 * One backend gets this long before it is out of the race. A backend fetch over a
 * VPN can take well over a second (measured ~1.7s cold on one backend), so the budget is
 * generous; the hook itself has no host timeout, and a slow URL still beats a toast.
 */
const LX_BACKEND_TIMEOUT_MS = 2500;
/** The whole race gives up after this long. */
const LX_RACE_TIMEOUT_MS = 4000;

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

/** How long the tx-equivalent search may hold up a Qishui preview before the trial plays. */
const TX_EQUIVALENT_TIMEOUT_MS = 5000;
/** How many candidates the equivalent search reads before it stops. */
const TX_EQUIVALENT_LIMIT = 10;

const normalizeSongText = (value: string): string => value.toLowerCase().replace(/\s+/g, '');

/**
 * Whether a candidate is the same song: the same title and at least one
 * artist in common. The title alone is not enough — '瞬' is sung by other
 * singers too — and the artist alone is not either. Titles
 * compare exactly (past case and spacing): a trailing version note such as
 * '(Live)' or '(Speed up版)' is a different recording, not the same song,
 * so it must not match the bare title.
 */
export const isTxEquivalent = (candidate: SongResult, song: SongResult): boolean => {
    if (normalizeSongText(candidate.name || '') !== normalizeSongText(song.name || '')) return false;
    const wanted = new Set(song.artists.map(artist => normalizeSongText(artist.name)));
    return candidate.artists.some(artist => wanted.has(normalizeSongText(artist.name)));
};

/**
 * The tx song a Qishui song is, by exact title and artist, or null when there is
 * no such song. The search goes through omni like any other provider search, so
 * a signed-in account searches with its session and an anonymous one searches
 * musicu direct; a refusal or a slow search is "no equivalent", never an error.
 */
export const findTxEquivalent = async (song: SongResult): Promise<SongResult | null> => {
    const name = song.name.trim();
    if (!name) return null;
    const firstArtist = song.artists[0]?.name?.trim() ?? '';
    const query = [name, firstArtist].filter(part => part.length > 0).join(' ');
    const search = omni.searchProviderSongs('qq', query, { limit: TX_EQUIVALENT_LIMIT, offset: 0 })
        .catch((error: unknown) => {
            console.warn('[lxFallback] tx equivalent search failed', error);
            return null;
        });
    const page = await Promise.race([
        search,
        new Promise<null>(resolve => setTimeout(() => resolve(null), TX_EQUIVALENT_TIMEOUT_MS)),
    ]);
    if (!page) return null;
    return page.items.find(candidate => isTxEquivalent(candidate, song)) ?? null;
};

/** The 'tx' identity of the equivalent song: its songmid, from the song itself or a detail lookup. */
export const resolveTxIdentity = async (song: SongResult, name: string, artists: string): Promise<LxSongIdentity | null> => {
    const ref = getPlaybackSourceRef(song);
    if (ref.kind !== 'online') return null;
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
    return { source: 'tx', songId: String(song.id), songMid, mediaMid, name, artists };
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
    // 'tx': a Qishui song is not a tx song — its id would reach a backend as a
    // songmid and come back as another song's URL — so it first resolves to its
    // tx equivalent, and only that equivalent enters the race.
    if (ref.providerId === 'qishui') {
        const equivalent = await findTxEquivalent(song);
        if (!equivalent) return null;
        return resolveTxIdentity(equivalent, name, artists);
    }
    return resolveTxIdentity(song, name, artists);
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

/** One playback URL from the built-in script, or null when it has none. */
export const resolveLxAudioUrl = async (song: SongResult): Promise<string | null> => {
    const startedAt = Date.now();
    const identity = await resolveLxSongIdentity(song);
    if (!identity) {
        // A song the fallback should cover but cannot identify used to fail
        // silently: in the run log that looks exactly like a hook that never
        // ran. Only logged for a provider the fallback maps, so a local song
        // or an unmapped provider stays quiet.
        const ref = getPlaybackSourceRef(song);
        if (ref.kind === 'online' && LX_SOURCE_BY_PROVIDER_ID[ref.providerId]) {
            console.info(`[lxFallback] no song identity for ${ref.providerId} ${String(song.id)}`);
        }
        return null;
    }
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
 * Install the fallback on the omni audio hook. It fills in when the native provider
 * produced no URL, and when it produced only a trial clip (`preview`): a trial is
 * not a playable full song, so the scripts race for a full URL first and the
 * provider's trial is only kept when none of them has one. Anything it returns is
 * recorded as a standard-quality hook URL. Omni hooks chain in install order,
 * so this runs alongside the Folium experimental hooks no matter which of
 * them was installed first.
 */
export const installLxFallbackHook = (): void => {
    installOmniResultHooks({
        audio: async (song, source) => {
            // A full URL from the provider plays as-is; a trial clip (or no URL at
            // all) goes to the scripts, and the trial is only kept when they fail.
            if (source && !source.preview) return source;
            try {
                const url = await resolveLxAudioUrl(song);
                if (!url) return source;
                return { quality: 'standard', url, fetchedAt: Date.now(), preview: false };
            } catch (error) {
                console.warn('[lxFallback] fallback failed', error);
                return source;
            }
        },
    });
    console.info(`[lxFallback] installed (native http: ${lxHasNativeHttp() ? 'yes' : 'no'})`);
};
