// src/services/appUpdate/appUpdateShare.ts
// The in-app update's download-and-share path (lx18): the IPA is fetched inside the app
// (the accelerator address the lx13 race already resolved, so the bytes come through a
// CORS-enabled mirror) and handed to the iOS system share sheet, so the listener picks
// 全能签 there instead of being sent to Safari.
//
// Why the Web Share API and not the Capacitor Share/Filesystem plugins: the shell does
// not ship them. Its capacitor.config.json registers only Browser, SplashScreen and
// StatusBar, and the App binary contains no CAPSharePlugin / CAPFilesystemPlugin; the
// iOS Xcode project (folia-ipad) is not in this repo, so a native rebuild cannot be done
// here. `navigator.share` with a File is the same system UIActivityViewController, and
// it needs no native plugin.
//
// One platform rule this has to respect: `navigator.share` only runs inside a user
// gesture. A 65 MB download outlives the tap's transient activation, so the download
// and the share are two taps: the first tap downloads the file into memory, the second
// tap shares it synchronously from the same click handler. `shareIpaFile` therefore
// calls `navigator.share` with no await in front of it; anything that must wait has
// already happened by then.

/** What a share attempt ended as. */
export type AppUpdateShareOutcome = 'shared' | 'cancelled' | 'unavailable' | 'failed';

/** The IPA asset's file name, taken off its download address. */
export const fileNameFromDownloadUrl = (url: string): string => {
    try {
        const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
        return name.toLowerCase().endsWith('.ipa') && name.length > 0 ? name : 'Folia.ipa';
    } catch {
        return 'Folia.ipa';
    }
};

type NavigatorWithShare = {
    share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
    canShare?: (data: { files?: File[] }) => boolean;
};

const navigatorWithShare = (): NavigatorWithShare | null => (
    typeof navigator === 'undefined' ? null : (navigator as unknown as NavigatorWithShare)
);

/** Whether this webview exposes the Web Share API at all (iOS 13+ in WKWebView). */
export const isWebShareAvailable = (): boolean => {
    const nav = navigatorWithShare();
    return nav !== null && typeof nav.share === 'function';
};

/**
 * Whether this webview can share an IPA file: the share API exists and `canShare`
 * accepts a file. A tiny probe file keeps the check cheap; `canShare` is optional,
 * so its absence means "try it" rather than "cannot". Used before the download so a
 * device that cannot share files never pays for a 65 MB download it cannot use.
 */
export const canShareIpaFiles = (): boolean => {
    const nav = navigatorWithShare();
    if (nav === null || typeof nav.share !== 'function') {
        return false;
    }
    if (typeof nav.canShare !== 'function') {
        return true;
    }
    try {
        const probe = new File([new Blob(['probe'], { type: 'text/plain' })], 'probe.ipa', {
            type: 'application/octet-stream',
        });
        return nav.canShare({ files: [probe] });
    } catch {
        return false;
    }
};

/**
 * Fetches the IPA's bytes, reporting the fraction downloaded (a number 0–1, or null
 * when the server sends no Content-Length). A streaming reader keeps the progress
 * moving on a 65 MB file instead of one long silent wait. Rejects on a non-OK answer
 * or a network error; the caller falls back to the browser then.
 */
export const downloadIpaFile = async (url: string, options?: {
    fetchFn?: typeof fetch;
    /** Called with the fraction downloaded, or null while the total is unknown. */
    onProgress?: (fraction: number | null) => void;
}): Promise<Blob> => {
    const fetchFn = options?.fetchFn ?? fetch;
    const response = await fetchFn(url);
    if (!response.ok) {
        throw new Error(`update download answered ${response.status}`);
    }
    const total = Number(response.headers.get('Content-Length') ?? '') || 0;
    const reader = response.body?.getReader();
    if (!reader) {
        return response.blob();
    }
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value) {
            chunks.push(value);
            loaded += value.byteLength;
            options?.onProgress?.(total > 0 ? loaded / total : null);
        }
    }
    return new Blob(chunks as BlobPart[], { type: 'application/octet-stream' });
};

/**
 * Shares a downloaded IPA through the system share sheet. Call this synchronously
 * from the tap handler: `navigator.share` only runs inside the tap's user gesture,
 * and any await before it would let the activation expire. Returns what happened:
 * `shared` when the sheet was used, `cancelled` when the listener closed it (keep
 * the file so they can try again), `unavailable` when this webview cannot share
 * files, `failed` for anything else. Never throws.
 *
 * Implementation note: this function is deliberately not `async` — the share call
 * sits in the same synchronous execution as the tap, and only the promise it returns
 * is mapped to an outcome afterwards.
 */
export const shareIpaFile = (
    blob: Blob,
    fileName: string,
): Promise<AppUpdateShareOutcome> => {
    const nav = navigatorWithShare();
    if (nav === null || typeof nav.share !== 'function') {
        return Promise.resolve('unavailable');
    }
    const file = new File([blob], fileName, { type: 'application/octet-stream' });
    if (typeof nav.canShare === 'function') {
        try {
            if (!nav.canShare({ files: [file] })) {
                return Promise.resolve('unavailable');
            }
        } catch {
            return Promise.resolve('unavailable');
        }
    }
    return nav.share({ files: [file], title: fileName, text: fileName }).then(
        () => 'shared' as const,
        (error: unknown) => {
            if (error instanceof DOMException && error.name === 'AbortError') {
                return 'cancelled' as const;
            }
            return 'failed' as const;
        },
    );
};
