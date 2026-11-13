// src/services/lxFallback/lxRuntime.ts
// The LX script runtime: runs one third-party LX music-URL script (the three files under
// scripts/) in its own scope with an `lx` bridge, and asks it for a playback URL. This is
// a TypeScript port of Golia's LXScriptSourceRunner (Beans), which runs these exact scripts
// on iOS; the bridge surface, the request/response shapes and the URL extraction follow it
// so the scripts take the same code paths they take there.

import md5 from 'blueimp-md5';
import { lxAesEncrypt } from './lxAes';
import {
    base64ToBytes, bytesToBase64, bytesToHex, bytesToUtf8, hexToBytes, lxBufferBytes, lxBufferIs,
    lxBufferOf, utf8ToBytes, type LxBuffer,
} from './lxBytes';
import { lxHttpRequest, type LxHttpResponse, type LxRequestOptions } from './lxHttp';
import golia2Script from './scripts/Golia-2.js?raw';
import hbdScript from './scripts/Hbd.js?raw';
import v52Script from './scripts/v5-2.js?raw';

export type LxSource = 'wy' | 'tx' | 'kg';
export type LxScriptId = 'v5-2' | 'hbd' | 'golia-2';

export interface LxScriptDefinition {
    id: LxScriptId;
    /** Display name, as Golia shows it for the built-in source. */
    name: string;
    source: string;
}

export const LX_SCRIPTS: readonly LxScriptDefinition[] = [
    { id: 'v5-2', name: '酸甜贤', source: v52Script },
    { id: 'hbd', name: 'GD', source: hbdScript },
    { id: 'golia-2', name: 'Golia-2', source: golia2Script },
];

/** The song identity handed to a script, in Golia's `musicInfo` shape. */
export interface LxMusicInfo {
    id: string;
    songId: string;
    musicId: string;
    musicrid: string;
    mid: string;
    songmid: string;
    mediaId: string;
    media_mid: string;
    mediaMid: string;
    strMediaMid: string;
    copyrightId: string;
    contentId: string;
    hash: string;
    rid: string;
    name: string;
    songName: string;
    singer: string;
    artist: string;
    artists: string[];
    source: LxSource;
    album: string;
    albumName: string;
    albumId: string;
    albumAudioId: string;
    interval: string;
    _types: Record<string, unknown>;
    meta: Record<string, unknown>;
}

/**
 * Golia's `musicInfoPayload`: the primary id is the songmid for a 'tx' song and the
 * file hash for a 'kg' song, the plain song id otherwise; the media id falls back to
 * the primary id when the platform did not give one.
 */
export const buildLxMusicInfo = (params: {
    source: LxSource;
    songId: string;
    songMid?: string;
    mediaMid?: string;
    hash?: string;
    name: string;
    artists: string;
}): LxMusicInfo => {
    const songMid = params.songMid?.trim() ? params.songMid.trim() : undefined;
    const mediaMid = params.mediaMid?.trim() ? params.mediaMid.trim() : undefined;
    const primaryId = (params.source === 'tx' ? songMid : undefined) ?? params.songId;
    const resolvedHash = (params.source === 'kg' ? params.hash : undefined) ?? params.songId;
    const artistList = params.artists.split(/[/&,]/).map(part => part.trim()).filter(part => part.length > 0);
    return {
        id: params.songId,
        songId: params.songId,
        musicId: primaryId,
        musicrid: params.songId,
        mid: songMid ?? primaryId,
        songmid: songMid ?? primaryId,
        mediaId: mediaMid ?? primaryId,
        media_mid: mediaMid ?? primaryId,
        mediaMid: mediaMid ?? primaryId,
        strMediaMid: mediaMid ?? primaryId,
        copyrightId: params.songId,
        contentId: params.songId,
        hash: resolvedHash,
        rid: params.songId,
        name: params.name,
        songName: params.name,
        singer: params.artists,
        artist: params.artists,
        artists: artistList,
        source: params.source,
        album: '',
        albumName: '',
        albumId: '',
        albumAudioId: '',
        interval: '',
        _types: {},
        meta: {},
    };
};

export interface LxRequestPayload {
    action: 'musicUrl';
    source: LxSource;
    info: { type: string; musicInfo: LxMusicInfo };
}

const valueAtPath = (obj: Record<string, unknown>, path: string): unknown => {
    let current: unknown = obj;
    for (const key of path.split('.')) {
        if (typeof current !== 'object' || current === null) return undefined;
        current = (current as Record<string, unknown>)[key];
    }
    return current;
};

/**
 * Golia's `extractURLString`: a URL string (a `//` one gains `https:`), a JSON string
 * holding one, or an object/array holding one under a known key. Only the likely
 * containers are recursed into, so a cover URL is never picked up by mistake.
 */
export const extractLxUrl = (raw: unknown): string | null => {
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
        if (trimmed.startsWith('//')) return `https:${trimmed}`;
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                return extractLxUrl(JSON.parse(trimmed) as unknown);
            } catch {
                return null;
            }
        }
        return null;
    }
    if (Array.isArray(raw)) {
        for (const item of raw) {
            const url = extractLxUrl(item);
            if (url) return url;
        }
        return null;
    }
    if (typeof raw === 'object' && raw !== null) {
        const dict = raw as Record<string, unknown>;
        const paths = [
            'musicUrl', 'musicurl', 'music', 'url', 'play_url', 'playUrl', 'src', 'audioUrl', 'audio_url', 'link', 'purl',
            'data.url', 'data.musicUrl', 'data.musicurl', 'data.music', 'data.play_url', 'data.playUrl', 'data.src',
            'data.audioUrl', 'data.audio_url', 'data.link',
            'result.url', 'result.musicUrl', 'result.musicurl', 'result.music', 'result.play_url', 'result.playUrl',
            'result.src', 'result.audioUrl', 'result.link',
        ];
        for (const path of paths) {
            const value = valueAtPath(dict, path);
            if (value !== undefined) {
                const url = extractLxUrl(value);
                if (url) return url;
            }
        }
        for (const key of ['data', 'result', 'response', 'body', 'payload', 'musicInfo']) {
            if (key in dict) {
                const url = extractLxUrl(dict[key]);
                if (url) return url;
            }
        }
        return null;
    }
    return null;
};

type LxRequestCallback = (error: { message: string } | null, response: LxHttpResponse | null) => void;

interface LxBridge {
    EVENT_NAMES: { request: string; inited: string; updateAlert: string };
    env: { platform: string; os: string; device: string; isMobile: boolean };
    utils: {
        buffer: {
            from: (text: string, encoding?: string) => LxBuffer;
            bufToString: (buffer: unknown, encoding?: string) => string;
        };
        crypto: {
            md5: (value: string) => string;
            aesEncrypt: (data: string, mode: string, key: string, iv: string) => LxBuffer;
        };
    };
    version: string;
    currentScriptInfo: { name: string; version: string; rawScript: string };
    on: (event: string, handler: (payload: LxRequestPayload) => unknown) => void;
    send: (event: string, payload?: unknown) => void;
    request: (
        url: string,
        options?: LxRequestOptions | LxRequestCallback,
        callback?: LxRequestCallback,
    ) => Promise<LxHttpResponse> | undefined;
}

/**
 * One script in its own scope. The script runs as a `new Function` whose parameters are
 * its shims, so bare identifiers (`lx`, `fetch`, `Buffer`, ...) resolve to this script's
 * own objects and not the page's; standard built-ins still come from the real global.
 * A script is evaluated once, lazily, on its first use.
 */
export class LxScriptRuntime {
    readonly id: LxScriptId;
    readonly name: string;
    private readonly scriptSource: string;
    private handlers = new Map<string, (payload: LxRequestPayload) => unknown>();
    private pluginExports: Record<string, unknown> = {};
    private musicPlugin: Record<string, unknown> | null = null;
    private evaluation: 'pending' | 'ok' | 'failed' = 'pending';

    constructor(definition: LxScriptDefinition) {
        this.id = definition.id;
        this.name = definition.name;
        this.scriptSource = definition.source;
    }

    /** Ask this script for a playback URL; null when it has none or runs out of time. */
    async resolveMusicUrl(
        source: LxSource,
        musicInfo: LxMusicInfo,
        quality: string,
        timeoutMs: number,
    ): Promise<string | null> {
        if (this.evaluation === 'pending') {
            this.evaluation = this.evaluate() ? 'ok' : 'failed';
        }
        if (this.evaluation !== 'ok') return null;
        const payload: LxRequestPayload = { action: 'musicUrl', source, info: { type: quality, musicInfo } };
        const raw = await this.invokeRequest(payload, timeoutMs);
        if (raw === null || raw === undefined) return null;
        return extractLxUrl(raw);
    }

    private buildBridge(): LxBridge {
        // The request the scripts see: callback-style like the LX host, Promise-capable
        // when no callback is given (Golia's wrapper does the same).
        const request: LxBridge['request'] = (url, options, callback) => {
            let opts: LxRequestOptions = {};
            let cb: LxRequestCallback | undefined;
            if (typeof options === 'function') cb = options;
            else {
                opts = options ?? {};
                cb = callback;
            }
            const headers = { ...(opts.headers ?? {}) };
            if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = 'lx-music';
            const promise = (async (): Promise<LxHttpResponse> => {
                let response: LxHttpResponse;
                try {
                    response = await lxHttpRequest(url, { ...opts, headers });
                } catch (error) {
                    throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
                }
                if (response.statusCode >= 400) {
                    const httpError = new Error(`HTTP ${response.statusCode}`) as Error & { response: LxHttpResponse };
                    httpError.response = response;
                    throw httpError;
                }
                return response;
            })();
            if (cb) {
                promise.then(
                    response => cb(null, response),
                    (error: unknown) => {
                        const message = error instanceof Error ? error.message : 'request failed';
                        const response = (error as { response?: LxHttpResponse }).response ?? null;
                        cb({ message }, response);
                    },
                );
                return undefined;
            }
            return promise;
        };

        const buffer = {
            from: (text: string, encoding = 'utf8'): LxBuffer => {
                const normalized = encoding.trim().toLowerCase();
                if (normalized === 'base64') return lxBufferOf(base64ToBytes(text));
                if (normalized === 'hex') return lxBufferOf(hexToBytes(text));
                return lxBufferOf(utf8ToBytes(text));
            },
            bufToString: (bufferValue: unknown, encoding = 'utf8'): string => {
                const bytes = lxBufferBytes(bufferValue);
                if (bytes === null) {
                    if (typeof bufferValue === 'string') return bufferValue;
                    if (typeof bufferValue === 'number' || typeof bufferValue === 'boolean' || typeof bufferValue === 'bigint') {
                        return String(bufferValue);
                    }
                    return '';
                }
                const normalized = encoding.trim().toLowerCase();
                if (normalized === 'base64') return bytesToBase64(bytes);
                if (normalized === 'hex') return bytesToHex(bytes);
                return bytesToUtf8(bytes);
            },
        };

        return {
            EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
            // Deliberately Golia's values, not the web's: these scripts are proven to work
            // against this environment on iOS, and a different platform string could send
            // them down a code path their backends do not serve.
            env: { platform: 'ios', os: 'iOS', device: 'iPhone', isMobile: true },
            utils: {
                buffer,
                crypto: {
                    md5: (value: string) => md5(value),
                    aesEncrypt: (data: string, mode: string, key: string, iv: string) => lxAesEncrypt(data, mode, key, iv),
                },
            },
            version: __APP_VERSION__,
            currentScriptInfo: { name: this.name, version: '', rawScript: this.scriptSource },
            on: (event, handler) => {
                this.handlers.set(event, handler);
            },
            send: (event, payload) => {
                if (event !== 'inited') return;
                const sources = (payload as { sources?: Record<string, unknown> } | null | undefined)?.sources;
                if (sources) {
                    console.info(`[lxFallback] script ${this.id} inited: ${Object.keys(sources).join(',')}`);
                }
            },
            request,
        };
    }

    private evaluate(): boolean {
        const lx = this.buildBridge();
        // The script's own `globalThis`, chained to the real one for the built-ins.
        // Own properties are defined BEFORE the prototype is set to the real global:
        // a plain assignment onto an object whose prototype is `globalThis` would
        // invoke a prototype accessor setter (where the host defines one, e.g. for
        // `Buffer` or `fetch`) and mutate the real global instead of shadowing it.
        // That leak deleted `Buffer.concat` on the host and broke every later
        // `fetch` body read, so the LX scripts could never resolve a URL.
        const shimGlobal: Record<string, unknown> = {};
        const moduleObj: { exports: Record<string, unknown> } = { exports: {} };

        const fetchShim = (url: string, options?: LxRequestOptions): Promise<{
            ok: boolean; status: number; statusCode: number; headers: Record<string, string>;
            text: () => Promise<string>; json: () => Promise<unknown>;
        }> => (
            (lx.request(url, options) as Promise<LxHttpResponse>).then(response => ({
                ok: response.ok,
                status: response.statusCode,
                statusCode: response.statusCode,
                headers: response.headers,
                text: () => Promise.resolve(
                    response.bodyText
                    || (typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? '')),
                ),
                json: () => Promise.resolve(
                    typeof response.body === 'string' ? JSON.parse(response.body) as unknown : response.body,
                ),
            }))
        );
        const customFetchShim = (url: string, options?: LxRequestOptions): Promise<string> => (
            (lx.request(url, options) as Promise<LxHttpResponse>).then(response => {
                if (response.bodyText.length > 0) return response.bodyText;
                if (typeof response.body === 'string') return response.body;
                return JSON.stringify(response.body ?? {});
            })
        );
        const bufferShim = {
            from: (value: unknown, encoding?: string): LxBuffer => {
                if (lxBufferIs(value)) return value;
                const text = typeof value === 'string' ? value
                    : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' ? String(value)
                        : '';
                const buffer = lx.utils.buffer.from(text, encoding ?? 'utf8');
                (buffer as unknown as Record<string, unknown>).toString = (outputEncoding?: string) => (
                    lx.utils.buffer.bufToString(buffer, outputEncoding ?? 'utf8')
                );
                return buffer;
            },
            isBuffer: (value: unknown): boolean => lxBufferIs(value),
        };
        const jsonShim = Object.create(JSON) as JSON;
        (jsonShim as unknown as Record<string, unknown>).parse = (value: unknown): unknown => (
            value !== null && typeof value === 'object' ? value : JSON.parse(value as string) as unknown
        );
        const cerumusic = {
            request: lx.request,
            utils: lx.utils,
            env: lx.env,
            version: lx.version,
            currentScriptInfo: lx.currentScriptInfo,
            NoticeCenter: () => undefined,
            stopRequests: () => undefined,
        };

        shimGlobal.lx = lx;
        shimGlobal.module = moduleObj;
        shimGlobal.exports = moduleObj.exports;
        shimGlobal.global = shimGlobal;
        shimGlobal.self = shimGlobal;
        shimGlobal.fetch = fetchShim;
        shimGlobal.customFetch = customFetchShim;
        shimGlobal.Buffer = bufferShim;
        shimGlobal.JSON = jsonShim;
        shimGlobal.cerumusic = cerumusic;
        // Chain to the real global for the built-ins the scripts read (Object, Math,
        // setTimeout, ...). Own properties above already shadow the names the bridge
        // provides, so this cannot leak an assignment back to the host.
        Object.setPrototypeOf(shimGlobal, globalThis);

        const paramNames = ['lx', 'module', 'exports', 'globalThis', 'global', 'self', 'fetch', 'customFetch', 'Buffer', 'JSON', 'cerumusic'];
        let fn: (...args: unknown[]) => unknown;
        try {
            // eslint-disable-next-line @typescript-eslint/no-implied-eval -- The LX scripts are third-party code the user asked to embed; they run in an isolated scope (shims passed as parameters, own globalThis), the same way Golia runs them in a JSContext.
            fn = new Function(...paramNames, this.scriptSource) as (...args: unknown[]) => unknown;
        } catch (error) {
            console.warn(`[lxFallback] script ${this.id} failed to compile`, error);
            return false;
        }
        try {
            fn.call(shimGlobal, lx, moduleObj, moduleObj.exports, shimGlobal, shimGlobal, shimGlobal, fetchShim, customFetchShim, bufferShim, jsonShim, cerumusic);
        } catch (error) {
            console.warn(`[lxFallback] script ${this.id} failed to evaluate`, error);
            return false;
        }
        this.pluginExports = moduleObj.exports;
        // The legacy `MusicPlugin` global: prefer the script's own global, fall back to a
        // bare assignment that landed on the real one, and clean that leak up right away.
        const musicPlugin = (shimGlobal as { MusicPlugin?: unknown }).MusicPlugin
            ?? (globalThis as unknown as { MusicPlugin?: unknown }).MusicPlugin;
        if (typeof musicPlugin === 'object' && musicPlugin !== null) {
            this.musicPlugin = musicPlugin as Record<string, unknown>;
        }
        if ((globalThis as unknown as { MusicPlugin?: unknown }).MusicPlugin !== undefined) {
            delete (globalThis as unknown as { MusicPlugin?: unknown }).MusicPlugin;
        }
        return true;
    }

    private invokeRequest(payload: LxRequestPayload, timeoutMs: number): Promise<unknown> {
        return new Promise(resolve => {
            const timer = setTimeout(() => resolve(null), timeoutMs);
            const settle = (value: unknown): void => {
                clearTimeout(timer);
                resolve(value);
            };
            try {
                const handler = this.handlers.get('request');
                let invocation: unknown;
                if (handler) {
                    invocation = handler(payload);
                } else if (typeof (this.pluginExports as { musicUrl?: unknown }).musicUrl === 'function') {
                    const musicUrl = (this.pluginExports as {
                        musicUrl: (source: string, musicInfo: LxMusicInfo, type: string) => unknown;
                    }).musicUrl;
                    invocation = musicUrl(payload.source, payload.info.musicInfo, payload.info.type);
                } else if (typeof (this.musicPlugin as { getMusicUrl?: unknown } | null)?.getMusicUrl === 'function') {
                    const getMusicUrl = (this.musicPlugin as {
                        getMusicUrl: (source: string, id: string, type: string) => unknown;
                    }).getMusicUrl;
                    const info = payload.info.musicInfo;
                    invocation = getMusicUrl(payload.source, info.musicId || info.songmid || info.id, payload.info.type);
                } else if (typeof (this.pluginExports as { getMusicUrl?: unknown }).getMusicUrl === 'function') {
                    const getMusicUrl = (this.pluginExports as {
                        getMusicUrl: (source: string, id: string, type: string) => unknown;
                    }).getMusicUrl;
                    const info = payload.info.musicInfo;
                    invocation = getMusicUrl(payload.source, info.musicId || info.songmid || info.id, payload.info.type);
                } else {
                    console.warn(`[lxFallback] script ${this.id} has no music URL resolver`);
                    settle(null);
                    return;
                }
                Promise.resolve(invocation).then(
                    value => settle(value),
                    (error: unknown) => {
                        console.warn(`[lxFallback] script ${this.id} rejected`, error);
                        settle(null);
                    },
                );
            } catch (error) {
                console.warn(`[lxFallback] script ${this.id} threw`, error);
                settle(null);
            }
        });
    }
}

const runtimes = new Map<LxScriptId, LxScriptRuntime>();

/** The cached runtime for one script; the script is evaluated on its first use. */
export const getLxRuntime = (scriptId: LxScriptId): LxScriptRuntime => {
    let runtime = runtimes.get(scriptId);
    if (!runtime) {
        const definition = LX_SCRIPTS.find(script => script.id === scriptId);
        if (!definition) throw new Error(`unknown LX script ${scriptId}`);
        runtime = new LxScriptRuntime(definition);
        runtimes.set(scriptId, runtime);
    }
    return runtime;
};
