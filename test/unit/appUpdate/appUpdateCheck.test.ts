// test/unit/appUpdate/appUpdateCheck.test.ts
// The Golia in-app update check: tag parsing, the lx comparison, and the silent failure
// contract (a bad request or an unparsable tag never surfaces to the listener).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    APP_UPDATE_RELEASES_API_URL,
    buildAcceleratedDownloadUrl,
    checkForAppUpdate,
    isNewerLxBuild,
    parseLxNumber,
    resolveIpaDownloadUrl,
} from '@/services/appUpdate/appUpdateCheck';

const ipaAsset = (tag: string) => ({
    name: `Folia_0.7.28-lx${tag.split('-lx')[1]}.ipa`,
    browser_download_url: `https://github.com/Rxsume/Golia/releases/download/${tag}/Folia_0.7.28-lx${tag.split('-lx')[1]}.ipa`,
});

const releaseResponse = (
    tag: string,
    url = 'https://github.com/Rxsume/Golia/releases/tag/v0.7.28-lx7',
    assets: unknown[] = [ipaAsset(tag)],
): Response => (
    new Response(JSON.stringify({ tag_name: tag, html_url: url, assets }), { status: 200 })
);

describe('parseLxNumber', () => {
    it('reads the lx number off a release tag', () => {
        expect(parseLxNumber('v0.7.28-lx5')).toBe(5);
        expect(parseLxNumber('v0.7.28-lx12')).toBe(12);
    });

    it('returns null when the tag carries no lx suffix', () => {
        expect(parseLxNumber('v0.7.28')).toBeNull();
        expect(parseLxNumber('')).toBeNull();
        expect(parseLxNumber(null)).toBeNull();
        expect(parseLxNumber(undefined)).toBeNull();
    });

    it('does not mistake an upstream tag or a mid-tag lx for a build number', () => {
        expect(parseLxNumber('v0.7.28-lx5-beta')).toBeNull();
        expect(parseLxNumber('lx5')).toBeNull();
    });
});

describe('isNewerLxBuild', () => {
    it('is newer only when the release lx is strictly greater', () => {
        expect(isNewerLxBuild(7, 6)).toBe(true);
        expect(isNewerLxBuild(6, 6)).toBe(false);
        expect(isNewerLxBuild(5, 6)).toBe(false);
    });
});

describe('checkForAppUpdate', () => {
    it('reports an update when the latest release lx is newer, with its tag and page', async () => {
        const fetchFn = vi.fn().mockResolvedValue(releaseResponse('v0.7.28-lx7'));
        const result = await checkForAppUpdate({ fetchFn, currentLx: 6 });
        expect(fetchFn).toHaveBeenCalledWith(APP_UPDATE_RELEASES_API_URL, expect.objectContaining({
            headers: { Accept: 'application/vnd.github+json' },
        }));
        expect(result).toEqual({
            available: true,
            outcome: 'available',
            latestLx: 7,
            latestTag: 'v0.7.28-lx7',
            releaseUrl: 'https://github.com/Rxsume/Golia/releases/tag/v0.7.28-lx7',
            downloadUrl: 'https://github.com/Rxsume/Golia/releases/download/v0.7.28-lx7/Folia_0.7.28-lx7.ipa',
        });
    });

    it('carries no download address when the release has no .ipa asset', async () => {
        const fetchFn = vi.fn().mockResolvedValue(releaseResponse('v0.7.28-lx7', undefined, []));
        const result = await checkForAppUpdate({ fetchFn, currentLx: 6 });
        expect(result.downloadUrl).toBeUndefined();
        expect(result.releaseUrl).toBe('https://github.com/Rxsume/Golia/releases/tag/v0.7.28-lx7');
    });

    it('reports latest when the release lx is the current build', async () => {
        const fetchFn = vi.fn().mockResolvedValue(releaseResponse('v0.7.28-lx6'));
        const result = await checkForAppUpdate({ fetchFn, currentLx: 6 });
        expect(result).toEqual({ available: false, outcome: 'latest' });
    });

    it('falls back to the tag page when the release carries no url', async () => {
        const fetchFn = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ tag_name: 'v0.7.28-lx8' }), { status: 200 }),
        );
        const result = await checkForAppUpdate({ fetchFn, currentLx: 6 });
        expect(result.releaseUrl).toBe('https://github.com/Rxsume/Golia/releases/tag/v0.7.28-lx8');
    });

    it('stays silent when the tag has no lx number', async () => {
        const fetchFn = vi.fn().mockResolvedValue(releaseResponse('v0.7.28'));
        const result = await checkForAppUpdate({ fetchFn, currentLx: 6 });
        expect(result).toEqual({ available: false, outcome: 'unavailable' });
    });

    it('stays silent on a rate-limited or failed request', async () => {
        const rateLimited = vi.fn().mockResolvedValue(new Response('rate limited', { status: 403 }));
        expect(await checkForAppUpdate({ fetchFn: rateLimited, currentLx: 6 })).toEqual({
            available: false,
            outcome: 'unavailable',
        });
        const offline = vi.fn().mockRejectedValue(new Error('network down'));
        expect(await checkForAppUpdate({ fetchFn: offline, currentLx: 6 })).toEqual({
            available: false,
            outcome: 'unavailable',
        });
    });

    it('stays silent on an unparsable body', async () => {
        const fetchFn = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
        expect(await checkForAppUpdate({ fetchFn, currentLx: 6 })).toEqual({
            available: false,
            outcome: 'unavailable',
        });
    });
});

describe('download address (lx10)', () => {
    const direct = 'https://github.com/Rxsume/Golia/releases/download/v0.7.28-lx10/Folia_0.7.28-lx10.ipa';
    const accelerated = 'https://gh-proxy.org/https://github.com/Rxsume/Golia/releases/download/v0.7.28-lx10/Folia_0.7.28-lx10.ipa';

    it('puts the accelerator in front of the direct GitHub address', () => {
        expect(buildAcceleratedDownloadUrl(direct)).toBe(accelerated);
    });

    it('builds one accelerated address per candidate base', () => {
        expect(buildAcceleratedDownloadUrl(direct, 'https://gh-proxy.com/')).toBe(
            'https://gh-proxy.com/https://github.com/Rxsume/Golia/releases/download/v0.7.28-lx10/Folia_0.7.28-lx10.ipa',
        );
    });

    it('uses the accelerated address when the accelerator answers', async () => {
        const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        await expect(resolveIpaDownloadUrl(direct, { fetchFn })).resolves.toBe(accelerated);
        expect(fetchFn).toHaveBeenCalledTimes(3);
        expect(fetchFn).toHaveBeenCalledWith(
            accelerated,
            expect.objectContaining({ method: 'HEAD' }),
        );
    });

    it('falls back to the direct address when the accelerator refuses', async () => {
        const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
        await expect(resolveIpaDownloadUrl(direct, { fetchFn })).resolves.toBe(direct);
    });

    it('falls back to the direct address when the accelerator cannot be reached', async () => {
        const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
        await expect(resolveIpaDownloadUrl(direct, { fetchFn })).resolves.toBe(direct);
    });
});

describe('download race (lx13)', () => {
    const direct = 'https://github.com/Rxsume/Golia/releases/download/v0.7.28-lx13/Folia_0.7.28-lx13.ipa';
    const ghProxyOrg = `https://gh-proxy.org/${direct}`;
    const ghProxyCom = `https://gh-proxy.com/${direct}`;
    const ghfastTop = `https://ghfast.top/${direct}`;

    const ok = () => Promise.resolve(new Response(null, { status: 200 }));
    const hang = () => new Promise<Response>(() => {});
    const delayedOk = (ms: number) => (
        () => new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response(null, { status: 200 })), ms);
        })
    );

    /** A fetch mock that answers per accelerator host, so the race can be steered. */
    const probeFetch = (byHost: Record<string, () => Promise<Response>>) => (
        vi.fn().mockImplementation((url: string) => {
            const behaviour = byHost[new URL(url).hostname];
            return behaviour ? behaviour() : Promise.reject(new Error(`unexpected probe url ${url}`));
        })
    );

    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('the first accelerator to answer wins, whichever it is', async () => {
        const slowFirst = probeFetch({ 'gh-proxy.org': delayedOk(60), 'gh-proxy.com': ok, 'ghfast.top': ok });
        await expect(resolveIpaDownloadUrl(direct, { fetchFn: slowFirst, timeoutMs: 500, raceTimeoutMs: 1000 }))
            .resolves.toBe(ghProxyCom);

        const fastFirst = probeFetch({ 'gh-proxy.org': ok, 'gh-proxy.com': delayedOk(60), 'ghfast.top': delayedOk(60) });
        await expect(resolveIpaDownloadUrl(direct, { fetchFn: fastFirst, timeoutMs: 500, raceTimeoutMs: 1000 }))
            .resolves.toBe(ghProxyOrg);
    });

    it('a hanging candidate does not block the others', async () => {
        const fetchFn = probeFetch({ 'gh-proxy.org': hang, 'gh-proxy.com': ok, 'ghfast.top': ok });
        await expect(resolveIpaDownloadUrl(direct, { fetchFn, timeoutMs: 50, raceTimeoutMs: 500 }))
            .resolves.toBe(ghProxyCom);
    });

    it('falls back to the direct address when every candidate hangs, within the race cap', async () => {
        const fetchFn = probeFetch({ 'gh-proxy.org': hang, 'gh-proxy.com': hang, 'ghfast.top': hang });
        const started = Date.now();
        await expect(resolveIpaDownloadUrl(direct, { fetchFn, timeoutMs: 50, raceTimeoutMs: 100 }))
            .resolves.toBe(direct);
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('logs the winning accelerator host', async () => {
        const fetchFn = probeFetch({ 'gh-proxy.org': delayedOk(60), 'gh-proxy.com': ok, 'ghfast.top': ok });
        await resolveIpaDownloadUrl(direct, { fetchFn, timeoutMs: 500, raceTimeoutMs: 1000 });
        expect(logSpy).toHaveBeenCalledWith('[AppUpdate] download via gh-proxy.com');
    });

    it('logs direct when every accelerator misses', async () => {
        const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
        await resolveIpaDownloadUrl(direct, { fetchFn });
        expect(logSpy).toHaveBeenCalledWith('[AppUpdate] download via direct');
    });

    it('uses the third candidate when the first two refuse', async () => {
        const fetchFn = probeFetch({
            'gh-proxy.org': () => Promise.resolve(new Response(null, { status: 404 })),
            'gh-proxy.com': () => Promise.resolve(new Response(null, { status: 503 })),
            'ghfast.top': ok,
        });
        await expect(resolveIpaDownloadUrl(direct, { fetchFn })).resolves.toBe(ghfastTop);
    });
});
