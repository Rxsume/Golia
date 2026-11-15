import { describe, expect, it } from 'vitest';

// test/unit/qishui/directProtocol.test.ts
//
// The car-protocol crypto port: the P-256 guard key, its certificate request
// and the ticket-guard request signature, checked against Node's own crypto
// rather than against the package (which the renderer cannot load).

import { createQishuiDeviceId, createQishuiGuard, isQishuiDeviceId, qishuiGuardHeaders, readQishuiGuard } from '@/services/onlineMusic/qishui/direct/protocol';

// A minimal DER length reader: enough to walk the certificate request and
// pull its subject public key info out for verification.
const readTlv = (bytes: Uint8Array, offset: number): { tag: number; length: number; header: number; end: number } => {
    const tag = bytes[offset];
    let length = bytes[offset + 1];
    let header = 2;
    if (length & 0x80) {
        const count = length & 0x7f;
        length = 0;
        for (let index = 0; index < count; index++) length = (length << 8) | bytes[offset + 2 + index];
        header = 2 + count;
    }
    return { tag, length, header, end: offset + header + length };
};

const derChildren = (bytes: Uint8Array, start: number, end: number): Array<{ tag: number; tlvStart: number; start: number; end: number }> => {
    const children: Array<{ tag: number; tlvStart: number; start: number; end: number }> = [];
    let cursor = start;
    while (cursor < end) {
        const child = readTlv(bytes, cursor);
        children.push({ tag: child.tag, tlvStart: cursor, start: cursor + child.header, end: child.end });
        cursor = child.end;
    }
    return children;
};

const derToBytes = (pem: string): Uint8Array => {
    const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    return new Uint8Array(Buffer.from(body, 'base64'));
};

// WebCrypto ECDSA signatures are raw r||s, not the DER the certificate request
// and the ticket-guard request carry: convert before verifying.
const derToRaw = (derSignature: Uint8Array): Uint8Array => {
    let cursor = 2;
    const readInt = (): Uint8Array => {
        const length = derSignature[cursor + 1];
        const value = derSignature.slice(cursor + 2, cursor + 2 + length);
        cursor += 2 + length;
        const trimmed = value[0] === 0 ? value.slice(1) : value;
        const out = new Uint8Array(32);
        out.set(trimmed, 32 - trimmed.length);
        return out;
    };
    const raw = new Uint8Array(64);
    raw.set(readInt(), 0);
    raw.set(readInt(), 32);
    return raw;
};

describe('Qishui direct protocol', () => {
    it('builds a device id the store accepts', () => {
        const first = createQishuiDeviceId();
        const second = createQishuiDeviceId();
        expect(isQishuiDeviceId(first)).toBe(true);
        expect(first).not.toBe(second);
        expect(isQishuiDeviceId('not-a-device-id')).toBe(false);
    });

    it('builds a certificate request whose self-signature verifies', async () => {
        const guard = await createQishuiGuard();
        const csrPem = Buffer.from(guard.csr, 'base64').toString('utf8');
        expect(csrPem).toContain('-----BEGIN CERTIFICATE REQUEST-----');
        const der = derToBytes(csrPem);
        const outerTlv = readTlv(der, 0);
        const outer = derChildren(der, outerTlv.header, outerTlv.end);
        expect(outer).toHaveLength(3);
        const info = derChildren(der, outer[0].start, outer[0].end);
        expect(info).toHaveLength(4);
        const spki = der.slice(info[2].tlvStart, info[2].end);
        const publicKey = await crypto.subtle.importKey('spki', spki as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
        // The signature is a bit string: one unused-bits byte, then the DER signature.
        const signatureBytes = der.slice(outer[2].start + 1, outer[2].end);
        const infoBytes = der.slice(outer[0].tlvStart, outer[0].end);
        expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, derToRaw(signatureBytes) as BufferSource, infoBytes as BufferSource)).toBe(true);

        // The guard key round-trips as the private half of the same pair.
        const headers = await qishuiGuardHeaders({ ticket: 'TICKET1', guardKey: guard.guardKey, guardCert: 'CERT1', guardTsSign: 'TS1' }, '/me/info/');
        expect(headers['access-token']).toBe('TICKET1');
        expect(headers['bd-ticket-guard-version']).toBe('1');
        expect(headers['bd-ticket-guard-client-cert']).toBe('CERT1');
        const clientData = JSON.parse(Buffer.from(headers['bd-ticket-guard-client-data'], 'base64').toString('utf8')) as { ts_sign: string; req_content: string; req_sign: string; timestamp: number };
        expect(clientData.ts_sign).toBe('TS1');
        expect(clientData.req_content).toBe('ticket,path,timestamp');
        const content = `ticket=TICKET1&path=/api/luna/v1/platform/me/info/&timestamp=${clientData.timestamp}`;
        const derSignature = new Uint8Array(Buffer.from(clientData.req_sign, 'base64'));
        expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, derToRaw(derSignature) as BufferSource, new TextEncoder().encode(content) as BufferSource)).toBe(true);
    });

    it('reads the guard server data the ticket exchange returns', () => {
        const raw = Buffer.from(JSON.stringify({ ticket: 'T', ts_sign: 'S', client_cert: 'C' })).toString('base64');
        expect(readQishuiGuard(raw)).toEqual({ ticket: 'T', guardTsSign: 'S', guardCert: 'C' });
        expect(() => readQishuiGuard(null)).toThrow();
    });
});
