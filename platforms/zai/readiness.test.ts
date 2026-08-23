import { describe, expect, it } from 'bun:test';
import {
    ZAI_ASSISTANT_MESSAGE_ID,
    zaiDetailPayloadFixture,
    zaiMessagesBatchPayloadFixture,
} from './fixtures/har-derived';
import { mergeZaiConversationPayloads, parseZaiConversationDetail } from './parser';
import { evaluateZaiReadiness } from './readiness';

describe('Z.ai readiness', () => {
    it('should accept a done assistant turn with terminal text', () => {
        const parsed = mergeZaiConversationPayloads(zaiDetailPayloadFixture, zaiMessagesBatchPayloadFixture);

        expect(evaluateZaiReadiness(parsed!)).toMatchObject({
            ready: true,
            terminal: true,
            reason: 'terminal',
        });
        expect(evaluateZaiReadiness(parsed!).contentHash).not.toBeNull();
    });

    it('should reject an unloaded detail assistant stub', () => {
        const parsed = parseZaiConversationDetail(zaiDetailPayloadFixture);

        expect(evaluateZaiReadiness(parsed!)).toEqual({
            ready: false,
            terminal: false,
            reason: 'assistant-in-progress',
            contentHash: null,
            latestAssistantTextLength: 0,
        });
    });

    it('should fail closed while the assistant done marker is false', () => {
        const batch = structuredClone(zaiMessagesBatchPayloadFixture);
        batch.data[ZAI_ASSISTANT_MESSAGE_ID].done = false;
        const parsed = mergeZaiConversationPayloads(zaiDetailPayloadFixture, batch);

        expect(evaluateZaiReadiness(parsed!)).toMatchObject({
            ready: false,
            terminal: false,
            reason: 'assistant-in-progress',
        });
    });

    it('should reject a done assistant response without text', () => {
        const batch = structuredClone(zaiMessagesBatchPayloadFixture);
        for (const block of batch.data[ZAI_ASSISTANT_MESSAGE_ID].content_blocks) {
            if (block.type === 'text' && typeof block.content === 'string') {
                block.content = '   ';
            }
        }
        const parsed = mergeZaiConversationPayloads(zaiDetailPayloadFixture, batch);

        expect(evaluateZaiReadiness(parsed!)).toEqual({
            ready: false,
            terminal: true,
            reason: 'assistant-text-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        });
    });

    it('should reject a terminal assistant error', () => {
        const batch: any = structuredClone(zaiMessagesBatchPayloadFixture);
        batch.data[ZAI_ASSISTANT_MESSAGE_ID].error = { code: 'synthetic_error' };
        const parsed = mergeZaiConversationPayloads(zaiDetailPayloadFixture, batch);

        expect(evaluateZaiReadiness(parsed!)).toMatchObject({
            ready: false,
            terminal: true,
            reason: 'assistant-error',
        });
    });
});
