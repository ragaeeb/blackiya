import { describe, expect, it, mock } from 'bun:test';
import {
    cachePromptHintFromGrokRequest,
    emitFetchPromptLifecycle,
    extractGrokPromptHintFromFetchArgs,
    resolveGrokPromptHintFromFetchArgs,
} from '@/entrypoints/interceptor/bootstrap-lifecycle';

describe('bootstrap lifecycle prompt hints', () => {
    it('should extract Grok prompt hint from add_response fetch body', () => {
        const args = [
            'https://grok.x.com/2/grok/add_response.json',
            {
                method: 'POST',
                body: JSON.stringify({
                    responses: [{ message: 'Translate these segments exactly.', sender: 1 }],
                }),
            },
        ] as unknown as Parameters<typeof fetch>;

        expect(extractGrokPromptHintFromFetchArgs(args)).toBe('Translate these segments exactly.');
    });

    it('should prefer responses message text over promptMetadata', () => {
        const args = [
            'https://grok.x.com/2/grok/add_response.json',
            {
                method: 'POST',
                body: JSON.stringify({
                    responses: [{ message: 'Actual user prompt text', sender: 1 }],
                    promptMetadata: { promptSource: 'NATURAL', action: 'INPUT' },
                }),
            },
        ] as unknown as Parameters<typeof fetch>;

        expect(extractGrokPromptHintFromFetchArgs(args)).toBe('Actual user prompt text');
    });

    it('should cache prompt hint for Grok add_response requests', () => {
        const emitLifecycle = mock(() => {});
        const cachePromptHintForAttempt = mock(() => {});
        const log = mock(() => {});
        const shouldLogTransient = mock(() => false);

        const context = {
            args: [
                'https://grok.x.com/2/grok/add_response.json',
                {
                    method: 'POST',
                    body: JSON.stringify({
                        responses: [{ message: 'Explain istijmar in detail', sender: 1 }],
                    }),
                },
            ] as unknown as Parameters<typeof fetch>,
            outgoingUrl: 'https://grok.x.com/2/grok/add_response.json',
            outgoingMethod: 'POST',
            outgoingPath: '/2/grok/add_response.json',
            fetchApiAdapter: { name: 'Grok' },
            isNonChatGptApiRequest: true,
            shouldEmitNonChatLifecycle: true,
            nonChatConversationId: undefined,
            nonChatAttemptId: 'grok:attempt-1',
            isChatGptPromptRequest: false,
            lifecycleConversationId: undefined,
            lifecycleAttemptId: undefined,
        } as any;

        emitFetchPromptLifecycle(context, {
            emitter: {
                emitLifecycle,
                cachePromptHintForAttempt,
                shouldLogTransient,
                log,
            } as any,
            resolveAttemptIdForConversation: () => 'grok:attempt-fallback',
            bindAttemptToConversation: () => {},
            latestAttemptIdByPlatform: new Map<string, string>(),
            disposedAttemptIds: new Set<string>(),
            maxAttemptBindings: 10,
        });

        expect(cachePromptHintForAttempt).toHaveBeenCalledWith('grok:attempt-1', 'Explain istijmar in detail');
        expect(emitLifecycle).toHaveBeenCalledWith('grok:attempt-1', 'prompt-sent', undefined, 'Grok');
        expect(emitLifecycle).toHaveBeenCalledWith('grok:attempt-1', 'streaming', undefined, 'Grok');
    });

    it('should ignore CreateGrokConversation prompt-hint caching after x-grok removal', async () => {
        const cachePromptHintForAttempt = mock(() => {});
        const resolveAttemptIdForConversation = mock(() => 'grok:attempt-unmatched');

        const context = {
            args: [
                'https://x.com/i/api/graphql/vvC5uy7pWWHXS2aDi1FZeA/CreateGrokConversation',
                {
                    method: 'POST',
                    body: JSON.stringify({
                        variables: {
                            request: {
                                message: 'What is a hadith?',
                            },
                        },
                    }),
                },
            ] as unknown as Parameters<typeof fetch>,
            outgoingMethod: 'POST',
            outgoingUrl: 'https://x.com/i/api/graphql/vvC5uy7pWWHXS2aDi1FZeA/CreateGrokConversation',
            nonChatAttemptId: undefined,
        } as const;

        await cachePromptHintFromGrokRequest(context, {
            emitter: {
                cachePromptHintForAttempt,
            } as any,
            resolveAttemptIdForConversation,
        });

        expect(resolveAttemptIdForConversation).not.toHaveBeenCalled();
        expect(cachePromptHintForAttempt).not.toHaveBeenCalled();
    });

    it('should cache prompt hint for add_response request payloads', async () => {
        const cachePromptHintForAttempt = mock(() => {});
        const resolveAttemptIdForConversation = mock(() => 'grok:attempt-add-response');

        const request = new Request('https://grok.x.com/2/grok/add_response.json', {
            method: 'POST',
            body: JSON.stringify({
                responses: [{ message: 'What is a hadith\r', sender: 1, promptSource: '' }],
                conversationId: '2025634720810504324',
            }),
        });

        await cachePromptHintFromGrokRequest(
            {
                args: [request] as unknown as Parameters<typeof fetch>,
                outgoingMethod: 'POST',
                outgoingUrl: 'https://grok.x.com/2/grok/add_response.json',
                nonChatAttemptId: undefined,
            },
            {
                emitter: { cachePromptHintForAttempt } as any,
                resolveAttemptIdForConversation,
            },
        );

        expect(resolveAttemptIdForConversation).toHaveBeenCalledWith(undefined, 'Grok');
        expect(cachePromptHintForAttempt).toHaveBeenCalledWith('grok:attempt-add-response', 'What is a hadith');
    });

    it('should resolve prompt hint from add_response request body when init body is absent', async () => {
        const request = new Request('https://grok.x.com/2/grok/add_response.json', {
            method: 'POST',
            body: JSON.stringify({
                responses: [{ message: 'What is a hadith?', sender: 1 }],
            }),
        });

        const args = [request] as unknown as Parameters<typeof fetch>;
        await expect(resolveGrokPromptHintFromFetchArgs(args)).resolves.toBe('What is a hadith?');
    });

    it('should resolve prompt hint from add_response responses message over promptMetadata', async () => {
        const request = new Request('https://grok.x.com/2/grok/add_response.json', {
            method: 'POST',
            body: JSON.stringify({
                responses: [{ message: 'What is a hadith\r', sender: 1, promptSource: '' }],
                promptMetadata: { promptSource: 'NATURAL', action: 'INPUT' },
                requestFeatures: { eagerTweets: true },
            }),
        });

        const args = [request] as unknown as Parameters<typeof fetch>;
        await expect(resolveGrokPromptHintFromFetchArgs(args)).resolves.toBe('What is a hadith');
    });
});
