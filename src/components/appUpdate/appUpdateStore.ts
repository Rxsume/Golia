// src/components/appUpdate/appUpdateStore.ts
// The one place that owns the app update check's state, so the startup check, the home
// banner and the settings row all read the same answer and never check twice: the automatic
// check runs at most once per launch, a manual check from the settings row always runs.

import { create } from 'zustand';
import { checkForAppUpdate, type AppUpdateCheckResult } from '../../services/appUpdate/appUpdateCheck';

export type AppUpdateStatus = 'idle' | 'checking' | 'available' | 'latest' | 'error';

type AppUpdateState = {
    status: AppUpdateStatus;
    result: AppUpdateCheckResult | null;
    /** The automatic check already ran this launch. */
    autoChecked: boolean;
    /** The release tag whose banner the listener closed this launch; it does not come back. */
    dismissedTag: string | null;
};

export const useAppUpdateStore = create<AppUpdateState>(() => ({
    status: 'idle',
    result: null,
    autoChecked: false,
    dismissedTag: null,
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
