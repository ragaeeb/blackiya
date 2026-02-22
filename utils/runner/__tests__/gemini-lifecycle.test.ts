/**
 * Tests: Gemini-specific lifecycle behaviours.
 *
 * Covers:
 *  - Pending lifecycle replayed once conversationId resolves mid-stream
 *  - Save disabled while streaming even after canonical samples arrive pre-completion
 *  - RESPONSE_FINISHED accepted during streaming even when DOM has generating markers
 *  - Save disabled on no-conversation Gemini route despite finished hints
 *  - Stale conversation ID not reused on Gemini /app health checks
 *  - Identical canonical_ready readiness logs de-duplicated across periodic health checks
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { STORAGE_KEYS } from '@/utils/settings';

const window = new Window();
(window as any).SyntaxError = SyntaxError;
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
    parseInterceptedDataMock,
    waitFor,
} from './helpers';

let currentAdapterMock: any = createMockAdapter(document);
const logCalls = createLoggerCalls();
const browserMockState = {
    storageData: {} as Record<string, unknown>,
    sendMessage: async (_: unknown) => undefined as unknown,
};

mock.module('@/platforms/factory', () => ({
    getPlatformAdapter: () => currentAdapterMock,
    getPlatformAdapterByApiUrl: () => currentAdapterMock,
}));
mock.module('@/utils/download', () => ({ downloadAsJSON: () => {} }));
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));
mock.module('wxt/browser', () => buildBrowserMock(browserMockState));

import { getSessionToken } from '@/utils/protocol/session-token';
import { runPlatform } from '@/utils/runner/platform-runtime';

const postStampedMessage = makePostStampedMessage(window as any, getSessionToken);
const waitForRunnerReady = () => waitFor(() => !!document.getElementById('blackiya-save-btn'));

const geminiAdapter = () => ({
    ...createMockAdapter(document),
    name: 'Gemini',
    extractConversationId: () => null,
    evaluateReadiness: evaluateReadinessMock,
});

const GEMINI_STREAM_URL =
    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';

describe('Platform Runner – Gemini lifecycle', () => {
    beforeEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
        document.body.innerHTML = '';
        currentAdapterMock = createMockAdapter(document);
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;
        browserMockState.storageData = { [STORAGE_KEYS.STREAM_PROBE_VISIBLE]: true };
        browserMockState.sendMessage = async () => undefined;
        delete (window as any).location;
        (window as any).location = { href: 'https://gemini.google.com/app', origin: 'https://gemini.google.com' };
        (global as any).alert = () => {};
        (global as any).confirm = () => true;
        window.localStorage.clear();
        (globalThis as any).__BLACKIYA_CAPTURE_QUEUE__ = [];
        (globalThis as any).__BLACKIYA_LOG_QUEUE__ = [];
        delete (window as any).__BLACKIYA_TEST_HEALTH_CHECK_INTERVAL_MS;
    });

    afterEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
    });

    it('should replay pending lifecycle once conversationId resolves mid-stream', async () => {
        currentAdapterMock = geminiAdapter();
        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-late',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-late',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));

        postStampedMessage(
            {
                type: 'BLACKIYA_CONVERSATION_ID_RESOLVED',
                platform: 'Gemini',
                attemptId: 'attempt:gem-late',
                conversationId: 'gem-late-1',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 50));

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();
    });

    it('should keep Gemini Save disabled while streaming even after canonical samples arrive pre-completion', async () => {
        currentAdapterMock = {
            ...geminiAdapter(),
            parseInterceptedData: parseInterceptedDataMock,
        };
        runPlatform();
        await waitForRunnerReady();

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-guard',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-guard',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_CONVERSATION_ID_RESOLVED',
                platform: 'Gemini',
                attemptId: 'attempt:gem-guard',
                conversationId: 'gem-late-2',
            },
            window.location.origin,
        );
        await waitFor(
            () =>
                document.getElementById('blackiya-lifecycle-badge')?.textContent?.includes('Streaming') === true &&
                ((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled ?? true),
        );

        const canonical = buildConversation('gem-late-2', 'Assistant final answer', {
            status: 'finished_successfully',
            endTurn: true,
        });
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: GEMINI_STREAM_URL,
                data: JSON.stringify(canonical),
                attemptId: 'attempt:gem-guard',
            },
            window.location.origin,
        );
        const stabilizationWaitStartedAt = Date.now();
        await waitFor(
            () =>
                logCalls.info.some((entry) => entry.message === 'Stabilization retry tick') ||
                Date.now() - stabilizationWaitStartedAt >= 1200,
            { timeout: 3000, interval: 20 },
        );
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: GEMINI_STREAM_URL,
                data: JSON.stringify(canonical),
                attemptId: 'attempt:gem-guard',
            },
            window.location.origin,
        );
        await waitFor(
            () =>
                document.getElementById('blackiya-lifecycle-badge')?.textContent?.includes('Streaming') === true &&
                ((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled ?? true),
        );

        // Still streaming — Save must stay disabled
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'Gemini',
                attemptId: 'attempt:gem-guard',
                conversationId: 'gem-late-2',
            },
            window.location.origin,
        );
        await waitFor(
            () =>
                document.getElementById('blackiya-lifecycle-badge')?.textContent?.includes('Completed') === true &&
                (document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled === false,
        );

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeFalse();
    }, 10_000);

    it('should accept Gemini RESPONSE_FINISHED during streaming even if DOM has generating markers', async () => {
        currentAdapterMock = { ...geminiAdapter(), extractConversationId: () => 'gem-finish-1' };
        delete (window as any).location;
        (window as any).location = {
            href: 'https://gemini.google.com/app/gem-finish-1',
            origin: 'https://gemini.google.com',
        };

        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-finish',
                phase: 'streaming',
                conversationId: 'gem-finish-1',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');

        const marker = document.createElement('div');
        marker.className = 'still-generating streaming-marker';
        document.body.appendChild(marker);

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'Gemini',
                attemptId: 'attempt:gem-finish',
                conversationId: 'gem-finish-1',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 80));

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');
    });

    it('should keep Save disabled on no-conversation Gemini route despite finished hints', async () => {
        currentAdapterMock = { ...geminiAdapter() };
        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'Gemini',
                attemptId: 'attempt:gem-null',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Idle');
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();
        const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelText.includes('stream-done: no api url candidates')).toBeFalse();
    });

    it('should not reuse stale conversation ID on Gemini /app health checks', async () => {
        currentAdapterMock = { ...geminiAdapter(), extractConversationId: () => 'gem-conv-1' };
        delete (window as any).location;
        (window as any).location = {
            href: 'https://gemini.google.com/app/gem-conv-1',
            origin: 'https://gemini.google.com',
        };

        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-hc',
                phase: 'completed',
                conversationId: 'gem-conv-1',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'Gemini',
                attemptId: 'attempt:gem-hc',
                conversationId: 'gem-conv-1',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 40));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');

        // Navigate away: adapter now returns null
        currentAdapterMock.extractConversationId = () => null;
        delete (window as any).location;
        (window as any).location = { href: 'https://gemini.google.com/app', origin: 'https://gemini.google.com' };

        await new Promise((r) => setTimeout(r, 1900));

        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Idle');
    });

    it('should not spam identical canonical_ready readiness logs during periodic health checks', async () => {
        (window as any).__BLACKIYA_TEST_HEALTH_CHECK_INTERVAL_MS = 120;
        currentAdapterMock = {
            ...geminiAdapter(),
            extractConversationId: () => 'gem-ready-log',
            parseInterceptedData: parseInterceptedDataMock,
        };
        delete (window as any).location;
        (window as any).location = {
            href: 'https://gemini.google.com/app/gem-ready-log',
            origin: 'https://gemini.google.com',
        };

        runPlatform();
        await new Promise((r) => setTimeout(r, 120));

        const readyConv = buildConversation('gem-ready-log', 'Assistant output', {
            status: 'finished_successfully',
            endTurn: true,
        });

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-log',
                phase: 'completed',
                conversationId: 'gem-ready-log',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: GEMINI_STREAM_URL,
                data: JSON.stringify(readyConv),
                attemptId: 'attempt:gem-log',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 1200));
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: GEMINI_STREAM_URL,
                data: JSON.stringify(readyConv),
                attemptId: 'attempt:gem-log',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 200));

        const countBefore = logCalls.debug.filter(
            (e) =>
                e.message === 'Readiness decision: canonical_ready' &&
                (e.args[0] as any)?.conversationId === 'gem-ready-log',
        ).length;
        expect(countBefore).toBeGreaterThan(0);

        await new Promise((r) => setTimeout(r, 420));

        const countAfter = logCalls.debug.filter(
            (e) =>
                e.message === 'Readiness decision: canonical_ready' &&
                (e.args[0] as any)?.conversationId === 'gem-ready-log',
        ).length;
        expect(countAfter).toBe(countBefore);
    }, 12_000);
});
