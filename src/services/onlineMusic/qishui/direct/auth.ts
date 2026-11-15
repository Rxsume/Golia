// src/services/onlineMusic/qishui/direct/auth.ts
// Car QR authorization; credentials originate only from a QR explicitly requested by the listener.
//
// A port of qishui-music-api@0.2.2 src/auth.cjs. The pending QR lives in memory
// of this instance (as in the package); the confirmed session is kept by the
// session store the caller supplies.

import { createQishuiGuard, QISHUI_APP_IDENTITY_MD5, QISHUI_CLIENT_KEY, QISHUI_PREFIX, qishuiParams, qishuiText, readQishuiGuard, qishuiCredentialExpiry } from './protocol';
import type { QishuiDirectClient, QishuiDirectSession, QishuiDirectUser } from './client';
import { QishuiDirectError } from './client';

export type QishuiLoginStage = 'access-code' | 'ticket' | 'account';

export type QishuiLoginCheck =
    | { state: 'waiting' | 'scanned' | 'expired' | 'confirmed' }
    | { state: 'error'; transient?: boolean; failure?: { case: string } };

const qrParams = (): Record<string, string> => ({
    aid: '1128',
    client_key: QISHUI_CLIENT_KEY,
    scope: 'user_info,luna.openapi.platform.interaction,luna.openapi.platform.me_tab,luna.commerce.openapi_platform.vip_info',
    state: '',
    next: '',
    jump_type: 'native',
    optional_scope_check: '',
    optional_scope_uncheck: '',
    customize_params: '{"source":"pc_auth","not_skip_confirm":"true"}',
    source_from: 'native',
    device_platform: 'android',
    app_identity: QISHUI_APP_IDENTITY_MD5,
    signature: 'cf9024ea72d9c71813238b13ea107a3d',
});

interface PendingQr {
    token: string;
    qr: string;
    expires: number;
    task?: Promise<QishuiLoginCheck>;
}

interface AccessCode {
    access_code?: unknown;
    open_id?: unknown;
    open_uid?: unknown;
    expires_time?: unknown;
}

export interface QishuiDirectAuth {
    start(): Promise<{ key: string }>;
    qr(key: string): { imageUrl: string };
    check(key: string): Promise<QishuiLoginCheck>;
    cancel(key: string): void;
    logout(): void;
    status(): Promise<QishuiDirectUser | null>;
}

export const createQishuiDirectAuth = (
    client: QishuiDirectClient,
    options: { log?: (message: string) => void; onSignOut?: () => void } = {},
): QishuiDirectAuth => {
    const log = typeof options.log === 'function' ? options.log : console.info;
    const onSignOut = options.onSignOut ?? (() => undefined);
    const { sessions } = client;
    const pending = new Map<string, PendingQr>();
    let generation = 0;
    let refreshing: Promise<QishuiDirectUser | null> | undefined;

    const clean = (): void => {
        for (const [key, value] of pending) if (value.expires <= Date.now()) pending.delete(key);
    };

    const buildQuery = (url: string, extras: Record<string, string> = {}, deviceId: string = sessions.deviceId): string => {
        const values = new URLSearchParams(qishuiParams(deviceId));
        Object.entries(extras).forEach(([key, value]) => values.set(key, value));
        return `${url}?${values}`;
    };

    // Attach a safe stage name; neither credentials nor an account's raw response enter diagnostics.
    const step = async <T>(stage: QishuiLoginStage, run: () => Promise<T>): Promise<T> => {
        try { return await run(); } catch (error) {
            if (error instanceof QishuiDirectError) {
                error.stage = stage;
                throw error;
            }
            const failure = new QishuiDirectError('invalid-response', 'Qishui sign-in response could not be read', undefined, { cause: error });
            failure.stage = stage;
            throw failure;
        }
    };

    const randomKey = (): string => {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    };

    const getUser = (credential: Omit<QishuiDirectSession, 'userId' | 'user'>): Promise<QishuiDirectUser> => step('account', async () => {
        const { my_info: user } = await client.platform('/me/info/', {}, credential) as { my_info?: Record<string, unknown> };
        if (!user || typeof user.id !== 'string' || !user.id) {
            throw new QishuiDirectError('invalid-response', 'Qishui did not identify the account');
        }
        return {
            id: user.id,
            nickname: qishuiText(user.nickname),
            avatar: (user.medium_avatar_url || user.avatar_url || user.thumb_avatar_url) as string | undefined,
            isVip: user.is_vip === true,
        };
    });

    // The ticket exchange returns the guard credential without the account
    // identity; the caller fills userId/user in after getUser confirms it.
    const ticket = async (
        access: AccessCode,
        guard: { csr?: string; guardKey?: string; guardCert?: string },
        deviceId: string,
    ): Promise<Omit<QishuiDirectSession, 'userId' | 'user'>> => {
        if (!access.access_code) throw new QishuiDirectError('invalid-response', 'Access code is missing');
        const params = new URLSearchParams({ aid: '1128', client_key: QISHUI_CLIENT_KEY, device_platform: 'android' });
        const response = await client.http(`https://open-client.douyin.com/passport/open/get_access_ticket/?${params}`, {
            body: { access_code: access.access_code, open_id: qishuiText(access.open_id || access.open_uid) },
            form: true,
            headers: {
                'bd-ticket-guard-version': '1',
                ...(guard.csr
                    ? { 'bd-ticket-guard-client-csr': guard.csr }
                    : { 'bd-ticket-guard-client-cert': guard.guardCert ?? '' }),
            },
        });
        const guardData = readQishuiGuard(response.header('bd-ticket-guard-server-data'));
        return {
            deviceId,
            guardKey: guard.guardKey ?? '',
            ...guardData,
            accessCode: qishuiText(access.access_code),
            openId: qishuiText(access.open_id || access.open_uid),
            expiresAt: qishuiCredentialExpiry(access.expires_time).getTime(),
        };
    };

    const renew = async (): Promise<QishuiDirectUser | null> => {
        const old = sessions.get();
        if (!old) return null;
        const revision = sessions.revision;
        // Every request here carries this account's own credentials, never the public client token,
        // so an explicit platform rejection means the stored session cannot be renewed.
        const signOut = (): void => {
            if (revision !== sessions.revision) return;
            sessions.clear();
            // Notify only for this renewal's actual sign-out, not a stale failure after logout.
            onSignOut();
            log('[Qishui] Stored account was rejected; signed out');
        };
        try {
            let candidate: QishuiDirectSession | Omit<QishuiDirectSession, 'userId' | 'user'> = old;
            if (old.expiresAt < Date.now() + 3600000) {
                const result = await client.http(buildQuery(`https://open.qishui.com${QISHUI_PREFIX}/access/code/refresh/`, { access_code: old.accessCode }, old.deviceId));
                const access = (result.data.data || result.data) as AccessCode;
                candidate = await ticket({ ...access, open_id: access.open_id || access.open_uid || old.openId }, old, old.deviceId);
            }
            const user = await getUser(candidate);
            if (user.id !== old.userId) {
                signOut();
                throw new QishuiDirectError('auth-required', 'Qishui account identity changed');
            }
            if (revision !== sessions.revision) return null;
            sessions.set({ ...candidate, userId: user.id, user });
            return user;
        } catch (error) {
            // HTTP 401/403 without a platform code, network and parse failures keep the session for a later retry.
            if (error instanceof QishuiDirectError && error.code === 'auth-required' && error.upstreamCode) signOut();
            throw error;
        }
    };

    return {
        async start() {
            clean();
            pending.clear();
            const mine = ++generation;
            const result = await client.http(`https://open.douyin.com/oauth/get_qrcode/?${new URLSearchParams(qrParams())}`);
            const data = (result.data.data || {}) as Record<string, unknown>;
            if (!data.token || !data.qrcode) throw new QishuiDirectError('invalid-response', 'QR code is missing');
            if (mine !== generation) throw new QishuiDirectError('unavailable', 'Sign-in was cancelled');
            const key = randomKey();
            pending.set(key, {
                token: qishuiText(data.token),
                qr: `data:image/png;base64,${qishuiText(data.qrcode)}`,
                expires: Date.now() + 300000,
            });
            log('[Qishui] Sign-in QR created');
            return { key };
        },
        qr(key) {
            clean();
            const value = pending.get(key);
            if (!value) throw new QishuiDirectError('unavailable', 'QR session expired');
            return { imageUrl: value.qr };
        },
        async check(key) {
            clean();
            const value = pending.get(key);
            if (!value) return { state: 'expired' };
            if (value.task) return value.task;
            const revision = sessions.revision;
            const run = async (): Promise<QishuiLoginCheck> => {
                const result = await client.http(`https://open.douyin.com/oauth/check_qrcode/?${new URLSearchParams({
                    ...qrParams(), token: value.token, timestamp: String(Date.now()),
                })}`);
                const data = (result.data.data || {}) as Record<string, unknown>;
                if (!['new', 'scanned', 'confirmed', 'expired', 'refused'].includes(qishuiText(data.status))) {
                    throw new QishuiDirectError('invalid-response', 'Invalid QR status');
                }
                if (data.status !== 'confirmed') {
                    if (['expired', 'refused'].includes(qishuiText(data.status))) pending.delete(key);
                    return data.status === 'refused'
                        ? { state: 'error', failure: { case: 'refused' } }
                        : { state: data.status === 'new' ? 'waiting' : data.status } as QishuiLoginCheck;
                }
                const code = (data.code || data.auth_code) as string | undefined;
                if (!code) throw new QishuiDirectError('invalid-response', 'QR authorization code is missing');
                const accessResult = await step('access-code', () => client.http(
                    buildQuery(`https://open.qishui.com${QISHUI_PREFIX}/access/code/get/`, { auth_code: code })));
                const access = (accessResult.data.data || accessResult.data) as AccessCode;
                const credential = await step('ticket', async () => ticket(access, await createQishuiGuard(), sessions.deviceId));
                const user = await getUser(credential);
                if (pending.get(key) !== value || sessions.revision !== revision) return { state: 'expired' };
                sessions.set({ ...credential, userId: user.id, user });
                pending.delete(key);
                log('[Qishui] Sign-in confirmed; account stored');
                return { state: 'confirmed' };
            };
            const task = run().finally(() => { value.task = undefined; });
            value.task = task;
            return task;
        },
        cancel(key) { pending.delete(key); },
        logout() {
            generation++;
            pending.clear();
            sessions.clear();
            log('[Qishui] Signed out');
        },
        status() {
            if (!refreshing) refreshing = renew().finally(() => { refreshing = undefined; });
            return refreshing;
        },
    };
};
