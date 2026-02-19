import { setBoundedMapValue } from '@/utils/bounded-collections';
import { createAttemptId } from '@/utils/protocol/messages';

export type InterceptorAttemptRegistryState = {
    attemptByConversationId: Map<string, string>;
    latestAttemptIdByPlatform: Map<string, string>;
    disposedAttemptIds: Set<string>;
};

export type CreateInterceptorAttemptRegistryInput = {
    state: InterceptorAttemptRegistryState;
    maxAttemptBindings: number;
    defaultPlatformName: string;
};

export type InterceptorAttemptRegistry = {
    bindAttemptToConversation: (attemptId: string | null | undefined, conversationId: string | undefined) => void;
    resolveAttemptIdForConversation: (conversationId?: string, platformName?: string) => string;
    peekAttemptIdForConversation: (conversationId?: string, platformName?: string) => string | undefined;
    isAttemptDisposed: (attemptId: string | undefined) => boolean;
};

export function toInterceptorAttemptPrefix(platformName: string): string {
    return platformName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export function createInterceptorAttemptRegistry(
    input: CreateInterceptorAttemptRegistryInput,
): InterceptorAttemptRegistry {
    const { state, maxAttemptBindings, defaultPlatformName } = input;

    const bindAttemptToConversation = (
        attemptId: string | null | undefined,
        conversationId: string | undefined,
    ): void => {
        if (!attemptId || !conversationId) {
            return;
        }
        setBoundedMapValue(state.attemptByConversationId, conversationId, attemptId, maxAttemptBindings);
    };

    const resolvePlatformKey = (platformName?: string): string => platformName || defaultPlatformName;

    const resolveBoundAttempt = (conversationId?: string): string | undefined => {
        if (!conversationId) {
            return undefined;
        }
        const bound = state.attemptByConversationId.get(conversationId);
        if (bound && state.disposedAttemptIds.has(bound)) {
            state.attemptByConversationId.delete(conversationId);
            return undefined;
        }
        return bound;
    };

    const resolveReusableLatestAttempt = (platformKey: string, conversationId?: string): string | undefined => {
        const latestAttemptId = state.latestAttemptIdByPlatform.get(platformKey);
        if (!latestAttemptId) {
            return undefined;
        }
        if (state.disposedAttemptIds.has(latestAttemptId)) {
            state.latestAttemptIdByPlatform.delete(platformKey);
            return undefined;
        }
        if (conversationId) {
            bindAttemptToConversation(latestAttemptId, conversationId);
        }
        return latestAttemptId;
    };

    const createAndBindAttempt = (platformKey: string, conversationId?: string): string => {
        const created = createAttemptId(toInterceptorAttemptPrefix(platformKey));
        setBoundedMapValue(state.latestAttemptIdByPlatform, platformKey, created, maxAttemptBindings);
        if (conversationId) {
            bindAttemptToConversation(created, conversationId);
        }
        return created;
    };

    const resolveAttemptIdForConversation = (conversationId?: string, platformName = defaultPlatformName): string => {
        const platformKey = resolvePlatformKey(platformName);
        const bound = resolveBoundAttempt(conversationId);
        if (bound) {
            return bound;
        }
        const latestAttemptId = resolveReusableLatestAttempt(platformKey, conversationId);
        if (latestAttemptId) {
            return latestAttemptId;
        }
        return createAndBindAttempt(platformKey, conversationId);
    };

    const peekAttemptIdForConversation = (
        conversationId?: string,
        platformName = defaultPlatformName,
    ): string | undefined => {
        const platformKey = resolvePlatformKey(platformName);
        if (conversationId) {
            const bound = state.attemptByConversationId.get(conversationId);
            if (bound && !state.disposedAttemptIds.has(bound)) {
                return bound;
            }
        }
        const latestAttemptId = state.latestAttemptIdByPlatform.get(platformKey);
        if (latestAttemptId && !state.disposedAttemptIds.has(latestAttemptId)) {
            return latestAttemptId;
        }
        return undefined;
    };

    const isAttemptDisposed = (attemptId: string | undefined): boolean =>
        !!attemptId && state.disposedAttemptIds.has(attemptId);

    return {
        bindAttemptToConversation,
        resolveAttemptIdForConversation,
        peekAttemptIdForConversation,
        isAttemptDisposed,
    };
}
