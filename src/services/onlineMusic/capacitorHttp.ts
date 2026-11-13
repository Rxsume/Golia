// src/services/onlineMusic/capacitorHttp.ts
// One HTTP request that prefers the native bridge and falls back to fetch.
//
// The iOS shell runs this web build under a custom scheme, so a plain fetch to an outside host
// is stopped by CORS where that host sends no Access-Control-Allow-Origin header. The shell's
// native HTTP plugin runs outside the webview, so it is not stopped; fetch stays as the fallback
// for the desktop web build and for tests, where the same hosts either allow it or a same-origin
// relay answers instead. This file knows no host and no platform: callers pass the full URL.

export interface NativeHttpResponse {
    status: number;
    headers: Record<string, string>;
    bodyText: string;
    ok: boolean;
}

export interface NativeHttpRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    /** Sent as-is. Callers that send JSON stringify it themselves. */
    body?: string;
    /** Milliseconds; defaults to 15000. */
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;

/** The native HTTP plugin as the shell exposes it (only the part used here). */
interface CapacitorHttpPlugin {
    request: (options: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        data?: unknown;
        connectTimeout?: number;
        readTimeout?: number;
        responseType?: string;
    }) => Promise<{
        status: number;
        headers: Record<string, string>;
        data: unknown;
        url?: string;
    }>;
}

const capacitorHttpPlugin = (): CapacitorHttpPlugin | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as unknown as {
        Capacitor?: { Plugins?: { CapacitorHttp?: CapacitorHttpPlugin } };
    }).Capacitor;
    const plugin = capacitor?.Plugins?.CapacitorHttp;
    return plugin && typeof plugin.request === 'function' ? plugin : null;
};

/** Whether the native HTTP plugin is present in this shell. */
export const hasNativeHttp = (): boolean => capacitorHttpPlugin() !== null;

const normalizeHeaders = (headers: unknown): Record<string, string> => {
    if (typeof headers !== 'object' || headers === null) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value;
        else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
    }
    return out;
};

const requestViaNativeHttp = async (url: string, options: NativeHttpRequestOptions): Promise<NativeHttpResponse> => {
    const plugin = capacitorHttpPlugin();
    if (!plugin) throw new Error('Native HTTP is not available');
    const timeout = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const response = await plugin.request({
        url,
        method: (options.method ?? 'GET').toUpperCase(),
        headers: options.headers ?? {},
        data: options.body,
        connectTimeout: timeout,
        readTimeout: timeout,
        responseType: 'text',
    });
    const headers = normalizeHeaders(response.headers);
    const status = response.status;
    const bodyText = typeof response.data === 'string'
        ? response.data
        : typeof response.data === 'object' && response.data !== null
            ? JSON.stringify(response.data)
            : '';
    return { status, headers, bodyText, ok: status >= 200 && status < 300 };
};

const requestViaFetch = async (url: string, options: NativeHttpRequestOptions): Promise<NativeHttpResponse> => {
    const timeout = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            method: (options.method ?? 'GET').toUpperCase(),
            headers: options.headers ?? {},
            body: options.body,
            signal: controller.signal,
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            headers[key] = value;
        });
        return { status: response.status, headers, bodyText: await response.text(), ok: response.ok };
    } finally {
        clearTimeout(timer);
    }
};

/**
 * One HTTP request for an outside host. Prefers the native plugin (no CORS wall); a plugin
 * failure falls back to fetch, which still works for the hosts that send CORS headers.
 */
export const requestNativeHttp = async (url: string, options: NativeHttpRequestOptions = {}): Promise<NativeHttpResponse> => {
    if (capacitorHttpPlugin()) {
        try {
            return await requestViaNativeHttp(url, options);
        } catch (error) {
            console.warn('[NativeHttp] native request failed, falling back to fetch', error);
        }
    }
    return requestViaFetch(url, options);
};
