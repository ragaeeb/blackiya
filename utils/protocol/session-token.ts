/**
 * Session Token for Cross-World Message Authentication
 *
 * Generates and validates per-session nonces to authenticate
 * postMessage traffic between MAIN and ISOLATED worlds.
 *
 * @module utils/protocol/session-token
 */

const SESSION_TOKEN_KEY = '__BLACKIYA_SESSION_TOKEN__';
export type TokenValidationFailureReason =
    | 'invalid-payload'
    | 'missing-message-token'
    | 'session-token-uninitialized'
    | 'token-mismatch';

export const generateSessionToken = (): string => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return `bk:${crypto.randomUUID()}`;
    }
    return `bk:${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const getSessionToken = (): string | undefined => {
    try {
        const token = (window as any)[SESSION_TOKEN_KEY];
        return typeof token === 'string' ? token : undefined;
    } catch {
        return undefined;
    }
};

export const setSessionToken = (token: string): void => {
    try {
        (window as any)[SESSION_TOKEN_KEY] = token;
    } catch {
        // Silently fail if window is unavailable (test environments)
    }
};

export const stampToken = <T extends object>(payload: T): T & { __blackiyaToken: string } => {
    const token = getSessionToken();
    return { ...payload, __blackiyaToken: token ?? '' };
};

export const isValidToken = (payload: unknown): boolean => {
    return resolveTokenValidationFailureReason(payload) === null;
};

export const resolveTokenValidationFailureReason = (payload: unknown): TokenValidationFailureReason | null => {
    if (!payload || typeof payload !== 'object') {
        return 'invalid-payload';
    }
    const candidate = payload as Record<string, unknown>;
    const messageToken = candidate.__blackiyaToken;
    if (typeof messageToken !== 'string' || messageToken.length === 0) {
        return 'missing-message-token';
    }
    const sessionToken = getSessionToken();
    if (!sessionToken) {
        return 'session-token-uninitialized';
    }
    return messageToken === sessionToken ? null : 'token-mismatch';
};
