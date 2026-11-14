import React from 'react';
import { useTranslation } from 'react-i18next';
import { Sheet, SheetButton } from '../shared/Sheet';

// src/components/modal/GoliaWelcomeDialog.tsx
// The Golia first-launch dialog: two lines, shown once per install (the startup
// experience gate owns the flag). The lines are the user's own words; the Chinese
// text is verbatim, the other locales translate the frame around the two names.

type GoliaWelcomeDialogProps = {
    isOpen: boolean;
    isDaylight: boolean;
    onClose: () => void;
};

const GoliaWelcomeDialog: React.FC<GoliaWelcomeDialogProps> = ({ isOpen, isDaylight, onClose }) => {
    const { t } = useTranslation();

    return (
        <Sheet
            isOpen={isOpen}
            onClose={onClose}
            isDaylight={isDaylight}
            size="s"
            title={t('goliaWelcome.title')}
            footer={<SheetButton data-testid="golia-welcome-close" onClick={onClose}>{t('userGuide.gotIt')}</SheetButton>}
        >
            <div data-testid="golia-welcome-dialog" className="space-y-2 text-sm leading-6 text-[color:var(--st-t1)]">
                <p>{t('goliaWelcome.line1')}</p>
                <p>{t('goliaWelcome.line2')}</p>
            </div>
        </Sheet>
    );
};

export default GoliaWelcomeDialog;
