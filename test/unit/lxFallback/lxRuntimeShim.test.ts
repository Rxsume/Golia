// Regression test for the shim-global leak (lx3, Bug A): evaluating an LX script
// must not mutate the host's globals. `LxScriptRuntime.evaluate` used to assign the
// bridge shims onto an object whose prototype was the real `globalThis`; where the
// host defines a global (e.g. `Buffer`) with an accessor, that assignment invoked
// the prototype setter and replaced the real global — `Buffer.concat` vanished and
// every later `fetch` body read failed, so no LX script could ever resolve a URL.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.7.28';

import { describe, expect, it } from 'vitest';
import { LxScriptRuntime } from '@/services/lxFallback/lxRuntime';

const NOOP_SCRIPT = `
lx.on('request', async () => { throw new Error('noop'); });
lx.send('inited', { status: true, openDevTools: false, sources: {} });
`;

describe('LxScriptRuntime shim isolation', () => {
    it('evaluating a script leaves the host Buffer intact', async () => {
        expect(typeof Buffer.concat).toBe('function');
        const runtime = new LxScriptRuntime({ id: 'hbd', name: 'noop', source: NOOP_SCRIPT });
        await runtime.resolveMusicUrl('wy', { id: '1', title: 'x', artist: 'y', album: '', source: 'wy' } as never, '320k', 500);
        expect(typeof Buffer.concat).toBe('function');
        expect(typeof Buffer.from).toBe('function');
        expect(typeof globalThis.fetch).toBe('function');
    }, 15000);
});
