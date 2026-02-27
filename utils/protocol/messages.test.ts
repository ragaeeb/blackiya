import { describe, expect, it } from 'bun:test';
import * as protocol from '@/utils/protocol/messages';

describe('protocol/messages', () => {
    it('validates typed lifecycle messages', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'a-1',
                phase: 'prompt-sent',
            }),
        ).toBeTrue();
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_STREAM_DUMP_CONFIG',
                enabled: true,
            }),
        ).toBeTrue();
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_STREAM_DUMP_FRAME',
                platform: 'ChatGPT',
                attemptId: 'a-1',
                kind: 'snapshot',
                text: 'hello',
                __blackiyaToken: 'bk:test',
            }),
        ).toBeTrue();
    });

    it('keeps tokenized wire messages type-compatible', () => {
        const lifecycle: protocol.ResponseLifecycleMessage = {
            type: 'BLACKIYA_RESPONSE_LIFECYCLE',
            platform: 'ChatGPT',
            attemptId: 'attempt-1',
            phase: 'streaming',
            __blackiyaToken: 'bk:test',
        };
        const capture: protocol.CaptureInterceptedMessage = {
            type: 'LLM_CAPTURE_DATA_INTERCEPTED',
            platform: 'ChatGPT',
            url: 'https://chatgpt.com/backend-api/conversation/1',
            data: '{}',
            __blackiyaToken: 'bk:test',
        };
        expect(lifecycle.__blackiyaToken).toBe('bk:test');
        expect(capture.__blackiyaToken).toBe('bk:test');
    });

    it('rejects lifecycle and completion messages without attempt IDs', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                phase: 'streaming',
            }),
        ).toBeFalse();
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                conversationId: 'conv-1',
            }),
        ).toBeFalse();
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                text: 'hello',
            }),
        ).toBeFalse();
    });

    it('rejects removed legacy public status messages', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_PUBLIC_STATUS',
                status: {},
            }),
        ).toBeFalse();
    });

    it('does not expose removed legacy helper exports', () => {
        expect('isLegacyLifecycleMessage' in protocol).toBeFalse();
        expect('isLegacyFinishedMessage' in protocol).toBeFalse();
        expect('isLegacyStreamDeltaMessage' in protocol).toBeFalse();
        expect('buildLegacyAttemptId' in protocol).toBeFalse();
    });

    it('creates attempt IDs', () => {
        const attemptId = protocol.createAttemptId('test');
        expect(attemptId.startsWith('test:')).toBeTrue();
    });

    it('rejects non-object and null values', () => {
        expect(protocol.isBlackiyaMessage(null)).toBeFalse();
        expect(protocol.isBlackiyaMessage(undefined)).toBeFalse();
        expect(protocol.isBlackiyaMessage(42)).toBeFalse();
        expect(protocol.isBlackiyaMessage('string')).toBeFalse();
        expect(protocol.isBlackiyaMessage([])).toBeFalse();
    });

    it('rejects messages with empty or missing type', () => {
        expect(protocol.isBlackiyaMessage({ type: '' })).toBeFalse();
        expect(protocol.isBlackiyaMessage({})).toBeFalse();
    });

    it('validates STREAM_DELTA accepts empty-string text', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                attemptId: 'a-1',
                text: '',
            }),
        ).toBeTrue();
    });

    it('rejects STREAM_DELTA when text field is absent', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                attemptId: 'a-1',
            }),
        ).toBeFalse();
    });

    it('validates CAPTURE_DATA_INTERCEPTED message', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/api',
                data: '{}',
            }),
        ).toBeTrue();
    });

    it('rejects CAPTURE_DATA_INTERCEPTED when required fields are missing', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://example.com',
                // data missing
            }),
        ).toBeFalse();
    });

    it('validates LOG_ENTRY message', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'LLM_LOG_ENTRY',
                payload: {
                    level: 'info',
                    message: 'test log',
                },
            }),
        ).toBeTrue();
    });

    it('rejects LOG_ENTRY when payload is missing or malformed', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'LLM_LOG_ENTRY',
                payload: { level: 'info' },
                // message missing
            }),
        ).toBeFalse();

        expect(
            protocol.isBlackiyaMessage({
                type: 'LLM_LOG_ENTRY',
                // payload missing entirely
            }),
        ).toBeFalse();
    });

    it('returns false for unrecognised message type strings', () => {
        expect(protocol.isBlackiyaMessage({ type: 'UNKNOWN_TYPE' })).toBeFalse();
    });

    it('validates CONVERSATION_ID_RESOLVED message', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_CONVERSATION_ID_RESOLVED',
                platform: 'ChatGPT',
                attemptId: 'a-1',
                conversationId: 'conv-1',
            }),
        ).toBeTrue();
    });

    it('validates ATTEMPT_DISPOSED message', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_ATTEMPT_DISPOSED',
                attemptId: 'a-1',
                reason: 'navigation',
            }),
        ).toBeTrue();
    });

    it('validates TITLE_RESOLVED message', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_TITLE_RESOLVED',
                platform: 'ChatGPT',
                attemptId: 'a-1',
                conversationId: 'conv-1',
                title: 'My Title',
            }),
        ).toBeTrue();
    });

    it('validates RESPONSE_FINISHED message', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                attemptId: 'a-1',
            }),
        ).toBeTrue();
    });

    it('validates SESSION_INIT message', () => {
        expect(
            protocol.isBlackiyaMessage({
                type: 'BLACKIYA_SESSION_INIT',
                token: 'bk:some-token',
            }),
        ).toBeTrue();
    });

    it('uses timestamp fallback when crypto.randomUUID is unavailable', () => {
        const originalCrypto = globalThis.crypto;
        // Remove randomUUID to trigger the fallback path
        Object.defineProperty(globalThis, 'crypto', {
            value: undefined,
            configurable: true,
            writable: true,
        });
        try {
            const id = protocol.createAttemptId('fallback');
            expect(id.startsWith('fallback:')).toBeTrue();
        } finally {
            Object.defineProperty(globalThis, 'crypto', {
                value: originalCrypto,
                configurable: true,
                writable: true,
            });
        }
    });
});
