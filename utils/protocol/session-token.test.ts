import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
    generateSessionToken,
    getSessionToken,
    isValidToken,
    resolveTokenValidationFailureReason,
    setSessionToken,
    stampToken,
} from '@/utils/protocol/session-token';

describe('protocol/session-token', () => {
    beforeEach(() => {
        delete (globalThis as Record<string, unknown>).window;
        (globalThis as Record<string, unknown>).window = globalThis;
    });

    afterEach(() => {
        delete (window as any).__BLACKIYA_SESSION_TOKEN__;
    });

    it('should generate unique non-empty session tokens', () => {
        const a = generateSessionToken();
        const b = generateSessionToken();
        expect(a).toBeString();
        expect(a.length).toBeGreaterThan(0);
        expect(a.startsWith('bk:')).toBeTrue();
        expect(b.startsWith('bk:')).toBeTrue();
        expect(a).not.toBe(b);
    });

    it('should round-trip token via set/get', () => {
        expect(getSessionToken()).toBeUndefined();
        setSessionToken('bk:test-token-123');
        expect(getSessionToken()).toBe('bk:test-token-123');
    });

    it('should stamp payload with current session token', () => {
        setSessionToken('bk:stamp-test');
        const payload = {
            type: 'BLACKIYA_RESPONSE_LIFECYCLE' as const,
            platform: 'ChatGPT',
            attemptId: 'a-1',
            phase: 'streaming' as const,
        };
        const stamped = stampToken(payload);
        expect(stamped.__blackiyaToken).toBe('bk:stamp-test');
        expect(stamped.type).toBe('BLACKIYA_RESPONSE_LIFECYCLE');
        expect(stamped.platform).toBe('ChatGPT');
    });

    it('should stamp with empty string when no token is set', () => {
        const stamped = stampToken({ type: 'test' });
        expect(stamped.__blackiyaToken).toBe('');
    });

    it('should validate matching token', () => {
        setSessionToken('bk:valid-token');
        expect(isValidToken({ __blackiyaToken: 'bk:valid-token', type: 'test' })).toBeTrue();
        expect(resolveTokenValidationFailureReason({ __blackiyaToken: 'bk:valid-token', type: 'test' })).toBeNull();
    });

    it('should reject missing token field', () => {
        setSessionToken('bk:valid-token');
        expect(isValidToken({ type: 'test' })).toBeFalse();
        expect(resolveTokenValidationFailureReason({ type: 'test' })).toBe('missing-message-token');
    });

    it('should reject empty token string', () => {
        setSessionToken('bk:valid-token');
        expect(isValidToken({ __blackiyaToken: '', type: 'test' })).toBeFalse();
        expect(resolveTokenValidationFailureReason({ __blackiyaToken: '', type: 'test' })).toBe(
            'missing-message-token',
        );
    });

    it('should reject mismatched token', () => {
        setSessionToken('bk:valid-token');
        expect(isValidToken({ __blackiyaToken: 'bk:wrong-token', type: 'test' })).toBeFalse();
        expect(resolveTokenValidationFailureReason({ __blackiyaToken: 'bk:wrong-token', type: 'test' })).toBe(
            'token-mismatch',
        );
    });

    it('should reject when no session token is set', () => {
        expect(isValidToken({ __blackiyaToken: 'bk:some-token', type: 'test' })).toBeFalse();
        expect(resolveTokenValidationFailureReason({ __blackiyaToken: 'bk:some-token', type: 'test' })).toBe(
            'session-token-uninitialized',
        );
    });

    it('should reject non-object payloads', () => {
        setSessionToken('bk:valid-token');
        expect(isValidToken(null)).toBeFalse();
        expect(isValidToken(undefined)).toBeFalse();
        expect(isValidToken('string')).toBeFalse();
        expect(isValidToken(42)).toBeFalse();
        expect(resolveTokenValidationFailureReason(null)).toBe('invalid-payload');
    });

    it('should return undefined from getSessionToken when window access throws', () => {
        const originalWindow = globalThis.window;
        // Make window property access throw
        Object.defineProperty(globalThis, 'window', {
            get() {
                throw new Error('window not available');
            },
            configurable: true,
        });
        try {
            const result = getSessionToken();
            expect(result).toBeUndefined();
        } finally {
            Object.defineProperty(globalThis, 'window', {
                value: originalWindow,
                configurable: true,
                writable: true,
            });
        }
    });

    it('should generate a token using timestamp fallback when crypto.randomUUID is unavailable', () => {
        const originalCrypto = globalThis.crypto;
        Object.defineProperty(globalThis, 'crypto', {
            value: undefined,
            configurable: true,
            writable: true,
        });
        try {
            const token = generateSessionToken();
            expect(token.startsWith('bk:')).toBeTrue();
            expect(token.length).toBeGreaterThan(3);
        } finally {
            Object.defineProperty(globalThis, 'crypto', {
                value: originalCrypto,
                configurable: true,
                writable: true,
            });
        }
    });
});
