// src/services/onlineMusic/qishui/direct/protocol.ts
// Ticket-guard signing for the car protocol, on renderer primitives only.
//
// A port of qishui-music-api@0.2.2 src/protocol.cjs: the same P-256 key, the same
// PKCS#10 request shape, the same per-request signature — but node:crypto is
// replaced by WebCrypto, so this runs in the Capacitor shell (and in tests) with
// no Electron bridge. The MD5 of the app id is a constant, so it is written out
// instead of hashing at runtime (WebCrypto has no MD5).

// The error lives in its own module so this file can throw it without importing
// the client (which imports this file: that would be a cycle).
import { QishuiDirectError } from './errors';

export const QISHUI_UA = 'LunaOpenSDK/1.0.10';
export const QISHUI_PREFIX = '/api/luna/v1/platform';
export const QISHUI_CLIENT_KEY = 'aw4bbxfujo741d09';
// md5('com.luna.music.car').
export const QISHUI_APP_IDENTITY_MD5 = '82a0737a3f8d93d9958c8a7938bbc365';

/** A JSON field as text: strings and finite numbers as they read, anything else empty. */
export const qishuiText = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
};

const QISHUI_COMMON = {
    aid: '765213',
    app_id: '765213',
    app_name: 'byte_autoservice_lite',
    version_code: '100010',
    version_name: '1.0.10',
    channel: 'bydSong',
    sdk_aid: '753999',
    caller_name: 'luna_open_sdk',
    sdk_version_code: '100000100',
    sdk_version_name: '0.0.1',
    sdk_channel: 'Test',
    vehicle_type: 'BYD',
    device_brand: 'BYD',
    device_type: 'BYD',
    device_platform: 'android',
    resolution: '1920x1080',
    os_version: '13',
    ac: 'wifi',
} as const;

export const isAccountId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/u.test(value);

export const isQishuiDeviceId = (value: unknown): value is string =>
    typeof value === 'string' && /^\d{19}$/.test(value);

export const createQishuiDeviceId = (): string => {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const value = new DataView(bytes.buffer).getBigUint64(0);
    return ((value % 9000000000000000000n) + 1000000000000000000n).toString();
};

export const qishuiParams = (deviceId: string, extras: Record<string, string> = {}): string => {
    const values = new URLSearchParams({
        ...QISHUI_COMMON,
        device_id: deviceId,
        did: deviceId,
        iid: deviceId,
        vehicle_id: `qishui-${deviceId}`,
        _timestamp: String(Math.floor(Date.now() / 1000)),
        _nonce: String(crypto.getRandomValues(new Uint16Array(1))[0]),
        ...extras,
    });
    return values.toString();
};

/** Base64 of bytes, without line breaks. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    const chunk = 8192;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return btoa(binary);
};

/** Bytes of a base64 string; throws on malformed input. */
export const base64ToBytes = (value: string): Uint8Array => {
    const binary = atob(value.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
};

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
};

const der = (tag: number, ...values: Uint8Array[]): Uint8Array => {
    const value = concatBytes(...values);
    const length = value.length < 128 ? new Uint8Array([value.length])
        : value.length < 256 ? new Uint8Array([0x81, value.length])
            : new Uint8Array([0x82, value.length >> 8, value.length & 255]);
    return concatBytes(new Uint8Array([tag]), length, value);
};

/** A raw ECDSA r||s signature as a DER SEQUENCE (what Node's sign returns). */
const ecdsaRawToDer = (raw: Uint8Array): Uint8Array => {
    const half = raw.length / 2;
    const encodeInteger = (part: Uint8Array): Uint8Array => {
        let value = part;
        while (value.length > 1 && value[0] === 0) value = value.subarray(1);
        if (value[0] & 0x80) value = concatBytes(new Uint8Array([0]), value);
        return der(2, value);
    };
    return der(0x30, encodeInteger(raw.subarray(0, half)), encodeInteger(raw.subarray(half)));
};

export interface QishuiGuard {
    guardKey: string;
    csr: string;
}

// Generate a fresh P-256 key and PKCS#10 request for this Folia authorization, not a client's saved identity.
export const createQishuiGuard = async (): Promise<QishuiGuard> => {
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const subject = der(0x30, ...[[3, 'bd-ticket-guard'], [11, ''], [10, '']].map(([id, value]) => (
        der(0x31, der(0x30,
            der(6, new Uint8Array([0x55, 4, Number(id)])),
            der(12, new TextEncoder().encode(String(value))))))));
    const info = der(0x30,
        der(2, new Uint8Array([0])),
        subject,
        new Uint8Array(await crypto.subtle.exportKey('spki', publicKey)),
        der(0xa0));
    const algorithm = der(0x30, der(6, new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])));
    const rawSignature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, info as BufferSource));
    const request = der(0x30, info, algorithm, der(3, new Uint8Array([0]), ecdsaRawToDer(rawSignature)));
    const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${bytesToBase64(request).match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE REQUEST-----\n`;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
    return {
        guardKey: `-----BEGIN PRIVATE KEY-----\n${bytesToBase64(pkcs8).match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END PRIVATE KEY-----\n`,
        csr: bytesToBase64(new TextEncoder().encode(pem)),
    };
};

const importGuardKey = async (guardKey: string): Promise<CryptoKey> => {
    const derKey = base64ToBytes(guardKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
    return crypto.subtle.importKey('pkcs8', derKey as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
};

export interface QishuiGuardCredential {
    ticket: string;
    guardKey: string;
    guardCert: string;
    guardTsSign: string;
}

// The guard headers for one account request: the ticket, the certificate, and the
// request signature over ticket, path and timestamp.
export const qishuiGuardHeaders = async (
    credential: QishuiGuardCredential,
    path = '/me/info/',
): Promise<Record<string, string>> => {
    for (const key of ['ticket', 'guardKey', 'guardCert', 'guardTsSign'] as const) {
        if (typeof credential[key] !== 'string' || !credential[key] || credential[key].length > 16384) {
            throw new Error('invalid guard credential');
        }
    }
    // A stored guard key that is not a usable P-256 PKCS#8 key (a valid string
    // the store accepts, but not a key) used to throw the raw DOMException from
    // the import on every account request, and renew() only signs out on
    // 'auth-required' with an upstream code — so the session never self-cleared.
    // It is an unusable credential, not a transient failure: report it as one,
    // with a marker code so renew() can tell it from a bare HTTP 401/403.
    let key: CryptoKey;
    try {
        key = await importGuardKey(credential.guardKey);
    } catch (error) {
        throw new QishuiDirectError('auth-required', 'Qishui guard credential cannot be used', 'invalid-guard-key', { cause: error });
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const content = `ticket=${credential.ticket}&path=${QISHUI_PREFIX}${path}&timestamp=${timestamp}`;
    const rawSignature = new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(content)));
    return {
        'access-token': credential.ticket,
        'bd-ticket-guard-version': '1',
        'bd-ticket-guard-client-cert': credential.guardCert,
        'bd-ticket-guard-client-data': bytesToBase64(new TextEncoder().encode(JSON.stringify({
            ts_sign: credential.guardTsSign,
            req_content: 'ticket,path,timestamp',
            req_sign: bytesToBase64(ecdsaRawToDer(rawSignature)),
            timestamp,
        }))),
    };
};

export interface QishuiGuardResponse {
    ticket: string;
    guardTsSign: string;
    guardCert: string;
}

export const readQishuiGuard = (raw: string | null): QishuiGuardResponse => {
    if (typeof raw !== 'string' || !raw || raw.length > 65536) throw new Error('invalid guard response');
    const data: unknown = JSON.parse(new TextDecoder().decode(base64ToBytes(raw)));
    if (!data || typeof data !== 'object') throw new Error('invalid guard response');
    const { ticket, ts_sign: tsSign, client_cert: clientCert } = data as Record<string, unknown>;
    for (const value of [ticket, tsSign, clientCert]) {
        if (typeof value !== 'string' || !value || value.length > 16384) throw new Error('invalid guard response');
    }
    const cert = clientCert as string;
    return {
        ticket: ticket as string,
        guardTsSign: tsSign as string,
        guardCert: cert.includes('-----BEGIN') ? bytesToBase64(new TextEncoder().encode(cert)) : cert,
    };
};

export const qishuiCredentialExpiry = (raw: unknown): Date => {
    const value = Number(raw || 0);
    const expires = value > 1e12 ? value : value > 1e9 ? value * 1000 : value > 0 ? Date.now() + value * 1000 : Date.now() + 6 * 3600000;
    if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('invalid credential expiry');
    return new Date(expires);
};
