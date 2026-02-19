/**
 * Tests: Grok-specific lifecycle behaviours.
 *
 * Covers:
 *  - Badge updates for pending signals with null conversationId (Grok /conversations/new)
 *  - SPA navigation null → new conversation preserves streaming lifecycle (V2.2-001)
 *  - Stream delta rendered after SPA navigation (V2.2-002)
 *  - Lifecycle reset to idle when switching between existing Grok conversations (V2.2-003)
 *  - No ATTEMPT_DISPOSED for active attempt during null-to-new SPA navigation (V2.2-004)
 *  - refreshButtonState with null conversation must not clobber active lifecycle (V2.2-005)
 *  - injectSaveButton retries must not clobber active lifecycle (V2.2-006)
 *  - Completed promoted when canonical-ready capture arrives on new attempt after disposal
 *  - Lifecycle promoted to completed when canonical-ready capture arrives from /conversations/new
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { STORAGE_KEYS } from '@/utils/settings';

const window = new Window();
const document = window.document;
(global as any).window = window;
(global as any).document = document;
(global as any).history = window.history;
(global as any).HTMLElement = window.HTMLElement;
(global as any).HTMLButtonElement = window.HTMLButtonElement;
(global as any).MutationObserver = window.MutationObserver;

import {
    buildBrowserMock,
    buildConversation,
    buildLoggerMock,
    createLoggerCalls,
    createMockAdapter,
    evaluateReadinessMock,
    makePostStampedMessage,
} from './helpers';

let currentAdapterMock: any = createMockAdapter(document);
const browserMockState = {
    storageData: {} as Record<string, unknown>,
    sendMessage: async (_: unknown) => undefined as unknown,
};

mock.module('@/platforms/factory', () => ({
    getPlatformAdapter: () => currentAdapterMock,
    getPlatformAdapterByApiUrl: () => currentAdapterMock,
}));
mock.module('@/utils/download', () => ({ downloadAsJSON: () => {} }));
mock.module('@/utils/logger', () => buildLoggerMock(createLoggerCalls()));
mock.module('wxt/browser', () => buildBrowserMock(browserMockState));

import { runPlatform } from '@/utils/platform-runner';
import { getSessionToken } from '@/utils/protocol/session-token';

const postStampedMessage = makePostStampedMessage(window as any, getSessionToken);

const grokAdapter = () => ({
    ...createMockAdapter(document),
    name: 'Grok',
    extractConversationId: () => null,
    evaluateReadiness: evaluateReadinessMock,
});

describe('Platform Runner – Grok lifecycle', () => {
    beforeEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
        document.body.innerHTML = '';
        currentAdapterMock = createMockAdapter(document);
        browserMockState.storageData = { [STORAGE_KEYS.STREAM_PROBE_VISIBLE]: true };
        browserMockState.sendMessage = async () => undefined;
        delete (window as any).location;
        (window as any).location = { href: 'https://grok.com/', origin: 'https://grok.com' };
        (global as any).alert = () => {};
        (global as any).confirm = () => true;
        window.localStorage.clear();
        (globalThis as any).__BLACKIYA_CAPTURE_QUEUE__ = [];
        (globalThis as any).__BLACKIYA_LOG_QUEUE__ = [];
    });

    afterEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
    });

    it('should update lifecycle badge for pending signals with null conversationId (Grok regression)', async () => {
        currentAdapterMock = grokAdapter();
        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-1',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Prompt Sent');

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-1',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
    });

    it('should preserve streaming lifecycle when Grok SPA navigates null → new conversation (V2.2-001)', async () => {
        currentAdapterMock = grokAdapter();
        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-nav-1',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-nav-1',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');

        currentAdapterMock.extractConversationId = () => 'grok-nav-conv-1';
        (window as any).location.href = 'https://grok.com/c/grok-nav-conv-1?rid=some-response-id';
        window.dispatchEvent(new (window as any).Event('popstate'));
        await new Promise((r) => setTimeout(r, 50));

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
    });

    it('should render stream delta in probe after SPA navigation (V2.2-002)', async () => {
        currentAdapterMock = grokAdapter();
        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-delta',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));

        currentAdapterMock.extractConversationId = () => 'grok-delta-conv';
        (window as any).location.href = 'https://grok.com/c/grok-delta-conv?rid=rid-1';
        window.dispatchEvent(new (window as any).Event('popstate'));
        await new Promise((r) => setTimeout(r, 50));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Grok',
                source: 'network',
                attemptId: 'attempt:grok-delta',
                conversationId: 'grok-delta-conv',
                text: 'grok-thinking-reasoning-text',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
        expect(document.getElementById('blackiya-stream-probe')?.textContent).toContain('grok-thinking-reasoning-text');
    });

    it('should reset lifecycle to idle when navigating between distinct existing Grok conversations (V2.2-003)', async () => {
        currentAdapterMock = { ...grokAdapter(), extractConversationId: () => 'grok-old-conv' };
        delete (window as any).location;
        (window as any).location = { href: 'https://grok.com/c/grok-old-conv', origin: 'https://grok.com' };

        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-cross',
                phase: 'streaming',
                conversationId: 'grok-old-conv',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');

        currentAdapterMock.extractConversationId = () => 'grok-other-conv';
        (window as any).location.href = 'https://grok.com/c/grok-other-conv';
        window.dispatchEvent(new (window as any).Event('popstate'));
        await new Promise((r) => setTimeout(r, 650));

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Idle');
    });

    it('should not emit ATTEMPT_DISPOSED for active attempt during null-to-new SPA navigation (V2.2-004)', async () => {
        currentAdapterMock = grokAdapter();
        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-nodispose',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));

        const postedMessages: any[] = [];
        const origPost = window.postMessage.bind(window);
        (window as any).postMessage = (payload: any, target: string) => {
            postedMessages.push(payload);
            return origPost(payload, target);
        };

        try {
            currentAdapterMock.extractConversationId = () => 'grok-nodispose-conv';
            (window as any).location.href = 'https://grok.com/c/grok-nodispose-conv?rid=rid-1';
            window.dispatchEvent(new (window as any).Event('popstate'));
            await new Promise((r) => setTimeout(r, 50));
        } finally {
            (window as any).postMessage = origPost;
        }

        expect(
            postedMessages.filter((p) => p?.type === 'BLACKIYA_ATTEMPT_DISPOSED').map((p) => p.attemptId),
        ).not.toContain('attempt:grok-nodispose');
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
    });

    it('should not clobber active Grok lifecycle when refreshButtonState fires with null conversation (V2.2-005)', async () => {
        currentAdapterMock = grokAdapter();
        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-hc',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');

        window.dispatchEvent(new (window as any).Event('popstate'));
        await new Promise((r) => setTimeout(r, 50));

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
    });

    it('should not clobber active Grok lifecycle when injectSaveButton retries fire (V2.2-006)', async () => {
        currentAdapterMock = grokAdapter();
        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-inject',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Prompt Sent');

        // First retry fires at 1000ms — wait past it
        await new Promise((r) => setTimeout(r, 1100));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Prompt Sent');
    });

    it('should promote Grok to completed when canonical-ready capture arrives on new attempt after disposal', async () => {
        currentAdapterMock = {
            ...grokAdapter(),
            extractConversationId: () => 'grok-disposed-conv',
            parseInterceptedData: (raw: string) => {
                try {
                    const p = JSON.parse(raw);
                    return p?.conversation_id ? p : null;
                } catch {
                    return null;
                }
            },
        };
        delete (window as any).location;
        (window as any).location = { href: 'https://grok.com/c/grok-disposed-conv', origin: 'https://grok.com' };

        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-old',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-old',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));

        postStampedMessage(
            { type: 'BLACKIYA_ATTEMPT_DISPOSED', attemptId: 'attempt:grok-old', reason: 'navigation' },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Grok',
                url: 'https://grok.com/rest/app-chat/conversations/new',
                data: JSON.stringify(
                    buildConversation('grok-disposed-conv', 'Grok final answer', {
                        status: 'finished_successfully',
                        endTurn: true,
                    }),
                ),
                attemptId: 'attempt:grok-new',
            },
            window.location.origin,
        );

        await new Promise((r) => setTimeout(r, 120));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');
    });

    it('should promote lifecycle to completed when canonical-ready capture arrives from /conversations/new', async () => {
        currentAdapterMock = {
            ...grokAdapter(),
            extractConversationId: () => 'grok-conv-1',
            parseInterceptedData: (raw: string) => {
                try {
                    const p = JSON.parse(raw);
                    return p?.conversation_id ? p : null;
                } catch {
                    return null;
                }
            },
        };
        delete (window as any).location;
        (window as any).location = { href: 'https://grok.com/c/grok-conv-1', origin: 'https://grok.com' };

        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-canonical',
                phase: 'prompt-sent',
                conversationId: 'grok-conv-1',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-canonical',
                phase: 'streaming',
                conversationId: 'grok-conv-1',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Grok',
                url: 'https://grok.com/rest/app-chat/conversations/new',
                data: JSON.stringify(
                    buildConversation('grok-conv-1', 'Grok final answer', {
                        status: 'finished_successfully',
                        endTurn: true,
                    }),
                ),
                attemptId: 'attempt:grok-canonical',
            },
            window.location.origin,
        );

        await new Promise((r) => setTimeout(r, 120));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');
    });
});
