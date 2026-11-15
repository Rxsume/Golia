// test/unit/qishui/directAuthRenew.test.ts
// The Qishui renewal: an expired session refreshes (refresh → ticket → /me/info/)
// and the stored session is updated; a rejected or unusable credential signs out.

import { describe, expect, it, vi } from 'vitest';
import { createQishuiDirectAuth } from '@/services/onlineMusic/qishui/direct/auth';
import { createQishuiDirectClient, QishuiDirectError } from '@/services/onlineMusic/qishui/direct/client';
import type { QishuiDirectClient, QishuiDirectSession, QishuiDirectSessionStore } from '@/services/onlineMusic/qishui/direct/client';
import { createQishuiGuard } from '@/services/onlineMusic/qishui/direct/protocol';

const silent = (): void => {};

const fakeStore = (initial: QishuiDirectSession | null): QishuiDirectSessionStore & { current(): QishuiDirectSession | null } => {
    let current = initial;
    let revision = 0;
    return {
        deviceId: '1234567890123456789',
        get revision() { return revision; },
        get: () => current,
        set: (value: QishuiDirectSession) => { current = { ...value, version: 1 }; revision++; },
        clear: () => { current = null; revision++; },
        current: () => current,
    };
};

const oldSession = async (overrides: Partial<QishuiDirectSession> = {}): Promise<QishuiDirectSession> => {
    const guard = await createQishuiGuard();
    return {
        deviceId: '1234567890123456789',
        userId: 'USER1',
        user: { id: 'USER1', nickname: 'Nick', isVip: false },
        accessCode: 'CODE1',
        openId: 'OPEN1',
        expiresAt: Date.now() - 1000,
        ticket: 'T1',
        guardKey: guard.guardKey,
        guardCert: 'C1',
        guardTsSign: 'S1',
        ...overrides,
    };
};

const guardServerData = (): string => Buffer.from(JSON.stringify({ ticket: 'T2', ts_sign: 'S2', client_cert: 'C2' })).toString('base64');

// The mocked client: the refresh answers a new access code, the ticket exchange
// answers new guard server data, /me/info/ confirms the same account.
const mockedClient = (sessions: QishuiDirectSessionStore, myInfo: Record<string, unknown>) => {
    const http = vi.fn(async (url: string) => {
        if (url.includes('/access/code/refresh/')) {
            return {
                data: { data: { access_code: 'CODE2', open_id: 'OPEN1', expires_time: Date.now() + 6 * 3600000 } },
                header: () => null,
            };
        }
        if (url.includes('/get_access_ticket/')) {
            return { data: {}, header: (name: string) => (name === 'bd-ticket-guard-server-data' ? guardServerData() : null) };
        }
        throw new Error(`unexpected http ${url}`);
    });
    const platform = vi.fn(async () => ({ my_info: myInfo }));
    return {
        http, platform,
        command: vi.fn(),
        sessions,
        log: silent,
        warn: silent,
    } as unknown as QishuiDirectClient;
};

describe('Qishui direct renew', () => {
    it('refreshes an expired session and stores the new ticket', async () => {
        const sessions = fakeStore(await oldSession());
        const client = mockedClient(sessions, { id: 'USER1', nickname: 'Nick', medium_avatar_url: 'https://x/a.jpg', is_vip: true });
        const auth = createQishuiDirectAuth(client, { log: silent });
        const user = await auth.status();
        expect(user).toMatchObject({ id: 'USER1', nickname: 'Nick', isVip: true });
        const stored = sessions.current();
        expect(stored?.ticket).toBe('T2');
        expect(stored?.accessCode).toBe('CODE2');
        expect(stored?.userId).toBe('USER1');
        expect(stored?.expiresAt).toBeGreaterThan(Date.now());
        expect((client.http as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
            ([url]) => typeof url === 'string' && url.includes('/access/code/refresh/') && url.includes('access_code=CODE1'),
        )).toBe(true);
    });

    it('signs out when the renewed account is a different one', async () => {
        const sessions = fakeStore(await oldSession());
        const onSignOut = vi.fn();
        const client = mockedClient(sessions, { id: 'USER2', nickname: 'Other' });
        const auth = createQishuiDirectAuth(client, { log: silent, onSignOut });
        await expect(auth.status()).rejects.toMatchObject({ code: 'auth-required' });
        expect(sessions.current()).toBeNull();
        expect(onSignOut).toHaveBeenCalled();
    });

    it('rejects an account id the package would not accept', async () => {
        const sessions = fakeStore(await oldSession({ expiresAt: Date.now() + 7200000 }));
        const client = mockedClient(sessions, { id: 'has space' });
        const auth = createQishuiDirectAuth(client, { log: silent });
        await expect(auth.status()).rejects.toMatchObject({ code: 'invalid-response' });
        expect(sessions.current()).not.toBeNull();
    });

    it('rejects when /me/info/ names no account', async () => {
        const sessions = fakeStore(await oldSession({ expiresAt: Date.now() + 7200000 }));
        const client = mockedClient(sessions, {});
        const auth = createQishuiDirectAuth(client, { log: silent });
        await expect(auth.status()).rejects.toMatchObject({ code: 'invalid-response' });
    });

    it('keeps an error stage the failing step already set', async () => {
        const sessions = fakeStore(await oldSession({ expiresAt: Date.now() + 7200000 }));
        const client = mockedClient(sessions, { id: 'USER1' });
        const staged = new QishuiDirectError('invalid-response', 'stale stage');
        staged.stage = 'ticket';
        (client.platform as unknown as { mockRejectedValue: (error: unknown) => void }).mockRejectedValue(staged);
        const auth = createQishuiDirectAuth(client, { log: silent });
        const error = await auth.status().catch((caught: unknown) => caught) as QishuiDirectError;
        expect(error).toBe(staged);
        expect(error.stage).toBe('ticket');
    });

    it('stamps the account stage on an unstaged failure', async () => {
        const sessions = fakeStore(await oldSession({ expiresAt: Date.now() + 7200000 }));
        const client = mockedClient(sessions, { id: 'USER1' });
        (client.platform as unknown as { mockRejectedValue: (error: unknown) => void }).mockRejectedValue(new Error('boom'));
        const auth = createQishuiDirectAuth(client, { log: silent });
        const error = await auth.status().catch((caught: unknown) => caught) as QishuiDirectError;
        expect(error.code).toBe('invalid-response');
        expect(error.stage).toBe('account');
    });

    it('signs out when the stored guard key is not a usable key', async () => {
        const sessions = fakeStore(await oldSession({ expiresAt: Date.now() + 7200000, guardKey: 'not-a-key' }));
        const onSignOut = vi.fn();
        const client = createQishuiDirectClient({ sessions, log: silent, warn: silent });
        const auth = createQishuiDirectAuth(client, { log: silent, onSignOut });
        await expect(auth.status()).rejects.toMatchObject({ code: 'auth-required', upstreamCode: 'invalid-guard-key' });
        expect(sessions.current()).toBeNull();
        expect(onSignOut).toHaveBeenCalled();
    });
});
