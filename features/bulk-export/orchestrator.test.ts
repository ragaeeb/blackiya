import { describe, expect, it, mock } from 'bun:test';
import type { LLMPlatform, PlatformReadiness } from '@/platforms/types';
import type { ConversationData } from '@/utils/types';
import { runBulkExport } from './orchestrator';

const buildConversation = (conversationId: string, title: string): ConversationData => ({
    title,
    create_time: 1,
    update_time: 2,
    conversation_id: conversationId,
    current_node: `${conversationId}-assistant`,
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gpt-5',
    safe_urls: [],
    blocked_urls: [],
    mapping: {
        [`${conversationId}-user`]: {
            id: `${conversationId}-user`,
            parent: null,
            children: [`${conversationId}-assistant`],
            message: {
                id: `${conversationId}-user`,
                author: { role: 'user', name: 'user', metadata: {} },
                create_time: 1,
                update_time: 1,
                content: { content_type: 'text', parts: ['prompt'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        },
        [`${conversationId}-assistant`]: {
            id: `${conversationId}-assistant`,
            parent: `${conversationId}-user`,
            children: [],
            message: {
                id: `${conversationId}-assistant`,
                author: { role: 'assistant', name: 'assistant', metadata: {} },
                create_time: 2,
                update_time: 2,
                content: { content_type: 'text', parts: ['response'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        },
    },
});

const buildAdapter = (): LLMPlatform => ({
    name: 'ChatGPT',
    urlMatchPattern: 'https://chatgpt.com/*',
    isPlatformUrl: () => true,
    extractConversationId: () => null,
    parseInterceptedData: (data) => {
        try {
            return JSON.parse(data) as ConversationData;
        } catch {
            return null;
        }
    },
    formatFilename: (conversation) => conversation.title,
    buildApiUrls: (conversationId) => [
        `https://chatgpt.com/backend-api/conversation/${conversationId}?candidate=1`,
        `https://chatgpt.com/backend-api/conversation/${conversationId}?candidate=2`,
    ],
});

const terminalReadiness: PlatformReadiness = {
    ready: true,
    terminal: true,
    reason: 'terminal',
    contentHash: null,
    latestAssistantTextLength: 8,
};

describe('runBulkExport', () => {
    it('should fail before the ChatGPT list request when authorization is absent', async () => {
        let requestCount = 0;

        await expect(
            runBulkExport(
                { limit: 1, delayMs: 0, timeoutMs: 5_000 },
                {
                    getAdapter: () => buildAdapter(),
                    getAuthHeaders: () => ({ 'x-client-context': 'present' }),
                    locationHref: () => 'https://chatgpt.com/c/current',
                    fetchImpl: (async () => {
                        requestCount += 1;
                        return new Response('', { status: 500 });
                    }) as unknown as typeof fetch,
                },
            ),
        ).rejects.toThrow('ChatGPT bulk export requires captured authorization.');

        expect(requestCount).toBe(0);
    });

    it('should fail before Gemini list or detail requests when the at context is absent', async () => {
        let requestCount = 0;
        const adapter = { name: 'Gemini', extractConversationId: () => null } as unknown as LLMPlatform;

        await expect(
            runBulkExport(
                { limit: 1, delayMs: 0, timeoutMs: 5_000 },
                {
                    getAdapter: () => adapter,
                    getAuthHeaders: () => ({ authorization: 'Bearer test' }),
                    getGeminiBatchexecuteContext: () => ({ updatedAt: 1 }),
                    locationHref: () => 'https://gemini.google.com/app/current',
                    fetchImpl: (async () => {
                        requestCount += 1;
                        return new Response('', { status: 500 });
                    }) as unknown as typeof fetch,
                },
            ),
        ).rejects.toThrow('Gemini bulk export requires captured batchexecute at context.');

        expect(requestCount).toBe(0);
    });

    it('should invalidate the provider context when a bulk request receives 401 or 403', async () => {
        for (const [platformName, status, adapter, locationHref, authHeaders, geminiContext] of [
            [
                'ChatGPT',
                401,
                buildAdapter(),
                'https://chatgpt.com/c/current',
                { authorization: 'Bearer stale' },
                undefined,
            ],
            [
                'Gemini',
                403,
                { name: 'Gemini', extractConversationId: () => null } as unknown as LLMPlatform,
                'https://gemini.google.com/app/current',
                undefined,
                { at: 'valid-at', updatedAt: 1 },
            ],
        ] as const) {
            const invalidateAuthContext = mock();

            await runBulkExport(
                { limit: 1, delayMs: 0, timeoutMs: 5_000 },
                {
                    getAdapter: () => adapter,
                    getAuthHeaders: () => authHeaders,
                    getGeminiBatchexecuteContext: () => geminiContext,
                    invalidateAuthContext,
                    locationHref: () => locationHref,
                    fetchImpl: (async () => new Response('', { status })) as unknown as typeof fetch,
                },
            );

            expect(invalidateAuthContext).toHaveBeenCalledWith(platformName);
        }
    });

    it('should list, fetch, annotate, download, and report canonical exports', async () => {
        const conversationId = '69a85cf1-4bcc-832b-b221-d582b0c9910a';
        const conversation = buildConversation(conversationId, 'Export title');
        const downloads: Array<{ payload: unknown; filename: string }> = [];
        const progress: unknown[] = [];

        const result = await runBulkExport(
            { limit: 0, delayMs: 300, timeoutMs: 5_000 },
            {
                getAdapter: () => buildAdapter(),
                getAuthHeaders: () => ({ authorization: 'Bearer test' }),
                locationHref: () => 'https://chatgpt.com/c/current',
                sleepImpl: async () => {},
                nowImpl: () => 100,
                onProgress: (message) => progress.push(message),
                downloadImpl: (payload, filename) => downloads.push({ payload, filename }),
                fetchImpl: (async (input: RequestInfo | URL) => {
                    const url = String(input);
                    if (url.includes('/backend-api/conversations?')) {
                        return new Response(JSON.stringify({ items: [{ id: conversationId }] }), { status: 200 });
                    }
                    return new Response(JSON.stringify(conversation), { status: 200 });
                }) as unknown as typeof fetch,
            },
        );

        expect(result).toMatchObject({
            platform: 'ChatGPT',
            discovered: 1,
            attempted: 1,
            exported: 1,
            failed: 0,
            limit: 0,
        });
        expect(downloads).toHaveLength(1);
        const [download] = downloads;
        if (!download) {
            throw new Error('expected one download');
        }
        expect(download.filename).toBe('Export title');
        expect((download.payload as Record<string, unknown>).__blackiya).toEqual({
            exportMeta: {
                captureSource: 'canonical_api',
                fidelity: 'high',
                completeness: 'complete',
            },
        });
        expect((progress[0] as { stage: string }).stage).toBe('started');
        expect((progress.at(-1) as { stage: string }).stage).toBe('completed');
    });

    it('should continue to the next detail candidate after a 404', async () => {
        const conversationId = '69a85cf1-4bcc-832b-b221-d582b0c9910a';
        const conversation = buildConversation(conversationId, 'Fallback title');
        const fetchedUrls: string[] = [];

        const result = await runBulkExport(
            { limit: 1, delayMs: 300, timeoutMs: 5_000 },
            {
                getAdapter: () => buildAdapter(),
                getAuthHeaders: () => ({ authorization: 'Bearer test' }),
                locationHref: () => 'https://chatgpt.com/c/current',
                sleepImpl: async () => {},
                downloadImpl: () => {},
                fetchImpl: (async (input: RequestInfo | URL) => {
                    const url = String(input);
                    fetchedUrls.push(url);
                    if (url.includes('/backend-api/conversations?')) {
                        return new Response(JSON.stringify({ items: [{ id: conversationId }] }), { status: 200 });
                    }
                    if (url.includes('?candidate=1')) {
                        return new Response('missing', { status: 404 });
                    }
                    return new Response(JSON.stringify(conversation), { status: 200 });
                }) as unknown as typeof fetch,
            },
        );

        expect(result.exported).toBe(1);
        expect(fetchedUrls.some((url) => url.includes('?candidate=1'))).toBeTrue();
        expect(fetchedUrls.some((url) => url.includes('?candidate=2'))).toBeTrue();
    });

    it('should count a failed download without counting it as exported', async () => {
        const firstId = '69a85cf1-4bcc-832b-b221-d582b0c9910a';
        const secondId = '69a85cf1-4bcc-832b-b221-d582b0c9910b';
        const progress: Array<{ stage: string; exported?: number; failed?: number }> = [];

        const result = await runBulkExport(
            { limit: 2, delayMs: 0, timeoutMs: 5_000 },
            {
                getAdapter: () => buildAdapter(),
                getAuthHeaders: () => ({ authorization: 'Bearer test' }),
                locationHref: () => 'https://chatgpt.com/c/current',
                downloadImpl: (_payload, filename) => filename !== firstId,
                onProgress: (message) => progress.push(message),
                fetchImpl: (async (input: RequestInfo | URL) => {
                    const url = String(input);
                    if (url.includes('/backend-api/conversations?')) {
                        return new Response(JSON.stringify({ items: [{ id: firstId }, { id: secondId }] }), {
                            status: 200,
                        });
                    }
                    const conversationId = url.includes(secondId) ? secondId : firstId;
                    return new Response(JSON.stringify(buildConversation(conversationId, conversationId)), { status: 200 });
                }) as unknown as typeof fetch,
            },
        );

        expect(result).toMatchObject({ discovered: 2, attempted: 2, exported: 1, failed: 1 });
        expect(progress.at(-1)).toMatchObject({ stage: 'completed', exported: 1, failed: 1 });
    });

    it('should count a conversation ID mismatch as a failure without downloading it', async () => {
        const requestedId = '69a85cf1-4bcc-832b-b221-d582b0c9910a';
        const returnedId = '69a85cf1-4bcc-832b-b221-d582b0c9910b';
        let downloadCount = 0;
        const adapter: LLMPlatform = {
            ...buildAdapter(),
            evaluateReadiness: () => terminalReadiness,
        };

        const result = await runBulkExport(
            { limit: 1, delayMs: 0, timeoutMs: 5_000 },
            {
                getAdapter: () => adapter,
                getAuthHeaders: () => ({ authorization: 'Bearer test' }),
                locationHref: () => 'https://chatgpt.com/c/current',
                downloadImpl: () => {
                    downloadCount += 1;
                },
                fetchImpl: (async (input: RequestInfo | URL) => {
                    const url = String(input);
                    if (url.includes('/backend-api/conversations?')) {
                        return new Response(JSON.stringify({ items: [{ id: requestedId }] }), { status: 200 });
                    }
                    return new Response(JSON.stringify(buildConversation(returnedId, 'Wrong conversation')), {
                        status: 200,
                    });
                }) as unknown as typeof fetch,
            },
        );

        expect(result).toMatchObject({ discovered: 1, attempted: 1, exported: 0, failed: 1 });
        expect(downloadCount).toBe(0);
    });

    it('should count a non-terminal adapter payload as a failure without downloading it', async () => {
        const conversationId = '69a85cf1-4bcc-832b-b221-d582b0c9910a';
        let downloadCount = 0;
        const adapter: LLMPlatform = {
            ...buildAdapter(),
            evaluateReadiness: () => ({
                ...terminalReadiness,
                ready: false,
                terminal: false,
                reason: 'assistant-in-progress',
            }),
        };

        const result = await runBulkExport(
            { limit: 1, delayMs: 0, timeoutMs: 5_000 },
            {
                getAdapter: () => adapter,
                getAuthHeaders: () => ({ authorization: 'Bearer test' }),
                locationHref: () => 'https://chatgpt.com/c/current',
                downloadImpl: () => {
                    downloadCount += 1;
                },
                fetchImpl: (async (input: RequestInfo | URL) => {
                    const url = String(input);
                    if (url.includes('/backend-api/conversations?')) {
                        return new Response(JSON.stringify({ items: [{ id: conversationId }] }), { status: 200 });
                    }
                    return new Response(JSON.stringify(buildConversation(conversationId, 'Still generating')), {
                        status: 200,
                    });
                }) as unknown as typeof fetch,
            },
        );

        expect(result).toMatchObject({ discovered: 1, attempted: 1, exported: 0, failed: 1 });
        expect(downloadCount).toBe(0);
    });

    it('should complete with partial counts when one detail payload is unavailable', async () => {
        const firstId = '69a85cf1-4bcc-832b-b221-d582b0c9910a';
        const secondId = '69a85cf1-4bcc-832b-b221-d582b0c9910b';

        const result = await runBulkExport(
            { limit: 2, delayMs: 0, timeoutMs: 5_000 },
            {
                getAdapter: () => buildAdapter(),
                getAuthHeaders: () => ({ authorization: 'Bearer test' }),
                locationHref: () => 'https://chatgpt.com/c/current',
                downloadImpl: () => true,
                fetchImpl: (async (input: RequestInfo | URL) => {
                    const url = String(input);
                    if (url.includes('/backend-api/conversations?')) {
                        return new Response(JSON.stringify({ items: [{ id: firstId }, { id: secondId }] }), {
                            status: 200,
                        });
                    }
                    if (url.includes(secondId)) {
                        return new Response('', { status: 404 });
                    }
                    return new Response(JSON.stringify(buildConversation(firstId, 'Partial success')), { status: 200 });
                }) as unknown as typeof fetch,
            },
        );

        expect(result).toMatchObject({ discovered: 2, attempted: 2, exported: 1, failed: 1 });
        expect(result.warnings).toEqual([]);
    });

    it('should emit failed progress and rethrow fatal detail errors with sanitized details', async () => {
        const conversationId = '69a85cf1-4bcc-832b-b221-d582b0c9910a';
        const progress: unknown[] = [];
        const parseInterceptedData = (data: string, sourceUrl?: string) => {
            if (sourceUrl?.includes('/backend-api/conversations?')) {
                return null;
            }
            if (data.includes('detail')) {
                throw new Error('detail failed at https://chatgpt.com/backend-api/conversation/secret?at=secret-token');
            }
            return null;
        };

        await expect(
            runBulkExport(
                { limit: 1, delayMs: 0, timeoutMs: 5_000 },
                {
                    getAdapter: () => ({ ...buildAdapter(), parseInterceptedData }),
                    getAuthHeaders: () => ({ authorization: 'Bearer test' }),
                    locationHref: () => 'https://chatgpt.com/c/current',
                    onProgress: (message) => progress.push(message),
                    fetchImpl: (async (input: RequestInfo | URL) => {
                        const url = String(input);
                        if (url.includes('/backend-api/conversations?')) {
                            return new Response(JSON.stringify({ items: [{ id: conversationId }] }), { status: 200 });
                        }
                        return new Response('detail', { status: 200 });
                    }) as unknown as typeof fetch,
                },
            ),
        ).rejects.toThrow('detail failed');

        const failed = progress.at(-1) as Record<string, unknown>;
        expect(failed).toMatchObject({
            stage: 'failed',
            discovered: 1,
            attempted: 1,
            exported: 0,
            failed: 1,
            remaining: 0,
        });
        expect(failed.message).toBe('detail failed at https://chatgpt.com/backend-api/conversation/secret');
    });

    it('should emit failed progress with partial counts when a downloader throws', async () => {
        const firstId = '69a85cf1-4bcc-832b-b221-d582b0c9910a';
        const secondId = '69a85cf1-4bcc-832b-b221-d582b0c9910b';
        const progress: unknown[] = [];
        let downloadCount = 0;

        await expect(
            runBulkExport(
                { limit: 2, delayMs: 0, timeoutMs: 5_000 },
                {
                    getAdapter: () => buildAdapter(),
                    getAuthHeaders: () => ({ authorization: 'Bearer test' }),
                    locationHref: () => 'https://chatgpt.com/c/current',
                    onProgress: (message) => progress.push(message),
                    downloadImpl: () => {
                        downloadCount += 1;
                        if (downloadCount === 2) {
                            throw new Error('download failed at https://chatgpt.com/download?token=secret');
                        }
                        return true;
                    },
                    fetchImpl: (async (input: RequestInfo | URL) => {
                        const url = String(input);
                        if (url.includes('/backend-api/conversations?')) {
                            return new Response(JSON.stringify({ items: [{ id: firstId }, { id: secondId }] }), {
                                status: 200,
                            });
                        }
                        const conversationId = url.includes(secondId) ? secondId : firstId;
                        return new Response(JSON.stringify(buildConversation(conversationId, conversationId)), { status: 200 });
                    }) as unknown as typeof fetch,
                },
            ),
        ).rejects.toThrow('download failed');

        expect(progress.at(-1)).toEqual({
            type: 'BLACKIYA_BULK_EXPORT_PROGRESS',
            stage: 'failed',
            platform: 'ChatGPT',
            discovered: 2,
            attempted: 2,
            exported: 1,
            failed: 1,
            remaining: 0,
            message: 'download failed at https://chatgpt.com/download',
        });
    });
});
