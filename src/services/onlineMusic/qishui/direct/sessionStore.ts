// src/services/onlineMusic/qishui/direct/sessionStore.ts
// The renderer's Qishui session store: the device id and the confirmed account,
// kept in the provider's own storage namespace.
//
// This mirrors electron/qishui/session.cjs (same session shape, same device-id
// rule) without its OS-encryption layer: the renderer has no safeStorage, so the
// values rest in localStorage, as other providers' session cookies do. The session
// holds a per-device P-256 guard key, never a password; logout clears it.
// The device id is not an account credential.

import { readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue } from '../../providerStorage';
import type { QishuiDirectSession, QishuiDirectSessionStore, QishuiDirectUser } from './client';
import { createQishuiDeviceId, isAccountId, isQishuiDeviceId } from './protocol';

const DEVICE_KEY = 'device';
const SESSION_KEY = 'session';

// Only accounts explicitly authorized in Folia are kept; the stored JSON must
// still be a complete session, or it is dropped rather than half-trusted.
const isStoredSession = (value: unknown): value is QishuiDirectSession => {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 && record.version !== undefined) return false;
    if (!isAccountId(record.userId)) return false;
    const user = record.user as Record<string, unknown> | undefined;
    if (!user || typeof user.id !== 'string' || !user.id) return false;
    return typeof record.ticket === 'string' && Boolean(record.ticket)
        && typeof record.guardKey === 'string' && Boolean(record.guardKey)
        && typeof record.guardCert === 'string' && Boolean(record.guardCert)
        && typeof record.guardTsSign === 'string' && Boolean(record.guardTsSign)
        && typeof record.accessCode === 'string' && Boolean(record.accessCode)
        && Number.isFinite(record.expiresAt);
};

/** The one writer of the stored Qishui session (see dev/dedicatus/credentialWriters.mjs). */
export const persistQishuiSession = (session: QishuiDirectSession | null): void => {
    // The key is a literal on purpose: the D604 check only recognizes literal keys at write sites.
    if (session) writeProviderSessionValue('qishui', 'session', JSON.stringify({ ...session, version: 1 }));
    else removeProviderSessionValue('qishui', SESSION_KEY);
};

export const createQishuiDirectSessionStore = (): QishuiDirectSessionStore => {
    let loaded = false;
    let current: QishuiDirectSession | null = null;
    let revision = 0;
    let deviceId = readProviderSessionValue('qishui', DEVICE_KEY);
    if (!isQishuiDeviceId(deviceId)) {
        deviceId = createQishuiDeviceId();
        // Literal key on purpose, as in persistQishuiSession: 'device' is not a credential key.
        writeProviderSessionValue('qishui', 'device', deviceId);
    }
    return {
        deviceId,
        get revision() { return revision; },
        get() {
            if (!loaded) {
                loaded = true;
                try {
                    const raw = readProviderSessionValue('qishui', SESSION_KEY);
                    if (typeof raw === 'string' && raw) {
                        const parsed: unknown = JSON.parse(raw);
                        if (isStoredSession(parsed)) current = parsed;
                    }
                } catch {
                    // A JSON error quotes the text it could not read; only its kind is logged.
                    console.warn('[Qishui] Stored account could not be restored');
                }
            }
            return current;
        },
        set(value) {
            loaded = true;
            current = { ...value, version: 1 };
            revision++;
            persistQishuiSession(current);
        },
        clear() {
            loaded = true;
            current = null;
            revision++;
            persistQishuiSession(null);
        },
    };
};

/** The stored account's user, for diagnostics that must not trigger a renewal. */
export const readStoredQishuiUser = (): QishuiDirectUser | null => {
    try {
        const raw = readProviderSessionValue('qishui', SESSION_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return isStoredSession(parsed) ? parsed.user : null;
    } catch {
        return null;
    }
};
