// src/components/appUpdate/useAppUpdateStartupCheck.ts
// The once-per-launch update check, run from App just after the startup experience gate:
// it starts a couple of seconds in, so it never competes with the launch itself, and it
// only ever shows the home banner — never a dialog.

import { useEffect } from 'react';
import { checkAppUpdate } from './appUpdateStore';

export const useAppUpdateStartupCheck = (): void => {
    useEffect(() => {
        const timer = window.setTimeout(() => void checkAppUpdate({ automatic: true }), 2000);
        return () => window.clearTimeout(timer);
    }, []);
};
