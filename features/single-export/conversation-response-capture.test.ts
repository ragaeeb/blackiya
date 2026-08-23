import { describe, expect, it, mock } from 'bun:test';
import type { LLMPlatform } from '@/platforms/types';
import type { ConversationData } from '@/utils/types';
import { ConversationResponseCache } from './conversation-response-cache';
import { captureTerminalConversationResponse } from './conversation-response-capture';

const makeConversation = (id: string): ConversationData => ({
    title: 'Captured conversation',
    create_time: 1,
    update_time: 2,
    mapping: {},
    conversation_id: id,
    current_node: 'root',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'test',
    safe_urls: [],
    blocked_urls: [],
});

const makeAdapter = (data: ConversationData, ready = true): LLMPlatform => ({
    name: 'Synthetic',
    urlMatchPattern: 'https://chat.example/*',
    isPlatformUrl: (url) => url.startsWith('https://chat.example/'),
    extractConversationId: () => data.conversation_id,
    parseInterceptedData: () => data,
    formatFilename: () => 'synthetic',
    evaluateReadiness: () => ({
        ready,
        terminal: ready,
        reason: ready ? 'terminal' : 'in-progress',
        contentHash: null,
        latestAssistantTextLength: 0,
    }),
});

describe('captureTerminalConversationResponse', () => {
    it('should cache a terminal parsed response without consuming the page-owned response', async () => {
        const data = makeConversation('conversation-1');
        const adapter = makeAdapter(data);
        const cache = new ConversationResponseCache();
        const response = new Response(JSON.stringify({ provider: 'payload' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });

        const captured = await captureTerminalConversationResponse({
            response: response.clone(),
            url: 'https://chat.example/api/conversation/conversation-1',
            method: 'GET',
            pageUrl: 'https://chat.example/c/conversation-1',
            resolveAdapter: () => adapter,
            cache,
        });

        expect(captured).toBeTrue();
        expect(cache.get('Synthetic', 'conversation-1')).toEqual(data);
        expect(await response.text()).toBe(JSON.stringify({ provider: 'payload' }));
    });

    it('should not cache a non-terminal response', async () => {
        const data = makeConversation('conversation-1');
        const adapter = makeAdapter(data, false);
        const cache = new ConversationResponseCache();

        const captured = await captureTerminalConversationResponse({
            response: new Response('{}', { status: 200 }),
            url: 'https://chat.example/api/conversation/conversation-1',
            method: 'GET',
            pageUrl: 'https://chat.example/c/conversation-1',
            resolveAdapter: () => adapter,
            cache,
        });

        expect(captured).toBeFalse();
        expect(cache.get('Synthetic', 'conversation-1')).toBeUndefined();
    });

    it('should not read or parse responses outside the adapter detail allowlist', async () => {
        const data = makeConversation('conversation-1');
        const parseInterceptedData = mock(() => data);
        const adapter = {
            ...makeAdapter(data),
            isConversationDetailRequest: () => false,
            parseInterceptedData,
        };
        const response = new Response('large unrelated response');
        const text = mock(response.text.bind(response));
        response.text = text;

        const captured = await captureTerminalConversationResponse({
            response,
            url: 'https://chat.example/api/unrelated',
            method: 'GET',
            pageUrl: 'https://chat.example/c/conversation-1',
            resolveAdapter: () => adapter,
            cache: new ConversationResponseCache(),
        });

        expect(captured).toBeFalse();
        expect(text).not.toHaveBeenCalled();
        expect(parseInterceptedData).not.toHaveBeenCalled();
    });

    it('should pass request headers to a multiplexed detail classifier', async () => {
        const data = makeConversation('conversation-1');
        const classifier = mock(
            (_url: string, _method: string, headers?: HeadersInit) =>
                new Headers(headers).get('x-operation') === 'conversation-detail',
        );
        const adapter = { ...makeAdapter(data), isConversationDetailRequest: classifier };
        const cache = new ConversationResponseCache();

        const captured = await captureTerminalConversationResponse({
            response: new Response('{}'),
            url: 'https://chat.example/api',
            method: 'POST',
            requestHeaders: { 'x-operation': 'conversation-detail' },
            pageUrl: 'https://chat.example/c/conversation-1',
            resolveAdapter: () => adapter,
            cache,
        });

        expect(captured).toBeTrue();
        expect(classifier).toHaveBeenCalled();
    });
});
