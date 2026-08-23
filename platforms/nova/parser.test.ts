import { describe, expect, it } from 'bun:test';

import {
    createNovaConversationFixture,
    NOVA_CONVERSATION_ID,
    NOVA_OTHER_CONVERSATION_ID,
    terminalNovaConversation,
} from './fixtures/conversation';
import { novaAdapter } from './index';
import { parseNovaConversationPayload } from './parser';

describe('Amazon Nova conversation parser', () => {
    it('should parse the HAR-derived canonical interaction shape and preserve the full payload', () => {
        const result = parseNovaConversationPayload(terminalNovaConversation);

        expect(result).not.toBeNull();
        expect(result?.conversation_id).toBe(NOVA_CONVERSATION_ID);
        expect(result?.title).toBe('Sanitized Nova conversation');
        expect(result?.default_model_slug).toBe('amazon.nova.synthetic-v1:0');
        expect(result?.raw_payload).toEqual(terminalNovaConversation);
        expect(JSON.parse(JSON.stringify(result?.raw_payload))).toEqual(terminalNovaConversation);

        const messages = Object.values(result?.mapping ?? {})
            .map((node) => node.message)
            .filter((message) => message !== null);
        expect(messages.map((message) => message?.author.role)).toEqual(['user', 'assistant']);
        expect(messages[1]?.content.parts?.[0]).toBe('[sanitized terminal response]');
    });

    it('should parse canonical JSON only on the Nova API endpoint', () => {
        const parsed = novaAdapter.parseInterceptedData(
            JSON.stringify(terminalNovaConversation),
            'https://nova.amazon.com/api',
        );

        expect(parsed?.conversation_id).toBe(NOVA_CONVERSATION_ID);
        expect(
            novaAdapter.parseInterceptedData(
                JSON.stringify(terminalNovaConversation),
                'https://nova.amazon.com/registry',
            ),
        ).toBeNull();
        expect(
            novaAdapter.parseInterceptedData(
                JSON.stringify(terminalNovaConversation),
                'https://nova.amazon.com/api?operation=synthetic',
            ),
        ).toBeNull();
        expect(novaAdapter.parseInterceptedData('{"status":"success"}', 'https://nova.amazon.com/api')).toBeNull();
        expect(novaAdapter.parseInterceptedData('{broken', 'https://nova.amazon.com/api')).toBeNull();
    });

    it('should fail closed when canonical interactions disagree on conversation identity', () => {
        const mismatched = createNovaConversationFixture({ secondConversationId: NOVA_OTHER_CONVERSATION_ID });

        expect(parseNovaConversationPayload(mismatched)).toBeNull();
    });

    it('should keep the response non-terminal when any present companion status is unknown', () => {
        const unknownInteraction = parseNovaConversationPayload(
            createNovaConversationFixture({ interactionStatus: 'UNKNOWN_PROVIDER_STATE' }),
        );
        const unknownDeepResearch = parseNovaConversationPayload(
            createNovaConversationFixture({ deepResearchStatus: 'UNKNOWN_PROVIDER_STATE' }),
        );

        expect(unknownInteraction?.mapping[unknownInteraction.current_node]?.message?.status).toBe('in_progress');
        expect(unknownInteraction?.mapping[unknownInteraction.current_node]?.message?.end_turn).toBeFalse();
        expect(unknownDeepResearch?.mapping[unknownDeepResearch.current_node]?.message?.status).toBe('in_progress');
        expect(unknownDeepResearch?.mapping[unknownDeepResearch.current_node]?.message?.end_turn).toBeFalse();
    });

    it('should accept only explicitly terminal statuses when all present statuses agree', () => {
        const parsed = parseNovaConversationPayload(
            createNovaConversationFixture({
                assistantStatus: 'finished',
                interactionStatus: 'completed',
                deepResearchStatus: 'succeeded',
            }),
        );

        expect(parsed?.mapping[parsed.current_node]?.message?.status).toBe('finished_successfully');
        expect(parsed?.mapping[parsed.current_node]?.message?.end_turn).toBeTrue();
    });

    it('should reject empty and structurally unrelated payloads', () => {
        const missingInteractionId = JSON.parse(JSON.stringify(terminalNovaConversation)) as {
            conversationInteractions: Array<Record<string, unknown>>;
        };
        delete missingInteractionId.conversationInteractions[0]?.interactionId;

        expect(parseNovaConversationPayload(null)).toBeNull();
        expect(parseNovaConversationPayload({ conversationInteractions: [] })).toBeNull();
        expect(
            parseNovaConversationPayload({ conversationInteractions: [{ conversationId: NOVA_CONVERSATION_ID }] }),
        ).toBeNull();
        expect(parseNovaConversationPayload(missingInteractionId)).toBeNull();
        expect(parseNovaConversationPayload({ modelConfigs: [] })).toBeNull();
    });
});
