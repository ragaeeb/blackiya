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
import { resolveExportConversationTitle, runPlatform } from './platform-runner';

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

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-title',
                phase: 'completed',
                conversationId: 'gem-title-1',
            },
            window.location.origin,
        );
        postStampedMessage(
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
        postStampedMessage(
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
        expect(saveBtn?.disabled).toBeFalse();

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

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gem-title-2',
                phase: 'completed',
                conversationId: 'gem-title-2',
            },
            window.location.origin,
        );
        postStampedMessage(
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
        postStampedMessage(
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
        expect(saveBtn?.disabled).toBeFalse();

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

        postStampedMessage(
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

        postStampedMessage(
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

        postStampedMessage(
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

        postStampedMessage(
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

        postStampedMessage(
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

    it('should update lifecycle badge but keep save disabled for lifecycle messages without conversation context', async () => {
        runPlatform();
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Idle');

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-null-conv',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        postStampedMessage(
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
        // Badge should reflect the lifecycle phase, even without conversation context
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
        expect(saveBtn?.disabled).toBeTrue();
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

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-late-id',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        postStampedMessage(
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

        postStampedMessage(
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
        expect(saveBtn?.disabled).toBeTrue();
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

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-stream-guard',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:gemini-stream-guard',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        postStampedMessage(
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
        postStampedMessage(
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
        postStampedMessage(
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
        expect(saveDuringStream?.disabled).toBeTrue();

        postStampedMessage(
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
        expect(saveAfterFinish?.disabled).toBeFalse();
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

        postStampedMessage(
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

        postStampedMessage(
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

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Grok',
                attemptId: 'attempt:grok-canonical-finish',
                phase: 'prompt-sent',
                conversationId: 'grok-conv-1',
            },
            window.location.origin,
        );
        postStampedMessage(
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
        postStampedMessage(
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
});
