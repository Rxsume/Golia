// test/unit/appUpdate/appUpdateCheck.test.ts
// The Golia in-app update check: tag parsing, the lx comparison, and the silent failure
// contract (a bad request or an unparsable tag never surfaces to the listener).

import { describe, expect, it, vi } from 'vitest';
import {
    APP_UPDATE_RELEASES_API_URL,
    checkForAppUpdate,
    isNewerLxBuild,
    parseLxNumber,
} from '@/services/appUpdate/appUpdateCheck';

const releaseResponse = (tag: string, url = 'https://github.com/Rxsume/Golia/releases/tag/v0.7.28-lx7'): Response => (
    new Response(JSON.stringify({ tag_name: tag, html_url: url }), { status: 200 })
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
        });
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
