import { describe, expect, it } from 'bun:test';
import type { LLMPlatform } from '@/platforms/types';
import type { ConversationData } from '@/utils/types';
import { attachCanonicalExportMeta, prepareCanonicalDownload } from './downloads';

const buildConversation = (title: string): ConversationData => ({
    title,
    create_time: 1,
    update_time: 2,
    conversation_id: '69a85cf1-4bcc-832b-b221-d582b0c9910a',
    current_node: 'assistant',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gpt-5',
    safe_urls: [],
    blocked_urls: [],
    mapping: {
        user: {
            id: 'user',
            parent: null,
            children: ['assistant'],
            message: {
                id: 'user',
                author: { role: 'user', name: 'user', metadata: {} },
                create_time: 1,
                update_time: 1,
                content: { content_type: 'text', parts: ['derived title'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        },
        assistant: {
            id: 'assistant',
            parent: 'user',
            children: [],
            message: null,
        },
    },
});

const adapter: LLMPlatform = {
    name: 'ChatGPT',
    urlMatchPattern: 'https://chatgpt.com/*',
    isPlatformUrl: () => true,
    extractConversationId: () => null,
    parseInterceptedData: () => null,
    formatFilename: (conversation) => conversation.title,
};

describe('bulk export downloads', () => {
    it('should attach complete canonical metadata without importing runner export helpers', () => {
        const payload = attachCanonicalExportMeta({ title: 'Conversation' });

        expect(payload).toEqual({
            title: 'Conversation',
            __blackiya: {
                exportMeta: {
                    captureSource: 'canonical_api',
                    fidelity: 'high',
                    completeness: 'complete',
                },
            },
        });
    });

    it('should resolve a generic title and make duplicate filenames unique', () => {
        const usedFilenames = new Set<string>();
        const first = prepareCanonicalDownload(buildConversation('New conversation'), adapter, usedFilenames);
        const second = prepareCanonicalDownload(buildConversation('New conversation'), adapter, usedFilenames);

        expect(first.filename).toBe('derived title');
        expect(second.filename).toBe('derived title_2');
        expect((first.payload as Record<string, unknown>).title).toBe('derived title');
        expect(((first.payload as Record<string, unknown>).__blackiya as Record<string, unknown>).exportMeta).toEqual({
            captureSource: 'canonical_api',
            fidelity: 'high',
            completeness: 'complete',
        });
    });
});
