import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
    extractConversationIdFromAnyUrl,
    extractConversationIdFromChatGptUrl,
    extractConversationIdFromRequestBody,
    extractLatestAssistantText,
    getApiUrlCandidates,
    isCapturedConversationReady,
    isFetchReady,
    parseConversationData,
    resolveLifecycleConversationId,
    resolveParsedConversationId,
    resolveRequestConversationId,
} from '@/entrypoints/interceptor/conversation-utils';

mock.module('@/utils/conversation-readiness', () => ({
    isConversationReady: () => true,
}));

const mockUUID = '12345678-1234-1234-1234-123456789012';

describe('conversation-utils', () => {
    let originalWindow: any;
    beforeEach(() => {
        originalWindow = (globalThis as any).window;
        (globalThis as any).window = {
            location: {
                href: 'https://chatgpt.com',
                origin: 'https://chatgpt.com',
            },
        };
    });

    afterEach(() => {
        (globalThis as any).window = originalWindow;
    });

    describe('extractConversationIdFromChatGptUrl', () => {
        it('should extract correct uuid from /c/ url', () => {
            expect(extractConversationIdFromChatGptUrl(`https://chatgpt.com/c/${mockUUID}`)).toBe(mockUUID);
        });

        it('should return undefined if not matched', () => {
            expect(extractConversationIdFromChatGptUrl('https://chatgpt.com/')).toBeUndefined();
        });
    });

    describe('extractConversationIdFromAnyUrl', () => {
        it('should extract uuid from any valid pattern', () => {
            expect(extractConversationIdFromAnyUrl(`https://api.com/query?id=${mockUUID}&v=2`)).toBe(mockUUID);
        });

        it('should return undefined if no uuid found', () => {
            expect(extractConversationIdFromAnyUrl('https://api.com/query?id=123')).toBeUndefined();
        });
    });

    describe('extractConversationIdFromRequestBody', () => {
        it('should extract conversation_id from json body', () => {
            const fetchArgs = ['url', { body: JSON.stringify({ conversation_id: mockUUID }) }] as any;
            expect(extractConversationIdFromRequestBody(fetchArgs)).toBe(mockUUID);
        });

        it('should return undefined if json invalid or non uuid', () => {
            expect(extractConversationIdFromRequestBody(['url', {}] as any)).toBeUndefined();
            expect(extractConversationIdFromRequestBody(['url', { body: '{]' }] as any)).toBeUndefined();
            expect(
                extractConversationIdFromRequestBody([
                    'url',
                    { body: JSON.stringify({ conversation_id: '123' }) },
                ] as any),
            ).toBeUndefined();
        });
    });

    describe('resolveLifecycleConversationId', () => {
        it('should extract from body first if present', () => {
            const fetchArgs = ['url', { body: JSON.stringify({ conversation_id: mockUUID }) }] as any;
            expect(resolveLifecycleConversationId(fetchArgs)).toBe(mockUUID);
        });
    });

    describe('resolveRequestConversationId', () => {
        it('should check extractConversationIdFromUrl first then extractConversationId', () => {
            const adapter = {
                extractConversationIdFromUrl: () => 'from-url',
                extractConversationId: () => 'from-href',
            } as any;
            expect(resolveRequestConversationId(adapter, 'req-url')).toBe('from-url');

            adapter.extractConversationIdFromUrl = undefined;
            expect(resolveRequestConversationId(adapter, 'req-url')).toBe('from-href');

            adapter.extractConversationId = () => undefined;
            expect(resolveRequestConversationId(adapter, 'req-url')).toBeUndefined();
        });
    });

    describe('parseConversationData', () => {
        it('should return parsed data or null on failure', () => {
            const adapter = {
                parseInterceptedData: (d: string) => {
                    if (d === 'fail') {
                        throw new Error('fail');
                    }
                    return { parsed: true };
                },
            } as any;

            expect(parseConversationData(adapter, 'data', 'url')).toEqual({ parsed: true } as any);
            expect(parseConversationData(adapter, 'fail', 'url')).toBeNull();
        });
    });

    describe('resolveParsedConversationId', () => {
        it('should fallback properly through parsed -> adapter -> generic extraction', () => {
            const adapter = { extractConversationIdFromUrl: () => 'from-adapter' } as any;

            expect(resolveParsedConversationId(adapter, { conversation_id: 'from-parsed' } as any, 'url')).toBe(
                'from-parsed',
            );
            expect(resolveParsedConversationId(adapter, null, 'url')).toBe('from-adapter');

            delete adapter.extractConversationIdFromUrl;
            expect(resolveParsedConversationId(adapter, null, `http://test/${mockUUID}`)).toBe(mockUUID);
        });
    });

    describe('extractLatestAssistantText', () => {
        it('should extract text from latest assistant message mapping', () => {
            const parsed = {
                mapping: {
                    '1': { message: { author: { role: 'assistant' }, content: { parts: ['first'] }, create_time: 1 } },
                    '2': { message: { author: { role: 'user' }, content: { parts: ['user'] }, create_time: 2 } },
                    '3': { message: { author: { role: 'assistant' }, content: { parts: ['latest'] }, create_time: 3 } },
                },
            } as any;

            expect(extractLatestAssistantText(parsed)).toBe('latest');
        });

        it('should return null if empty or version string', () => {
            const parsed = {
                mapping: {
                    '1': { message: { author: { role: 'assistant' }, content: { parts: [''] }, create_time: 1 } },
                    '2': { message: { author: { role: 'assistant' }, content: { parts: ['v123'] }, create_time: 2 } },
                },
            } as any;
            expect(extractLatestAssistantText(parsed)).toBeNull();
        });
    });

    describe('isFetchReady', () => {
        it('should return true if extract and build features exist', () => {
            expect(isFetchReady({ extractConversationIdFromUrl: () => {}, buildApiUrl: () => {} } as any)).toBeTrue();
            expect(isFetchReady({ extractConversationIdFromUrl: () => {}, buildApiUrls: () => [] } as any)).toBeTrue();
            expect(isFetchReady({ buildApiUrl: () => {} } as any)).toBeFalse(); // Missing extract
        });
    });

    describe('getApiUrlCandidates', () => {
        it('should prepend buildApiUrl and append buildApiUrls, deduped and origin checked', () => {
            const adapter = {
                buildApiUrl: () => 'https://chatgpt.com/api/primary',
                buildApiUrls: () => [
                    'https://chatgpt.com/api/secondary',
                    'https://chatgpt.com/api/primary',
                    'https://evil.com/api',
                ],
            } as any;

            const urls = getApiUrlCandidates(adapter, 'cid');
            expect(urls).toEqual(['https://chatgpt.com/api/secondary', 'https://chatgpt.com/api/primary']);
        });
    });

    describe('isCapturedConversationReady', () => {
        // Not strictly passing the mock directly, passing as any
        it('should return false if parsed is missing or invalid type', () => {
            expect(isCapturedConversationReady({} as any, null)).toBeFalse();
            expect(isCapturedConversationReady({} as any, 'str')).toBeFalse();
            expect(isCapturedConversationReady({} as any, { no_id: true })).toBeFalse();
        });

        it('should invoke adapter method if provided or default fallback', () => {
            const validData = { conversation_id: 'c-1' };
            // Use adapter with evaluateReadiness since module mock might not hoist natively depending on bun version
            expect(isCapturedConversationReady({ evaluateReadiness: () => ({ ready: true }) } as any, validData)).toBe(
                true,
            );

            const adapter = { evaluateReadiness: () => ({ ready: false }) } as any;
            expect(isCapturedConversationReady(adapter, validData)).toBe(false);
        });
    });
});
