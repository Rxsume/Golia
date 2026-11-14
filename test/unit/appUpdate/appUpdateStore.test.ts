// test/unit/appUpdate/appUpdateStore.test.ts
// The lx18 update store: the first tap downloads the IPA in-app, the second tap shares
// it through the system share sheet. Failures and devices that cannot share files fall
// back to the browser, as before. The real share module runs here (its `navigator` and
// `fetch` are stubbed), so the tap flow is exercised end to end.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadAppUpdate, shareAppUpdate, useAppUpdateStore } from '@/components/appUpdate/appUpdateStore';
import type { AppUpdateCheckResult } from '@/services/appUpdate/appUpdateCheck';

const { resolveIpaDownloadUrlMock, openOutsideLinkMock } = vi.hoisted(() => ({
    resolveIpaDownloadUrlMock: vi.fn(),
    openOutsideLinkMock: vi.fn(),
}));

vi.mock('@/services/appUpdate/appUpdateCheck', () => ({
    checkForAppUpdate: vi.fn(),
    resolveIpaDownloadUrl: resolveIpaDownloadUrlMock,
}));

vi.mock('@/utils/system/outsideLink', () => ({
    openOutsideLink: openOutsideLinkMock,
}));

const directUrl = 'https://github.com/Rxsume/Golia/releases/download/v0.7.28-lx18/Folia_0.7.28-lx18.ipa';
const acceleratedUrl = `https://gh-proxy.org/${directUrl}`;
const releaseUrl = 'https://github.com/Rxsume/Golia/releases/tag/v0.7.28-lx18';

const availableResult = (overrides: Partial<AppUpdateCheckResult> = {}): AppUpdateCheckResult => ({
    available: true,
    outcome: 'available',
    latestLx: 18,
    latestTag: 'v0.7.28-lx18',
    releaseUrl,
    downloadUrl: directUrl,
    ...overrides,
});

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

const stubShareableNavigator = (implementation: () => Promise<void> = () => Promise.resolve()) => {
    const share = vi.fn().mockImplementation(implementation);
    vi.stubGlobal('navigator', {
        share,
        canShare: vi.fn().mockReturnValue(true),
    });
    return share;
};

const setAvailable = (overrides: Partial<AppUpdateCheckResult> = {}): void => {
    useAppUpdateStore.setState({
        status: 'available',
        result: availableResult(overrides),
        autoChecked: false,
        dismissedTag: null,
        downloading: false,
        downloadProgress: null,
        downloaded: null,
    });
};

describe('downloadAppUpdate (lx18)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
        resolveIpaDownloadUrlMock.mockImplementation(async (url: string) => `https://gh-proxy.org/${url}`);
        openOutsideLinkMock.mockResolvedValue(undefined);
        setAvailable();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.clearAllMocks();
        setAvailable();
    });

    it('downloads the IPA in-app and holds it for the share tap, without opening the browser', async () => {
        stubShareableNavigator();
        vi.mocked(fetch).mockResolvedValue(streamedResponse(['ab', 'cd'], 4));
        await downloadAppUpdate();
        const state = useAppUpdateStore.getState();
        expect(state.downloaded).not.toBeNull();
        expect(state.downloaded?.fileName).toBe('Folia_0.7.28-lx18.ipa');
        expect(await state.downloaded?.blob.text()).toBe('abcd');
        expect(state.downloading).toBe(false);
        expect(state.downloadProgress).toBe(1);
        expect(fetch).toHaveBeenCalledWith(acceleratedUrl);
        expect(openOutsideLinkMock).not.toHaveBeenCalled();
    });

    it('does not download at all when the device cannot share files, and opens the browser', async () => {
        vi.stubGlobal('navigator', {});
        await downloadAppUpdate();
        expect(fetch).not.toHaveBeenCalled();
        expect(openOutsideLinkMock).toHaveBeenCalledWith(acceleratedUrl);
        expect(useAppUpdateStore.getState().downloaded).toBeNull();
    });

    it('falls back to the browser when the download fails', async () => {
        stubShareableNavigator();
        vi.mocked(fetch).mockResolvedValue(new Response('gone', { status: 404 }));
        await downloadAppUpdate();
        expect(openOutsideLinkMock).toHaveBeenCalledWith(acceleratedUrl);
        expect(useAppUpdateStore.getState().downloaded).toBeNull();
        expect(useAppUpdateStore.getState().downloading).toBe(false);
    });

    it('opens the release page when the release carries no .ipa asset', async () => {
        stubShareableNavigator();
        setAvailable({ downloadUrl: undefined });
        await downloadAppUpdate();
        expect(fetch).not.toHaveBeenCalled();
        expect(openOutsideLinkMock).toHaveBeenCalledWith(releaseUrl);
    });
});

describe('shareAppUpdate (lx18)', () => {
    beforeEach(() => {
        resolveIpaDownloadUrlMock.mockImplementation(async (url: string) => `https://gh-proxy.org/${url}`);
        openOutsideLinkMock.mockResolvedValue(undefined);
        setAvailable();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.clearAllMocks();
        setAvailable();
    });

    const downloadFirst = async (): Promise<void> => {
        stubShareableNavigator();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamedResponse(['ab'], 2)));
        await downloadAppUpdate();
    };

    it('shares the downloaded file and clears it once shared', async () => {
        await downloadFirst();
        const share = stubShareableNavigator();
        shareAppUpdate();
        // The share call happens synchronously inside the tap.
        expect(share).toHaveBeenCalledTimes(1);
        const [data] = share.mock.calls[0] as [{ files: File[] }];
        expect(data.files[0].name).toBe('Folia_0.7.28-lx18.ipa');
        await vi.waitFor(() => expect(useAppUpdateStore.getState().downloaded).toBeNull());
        expect(openOutsideLinkMock).not.toHaveBeenCalled();
    });

    it('keeps the file when the listener closes the sheet, so they can try again', async () => {
        await downloadFirst();
        stubShareableNavigator(() => Promise.reject(new DOMException('aborted', 'AbortError')));
        shareAppUpdate();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(useAppUpdateStore.getState().downloaded).not.toBeNull();
        expect(openOutsideLinkMock).not.toHaveBeenCalled();
    });

    it('falls back to the browser when the share fails', async () => {
        await downloadFirst();
        stubShareableNavigator(() => Promise.reject(new Error('share unavailable')));
        shareAppUpdate();
        await vi.waitFor(() => expect(openOutsideLinkMock).toHaveBeenCalledWith(acceleratedUrl));
        expect(useAppUpdateStore.getState().downloaded).toBeNull();
    });

    it('does nothing without a downloaded file', () => {
        const share = stubShareableNavigator();
        shareAppUpdate();
        expect(share).not.toHaveBeenCalled();
        expect(openOutsideLinkMock).not.toHaveBeenCalled();
    });
});
