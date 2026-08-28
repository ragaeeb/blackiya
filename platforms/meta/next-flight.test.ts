import { describe, expect, it } from 'bun:test';

import {
    createMetaDetailFixture,
    createMetaOlderPageFixture,
    SYNTHETIC_META_CONVERSATION_ID,
} from './fixtures/conversation';
import { extractMetaNextFlightConversation } from './next-flight';
import { buildMetaConversationPaginationRequest } from './request';
import { MetaGraphqlResponseAssembler } from './response-assembler';

describe('Meta Next.js Flight conversation capture', () => {
    it('should combine the embedded initial conversation with captured backward pagination', () => {
        const initial = createMetaDetailFixture({
            hasPreviousPage: true,
            assistantContent: '## Executive Answer\n\nSanitized answer.',
        });
        const page = createMetaOlderPageFixture();
        const paginationRequest = buildMetaConversationPaginationRequest(
            {
                conversationId: SYNTHETIC_META_CONVERSATION_ID,
                before: initial.data.conversation.messages.pageInfo.startCursor!,
                last: 10,
            },
            { documentId: 'synthetic_document_id' },
        );
        if (!paginationRequest) {
            throw new Error('expected sanitized Meta pagination request');
        }
        const assembler = new MetaGraphqlResponseAssembler();
        expect(assembler.ingest(paginationRequest.body, JSON.stringify(page))).toBeNull();

        const row = `a8:${JSON.stringify(initial)}`;
        const scripts = [{ textContent: `self.__next_f.push(${JSON.stringify([1, row])})` }];
        const embedded = extractMetaNextFlightConversation(scripts, SYNTHETIC_META_CONVERSATION_ID, 1024 * 1024);
        const parsed = embedded
            ? assembler.ingestInitialDocument(embedded.conversationId, embedded.responseText)
            : null;

        expect(parsed?.conversation_id).toBe(SYNTHETIC_META_CONVERSATION_ID);
        expect(JSON.stringify(parsed)).toContain('Executive Answer');
    });

    it('should ignore unrelated or malformed Flight rows', () => {
        expect(
            extractMetaNextFlightConversation(
                [{ textContent: 'self.__next_f.push([1,"not-json"])' }, { textContent: 'page-owned-script()' }],
                SYNTHETIC_META_CONVERSATION_ID,
                1024,
            ),
        ).toBeNull();
        expect(
            extractMetaNextFlightConversation(
                [
                    {
                        textContent: `self.__next_f.push(${JSON.stringify([1, `a8:${JSON.stringify(createMetaDetailFixture())}`])})`,
                    },
                ],
                SYNTHETIC_META_CONVERSATION_ID,
                10,
            ),
        ).toBeNull();
    });
});
