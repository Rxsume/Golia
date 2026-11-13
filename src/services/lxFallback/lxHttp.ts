// src/services/lxFallback/lxHttp.ts
// The HTTP transport behind `lx.request`: the Capacitor shell's native HTTP plugin first
// (it runs outside the webview, so the LX backends' missing CORS headers do not matter),
// plain `fetch` as the fallback. Resolves with the response for any HTTP status and only
// rejects on a network or timeout error; the caller applies the LX rule that a status
// of 400 or above is an error. Response shape matches Golia's LX bridge.

import { lxBufferBytes } from './lxBytes';

export interface LxHttpResponse {
    statusCode: number;
    headers: Record<string, string>;
    /** Parsed JSON when the body parses and the caller did not ask for text, else the text. */
    body: unknown;
    bodyText: string;
    ok: boolean;
}

export interface LxRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    /** String, plain object (sent as JSON), LX buffer dictionary, or raw bytes. */
    body?: unknown;
    /** Milliseconds; defaults to 8000. */
    timeout?: number;
    responseType?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

/** The CapacitorHttp plugin as the native bridge exposes it (only the part used here). */
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

const normalizeHeaders = (headers: unknown): Record<string, string> => {
    if (typeof headers !== 'object' || headers === null) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value;
        else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
        // Other types are not valid header values; skip them.
    }
    return out;
};

/** Split a raw body into text plus the `body` value the LX contract expects. */
const parseBody = (rawText: string, responseType?: string): { body: unknown; bodyText: string } => {
    if (responseType?.toLowerCase() === 'text') return { body: rawText, bodyText: rawText };
    try {
        return { body: JSON.parse(rawText) as unknown, bodyText: rawText };
    } catch {
        return { body: rawText, bodyText: rawText };
    }
};

/** The request body as the native plugin and `fetch` both accept it, plus its content type. */
const encodeBody = (body: unknown, headers: Record<string, string | undefined>): { data: unknown; contentType: string | null } => {
    if (body === undefined || body === null) return { data: undefined, contentType: null };
    if (typeof body === 'string') return { data: body, contentType: null };
    if (body instanceof Uint8Array) return { data: body, contentType: null };
    if (typeof body === 'number' || typeof body === 'boolean') return { data: String(body), contentType: null };
    if (typeof body === 'object') {
        const bufferBytes = lxBufferBytes(body);
        if (bufferBytes !== null) return { data: bufferBytes, contentType: null };
        const contentType = headers['Content-Type'] ?? headers['content-type'] ?? 'application/json';
        return { data: JSON.stringify(body), contentType };
    }
    return { data: undefined, contentType: null };
};

const requestViaCapacitorHttp = async (url: string, options: LxRequestOptions): Promise<LxHttpResponse> => {
    const plugin = capacitorHttpPlugin();
    if (!plugin) throw new Error('CapacitorHttp is not available');
    const headers = normalizeHeaders(options.headers);
    const timeout = options.timeout && options.timeout > 0 ? options.timeout : DEFAULT_TIMEOUT_MS;
    const { data, contentType } = encodeBody(options.body, headers);
    if (contentType && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = contentType;
    const response = await plugin.request({
        url,
        method: (options.method ?? 'GET').toUpperCase(),
        headers,
        // The plugin takes the body as `data`; a Uint8Array is sent as binary.
        data,
        connectTimeout: timeout,
        readTimeout: timeout,
        responseType: options.responseType ?? 'text',
    });
    const responseHeaders = normalizeHeaders(response.headers);
    const statusCode = response.status;
    if (typeof response.data === 'string') {
        const parsed = parseBody(response.data, options.responseType);
        return { statusCode, headers: responseHeaders, ...parsed, ok: statusCode >= 200 && statusCode < 300 };
    }
    if (typeof response.data === 'object' && response.data !== null) {
        return {
            statusCode,
            headers: responseHeaders,
            body: response.data,
            bodyText: JSON.stringify(response.data),
            ok: statusCode >= 200 && statusCode < 300,
        };
    }
    const text = typeof response.data === 'number' || typeof response.data === 'boolean' ? String(response.data) : '';
    const parsed = parseBody(text, options.responseType);
    return { statusCode, headers: responseHeaders, ...parsed, ok: statusCode >= 200 && statusCode < 300 };
};

const requestViaFetch = async (url: string, options: LxRequestOptions): Promise<LxHttpResponse> => {
    const headers = normalizeHeaders(options.headers);
    const timeout = options.timeout && options.timeout > 0 ? options.timeout : DEFAULT_TIMEOUT_MS;
    const { data, contentType } = encodeBody(options.body, headers);
    if (contentType && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = contentType;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const init: RequestInit = {
            method: (options.method ?? 'GET').toUpperCase(),
            headers,
            signal: controller.signal,
        };
        if (data !== undefined) {
            init.body = data instanceof Uint8Array ? data as unknown as BodyInit : data as BodyInit;
        }
        const response = await fetch(url, init);
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
        });
        const text = await response.text();
        const parsed = parseBody(text, options.responseType);
        return { statusCode: response.status, headers: responseHeaders, ...parsed, ok: response.ok };
    } finally {
        clearTimeout(timer);
    }
};

/**
 * One HTTP request for an LX script. Prefers the native plugin (no CORS wall); a plugin
 * failure falls back to `fetch`, which still works for the backends that send CORS headers.
 */
export const lxHttpRequest = async (url: string, options: LxRequestOptions = {}): Promise<LxHttpResponse> => {
    if (capacitorHttpPlugin()) {
        try {
            return await requestViaCapacitorHttp(url, options);
        } catch (error) {
            console.warn('[lxFallback] capacitor-http failed, falling back to fetch', error);
        }
    }
    return requestViaFetch(url, options);
};

/** Whether the native HTTP plugin is present in this shell (decides the log line at startup). */
export const lxHasNativeHttp = (): boolean => capacitorHttpPlugin() !== null;
