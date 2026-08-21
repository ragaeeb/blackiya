import { describe, expect, it } from 'bun:test';

import type { MessageNode } from '@/utils/types';
import {
    deriveTitleFromFirstUserMessage,
    extractMappingModelSlug,
    normalizeConversationCandidate,
} from './conversation-normalizer';

const createMessageNode = (
    id: string,
    role: 'user' | 'assistant',
    text: string,
    createTime: number,
    metadata: Record<string, unknown> = {},
): MessageNode => ({
    id,
    parent: null,
    children: [],
    message: {
        id,
        author: { role, name: role === 'user' ? 'User' : 'Assistant', metadata: {} },
        content: { content_type: 'text', parts: [text] },
        create_time: createTime,
        update_time: createTime,
        status: 'finished_successfully',
        end_turn: true,
        weight: 1,
        metadata,
        recipient: 'all',
        channel: null,
    },
});

describe('chatgpt conversation normalizer helpers', () => {
    it('should preserve unknown top-level fields and every canonical mapping branch', () => {
        const raw = {
            conversation_id: '696bc3d5-fa84-8328-b209-4d65cb229e59',
            title: 'Canonical title',
            create_time: 100,
            update_time: 200,
            current_node: 'branch-a',
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['user'] },
                user: {
                    id: 'user',
                    message: null,
                    parent: 'root',
                    children: ['branch-a', 'branch-b'],
                    providerNodeField: { source: 'chatgpt' },
                },
                'branch-a': {
                    id: 'branch-a',
                    message: null,
                    parent: 'user',
                    children: [],
                },
                'branch-b': {
                    id: 'branch-b',
                    message: null,
                    parent: 'user',
                    children: [],
                },
            },
            providerTopLevelField: { retained: true },
        };

        const normalized = normalizeConversationCandidate(raw);

        expect(normalized).not.toBeNull();
        if (!normalized) {
            return;
        }
        expect((normalized as unknown as Record<string, unknown>).providerTopLevelField).toEqual({ retained: true });
        expect(normalized.mapping).toEqual(raw.mapping);
        expect((normalized.mapping.user as unknown as Record<string, unknown>).providerNodeField).toEqual({
            source: 'chatgpt',
        });
    });

    it('should prioritize resolved_model_slug globally over model_slug/model', () => {
        const mapping: Record<string, MessageNode> = {
            first: createMessageNode('first', 'assistant', 'a', 100, { model_slug: 'gpt-4o-mini' }),
            second: createMessageNode('second', 'assistant', 'b', 200, { resolved_model_slug: 'gpt-5-mini' }),
        };

        expect(extractMappingModelSlug(mapping)).toBe('gpt-5-mini');
    });

    it('should prioritize model_slug globally over model fallback', () => {
        const mapping: Record<string, MessageNode> = {
            first: createMessageNode('first', 'assistant', 'a', 100, { model: 'gpt-3.5' }),
            second: createMessageNode('second', 'assistant', 'b', 200, { model_slug: 'gpt-4o' }),
        };

        expect(extractMappingModelSlug(mapping)).toBe('gpt-4o');
    });

    it('should derive title from the earliest user message by timestamp', () => {
        const mapping: Record<string, MessageNode> = {
            later: createMessageNode('later', 'user', 'Later question', 200),
            earlier: createMessageNode('earlier', 'user', 'Earlier question', 100),
        };

        expect(deriveTitleFromFirstUserMessage(mapping)).toBe('Earlier question');
    });
});
