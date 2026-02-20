import { describe, expect, it } from 'bun:test';
import { evaluateReadinessForData } from '@/utils/runner/readiness-evaluation';

describe('readiness-evaluation', () => {
    describe('evaluateReadinessForData', () => {
        it('should return invalid shape if malformed', () => {
            expect(evaluateReadinessForData({} as any, null)).toEqual({
                ready: false,
                terminal: false,
                reason: 'invalid-conversation-shape',
                contentHash: null,
                latestAssistantTextLength: 0,
            });
        });

        it('should defer to adapter evaluateReadiness if present', () => {
            const data = { mapping: {} } as any;
            const adapterReady = {
                ready: true,
                terminal: true,
                reason: 'adapter',
                contentHash: 'abc',
                latestAssistantTextLength: 10,
            };
            const adapter = { evaluateReadiness: () => adapterReady } as any;

            expect(evaluateReadinessForData(data, adapter)).toBe(adapterReady);
        });

        it('should mark generic fallback ready based on isConversationReady', () => {
            const data = {
                mapping: {
                    'node-1': {
                        message: {
                            id: 'msg-1',
                            author: { role: 'assistant' },
                            content: { content_type: 'text', parts: ['hello'] },
                            status: 'finished_successfully',
                        },
                    },
                },
            } as any;

            const result = evaluateReadinessForData(data, null);
            expect(result.terminal).toBeTrue();
            expect(result.reason).toBe('terminal-snapshot');
            expect(result.latestAssistantTextLength).toBeGreaterThan(0);
        });

        it('should mark not terminal if assistant message in_progress', () => {
            const data = {
                mapping: {
                    'node-1': {
                        message: {
                            id: 'msg-1',
                            author: { role: 'assistant' },
                            content: { content_type: 'text', parts: ['hello'] },
                            status: 'in_progress',
                        },
                    },
                },
            } as any;

            const result = evaluateReadinessForData(data, null);
            expect(result.terminal).toBeFalse();
            expect(result.reason).toBe('assistant-in-progress');
        });
    });
});
