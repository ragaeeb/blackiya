import { describe, expect, it, mock } from 'bun:test';
import {
    cachePromptHintFromGrokCreateConversationRequest,
    emitFetchPromptLifecycle,
    extractGrokPromptHintFromFetchArgs,
    resolveGrokPromptHintFromFetchArgs,
} from '@/entrypoints/interceptor/bootstrap-lifecycle';

describe('bootstrap lifecycle prompt hints', () => {
    it('should extract Grok prompt hint from CreateGrokConversation fetch body', () => {
        const args = [
            'https://x.com/i/api/graphql/vvC5uy7pWWHXS2aDi1FZeA/CreateGrokConversation',
            {
                method: 'POST',
                body: JSON.stringify({
                    variables: {
                        request: {
                            message: 'Translate these segments exactly.',
                        },
                    },
                }),
            },
        ] as unknown as Parameters<typeof fetch>;

        expect(extractGrokPromptHintFromFetchArgs(args)).toBe('Translate these segments exactly.');
    });

    it('should ignore GraphQL operation documents and prefer variables message text', () => {
        const args = [
            'https://x.com/i/api/graphql/vvC5uy7pWWHXS2aDi1FZeA/CreateGrokConversation',
            {
                method: 'POST',
                body: JSON.stringify({
                    query: 'mutation CreateGrokConversation { create_grok_conversation { id } }',
                    variables: {
                        request: {
                            message: 'Actual user prompt text',
                        },
                    },
                }),
            },
        ] as unknown as Parameters<typeof fetch>;

        expect(extractGrokPromptHintFromFetchArgs(args)).toBe('Actual user prompt text');
    });

    it('should cache prompt hint for Grok CreateGrokConversation requests', () => {
        const emitLifecycle = mock(() => {});
        const cachePromptHintForAttempt = mock(() => {});
        const log = mock(() => {});
        const shouldLogTransient = mock(() => false);

        const context = {
            args: [
                'https://x.com/i/api/graphql/vvC5uy7pWWHXS2aDi1FZeA/CreateGrokConversation',
                {
                    method: 'POST',
                    body: JSON.stringify({
                        variables: {
                            request: {
                                message: 'Explain istijmar in detail',
                            },
                        },
                    }),
                },
            ] as unknown as Parameters<typeof fetch>,
            outgoingUrl: 'https://x.com/i/api/graphql/vvC5uy7pWWHXS2aDi1FZeA/CreateGrokConversation',
            outgoingMethod: 'POST',
            outgoingPath: '/i/api/graphql/vvC5uy7pWWHXS2aDi1FZeA/CreateGrokConversation',
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

    it('should cache prompt hint even when CreateGrokConversation is unmatched by adapter', async () => {
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

        await cachePromptHintFromGrokCreateConversationRequest(context, {
            emitter: {
                cachePromptHintForAttempt,
            } as any,
            resolveAttemptIdForConversation,
        });

        expect(resolveAttemptIdForConversation).toHaveBeenCalledWith(undefined, 'Grok');
        expect(cachePromptHintForAttempt).toHaveBeenCalledWith('grok:attempt-unmatched', 'What is a hadith?');
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

        await cachePromptHintFromGrokCreateConversationRequest(
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

    it('should resolve prompt hint from Request body when init body is absent', async () => {
        const request = new Request('https://x.com/i/api/graphql/vvC5uy7pWWHXS2aDi1FZeA/CreateGrokConversation', {
            method: 'POST',
            body: JSON.stringify({
                query: 'mutation CreateGrokConversation { create_grok_conversation { id } }',
                variables: {
                    request: {
                        message: 'What is a hadith?',
                    },
                },
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
