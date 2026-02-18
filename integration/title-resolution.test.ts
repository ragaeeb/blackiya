import { describe, expect, it } from 'bun:test';
import { Window as HappyDomWindow } from 'happy-dom';
import { InterceptionManager } from '@/utils/managers/interception-manager';
import { resolveConversationTitleByPrecedence } from '@/utils/title-resolver';
import type { ConversationData } from '@/utils/types';

function buildConversation(title: string): ConversationData {
    return {
        title,
        create_time: 1,
        update_time: 2,
        conversation_id: 'conv-1',
        current_node: 'a1',
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'gpt-4o',
        safe_urls: [],
        blocked_urls: [],
        mapping: {
            root: { id: 'root', message: null, parent: null, children: ['u1'] },
            u1: {
                id: 'u1',
                parent: 'root',
                children: ['a1'],
                message: {
                    id: 'u1',
                    author: { role: 'user', name: null, metadata: {} },
                    create_time: 2,
                    update_time: 2,
                    content: { content_type: 'text', parts: ['Prompt title'] },
                    status: 'finished_successfully',
                    end_turn: true,
                    weight: 1,
                    metadata: {},
                    recipient: 'all',
                    channel: null,
                },
            },
            a1: {
                id: 'a1',
                parent: 'u1',
                children: [],
                message: {
                    id: 'a1',
                    author: { role: 'assistant', name: null, metadata: {} },
                    create_time: 3,
                    update_time: 3,
                    content: { content_type: 'text', parts: ['Answer'] },
                    status: 'finished_successfully',
                    end_turn: true,
                    weight: 1,
                    metadata: {},
                    recipient: 'all',
                    channel: null,
                },
            },
        },
    };
}

describe('integration: title resolution precedence', () => {
    it('prefers stream title over cached generic title and DOM fallback', () => {
        const resolved = resolveConversationTitleByPrecedence({
            streamTitle: 'Specific stream title',
            cachedTitle: 'You said: prompt',
            domTitle: 'DOM fallback title',
            firstUserMessageTitle: 'Prompt title',
            fallbackTitle: 'Conversation',
        });
        expect(resolved).toEqual({ title: 'Specific stream title', source: 'stream' });
    });

    it('keeps previously captured specific title when later ingest carries generic title', () => {
        const testWindow = new HappyDomWindow();
        const manager = new InterceptionManager(() => {}, {
            window: testWindow as unknown as globalThis.Window,
            global: globalThis,
        });
        manager.updateAdapter({
            name: 'Gemini',
            urlMatchPattern: 'https://gemini.google.com/*',
            apiEndpointPattern: /batchexecute/,
            isPlatformUrl: () => true,
            extractConversationId: () => 'conv-1',
            parseInterceptedData: () => null,
            formatFilename: () => 'x',
            getButtonInjectionTarget: () => null,
            defaultTitles: ['Conversation with Gemini'],
        });

        manager.ingestConversationData(buildConversation('Specific retained title'), 'network');
        manager.ingestConversationData(buildConversation('Conversation with Gemini'), 'snapshot');

        expect(manager.getConversation('conv-1')?.title).toBe('Specific retained title');
    });
});
