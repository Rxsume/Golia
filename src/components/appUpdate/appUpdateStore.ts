// src/components/appUpdate/appUpdateStore.ts
// The one place that owns the app update check's state, so the startup check, the home
// banner and the settings row all read the same answer and never check twice: the automatic
// check runs at most once per launch, a manual check from the settings row always runs.

import { create } from 'zustand';
import { checkForAppUpdate, resolveIpaDownloadUrl, type AppUpdateCheckResult } from '../../services/appUpdate/appUpdateCheck';
import { openOutsideLink } from '../../utils/system/outsideLink';

export type AppUpdateStatus = 'idle' | 'checking' | 'available' | 'latest' | 'error';

type AppUpdateState = {
    status: AppUpdateStatus;
    result: AppUpdateCheckResult | null;
    /** The automatic check already ran this launch. */
    autoChecked: boolean;
    /** The release tag whose banner the listener closed this launch; it does not come back. */
    dismissedTag: string | null;
    /** A download tap is resolving its address (accelerator first, direct fallback). */
    downloading: boolean;
};

export const useAppUpdateStore = create<AppUpdateState>(() => ({
    status: 'idle',
    result: null,
    autoChecked: false,
    dismissedTag: null,
    downloading: false,
}));

/** Whether the Electron updater owns updates here: it does on the desktop, so this check stays out. */
const isElectronApp = (): boolean => typeof window !== 'undefined' && Boolean(window.electron);

/**
 * Checks GitHub for a newer lx build. `automatic` is the once-per-launch startup check:
 * it runs once and a failure leaves no trace; a manual check reports latest and failure too.
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
    useAppUpdateStore.setState({ status: 'checking', autoChecked: automatic ? true : state.autoChecked });
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
};

/**
 * Downloads the found release: the IPA file itself, through the accelerator first and the
 * direct GitHub address when the accelerator does not answer. The address is handed to the
 * system browser, which saves the file (the app cannot install an IPA itself, and this
 * shell has no Filesystem plugin to save one into Files directly — see the lx10 report).
 * No .ipa asset on the release: falls back to the release page, as before.
 */
export const downloadAppUpdate = async (): Promise<void> => {
    const { result, downloading } = useAppUpdateStore.getState();
    if (downloading || !result) {
        return;
    }
    const directUrl = result.downloadUrl;
    const fallbackUrl = result.releaseUrl ?? '';
    useAppUpdateStore.setState({ downloading: true });
    try {
        const target = directUrl ? await resolveIpaDownloadUrl(directUrl) : fallbackUrl;
        if (!target) {
            return;
        }
        await openOutsideLink(target);
    } catch (error) {
        console.warn('[AppUpdate] download failed', error);
    } finally {
        useAppUpdateStore.setState({ downloading: false });
    }
};
