// src/services/appUpdate/appUpdateCheck.ts
// The web-only app update check for the Golia iOS shell: the Electron updater owns updates
// on the desktop, so everywhere else the app asks GitHub Releases directly. No token is sent;
// an unauthenticated request is enough for the one check per launch this does.

/** The latest Golia release, as GitHub reports it. */
export const APP_UPDATE_RELEASES_API_URL = 'https://api.github.com/repos/Rxsume/Golia/releases/latest';

/** Where a found release is downloaded from: the release page, opened in the system browser. */
export const APP_UPDATE_RELEASES_PAGE_URL = 'https://github.com/Rxsume/Golia/releases';

/** The GitHub accelerator the download goes through first (lx10): no deploy, no key. */
export const APP_UPDATE_ACCELERATOR_BASE_URL = 'https://gh-proxy.org/';

/** The lx build this app was built as (`__LX_BUILD__`, 6 for lx6); 0 when the build did not stamp one. */
export const getCurrentLxBuild = (): number => (
    typeof __LX_BUILD__ === 'undefined' || !Number.isFinite(__LX_BUILD__) ? 0 : __LX_BUILD__
);

/** The version the settings row shows, for example `Golia 0.7.28-lx6`. */
export const getCurrentAppUpdateLabel = (): string => {
    const version = typeof __APP_VERSION__ === 'undefined' ? '0.7.28' : __APP_VERSION__;
    return `Golia ${version}-lx${getCurrentLxBuild()}`;
};

export type AppUpdateCheckOutcome = 'available' | 'latest' | 'unavailable';

export type AppUpdateCheckResult = {
    available: boolean;
    /** Why the check ended this way: `unavailable` is a failed request or an unparsable tag, not "latest". */
    outcome: AppUpdateCheckOutcome;
    latestLx?: number;
    latestTag?: string;
    releaseUrl?: string;
    /**
     * The release's IPA asset, as GitHub reports it (`browser_download_url`). Absent when the
     * release carries no .ipa asset: the download button then falls back to the release page.
     */
    downloadUrl?: string;
};

/**
 * The accelerated address of a release download: the accelerator in front of the direct
 * GitHub address. Live-verified 2026-11-14 (lx9 IPA: HEAD answers 200, octet-stream,
 * `Access-Control-Allow-Origin: *`, served through Cloudflare).
 */
export const buildAcceleratedDownloadUrl = (directUrl: string): string => (
    `${APP_UPDATE_ACCELERATOR_BASE_URL}${directUrl}`
);

/**
 * The lx number of a release tag (`v0.7.28-lx5` -> 5), or null when the tag carries none.
 * Only the `-lx<N>` suffix counts, so an upstream Folia tag never looks like a Golia build.
 */
export const parseLxNumber = (tag: string | null | undefined): number | null => {
    if (!tag) {
        return null;
    }
    const match = /-lx(\d+)$/.exec(tag.trim());
    return match ? Number(match[1]) : null;
};

/** Whether the release build is newer than the one this app was built as. */
export const isNewerLxBuild = (latestLx: number, currentLx: number): boolean => latestLx > currentLx;

type ReleaseApiResponse = {
    tag_name?: unknown;
    html_url?: unknown;
    assets?: unknown;
};

/** The release's IPA asset, as GitHub reports it: the first asset whose name ends in `.ipa`. */
const readIpaDownloadUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const assets = (value as ReleaseApiResponse).assets;
    if (!Array.isArray(assets)) {
        return undefined;
    }
    for (const asset of assets) {
        if (typeof asset !== 'object' || asset === null) {
            continue;
        }
        const { name, browser_download_url: url } = asset as { name?: unknown; browser_download_url?: unknown };
        if (typeof name === 'string' && name.toLowerCase().endsWith('.ipa')
            && typeof url === 'string' && url.length > 0) {
            return url;
        }
    }
    return undefined;
};

const readRelease = (value: unknown): { tag: string | null; url: string | null; downloadUrl?: string } => {
    if (typeof value !== 'object' || value === null) {
        return { tag: null, url: null };
    }
    const response = value as ReleaseApiResponse;
    return {
        tag: typeof response.tag_name === 'string' ? response.tag_name : null,
        url: typeof response.html_url === 'string' ? response.html_url : null,
        downloadUrl: readIpaDownloadUrl(value),
    };
};

/**
 * The address a tap on "download" opens: the accelerated address when the accelerator
 * answers, the direct GitHub address otherwise. Never throws: any failure (a non-OK
 * answer, a timeout, no network) falls back to the direct address, so a tap always has
 * somewhere to go. The check is a HEAD, so it costs no download.
 */
export const resolveIpaDownloadUrl = async (directUrl: string, options?: {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
}): Promise<string> => {
    const acceleratedUrl = buildAcceleratedDownloadUrl(directUrl);
    try {
        const fetchFn = options?.fetchFn ?? fetch;
        const timeoutMs = options?.timeoutMs ?? 5000;
        const response = await fetchFn(acceleratedUrl, {
            method: 'HEAD',
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) {
            return acceleratedUrl;
        }
    } catch (error) {
        console.warn('[AppUpdate] accelerator unreachable, falling back to the direct download', error);
    }
    return directUrl;
};

/**
 * Asks GitHub for the latest Golia release and compares its lx number with this build.
 * Never throws and never reports a failure to the listener: a failed request, a non-OK
 * status, an unparsable body or a tag without an lx number all come back as not available.
 */
export const checkForAppUpdate = async (options?: {
    fetchFn?: typeof fetch;
    currentLx?: number;
}): Promise<AppUpdateCheckResult> => {
    const currentLx = options?.currentLx ?? getCurrentLxBuild();
    try {
        const fetchFn = options?.fetchFn ?? fetch;
        const response = await fetchFn(APP_UPDATE_RELEASES_API_URL, {
            headers: { Accept: 'application/vnd.github+json' },
        });
        if (!response.ok) {
            return { available: false, outcome: 'unavailable' };
        }
        const body: unknown = await response.json();
        const { tag, url, downloadUrl } = readRelease(body);
        const latestLx = parseLxNumber(tag);
        if (latestLx === null || !tag) {
            return { available: false, outcome: 'unavailable' };
        }
        if (!isNewerLxBuild(latestLx, currentLx)) {
            return { available: false, outcome: 'latest' };
        }
        return {
            available: true,
            outcome: 'available',
            latestLx,
            latestTag: tag,
            releaseUrl: url ?? `${APP_UPDATE_RELEASES_PAGE_URL}/tag/${tag}`,
            downloadUrl,
        };
    } catch (error) {
        console.warn('[AppUpdate] update check failed', error);
        return { available: false, outcome: 'unavailable' };
    }
};
