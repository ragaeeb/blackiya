/**
 * Tests: BLACKIYA_STREAM_DELTA handling and probe panel rendering.
 *
 * Covers:
 *  - Delta text appended to probe panel (ChatGPT and non-ChatGPT platforms)
 *  - Panel style normalisation (pointerEvents, overflow) for existing stale panels
 *  - Panel docked to top-left on Gemini surfaces
 *  - Grok deltas with unresolved conversationId show "awaiting conversation id" header
 *  - Pending Grok deltas preserved after conversationId resolves
 *  - Word-boundary / space-joining logic between consecutive deltas
 *  - Preserved live-mirror snapshot shown after probe enters stream-done state
 *  - SFE readiness-source attribute defaults to "sfe"
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

describe('Platform Runner – stream preview', () => {
    beforeEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
        document.body.innerHTML = '';
        currentAdapterMock = createMockAdapter(document);
        browserMockState.storageData = { [STORAGE_KEYS.STREAM_PROBE_VISIBLE]: true };
        browserMockState.sendMessage = async () => undefined;
        delete (window as any).location;
        (window as any).location = { href: 'https://test.com/c/123', origin: 'https://test.com' };
        (global as any).alert = () => {};
        (global as any).confirm = () => true;
        window.localStorage.clear();
        (globalThis as any).__BLACKIYA_CAPTURE_QUEUE__ = [];
        (globalThis as any).__BLACKIYA_LOG_QUEUE__ = [];
    });

    afterEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
    });

    it('should append live stream delta text to stream probe panel', async () => {
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:a',
                conversationId: '123',
                text: 'Hello ',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:a',
                conversationId: '123',
                text: 'world',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));

        const panel = document.getElementById('blackiya-stream-probe');
        expect(panel).not.toBeNull();
        expect(panel?.textContent).toContain('stream: live mirror');
        expect(panel?.textContent).toContain('Hello world');
    });

    it('should append live stream delta text from non-ChatGPT platforms', async () => {
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Gemini',
                attemptId: 'attempt:gem',
                conversationId: '123',
                text: 'Gemini response chunk',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));

        const panel = document.getElementById('blackiya-stream-probe');
        expect(panel?.textContent).toContain('stream: live mirror');
        expect(panel?.textContent).toContain('Gemini response chunk');
    });

    it('should normalise existing stale probe panel styles to keep scrolling enabled', async () => {
        const stalePanel = document.createElement('div');
        stalePanel.id = 'blackiya-stream-probe';
        stalePanel.style.pointerEvents = 'none';
        stalePanel.style.overflow = 'auto';
        stalePanel.style.maxHeight = '42vh';
        stalePanel.textContent = 'legacy panel';
        document.body.appendChild(stalePanel);

        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:scroll',
                conversationId: '123',
                text: 'scroll check',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));

        const panel = document.getElementById('blackiya-stream-probe') as HTMLDivElement | null;
        expect(panel?.style.pointerEvents).toBe('auto');
        expect(panel?.style.overflow).toBe('auto');
    });

    it('should dock stream probe panel to top-left on Gemini surfaces', async () => {
        currentAdapterMock = { ...createMockAdapter(document), name: 'Gemini', extractConversationId: () => 'abc123' };
        delete (window as any).location;
        (window as any).location = {
            href: 'https://gemini.google.com/app/abc123',
            origin: 'https://gemini.google.com',
            hostname: 'gemini.google.com',
        };

        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Gemini',
                attemptId: 'attempt:dock',
                conversationId: 'abc123',
                text: 'dock check',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));

        const panel = document.getElementById('blackiya-stream-probe') as HTMLDivElement | null;
        expect(panel?.style.left).toBe('16px');
        expect(panel?.style.right).toBe('auto');
        expect(panel?.style.top).toBe('16px');
        expect(panel?.style.bottom).toBe('auto');
    });

    it('should surface Grok stream delta when conversationId is unresolved', async () => {
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'Grok',
            extractConversationId: () => null,
            evaluateReadiness: evaluateReadinessMock,
        };
        delete (window as any).location;
        (window as any).location = { href: 'https://grok.com/', origin: 'https://grok.com' };

        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Grok',
                attemptId: 'attempt:grok-pending',
                text: '[Thinking] Agents thinking chunk',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 40));

        const text = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(text).toContain('stream: awaiting conversation id');
        expect(text).toContain('Agents thinking chunk');
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
    });

    it('should preserve unresolved Grok delta text after conversationId resolves', async () => {
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'Grok',
            extractConversationId: () => null,
            evaluateReadiness: evaluateReadinessMock,
        };
        delete (window as any).location;
        (window as any).location = { href: 'https://grok.com/', origin: 'https://grok.com' };

        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Grok',
                attemptId: 'attempt:grok-2',
                text: '[Thinking] first chunk',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));

        postStampedMessage(
            {
                type: 'BLACKIYA_CONVERSATION_ID_RESOLVED',
                platform: 'Grok',
                attemptId: 'attempt:grok-2',
                conversationId: 'grok-conv-2',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));

        postStampedMessage(
            { type: 'BLACKIYA_STREAM_DELTA', platform: 'Grok', attemptId: 'attempt:grok-2', text: 'second chunk' },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 40));

        const text = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(text).toContain('first chunk');
        expect(text).toContain('second chunk');
    });

    it('should preserve explicit trailing spaces across Grok delta joins', async () => {
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));
        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Grok',
                attemptId: 'attempt:space',
                conversationId: '123',
                text: 'Word ',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Grok',
                attemptId: 'attempt:space',
                conversationId: '123',
                text: 'continuation',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));
        const text = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(text).toContain('Word continuation');
        expect(text.includes('Wordcontinuation')).toBeFalse();
    });

    it('should preserve word boundaries when concatenating stream deltas', async () => {
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));
        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:spacing',
                conversationId: '123',
                text: 'How Do Scholars',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:spacing',
                conversationId: '123',
                text: 'Prove',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));
        expect(document.getElementById('blackiya-stream-probe')?.textContent).toContain('How Do Scholars Prove');
    });

    it('should not inject artificial spaces inside lowercase word continuations', async () => {
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));
        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:lower',
                conversationId: '123',
                text: 'When Glass',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:lower',
                conversationId: '123',
                text: 'es Are Actually Helpful',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));
        const text = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(text).toContain('When Glasses Are Actually Helpful');
        expect(text.includes('When Glass es')).toBeFalse();
    });

    it('should not split single-letter prefix plus lowercase continuation', async () => {
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));
        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:prefix',
                conversationId: '123',
                text: 'W',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:prefix',
                conversationId: '123',
                text: 'earing the correct prescription:',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));
        const text = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(text).toContain('Wearing the correct prescription:');
        expect(text.includes('W earing')).toBeFalse();
    });

    it('should preserve pre-final live mirror snapshot when probe switches to stream-done state', async () => {
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:preserve',
                conversationId: '123',
                text: 'Live chunk one. ',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:preserve',
                conversationId: '123',
                text: 'Live chunk two.',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));

        expect(document.getElementById('blackiya-stream-probe')?.textContent).toContain(
            'Live chunk one. Live chunk two.',
        );

        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            buildApiUrls: () => ['https://test.com/backend-api/conversation/123'],
            parseInterceptedData: () => null,
        };

        const snapshotFailHandler = (event: MessageEvent) => {
            const msg = (event as any).data;
            if (msg?.type !== 'BLACKIYA_PAGE_SNAPSHOT_REQUEST') {
                return;
            }
            postStampedMessage(
                {
                    type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE',
                    requestId: msg.requestId,
                    success: false,
                    error: 'NOT_FOUND',
                },
                window.location.origin,
            );
        };
        window.addEventListener('message', snapshotFailHandler as any);
        try {
            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:preserve',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((r) => setTimeout(r, 80));
        } finally {
            window.removeEventListener('message', snapshotFailHandler as any);
        }

        const text = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(
            text.includes('stream-done: no api url candidates') ||
                text.includes('stream-done: awaiting canonical capture'),
        ).toBeTrue();
        expect(text).toContain('Preserved live mirror snapshot (pre-final)');
        expect(text).toContain('Live chunk one. Live chunk two.');
    });

    it('should default to SFE readiness source', async () => {
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));
        expect(document.getElementById('blackiya-button-container')?.getAttribute('data-readiness-source')).toBe('sfe');
    });
});
