// test/unit/appUpdate/appUpdateShare.test.ts
// The lx18 download-and-share path: the IPA is fetched in-app and handed to the system
// share sheet through the Web Share API. The shell ships no Share/Filesystem plugins,
// so this is the web-only route; the tests pin the gesture rule (no await before the
// share call), the fallbacks, and the download progress.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    canShareIpaFiles,
    downloadIpaFile,
    fileNameFromDownloadUrl,
    isWebShareAvailable,
    shareIpaFile,
} from '@/services/appUpdate/appUpdateShare';

const ipaUrl = 'https://gh-proxy.org/https://github.com/Rxsume/Golia/releases/download/v0.7.28-lx18/Folia_0.7.28-lx18.ipa';

/** A Response whose body streams in the given chunks, with an optional total. */
const streamedResponse = (chunks: string[], total?: number): Response => {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
        },
    });
    const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
    if (total !== undefined) {
        headers.set('Content-Length', String(total));
    }
    return new Response(body, { status: 200, headers });
};

describe('fileNameFromDownloadUrl', () => {
    it('takes the asset file name off the download address', () => {
        expect(fileNameFromDownloadUrl(ipaUrl)).toBe('Folia_0.7.28-lx18.ipa');
    });

    it('falls back to a plain name when the address carries none', () => {
        expect(fileNameFromDownloadUrl('https://example.invalid/')).toBe('Folia.ipa');
        expect(fileNameFromDownloadUrl('not a url')).toBe('Folia.ipa');
    });
});

describe('downloadIpaFile', () => {
    it('returns the bytes and reports the fraction downloaded', async () => {
        const fetchFn = vi.fn().mockResolvedValue(streamedResponse(['ab', 'cd'], 4));
        const progress: (number | null)[] = [];
        const blob = await downloadIpaFile(ipaUrl, {
            fetchFn,
            onProgress: (fraction) => { progress.push(fraction); },
        });
        expect(await blob.text()).toBe('abcd');
        expect(progress).toEqual([0.5, 1]);
        expect(fetchFn).toHaveBeenCalledWith(ipaUrl);
    });

    it('reports null progress when the server sends no total', async () => {
        const fetchFn = vi.fn().mockResolvedValue(streamedResponse(['ab', 'cd']));
        const progress: (number | null)[] = [];
        await downloadIpaFile(ipaUrl, {
            fetchFn,
            onProgress: (fraction) => { progress.push(fraction); },
        });
        expect(progress).toEqual([null, null]);
    });

    it('rejects on a non-OK answer, so the caller falls back to the browser', async () => {
        const fetchFn = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }));
        await expect(downloadIpaFile(ipaUrl, { fetchFn })).rejects.toThrow('404');
    });
});

describe('Web Share availability', () => {
    const realNavigator = globalThis.navigator;

    beforeEach(() => {
        vi.stubGlobal('navigator', {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal('navigator', realNavigator);
        vi.restoreAllMocks();
    });

    it('is unavailable when the webview exposes no share API', () => {
        expect(isWebShareAvailable()).toBe(false);
        expect(canShareIpaFiles()).toBe(false);
    });

    it('is available when share exists and canShare accepts a file', () => {
        vi.stubGlobal('navigator', {
            share: vi.fn(),
            canShare: vi.fn().mockReturnValue(true),
        });
        expect(isWebShareAvailable()).toBe(true);
        expect(canShareIpaFiles()).toBe(true);
    });

    it('cannot share files when canShare refuses them', () => {
        vi.stubGlobal('navigator', {
            share: vi.fn(),
            canShare: vi.fn().mockReturnValue(false),
        });
        expect(canShareIpaFiles()).toBe(false);
    });

    it('treats a missing canShare as "try it"', () => {
        vi.stubGlobal('navigator', { share: vi.fn() });
        expect(canShareIpaFiles()).toBe(true);
    });
});

describe('shareIpaFile', () => {
    const blob = new Blob(['fake-ipa-bytes'], { type: 'application/octet-stream' });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const stubShare = (implementation: () => Promise<void>, canShareResult = true) => {
        const share = vi.fn().mockImplementation(implementation);
        vi.stubGlobal('navigator', {
            share,
            canShare: vi.fn().mockReturnValue(canShareResult),
        });
        return share;
    };

    it('calls navigator.share synchronously (in the tap gesture) and reports shared', async () => {
        const share = stubShare(() => Promise.resolve());
        const outcome = shareIpaFile(blob, 'Folia_0.7.28-lx18.ipa');
        // The share call must already have happened before any await: the tap's
        // transient activation does not survive an async hop.
        expect(share).toHaveBeenCalledTimes(1);
        const [data] = share.mock.calls[0] as [{ files: File[]; title: string }];
        expect(data.files).toHaveLength(1);
        expect(data.files[0].name).toBe('Folia_0.7.28-lx18.ipa');
        expect(data.files[0].type).toBe('application/octet-stream');
        await expect(outcome).resolves.toBe('shared');
    });

    it('reports cancelled when the listener closes the sheet', async () => {
        stubShare(() => Promise.reject(new DOMException('aborted', 'AbortError')));
        await expect(shareIpaFile(blob, 'Folia_0.7.28-lx18.ipa')).resolves.toBe('cancelled');
    });

    it('reports failed for any other share error', async () => {
        stubShare(() => Promise.reject(new Error('share unavailable')));
        await expect(shareIpaFile(blob, 'Folia_0.7.28-lx18.ipa')).resolves.toBe('failed');
    });

    it('reports unavailable when the webview exposes no share API', async () => {
        vi.stubGlobal('navigator', {});
        await expect(shareIpaFile(blob, 'Folia_0.7.28-lx18.ipa')).resolves.toBe('unavailable');
    });

    it('reports unavailable when canShare refuses the file', async () => {
        stubShare(() => Promise.resolve(), false);
        await expect(shareIpaFile(blob, 'Folia_0.7.28-lx18.ipa')).resolves.toBe('unavailable');
    });
});
