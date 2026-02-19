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
        storageDataMock = {};
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

    it('should clear aliased conversation bindings when disposing an upstream alias attempt', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
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

        const postLifecycle = async (attemptId: string, conversationId: string) => {
            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId,
                    phase: 'prompt-sent',
                    conversationId,
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 15));
        };

        // Build alias chain A -> B, then bind conv-2 to raw A via interception metadata.
        await postLifecycle('attempt:chain-a', 'conv-1');
        await postLifecycle('attempt:chain-b', 'conv-1');

        const captureForConv2 = buildConversation('conv-2', 'Partial response', {
            status: 'in_progress',
            endTurn: false,
        });
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/conv-2',
                data: JSON.stringify(captureForConv2),
                attemptId: 'attempt:chain-a',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        // Extend alias chain to A -> B -> C. If cleanup only checks raw IDs, conv-2's raw A survives.
        await postLifecycle('attempt:chain-c', 'conv-1');

        const postedMessages: any[] = [];
        const originalPostMessage = window.postMessage.bind(window);
        (window as any).postMessage = (payload: any, targetOrigin: string) => {
            postedMessages.push(payload);
            return originalPostMessage(payload, targetOrigin);
        };
        try {
            // If conv-2 binding for aliased A was not cleared, rebinding emits an unnecessary C superseded disposal.
            await postLifecycle('attempt:chain-d', 'conv-2');
            await new Promise((resolve) => setTimeout(resolve, 40));
        } finally {
            (window as any).postMessage = originalPostMessage;
        }

        const supersededDisposals = postedMessages
            .filter((payload) => payload?.type === 'BLACKIYA_ATTEMPT_DISPOSED' && payload?.reason === 'superseded')
            .map((payload) => payload.attemptId);
        expect(supersededDisposals).not.toContain('attempt:chain-c');
    });

    it('should not supersede when rebinding a conversation with an aliased attempt that resolves to same canonical id', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
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

        const postLifecycle = async (attemptId: string, conversationId: string) => {
            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId,
                    phase: 'prompt-sent',
                    conversationId,
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 15));
        };

        // Establish alias mapping attempt:alias-a -> attempt:canon-a via supersede.
        await postLifecycle('attempt:alias-a', 'conv-1');
        await postLifecycle('attempt:canon-a', 'conv-1');

        // Bind conv-2 using the upstream alias id.
        const captureForConv2 = buildConversation('conv-2', 'Partial response', {
            status: 'in_progress',
            endTurn: false,
        });
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/conv-2',
                data: JSON.stringify(captureForConv2),
                attemptId: 'attempt:alias-a',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        const postedMessages: any[] = [];
        const originalPostMessage = window.postMessage.bind(window);
        (window as any).postMessage = (payload: any, targetOrigin: string) => {
            postedMessages.push(payload);
            return originalPostMessage(payload, targetOrigin);
        };

        try {
            // Rebinding conv-2 with the alias should resolve to the same canonical attempt and not supersede.
            await postLifecycle('attempt:alias-a', 'conv-2');
            await new Promise((resolve) => setTimeout(resolve, 30));
        } finally {
            (window as any).postMessage = originalPostMessage;
        }

        const supersededDisposals = postedMessages
            .filter((payload) => payload?.type === 'BLACKIYA_ATTEMPT_DISPOSED' && payload?.reason === 'superseded')
            .map((payload) => payload.attemptId);
        expect(supersededDisposals).not.toContain('attempt:canon-a');
    });

    it('should not create a spurious active attempt when refreshButtonState fires on a different conversation (H-01)', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
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

        // Step 1: Establish an active attempt on conv-1 via lifecycle signals
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:h01-active',
                phase: 'prompt-sent',
                conversationId: 'conv-h01-a',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Step 2: Capture messages during button state refresh for a DIFFERENT conversation
        const postedMessages: any[] = [];
        const originalPostMessage = window.postMessage.bind(window);
        (window as any).postMessage = (payload: any, targetOrigin: string) => {
            postedMessages.push(payload);
            return originalPostMessage(payload, targetOrigin);
        };

        try {
            // Step 3: Navigate to a different conversation (triggers button refresh + readiness check)
            currentAdapterMock.extractConversationId = () => 'conv-h01-b';
            delete (window as any).location;
            (window as any).location = {
                href: 'https://chatgpt.com/c/conv-h01-b',
                origin: 'https://chatgpt.com',
            };
            window.dispatchEvent(new (window as any).Event('popstate'));
            await new Promise((resolve) => setTimeout(resolve, 100));
        } finally {
            (window as any).postMessage = originalPostMessage;
        }

        // Read-only paths must NOT have emitted BLACKIYA_ATTEMPT_DISPOSED for the original attempt
        const disposals = postedMessages.filter((p) => p?.type === 'BLACKIYA_ATTEMPT_DISPOSED').map((p) => p.attemptId);
        expect(disposals).not.toContain('attempt:h01-active');
    });

    it('should keep ChatGPT stream deltas after navigation into the same conversation route', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
            extractConversationId: (url: string) => {
                const match = url.match(/\/c\/([a-z0-9-]+)/i);
                return match?.[1] ?? null;
            },
        };

        delete (window as any).location;
        (window as any).location = {
            href: 'https://chatgpt.com/',
            origin: 'https://chatgpt.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 100));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:nav-preserve',
                phase: 'streaming',
                conversationId: 'conv-same-nav',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        (window as any).location.href = 'https://chatgpt.com/c/conv-same-nav';
        window.dispatchEvent(new (window as any).Event('popstate'));
        await new Promise((resolve) => setTimeout(resolve, 30));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:nav-preserve',
                conversationId: 'conv-same-nav',
                text: 'delta-after-same-conversation-navigation',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelText.includes('delta-after-same-conversation-navigation')).toBeTrue();
    });

    it('should dispose prior ChatGPT attempt when navigation switches to a different conversation route', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
            extractConversationId: (url: string) => {
                const match = url.match(/\/c\/([a-z0-9-]+)/i);
                return match?.[1] ?? null;
            },
        };

        delete (window as any).location;
        (window as any).location = {
            href: 'https://chatgpt.com/c/conv-old',
            origin: 'https://chatgpt.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 100));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:nav-dispose',
                phase: 'streaming',
                conversationId: 'conv-old',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        (window as any).location.href = 'https://chatgpt.com/c/conv-new';
        window.dispatchEvent(new (window as any).Event('popstate'));
        await new Promise((resolve) => setTimeout(resolve, 30));

        postStampedMessage(
            {
                type: 'BLACKIYA_STREAM_DELTA',
                platform: 'ChatGPT',
                source: 'network',
                attemptId: 'attempt:nav-dispose',
                conversationId: 'conv-old',
                text: 'delta-from-disposed-old-conversation',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelText.includes('delta-from-disposed-old-conversation')).toBeFalse();
    });

    it('should defer auto calibration on first-prompt navigation even when no attempt is pre-bound', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
            isPlatformGenerating: () => true,
            extractConversationId: (url: string) => {
                const match = url.match(/\/c\/([a-z0-9-]+)/i);
                return match?.[1] ?? null;
            },
        };

        delete (window as any).location;
        (window as any).location = {
            href: 'https://chatgpt.com/c/conv-old',
            origin: 'https://chatgpt.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 100));

        (window as any).location.href = 'https://chatgpt.com/c/conv-new';
        window.dispatchEvent(new (window as any).Event('popstate'));
        await new Promise((resolve) => setTimeout(resolve, 2100));

        const deferred = loggerInfoCalls.find(
            (entry) =>
                entry.message === 'Auto calibration deferred: response still generating' &&
                (entry.args?.[0] as { conversationId?: string } | undefined)?.conversationId === 'conv-new',
        );
        expect(deferred).toBeDefined();
    });

    it('should ignore stale stream delta from superseded attempt', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        postStampedMessage(
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

        postStampedMessage(
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
        expect(panelText.includes('Should not render')).toBeFalse();
    });

    it('should NOT inject button if no adapter matches', async () => {
        currentAdapterMock = null;
        runPlatform();

        await new Promise((resolve) => setTimeout(resolve, 100));

        const saveBtn = document.getElementById('blackiya-save-btn');
        expect(saveBtn === null).toBeTrue();
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
            data: {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://test.com/api',
                data: '{}',
                __blackiyaToken: getSessionToken(),
            },
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

        postStampedMessage({ type: 'BLACKIYA_GET_JSON_REQUEST', requestId: 'request-1' }, window.location.origin);

        const responsePayload = await responsePromise;
        expect(responsePayload).toMatchObject({
            type: 'BLACKIYA_GET_JSON_RESPONSE',
            requestId: 'request-1',
            success: true,
            data,
        });
    });

    it('should gracefully reject bridge requests when intercepted payload is incomplete', async () => {
        runPlatform();

        const message = new (window as any).MessageEvent('message', {
            data: {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://test.com/api',
                data: '{}',
                __blackiyaToken: getSessionToken(),
            },
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

        postStampedMessage(
            { type: 'BLACKIYA_GET_JSON_REQUEST', requestId: 'request-incomplete' },
            window.location.origin,
        );

        const responsePayload = await responsePromise;
        expect(responsePayload).toMatchObject({
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
            data: {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://test.com/api',
                data: '{}',
                __blackiyaToken: getSessionToken(),
            },
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

        postStampedMessage(
            { type: 'BLACKIYA_GET_JSON_REQUEST', requestId: 'request-2', format: 'common' },
            window.location.origin,
        );

        const responsePayload = await responsePromise;
        expect(responsePayload.type).toBe('BLACKIYA_GET_JSON_RESPONSE');
        expect(responsePayload.requestId).toBe('request-2');
        expect(responsePayload.success).toBeTrue();
        expect(responsePayload.data.format).toBe('common');
        expect(responsePayload.data.llm).toBe('TestPlatform');
    });

    it('should update cached title when BLACKIYA_TITLE_RESOLVED arrives from SSE stream', async () => {
        const staleTitle = 'ROLE: Expert academic translator of Classical Islamic texts; prioritize accur...';
        const freshTitle = 'Translation of Maytah Prohibition';

        const staleConversation = buildConversation('123', 'Full response text', {
            status: 'finished_successfully',
            endTurn: true,
        });
        staleConversation.title = staleTitle;

        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'ChatGPT',
            evaluateReadiness: evaluateReadinessMock,
            formatFilename: (data: { title: string }) => data.title.replace(/[^a-zA-Z0-9]/g, '_'),
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

        // 1. Lifecycle: prompt-sent → streaming (mimic real SSE flow)
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:title-test',
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
                attemptId: 'attempt:title-test',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        // 2. Title arrives mid-stream via BLACKIYA_TITLE_RESOLVED
        postStampedMessage(
            {
                type: 'BLACKIYA_TITLE_RESOLVED',
                platform: 'ChatGPT',
                attemptId: 'attempt:title-test',
                conversationId: '123',
                title: freshTitle,
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        // 3. Ingest canonical data (with stale title, as would happen from proactive fetch)
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(staleConversation),
                attemptId: 'attempt:title-test',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 80));

        // 4. Lifecycle completed + response finished
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:title-test',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                attemptId: 'attempt:title-test',
                conversationId: '123',
            },
            window.location.origin,
        );

        // Wait for stabilization (second canonical sample from retry)
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // Second canonical sample for stability
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(staleConversation),
                attemptId: 'attempt:title-test',
            },
            window.location.origin,
        );

        await new Promise((resolve) => setTimeout(resolve, 1500));

        // 5. Verify save button is enabled
        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveBtn).not.toBeNull();
        expect(saveBtn?.disabled).toBeFalse();

        // 6. Click save
        downloadCalls.length = 0;
        saveBtn?.click();
        await new Promise((resolve) => setTimeout(resolve, 200));

        // 7. Verify the exported data has the fresh title from the SSE stream
        expect(downloadCalls.length).toBeGreaterThanOrEqual(1);
        const downloadedData = downloadCalls[0].data as Record<string, unknown>;
        expect(downloadedData.title).toBe(freshTitle);

        // Verify filename also used the fresh title
        expect(downloadCalls[0].filename).toContain('Translation');
    }, 15_000);

    it('should schedule stabilization retry after navigation resets lifecycle to idle', async () => {
        // Reproduces V2.1-018: For long-thinking models (GPT 5.2), the proactive
        // fetch gives up. After the response completes, a degraded snapshot is
        // captured (status: in_progress). The stabilization retry must continue
        // even when lifecycleState transitions to 'idle' (e.g., after navigation
        // changes chatgpt.com → chatgpt.com/c/{id}). Two canonical samples with
        // matching hashes are needed for the SFE to reach captured_ready.
        const canonicalConversation = buildConversation('123', 'Full canonical answer from API', {
            status: 'finished_successfully',
            endTurn: true,
        });

        const degradedSnapshot = buildConversation('123', 'Partial thinking output...', {
            status: 'in_progress',
            endTurn: false,
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

        // 1. Streaming lifecycle (tab backgrounded, SSE stalls)
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:nav-retry',
                phase: 'prompt-sent',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:nav-retry',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        // 2. RESPONSE_FINISHED sets lifecycleState = 'completed'
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                attemptId: 'attempt:nav-retry',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));

        // 3. Degraded snapshot arrives (what tryStreamDoneSnapshotCapture produces).
        //    This triggers onConversationCaptured with a snapshot source, which
        //    schedules the stabilization retry.
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'stream-snapshot://ChatGPT/123',
                data: JSON.stringify(degradedSnapshot),
                attemptId: 'attempt:nav-retry',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));

        // 4. Simulate the lifecycle transitioning to 'idle' — this is what
        //    handleConversationSwitch does after a URL change. In the real
        //    scenario, the stabilization retry timer may have been cleared and
        //    a warm fetch delivers data while lifecycle is idle.
        //    We send a lifecycle signal with a non-streaming phase to force idle.
        //    Then deliver canonical data as if from the warm fetch.

        // First canonical sample (first stabilization retry / warm fetch result)
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:nav-retry',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 1200));

        // Second canonical sample (second stabilization retry)
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:nav-retry',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // 5. Verify Save button is enabled — SFE should reach captured_ready
        const saveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveButton).not.toBeNull();
        expect(saveButton?.disabled).toBeFalse();
    }, 15_000);

    it('should re-request fresh DOM snapshot when cached snapshot has assistant-missing (V2.1-019 fix)', async () => {
        // When a thinking model's DOM is not fully rendered at snapshot time,
        // the initial snapshot may contain only the user message (no assistant).
        // evaluateReadiness returns { ready: false, reason: 'assistant-missing' }.
        // The stabilization retries re-check the same stale cached snapshot,
        // which never changes — all retries are doomed.
        //
        // Fix: when !fetchSucceeded && !readinessResult.ready, re-request a
        // fresh DOM snapshot via requestPageSnapshot. If the fresh snapshot is
        // now ready (DOM has rendered), promote it to canonical.
        let snapshotCallCount = 0;

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
            snapshotCallCount++;
            const isFirstSnapshot = snapshotCallCount <= 1;

            // First snapshot: only user message (assistant-missing)
            // Subsequent snapshots: full conversation with assistant message
            const mapping = isFirstSnapshot
                ? {
                      root: { id: 'root', message: null, parent: null, children: ['u1'] },
                      u1: {
                          id: 'u1',
                          parent: 'root',
                          children: [],
                          message: {
                              id: 'u1',
                              author: { role: 'user', name: null, metadata: {} },
                              create_time: 1_700_000_010,
                              update_time: 1_700_000_010,
                              content: { content_type: 'text', parts: ['Prompt for thinking model'] },
                              status: 'finished_successfully',
                              end_turn: true,
                              weight: 1,
                              metadata: {},
                              recipient: 'all',
                              channel: null,
                          },
                      },
                  }
                : {
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
                              content: { content_type: 'text', parts: ['Prompt for thinking model'] },
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
                              content: { content_type: 'text', parts: ['Thinking model final answer'] },
                              status: 'finished_successfully',
                              end_turn: true,
                              weight: 1,
                              metadata: {},
                              recipient: 'all',
                              channel: null,
                          },
                      },
                  };

            postStampedMessage(
                {
                    type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE',
                    requestId: msg.requestId,
                    success: true,
                    data: {
                        title: 'Thinking Model Response',
                        create_time: 1_700_000_000,
                        update_time: 1_700_000_120,
                        conversation_id: '123',
                        current_node: isFirstSnapshot ? 'u1' : 'a1',
                        moderation_results: [],
                        plugin_ids: null,
                        gizmo_id: null,
                        gizmo_type: null,
                        is_archived: false,
                        default_model_slug: 'gpt',
                        safe_urls: [],
                        blocked_urls: [],
                        mapping,
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
                    attemptId: 'attempt:thinking-model',
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
                    attemptId: 'attempt:thinking-model',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );

            // Wait for initial probe + snapshot (assistant-missing) + some retries
            // that should re-request fresh snapshots
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // The snapshot handler should have been called more than once
            // (initial + at least one retry re-request)
            expect(snapshotCallCount).toBeGreaterThan(1);

            // After retries re-request the snapshot and get the full version,
            // the conversation should reach captured_ready (Save JSON, not Force Save)
            const saveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(saveButton).not.toBeNull();
            expect(saveButton?.disabled).toBeFalse();
            expect(saveButton?.textContent?.includes('Force Save')).toBeFalse();
        } finally {
            window.removeEventListener('message', snapshotResponseHandler as any);
        }
    }, 15_000);

    it('should not enable button when RESPONSE_FINISHED arrives during active generation (V2.1-019 flicker fix)', async () => {
        // During thinking/reasoning, the interceptor emits BLACKIYA_RESPONSE_FINISHED
        // for every stream_status poll. The handleResponseFinishedMessage handler
        // promotes lifecycleState to 'completed' before checking whether the platform
        // is still generating. When a ChatGPT stop button is present in the DOM,
        // this lifecycle corruption should be prevented because the signal is spurious.
        //
        // This test verifies that RESPONSE_FINISHED during prompt-sent + active
        // generation does NOT process the signal (button stays disabled).
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

        // Enter streaming phase
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:flicker-test',
                phase: 'prompt-sent',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Simulate ChatGPT's stop button being visible (model is thinking)
        const stopButton = document.createElement('button');
        stopButton.setAttribute('data-testid', 'stop-button');
        document.body.appendChild(stopButton);

        // Send RESPONSE_FINISHED while stop button is visible.
        // Without fix: lifecycleState is corrupted to 'completed'.
        // With fix: lifecycleState stays 'prompt-sent' (signal rejected).
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                attemptId: 'attempt:flicker-test',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Now send canonical data. If lifecycle was corrupted to 'completed',
        // handleResponseFinished from the callback would process the signal,
        // call scheduleButtonRefresh, start probes, etc. — eventually enabling
        // the button. If lifecycle stayed 'prompt-sent', the streaming guard
        // in refreshButtonState blocks button enabling.
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(
                    buildConversation('123', 'Final answer', {
                        status: 'finished_successfully',
                        endTurn: true,
                    }),
                ),
                attemptId: 'attempt:flicker-test',
            },
            window.location.origin,
        );

        // Wait enough for stabilization retries and SFE to reach captured_ready
        // (if lifecycle was wrongly 'completed', retries would be scheduled and
        // the button would enable via the canonical_ready path)
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Button must still be disabled — the streaming guard should have
        // blocked all button state transitions.
        const saveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveButton).not.toBeNull();
        expect(saveButton?.disabled).toBeTrue();

        stopButton.remove();
    }, 15_000);
});
