// src/services/onlineMusic/qishui/direct/errors.ts
// The car-protocol error, on its own so the signing code can throw it without
// importing the client (which imports the signing code: that would be a cycle).

// The API result copies only code, message, upstreamCode and stage; fetch
// exceptions may embed credential-bearing URLs and never cross the boundary.
export class QishuiDirectError extends Error {
    /** The sign-in step that failed (access-code, ticket, account), where known. */
    public stage?: 'access-code' | 'ticket' | 'account';

    constructor(
        public readonly code: 'unsupported' | 'invalid-response' | 'auth-required' | 'unavailable' | 'network' | 'not-playable',
        message: string,
        public readonly upstreamCode?: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
    }
}
