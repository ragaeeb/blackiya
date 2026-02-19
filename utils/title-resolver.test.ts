import { describe, expect, it } from 'bun:test';
import {
    deriveConversationTitleFromFirstUserMessage,
    isGenericConversationTitle,
    resolveConversationTitleByPrecedence,
    resolveExportConversationTitleDecision,
} from '@/utils/title-resolver';
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
                    content: { content_type: 'text', parts: ['Prompt line one'] },
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

describe('title-resolver', () => {
    it('classifies shared generic titles consistently', () => {
        expect(isGenericConversationTitle('Conversation with Gemini')).toBeTrue();
        expect(isGenericConversationTitle('You said: hello')).toBeTrue();
        expect(isGenericConversationTitle('Chats')).toBeTrue();
        expect(isGenericConversationTitle('New chat')).toBeTrue();
        expect(isGenericConversationTitle('Grok / X')).toBeTrue();
        expect(isGenericConversationTitle('Specific conversation title')).toBeFalse();
    });

    it('honors platform default titles in generic classification', () => {
        expect(
            isGenericConversationTitle('Untitled conversation', {
                platformDefaultTitles: ['Untitled conversation'],
            }),
        ).toBeTrue();
    });

    it('derives first-user-message fallback title', () => {
        const conversation = buildConversation('Conversation with Gemini');
        expect(deriveConversationTitleFromFirstUserMessage(conversation)).toBe('Prompt line one');
    });

    it('resolves title precedence stream > cache > dom > first-user > fallback', () => {
        const resolvedFromStream = resolveConversationTitleByPrecedence({
            streamTitle: 'Stream title',
            cachedTitle: 'Cached title',
            domTitle: 'DOM title',
            firstUserMessageTitle: 'Prompt title',
            fallbackTitle: 'Conversation',
        });
        expect(resolvedFromStream).toEqual({ title: 'Stream title', source: 'stream' });

        const resolvedFromCache = resolveConversationTitleByPrecedence({
            streamTitle: 'Conversation with Gemini',
            cachedTitle: 'Cached specific title',
            domTitle: 'DOM title',
            firstUserMessageTitle: 'Prompt title',
            fallbackTitle: 'Conversation',
        });
        expect(resolvedFromCache).toEqual({ title: 'Cached specific title', source: 'cache' });

        const resolvedFromDom = resolveConversationTitleByPrecedence({
            streamTitle: 'Conversation with Gemini',
            cachedTitle: 'You said: hi',
            domTitle: 'DOM specific title',
            firstUserMessageTitle: 'Prompt title',
            fallbackTitle: 'Conversation',
        });
        expect(resolvedFromDom).toEqual({ title: 'DOM specific title', source: 'dom' });

        const resolvedFromPrompt = resolveConversationTitleByPrecedence({
            streamTitle: 'Conversation with Gemini',
            cachedTitle: 'You said: hi',
            domTitle: 'Conversation with Gemini',
            firstUserMessageTitle: 'Prompt title',
            fallbackTitle: 'Conversation',
        });
        expect(resolvedFromPrompt).toEqual({ title: 'Prompt title', source: 'first-user-message' });
    });

    it('uses export title decision with fallback behavior', () => {
        const genericConversation = buildConversation('Conversation with Gemini');
        const genericDecision = resolveExportConversationTitleDecision(genericConversation);
        expect(genericDecision).toEqual({ title: 'Prompt line one', source: 'first-user-message' });

        const specificConversation = buildConversation('Specific title');
        const specificDecision = resolveExportConversationTitleDecision(specificConversation);
        expect(specificDecision).toEqual({ title: 'Specific title', source: 'existing' });
    });

    it('normalizes export title decision for existing and fallback branches', () => {
        const specificConversation = buildConversation('   Specific    title   ');
        const specificDecision = resolveExportConversationTitleDecision(specificConversation);
        expect(specificDecision).toEqual({ title: 'Specific title', source: 'existing' });

        const fallbackConversation: ConversationData = {
            ...buildConversation('   New    chat   '),
            mapping: {},
        };
        const fallbackDecision = resolveExportConversationTitleDecision(fallbackConversation);
        expect(fallbackDecision).toEqual({ title: 'New chat', source: 'fallback' });
    });

    it('resolveConversationTitleByPrecedence falls back to fallbackTitle when all other sources are generic/absent', () => {
        const resolved = resolveConversationTitleByPrecedence({
            streamTitle: 'Conversation with Gemini',
            cachedTitle: 'You said: hi',
            domTitle: 'Conversation with Gemini',
            firstUserMessageTitle: null,
            fallbackTitle: 'My fallback',
        });
        expect(resolved).toEqual({ title: 'My fallback', source: 'fallback' });
    });

    it('resolveExportConversationTitleDecision falls back when title is generic and no user messages exist', () => {
        const emptyConversation: ConversationData = {
            ...buildConversation('New chat'),
            mapping: {},
        };
        const decision = resolveExportConversationTitleDecision(emptyConversation);
        expect(decision).toEqual({ title: 'New chat', source: 'fallback' });
    });
});
