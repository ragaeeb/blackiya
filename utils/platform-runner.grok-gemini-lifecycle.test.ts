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

const buildConversation = (
    conversationId: string,
    assistantText: string,
    options: { status: string; endTurn: boolean },
) => ({
    title: 'Test Conversation',
    create_time: 1_700_000_000,
    update_time: 1_700_000_120,
    conversation_id: conversationId,
    current_node: 'a1',
    moderation_results: [],
    plugin_ids: null,
    gizmo_id: null,
    gizmo_type: null,
    is_archived: false,
    default_model_slug: 'gpt',
    safe_urls: [],
    blocked_urls: [],
    mapping: {
        root: { id: 'root', message: null, parent: null, children: ['u1'] },
        u1: {
            id: 'u1',
            parent: 'root',
            children: ['a1'],
            message: {
                id: 'u1',
                author: { role: 'user', name: null, metadata: {} },
                create_time: 1_700_000_010,
                update_time: 1_700_000_010,
                content: { content_type: 'text', parts: ['Prompt'] },
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        },
        a1: {
            id: 'a1',
            parent: 'u1',
            children: [],
            message: {
                id: 'a1',
                author: { role: 'assistant', name: null, metadata: {} },
                create_time: 1_700_000_020,
                update_time: 1_700_000_020,
                content: { content_type: 'text', parts: [assistantText] },
                status: options.status,
                end_turn: options.endTurn,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        },
    },
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

    it('should update lifecycle badge for pending signals with null conversationId (Grok regression)', async () => {
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

        // Emit lifecycle with null conversationId (Grok pattern for /conversations/new)
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-pending-1',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Prompt Sent');

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-pending-1',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
    });

    it('should preserve lifecycle state when Grok SPA navigates from null to new conversation (V2.2-001)', async () => {
        // Start with null conversationId (Grok home or pre-navigation state)
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

        // Step 1: Lifecycle signals arrive with null conversationId
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
        await new Promise((resolve) => setTimeout(resolve, 20));

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
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');

        // Step 2: Grok SPA navigates to /c/<convId> — this triggers handleConversationSwitch
        currentAdapterMock.extractConversationId = () => 'grok-nav-conv-1';
        (window as any).location.href = 'https://grok.com/c/grok-nav-conv-1?rid=some-response-id';
        window.dispatchEvent(new (window as any).Event('popstate'));
        await new Promise((resolve) => setTimeout(resolve, 50));

        // The lifecycle badge should STILL show "Streaming" — not be reset to "Idle"
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
    });

    it('should render stream delta text in probe during Grok streaming after SPA navigation (V2.2-002)', async () => {
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

        // Step 1: Lifecycle signals arrive with null conversationId
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-delta-1',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Step 2: SPA navigation to conversation
        currentAdapterMock.extractConversationId = () => 'grok-delta-conv';
        (window as any).location.href = 'https://grok.com/c/grok-delta-conv?rid=rid-1';
        window.dispatchEvent(new (window as any).Event('popstate'));
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Step 3: Stream delta arrives AFTER navigation
        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'Grok',
                source: 'network',
                attemptId: 'attempt:grok-delta-1',
                conversationId: 'grok-delta-conv',
                text: 'grok-thinking-reasoning-text',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        // Lifecycle should still be streaming
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
        // Stream probe MUST contain the actual delta text (not just badge state)
        const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelText).toContain('grok-thinking-reasoning-text');
    });

    it('should reset lifecycle to idle when navigating to a different existing Grok conversation (V2.2-003)', async () => {
        // Start on an existing Grok conversation that has already completed
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Grok',
            extractConversationId: () => 'grok-old-conv',
            evaluateReadiness: evaluateReadinessMock,
        };
        delete (window as any).location;
        (window as any).location = {
            href: 'https://grok.com/c/grok-old-conv',
            origin: 'https://grok.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        // Step 1: Complete a lifecycle on the old conversation
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-cross-1',
                phase: 'streaming',
                conversationId: 'grok-old-conv',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');

        // Step 2: Navigate to a DIFFERENT conversation (not a null→new transition)
        currentAdapterMock.extractConversationId = () => 'grok-other-conv';
        (window as any).location.href = 'https://grok.com/c/grok-other-conv';
        window.dispatchEvent(new (window as any).Event('popstate'));
        // Wait for both the popstate handler and the 500ms setTimeout(injectSaveButton) to fire
        await new Promise((resolve) => setTimeout(resolve, 650));

        // When switching between existing conversations, lifecycle SHOULD reset to idle
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Idle');
    });

    it('should not emit BLACKIYA_ATTEMPT_DISPOSED for active attempt during Grok null-to-new SPA navigation (V2.2-004)', async () => {
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

        // Step 1: Lifecycle signals arrive with null conversationId
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-nodispose-1',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Step 2: Spy on postMessage to capture ATTEMPT_DISPOSED emissions
        const postedMessages: any[] = [];
        const originalPostMessage = window.postMessage.bind(window);
        (window as any).postMessage = (payload: any, targetOrigin: string) => {
            postedMessages.push(payload);
            return originalPostMessage(payload, targetOrigin);
        };

        try {
            // Step 3: SPA navigation to conversation (null → new)
            currentAdapterMock.extractConversationId = () => 'grok-nodispose-conv';
            (window as any).location.href = 'https://grok.com/c/grok-nodispose-conv?rid=rid-1';
            window.dispatchEvent(new (window as any).Event('popstate'));
            await new Promise((resolve) => setTimeout(resolve, 50));
        } finally {
            (window as any).postMessage = originalPostMessage;
        }

        // No ATTEMPT_DISPOSED should have been emitted for the active streaming attempt
        const disposals = postedMessages.filter((p) => p?.type === 'BLACKIYA_ATTEMPT_DISPOSED').map((p) => p.attemptId);
        expect(disposals).not.toContain('attempt:grok-nodispose-1');
        // Lifecycle should still be streaming
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
    });

    it('should not clobber active Grok lifecycle when refreshButtonState fires with null conversation (V2.2-005)', async () => {
        // Simulates the MutationObserver/health-check refreshButtonState path that
        // was the root cause of the first lifecycle reset at 16:59:31.356
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

        // Step 1: Lifecycle signals arrive with null conversationId
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-healthcheck-1',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');

        // Step 2: Simulate DOM mutation triggering handleNavigationChange with unchanged null ID
        // This triggers refreshButtonState(undefined) → resetButtonStateForNoConversation
        window.dispatchEvent(new (window as any).Event('popstate'));
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Lifecycle MUST remain streaming — the health-check must not reset it
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
    });

    it('should not clobber active Grok lifecycle when injectSaveButton retries with null conversation (V2.2-006)', async () => {
        // Simulates the injectSaveButton retry path (setTimeout at 1000/2000/5000ms)
        // that fires while lifecycle is active on a null-conversation Grok page
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

        // Step 1: Lifecycle signals arrive
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-inject-retry-1',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Prompt Sent');

        // Step 2: Wait past the first injectSaveButton retry at 1000ms
        await new Promise((resolve) => setTimeout(resolve, 1100));

        // Lifecycle MUST still be prompt-sent — the retry must not reset it
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Prompt Sent');
    });

    it('should promote Grok to completed when lifecycle attempt is disposed and canonical capture arrives on new attempt', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Grok',
            extractConversationId: () => 'grok-disposed-conv',
            evaluateReadiness: evaluateReadinessMock,
            parseInterceptedData: (raw: string) => {
                try {
                    const parsed = JSON.parse(raw);
                    return parsed?.conversation_id ? parsed : null;
                } catch {
                    return null;
                }
            },
        };
        delete (window as any).location;
        (window as any).location = {
            href: 'https://grok.com/c/grok-disposed-conv',
            origin: 'https://grok.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        // Step 1: Lifecycle signals arrive with null conversationId
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
        await new Promise((resolve) => setTimeout(resolve, 30));

        // Step 2: Attempt is disposed by navigation (Grok SPA URL change)
        postStampedMessage(
            {
                type: 'BLACKIYA_ATTEMPT_DISPOSED',
                attemptId: 'attempt:grok-old',
                reason: 'navigation',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        // Step 3: Late canonical capture arrives with a NEW attempt ID
        const canonicalConversation = buildConversation('grok-disposed-conv', 'Grok final answer', {
            status: 'finished_successfully',
            endTurn: true,
        });
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Grok',
                url: 'https://grok.com/rest/app-chat/conversations/new',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:grok-new',
            },
            window.location.origin,
        );

        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');
    });

    it('should keep save disabled on no-conversation Gemini route despite finished hints', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Gemini',
            extractConversationId: () => null,
        };
        delete (window as any).location;
        (window as any).location = {
            href: 'https://gemini.google.com/app',
            origin: 'https://gemini.google.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-finished-null',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Idle');
        expect(saveBtn?.disabled).toBeTrue();

        const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelText.includes('stream-done: no api url candidates')).toBeFalse();
    });

    it('should not reuse stale conversation id on Gemini /app health checks', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Gemini',
            extractConversationId: () => 'gem-conv-1',
        };

        delete (window as any).location;
        (window as any).location = {
            href: 'https://gemini.google.com/app/gem-conv-1',
            origin: 'https://gemini.google.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        // Put the lifecycle into a terminal state for the conversation route.
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-health',
                phase: 'completed',
                conversationId: 'gem-conv-1',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'Gemini',
                attemptId: 'attempt:gem-health',
                conversationId: 'gem-conv-1',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');

        // Route moved to /app (no conversation ID). Adapter now returns null.
        currentAdapterMock.extractConversationId = () => null;
        delete (window as any).location;
        (window as any).location = {
            href: 'https://gemini.google.com/app',
            origin: 'https://gemini.google.com',
        };

        // Wait past the health-check interval.
        await new Promise((resolve) => setTimeout(resolve, 1900));

        const saveAfter = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        const lifecycle = document.getElementById('blackiya-lifecycle-badge');
        expect(saveAfter?.disabled).toBeTrue();
        expect(lifecycle?.textContent).toContain('Idle');
    });

    it('should not spam identical canonical_ready readiness logs during periodic health checks', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Gemini',
            extractConversationId: () => 'gem-ready-log',
            evaluateReadiness: evaluateReadinessMock,
            parseInterceptedData: (raw: string) => {
                try {
                    const parsed = JSON.parse(raw);
                    return parsed?.conversation_id ? parsed : null;
                } catch {
                    return null;
                }
            },
        };
        delete (window as any).location;
        (window as any).location = {
            href: 'https://gemini.google.com/app/gem-ready-log',
            origin: 'https://gemini.google.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        const readyConversation = buildConversation('gem-ready-log', 'Assistant output', {
            status: 'finished_successfully',
            endTurn: true,
        });

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-ready-log',
                phase: 'completed',
                conversationId: 'gem-ready-log',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
                data: JSON.stringify(readyConversation),
                attemptId: 'attempt:gem-ready-log',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 1200));
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
                data: JSON.stringify(readyConversation),
                attemptId: 'attempt:gem-ready-log',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));

        const canonicalReadyLogsBeforeWait = loggerDebugCalls.filter(
            (entry) =>
                entry.message === 'Readiness decision: canonical_ready' &&
                (entry.args[0] as { conversationId?: string } | undefined)?.conversationId === 'gem-ready-log',
        ).length;
        expect(canonicalReadyLogsBeforeWait).toBeGreaterThan(0);

        await new Promise((resolve) => setTimeout(resolve, 3900));

        const canonicalReadyLogsAfterWait = loggerDebugCalls.filter(
            (entry) =>
                entry.message === 'Readiness decision: canonical_ready' &&
                (entry.args[0] as { conversationId?: string } | undefined)?.conversationId === 'gem-ready-log',
        ).length;

        expect(canonicalReadyLogsAfterWait).toBe(canonicalReadyLogsBeforeWait);
    }, 12_000);
});
