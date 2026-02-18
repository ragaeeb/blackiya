import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
    generateSessionToken,
    getSessionToken,
    isValidToken,
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
    });

    it('should reject missing token field', () => {
        setSessionToken('bk:valid-token');
        expect(isValidToken({ type: 'test' })).toBeFalse();
    });

    it('should reject empty token string', () => {
        setSessionToken('bk:valid-token');
        expect(isValidToken({ __blackiyaToken: '', type: 'test' })).toBeFalse();
    });

    it('should reject mismatched token', () => {
        setSessionToken('bk:valid-token');
        expect(isValidToken({ __blackiyaToken: 'bk:wrong-token', type: 'test' })).toBeFalse();
    });

    it('should reject when no session token is set', () => {
        expect(isValidToken({ __blackiyaToken: 'bk:some-token', type: 'test' })).toBeFalse();
    });

    it('should reject non-object payloads', () => {
        setSessionToken('bk:valid-token');
        expect(isValidToken(null)).toBeFalse();
        expect(isValidToken(undefined)).toBeFalse();
        expect(isValidToken('string')).toBeFalse();
        expect(isValidToken(42)).toBeFalse();
    });
});
