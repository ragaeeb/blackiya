import { describe, expect, it } from 'bun:test';
import {
    deriveConversationTitleFromFirstUserMessage,
    isGenericConversationTitle,
    normalizeConversationTitle,
    resolveConversationTitleByPrecedence,
    resolveExportConversationTitleDecision,
} from '@/utils/title-resolver';
import type { ConversationData } from '@/utils/types';

const buildConversation = (title: string): ConversationData => {
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
};

describe('title-resolver', () => {
    it('normalizeConversationTitle collapses whitespace and trims', () => {
        expect(normalizeConversationTitle('  Hello   World  ')).toBe('Hello World');
        expect(normalizeConversationTitle(null)).toBe('');
        expect(normalizeConversationTitle(undefined)).toBe('');
        expect(normalizeConversationTitle('')).toBe('');
    });

    it('isGenericConversationTitle returns true for null/undefined/empty titles', () => {
        expect(isGenericConversationTitle(null)).toBeTrue();
        expect(isGenericConversationTitle(undefined)).toBeTrue();
        expect(isGenericConversationTitle('')).toBeTrue();
        expect(isGenericConversationTitle('   ')).toBeTrue();
    });

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

    it('picks the earliest user message when multiple are present (sort by create_time)', () => {
        const base = buildConversation('New chat');
        // Add a second user message with an earlier timestamp
        base.mapping.u0 = {
            id: 'u0',
            parent: 'root',
            children: [],
            message: {
                id: 'u0',
                author: { role: 'user', name: null, metadata: {} },
                create_time: 1,
                update_time: 1,
                content: { content_type: 'text', parts: ['Earlier prompt'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        };
        // u1 already has create_time: 2 (from buildConversation)
        const result = deriveConversationTitleFromFirstUserMessage(base);
        expect(result).toBe('Earlier prompt');
    });

    it('falls back to update_time when create_time is null for sorting', () => {
        const base = buildConversation('New chat');
        // Override u1's create_time to null; update_time drives ordering
        base.mapping.u1.message!.create_time = null as any;
        base.mapping.u1.message!.update_time = 5;

        base.mapping.u0 = {
            id: 'u0',
            parent: 'root',
            children: [],
            message: {
                id: 'u0',
                author: { role: 'user', name: null, metadata: {} },
                create_time: null as any,
                update_time: 3,
                content: { content_type: 'text', parts: ['Earlier via update_time'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        };
        const result = deriveConversationTitleFromFirstUserMessage(base);
        expect(result).toBe('Earlier via update_time');
    });

    it('returns null from deriveConversationTitleFromFirstUserMessage when all user message parts are empty', () => {
        const base = buildConversation('New chat');
        base.mapping.u1.message!.content.parts = ['   ', ''];
        expect(deriveConversationTitleFromFirstUserMessage(base)).toBeNull();
    });

    it('truncates long first-user-message titles at maxLength', () => {
        const base = buildConversation('New chat');
        const longText = 'a'.repeat(200);
        base.mapping.u1.message!.content.parts = [longText];
        const result = deriveConversationTitleFromFirstUserMessage(base, 80);
        expect(result).not.toBeNull();
        expect(result!.length).toBeLessThanOrEqual(80);
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
