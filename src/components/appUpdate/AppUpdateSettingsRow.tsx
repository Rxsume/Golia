// src/components/appUpdate/AppUpdateSettingsRow.tsx
// The 检查更新 row on the Help page, under the version: the current build, a check on tap,
// and the download button once a newer lx build is found. The app cannot install an IPA
// itself, so the button downloads the release's IPA file (accelerator first, GitHub direct
// as fallback) and hands it to the system browser to save.

import React from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentAppUpdateLabel } from '../../services/appUpdate/appUpdateCheck';
import { Button, Row } from '../modal/settings/kit';
import { checkAppUpdate, downloadAppUpdate, useAppUpdateStore } from './appUpdateStore';

export const AppUpdateSettingsRow: React.FC = () => {
    const { t } = useTranslation();
    const status = useAppUpdateStore(state => state.status);
    const result = useAppUpdateStore(state => state.result);
    const downloading = useAppUpdateStore(state => state.downloading);
    const isChecking = status === 'checking';
    const isAvailable = status === 'available' && Boolean(result?.latestTag);

    return (
        <Row
            label={t('options.appUpdateCheck')}
            hint={t('options.appUpdateCurrentVersion', { version: getCurrentAppUpdateLabel() })}
        >
            {isAvailable ? (
                <>
                    <span className="shrink-0 text-[13px] font-medium text-[color:var(--st-t1)]">
                        {t('options.appUpdateAvailable', { version: result?.latestTag ?? '' })}
                    </span>
                    <Button variant="primary" onClick={() => void downloadAppUpdate()} disabled={downloading}>
                        {downloading ? t('options.appUpdatePreparingDownload') : t('options.appUpdateDownload')}
                    </Button>
                </>
            ) : (
                <>
                    {status === 'latest' && (
                        <span className="shrink-0 text-[13px] text-[color:var(--st-t2)]">{t('options.appUpdateLatest')}</span>
                    )}
                    {status === 'error' && (
                        <span className="shrink-0 text-[13px] text-[color:var(--st-t2)]">{t('options.appUpdateCheckFailed')}</span>
                    )}
                    <Button onClick={() => void checkAppUpdate()} disabled={isChecking}>
                        {isChecking ? t('options.updateChecking') : t('options.appUpdateCheck')}
                    </Button>
                </>
            )}
        </Row>
    );
};

export default AppUpdateSettingsRow;
