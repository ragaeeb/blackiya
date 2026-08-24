import { describe, expect, it } from 'bun:test';

import {
    failedNovaConversation,
    pendingDeepResearchNovaConversation,
    pendingNovaConversation,
    statuslessNovaConversation,
    terminalArtifactNovaConversation,
    terminalNovaConversation,
} from './fixtures/conversation';
import { parseNovaConversationPayload } from './parser';
import { evaluateNovaReadiness } from './readiness';

const parseFixture = (fixture: Parameters<typeof parseNovaConversationPayload>[0]) => {
    const parsed = parseNovaConversationPayload(fixture);
    expect(parsed).not.toBeNull();
    if (!parsed) {
        throw new Error('fixture did not parse');
    }
    return parsed;
};

describe('Amazon Nova readiness', () => {
    it('should accept a successful terminal assistant response', () => {
        const readiness = evaluateNovaReadiness(parseFixture(terminalNovaConversation));

        expect(readiness.ready).toBeTrue();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('terminal');
        expect(readiness.contentHash).not.toBeNull();
    });

    it('should accept a successful terminal structured artifact without text', () => {
        const readiness = evaluateNovaReadiness(parseFixture(terminalArtifactNovaConversation));

        expect(readiness.ready).toBeTrue();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('terminal-structured-content');
        expect(readiness.latestAssistantTextLength).toBe(0);
    });

    it('should reject empty or false structured markers as missing content', () => {
        for (const part of [{ artifact: {} }, { files: [] }, { toolUse: false }, { artifact: { files: [] } }]) {
            const data = parseFixture(terminalArtifactNovaConversation);
            data.mapping[data.current_node]!.message!.content.parts = [part];
            expect(evaluateNovaReadiness(data).reason).toBe('assistant-content-missing');
        }
    });

    it('should reject in-progress responses as non-terminal', () => {
        const readiness = evaluateNovaReadiness(parseFixture(pendingNovaConversation));

        expect(readiness.ready).toBeFalse();
        expect(readiness.terminal).toBeFalse();
        expect(readiness.reason).toBe('assistant-in-progress');
    });

    it('should reject a pending deep-research interaction despite terminal message text', () => {
        const readiness = evaluateNovaReadiness(parseFixture(pendingDeepResearchNovaConversation));

        expect(readiness.ready).toBeFalse();
        expect(readiness.terminal).toBeFalse();
        expect(readiness.reason).toBe('assistant-in-progress');
    });

    it('should reject statusless responses rather than infer completion from text', () => {
        const readiness = evaluateNovaReadiness(parseFixture(statuslessNovaConversation));

        expect(readiness.ready).toBeFalse();
        expect(readiness.terminal).toBeFalse();
        expect(readiness.reason).toBe('assistant-in-progress');
    });

    it('should reject failed assistant responses', () => {
        const readiness = evaluateNovaReadiness(parseFixture(failedNovaConversation));

        expect(readiness.ready).toBeFalse();
        expect(readiness.terminal).toBeTrue();
        expect(readiness.reason).toBe('assistant-error');
    });
});
