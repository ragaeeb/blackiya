import { describe, expect, it } from 'bun:test';
import type { LLMPlatform } from '@/platforms/types';
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
    getButtonInjectionTarget: () => null,
    buildApiUrls: (conversationId) => [
        `https://chatgpt.com/backend-api/conversation/${conversationId}?candidate=1`,
        `https://chatgpt.com/backend-api/conversation/${conversationId}?candidate=2`,
    ],
});

describe('runBulkExport', () => {
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
        expect(downloads[0]?.filename).toBe('Export title');
        expect((downloads[0]?.payload as Record<string, unknown>).__blackiya).toEqual({
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
                getAuthHeaders: () => undefined,
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
});
