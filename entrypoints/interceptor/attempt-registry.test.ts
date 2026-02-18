import { describe, expect, it } from 'bun:test';
import {
    createInterceptorAttemptRegistry,
    type InterceptorAttemptRegistryState,
    toInterceptorAttemptPrefix,
} from '@/entrypoints/interceptor/attempt-registry';

const createRegistry = (state?: Partial<InterceptorAttemptRegistryState>) => {
    const fullState: InterceptorAttemptRegistryState = {
        attemptByConversationId: state?.attemptByConversationId ?? new Map<string, string>(),
        latestAttemptIdByPlatform: state?.latestAttemptIdByPlatform ?? new Map<string, string>(),
        disposedAttemptIds: state?.disposedAttemptIds ?? new Set<string>(),
    };
    return createInterceptorAttemptRegistry({
        state: fullState,
        maxAttemptBindings: 8,
        defaultPlatformName: 'ChatGPT',
    });
};

describe('interceptor attempt registry', () => {
    it('should normalize attempt id prefixes from platform names', () => {
        expect(toInterceptorAttemptPrefix('Grok 4.2 (Beta)')).toBe('grok-4-2-beta');
        expect(toInterceptorAttemptPrefix('ChatGPT')).toBe('chatgpt');
    });

    it('should resolve an existing conversation binding without creating a new attempt', () => {
        const attemptByConversationId = new Map<string, string>([['conv-1', 'attempt-existing']]);
        const registry = createRegistry({ attemptByConversationId });

        const resolved = registry.resolveAttemptIdForConversation('conv-1', 'Grok');

        expect(resolved).toBe('attempt-existing');
    });

    it('should reuse the latest platform attempt and bind it to the conversation', () => {
        const attemptByConversationId = new Map<string, string>();
        const latestAttemptIdByPlatform = new Map<string, string>([['Grok', 'attempt-latest']]);
        const registry = createRegistry({ attemptByConversationId, latestAttemptIdByPlatform });

        const resolved = registry.resolveAttemptIdForConversation('conv-2', 'Grok');

        expect(resolved).toBe('attempt-latest');
        expect(attemptByConversationId.get('conv-2')).toBe('attempt-latest');
    });

    it('should create a fresh attempt when latest platform attempt is disposed', () => {
        const latestAttemptIdByPlatform = new Map<string, string>([['Grok', 'attempt-disposed']]);
        const disposedAttemptIds = new Set<string>(['attempt-disposed']);
        const registry = createRegistry({ latestAttemptIdByPlatform, disposedAttemptIds });

        const resolved = registry.resolveAttemptIdForConversation('conv-3', 'Grok');

        expect(resolved).not.toBe('attempt-disposed');
        expect(resolved.startsWith('grok:')).toBeTrue();
        expect(latestAttemptIdByPlatform.get('Grok')).toBe(resolved);
    });

    it('should ignore disposed attempts when peeking active attempt ids', () => {
        const attemptByConversationId = new Map<string, string>([['conv-4', 'attempt-disposed']]);
        const latestAttemptIdByPlatform = new Map<string, string>([['Grok', 'attempt-latest']]);
        const disposedAttemptIds = new Set<string>(['attempt-disposed', 'attempt-latest']);
        const registry = createRegistry({ attemptByConversationId, latestAttemptIdByPlatform, disposedAttemptIds });

        const peeked = registry.peekAttemptIdForConversation('conv-4', 'Grok');

        expect(peeked).toBeUndefined();
    });

    it('should treat missing attempt or conversation as a no-op bind', () => {
        const attemptByConversationId = new Map<string, string>();
        const registry = createRegistry({ attemptByConversationId });

        registry.bindAttemptToConversation(null, 'conv-5');
        registry.bindAttemptToConversation('attempt-1', undefined);

        expect(attemptByConversationId.size).toBe(0);
    });
});
