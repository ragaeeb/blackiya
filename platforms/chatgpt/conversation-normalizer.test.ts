import { describe, expect, it } from 'bun:test';

import type { MessageNode } from '@/utils/types';
import { deriveTitleFromFirstUserMessage, extractMappingModelSlug } from './conversation-normalizer';

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
