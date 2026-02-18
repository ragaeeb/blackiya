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

// Import subject under test AFTER mocking
import {
    beginCanonicalStabilizationTick,
    clearCanonicalStabilizationAttemptState,
    resolveExportConversationTitle,
    resolveShouldSkipCanonicalRetryAfterAwait,
    runPlatform,
    shouldRemoveDisposedAttemptBinding,
} from './platform-runner';

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

    it('should derive export title from first user message when title is generic', () => {
        const conversation = buildConversation('gem-1', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conversation.title = 'Google Gemini';
        conversation.mapping.u1.message.content.parts = ['Tafsir of Quranic Verses on Gender'];

        const resolved = resolveExportConversationTitle(conversation as any);
        expect(resolved).toContain('Tafsir of Quranic Verses on Gender');
    });

    it('should treat generic Gemini sidebar title as non-exportable and derive from first user message', () => {
        const conversation = buildConversation('gem-1b', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conversation.title = 'Chats';
        conversation.mapping.u1.message.content.parts = ['Tafsir of Prayer of Fear Verse'];

        const resolved = resolveExportConversationTitle(conversation as any);
        expect(resolved).toBe('Tafsir of Prayer of Fear Verse');
    });

    it('should treat "Conversation with Gemini" as generic and derive export title', () => {
        const conversation = buildConversation('gem-1c', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conversation.title = 'Conversation with Gemini';
        conversation.mapping.u1.message.content.parts = ['Vessels of Gold and Silver'];

        const resolved = resolveExportConversationTitle(conversation as any);
        expect(resolved).toBe('Vessels of Gold and Silver');
    });

    it('should treat Gemini "You said ..." placeholder title as generic and derive export title', () => {
        const conversation = buildConversation('gem-1d', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conversation.title = 'You said ROLE: Expert academic translator';
        conversation.mapping.u1.message.content.parts = ['Discussion on Istinja Rulings'];

        const resolved = resolveExportConversationTitle(conversation as any);
        expect(resolved).toBe('Discussion on Istinja Rulings');
    });

    it('should keep explicit non-generic export title', () => {
        const conversation = buildConversation('gem-2', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conversation.title = 'Custom Thread Title';

        const resolved = resolveExportConversationTitle(conversation as any);
        expect(resolved).toBe('Custom Thread Title');
    });

    it('should use Gemini DOM title fallback on Save when cached title is generic', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Gemini',
            extractConversationId: () => 'gem-title-1',
            evaluateReadiness: evaluateReadinessMock,
            defaultTitles: ['Gemini Conversation', 'Google Gemini'],
            extractTitleFromDom: () => 'Discussion on Quranic Verse Meanings',
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

        const conversation = buildConversation('gem-title-1', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conversation.title = 'Gemini Conversation';

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-title',
                phase: 'completed',
                conversationId: 'gem-title-1',
            },
            window.location.origin,
        );
        window.postMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
                data: JSON.stringify(conversation),
                attemptId: 'attempt:gem-title',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
        window.postMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
                data: JSON.stringify(conversation),
                attemptId: 'attempt:gem-title',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));

        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveBtn?.disabled).toBe(false);

        saveBtn?.click();
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(downloadCalls.length).toBeGreaterThanOrEqual(1);
        const payload = downloadCalls.at(-1)?.data as Record<string, unknown>;
        expect(payload.title).toBe('Discussion on Quranic Verse Meanings');
        expect(downloadCalls.at(-1)?.filename).toContain('Discussion_on_Quranic_Verse_Meanings');
    }, 10_000);

    it('should use Gemini DOM title fallback on Save when cached title is a "You said ..." placeholder', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Gemini',
            extractConversationId: () => 'gem-title-2',
            evaluateReadiness: evaluateReadinessMock,
            defaultTitles: ['Gemini Conversation', 'Google Gemini', 'Conversation with Gemini'],
            extractTitleFromDom: () => "Discussion on Istinja' Rulings",
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

        const conversation = buildConversation('gem-title-2', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conversation.title = 'You said ROLE: Expert academic translator';
        conversation.mapping.u1.message.content.parts = ['You said ROLE: Expert academic translator'];

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-title-2',
                phase: 'completed',
                conversationId: 'gem-title-2',
            },
            window.location.origin,
        );
        window.postMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
                data: JSON.stringify(conversation),
                attemptId: 'attempt:gem-title-2',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
        window.postMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
                data: JSON.stringify(conversation),
                attemptId: 'attempt:gem-title-2',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));

        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveBtn?.disabled).toBe(false);

        saveBtn?.click();
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(downloadCalls.length).toBeGreaterThanOrEqual(1);
        const payload = downloadCalls.at(-1)?.data as Record<string, unknown>;
        expect(payload.title).toBe("Discussion on Istinja' Rulings");
        expect(downloadCalls.at(-1)?.filename).toContain('Discussion_on_Istinja__Rulings');
    }, 10_000);

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

    it('should block lifecycle regression from completed to streaming for same attempt and conversation', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:monotonic-1',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:monotonic-1',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');
    });

    it('should ignore lifecycle messages without conversation context', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Idle');

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-null-conv',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-null-conv',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Idle');
        expect(saveBtn?.disabled).toBe(true);
    });

    it('should replay pending Gemini lifecycle once conversation ID resolves mid-stream', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Gemini',
            extractConversationId: () => null,
            evaluateReadiness: evaluateReadinessMock,
        };
        delete (window as any).location;
        (window as any).location = {
            href: 'https://gemini.google.com/app',
            origin: 'https://gemini.google.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-late-id',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-late-id',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));

        window.postMessage(
            {
                type: 'BLACKIYA_CONVERSATION_ID_RESOLVED',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-late-id',
                conversationId: 'gem-late-1',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));

        const badge = document.getElementById('blackiya-lifecycle-badge');
        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(badge?.textContent).toContain('Streaming');
        expect(saveBtn?.disabled).toBe(true);
    });

    it('should keep Gemini Save disabled while streaming even after canonical samples arrive before completion', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Gemini',
            extractConversationId: () => null,
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
            href: 'https://gemini.google.com/app',
            origin: 'https://gemini.google.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-stream-guard',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-stream-guard',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        window.postMessage(
            {
                type: 'BLACKIYA_CONVERSATION_ID_RESOLVED',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-stream-guard',
                conversationId: 'gem-late-2',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 60));

        const canonicalConversation = buildConversation('gem-late-2', 'Assistant final answer', {
            status: 'finished_successfully',
            endTurn: true,
        });
        window.postMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:gemini-stream-guard',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 950));
        window.postMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:gemini-stream-guard',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 120));

        const saveDuringStream = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
        expect(saveDuringStream?.disabled).toBe(true);

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-stream-guard',
                conversationId: 'gem-late-2',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 120));

        const saveAfterFinish = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');
        expect(saveAfterFinish?.disabled).toBe(false);
    }, 10_000);

    it('should accept Gemini RESPONSE_FINISHED while streaming even if DOM has generating markers', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Gemini',
            extractConversationId: () => 'gem-finish-1',
            evaluateReadiness: evaluateReadinessMock,
        };
        delete (window as any).location;
        (window as any).location = {
            href: 'https://gemini.google.com/app/gem-finish-1',
            origin: 'https://gemini.google.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-finish-guard',
                phase: 'streaming',
                conversationId: 'gem-finish-1',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');

        const marker = document.createElement('div');
        marker.className = 'still-generating streaming-marker';
        document.body.appendChild(marker);

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'Gemini',
                attemptId: 'attempt:gem-finish-guard',
                conversationId: 'gem-finish-1',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');
    });

    it('should promote Grok lifecycle to completed when canonical-ready capture arrives from conversations/new', async () => {
        currentAdapterMock = {
            ...createMockAdapter(),
            name: 'Grok',
            extractConversationId: () => 'grok-conv-1',
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
            href: 'https://grok.com/c/grok-conv-1',
            origin: 'https://grok.com',
        };

        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 120));

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-canonical-finish',
                phase: 'prompt-sent',
                conversationId: 'grok-conv-1',
            },
            window.location.origin,
        );
        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-canonical-finish',
                phase: 'streaming',
                conversationId: 'grok-conv-1',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');

        const canonicalConversation = buildConversation('grok-conv-1', 'Grok final answer', {
            status: 'finished_successfully',
            endTurn: true,
        });
        window.postMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Grok',
                url: 'https://grok.com/rest/app-chat/conversations/new',
                data: JSON.stringify(canonicalConversation),
                attemptId: 'attempt:grok-canonical-finish',
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

        window.postMessage(
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
        expect(saveBtn?.disabled).toBe(true);

        const panelText = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
        expect(panelText.includes('stream-done: no api url candidates')).toBe(false);
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
        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-health',
                phase: 'completed',
                conversationId: 'gem-conv-1',
            },
            window.location.origin,
        );
        window.postMessage(
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
        expect(saveAfter?.disabled).toBe(true);
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

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-ready-log',
                phase: 'completed',
                conversationId: 'gem-ready-log',
            },
            window.location.origin,
        );
        window.postMessage(
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
        window.postMessage(
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

    it('should append live stream delta text from non-ChatGPT platforms', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        window.postMessage(
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

    it('should tear down previous runner instance before starting a new one', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(document.querySelectorAll('#blackiya-button-container').length).toBe(1);
        expect(document.querySelectorAll('#blackiya-save-btn').length).toBe(1);
        expect(document.querySelectorAll('#blackiya-copy-btn').length).toBe(1);
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

        await new Promise((resolve) => setTimeout(resolve, 7600));
        const saveFallback = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        const copyFallback = document.getElementById('blackiya-copy-btn') as HTMLButtonElement | null;
        expect(saveFallback?.disabled).toBe(false);
        expect(saveFallback?.textContent).toContain('Force Save');
        expect(copyFallback?.disabled).toBe(true);
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
                    phase: 'prompt-sent',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((resolve) => setTimeout(resolve, 20));

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
            expect(saveButton?.disabled).toBe(false);
            expect(saveButton?.textContent?.includes('Force Save')).toBe(false);
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
            expect(degradedSaveButton?.disabled).toBe(true);
            expect(degradedSaveButton?.textContent?.includes('Force Save')).toBe(false);

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
            await new Promise((resolve) => setTimeout(resolve, 1050));
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
            await new Promise((resolve) => setTimeout(resolve, 250));

            const recoveredSaveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(recoveredSaveButton?.disabled).toBe(false);
            expect(recoveredSaveButton?.textContent).not.toContain('Force Save');
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

            // 1. Send prompt-sent
            window.postMessage(
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
            window.postMessage(
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
            expect(degradedSaveButton?.disabled).toBe(true);

            // 3. Send ONE canonical API capture (simulates the interceptor's proactive fetch)
            window.postMessage(
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
            expect(recoveredSaveButton?.disabled).toBe(false);
            expect(recoveredSaveButton?.textContent).not.toContain('Force Save');
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

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:no-flicker',
                phase: 'prompt-sent',
                conversationId: '123',
            },
            window.location.origin,
        );

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:no-flicker',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );

        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:no-flicker',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );

        window.postMessage(
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

        window.postMessage(
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
        expect(saveBtn?.disabled).toBe(false);

        const stopButton = document.createElement('button');
        stopButton.setAttribute('data-testid', 'stop-button');
        stopButton.disabled = false;
        document.body.appendChild(stopButton);

        await new Promise((resolve) => setTimeout(resolve, 1700));

        window.postMessage(
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
        expect(saveAfterHint?.disabled).toBe(false);
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
        window.postMessage(
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
        window.postMessage(
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
        window.postMessage(
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
        window.postMessage(
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
        window.postMessage(
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
        expect(saveButton?.disabled).toBe(false);
    }, 10_000);

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

        window.postMessage(
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
        window.postMessage(
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
        expect(saveBeforeGeneration?.disabled).toBe(false);

        const stopButton = document.createElement('button');
        stopButton.setAttribute('data-testid', 'stop-button');
        stopButton.disabled = false;
        document.body.appendChild(stopButton);

        for (let i = 0; i < 5; i += 1) {
            window.postMessage(
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
        expect(saveDuringGeneration?.disabled).toBe(true);
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
            window.postMessage(
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

            window.postMessage(
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

            window.postMessage(
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
            window.postMessage(
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

            window.postMessage(
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
            expect(saveAfterSnapshot?.disabled).toBe(false);
            expect(saveAfterSnapshot?.textContent?.includes('Force Save')).toBe(false);
        } finally {
            window.removeEventListener('message', snapshotResponseHandler as any);
        }
    }, 15_000);

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
            window.postMessage(
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
        window.postMessage(
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

        window.postMessage(
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

        window.postMessage(
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
        expect(panelText.includes('delta-after-same-conversation-navigation')).toBe(true);
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

        window.postMessage(
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

        window.postMessage(
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
        expect(panelText.includes('delta-from-disposed-old-conversation')).toBe(false);
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
        window.postMessage(
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

        window.postMessage(
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
        window.postMessage(
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
        window.postMessage(
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
        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:title-test',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );
        window.postMessage(
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
        window.postMessage(
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
        expect(saveBtn?.disabled).toBe(false);

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
        window.postMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:nav-retry',
                phase: 'prompt-sent',
            },
            window.location.origin,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        window.postMessage(
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
        window.postMessage(
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
        window.postMessage(
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
        window.postMessage(
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
        window.postMessage(
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
        expect(saveButton?.disabled).toBe(false);
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

            window.postMessage(
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

            window.postMessage(
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

            window.postMessage(
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
            expect(saveButton?.disabled).toBe(false);
            expect(saveButton?.textContent?.includes('Force Save')).toBe(false);
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
        window.postMessage(
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
        window.postMessage(
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
        window.postMessage(
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
        expect(saveButton?.disabled).toBe(true);

        stopButton.remove();
    }, 15_000);
});

describe('shouldRemoveDisposedAttemptBinding', () => {
    const resolveFromMap = (aliases: Record<string, string>) => (attemptId: string) => {
        let current = attemptId;
        const visited = new Set<string>();
        while (aliases[current] && !visited.has(current)) {
            visited.add(current);
            current = aliases[current];
        }
        return current;
    };

    it('removes mapped attempts that resolve to disposed canonical attempt', () => {
        const resolve = resolveFromMap({
            'attempt:raw-a': 'attempt:raw-b',
            'attempt:raw-b': 'attempt:canonical-c',
        });
        expect(shouldRemoveDisposedAttemptBinding('attempt:raw-a', 'attempt:raw-b', resolve)).toBe(true);
    });

    it('keeps mapped attempts that resolve to a different canonical attempt', () => {
        const resolve = resolveFromMap({
            'attempt:raw-a': 'attempt:canonical-a',
            'attempt:raw-b': 'attempt:canonical-b',
        });
        expect(shouldRemoveDisposedAttemptBinding('attempt:raw-a', 'attempt:raw-b', resolve)).toBe(false);
    });
});

describe('canonical stabilization retry helpers', () => {
    it('allows only one in-flight retry tick per attempt', () => {
        const inProgress = new Set<string>();
        expect(beginCanonicalStabilizationTick('attempt-1', inProgress)).toBe(true);
        expect(beginCanonicalStabilizationTick('attempt-1', inProgress)).toBe(false);
        expect(inProgress.has('attempt-1')).toBe(true);
    });

    it('clears retry timer/count/start/timeout state in one call', () => {
        const timerIds = new Map<string, number>([['attempt-1', 101]]);
        const retryCounts = new Map<string, number>([['attempt-1', 3]]);
        const startedAt = new Map<string, number>([['attempt-1', 999]]);
        const timeoutWarnings = new Set<string>(['attempt-1']);
        const inProgress = new Set<string>(['attempt-1']);
        const clearedTimers: number[] = [];

        clearCanonicalStabilizationAttemptState(
            'attempt-1',
            {
                timerIds,
                retryCounts,
                startedAt,
                timeoutWarnings,
                inProgress,
            },
            (timerId) => {
                clearedTimers.push(timerId);
            },
        );

        expect(clearedTimers).toEqual([101]);
        expect(timerIds.has('attempt-1')).toBe(false);
        expect(retryCounts.has('attempt-1')).toBe(false);
        expect(startedAt.has('attempt-1')).toBe(false);
        expect(timeoutWarnings.has('attempt-1')).toBe(false);
        expect(inProgress.has('attempt-1')).toBe(false);
    });

    it('re-checks disposal and conversation mismatch after await boundaries', () => {
        const disposed = resolveShouldSkipCanonicalRetryAfterAwait(
            'attempt-1',
            'conv-1',
            true,
            undefined,
            (attemptId) => attemptId,
        );
        expect(disposed).toBe(true);

        const mismatched = resolveShouldSkipCanonicalRetryAfterAwait(
            'attempt-1',
            'conv-1',
            false,
            'attempt-2',
            (attemptId) => attemptId,
        );
        expect(mismatched).toBe(true);

        const canonicalAliasMatch = resolveShouldSkipCanonicalRetryAfterAwait(
            'attempt-1',
            'conv-1',
            false,
            'alias-attempt-1',
            (attemptId) => (attemptId === 'alias-attempt-1' ? 'attempt-1' : attemptId),
        );
        expect(canonicalAliasMatch).toBe(false);
    });
});
