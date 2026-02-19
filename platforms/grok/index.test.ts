import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('wxt/browser', () => ({
    browser: {
        storage: { local: { get: async () => ({}), set: async () => {} } },
        runtime: { getURL: () => 'chrome-extension://mock/' },
    },
}));
mock.module('@/utils/logger', () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import sampleConversation from '@/data/grok/sample_grok_conversation.json';
import sampleHistory from '@/data/grok/sample_grok_history.json';

const withMockDom = (
    href: string,
    body: HTMLElement,
    querySelector: (selector: string) => Element | null,
    fn: () => void,
) => {
    const originalDocument = (globalThis as { document?: unknown }).document;
    const originalWindow = (globalThis as { window?: unknown }).window;

    (globalThis as { document?: unknown }).document = {
        body,
        querySelector,
    };
    (globalThis as { window?: unknown }).window = {
        location: new URL(href),
    };

    try {
        fn();
    } finally {
        (globalThis as { document?: unknown }).document = originalDocument;
        (globalThis as { window?: unknown }).window = originalWindow;
    }
};

let grokAdapter: any;
let resetGrokAdapterState: (() => void) | null = null;

beforeAll(async () => {
    const mod = await import('@/platforms/grok');
    grokAdapter = mod.grokAdapter;
    resetGrokAdapterState = mod.resetGrokAdapterState ?? null;
});

beforeEach(() => {
    resetGrokAdapterState?.();
});

describe('Grok Adapter — URL handling', () => {
    describe('isPlatformUrl', () => {
        it('should recognize valid Grok URLs', () => {
            expect(grokAdapter.isPlatformUrl('https://x.com/i/grok?conversation=123')).toBeTrue();
            expect(grokAdapter.isPlatformUrl('https://x.com/i/grok')).toBeTrue();
            expect(grokAdapter.isPlatformUrl('https://grok.com/c/01cb0729-6455-471d-b33a-124b3de76a29')).toBeTrue();
            expect(grokAdapter.isPlatformUrl('https://grok.com/')).toBeTrue();
        });

        it('should reject non-Grok URLs', () => {
            expect(grokAdapter.isPlatformUrl('https://x.com/home')).toBeFalse();
            expect(grokAdapter.isPlatformUrl('https://chatgpt.com')).toBeFalse();
        });
    });

    describe('extractConversationId', () => {
        it('should extract ID from x.com Grok URL', () => {
            expect(grokAdapter.extractConversationId('https://x.com/i/grok?conversation=2013295304527827227')).toBe(
                '2013295304527827227',
            );
        });

        it('should extract ID from grok.com URL', () => {
            expect(
                grokAdapter.extractConversationId('https://grok.com/c/01cb0729-6455-471d-b33a-124b3de76a29?rid=abc'),
            ).toBe('01cb0729-6455-471d-b33a-124b3de76a29');
        });

        it('should extract ID with additional query params', () => {
            expect(
                grokAdapter.extractConversationId('https://x.com/i/grok?conversation=2013295304527827227&mode=normal'),
            ).toBe('2013295304527827227');
        });

        it('should handle minimum-length numeric IDs', () => {
            expect(grokAdapter.extractConversationId('https://x.com/i/grok?conversation=1234567890')).toBe(
                '1234567890',
            );
        });

        it('should return null for missing conversation param', () => {
            expect(grokAdapter.extractConversationId('https://x.com/i/grok')).toBeNull();
        });

        it('should return null for invalid ID format', () => {
            expect(grokAdapter.extractConversationId('https://x.com/i/grok?conversation=invalid-id')).toBeNull();
        });

        it('should return null for too-long numeric ID (> 20 digits)', () => {
            expect(
                grokAdapter.extractConversationId('https://x.com/i/grok?conversation=20132953045278272271234567890'),
            ).toBeNull();
        });

        it('should return null for non-x.com domain', () => {
            expect(grokAdapter.extractConversationId('https://twitter.com/i/grok?conversation=123456789')).toBeNull();
        });

        it('should return null for non-Grok path', () => {
            expect(grokAdapter.extractConversationId('https://x.com/home')).toBeNull();
        });
    });

    describe('extractConversationIdFromUrl', () => {
        it('should extract x.com restId from GraphQL variables', () => {
            const variables = JSON.stringify({ restId: '2013295304527827227' });
            const url = `https://x.com/i/api/graphql/6QmFg/GrokConversationItemsByRestId?variables=${encodeURIComponent(variables)}`;
            expect(grokAdapter.extractConversationIdFromUrl(url)).toBe('2013295304527827227');
        });

        it('should extract grok.com UUID from REST URLs', () => {
            expect(
                grokAdapter.extractConversationIdFromUrl(
                    'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/load-responses',
                ),
            ).toBe('01cb0729-6455-471d-b33a-124b3de76a29');
        });
    });

    describe('buildApiUrls', () => {
        it('should provide grok.com fetch candidates for UUID conversation IDs', () => {
            const id = '01cb0729-6455-471d-b33a-124b3de76a29';
            const urls = grokAdapter.buildApiUrls?.(id) ?? [];
            expect(urls.length).toBe(3);
            expect(urls[0]).toContain(`/conversations/${id}/load-responses`);
            expect(urls[1]).toContain(`/conversations/${id}/response-node`);
            expect(urls[2]).toContain(`/conversations_v2/${id}`);
        });

        it('should not provide grok.com fetch candidates for x.com numeric IDs', () => {
            expect(grokAdapter.buildApiUrls?.('2013295304527827227') ?? []).toEqual([]);
        });
    });
});

describe('Grok Adapter — API pattern matching', () => {
    it('should match GrokConversationItemsByRestId GraphQL endpoint', () => {
        expect(
            grokAdapter.apiEndpointPattern.test(
                'https://x.com/i/api/graphql/6QmFg/GrokConversationItemsByRestId?variables=%7B%22restId%22%3A%222013295304527827227%22%7D',
            ),
        ).toBeTrue();
    });

    it('should match GrokHistory endpoint', () => {
        expect(
            grokAdapter.apiEndpointPattern.test('https://x.com/i/api/graphql/9Hyh5D4/GrokHistory?variables=%7B%7D'),
        ).toBeTrue();
    });

    it('should match grok.com conversation endpoints', () => {
        const { apiEndpointPattern } = grokAdapter;
        expect(
            apiEndpointPattern.test(
                'https://grok.com/rest/app-chat/conversations_v2/01cb0729-6455-471d-b33a-124b3de76a29?includeWorkspaces=true',
            ),
        ).toBeTrue();
        expect(
            apiEndpointPattern.test(
                'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/response-node?includeThreads=true',
            ),
        ).toBeTrue();
        expect(
            apiEndpointPattern.test(
                'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/load-responses',
            ),
        ).toBeTrue();
    });

    it('should match x.com add_response.json streaming endpoint', () => {
        expect(grokAdapter.apiEndpointPattern.test('https://x.com/2/grok/add_response.json')).toBeTrue();
    });

    it('should match grok.com conversations/new endpoint', () => {
        expect(grokAdapter.apiEndpointPattern.test('https://grok.com/rest/app-chat/conversations/new')).toBeTrue();
    });

    it('should match grok.com reconnect-response-v2 in apiEndpointPattern but NOT completionTriggerPattern', () => {
        const url =
            'https://grok.com/rest/app-chat/conversations/reconnect-response-v2/5b128365-2fed-4339-a2b6-8a85a62ad182';
        expect(grokAdapter.apiEndpointPattern.test(url)).toBeTrue();
        expect(grokAdapter.completionTriggerPattern.test(url)).toBeFalse();
    });

    it('should match completion trigger for add_response.json', () => {
        expect(grokAdapter.completionTriggerPattern.test('https://x.com/2/grok/add_response.json')).toBeTrue();
    });

    it('should match completion trigger for conversations/new', () => {
        expect(
            grokAdapter.completionTriggerPattern.test('https://grok.com/rest/app-chat/conversations/new'),
        ).toBeTrue();
    });

    it('should NOT match other GraphQL endpoints', () => {
        expect(grokAdapter.apiEndpointPattern.test('https://x.com/i/api/graphql/abc123/UserByScreenName')).toBeFalse();
    });

    it('should NOT match plain Grok page URLs', () => {
        expect(grokAdapter.apiEndpointPattern.test('https://x.com/i/grok?conversation=123')).toBeFalse();
    });

    it('conversations_v2 matches apiEndpointPattern but NOT completionTriggerPattern', () => {
        const url = 'https://grok.com/rest/app-chat/conversations_v2/af642f01?includeWorkspaces=true';
        expect(grokAdapter.apiEndpointPattern.test(url)).toBeTrue();
        expect(grokAdapter.completionTriggerPattern?.test(url)).toBeFalse();
    });

    it('GrokHistory does not match completionTriggerPattern', () => {
        expect(
            grokAdapter.completionTriggerPattern.test(
                'https://x.com/i/api/graphql/9Hyh5D4/GrokHistory?variables=%7B%7D',
            ),
        ).toBeFalse();
    });

    it('completion trigger should match x.com and grok.com response endpoints', () => {
        const { completionTriggerPattern } = grokAdapter;
        expect(
            completionTriggerPattern.test(
                'https://x.com/i/api/graphql/6QmFg/GrokConversationItemsByRestId?variables=%7B%22restId%22%3A%222013295304527827227%22%7D',
            ),
        ).toBeTrue();
        expect(
            completionTriggerPattern.test(
                'https://grok.com/rest/app-chat/conversations/01cb0729-6455-471d-b33a-124b3de76a29/load-responses',
            ),
        ).toBeTrue();
    });
});

describe('Grok Adapter — title caching (GrokHistory)', () => {
    it('should parse GrokHistory and cache titles without returning ConversationData', () => {
        const historyResult = grokAdapter.parseInterceptedData(
            JSON.stringify(sampleHistory),
            'https://x.com/i/api/graphql/test/GrokHistory',
        );
        expect(historyResult).toBeNull();

        // Subsequent conversation parse should pick up the cached title
        const conversationResult = grokAdapter.parseInterceptedData(
            JSON.stringify(sampleConversation),
            'https://x.com/i/api/graphql/test/GrokConversationItemsByRestId',
        );
        expect(conversationResult).not.toBeNull();
        expect(conversationResult?.title).toBeDefined();
    });

    it('should handle GrokHistory as raw string', () => {
        const result = grokAdapter.parseInterceptedData(
            JSON.stringify(sampleHistory),
            'https://x.com/i/api/graphql/test/GrokHistory',
        );
        expect(result).toBeNull();
    });

    it('should handle invalid GrokHistory gracefully', () => {
        const result = grokAdapter.parseInterceptedData(
            JSON.stringify({ data: { invalid: 'structure' } }),
            'https://x.com/i/api/graphql/test/GrokHistory',
        );
        expect(result).toBeNull();
    });
});

describe('Grok Adapter — formatFilename', () => {
    const buildConversationData = (overrides = {}) => ({
        title: 'Test Grok Conversation',
        create_time: 1768841980.715,
        update_time: 1768841980.715,
        mapping: {},
        conversation_id: '2013295304527827227',
        current_node: 'node-1',
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'grok-2',
        safe_urls: [],
        blocked_urls: [],
        ...overrides,
    });

    it('should include sanitized title and timestamp', () => {
        const filename = grokAdapter.formatFilename(buildConversationData({ title: 'Test Grok Conversation' }));
        expect(filename).toContain('Test_Grok_Conversation');
        expect(filename).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('should sanitize special characters', () => {
        const filename = grokAdapter.formatFilename(
            buildConversationData({ title: 'Test: Special/Characters\\Here?' }),
        );
        expect(filename).not.toMatch(/[:/\\?<>"|*]/);
    });

    it('should use fallback when title is empty', () => {
        expect(grokAdapter.formatFilename(buildConversationData({ title: '' }))).toContain('grok_conversation');
    });

    it('should truncate very long titles', () => {
        expect(grokAdapter.formatFilename(buildConversationData({ title: 'A'.repeat(200) })).length).toBeLessThan(150);
    });
});

describe('Grok Adapter — extractTitleFromDom', () => {
    const withDoc = (doc: { title?: string; querySelector?: (selector: string) => Element | null }, fn: () => void) => {
        const orig = (globalThis as any).document;
        (globalThis as any).document = doc;
        try {
            fn();
        } finally {
            (globalThis as any).document = orig;
        }
    };

    const withDocTitle = (title: string, fn: () => void) => withDoc({ title, querySelector: () => null }, fn);

    it('should have extractTitleFromDom defined', () => {
        expect(typeof grokAdapter.extractTitleFromDom).toBe('function');
    });

    it('should have the expected defaultTitles', () => {
        expect(grokAdapter.defaultTitles).toContain('New conversation');
        expect(grokAdapter.defaultTitles).toContain('Grok Conversation');
        expect(grokAdapter.defaultTitles).toContain('Grok / X');
    });

    it('should strip "- Grok" suffix', () => {
        withDocTitle('Classical Islamic Text Translation Guidelines - Grok', () => {
            expect(grokAdapter.extractTitleFromDom()).toBe('Classical Islamic Text Translation Guidelines');
        });
    });

    it('should return title without suffix unchanged', () => {
        withDocTitle('Some Conversation Title', () => {
            expect(grokAdapter.extractTitleFromDom()).toBe('Some Conversation Title');
        });
    });

    it('should return null for bare "Grok" page title', () => {
        withDocTitle('Grok', () => {
            expect(grokAdapter.extractTitleFromDom()).toBeNull();
        });
    });

    it('should return null for generic "Grok / X" page title', () => {
        withDocTitle('Grok / X', () => {
            expect(grokAdapter.extractTitleFromDom()).toBeNull();
        });
    });

    it('should return null for empty document title', () => {
        withDocTitle('', () => {
            expect(grokAdapter.extractTitleFromDom()).toBeNull();
        });
    });

    it('should return null when cleaned title matches a default', () => {
        withDocTitle('New conversation - Grok', () => {
            expect(grokAdapter.extractTitleFromDom()).toBeNull();
        });
    });

    it('should resolve title from x.com active conversation DOM when page title is generic', () => {
        const activeConversationTitle = { textContent: 'Classical Islamic Text Translation Guidelines' } as Element;
        withDoc(
            {
                title: 'Grok / X',
                querySelector: (selector: string) =>
                    selector === '[aria-current="page"][href*="/i/grok?conversation="] [dir="ltr"]'
                        ? activeConversationTitle
                        : null,
            },
            () => {
                expect(grokAdapter.extractTitleFromDom()).toBe('Classical Islamic Text Translation Guidelines');
            },
        );
    });
});

describe('Grok Adapter — getButtonInjectionTarget', () => {
    it('should force body injection for x.com Grok conversation pages', () => {
        const body = {} as HTMLElement;
        const bannerParent = {} as HTMLElement;
        const banner = { parentElement: bannerParent } as HTMLElement;

        withMockDom(
            'https://x.com/i/grok?conversation=2024522069224943757',
            body,
            () => banner,
            () => {
                expect(grokAdapter.getButtonInjectionTarget()).toBe(body);
            },
        );
    });
});
