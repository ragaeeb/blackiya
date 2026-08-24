import { describe, expect, it } from 'bun:test';
import { createMetaDetailFixture, createMetaOlderPageFixture } from './fixtures/conversation';
import { parseMetaConversationArchive, parseMetaConversationPayload } from './parser';
import { evaluateMetaReadiness } from './readiness';

const parseFixture = (payload: ReturnType<typeof createMetaDetailFixture>) => {
    const parsed = parseMetaConversationPayload(payload);
    if (!parsed) {
        throw new Error('Synthetic fixture did not parse');
    }
    return parsed;
};

const withUnifiedResponse = (unifiedResponse: Record<string, unknown>): ReturnType<typeof createMetaDetailFixture> =>
    createMetaDetailFixture({ assistantContent: '', assistantStructuredContent: unifiedResponse });

describe('Meta Muse readiness', () => {
    it('should accept a complete latest assistant message only when Meta reports DONE', () => {
        const readiness = evaluateMetaReadiness(parseFixture(createMetaDetailFixture()));

        expect(readiness.ready).toBeTrue();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('terminal');
        expect(readiness.contentHash).not.toBeNull();
    });

    it('should fail closed when the latest assistant message is still streaming', () => {
        const readiness = evaluateMetaReadiness(
            parseFixture(createMetaDetailFixture({ assistantStreamingState: 'STREAMING' })),
        );

        expect(readiness.ready).toBeFalse();
        expect(readiness.terminal).toBeFalse();
        expect(readiness.reason).toBe('assistant-in-progress');
    });

    it('should keep a terminal turn unready while older history remains unfetched', () => {
        const readiness = evaluateMetaReadiness(parseFixture(createMetaDetailFixture({ hasPreviousPage: true })));

        expect(readiness.ready).toBeFalse();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('history-incomplete');
    });

    it('should become ready after the oldest backward page closes pagination', () => {
        const parsed = parseMetaConversationArchive(createMetaDetailFixture({ hasPreviousPage: true }), [
            createMetaOlderPageFixture(),
        ]);
        if (!parsed) {
            throw new Error('Synthetic archive did not parse');
        }

        expect(evaluateMetaReadiness(parsed)).toMatchObject({
            ready: true,
            terminal: true,
            reason: 'terminal',
        });
    });

    it('should reject a provider error even if a terminal state is also present', () => {
        const readiness = evaluateMetaReadiness(
            parseFixture(createMetaDetailFixture({ assistantError: { code: 'SYNTHETIC_ERROR' } })),
        );

        expect(readiness.ready).toBeFalse();
        expect(readiness.terminal).toBeFalse();
        expect(readiness.reason).toBe('assistant-error');
    });

    it('should accept explicit DONE structured output without plain text', () => {
        const readiness = evaluateMetaReadiness(parseFixture(createMetaDetailFixture({ assistantContent: '' })));

        expect(readiness.ready).toBeTrue();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.latestAssistantTextLength).toBe(0);
        expect(readiness.contentHash).toBeNull();
    });

    it('should reject an empty unified response without plain text', () => {
        const readiness = evaluateMetaReadiness(parseFixture(withUnifiedResponse({})));

        expect(readiness.ready).toBeFalse();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('assistant-content-missing');
    });

    it('should reject a recursively empty or false unified response without plain text', () => {
        const readiness = evaluateMetaReadiness(
            parseFixture(
                withUnifiedResponse({
                    sections: [],
                    nested: {
                        artifact: {},
                        enabled: false,
                        values: [null, '', false, { children: [] }],
                    },
                }),
            ),
        );

        expect(readiness.ready).toBeFalse();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('assistant-content-missing');
    });

    it('should accept a materially populated unified response without plain text', () => {
        const readiness = evaluateMetaReadiness(
            parseFixture(withUnifiedResponse({ nested: { artifact: { label: 'Synthetic artifact' } } })),
        );

        expect(readiness.ready).toBeTrue();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('terminal');
    });

    it('should reject an empty DONE response without text or structured output', () => {
        const readiness = evaluateMetaReadiness(
            parseFixture(createMetaDetailFixture({ assistantContent: '', includeStructuredContent: false })),
        );

        expect(readiness.ready).toBeFalse();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('assistant-content-missing');
    });
});
