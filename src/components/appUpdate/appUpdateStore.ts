// src/components/appUpdate/appUpdateStore.ts
// The one place that owns the app update check's state, so the startup check, the home
// banner and the settings row all read the same answer and never check twice: the automatic
// check runs at most once per launch, a manual check from the settings row always runs.

import { create } from 'zustand';
import { checkForAppUpdate, resolveIpaDownloadUrl, type AppUpdateCheckResult } from '../../services/appUpdate/appUpdateCheck';
import {
    canShareIpaFiles,
    downloadIpaFile,
    fileNameFromDownloadUrl,
    shareIpaFile,
} from '../../services/appUpdate/appUpdateShare';
import { openOutsideLink } from '../../utils/system/outsideLink';

export type AppUpdateStatus = 'idle' | 'checking' | 'available' | 'latest' | 'error';

/** A downloaded IPA held in memory, waiting for the share tap. */
export type AppUpdateDownloadedFile = {
    blob: Blob;
    fileName: string;
    /** The resolved address it came from, so a failed share still has somewhere to go. */
    downloadUrl: string;
};

type AppUpdateState = {
    status: AppUpdateStatus;
    result: AppUpdateCheckResult | null;
    /** The automatic check already ran this launch. */
    autoChecked: boolean;
    /** The release tag whose banner the listener closed this launch; it does not come back. */
    dismissedTag: string | null;
    /** A download tap is resolving its address (accelerator first, direct fallback). */
    downloading: boolean;
    /** The fraction of the IPA downloaded (0–1), or null while the total is unknown. */
    downloadProgress: number | null;
    /** The IPA once it is downloaded, until it is shared or discarded. */
    downloaded: AppUpdateDownloadedFile | null;
};

export const useAppUpdateStore = create<AppUpdateState>(() => ({
    status: 'idle',
    result: null,
    autoChecked: false,
    dismissedTag: null,
    downloading: false,
    downloadProgress: null,
    downloaded: null,
}));

/** Whether the Electron updater owns updates here: it does on the desktop, so this check stays out. */
const isElectronApp = (): boolean => typeof window !== 'undefined' && Boolean(window.electron);

/** Drops a downloaded IPA (it belongs to the previous check's release) and its progress. */
const clearDownloaded = (): void => {
    useAppUpdateStore.setState({ downloaded: null, downloadProgress: null });
};

/**
 * Checks GitHub for a newer lx build. `automatic` is the once-per-launch startup check:
 * it runs once and a failure leaves no trace; a manual check reports latest and failure too.
 * A new check discards any downloaded IPA: it belongs to the release just checked.
 */
export const checkAppUpdate = async (options?: { automatic?: boolean }): Promise<void> => {
    const automatic = options?.automatic ?? false;
    const state = useAppUpdateStore.getState();
    if (automatic && state.autoChecked) {
        return;
    }
    if (state.status === 'checking') {
        return;
    }
    if (isElectronApp()) {
        useAppUpdateStore.setState({ autoChecked: true });
        return;
    }
    useAppUpdateStore.setState({
        status: 'checking',
        autoChecked: automatic ? true : state.autoChecked,
        downloaded: null,
        downloadProgress: null,
    });
    const result = await checkForAppUpdate();
    useAppUpdateStore.setState({
        result,
        status: result.outcome === 'available'
            ? 'available'
            : result.outcome === 'latest'
                ? 'latest'
                : automatic ? 'idle' : 'error',
    });
};

/** Closes the home banner for this launch; the settings row still shows the found version. */
export const dismissAppUpdateBanner = (): void => {
    const { result } = useAppUpdateStore.getState();
    useAppUpdateStore.setState({ dismissedTag: result?.latestTag ?? null });
    clearDownloaded();
};

/** Opens a download address in the system browser: the pre-lx18 behaviour, kept as the fallback. */
const openDownloadInBrowser = async (url: string): Promise<void> => {
    if (!url) {
        return;
    }
    await openOutsideLink(url);
};

/**
 * Shares the downloaded IPA through the system share sheet. This is the second tap:
 * it runs synchronously from the click handler (the downloaded file is already in
 * memory), because `navigator.share` only runs inside the tap's user gesture. A
 * cancelled sheet keeps the file so the listener can try again; any other outcome
 * that is not a share falls back to the browser.
 */
export const shareAppUpdate = (): void => {
    const { result, downloaded } = useAppUpdateStore.getState();
    if (!downloaded || !result) {
        return;
    }
    const fallbackUrl = downloaded.downloadUrl || result.releaseUrl || '';
    // No await before this call: the share sheet has to be opened inside this tap.
    void shareIpaFile(downloaded.blob, downloaded.fileName).then(async (outcome) => {
        if (outcome === 'shared') {
            console.log('[AppUpdate] update shared via the system share sheet');
            clearDownloaded();
            return;
        }
        if (outcome === 'cancelled') {
            return;
        }
        console.warn(`[AppUpdate] share ${outcome}, falling back to the browser`);
        clearDownloaded();
        try {
            await openDownloadInBrowser(fallbackUrl);
        } catch (error) {
            console.warn('[AppUpdate] browser fallback failed', error);
        }
    });
};

/**
 * The first tap on "download": the IPA is fetched inside the app (the accelerator
 * address the lx13 race already resolved, with the direct GitHub address when the
 * accelerator does not answer) and held in memory; the button then becomes the
 * share tap. No .ipa asset on the release, a device that cannot share files, or a
 * failed download all fall back to the system browser, as before — the share sheet
 * is never shown with a missing or partial file.
 */
export const downloadAppUpdate = async (): Promise<void> => {
    const { result, downloading, downloaded } = useAppUpdateStore.getState();
    if (downloading || !result) {
        return;
    }
    if (downloaded) {
        shareAppUpdate();
        return;
    }
    const directUrl = result.downloadUrl;
    const fallbackUrl = result.releaseUrl ?? '';
    if (!directUrl) {
        await openDownloadInBrowser(fallbackUrl);
        return;
    }
    if (!canShareIpaFiles()) {
        console.log('[AppUpdate] this device cannot share files, falling back to the browser');
        const target = await resolveIpaDownloadUrl(directUrl);
        await openDownloadInBrowser(target);
        return;
    }
    // The tag this download belongs to: a manual re-check may land a newer release
    // while it is in flight (it clears `downloaded` and moves `result` on), and the
    // share tap must never offer the older IPA while the UI shows the newer version.
    const tagAtStart = result.latestTag;
    useAppUpdateStore.setState({ downloading: true, downloadProgress: null });
    let target = directUrl;
    try {
        target = await resolveIpaDownloadUrl(directUrl);
        const blob = await downloadIpaFile(target, {
            onProgress: (fraction) => {
                // Stale progress from a download a newer check already discarded.
                if (useAppUpdateStore.getState().result?.latestTag === tagAtStart) {
                    useAppUpdateStore.setState({ downloadProgress: fraction });
                }
            },
        });
        if (useAppUpdateStore.getState().result?.latestTag !== tagAtStart) {
            console.warn(`[AppUpdate] a newer check superseded ${tagAtStart} mid-download; discarding the stale IPA`);
            return;
        }
        useAppUpdateStore.setState({
            downloaded: { blob, fileName: fileNameFromDownloadUrl(target), downloadUrl: target },
            downloadProgress: 1,
        });
        console.log('[AppUpdate] update downloaded, ready to share');
    } catch (error) {
        if (useAppUpdateStore.getState().result?.latestTag !== tagAtStart) {
            console.warn(`[AppUpdate] download for ${tagAtStart} failed after a newer check; not opening the superseded release`, error);
            return;
        }
        console.warn('[AppUpdate] download failed, falling back to the browser', error);
        try {
            await openDownloadInBrowser(target);
        } catch (browserError) {
            console.warn('[AppUpdate] browser fallback failed', browserError);
        }
    } finally {
        useAppUpdateStore.setState({ downloading: false });
    }
};
