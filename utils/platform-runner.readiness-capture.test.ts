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

    it('should tear down previous runner instance before starting a new one', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(document.querySelectorAll('#blackiya-button-container').length).toBe(1);
        expect(document.querySelectorAll('#blackiya-save-btn').length).toBe(1);
        expect(document.querySelectorAll('#blackiya-calibrate-btn').length).toBe(1);
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

        postStampedMessage(
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

        postStampedMessage(
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
        postStampedMessage(
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
        postStampedMessage(
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
        expect(saveBeforeStreaming?.disabled).toBeFalse();

        postStampedMessage(
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

        postStampedMessage(
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

        postStampedMessage(
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
        expect(saveDuringStreaming?.disabled).toBeTrue();
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

            postStampedMessage(
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
            expect(panelText.includes('Could not parse conversation payload')).toBeFalse();
        } finally {
            (globalThis as any).fetch = originalFetch;
        }
    });

    it('should skip stream probe when probe lease is denied by coordinator', async () => {
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

            runtimeSendMessageMock = async (message: unknown) => {
                const typed = message as { type?: string };
                if (typed?.type === 'BLACKIYA_PROBE_LEASE_CLAIM') {
                    return {
                        type: 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT',
                        acquired: false,
                        ownerAttemptId: 'attempt:owner',
                        expiresAtMs: Date.now() + 10_000,
                    };
                }
                return {
                    type: 'BLACKIYA_PROBE_LEASE_RELEASE_RESULT',
                    released: false,
                };
            };

            currentAdapterMock = {
                ...createMockAdapter(),
                name: 'ChatGPT',
                buildApiUrls: () => ['https://test.com/backend-api/conversation/123'],
                parseInterceptedData: () => null,
            };

            runPlatform();
            await new Promise((resolve) => setTimeout(resolve, 80));

            postStampedMessage(
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
        expect(saveBefore?.disabled).toBeTrue();

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://test.com/backend-api/conversation/123',
                data: '{"ok":true}',
                attemptId: 'attempt:single-sample-ready',
            },
            window.location.origin,
        );
        postStampedMessage(
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
        expect(saveDuring?.disabled).toBeTrue();

        await new Promise((resolve) => setTimeout(resolve, 1300));
        const saveAfter = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveAfter?.disabled).toBeFalse();
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

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://test.com/backend-api/conversation/123',
                data: '{"ok":true}',
                attemptId: 'attempt:unstable-hash',
            },
            window.location.origin,
        );
        postStampedMessage(
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
        expect(saveEarly?.disabled).toBeTrue();

        await new Promise((resolve) => setTimeout(resolve, 7600));
        const saveFallback = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        const copyFallback = document.getElementById('blackiya-copy-btn') as HTMLButtonElement | null;
        expect(saveFallback?.disabled).toBeFalse();
        expect(saveFallback?.title).toContain('Force Save');
        expect(copyFallback).toBeNull();
    }, 15_000);

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

        postStampedMessage(
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
        expect(saveButton?.disabled).toBeTrue();
    });

    it('should preserve pre-final live mirror snapshot when probe switches to stream-done state', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
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
        postStampedMessage(
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
        window.addEventListener('message', snapshotFailureHandler as any);
        try {
            postStampedMessage(
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
        ).toBeTrue();
        expect(panelAfterDone).toContain('Preserved live mirror snapshot (pre-final)');
        expect(panelAfterDone).toContain('Live chunk one. Live chunk two.');
    });

    it('should ignore unstamped page snapshot responses', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
            buildApiUrls: () => [],
            parseInterceptedData: () => null,
        };

        const unstampedSnapshotHandler = (event: MessageEvent) => {
            const msg = (event as any).data;
            if (msg?.type !== 'BLACKIYA_PAGE_SNAPSHOT_REQUEST') {
                return;
            }
            window.postMessage(
                {
                    type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE',
                    requestId: msg.requestId,
                    success: true,
                    data: buildConversation('123', 'UNSTAMPED SNAPSHOT SHOULD NOT APPLY', {
                        status: 'finished_successfully',
                        endTurn: true,
                    }),
                },
                window.location.origin,
            );
        };

        window.addEventListener('message', unstampedSnapshotHandler as any);
        try {
            runPlatform();
            await new Promise((resolve) => setTimeout(resolve, 80));

            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:unstamped-snapshot',
                    phase: 'prompt-sent',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:unstamped-snapshot',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );

            await new Promise((resolve) => setTimeout(resolve, 2800));
            const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
            expect(panelText.includes('UNSTAMPED SNAPSHOT SHOULD NOT APPLY')).toBeFalse();
            expect(panelText.includes('stream-done: degraded snapshot captured')).toBeFalse();
        } finally {
            window.removeEventListener('message', unstampedSnapshotHandler as any);
        }
    });

    it('should promote ready snapshot to canonical when warm fetch fails (V2.1-018 fix)', async () => {
        // When the ChatGPT API is unreachable from the ISOLATED content script
        // world (returns 404), the stabilization retry's warm fetch fails. If
        // the cached DOM snapshot already passes readiness, it should be promoted
        // to canonical so the SFE can stabilize via two matching snapshot samples.
        // This avoids the Force Save timeout entirely.
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
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

            postStampedMessage(
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

            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:snapshot-fallback',
                    phase: 'prompt-sent',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 20));

            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:snapshot-fallback',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );

            // Wait for probe to run (fetch fails), snapshot fallback captures
            // degraded data, and stabilization retries promote it to canonical.
            await new Promise((resolve) => setTimeout(resolve, 1700));

            const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
            expect(panelText).toContain('stream-done: degraded snapshot captured');
            expect(panelText).toContain('Final answer from snapshot');

            // After 2 retry ticks (~2.3s), the snapshot should be promoted
            // to canonical because it passes readiness. Wait for the SFE
            // to stabilize with two matching canonical samples.
            await new Promise((resolve) => setTimeout(resolve, 3000));

            // Verify Save JSON is shown (not Force Save) — the snapshot was
            // promoted to canonical since the API warm fetch consistently failed.
            const saveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(saveButton).not.toBeNull();
            expect(saveButton?.disabled).toBeFalse();
            expect(saveButton?.title?.includes('Force Save')).toBeFalse();
        } finally {
            window.removeEventListener('message', snapshotResponseHandler as any);
        }
    }, 15_000);

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
            postStampedMessage(
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

            postStampedMessage(
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

            postStampedMessage(
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
            expect(degradedSaveButton?.disabled).toBeTrue();
            expect(degradedSaveButton?.title?.includes('Force Save')).toBeFalse();

            postStampedMessage(
                {
                    type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                    platform: 'ChatGPT',
                    url: 'https://chatgpt.com/backend-api/conversation/123',
                    data: JSON.stringify(canonicalConversation),
                    attemptId: 'attempt:recover-after-snapshot',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 1050));
            postStampedMessage(
                {
                    type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                    platform: 'ChatGPT',
                    url: 'https://chatgpt.com/backend-api/conversation/123',
                    data: JSON.stringify(canonicalConversation),
                    attemptId: 'attempt:recover-after-snapshot',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 250));

            const recoveredSaveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(recoveredSaveButton?.disabled).toBeFalse();
            expect(recoveredSaveButton?.title).not.toContain('Force Save');
        } finally {
            window.removeEventListener('message', snapshotResponseHandler as any);
        }
    });

    it('should promote fidelity to high when canonical API capture arrives after degraded snapshot', async () => {
        // Reproduces V2.1-015: snapshot fallback sets fidelity=degraded, then a single
        // canonical API capture arrives. The stabilization retry loop must be able to
        // ingest the cached data as a second sample. If fidelity stays degraded, the
        // shouldIngestAsCanonicalSample guard blocks the second sample and the SFE
        // never reaches captured_ready — landing in Force Save permanently.
        const canonicalConversation = buildConversation('123', 'Full canonical response from API', {
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

        // Respond to snapshot requests with a degraded snapshot
        const snapshotResponseHandler = (event: MessageEvent) => {
            const msg = (event as any).data;
            if (msg?.type !== 'BLACKIYA_PAGE_SNAPSHOT_REQUEST') {
                return;
            }
            postStampedMessage(
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

            // 1. Send prompt-sent
            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:fidelity-promote',
                    phase: 'prompt-sent',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 30));

            // 2. Send completed — triggers snapshot fallback (degraded fidelity)
            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:fidelity-promote',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );

            // Wait for snapshot capture to process
            await new Promise((resolve) => setTimeout(resolve, 700));

            // Save should NOT be enabled yet (degraded, awaiting canonical)
            const degradedSaveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(degradedSaveButton?.disabled).toBeTrue();

            // 3. Send ONE canonical API capture (simulates the interceptor's proactive fetch)
            postStampedMessage(
                {
                    type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                    platform: 'ChatGPT',
                    url: 'https://chatgpt.com/backend-api/conversation/123',
                    data: JSON.stringify(canonicalConversation),
                    attemptId: 'attempt:fidelity-promote',
                },
                window.location.origin,
            );

            // Wait for stabilization retry to fire and ingest second sample
            // The retry interval is 1150ms, so 2500ms should be enough for
            // the first sample + one retry with a matching hash
            await new Promise((resolve) => setTimeout(resolve, 2500));

            // Save button should be enabled in canonical_ready mode (not Force Save)
            const recoveredSaveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(recoveredSaveButton?.disabled).toBeFalse();
            expect(recoveredSaveButton?.title).not.toContain('Force Save');
        } finally {
            window.removeEventListener('message', snapshotResponseHandler as any);
        }
    }, 10_000);

    it('should keep Save enabled after canonical-ready despite transient ChatGPT generating DOM re-checks', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
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

        const canonicalConversation = buildConversation('123', 'Stable canonical answer', {
            status: 'finished_successfully',
            endTurn: true,
        });

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:no-flicker',
                phase: 'prompt-sent',
                conversationId: '123',
            },
            window.location.origin,
        );

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:no-flicker',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:no-flicker',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:no-flicker',
            },
            window.location.origin,
        );

        await new Promise((resolve) => setTimeout(resolve, 1050));

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:no-flicker',
            },
            window.location.origin,
        );

        await new Promise((resolve) => setTimeout(resolve, 180));

        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveBtn?.disabled).toBeFalse();

        const stopButton = document.createElement('button');
        stopButton.setAttribute('data-testid', 'stop-button');
        stopButton.disabled = false;
        document.body.appendChild(stopButton);

        await new Promise((resolve) => setTimeout(resolve, 1700));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                source: 'completion-endpoint',
                attemptId: 'attempt:no-flicker',
                conversationId: '123',
            },
            window.location.origin,
        );

        await new Promise((resolve) => setTimeout(resolve, 120));

        const saveAfterHint = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveAfterHint?.disabled).toBeFalse();
    }, 15_000);

    it('should enable Save when RESPONSE_FINISHED arrives before canonical data in multi-tab scenario', async () => {
        // Reproduces the Tab 1 failure in multi-tab: the SSE stream never emits
        // "completed" because the tab was backgrounded, but the DOM completion watcher
        // detects the UI transition via RESPONSE_FINISHED. Shortly after, the
        // interceptor's proactive fetch delivers canonical data via
        // LLM_CAPTURE_DATA_INTERCEPTED. The runner must handle both signals
        // (finished + canonical data) to reach captured_ready.
        const canonicalConversation = buildConversation('123', 'Full response text', {
            status: 'finished_successfully',
            endTurn: true,
        });

        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
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

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        // 1. prompt-sent WITHOUT conversationId (new conversation, ID not yet resolved)
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:dom-completion-probe',
                phase: 'prompt-sent',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        // 2. streaming WITHOUT conversationId
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:dom-completion-probe',
                phase: 'streaming',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        // 3. The SSE stream never sends "completed" (tab was backgrounded).
        //    Instead, the RESPONSE_FINISHED signal arrives (from DOM watcher).
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                attemptId: 'attempt:dom-completion-probe',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));

        // 4. Canonical data arrives from interceptor's proactive fetch (first sample)
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:dom-completion-probe',
            },
            window.location.origin,
        );

        // Wait for stabilization window
        await new Promise((resolve) => setTimeout(resolve, 1200));

        // 5. Second canonical sample for stability confirmation
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:dom-completion-probe',
            },
            window.location.origin,
        );

        await new Promise((resolve) => setTimeout(resolve, 1500));

        const saveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveButton?.disabled).toBeFalse();
    }, 10_000);

    it('should recover from blocked network finished and enable Save after DOM completion transition', async () => {
        const canonicalConversation = buildConversation('123', 'Long reasoning answer', {
            status: 'finished_successfully',
            endTurn: true,
        });

        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
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

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:chatgpt-dom-recovery',
                phase: 'prompt-sent',
                conversationId: '123',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:chatgpt-dom-recovery',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 80));

        const stopButton = document.createElement('button');
        stopButton.setAttribute('data-testid', 'stop-button');
        stopButton.disabled = false;
        document.body.appendChild(stopButton);

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                attemptId: 'attempt:chatgpt-dom-recovery',
                conversationId: '123',
            },
            window.location.origin,
        );

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:chatgpt-dom-recovery',
            },
            window.location.origin,
        );

        // Ensure completion watcher samples a generating=true state before we clear it.
        await new Promise((resolve) => setTimeout(resolve, 900));

        await new Promise((resolve) => setTimeout(resolve, 120));
        const saveWhileGenerating = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveWhileGenerating?.disabled).toBeTrue();

        stopButton.remove();

        // Let completion watcher observe generating -> not generating transition.
        await new Promise((resolve) => setTimeout(resolve, 1100));

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:chatgpt-dom-recovery',
            },
            window.location.origin,
        );

        await new Promise((resolve) => setTimeout(resolve, 1500));

        const saveAfterDomCompletion = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveAfterDomCompletion?.disabled).toBeFalse();
        expect(saveAfterDomCompletion?.title?.includes('Force Save')).toBeFalse();
    }, 12_000);

    it('should keep Save disabled during active generation despite repeated network finished hints', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
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

        const canonicalConversation = buildConversation('123', 'Ready canonical answer', {
            status: 'finished_successfully',
            endTurn: true,
        });

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:generation-guard',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 1050));
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:generation-guard',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));

        const saveBeforeGeneration = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveBeforeGeneration?.disabled).toBeFalse();

        const stopButton = document.createElement('button');
        stopButton.setAttribute('data-testid', 'stop-button');
        stopButton.disabled = false;
        document.body.appendChild(stopButton);

        for (let i = 0; i < 5; i += 1) {
            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_FINISHED',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:generation-guard',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 40));
        }

        await new Promise((resolve) => setTimeout(resolve, 120));
        const saveDuringGeneration = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveDuringGeneration?.disabled).toBeTrue();
    }, 15_000);

    it('should keep Save enabled when late degraded snapshot arrives after canonical-ready', async () => {
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

        const canonicalConversation = buildConversation('123', 'Stable canonical answer', {
            status: 'finished_successfully',
            endTurn: true,
        });

        const degradedSnapshotConversation = buildConversation('123', 'Partial snapshot answer', {
            status: 'in_progress',
            endTurn: false,
        });

        const snapshotResponseHandler = (event: MessageEvent) => {
            const msg = (event as any).data;
            if (msg?.type !== 'BLACKIYA_PAGE_SNAPSHOT_REQUEST') {
                return;
            }
            postStampedMessage(
                {
                    type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE',
                    requestId: msg.requestId,
                    success: true,
                    data: degradedSnapshotConversation,
                },
                window.location.origin,
            );
        };

        window.addEventListener('message', snapshotResponseHandler as any);
        try {
            runPlatform();
            await new Promise((resolve) => setTimeout(resolve, 80));

            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:late-snapshot',
                    phase: 'prompt-sent',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 20));

            postStampedMessage(
                {
                    type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                    platform: 'ChatGPT',
                    url: 'https://chatgpt.com/backend-api/conversation/123',
                    data: JSON.stringify(canonicalConversation),
                    attemptId: 'attempt:late-snapshot',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 1050));
            postStampedMessage(
                {
                    type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                    platform: 'ChatGPT',
                    url: 'https://chatgpt.com/backend-api/conversation/123',
                    data: JSON.stringify(canonicalConversation),
                    attemptId: 'attempt:late-snapshot',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 150));

            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:late-snapshot',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );

            await new Promise((resolve) => setTimeout(resolve, 1200));

            const saveAfterSnapshot = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(saveAfterSnapshot?.disabled).toBeFalse();
            expect(saveAfterSnapshot?.title?.includes('Force Save')).toBeFalse();
        } finally {
            window.removeEventListener('message', snapshotResponseHandler as any);
        }
    }, 15_000);

    it('should ignore disposed attempt lifecycle messages', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
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

        postStampedMessage(
            {
                type: 'BLACKIYA_ATTEMPT_DISPOSED',
                attemptId: 'attempt:stale-1',
                reason: 'navigation',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));

        postStampedMessage(
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
});
