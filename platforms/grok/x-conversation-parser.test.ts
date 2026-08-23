import { describe, expect, it } from 'bun:test';
import { evaluateGrokReadiness } from './readiness';
import { parseXGrokConversationItems } from './x-conversation-parser';

const CONVERSATION_ID = '2091428436845772921';
const DETAIL_URL = `https://x.com/i/api/graphql/synthetic/GrokConversationItemsByRestId?variables=${encodeURIComponent(
    JSON.stringify({ restId: CONVERSATION_ID }),
)}`;

const makePayload = (isPartial = false) => ({
    data: {
        grok_conversation_by_rest_id: { is_pinned: false },
        grok_conversation_items_by_rest_id: {
            cursor: 'synthetic-cursor',
            items: [
                {
                    chat_item_id: '2091428438666096641',
                    created_at_ms: 1_787_470_371_309,
                    grok_mode: 'Normal',
                    is_partial: isPartial,
                    message: 'A terminal synthetic answer.',
                    sender_type: 'Agent',
                    thinking_trace: 'Synthetic reasoning trace.',
                    web_results: [{ title: 'Synthetic source', url: 'https://example.test', snippet: 'Example' }],
                },
                {
                    chat_item_id: '2091428438666096640',
                    created_at_ms: 1_787_470_370_000,
                    grok_mode: 'Normal',
                    message: 'A synthetic question?',
                    sender_type: 'User',
                },
            ],
        },
    },
});

describe('x.com Grok conversation parser', () => {
    it('should convert the HAR-derived GraphQL shape into a terminal conversation', () => {
        const payload = makePayload();
        const result = parseXGrokConversationItems(JSON.stringify(payload), DETAIL_URL);

        expect(result?.conversation_id).toBe(CONVERSATION_ID);
        expect(Object.keys(result?.mapping ?? {})).toHaveLength(3);
        expect(result?.mapping['2091428438666096640']?.message?.author.role).toBe('user');
        expect(result?.mapping['2091428438666096641']?.message?.author.role).toBe('assistant');
        expect(result?.mapping['2091428438666096641']?.parent).toBe('2091428438666096640');
        expect(result?.current_node).toBe('2091428438666096641');
        expect(result?.raw_payload as unknown).toEqual(payload);
        expect(result && evaluateGrokReadiness(result)).toMatchObject({
            ready: true,
            terminal: true,
            reason: 'terminal',
        });
    });

    it('should keep partial assistant items non-terminal', () => {
        const result = parseXGrokConversationItems(JSON.stringify(makePayload(true)), DETAIL_URL);
        expect(result && evaluateGrokReadiness(result)).toMatchObject({
            ready: false,
            terminal: false,
            reason: 'assistant-in-progress',
        });
    });

    it('should reject a malformed payload and a payload without matching items', () => {
        expect(parseXGrokConversationItems('{broken', DETAIL_URL)).toBeNull();
        expect(parseXGrokConversationItems(JSON.stringify({ data: {} }), DETAIL_URL)).toBeNull();
    });
});
