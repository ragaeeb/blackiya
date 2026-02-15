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

    it('should replace awaiting canonical probe toast once canonical capture becomes ready', async () => {
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
                    attemptId: 'attempt:probe-await',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 40));

            const panelBeforeCanonical = document.getElementById('blackiya-stream-probe');
            expect(panelBeforeCanonical).not.toBeNull();
            if (panelBeforeCanonical) {
                panelBeforeCanonical.textContent =
                    '[Blackiya Stream Probe] stream-done: awaiting canonical capture @ 1:23:45 AM\n\nConversation stream completed for 123. Waiting for canonical capture.';
            }

            currentAdapterMock.parseInterceptedData = () => ({
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
            });

            window.postMessage(
                {
                    type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                    url: 'https://test.com/backend-api/conversation/123',
                    data: '{"ok":true}',
                    attemptId: 'attempt:probe-await',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 950));

            window.postMessage(
                {
                    type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                    url: 'https://test.com/backend-api/conversation/123',
                    data: '{"ok":true}',
                    attemptId: 'attempt:probe-await',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 40));

            const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
            expect(panelText).toContain('stream-done: canonical capture ready');
            expect(panelText).toContain('Final answer from cache');
            expect(panelText.includes('stream-done: awaiting canonical capture')).toBe(false);
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

        await new Promise((resolve) => setTimeout(resolve, 80));
        const saveDuring = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveDuring?.disabled).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 1300));
        const saveAfter = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveAfter?.disabled).toBe(false);
    });

    it('should enable Save via legacy fallback when canonical hash never stabilizes', async () => {
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

        await new Promise((resolve) => setTimeout(resolve, 120));
        const saveEarly = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveEarly?.disabled).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 3600));
        const saveFallback = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveFallback?.disabled).toBe(false);
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
        await new Promise((resolve) => setTimeout(resolve, 40));

        const panelAfterDone = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelAfterDone).toContain('stream-done: no api url candidates');
        expect(panelAfterDone).toContain('Preserved live mirror snapshot (pre-final)');
        expect(panelAfterDone).toContain('Live chunk one. Live chunk two.');
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
