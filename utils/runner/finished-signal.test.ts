import { describe, expect, it } from 'bun:test';
import { resolveFinishedSignalDebounce, shouldPromoteGrokFromCanonicalCapture } from '@/utils/runner/finished-signal';

describe('finished-signal', () => {
    describe('resolveFinishedSignalDebounce', () => {
        it('should return 1500ms for dom source', () => {
            const result = resolveFinishedSignalDebounce('conv-1', 'dom', 'attempt-1', 'conv-1', 'attempt-1');
            expect(result.minIntervalMs).toBe(1500);
            expect(result.effectiveAttemptId).toBe('attempt-1');
        });

        it('should return 4500ms for network source if not same conversation', () => {
            const result = resolveFinishedSignalDebounce('conv-1', 'network', 'attempt-1', 'conv-2', 'attempt-old');
            expect(result.minIntervalMs).toBe(4500);
            expect(result.effectiveAttemptId).toBe('attempt-1');
        });

        it('should return 4500ms for network source if same conversation but same attempt', () => {
            const result = resolveFinishedSignalDebounce('conv-1', 'network', 'attempt-1', 'conv-1', 'attempt-1');
            expect(result.minIntervalMs).toBe(4500);
        });

        it('should return 900ms for network source if same conversation but new attempt', () => {
            const result = resolveFinishedSignalDebounce('conv-1', 'network', 'attempt-2', 'conv-1', 'attempt-1');
            expect(result.minIntervalMs).toBe(900);
            expect(result.effectiveAttemptId).toBe('attempt-2');
        });

        it('should handle missing attemptId by replacing with empty string', () => {
            const result = resolveFinishedSignalDebounce('conv-1', 'network', null, 'conv-2', null);
            expect(result.effectiveAttemptId).toBe('');
            expect(result.minIntervalMs).toBe(4500);
        });
    });

    describe('shouldPromoteGrokFromCanonicalCapture', () => {
        it('should return true for network Grok with cached ready and active lifecycle', () => {
            expect(shouldPromoteGrokFromCanonicalCapture('network', true, 'idle', 'Grok')).toBeTrue();
            expect(shouldPromoteGrokFromCanonicalCapture('network', true, 'prompt-sent', 'Grok')).toBeTrue();
            expect(shouldPromoteGrokFromCanonicalCapture('network', true, 'streaming', 'Grok')).toBeTrue();
        });

        it('should return false if source is not network', () => {
            expect(shouldPromoteGrokFromCanonicalCapture('dom', true, 'idle', 'Grok')).toBeFalse();
        });

        it('should return false if adapter is not Grok', () => {
            expect(shouldPromoteGrokFromCanonicalCapture('network', true, 'idle', 'ChatGPT')).toBeFalse();
        });

        it('should return false if not cached ready', () => {
            expect(shouldPromoteGrokFromCanonicalCapture('network', false, 'idle', 'Grok')).toBeFalse();
        });

        it('should return false if lifecycle is already completed or error', () => {
            expect(shouldPromoteGrokFromCanonicalCapture('network', true, 'completed', 'Grok')).toBeFalse();
            expect(shouldPromoteGrokFromCanonicalCapture('network', true, 'error' as any, 'Grok')).toBeFalse();
        });
    });
});
