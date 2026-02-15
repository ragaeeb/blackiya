import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

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

// Mock the factory module
mock.module('@/platforms/factory', () => ({
    getPlatformAdapter: () => currentAdapterMock,
    getPlatformAdapterByApiUrl: () => currentAdapterMock,
}));

mock.module('@/utils/download', () => ({
    downloadAsJSON: () => {},
}));

mock.module('@/utils/logger', () => ({
    logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
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
        sendMessage: async () => {},
    },
};
mock.module('wxt/browser', () => ({
    browser: browserMock,
}));

// Import subject under test AFTER mocking
import { runPlatform } from './platform-runner';

describe('Platform Runner', () => {
    beforeEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
        // Reset DOM
        document.body.innerHTML = '';
        currentAdapterMock = createMockAdapter();
        storageDataMock = {};

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

    it('should show Captured calibration state on no-conversation route when profile exists', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Gemini',
            extractConversationId: () => null,
        };
        storageDataMock = {
            'userSettings.calibrationProfiles': {
                Gemini: {
                    schemaVersion: 2,
                    platform: 'Gemini',
                    strategy: 'aggressive',
                    disabledSources: ['snapshot_fallback'],
                    timingsMs: {
                        passiveWait: 900,
                        domQuietWindow: 500,
                        maxStabilizationWait: 12000,
                    },
                    retry: {
                        maxAttempts: 3,
                        backoffMs: [300, 800, 1300],
                        hardTimeoutMs: 12000,
                    },
                    updatedAt: '2026-02-14T00:00:00.000Z',
                    lastModifiedBy: 'manual',
                },
            },
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        const calibrateBtn = document.getElementById('blackiya-calibrate-btn');
        expect(calibrateBtn).not.toBeNull();
        expect(calibrateBtn?.textContent).toContain('Captured');
    });

    it('should keep Captured calibration state on conversation route when profile exists but no data yet', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Gemini',
            extractConversationId: () => 'gem-conv-1',
        };
        storageDataMock = {
            'userSettings.calibrationProfiles': {
                Gemini: {
                    schemaVersion: 2,
                    platform: 'Gemini',
                    strategy: 'aggressive',
                    disabledSources: ['snapshot_fallback'],
                    timingsMs: {
                        passiveWait: 900,
                        domQuietWindow: 500,
                        maxStabilizationWait: 12000,
                    },
                    retry: {
                        maxAttempts: 3,
                        backoffMs: [300, 800, 1300],
                        hardTimeoutMs: 12000,
                    },
                    updatedAt: '2026-02-14T00:00:00.000Z',
                    lastModifiedBy: 'manual',
                },
            },
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        const calibrateBtn = document.getElementById('blackiya-calibrate-btn');
        expect(calibrateBtn).not.toBeNull();
        expect(calibrateBtn?.textContent).toContain('Captured');
    });

    it('should show friendly calibration timestamp when profile updatedAt exists', async () => {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Gemini',
            extractConversationId: () => 'gem-conv-timestamp',
        };
        storageDataMock = {
            'userSettings.calibrationProfiles': {
                Gemini: {
                    schemaVersion: 2,
                    platform: 'Gemini',
                    strategy: 'aggressive',
                    disabledSources: ['snapshot_fallback'],
                    timingsMs: {
                        passiveWait: 900,
                        domQuietWindow: 500,
                        maxStabilizationWait: 12000,
                    },
                    retry: {
                        maxAttempts: 3,
                        backoffMs: [300, 800, 1300],
                        hardTimeoutMs: 12000,
                    },
                    updatedAt: fiveMinutesAgo,
                    lastModifiedBy: 'manual',
                },
            },
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        const calibrateBtn = document.getElementById('blackiya-calibrate-btn');
        expect(calibrateBtn).not.toBeNull();
        expect(calibrateBtn?.textContent).toContain('Captured');
        expect(calibrateBtn?.textContent).toContain('ago');
    });

    it('should inject button when valid adapter and ID found', async () => {
        runPlatform();

        // Wait for async injection logic
        await new Promise((resolve) => setTimeout(resolve, 100));

        const saveBtn = document.getElementById('blackiya-save-btn');
        const copyBtn = document.getElementById('blackiya-copy-btn');
        expect(saveBtn).not.toBeNull();
        expect(copyBtn).not.toBeNull();
        expect(saveBtn?.textContent).toContain('Save JSON');
    });

    it('should update lifecycle badge from network lifecycle messages', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        const idleBadge = document.getElementById('blackiya-lifecycle-badge');
        expect(idleBadge?.textContent).toContain('Idle');

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:test-1',
                phase: 'prompt-sent',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Prompt Sent');

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:test-1',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:test-1',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');
    });

    it('should append live stream delta text to stream probe panel', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        window.postMessage(
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
        window.postMessage(
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

    it('should preserve word boundaries when concatenating stream deltas', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        window.postMessage(
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
        window.postMessage(
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

        window.postMessage(
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
        window.postMessage(
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
        expect(panelText.includes('When Glass es')).toBe(false);
    });

    it('should not split single-letter prefix plus lowercase continuation', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        window.postMessage(
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
        window.postMessage(
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
        expect(panelText.includes('W earing')).toBe(false);
    });

    it('should default to SFE readiness source', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        const container = document.getElementById('blackiya-button-container');
        expect(container?.getAttribute('data-readiness-source')).toBe('sfe');
    });

    it('should keep SFE readiness source enabled', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        const container = document.getElementById('blackiya-button-container');
        expect(container?.getAttribute('data-readiness-source')).toBe('sfe');
    });

    it('should process typed lifecycle messages that include attemptId', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:test',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
    });

    it('should keep Save disabled while streaming even when cached data is ready', async () => {
        const readyConversation = buildConversation('123', 'Canonical ready answer', {
            status: 'finished_successfully',
            endTurn: true,
        });

        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'TestPlatform',
            evaluateReadiness: evaluateReadinessMock,
            parseInterceptedData: (raw: string) => {
                const parsed = JSON.parse(raw);
                return parsed?.conversation_id ? parsed : null;
            },
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        window.postMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'TestPlatform',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(readyConversation),
                attemptId: 'attempt:seed-ready',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
        await new Promise((resolve) => setTimeout(resolve, 950));
        window.postMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'TestPlatform',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(readyConversation),
                attemptId: 'attempt:seed-ready',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'TestPlatform',
                attemptId: 'attempt:seed-ready',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const saveBeforeStreaming = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveBeforeStreaming?.disabled).toBe(false);

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'TestPlatform',
                attemptId: 'attempt:stream-active',
                phase: 'prompt-sent',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'TestPlatform',
                attemptId: 'attempt:stream-active',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'TestPlatform',
                attemptId: 'attempt:stream-active',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const saveDuringStreaming = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveDuringStreaming?.disabled).toBe(true);
    });

    it('should not show parse-failure toast when stream probe cannot parse payload', async () => {
        const originalFetch = (globalThis as any).fetch;
        try {
            (globalThis as any).fetch = async () => ({
                ok: true,
                text: async () => '{"not":"conversation"}',
            });

            currentAdapterMock = {
                ...createMockAdapter(),
                name: 'ChatGPT',
                buildApiUrls: () => ['https://test.com/backend-api/conversation/123'],
                parseInterceptedData: () => null,
            };

            runPlatform();
            await new Promise((resolve) => setTimeout(resolve, 80));

            window.postMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:probe-fail',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 40));

            const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
            expect(panelText.includes('Could not parse conversation payload')).toBe(false);
        } finally {
            (globalThis as any).fetch = originalFetch;
        }
    });

    it('should skip stream probe when probe lease is held by another tab', async () => {
        const originalFetch = (globalThis as any).fetch;
        let fetchCalls = 0;
        try {
            (globalThis as any).fetch = async () => {
                fetchCalls += 1;
                return {
                    ok: true,
                    text: async () => '{}',
                };
            };

            const now = Date.now();
            window.localStorage.setItem(
                'blackiya:probe-lease:123',
                JSON.stringify({
                    attemptId: 'attempt:owner',
                    expiresAtMs: now + 10_000,
                    updatedAtMs: now,
                }),
            );

            storageDataMock = {
                'userSettings.sfe.probeLeaseEnabled': true,
            };

            currentAdapterMock = {
                ...createMockAdapter(),
                name: 'ChatGPT',
                buildApiUrls: () => ['https://test.com/backend-api/conversation/123'],
                parseInterceptedData: () => null,
            };

            runPlatform();
            await new Promise((resolve) => setTimeout(resolve, 80));

            window.postMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:lease-contender',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );

            await new Promise((resolve) => setTimeout(resolve, 40));
            const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
            expect(panelText).toContain('stream-done: lease held by another tab');
            expect(fetchCalls).toBe(0);
        } finally {
            (globalThis as any).fetch = originalFetch;
        }
    });

    it('should promote a single canonical sample to ready after stabilization retry', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
            parseInterceptedData: () => ({
                title: 'Probe Conversation',
                create_time: 1_700_000_000,
                update_time: 1_700_000_100,
                conversation_id: '123',
                current_node: 'node-2',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt',
                safe_urls: [],
                blocked_urls: [],
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['node-1'] },
                    'node-1': {
                        id: 'node-1',
                        message: {
                            id: 'node-1',
                            author: { role: 'user', name: 'User', metadata: {} },
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
                        parent: 'root',
                        children: ['node-2'],
                    },
                    'node-2': {
                        id: 'node-2',
                        message: {
                            id: 'node-2',
                            author: { role: 'assistant', name: 'Assistant', metadata: {} },
                            create_time: 1_700_000_020,
                            update_time: 1_700_000_020,
                            content: { content_type: 'text', parts: ['Final answer from cache'] },
                            status: 'finished_successfully',
                            end_turn: true,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                        parent: 'node-1',
                        children: [],
                    },
                },
            }),
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        const saveBefore = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveBefore).not.toBeNull();
        expect(saveBefore?.disabled).toBe(true);

        window.postMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://test.com/backend-api/conversation/123',
                data: '{"ok":true}',
                attemptId: 'attempt:single-sample-ready',
            },
            window.location.origin,
        );
        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:single-sample-ready',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );

        await new Promise((resolve) => setTimeout(resolve, 80));
        const saveDuring = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveDuring?.disabled).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 1300));
        const saveAfter = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveAfter?.disabled).toBe(false);
    });

    it('should enter degraded manual-only mode when canonical hash never stabilizes', async () => {
        let readinessCounter = 0;
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
            evaluateReadiness: () => {
                readinessCounter += 1;
                return {
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: `unstable-${readinessCounter}`,
                    latestAssistantTextLength: 24,
                };
            },
            parseInterceptedData: () => ({
                title: 'Unstable Hash Conversation',
                create_time: 1_700_000_000,
                update_time: 1_700_000_100,
                conversation_id: '123',
                current_node: 'node-2',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt',
                safe_urls: [],
                blocked_urls: [],
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['node-1'] },
                    'node-1': {
                        id: 'node-1',
                        message: {
                            id: 'node-1',
                            author: { role: 'user', name: 'User', metadata: {} },
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
                        parent: 'root',
                        children: ['node-2'],
                    },
                    'node-2': {
                        id: 'node-2',
                        message: {
                            id: 'node-2',
                            author: { role: 'assistant', name: 'Assistant', metadata: {} },
                            create_time: 1_700_000_020,
                            update_time: 1_700_000_020,
                            content: { content_type: 'text', parts: ['Final answer with meaningful content'] },
                            status: 'finished_successfully',
                            end_turn: true,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                        parent: 'node-1',
                        children: [],
                    },
                },
            }),
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        window.postMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://test.com/backend-api/conversation/123',
                data: '{"ok":true}',
                attemptId: 'attempt:unstable-hash',
            },
            window.location.origin,
        );
        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:unstable-hash',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );

        await new Promise((resolve) => setTimeout(resolve, 120));
        const saveEarly = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveEarly?.disabled).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 4300));
        const saveFallback = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        const copyFallback = document.getElementById('blackiya-copy-btn') as HTMLButtonElement | null;
        expect(saveFallback?.disabled).toBe(false);
        expect(saveFallback?.textContent).toContain('Force Save');
        expect(copyFallback?.disabled).toBe(true);
    });

    it('should keep Save disabled for ChatGPT thoughts-only captures even after fallback window', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
            evaluateReadiness: () => ({
                ready: false,
                terminal: true,
                reason: 'assistant-text-missing',
                contentHash: null,
                latestAssistantTextLength: 0,
            }),
            parseInterceptedData: () => ({
                title: 'New chat',
                create_time: 1_700_000_000,
                update_time: 1_700_000_020,
                conversation_id: '123',
                current_node: 'node-2',
                moderation_results: [],
                plugin_ids: null,
                gizmo_id: null,
                gizmo_type: null,
                is_archived: false,
                default_model_slug: 'gpt',
                safe_urls: [],
                blocked_urls: [],
                mapping: {
                    root: { id: 'root', message: null, parent: null, children: ['node-1'] },
                    'node-1': {
                        id: 'node-1',
                        message: {
                            id: 'node-1',
                            author: { role: 'user', name: 'User', metadata: {} },
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
                        parent: 'root',
                        children: ['node-2'],
                    },
                    'node-2': {
                        id: 'node-2',
                        message: {
                            id: 'node-2',
                            author: { role: 'assistant', name: 'Assistant', metadata: {} },
                            create_time: 1_700_000_020,
                            update_time: 1_700_000_020,
                            content: {
                                content_type: 'thoughts',
                                thoughts: [{ summary: 'Thinking', content: 'Draft', chunks: [], finished: true }],
                            },
                            status: 'finished_successfully',
                            end_turn: false,
                            weight: 1,
                            metadata: {},
                            recipient: 'all',
                            channel: null,
                        },
                        parent: 'node-1',
                        children: [],
                    },
                },
            }),
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        window.postMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://test.com/backend-api/conversation/123',
                data: '{"ok":true}',
                attemptId: 'attempt:thoughts-only',
            },
            window.location.origin,
        );

        await new Promise((resolve) => setTimeout(resolve, 3800));
        const saveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveButton?.disabled).toBe(true);
    });

    it('should preserve pre-final live mirror snapshot when probe switches to stream-done state', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        window.postMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:preserve-live',
                conversationId: '123',
                text: 'Live chunk one. ',
            },
            window.location.origin,
        );
        window.postMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:preserve-live',
                conversationId: '123',
                text: 'Live chunk two.',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const panelBeforeDone = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelBeforeDone).toContain('Live chunk one. Live chunk two.');

        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
            buildApiUrls: () => ['https://test.com/backend-api/conversation/123'],
            parseInterceptedData: () => null,
        };

        const snapshotFailureHandler = (event: MessageEvent) => {
            const msg = (event as any).data;
            if (msg?.type !== 'BLACKIYA_PAGE_SNAPSHOT_REQUEST') {
                return;
            }
            window.postMessage(
                {
                    type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE',
                    requestId: msg.requestId,
                    success: false,
                    error: 'NOT_FOUND',
                },
                window.location.origin,
            );
        };
        window.addEventListener('message', snapshotFailureHandler as any);
        try {
            window.postMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:preserve-live',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 80));
        } finally {
            window.removeEventListener('message', snapshotFailureHandler as any);
        }

        const panelAfterDone = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(
            panelAfterDone.includes('stream-done: no api url candidates') ||
                panelAfterDone.includes('stream-done: awaiting canonical capture'),
        ).toBe(true);
        expect(panelAfterDone).toContain('Preserved live mirror snapshot (pre-final)');
        expect(panelAfterDone).toContain('Live chunk one. Live chunk two.');
    });

    it('should enable Save from stream-done snapshot fallback when api candidates are unavailable', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
        };

        const snapshotResponseHandler = (event: MessageEvent) => {
            const msg = (event as any).data;
            if (msg?.type !== 'BLACKIYA_PAGE_SNAPSHOT_REQUEST') {
                return;
            }

            window.postMessage(
                {
                    type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE',
                    requestId: msg.requestId,
                    success: true,
                    data: {
                        title: 'Snapshot Title',
                        create_time: 1_700_000_000,
                        update_time: 1_700_000_120,
                        conversation_id: '123',
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
                                    content: { content_type: 'text', parts: ['Final answer from snapshot'] },
                                    status: 'finished_successfully',
                                    end_turn: true,
                                    weight: 1,
                                    metadata: {},
                                    recipient: 'all',
                                    channel: null,
                                },
                            },
                        },
                    },
                },
                window.location.origin,
            );
        };

        window.addEventListener('message', snapshotResponseHandler as any);
        try {
            runPlatform();
            await new Promise((resolve) => setTimeout(resolve, 80));

            window.postMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:snapshot-fallback',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );

            await new Promise((resolve) => setTimeout(resolve, 1700));
            const saveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(saveButton?.disabled).toBe(false);
            expect(saveButton?.textContent).toContain('Force Save');

            const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
            expect(panelText).toContain('stream-done: degraded snapshot captured');
            expect(panelText).toContain('Final answer from snapshot');
        } finally {
            window.removeEventListener('message', snapshotResponseHandler as any);
        }
    });

    it('should upgrade from degraded snapshot mode to canonical-ready when API capture arrives', async () => {
        const canonicalConversation = buildConversation('123', 'Canonical answer from API', {
            status: 'finished_successfully',
            endTurn: true,
        });

        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
            buildApiUrls: () => [],
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

        const snapshotResponseHandler = (event: MessageEvent) => {
            const msg = (event as any).data;
            if (msg?.type !== 'BLACKIYA_PAGE_SNAPSHOT_REQUEST') {
                return;
            }
            window.postMessage(
                {
                    type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE',
                    requestId: msg.requestId,
                    success: true,
                    data: buildConversation('123', 'Snapshot partial answer', {
                        status: 'finished_successfully',
                        endTurn: true,
                    }),
                },
                window.location.origin,
            );
        };

        window.addEventListener('message', snapshotResponseHandler as any);
        try {
            runPlatform();
            await new Promise((resolve) => setTimeout(resolve, 80));

            window.postMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:recover-after-snapshot',
                    phase: 'prompt-sent',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 30));

            window.postMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:recover-after-snapshot',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );

            await new Promise((resolve) => setTimeout(resolve, 700));
            const degradedSaveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(degradedSaveButton?.textContent).toContain('Force Save');

            window.postMessage(
                {
                    type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                    platform: 'ChatGPT',
                    url: 'https://chatgpt.com/backend-api/conversation/123',
                    data: JSON.stringify(canonicalConversation),
                    attemptId: 'attempt:recover-after-snapshot',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 1500));

            const recoveredSaveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(recoveredSaveButton?.disabled).toBe(false);
            expect(recoveredSaveButton?.textContent).not.toContain('Force Save');
        } finally {
            window.removeEventListener('message', snapshotResponseHandler as any);
        }
    });

    it('should ignore disposed attempt lifecycle messages', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:stale-1',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');

        window.postMessage(
            {
                type: 'BLACKIYA_ATTEMPT_DISPOSED',
                attemptId: 'attempt:stale-1',
                reason: 'navigation',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:stale-1',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).not.toContain('Completed');
    });

    it('should ignore stale stream delta from superseded attempt', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:new-active',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));

        window.postMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:old-stale',
                conversationId: '123',
                text: 'Should not render',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelText.includes('Should not render')).toBe(false);
    });

    it('should NOT inject button if no adapter matches', async () => {
        currentAdapterMock = null;
        runPlatform();

        await new Promise((resolve) => setTimeout(resolve, 100));

        const saveBtn = document.getElementById('blackiya-save-btn');
        expect(saveBtn === null).toBe(true);
    });

    it('should respond with cached conversation JSON for window bridge request', async () => {
        runPlatform();

        const data = {
            title: 'Test',
            create_time: 1_700_000_000,
            update_time: 1_700_000_100,
            conversation_id: '123',
            current_node: 'node-2',
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['node-1'] },
                'node-1': {
                    id: 'node-1',
                    message: {
                        id: 'node-1',
                        author: { role: 'user', name: 'User', metadata: {} },
                        create_time: 1_700_000_010,
                        update_time: 1_700_000_010,
                        content: { content_type: 'text', parts: ['Hello'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'root',
                    children: ['node-2'],
                },
                'node-2': {
                    id: 'node-2',
                    message: {
                        id: 'node-2',
                        author: { role: 'assistant', name: 'Assistant', metadata: {} },
                        create_time: 1_700_000_020,
                        update_time: 1_700_000_020,
                        content: { content_type: 'text', parts: ['Hi'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'node-1',
                    children: [],
                },
            },
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'test-model',
            safe_urls: [],
            blocked_urls: [],
        };
        currentAdapterMock.parseInterceptedData = () => data;
        const message = new (window as any).MessageEvent('message', {
            data: { type: 'LLM_CAPTURE_DATA_INTERCEPTED', url: 'https://test.com/api', data: '{}' },
            origin: window.location.origin,
            source: window,
        });
        window.dispatchEvent(message);
        await new Promise((resolve) => setTimeout(resolve, 950));
        window.dispatchEvent(message);
        await new Promise((resolve) => setTimeout(resolve, 40));

        const responsePromise = new Promise<any>((resolve) => {
            const handler = (event: any) => {
                const message = event?.data;
                if (message?.type !== 'BLACKIYA_GET_JSON_RESPONSE') {
                    return;
                }
                window.removeEventListener('message', handler as any);
                resolve(message);
            };
            window.addEventListener('message', handler as any);
        });

        window.postMessage({ type: 'BLACKIYA_GET_JSON_REQUEST', requestId: 'request-1' }, window.location.origin);

        const responsePayload = await responsePromise;
        expect(responsePayload).toEqual({
            type: 'BLACKIYA_GET_JSON_RESPONSE',
            requestId: 'request-1',
            success: true,
            data,
        });
    });

    it('should gracefully reject bridge requests when intercepted payload is incomplete', async () => {
        runPlatform();

        const message = new (window as any).MessageEvent('message', {
            data: { type: 'LLM_CAPTURE_DATA_INTERCEPTED', url: 'https://test.com/api', data: '{}' },
            origin: window.location.origin,
            source: window,
        });
        window.dispatchEvent(message);

        const responsePromise = new Promise<any>((resolve) => {
            const handler = (event: any) => {
                const bridgeMessage = event?.data;
                if (bridgeMessage?.type !== 'BLACKIYA_GET_JSON_RESPONSE') {
                    return;
                }
                window.removeEventListener('message', handler as any);
                resolve(bridgeMessage);
            };
            window.addEventListener('message', handler as any);
        });

        window.postMessage(
            { type: 'BLACKIYA_GET_JSON_REQUEST', requestId: 'request-incomplete' },
            window.location.origin,
        );

        const responsePayload = await responsePromise;
        expect(responsePayload).toEqual({
            type: 'BLACKIYA_GET_JSON_RESPONSE',
            requestId: 'request-incomplete',
            success: false,
            data: undefined,
            error: 'NO_CONVERSATION_DATA',
        });
    });

    it('should respond with common JSON when requested', async () => {
        runPlatform();

        const data = {
            title: 'Test',
            create_time: 1_700_000_000,
            update_time: 1_700_000_100,
            conversation_id: '123',
            current_node: 'node-2',
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['node-1'] },
                'node-1': {
                    id: 'node-1',
                    message: {
                        id: 'node-1',
                        author: { role: 'user', name: 'User', metadata: {} },
                        create_time: 1_700_000_010,
                        update_time: 1_700_000_010,
                        content: { content_type: 'text', parts: ['Hello'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'root',
                    children: ['node-2'],
                },
                'node-2': {
                    id: 'node-2',
                    message: {
                        id: 'node-2',
                        author: { role: 'assistant', name: 'Assistant', metadata: {} },
                        create_time: 1_700_000_020,
                        update_time: 1_700_000_020,
                        content: { content_type: 'text', parts: ['Hi'] },
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                    parent: 'node-1',
                    children: [],
                },
            },
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'test-model',
            safe_urls: [],
            blocked_urls: [],
        };
        currentAdapterMock.parseInterceptedData = () => data;
        const message = new (window as any).MessageEvent('message', {
            data: { type: 'LLM_CAPTURE_DATA_INTERCEPTED', url: 'https://test.com/api', data: '{}' },
            origin: window.location.origin,
            source: window,
        });
        window.dispatchEvent(message);
        await new Promise((resolve) => setTimeout(resolve, 950));
        window.dispatchEvent(message);
        await new Promise((resolve) => setTimeout(resolve, 40));

        const responsePromise = new Promise<any>((resolve) => {
            const handler = (event: any) => {
                const message = event?.data;
                if (message?.type !== 'BLACKIYA_GET_JSON_RESPONSE') {
                    return;
                }
                window.removeEventListener('message', handler as any);
                resolve(message);
            };
            window.addEventListener('message', handler as any);
        });

        window.postMessage(
            { type: 'BLACKIYA_GET_JSON_REQUEST', requestId: 'request-2', format: 'common' },
            window.location.origin,
        );

        const responsePayload = await responsePromise;
        expect(responsePayload.type).toBe('BLACKIYA_GET_JSON_RESPONSE');
        expect(responsePayload.requestId).toBe('request-2');
        expect(responsePayload.success).toBe(true);
        expect(responsePayload.data.format).toBe('common');
        expect(responsePayload.data.llm).toBe('TestPlatform');
    });
});
