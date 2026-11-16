import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_DATABASE_NAME, APP_DATABASE_VERSION_CHANGE_EVENT, appDatabase } from '../../../src/services/appDatabase';

// test/unit/services/appDatabaseVersionChange.test.ts
// Regression test for the lx20 "playing 2–3s, then the app reopens" report (lx23):
// a Dexie `versionchange` used to reload the page unconditionally
// (`window.setTimeout(() => window.location.reload(), 0)`). A versionchange can
// arrive while a song is playing — a second connection opening the database
// interleaves with the busy write window after playback starts — and the reload
// restarted the app mid-playback. The handler must close the connection and
// dispatch the event, but must NOT reload the page; the new schema is picked
// up on the next launch.

describe('AppDatabase versionchange', () => {
    const reload = vi.fn();
    const dispatchEvent = vi.fn();
    let originalWindow: unknown;

    beforeEach(async () => {
        await appDatabase.delete();
        reload.mockClear();
        dispatchEvent.mockClear();
        originalWindow = (globalThis as Record<string, unknown>).window;
        (globalThis as Record<string, unknown>).window = {
            location: { reload },
            dispatchEvent,
            setTimeout: (fn: (...args: Array<unknown>) => void, ms?: number) => globalThis.setTimeout(fn, ms),
        };
    });

    afterEach(async () => {
        (globalThis as Record<string, unknown>).window = originalWindow;
        await appDatabase.delete();
    });

    it('does not reload the page when a second connection upgrades the database', async () => {
        await appDatabase.open();
        expect(appDatabase.verno).toBe(0.9);

        // A second connection asking for a higher version fires `versionchange`
        // on the app's connection; the upgrade then proceeds once it closes.
        const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(APP_DATABASE_NAME, 10);
            request.onupgradeneeded = () => { /* version bump only */ };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onblocked = () => reject(new Error('upgrade blocked'));
        });
        upgraded.close();

        // Give the versionchange handler (and any reload it might schedule) a tick.
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(reload).not.toHaveBeenCalled();
        expect(dispatchEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: APP_DATABASE_VERSION_CHANGE_EVENT }),
        );
    });
});
