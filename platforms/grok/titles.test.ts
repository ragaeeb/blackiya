import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { grokState } from '@/platforms/grok/state';
import { isTitlesEndpoint, tryHandleGrokTitlesEndpoint } from '@/platforms/grok/titles';
import { buildLoggerMock, createLoggerCalls } from '@/utils/runner/__tests__/helpers';

const logCalls = createLoggerCalls();
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));

describe('grok-titles', () => {
    beforeEach(() => {
        grokState.reset();
        logCalls.info.length = 0;
        logCalls.error.length = 0;
        logCalls.warn.length = 0;
    });

    describe('isTitlesEndpoint', () => {
        it('should detect GrokHistory urls', () => {
            expect(isTitlesEndpoint('https://api.grok.com/GrokHistory?someparam')).toBeTrue();
            expect(isTitlesEndpoint('https://api.grok.com/OtherEndpoint')).toBeFalse();
        });
    });

    describe('tryHandleGrokTitlesEndpoint', () => {
        it('should skip if not a title endpoint', () => {
            expect(tryHandleGrokTitlesEndpoint('{}', 'some-url')).toBeFalse();
        });

        it('should gracefully handle non-string inputs and serialize them', () => {
            const data = {
                data: { grok_conversation_history: { items: [{ grokConversation: { rest_id: '1' }, title: 'T1' }] } },
            };
            expect(tryHandleGrokTitlesEndpoint(data, 'GrokHistory')).toBeTrue();
            expect(grokState.conversationTitles.get('1')).toBe('T1');
        });

        it('should log warning if serialization fails or returns non-string', () => {
            const circular: any = {};
            circular.self = circular;

            expect(tryHandleGrokTitlesEndpoint(circular, 'GrokHistory')).toBeTrue();
            expect(logCalls.warn.length).toBeGreaterThan(0);
            expect(grokState.conversationTitles.size).toBe(0);
        });

        it('should update retroactively if active conversation exists with old title', () => {
            grokState.activeConversations.set('conv-1', {
                conversation_id: 'conv-1',
                title: 'Old Title',
                mapping: {},
            } as any);

            const payload = JSON.stringify({
                data: {
                    grok_conversation_history: {
                        items: [{ grokConversation: { rest_id: 'conv-1' }, title: 'New Title' }],
                    },
                },
            });

            expect(tryHandleGrokTitlesEndpoint(payload, 'GrokHistory')).toBeTrue();

            expect(grokState.activeConversations.get('conv-1')?.title).toBe('New Title');
            // Make sure cache has it too
            expect(grokState.conversationTitles.get('conv-1')).toBe('New Title');
        });

        it('should log error if payload parsing throws', () => {
            expect(tryHandleGrokTitlesEndpoint('invalid json', 'GrokHistory')).toBeTrue();
            expect(logCalls.error.length).toBeGreaterThan(0);
            expect(grokState.conversationTitles.size).toBe(0);
        });

        it('should log error if historyData missing items array', () => {
            expect(tryHandleGrokTitlesEndpoint('{"data": {}}', 'GrokHistory')).toBeTrue();
            expect(grokState.conversationTitles.size).toBe(0);
        });

        it('should skip malformed titles or rest_ids in array', () => {
            const payload = JSON.stringify({
                data: {
                    grok_conversation_history: {
                        items: [
                            { grokConversation: { rest_id: 123 }, title: 'T' },
                            { grokConversation: { rest_id: 'valid' }, title: null },
                        ],
                    },
                },
            });

            expect(tryHandleGrokTitlesEndpoint(payload, 'GrokHistory')).toBeTrue();
            expect(grokState.conversationTitles.size).toBe(0);
        });
    });
});
