// src/components/appUpdate/AppUpdateBanner.tsx
// The home banner a found update gets: one small dismissible strip at the top of the home
// surface, never a dialog. Tapping it downloads the release's IPA file (accelerator first,
// GitHub direct as fallback) and hands it to the system browser to save; closing it hides
// it for the rest of this launch.

import React from 'react';
import { Download, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { dismissAppUpdateBanner, downloadAppUpdate, useAppUpdateStore } from './appUpdateStore';

export const AppUpdateBanner: React.FC = () => {
    const { t } = useTranslation();
    const status = useAppUpdateStore(state => state.status);
    const result = useAppUpdateStore(state => state.result);
    const dismissedTag = useAppUpdateStore(state => state.dismissedTag);

    if (status !== 'available' || !result?.releaseUrl || !result.latestTag || dismissedTag === result.latestTag) {
        return null;
    }

    return (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex justify-center px-4 pt-[calc(env(safe-area-inset-top,0px)+8px)]">
            <div className="pointer-events-auto flex min-w-0 max-w-full items-center gap-2 rounded-full bg-[var(--st-accent)] py-2 pl-3 pr-1.5 text-[13px] font-medium leading-5 text-[color:var(--st-on-accent)] shadow-lg">
                <button
                    type="button"
                    onClick={() => void downloadAppUpdate()}
                    className="flex min-w-0 items-center gap-1.5"
                >
                    <Download size={14} className="shrink-0" />
                    <span className="truncate">{t('options.appUpdateAvailable', { version: result.latestTag })}</span>
                    <span className="shrink-0 font-semibold">{t('options.appUpdateDownload')}</span>
                </button>
                <button
                    type="button"
                    aria-label={t('options.appUpdateDismiss')}
                    onClick={dismissAppUpdateBanner}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-full opacity-80 hover:opacity-100"
                >
                    <X size={14} />
                </button>
            </div>
        </div>
    );
};

export default AppUpdateBanner;
