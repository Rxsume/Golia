import { useCallback, useEffect, useState } from 'react';
import { USER_GUIDE_AUTO_OPEN_VERSION } from '../components/modal/userGuideContent';
import { skipsStartupExperience } from '../dev/devLaunchFlags';
import { hasOnboardingLibrarySuiteChoice } from '../library/app/librarySuiteChoice';
import { requestPlaybackEntryViewPrompt, usePlaybackEntryViewStore } from '../stores/usePlaybackEntryViewStore';
import { loadSourcesOnboarding, useSourcesOnboardingStore } from '../components/modal/playback-entry-view/sourcesOnboarding';
import { useSettingsModalStore } from '../stores/useSettingsModalStore';
import { getStoredBoolean, setStoredBoolean } from '../stores/storagePrimitives';

// src/hooks/useStartupExperienceGate.ts

const LAST_SEEN_RELEASE_NOTES_VERSION_STORAGE_KEY = 'folia_last_seen_guide_version';
/** The Golia first-launch dialog has been shown once; it never opens again. */
const GOLIA_WELCOME_SHOWN_STORAGE_KEY = 'golia_welcome_shown';

export type StartupExperienceStep = 'golia-welcome' | 'release-notes' | 'playback-entry-view' | 'ponder' | null;

type StartupExperienceState = {
    /** The Golia first-launch dialog has been shown once (it is once per install). */
    hasSeenGoliaWelcome: boolean;
    isGoliaWelcomeOpen: boolean;
    isCurrentRelease: boolean;
    /** Ponder onboarding was completed in some version (it is shown once per install). */
    hasSeenPonder: boolean;
    /**
     * Ponder onboarding was completed in this version. It is the last startup step and nothing else opens it,
     * so this means the whole sequence already ran for this release.
     */
    hasFinishedThisRelease: boolean;
    hasSeenReleaseNotes: boolean;
    isReleaseNotesOpen: boolean;
    hasChosenPlaybackEntryView: boolean;
    /**
     * The library-interface page is still owed (both suites exist and it has never been shown). Unlike everything
     * else here it is not gated by the release: everyone is asked once (2026-10-10), whatever version they are on.
     */
    needsLibrarySuitePrompt: boolean;
    /**
     * The sources page is still owed (Folium 2.0 plan §5.3): the main process gave this fresh profile 'pending' and
     * it has not been answered. Like the library-interface page it is not gated by the release.
     */
    needsSourcesPrompt: boolean;
    isPlaybackEntryViewPromptOpen: boolean;
    isPonderOnboardingOpen: boolean;
};

/** Chooses the next blocking surface while ensuring that two startup dialogs never overlap. */
export const resolveStartupExperienceStep = ({
    hasSeenGoliaWelcome,
    isGoliaWelcomeOpen,
    isCurrentRelease,
    hasSeenPonder,
    hasFinishedThisRelease,
    hasSeenReleaseNotes,
    isReleaseNotesOpen,
    hasChosenPlaybackEntryView,
    needsLibrarySuitePrompt,
    needsSourcesPrompt,
    isPlaybackEntryViewPromptOpen,
    isPonderOnboardingOpen,
}: StartupExperienceState): StartupExperienceStep => {
    if (isGoliaWelcomeOpen || isReleaseNotesOpen || isPlaybackEntryViewPromptOpen || isPonderOnboardingOpen) {
        return null;
    }
    // The Golia first-launch dialog comes first and only once per install: a fresh
    // install sees it before the release sequence, and it never opens again.
    if (!hasSeenGoliaWelcome) {
        return 'golia-welcome';
    }
    // The release sequence (notes, the playback choice, the Ponder gate) only runs on the release that auto-opens
    // it, and not again once finished. Release notes are per version; the playback choice and the Ponder gate are
    // once per install, so having finished Ponder must not suppress a later release's notes.
    const releaseDue = isCurrentRelease && !hasFinishedThisRelease;
    if (releaseDue && !hasSeenReleaseNotes) {
        return 'release-notes';
    }
    // The library-interface page is owed once to every install, the sources page once to a fresh profile, both
    // outside the release gate.
    if ((releaseDue && !hasChosenPlaybackEntryView) || needsLibrarySuitePrompt || needsSourcesPrompt) {
        return 'playback-entry-view';
    }
    return releaseDue && !hasSeenPonder ? 'ponder' : null;
};

const readLastSeenReleaseNotesVersion = (): string | null => (
    typeof window === 'undefined'
        ? null
        : localStorage.getItem(LAST_SEEN_RELEASE_NOTES_VERSION_STORAGE_KEY)
);

const readHasSeenGoliaWelcome = (): boolean => getStoredBoolean(GOLIA_WELCOME_SHOWN_STORAGE_KEY, false);

/**
 * Runs the first-launch sequence: the Golia welcome dialog (once per install), then release
 * notes, the choice prompt (the sources a fresh profile uses, library interface, then playback
 * destination), then the Ponder shortcut gate. The prompt is gated by the playback choice alone,
 * so installs that answered the older single-page prompt are not asked again.
 */
export const useStartupExperienceGate = () => {
    const lastSeenPonderVersion = useSettingsModalStore(state => state.lastSeenGuideVersion);
    const isPonderOnboardingOpen = useSettingsModalStore(state => state.isUserGuideModalOpen);
    const setIsPonderOnboardingOpen = useSettingsModalStore(state => state.setIsUserGuideModalOpen);
    const hasChosenPlaybackEntryView = usePlaybackEntryViewStore(state => state.hasChosenPlaybackEntryView);
    const hasSeenLibrarySuitePrompt = usePlaybackEntryViewStore(state => state.hasSeenLibrarySuitePrompt);
    const needsLibrarySuitePrompt = hasOnboardingLibrarySuiteChoice() && !hasSeenLibrarySuitePrompt;
    const isPlaybackEntryViewPromptOpen = usePlaybackEntryViewStore(state => state.isPlaybackEntryViewPromptOpen);
    const [hasSeenGoliaWelcome, setHasSeenGoliaWelcome] = useState(readHasSeenGoliaWelcome);
    const [isGoliaWelcomeOpen, setIsGoliaWelcomeOpen] = useState(false);
    const sourcesOnboardingStatus = useSourcesOnboardingStore(state => state.status);
    const needsSourcesPrompt = sourcesOnboardingStatus === 'owed';
    const [lastSeenReleaseNotesVersion, setLastSeenReleaseNotesVersion] = useState(readLastSeenReleaseNotesVersion);
    const [isReleaseNotesOpen, setIsReleaseNotesOpen] = useState(false);
    const appVersion = typeof __APP_VERSION__ === 'undefined' ? null : __APP_VERSION__;

    // Dev shortcut (devLaunchFlags.ts): nothing opens and nothing is marked seen, so turning it off brings the sequence back.
    const nextStep = skipsStartupExperience ? null : resolveStartupExperienceStep({
        hasSeenGoliaWelcome,
        isGoliaWelcomeOpen,
        isCurrentRelease: Boolean(appVersion && USER_GUIDE_AUTO_OPEN_VERSION === appVersion),
        hasSeenPonder: lastSeenPonderVersion !== null,
        hasFinishedThisRelease: Boolean(appVersion && lastSeenPonderVersion === appVersion),
        hasSeenReleaseNotes: Boolean(appVersion && lastSeenReleaseNotesVersion === appVersion),
        isReleaseNotesOpen,
        hasChosenPlaybackEntryView,
        needsLibrarySuitePrompt,
        needsSourcesPrompt,
        isPlaybackEntryViewPromptOpen,
        isPonderOnboardingOpen,
    });

    // Whether a fresh profile owes the sources page, asked of the main process once (the web build: never). Not
    // asked under the dev shortcut: nothing opens and nothing is recorded, so a fresh profile runs no source until
    // one is switched in "Settings → Sources" (which counts as the answer).
    useEffect(() => {
        if (!skipsStartupExperience) void loadSourcesOnboarding();
    }, []);

    useEffect(() => {
        if (nextStep === 'golia-welcome') {
            setIsGoliaWelcomeOpen(true);
        } else if (nextStep === 'release-notes') {
            setIsReleaseNotesOpen(true);
        } else if (nextStep === 'playback-entry-view') {
            // The prompt's pages are fixed when it opens: it waits for the main process's word on the sources page.
            if (sourcesOnboardingStatus === 'unknown') return;
            requestPlaybackEntryViewPrompt({
                withSources: sourcesOnboardingStatus === 'owed',
                withLibrarySuite: hasOnboardingLibrarySuiteChoice(),
            });
        } else if (nextStep === 'ponder') {
            setIsPonderOnboardingOpen(true);
        }
    }, [nextStep, sourcesOnboardingStatus, setIsPonderOnboardingOpen]);

    const closeGoliaWelcome = useCallback(() => {
        setStoredBoolean(GOLIA_WELCOME_SHOWN_STORAGE_KEY, true);
        setHasSeenGoliaWelcome(true);
        setIsGoliaWelcomeOpen(false);
    }, []);

    const closeReleaseNotes = useCallback(() => {
        if (appVersion) {
            localStorage.setItem(LAST_SEEN_RELEASE_NOTES_VERSION_STORAGE_KEY, appVersion);
            setLastSeenReleaseNotesVersion(appVersion);
        }
        setIsReleaseNotesOpen(false);
    }, [appVersion]);

    return { isGoliaWelcomeOpen, closeGoliaWelcome, isReleaseNotesOpen, closeReleaseNotes };
};
