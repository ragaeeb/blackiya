import { describe, expect, it } from 'bun:test';
import {
    getConversationAttemptMismatch,
    peekRunnerAttemptId,
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
        expect(result.attemptId.startsWith('grok:')).toBeTrue();
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
        expect(shouldRemoveDisposedAttemptBinding('alias:1', 'canonical:1', resolveAttemptId)).toBeTrue();
        expect(shouldRemoveDisposedAttemptBinding('alias:2', 'canonical:1', resolveAttemptId)).toBeFalse();
    });

    it('should return mapped conversation attempt from peekRunnerAttemptId', () => {
        const result = peekRunnerAttemptId({
            conversationId: 'conv-1',
            activeAttemptId: null,
            attemptByConversation: new Map([['conv-1', 'attempt-mapped']]),
            resolveAliasedAttemptId: (id) => id,
        });
        expect(result).toBe('attempt-mapped');
    });

    it('should resolve alias on peeked attempt', () => {
        const result = peekRunnerAttemptId({
            conversationId: 'conv-1',
            activeAttemptId: null,
            attemptByConversation: new Map([['conv-1', 'alias:x']]),
            resolveAliasedAttemptId: (id) => id.replace('alias:', 'canonical:'),
        });
        expect(result).toBe('canonical:x');
    });

    it('should fall back to active attempt from peekRunnerAttemptId when no conversation binding', () => {
        const result = peekRunnerAttemptId({
            conversationId: 'conv-2',
            activeAttemptId: 'attempt-active',
            attemptByConversation: new Map(),
            resolveAliasedAttemptId: (id) => id,
        });
        expect(result).toBe('attempt-active');
    });

    it('should return null from peekRunnerAttemptId when no mapping or active attempt exists', () => {
        const result = peekRunnerAttemptId({
            activeAttemptId: null,
            attemptByConversation: new Map(),
            resolveAliasedAttemptId: (id) => id,
        });
        expect(result).toBeNull();
    });

    it('should never create a new attempt from peekRunnerAttemptId (unlike resolveRunnerAttemptId)', () => {
        const input = {
            activeAttemptId: null,
            adapterName: 'Grok',
            attemptByConversation: new Map<string, string>(),
            resolveAliasedAttemptId: (id: string) => id,
        };
        // peek returns null — no creation
        expect(peekRunnerAttemptId(input)).toBeNull();
        // resolve creates a new attempt
        const resolved = resolveRunnerAttemptId(input);
        expect(resolved.attemptId.startsWith('grok:')).toBeTrue();
        expect(resolved.nextActiveAttemptId).toBe(resolved.attemptId);
    });
});
