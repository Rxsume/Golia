// src/services/onlineMusic/qishui/direct/client.ts
// Car HTTP client: public media and ticket-guard account requests use separate authentication.
//
// A port of qishui-music-api@0.2.2 src/client.cjs. The only transport change is
// the fetch itself: the shell's native HTTP plugin (capacitorHttp) carries the
// request where a plain fetch would be stopped by CORS, and plain fetch stays as
// the fallback for the desktop web build and for tests.

import { hasNativeHttp, requestNativeHttp } from '../../capacitorHttp';
import { QISHUI_PREFIX, QISHUI_UA, qishuiGuardHeaders, qishuiParams } from './protocol';
import { QishuiDirectError } from './errors';
import type { QishuiGuardCredential } from './protocol';

export { QishuiDirectError } from './errors';

const AUTH_CODES = [28001003, 28001007, 28001008, 10007];
// Only known reads may be replayed. Account commands and future platform endpoints
// must not inherit a retry just because the car API uses POST for both reads and writes.
const RETRYABLE_READS = new Set(['/search/', '/playlist/detail/', '/media/mget/', '/media/mcheck/',
    '/artist/detail/', '/artist/tracks/', '/feed/mode/', '/feed/song-tab/']);

export interface QishuiDirectSessionStore {
    readonly deviceId: string;
    readonly revision: number;
    get(): QishuiDirectSession | null;
    set(session: QishuiDirectSession): void;
    clear(): void;
}

export interface QishuiDirectUser {
    id: string;
    nickname: string;
    avatar?: unknown;
    isVip: boolean;
}

export interface QishuiDirectSession extends QishuiGuardCredential {
    version?: 1;
    deviceId: string;
    userId: string;
    user: QishuiDirectUser;
    accessCode: string;
    openId: string;
    expiresAt: number;
}

interface DirectHttpAnswer {
    status: number;
    bodyText: string;
    header(name: string): string | null;
}

// One request through the native bridge where it exists, else plain fetch. Each
// upstream call has the package's own 25 s limit; the transport's overall limit
// (online/login) only stops waiting for the answer, as with the desktop bridge.
const directFetch = async (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
}): Promise<DirectHttpAnswer> => {
    if (hasNativeHttp()) {
        const response = await requestNativeHttp(url, {
            method: init.method,
            headers: init.headers,
            body: init.body,
            timeoutMs: 25000,
        });
        const headers = new Map(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
        return { status: response.status, bodyText: response.bodyText, header: name => headers.get(name.toLowerCase()) ?? null };
    }
    const response = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        redirect: 'error',
        signal: AbortSignal.timeout(25000),
    });
    return {
        status: response.status,
        bodyText: await response.text(),
        header: name => response.headers.get(name),
    };
};

type JsonObject = Record<string, unknown>;

const checked = (data: unknown): JsonObject => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new QishuiDirectError('invalid-response', 'Invalid Qishui response');
    const record = data as JsonObject;
    const nested = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
        ? record.data as JsonObject : undefined;
    const code = Number(record.err_no ?? nested?.error_code ?? 0);
    if (code) throw new QishuiDirectError(AUTH_CODES.includes(code) ? 'auth-required' : 'unavailable', 'Qishui rejected the request', String(code));
    return record;
};

const HOSTS = ['365yg.com', 'douyinvod.com', 'douyinscdn.com', 'bytefcdn.com', 'bytecdn.cn', 'byteicdn.com', 'ibytedtos.com',
    'pstatp.com', 'snssdk.com', 'bytedance.com', 'bytetos.com', 'volcvideo.com', 'volccdn.com', 'volces.com',
    'volcengineapi.com', 'douyin.com', 'qishui.com', 'zijieapi.com', 'zjcdn.com'];

/** Only an https URL on a known media host is playable; anything else is refused. */
export const qishuiMediaUrl = (raw: unknown): string => {
    let url: URL;
    try { url = new URL(String(raw)); } catch { throw new QishuiDirectError('invalid-response', 'Invalid Qishui media URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
        || !HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
        throw new QishuiDirectError('invalid-response', 'Untrusted Qishui media host');
    }
    return url.href;
};

// Names only the host of a refused media URL; its path and query may carry signatures.
export const qishuiMediaHost = (raw: unknown): string => {
    try { return new URL(String(raw)).hostname || 'unknown host'; } catch { return 'invalid URL'; }
};

export interface QishuiDirectClient {
    http(url: string, options?: {
        body?: Record<string, unknown>;
        headers?: Record<string, string>;
        form?: boolean;
    }): Promise<{ data: JsonObject; header(name: string): string | null }>;
    platform(path: string, body?: Record<string, unknown>, credential?: QishuiDirectSession | Omit<QishuiDirectSession, 'userId' | 'user'> | true): Promise<JsonObject>;
    command(path: string, body?: Record<string, unknown>): Promise<JsonObject>;
    sessions: QishuiDirectSessionStore;
    log(message: string): void;
    warn(message: string): void;
}

export const createQishuiDirectClient = (options: {
    sessions: QishuiDirectSessionStore;
    log?: (message: string) => void;
    warn?: (message: string) => void;
}): QishuiDirectClient => {
    const { sessions } = options;
    const log = typeof options.log === 'function' ? options.log : console.info;
    const warn = typeof options.warn === 'function' ? options.warn : typeof options.log === 'function' ? options.log : console.warn;

    const http = async (url: string, { body, headers = {}, form = false }: {
        body?: Record<string, unknown>;
        headers?: Record<string, string>;
        form?: boolean;
    } = {}): Promise<{ data: JsonObject; header(name: string): string | null }> => {
        let answer: DirectHttpAnswer;
        try {
            answer = await directFetch(url, {
                method: body === undefined ? 'GET' : 'POST',
                headers: {
                    'user-agent': QISHUI_UA,
                    ...(body === undefined ? {} : { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }),
                    ...headers,
                },
                ...(body === undefined ? {} : { body: form ? new URLSearchParams(
                    Object.entries(body).map(([key, value]) => [key, String(value)]),
                ).toString() : JSON.stringify(body) }),
            });
        } catch (cause) {
            throw new QishuiDirectError('network', 'Qishui service could not be reached', undefined, { cause });
        }
        if (answer.status < 200 || answer.status >= 300) {
            throw new QishuiDirectError(
                answer.status === 429 ? 'unavailable' : [401, 403].includes(answer.status) ? 'auth-required' : 'network',
                `Qishui HTTP ${answer.status}`);
        }
        let parsed: unknown;
        try { parsed = JSON.parse(answer.bodyText); } catch (cause) {
            throw new QishuiDirectError('invalid-response', 'Qishui response is not JSON', undefined, { cause });
        }
        try { return { data: checked(parsed), header: name => answer.header(name) }; } catch (error) {
            if (error instanceof QishuiDirectError) throw error;
            throw new QishuiDirectError('invalid-response', 'Qishui response is not JSON', undefined, { cause: error });
        }
    };

    const query = (path: string, extras: Record<string, string> = {}, deviceId: string = sessions.deviceId): string => {
        const values = new URLSearchParams(qishuiParams(deviceId));
        Object.entries(extras).forEach(([key, value]) => values.set(key, value));
        return `${path}?${values}`;
    };

    let tokenEntry: { task: Promise<string> } | undefined;
    const clientToken = (): { task: Promise<string> } => {
        if (!tokenEntry) {
            const entry = {} as { task: Promise<string> };
            entry.task = http(query(`https://open.qishui.com${QISHUI_PREFIX}/client/token/get/`, { trigger_type: 'cold_start' }))
                .then(({ data }) => {
                    const clientTokenValue = data.client_token;
                    if (typeof clientTokenValue !== 'string' || !clientTokenValue) {
                        throw new QishuiDirectError('invalid-response', 'Client token is missing');
                    }
                    return clientTokenValue;
                }).catch((error: unknown) => { if (tokenEntry === entry) tokenEntry = undefined; throw error; });
            tokenEntry = entry;
        }
        return tokenEntry;
    };

    const platform = async (path: string, body: Record<string, unknown> = {}, credential?: QishuiDirectSession | Omit<QishuiDirectSession, 'userId' | 'user'> | true): Promise<JsonObject> => {
        let resolved: QishuiDirectSession | Omit<QishuiDirectSession, 'userId' | 'user'> | null = null;
        if (credential === true) {
            resolved = sessions.get();
            if (!resolved) throw new QishuiDirectError('auth-required', 'Sign in to Qishui first');
        } else if (credential) {
            resolved = credential;
        }
        const account = resolved || sessions.get();
        const revision = sessions.revision;
        const request = async (headers: Record<string, string>): Promise<JsonObject> => {
            const { data } = await http(query(`https://open.douyin.com${QISHUI_PREFIX}${path}`, {}, account?.deviceId), {
                body: { ...body, common_params: { ...(account && 'userId' in account && account.userId ? { user_id: account.userId } : {}) } },
                headers,
            });
            const inner = data.data;
            if (!inner || typeof inner !== 'object') throw new QishuiDirectError('invalid-response', 'Qishui data is missing');
            return inner as JsonObject;
        };
        // Ticket-guard failures belong to the account flow, not the public client token.
        if (resolved) return request(await qishuiGuardHeaders(resolved, path));
        let token = clientToken();
        for (let attempt = 0; ; attempt++) {
            const headers = { 'access-token': await token.task };
            if (attempt && revision !== sessions.revision) {
                throw new QishuiDirectError('unavailable', 'Qishui account changed during the request');
            }
            try { return await request(headers); } catch (error) {
                if (!(error instanceof QishuiDirectError) || error.upstreamCode !== '28001008') throw error;
                // A delayed failure for an old token cannot invalidate a newer generation.
                if (tokenEntry === token) tokenEntry = undefined;
                if (attempt || !RETRYABLE_READS.has(path)) throw error;
                // Share the replacement, including its failure, across concurrent expired reads.
                // A later independent request can acquire again after a failed token exchange.
                token = clientToken();
            }
        }
    };

    // Account writes (collect/playlist/dislike) use the ticket-guard credential and may answer without data.
    const command = async (path: string, body: Record<string, unknown> = {}): Promise<JsonObject> => {
        const credential = sessions.get();
        if (!credential) throw new QishuiDirectError('auth-required', 'Sign in to Qishui first');
        const { data } = await http(query(`https://open.douyin.com${QISHUI_PREFIX}${path}`, {}, credential.deviceId), {
            body: { ...body, common_params: { ...(credential.userId ? { user_id: credential.userId } : {}) } },
            headers: await qishuiGuardHeaders(credential, path),
        });
        const inner = data.data;
        return inner && typeof inner === 'object' ? inner as JsonObject : {};
    };

    return { http, platform, command, sessions, log, warn };
};
