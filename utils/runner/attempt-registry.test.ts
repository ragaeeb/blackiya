import { describe, expect, it } from 'bun:test';
import {
    getConversationAttemptMismatch,
    resolveRunnerAttemptId,
    shouldRemoveDisposedAttemptBinding,
} from '@/utils/runner/attempt-registry';

describe('runner attempt registry helpers', () => {
    it('resolves mapped conversation attempt through alias mapping', () => {
        const result = resolveRunnerAttemptId({
            conversationId: 'conv-1',
            activeAttemptId: null,
            adapterName: 'Gemini',
            attemptByConversation: new Map([['conv-1', 'attempt-old']]),
            resolveAliasedAttemptId: (attemptId) => `${attemptId}:canonical`,
        });
        expect(result).toEqual({
            attemptId: 'attempt-old:canonical',
            nextActiveAttemptId: null,
        });
    });

    it('reuses active attempt when no conversation binding exists', () => {
        const result = resolveRunnerAttemptId({
            activeAttemptId: 'attempt-active',
            adapterName: 'ChatGPT',
            attemptByConversation: new Map(),
            resolveAliasedAttemptId: (attemptId) => `${attemptId}:canonical`,
        });
        expect(result).toEqual({
            attemptId: 'attempt-active:canonical',
            nextActiveAttemptId: 'attempt-active',
        });
    });

    it('creates a new attempt when no mapping or active attempt exists', () => {
        const result = resolveRunnerAttemptId({
            activeAttemptId: null,
            adapterName: 'Grok',
            attemptByConversation: new Map(),
            resolveAliasedAttemptId: (attemptId) => attemptId,
        });
        expect(result.attemptId.startsWith('grok:')).toBe(true);
        expect(result.nextActiveAttemptId).toBe(result.attemptId);
    });

    it('detects conversation mismatch when mapped attempt differs from canonical attempt', () => {
        const mismatch = getConversationAttemptMismatch(
            'attempt-a',
            'conv-1',
            new Map([['conv-1', 'attempt-b']]),
            (attemptId) => attemptId,
        );
        expect(mismatch).toBe('attempt-b');
        expect(
            getConversationAttemptMismatch(
                'attempt-a',
                'conv-1',
                new Map([['conv-1', 'attempt-a']]),
                (attemptId) => attemptId,
            ),
        ).toBeNull();
    });

    it('keeps existing disposed-binding behavior through shared helper', () => {
        const resolveAttemptId = (attemptId: string) => attemptId.replace('alias:', 'canonical:');
        expect(shouldRemoveDisposedAttemptBinding('alias:1', 'canonical:1', resolveAttemptId)).toBe(true);
        expect(shouldRemoveDisposedAttemptBinding('alias:2', 'canonical:1', resolveAttemptId)).toBe(false);
    });
});
