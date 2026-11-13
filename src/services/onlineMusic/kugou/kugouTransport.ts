import md5 from 'blueimp-md5';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue } from '../providerStorage';
import { lyricProxyWebUrl, requestLyricProxyOnDesktop } from '../../lyricProxy';
import { withLoginRequestLimit } from '../login/loginRequestLimit';
import { hasNativeHttp, requestNativeHttp } from '../capacitorHttp';
import { rsaRawEncrypt } from '../../../utils/rsaRaw';
import { asRecord } from '../../../utils/record';

// src/services/onlineMusic/kugou/kugouTransport.ts

export const KUGOU_OPERATIONS = [
    'register_dev', 'login_qr_key', 'login_qr_create', 'login_qr_check', 'logout',
    'user_detail', 'user_vip_detail', 'youth_union_vip', 'youth_day_vip', 'youth_day_vip_upgrade',
    'user_playlist', 'user_cloud', 'user_cloud_url', 'user_listen', 'search',
    'audio', 'krm_audio', 'song_url', 'song_climax', 'search_lyric', 'lyric', 'playlist_track_all',
    'playlist_detail',
    'album_detail', 'album_songs', 'artist_detail', 'artist_albums', 'artist_audios',
    'everyday_recommend', 'everyday_history', 'personal_fm', 'top_card_youth', 'playlist_add',
    'playlist_del', 'playlist_tracks_add', 'playlist_tracks_del',
] as const;

export type KugouOperation = typeof KUGOU_OPERATIONS[number];
export type KugouParams = Record<string, string | number | boolean | undefined>;

// The requests a sign-in waits for. They get the sign-in's time limit; no other request does.
const LOGIN_REQUESTS: ReadonlySet<KugouOperation> = new Set(['login_qr_key', 'login_qr_create', 'login_qr_check']);

const ENDPOINTS: Record<KugouOperation, string> = {
    register_dev: '/register/dev',
    login_qr_key: '/login/qr/key',
    login_qr_create: '/login/qr/create',
    login_qr_check: '/login/qr/check',
    logout: '/logout',
    user_detail: '/user/detail',
    user_vip_detail: '/user/vip/detail',
    youth_union_vip: '/youth/union/vip',
    youth_day_vip: '/youth/day/vip',
    youth_day_vip_upgrade: '/youth/day/vip/upgrade',
    user_playlist: '/user/playlist',
    user_cloud: '/user/cloud',
    user_cloud_url: '/user/cloud/url',
    user_listen: '/user/listen',
    search: '/search',
    audio: '/audio',
    krm_audio: '/krm/audio',
    song_url: '/song/url',
    song_climax: '/song/climax',
    search_lyric: '/search/lyric',
    lyric: '/lyric',
    playlist_track_all: '/playlist/track/all',
    playlist_detail: '/playlist/detail',
    album_detail: '/album/detail',
    album_songs: '/album/songs',
    artist_detail: '/artist/detail',
    artist_albums: '/artist/albums',
    artist_audios: '/artist/audios',
    everyday_recommend: '/everyday/recommend',
    everyday_history: '/everyday/history',
    personal_fm: '/personal/fm',
    top_card_youth: '/top/card/youth',
    playlist_add: '/playlist/add',
    playlist_del: '/playlist/del',
    playlist_tracks_add: '/playlist/tracks/add',
    playlist_tracks_del: '/playlist/tracks/del',
};

const getWebApiBase = (): string => {
    const viteValue = typeof import.meta !== 'undefined' && import.meta.env?.MODE !== 'test'
        ? String((import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_KUGOU_API_BASE || '')
        : '';
    const processValue = typeof process !== 'undefined'
        ? String(process.env?.VITE_KUGOU_API_BASE || '')
        : '';
    const value = viteValue || processValue;
    return value.trim().replace(/\/$/, '');
};

const isDeviceVerificationRequired = (body: any): boolean => {
    const errorCode = Number(body?.errcode ?? body?.error_code);
    const message = String(body?.error ?? body?.error_msg ?? body?.msg ?? '');
    return errorCode === 20028 || message.includes('本次请求需要验证');
};

// The web build has no KuGouMusicApi address configured: KuGou cannot be used there at all.
export const KUGOU_API_BASE_MISSING = 'VITE_KUGOU_API_BASE is not configured';

// The operations the web build can serve directly, without a configured backend, where the
// shell has a native bridge: the QR sign-in (its upstream endpoints take a signed GET) and the
// account read the sign-in ends with, plus the daily recommendations (an Android-signed POST
// to the gateway, routed to the daily-recommendation service). Everything else still needs the
// configured backend.
const DIRECT_OPERATIONS: ReadonlySet<KugouOperation> = new Set(['login_qr_key', 'login_qr_create', 'login_qr_check', 'user_detail', 'everyday_recommend']);

// The QR image the key endpoint itself returns, kept by key until the image is asked for:
// asking for a key again would mint a different code and orphan the one on screen.
const qrImages = new Map<string, string>();

// The signature salts of the bundled backend (KuGouMusicApi util/helper.js), and the platform's
// public RSA key (1024-bit, exponent 65537), as published in its source. Only public constants.
const WEB_SIGN_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const ANDROID_SIGN_SALT = 'OIlwieks28dk2k092lksi2UIkp';
const PUBLIC_MODULUS_HEX = 'c8006ed03842d2628209bd314984ca5ed6cfe06e30c95f9d4704d9c49791d7a935ba950ecb0bc8ebf5f5994f0bac927a7eb151b3c1de343303fa539c83136eccfd7d7e511e2dbce18eaa9f784c9b50d443e75865979e0a5e216e46c684066a8d6b998580bbaa22d73f5790286bb14742e83244e44db6d707ffe162c5c7002d45';

// The web signature (KuGouMusicApi util/helper.js signatureWebParams): the `key=value` strings,
// sorted as strings, wrapped in the salt and MD5-hashed.
const signatureWebParams = (params: Record<string, string | number>): string => {
    const paramsString = Object.keys(params)
        .map(key => `${key}=${params[key]}`)
        .sort()
        .join('');
    return md5(`${WEB_SIGN_SALT}${paramsString}${WEB_SIGN_SALT}`);
};

// The Android signature (signatureAndroidParams): the keys sorted, then `key=value` joined,
// with the request body between the two salts.
const signatureAndroidParams = (params: Record<string, string | number>, data: string): string => {
    const paramsString = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('');
    return md5(`${ANDROID_SIGN_SALT}${paramsString}${data}${ANDROID_SIGN_SALT}`);
};

// The default parameters and headers the bundled backend injects into every request
// (KuGouMusicApi util/request.js), with the session's own values where one is stored.
const directDefaults = (): { params: Record<string, string | number>; headers: Record<string, string> } => {
    const clienttime = Math.floor(Date.now() / 1000);
    const dfid = readProviderSessionValue('kugou', 'dfid') || '-';
    const token = readProviderSessionValue('kugou', 'token') || '';
    const userId = readProviderSessionValue('kugou', 'userid') || '';
    const params: Record<string, string | number> = {
        dfid, mid: 'undefined', uuid: '-', appid: 1005, clientver: 20489, clienttime,
    };
    if (token) params.token = token;
    if (userId) params.userid = userId;
    return {
        params,
        headers: {
            'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
            dfid, clienttime: String(clienttime), mid: 'undefined',
            'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
        },
    };
};

const signedUrl = (base: string, query: Record<string, string | number>): string => {
    const url = new URL(base);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    return url.toString();
};

// One direct JSON request to the platform, through the native bridge (plain fetch would be
// stopped by CORS: the platform sends no Access-Control-Allow-Origin).
const requestKugouDirectJson = async (url: string, options: { method?: string; headers?: Record<string, string>; body?: string }): Promise<unknown> => {
    const response = await requestNativeHttp(url, { method: options.method ?? 'GET', headers: options.headers, body: options.body });
    if (!response.ok) {
        throw new OnlineProviderError('network', `KuGou direct request failed: ${response.status}`, 'kugou', undefined, response.status);
    }
    try {
        const parsed: unknown = JSON.parse(response.bodyText);
        return parsed;
    } catch (error) {
        throw new OnlineProviderError('invalid-response', 'KuGou direct request returned an unreadable body', 'kugou', error);
    }
};

// The QR key, straight from the platform's login host (KuGouMusicApi module/login_qr_key.js).
// The answer carries the QR image itself, kept for the create step.
const requestKugouDirectQrKey = async (): Promise<unknown> => {
    const { params, headers } = directDefaults();
    const query: Record<string, string | number> = {
        ...params, appid: 1001, type: 1, plat: 4,
        qrcode_txt: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1001&',
        srcappid: 2919,
    };
    query.signature = signatureWebParams(query);
    const body = await requestKugouDirectJson(signedUrl('https://login-user.kugou.com/v2/qrcode', query), { headers });
    const data = asRecord(asRecord(body)?.data);
    const key = data?.qrcode;
    const image = data?.qrcode_img;
    if (typeof key === 'string' && key && typeof image === 'string' && image) qrImages.set(key, image);
    return body;
};

// The QR image for a key minted above (KuGouMusicApi module/login_qr_create.js renders the same
// URL locally; here the image already came with the key).
const requestKugouDirectQrCreate = (key: string): { code: number; data: { url: string; qrimg: string } } => {
    const image = qrImages.get(key);
    if (!image) {
        throw new OnlineProviderError('invalid-response', 'KuGou QR image is not available for this key', 'kugou');
    }
    return {
        code: 200,
        data: {
            url: `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}`,
            qrimg: image,
        },
    };
};

// One poll of a QR code's state (KuGouMusicApi module/login_qr_check.js).
const requestKugouDirectQrCheck = async (key: string): Promise<unknown> => {
    const { params, headers } = directDefaults();
    const query: Record<string, string | number> = { ...params, plat: 4, srcappid: 2919, qrcode: key };
    query.signature = signatureWebParams(query);
    return requestKugouDirectJson(signedUrl('https://login-user.kugou.com/v2/get_userinfo_qrcode', query), { headers });
};

// The account read (KuGouMusicApi module/user_detail.js): the token is RSA-encrypted into the
// body, the request signed like an Android client, routed by the x-router header.
const requestKugouDirectUserDetail = async (params: KugouParams): Promise<unknown> => {
    const token = readProviderSessionValue('kugou', 'token') || '';
    const userId = Number(params.userid ?? readProviderSessionValue('kugou', 'userid') ?? '0');
    const clienttime = Math.floor(Date.now() / 1000);
    const pk = rsaRawEncrypt(
        new TextEncoder().encode(JSON.stringify({ token, clienttime })),
        PUBLIC_MODULUS_HEX,
    ).toUpperCase();
    const data = JSON.stringify({ visit_time: clienttime, usertype: 1, p: pk, userid: userId });
    const { params: defaults, headers } = directDefaults();
    const query: Record<string, string | number> = { ...defaults, plat: 1 };
    query.signature = signatureAndroidParams(query, data);
    return requestKugouDirectJson(signedUrl('https://gateway.kugou.com/v3/get_my_info', query), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'x-router': 'usercenter.kugou.com' },
        body: data,
    });
};

// The daily recommendations, straight from the platform (KuGouMusicApi module/everyday_recommend.js):
// an Android-signed POST to the gateway, routed to the daily-recommendation service. The session's
// token and userid ride along in the signed query where one is stored, so a signed-in account gets
// its own list; without one KuGou still answers with the generic list of the day (verified live
// 2026-11-13: HTTP 200, error_code 0, 30 songs under data.song_list). A non-zero error_code is the
// platform refusing, so it throws instead of coming back as an empty list.
const requestKugouDirectEverydayRecommend = async (): Promise<unknown> => {
    const { params, headers } = directDefaults();
    const query: Record<string, string | number> = { ...params, platform: 'ios' };
    query.signature = signatureAndroidParams(query, '');
    const body = await requestKugouDirectJson(signedUrl('https://gateway.kugou.com/everyday_song_recommend', query), {
        method: 'POST',
        headers: { ...headers, 'x-router': 'everydayrec.service.kugou.com' },
    });
    const errorCode = Number(asRecord(body)?.error_code);
    if (Number.isFinite(errorCode) && errorCode !== 0 && errorCode !== 200) {
        throw new OnlineProviderError('network', `KuGou direct request failed: ${errorCode}`, 'kugou');
    }
    return body;
};

// One direct operation, in the shape the web backend would have answered with.
const requestKugouDirect = async (operation: KugouOperation, params: KugouParams): Promise<unknown> => {
    if (operation === 'login_qr_key') return requestKugouDirectQrKey();
    if (operation === 'login_qr_create') {
        const key = String(params.key ?? '');
        return requestKugouDirectQrCreate(key);
    }
    if (operation === 'login_qr_check') {
        const response = await requestKugouDirectQrCheck(String(params.key ?? params.qrcode ?? ''));
        persistWebSession(operation, response);
        return response;
    }
    if (operation === 'user_detail') return requestKugouDirectUserDetail(params);
    if (operation === 'everyday_recommend') return requestKugouDirectEverydayRecommend();
    throw new OnlineProviderError('unavailable', KUGOU_API_BASE_MISSING, 'kugou');
};

// HTTP-like statuses that unambiguously mean the account session is no longer accepted.
const KUGOU_AUTH_FAILURE_STATUSES: ReadonlySet<number> = new Set([401, 403]);

// docs/ku-go-api-docs.md: an authenticated request without valid cookie credentials fails with error_code 152.
// KuGouMusicApi reports every other upstream failure (including plain network errors) as status 502 with
// no stable login-expired code, so anything outside this set must not be treated as a logout signal.
const KUGOU_AUTH_FAILURE_ERROR_CODES: ReadonlySet<number> = new Set([152]);

const BRIDGE_ERROR_PREFIX = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/;
const BRIDGE_FIELDS = /KuGouApi\[([^\]]*)\](?::\s*(.*))?/;

export type KugouFailureDetails = {
    operation?: string;
    status?: number;
    errorCode?: number;
    detail?: string;
    // The main process could not load KuGouMusicApi (`api=unloaded`).
    apiUnloaded?: boolean;
    // A session is stored that the main process cannot load in this run (`session=unreadable`).
    sessionUnreadable?: boolean;
};

const toFiniteNumber = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Reads operation/status/error_code from whatever an Electron `kugouRequest` rejection looks like:
 * the bridge's `KuGouApi[operation=.. status=.. error_code=..]` error message (the only part of an
 * Error that survives IPC), or a raw `{ status, body }` answer object from an unpatched main process.
 */
export const extractKugouFailureDetails = (error: unknown): KugouFailureDetails => {
    if (error && typeof error === 'object' && !(error instanceof Error)) {
        const answer = error as { status?: unknown; body?: { error_code?: unknown; errcode?: unknown } | null };
        return {
            status: toFiniteNumber(answer.status),
            errorCode: toFiniteNumber(answer.body?.error_code ?? answer.body?.errcode),
        };
    }

    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    const match = BRIDGE_FIELDS.exec(message);
    if (!match) {
        const detail = message.replace(BRIDGE_ERROR_PREFIX, '').trim();
        return { detail: detail && detail !== '[object Object]' ? detail : undefined };
    }
    const fields = new Map(
        match[1].split(/\s+/).filter(Boolean).map(entry => {
            const separator = entry.indexOf('=');
            return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
        }),
    );
    return {
        operation: fields.get('operation'),
        status: toFiniteNumber(fields.get('status')),
        errorCode: toFiniteNumber(fields.get('error_code')),
        detail: match[2]?.trim() || undefined,
        ...(fields.get('api') === 'unloaded' ? { apiUnloaded: true } : {}),
        ...(fields.get('session') === 'unreadable' ? { sessionUnreadable: true } : {}),
    };
};

/** Whether a KuGou failure means the session is really rejected, as opposed to a transient/unknown error. */
export const isKugouAuthFailure = (details: Pick<KugouFailureDetails, 'status' | 'errorCode'>): boolean => (
    (details.status !== undefined && KUGOU_AUTH_FAILURE_STATUSES.has(details.status))
    || (details.errorCode !== undefined && KUGOU_AUTH_FAILURE_ERROR_CODES.has(details.errorCode))
);

/**
 * Wraps an Electron IPC rejection into an OnlineProviderError so callers can tell a rejected login
 * (`auth-required`) from everything else (`network`) instead of seeing "[object Object]".
 * A stored session the main process cannot load now is `unavailable`: the account is not known, not gone.
 */
export const toKugouProviderError = (operation: KugouOperation, error: unknown): OnlineProviderError => {
    if (error instanceof OnlineProviderError) return error;
    const details = extractKugouFailureDetails(error);
    const summary = [
        `operation=${details.operation ?? operation}`,
        details.status !== undefined ? `status=${details.status}` : '',
        details.errorCode !== undefined ? `error_code=${details.errorCode}` : '',
    ].filter(Boolean).join(' ');
    const suffix = details.detail ? `: ${details.detail}` : '';
    const authFailure = isKugouAuthFailure(details);
    return new OnlineProviderError(
        authFailure ? 'auth-required' : details.sessionUnreadable ? 'unavailable' : 'network',
        `${authFailure ? 'KuGou login required' : 'KuGou request failed'} (${summary})${suffix}`,
        'kugou',
        error,
    );
};

// Reads a Web 429 Retry-After (delta seconds or HTTP date); anything unreadable is left out.
const readRetryAfterMs = (response: Response): number | undefined => {
    const raw = response.headers?.get?.('Retry-After')?.trim();
    if (!raw) return undefined;
    if (/^\d+$/.test(raw)) {
        const ms = Number(raw) * 1000;
        return Number.isSafeInteger(ms) ? ms : undefined;
    }
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
};

/**
 * Turns a non-2xx Web answer into an OnlineProviderError. 401/403 still mean the login was rejected; anything else
 * stays `network`, its status in the sentence (kugouFailure.ts reads it), the error_code KuGou answered with in
 * the cause where the body has one, and the wait a 429 asks for. A 152 in the body is deliberately not promoted
 * to auth-required, keeping the current Web logout behavior.
 */
const toKugouWebHttpError = async (response: Response): Promise<OnlineProviderError> => {
    const message = `KuGouMusicApi request failed: ${response.status}`;
    if (KUGOU_AUTH_FAILURE_STATUSES.has(response.status)) {
        return new OnlineProviderError('auth-required', message, 'kugou');
    }
    let responseBody: any;
    try {
        responseBody = await response.json();
    } catch {
        responseBody = undefined;
    }
    const body = responseBody?.body ?? responseBody;
    const errorCode = toFiniteNumber(body?.error_code ?? body?.errcode);
    return new OnlineProviderError(
        'network',
        message,
        'kugou',
        errorCode === undefined ? undefined : { errorCode },
        response.status,
        response.status === 429 ? readRetryAfterMs(response) : undefined,
    );
};

const getWebSessionCookie = (): string => {
    const values = new Map<string, string>();
    const storedCookie = readProviderSessionValue('kugou', 'cookie');
    storedCookie?.split(';').forEach(entry => {
        const separator = entry.indexOf('=');
        if (separator <= 0) return;
        values.set(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim());
    });

    const token = readProviderSessionValue('kugou', 'token');
    const userId = readProviderSessionValue('kugou', 'userid');
    const dfid = readProviderSessionValue('kugou', 'dfid');
    if (dfid) values.set('dfid', dfid);
    if (token) values.set('token', token);
    if (userId) values.set('userid', userId);
    return Array.from(values, ([key, value]) => `${key}=${value}`).join(';');
};

export const hasKugouAuthenticatedSearchSession = (): boolean => {
    // Electron keeps the reusable token/dfid in the encrypted main-process bridge. The account id
    // is only a non-secret hint that lets this synchronous selector choose authenticated search.
    if (typeof window !== 'undefined' && window.electron?.kugouRequest) {
        return Boolean(readProviderSessionValue('kugou', 'userid'));
    }
    const cookie = getWebSessionCookie();
    return ['token', 'userid', 'dfid'].every(key => (
        new RegExp(`(?:^|;)\\s*${key}=[^;]+`, 'i').test(cookie)
    ));
};

// Reproduces KuGou's anonymous Android search signature used before account-backed provider search.
export const requestKugouAnonymousSearch = async (
    keyword: string,
    page: number,
    pagesize: number,
): Promise<any> => {
    const clientTimeMs = Date.now();
    const clientTimeSec = Math.floor(clientTimeMs / 1000);
    const mid = md5(String(clientTimeMs));
    const params: Record<string, string | number> = {
        sorttype: '0',
        keyword,
        pagesize,
        page,
        userid: '0',
        appid: '3116',
        token: '',
        clienttime: clientTimeSec,
        iscorrection: '1',
        uuid: '-',
        mid,
        dfid: '-',
        clientver: '11070',
        platform: 'AndroidFilter',
    };
    const signatureSource = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('');
    params.signature = md5(
        `LnT6xpN3khm36zse0QzvmgTZ3waWdRSA${signatureSource}LnT6xpN3khm36zse0QzvmgTZ3waWdRSA`,
    );

    const targetUrl = new URL('https://complexsearch.kugou.com/v2/search/song');
    Object.entries(params).forEach(([key, value]) => targetUrl.searchParams.set(key, String(value)));
    const headers: Record<string, string> = {
        'User-Agent': 'Android14-1070-11070-201-0-SearchSong-wifi',
        'KG-Rec': '1',
        'KG-RC': '1',
        'KG-CLIENTTIMEMS': String(clientTimeMs),
        mid,
        'x-router': 'complexsearch.kugou.com',
    };
    // The shell's native bridge reaches the search host directly: it sends no CORS headers, so
    // plain fetch is stopped there. The web build has no bridge and keeps the relay.
    if (typeof window !== 'undefined' && window.electron) {
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            credentials: 'omit',
            headers,
        });
        if (!response.ok) {
            throw new OnlineProviderError(
                'network',
                `KuGou anonymous search failed: ${response.status}`,
                'kugou',
            );
        }
        return parseKugouAnonymousSearchBody(await response.text());
    }
    if (hasNativeHttp()) {
        try {
            const native = await requestNativeHttp(targetUrl.toString(), { method: 'GET', headers });
            if (!native.ok) {
                throw new OnlineProviderError(
                    'network',
                    `KuGou anonymous search failed: ${native.status}`,
                    'kugou',
                );
            }
            return parseKugouAnonymousSearchBody(native.bodyText);
        } catch (error) {
            console.warn('[Kugou] anonymous search native request failed, trying the relay', error);
        }
    }
    const response = await fetch(lyricProxyWebUrl(targetUrl.toString()), {
        method: 'GET',
        credentials: 'omit',
        headers,
    });
    if (!response.ok) {
        throw new OnlineProviderError(
            'network',
            `KuGou anonymous search failed: ${response.status}`,
            'kugou',
        );
    }
    return parseKugouAnonymousSearchBody(await response.text());
};

// The anonymous search answer, read as JSON: a non-zero error code is the platform refusing.
const parseKugouAnonymousSearchBody = (text: string): unknown => {
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        throw new OnlineProviderError(
            'invalid-response',
            'KuGou anonymous search returned an unreadable body',
            'kugou',
        );
    }
    const errorCode = Number(asRecord(body)?.error_code);
    if (Number.isFinite(errorCode) && errorCode !== 0 && errorCode !== 200) {
        throw new OnlineProviderError(
            'network',
            `KuGou anonymous search failed: ${errorCode}`,
            'kugou',
        );
    }
    return body;
};

// Legacy playInfo failures: a non-2xx answer is `network`, an unreadable body is `invalid-response`. A non-2xx is
// still a real HTTP answer, though, so its status rides along as `httpStatus` whenever it is m.kugou.com's own
// (kugouFailure.ts sorts it by the shared rules); left without one it is a plain network failure.
export const KUGOU_LEGACY_PLAY_INFO_FAILED = 'KuGou legacy playInfo failed';

const legacyPlayInfoHttpError = (status: number, httpStatus?: number): OnlineProviderError => new OnlineProviderError(
    'network',
    `${KUGOU_LEGACY_PLAY_INFO_FAILED}: ${status}`,
    'kugou',
    undefined,
    httpStatus,
);

// The Web lyric proxies answer 500 / 502 themselves when their own fetch upstream fails, so those two say nothing
// about m.kugou.com and are passed on without a status.
const isLyricProxyOwnFailureStatus = (status: number): boolean => status === 500 || status === 502;

const legacyPlayInfoBodyError = (cause: unknown): OnlineProviderError => new OnlineProviderError(
    'invalid-response',
    'KuGou legacy playInfo returned an unreadable body',
    'kugou',
    cause,
);

/**
 * Legacy mobile play-info fallback used when the current /song/url endpoint refuses a hash.
 * It is intentionally kept outside the signed Web API transport because it calls KuGou's old
 * public mobile endpoint and works without the configured VITE_KUGOU_API_BASE.
 */
export const requestKugouLegacyPlayInfo = async (hash: string): Promise<any> => {
    const targetUrl = new URL('https://m.kugou.com/app/i/getSongInfo.php');
    targetUrl.searchParams.set('cmd', 'playInfo');
    targetUrl.searchParams.set('hash', hash);
    const targetUrlString = targetUrl.toString();

    // In Electron, route through the main-process lyric proxy so CORS cannot block this
    // last-resort mobile endpoint. The Web build uses the same relay through its web address.
    const relayed = requestLyricProxyOnDesktop(targetUrlString, { method: 'GET' });
    if (relayed) {
        const response = await relayed;
        if (!response.ok) {
            // The main process rejects when it cannot reach the endpoint, so ok:false is always m.kugou.com's answer.
            throw legacyPlayInfoHttpError(response.status, response.status);
        }
        try {
            return JSON.parse(response.bodyText) as any;
        } catch (error) {
            throw legacyPlayInfoBodyError(error);
        }
    }

    const requestUrl = typeof window !== 'undefined' && window.electron
        ? targetUrlString
        : lyricProxyWebUrl(targetUrlString);
    const response = await fetch(requestUrl, {
        method: 'GET',
        credentials: 'omit',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36',
        },
    });
    if (!response.ok) {
        throw legacyPlayInfoHttpError(
            response.status,
            requestUrl === targetUrlString || !isLyricProxyOwnFailureStatus(response.status) ? response.status : undefined,
        );
    }
    try {
        return await response.json();
    } catch (error) {
        throw legacyPlayInfoBodyError(error);
    }
};

const clearWebDeviceIdentity = (): void => {
    removeProviderSessionValue('kugou', 'dfid');
    const storedCookie = readProviderSessionValue('kugou', 'cookie');
    if (!storedCookie) return;
    const retained = storedCookie.split(';').filter(entry => entry.trim() && !/^\s*dfid=/i.test(entry));
    if (retained.length > 0) {
        writeProviderSessionValue('kugou', 'cookie', retained.join(';'));
    } else {
        removeProviderSessionValue('kugou', 'cookie');
    }
};

const responsePayload = (response: any): any => response?.data || response?.body?.data || response?.body || response;

/**
 * The account a confirmed QR sign-in (status 4) brings, as a whole pair, or null. Other answers
 * carry the userid of whoever owns what was read (a public playlist's creator), not of who is
 * signed in, so they never change the account (#1101).
 */
const confirmedSignIn = (operation: KugouOperation, response: any): { token?: string; userId: string } | null => {
    if (operation !== 'login_qr_check') return null;
    const payload = responsePayload(response);
    if (Number(payload?.status) !== 4) return null;
    const userId = payload?.userid ?? payload?.user_id;
    return userId ? { token: payload?.token ? String(payload.token) : undefined, userId: String(userId) } : null;
};

/**
 * The one place the web session's account is written (registered for Dedicatus D604): the cookies,
 * the token and the account id of a confirmed sign-in, the token and the id as a whole pair.
 */
const rememberConfirmedSignIn = (signIn: { token: string; userId: string }, cookieEntries: string[]): void => {
    if (cookieEntries.length) writeProviderSessionValue('kugou', 'cookie', cookieEntries.join('; '));
    writeProviderSessionValue('kugou', 'token', signIn.token);
    writeProviderSessionValue('kugou', 'userid', signIn.userId);
};

const ACCOUNT_COOKIE_ENTRY = /^(token|userid|user_id)=/i;

/**
 * The cookies any other answer brings (registered for Dedicatus D604): it drops the account ones
 * itself, which only a confirmed sign-in writes (#1101).
 */
const rememberSessionCookies = (cookieEntries: string[]): void => {
    const kept = cookieEntries.filter(entry => !ACCOUNT_COOKIE_ENTRY.test(entry));
    if (kept.length) writeProviderSessionValue('kugou', 'cookie', kept.join('; '));
};

/**
 * The desktop app's hint of who is signed in (registered for Dedicatus D604): passed only the account id
 * of a confirmed sign-in, or the one the bridge writes into the profile answer from its own session.
 */
const rememberSignedInAccountId = (userId: string): void => {
    writeProviderSessionValue('kugou', 'userid', userId);
};

const persistWebSession = (operation: KugouOperation, response: any): void => {
    const signIn = confirmedSignIn(operation, response);
    const cookies = response?.cookie || response?.data?.cookie;
    const cookieEntries = (typeof cookies === 'string' ? cookies.split(';')
        : Array.isArray(cookies) ? cookies.map(String) : [])
        .map(entry => entry.trim())
        .filter(Boolean);
    // Half of a pair is not taken: the other half would be the previous account's. Account cookies of
    // any other answer are left out, like its account fields.
    if (signIn?.token) rememberConfirmedSignIn({ token: signIn.token, userId: signIn.userId }, cookieEntries);
    else rememberSessionCookies(cookieEntries);
    const dfid = responsePayload(response)?.dfid;
    if (dfid) writeProviderSessionValue('kugou', 'dfid', String(dfid));
};

/**
 * Removes credentials written by older desktop builds. Electron only retains the non-sensitive
 * account id in renderer storage; every reusable credential stays in the encrypted IPC bridge.
 */
const persistElectronAccountHint = (operation: KugouOperation, response: any): void => {
    ['cookie', 'token', 'dfid'].forEach(key => removeProviderSessionValue('kugou', key));
    if (operation === 'logout') {
        removeProviderSessionValue('kugou', 'userid');
        return;
    }
    // The bridge strips the token from the sign-in answer, and writes the session's own account id
    // into the profile answer: those two are the only answers that say who is signed in.
    const userId = operation === 'user_detail'
        ? responsePayload(response)?.userid
        : confirmedSignIn(operation, response)?.userId;
    if (userId) rememberSignedInAccountId(String(userId));
};

export const getKugouTransportAvailability = () => {
    if (typeof window !== 'undefined' && window.electron?.kugouRequest) return { configured: true } as const;
    // The shell's native bridge serves search and the QR sign-in directly, no backend needed.
    if (hasNativeHttp()) return { configured: true } as const;
    return getWebApiBase()
        ? { configured: true } as const
        : { configured: false, reason: 'not-configured' as const };
};

// Routes one provider request through Electron IPC or an explicitly configured Web backend.
export const requestKugou = async <T = unknown>(operation: KugouOperation, params: KugouParams = {}): Promise<T> => {
    const limited = LOGIN_REQUESTS.has(operation);
    if (typeof window !== 'undefined' && window.electron?.kugouRequest) {
        // Account credentials are injected by the main-process bridge. Drop legacy renderer values
        // at the IPC boundary so an old localStorage token cannot keep circulating after migration.
        const electronParams = Object.fromEntries(
            Object.entries(params).filter(([key]) => !['token', 'dfid', 'cookie'].includes(key.toLowerCase())),
        );
        const send = async (): Promise<unknown> => {
            try {
                return await window.electron!.kugouRequest(operation, electronParams);
            } catch (error) {
                throw toKugouProviderError(operation, error);
            }
        };
        // The desktop side cannot be told to stop: past the limit its answer is no longer waited for.
        // A confirmation that arrives after that is still kept by the main process while the dialog
        // says there was no answer; the account then shows at the next read of it.
        const response = await (limited ? withLoginRequestLimit(send) : send());
        persistElectronAccountHint(operation, response);
        return response as T;
    }

    const base = getWebApiBase();
    if (!base) {
        // No backend configured: the sign-in and the account read go direct where the shell has
        // a native bridge; anything else still has no way to run.
        if (hasNativeHttp() && DIRECT_OPERATIONS.has(operation)) {
            return (limited
                ? withLoginRequestLimit(() => requestKugouDirect(operation, params))
                : requestKugouDirect(operation, params)) as Promise<T>;
        }
        throw new OnlineProviderError('unavailable', KUGOU_API_BASE_MISSING, 'kugou');
    }
    const execute = async (targetOperation: KugouOperation, targetParams: KugouParams): Promise<any> => {
        const query = new URLSearchParams();
        Object.entries(targetParams).forEach(([key, value]) => {
            if (value !== undefined) query.set(key, String(value));
        });
        const cookie = getWebSessionCookie();
        if (cookie) query.set('cookie', cookie);
        query.set('timestamp', String(Date.now()));

        const send = async (signal?: AbortSignal) => {
            const response = await fetch(`${base}${ENDPOINTS[targetOperation]}?${query}`, { credentials: 'include', ...(signal ? { signal } : {}) });
            if (!response.ok) throw await toKugouWebHttpError(response);
            try {
                return await response.json();
            } catch (error) {
                throw new OnlineProviderError('invalid-response', `KuGouMusicApi ${targetOperation} returned an unreadable body`, 'kugou', error);
            }
        };
        // Every request made for a sign-in operation is limited, the device registration it may need too.
        const responseBody = await (limited ? withLoginRequestLimit(send) : send());
        // What a sign-out is answered with is the session that just left: it is not written back.
        if (targetOperation !== 'logout') persistWebSession(targetOperation, responseBody);
        const body = responseBody?.body ?? responseBody;
        return body;
    };

    let body = await execute(operation, params);
    if (operation !== 'register_dev' && isDeviceVerificationRequired(body)) {
        clearWebDeviceIdentity();
        await execute('register_dev', {});
        body = await execute(operation, params);
    }
    return body as T;
};
