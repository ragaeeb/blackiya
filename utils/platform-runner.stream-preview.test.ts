import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { STORAGE_KEYS } from '@/utils/settings';

// Configure Happy DOM
const window = new Window();
const document = window.document;
(global as any).window = window;
(global as any).document = document;
(global as any).history = window.history;
(global as any).HTMLElement = window.HTMLElement;
(global as any).HTMLButtonElement = window.HTMLButtonElement;
(global as any).MutationObserver = window.MutationObserver;

// Mock dependencies
const createMockAdapter = () => ({
    name: 'TestPlatform',
    extractConversationId: () => '123',
    getButtonInjectionTarget: () => document.body,
    formatFilename: () => 'test.json',
    parseInterceptedData: () => ({ conversation_id: '123' }),
});

const evaluateReadinessMock = (data: any) => {
    const assistants = Object.values(data?.mapping ?? {})
        .map((node: any) => node?.message)
        .filter((message: any) => message?.author?.role === 'assistant');
    const latestAssistant = assistants[assistants.length - 1] as any;
    const text = (latestAssistant?.content?.parts ?? []).join('').trim();
    const terminal = latestAssistant?.status !== 'in_progress' && latestAssistant?.end_turn === true;
    return {
        ready: terminal && text.length > 0,
        terminal,
        reason: terminal ? 'terminal' : 'in-progress',
        contentHash: text.length > 0 ? `h:${text.length}:${terminal ? 1 : 0}` : null,
        latestAssistantTextLength: text.length,
    };
};

// We need a mutable reference to control the mock return value
let currentAdapterMock: any = createMockAdapter();
let storageDataMock: Record<string, unknown> = {};
let runtimeSendMessageMock: (message: unknown) => Promise<unknown> = async () => undefined;

// Mock the factory module
mock.module('@/platforms/factory', () => ({
    getPlatformAdapter: () => currentAdapterMock,
    getPlatformAdapterByApiUrl: () => currentAdapterMock,
}));

const downloadCalls: Array<{ data: unknown; filename: string }> = [];
mock.module('@/utils/download', () => ({
    downloadAsJSON: (data: unknown, filename: string) => {
        downloadCalls.push({ data, filename });
    },
}));

const loggerDebugCalls: Array<{ message: unknown; args: unknown[] }> = [];
const loggerInfoCalls: Array<{ message: unknown; args: unknown[] }> = [];
const loggerWarnCalls: Array<{ message: unknown; args: unknown[] }> = [];
const loggerErrorCalls: Array<{ message: unknown; args: unknown[] }> = [];

mock.module('@/utils/logger', () => ({
    logger: {
        debug: (message: unknown, ...args: unknown[]) => {
            loggerDebugCalls.push({ message, args });
        },
        info: (message: unknown, ...args: unknown[]) => {
            loggerInfoCalls.push({ message, args });
        },
        warn: (message: unknown, ...args: unknown[]) => {
            loggerWarnCalls.push({ message, args });
        },
        error: (message: unknown, ...args: unknown[]) => {
            loggerErrorCalls.push({ message, args });
        },
    },
}));

// Mock wxt/browser explicitly for this test file to prevent logger errors
const browserMock = {
    storage: {
        onChanged: {
            addListener: () => {},
            removeListener: () => {},
        },
        local: {
            get: async () => storageDataMock,
            set: async () => {},
        },
    },
    runtime: {
        getURL: () => 'chrome-extension://mock/',
        sendMessage: async (message: unknown) => runtimeSendMessageMock(message),
    },
};
mock.module('wxt/browser', () => ({
    browser: browserMock,
}));

import { getSessionToken } from '@/utils/protocol/session-token';
// Import subject under test AFTER mocking
import { runPlatform } from './platform-runner';

/** Stamps the session token onto a test message before posting via window.postMessage */
const postStampedMessage = (data: Record<string, unknown>, origin: string) => {
    const token = getSessionToken();
    window.postMessage(token ? { ...data, __blackiyaToken: token } : data, origin);
};

describe('Platform Runner', () => {
    beforeEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
        // Reset DOM
        document.body.innerHTML = '';
        currentAdapterMock = createMockAdapter();
        storageDataMock = {
            [STORAGE_KEYS.STREAM_PROBE_VISIBLE]: true,
        };
        runtimeSendMessageMock = async () => undefined;
        downloadCalls.length = 0;
        loggerDebugCalls.length = 0;
        loggerInfoCalls.length = 0;
        loggerWarnCalls.length = 0;
        loggerErrorCalls.length = 0;

        // Mock window.location properties
        const locationMock = {
            href: 'https://test.com/c/123',
            origin: 'https://test.com',
        };

        delete (window as any).location;
        (window as any).location = locationMock;
        (global as any).alert = () => {};
        (global as any).confirm = () => true;
        window.localStorage.clear();
        (globalThis as any).__BLACKIYA_CAPTURE_QUEUE__ = [];
        (window as any).__BLACKIYA_CAPTURE_QUEUE__ = [];
        (globalThis as any).__BLACKIYA_LOG_QUEUE__ = [];
        (window as any).__BLACKIYA_LOG_QUEUE__ = [];
    });

    afterEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
    });

    it('should append live stream delta text to stream probe panel', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:test-2',
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
                attemptId: 'attempt:test-2',
                conversationId: '123',
                text: 'world',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const panel = document.getElementById('blackiya-stream-probe');
        expect(panel).not.toBeNull();
        expect(panel?.textContent).toContain('stream: live mirror');
        expect(panel?.textContent).toContain('Hello world');
    });

    it('should append live stream delta text from non-ChatGPT platforms', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Gemini',
                attemptId: 'attempt:test-gemini-delta',
                conversationId: '123',
                text: 'Gemini response chunk',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const panel = document.getElementById('blackiya-stream-probe');
        expect(panel).not.toBeNull();
        expect(panel?.textContent).toContain('stream: live mirror');
        expect(panel?.textContent).toContain('Gemini response chunk');
    });

    it('should normalize existing stream probe panel styles to keep scrolling enabled', async () => {
        const stalePanel = document.createElement('div');
        stalePanel.id = 'blackiya-stream-probe';
        stalePanel.style.pointerEvents = 'none';
        stalePanel.style.overflow = 'auto';
        stalePanel.style.maxHeight = '42vh';
        stalePanel.textContent = 'legacy panel';
        document.body.appendChild(stalePanel);

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:test-panel-scroll-fix',
                conversationId: '123',
                text: 'scroll check',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const panel = document.getElementById('blackiya-stream-probe') as HTMLDivElement | null;
        expect(panel).not.toBeNull();
        expect(panel?.style.pointerEvents).toBe('auto');
        expect(panel?.style.overflow).toBe('auto');
    });

    it('should dock stream probe panel to top-left on Gemini surfaces', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Gemini',
            extractConversationId: () => 'abc123',
        };
        delete (window as any).location;
        (window as any).location = {
            href: 'https://gemini.google.com/app/abc123',
            origin: 'https://gemini.google.com',
            hostname: 'gemini.google.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Gemini',
                attemptId: 'attempt:test-gemini-dock-right',
                conversationId: 'abc123',
                text: 'dock check',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const panel = document.getElementById('blackiya-stream-probe') as HTMLDivElement | null;
        expect(panel).not.toBeNull();
        expect(panel?.style.left).toBe('16px');
        expect(panel?.style.right).toBe('auto');
        expect(panel?.style.top).toBe('16px');
        expect(panel?.style.bottom).toBe('auto');
    });

    it('should surface Grok stream delta when conversation ID is unresolved', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Grok',
            extractConversationId: () => null,
            evaluateReadiness: evaluateReadinessMock,
        };
        delete (window as any).location;
        (window as any).location = {
            href: 'https://grok.com/',
            origin: 'https://grok.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Grok',
                attemptId: 'attempt:grok-pending-delta-1',
                text: '[Thinking] Agents thinking chunk',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 40));

        const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelText).toContain('stream: awaiting conversation id');
        expect(panelText).toContain('Agents thinking chunk');
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
    });

    it('should preserve unresolved Grok stream delta after conversation resolves', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Grok',
            extractConversationId: () => null,
            evaluateReadiness: evaluateReadinessMock,
        };
        delete (window as any).location;
        (window as any).location = {
            href: 'https://grok.com/',
            origin: 'https://grok.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Grok',
                attemptId: 'attempt:grok-pending-delta-2',
                text: '[Thinking] first chunk',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        postStampedMessage(
            {
                type: 'BLACKIYA_CONVERSATION_ID_RESOLVED',
                platform: 'Grok',
                attemptId: 'attempt:grok-pending-delta-2',
                conversationId: 'grok-conv-pending-2',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Grok',
                attemptId: 'attempt:grok-pending-delta-2',
                text: 'second chunk',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 40));

        const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelText).toContain('first chunk');
        expect(panelText).toContain('second chunk');
    });

    it('should preserve explicit trailing spaces across Grok delta joins', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Grok',
                attemptId: 'attempt:grok-space-join',
                conversationId: '123',
                text: 'Word ',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Grok',
                attemptId: 'attempt:grok-space-join',
                conversationId: '123',
                text: 'continuation',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelText).toContain('Word continuation');
        expect(panelText.includes('Wordcontinuation')).toBeFalse();
    });

    it('should preserve word boundaries when concatenating stream deltas', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:test-spacing',
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
                attemptId: 'attempt:test-spacing',
                conversationId: '123',
                text: 'Prove',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelText).toContain('How Do Scholars Prove');
    });

    it('should not inject artificial spaces inside lowercase word continuations', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:test-word-join-lower',
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
                attemptId: 'attempt:test-word-join-lower',
                conversationId: '123',
                text: 'es Are Actually Helpful',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelText).toContain('When Glasses Are Actually Helpful');
        expect(panelText.includes('When Glass es')).toBeFalse();
    });

    it('should not split single-letter prefix plus lowercase continuation', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:test-single-prefix',
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
                attemptId: 'attempt:test-single-prefix',
                conversationId: '123',
                text: 'earing the correct prescription:',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelText).toContain('Wearing the correct prescription:');
        expect(panelText.includes('W earing')).toBeFalse();
    });

    it('should default to SFE readiness source', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        const container = document.getElementById('blackiya-button-container');
        expect(container?.getAttribute('data-readiness-source')).toBe('sfe');
    });
});
