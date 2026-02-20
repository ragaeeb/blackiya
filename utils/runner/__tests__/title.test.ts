/**
 * Tests: Export title resolution.
 *
 * Covers:
 *  - Unit tests for resolveExportConversationTitle (generic title detection)
 *  - Integration: SSE title resolves mid-stream and is used at export time
 *  - Integration: Gemini DOM title fallback used when cached title is generic
 *  - Integration: Gemini DOM title fallback for "You said …" placeholder titles
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

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
    buildConversation,
    buildLoggerMock,
    createLoggerCalls,
    createMockAdapter,
    evaluateReadinessMock,
    makePostStampedMessage,
} from './helpers';

const downloadCalls: Array<{ data: unknown; filename: string }> = [];

let currentAdapterMock: any = createMockAdapter(document);
const browserMockState = {
    storageData: {} as Record<string, unknown>,
    sendMessage: async (_: unknown) => undefined as unknown,
};

mock.module('@/platforms/factory', () => ({
    getPlatformAdapter: () => currentAdapterMock,
    getPlatformAdapterByApiUrl: () => currentAdapterMock,
}));
mock.module('@/utils/download', () => ({
    downloadAsJSON: (data: unknown, filename: string) => downloadCalls.push({ data, filename }),
}));
mock.module('@/utils/logger', () => buildLoggerMock(createLoggerCalls()));
mock.module('wxt/browser', () => buildBrowserMock(browserMockState));

import { getSessionToken } from '@/utils/protocol/session-token';
import { resolveExportConversationTitle, runPlatform } from '@/utils/runner/platform-runtime';

const postStampedMessage = makePostStampedMessage(window as any, getSessionToken);

describe('Platform Runner – export title resolution', () => {
    beforeEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
        document.body.innerHTML = '';
        downloadCalls.length = 0;
        currentAdapterMock = createMockAdapter(document);
        browserMockState.storageData = {};
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

    it('should derive export title from first user message when title is generic', () => {
        const conv = buildConversation('gem-1', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conv.title = 'Google Gemini';
        (conv.mapping.u1.message.content as any).parts = ['Tafsir of Quranic Verses on Gender'];
        expect(resolveExportConversationTitle(conv as any)).toContain('Tafsir of Quranic Verses on Gender');
    });

    it('should treat "Chats" as non-exportable and derive from first user message', () => {
        const conv = buildConversation('gem-1b', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conv.title = 'Chats';
        (conv.mapping.u1.message.content as any).parts = ['Tafsir of Prayer of Fear Verse'];
        expect(resolveExportConversationTitle(conv as any)).toBe('Tafsir of Prayer of Fear Verse');
    });

    it('should treat "Conversation with Gemini" as generic and derive export title', () => {
        const conv = buildConversation('gem-1c', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conv.title = 'Conversation with Gemini';
        (conv.mapping.u1.message.content as any).parts = ['Vessels of Gold and Silver'];
        expect(resolveExportConversationTitle(conv as any)).toBe('Vessels of Gold and Silver');
    });

    it('should treat "You said …" placeholder title as generic and derive export title', () => {
        const conv = buildConversation('gem-1d', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conv.title = 'You said ROLE: Expert academic translator';
        (conv.mapping.u1.message.content as any).parts = ['Discussion on Istinja Rulings'];
        expect(resolveExportConversationTitle(conv as any)).toBe('Discussion on Istinja Rulings');
    });

    it('should keep explicit non-generic export title unchanged', () => {
        const conv = buildConversation('gem-2', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conv.title = 'Custom Thread Title';
        expect(resolveExportConversationTitle(conv as any)).toBe('Custom Thread Title');
    });

    it('should update cached title when BLACKIYA_TITLE_RESOLVED arrives from SSE stream', async () => {
        const staleConv = buildConversation('123', 'Full response text', {
            status: 'finished_successfully',
            endTurn: true,
        });
        staleConv.title = 'ROLE: Expert academic translator of Classical Islamic texts; prioritize accur...';

        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            evaluateReadiness: evaluateReadinessMock,
            formatFilename: (data: { title: string }) => data.title.replace(/[^a-zA-Z0-9]/g, '_'),
            parseInterceptedData: (raw: string) => {
                try {
                    const p = JSON.parse(raw);
                    return p?.conversation_id ? p : null;
                } catch {
                    return null;
                }
            },
        };

        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

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
        await new Promise((r) => setTimeout(r, 30));
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
        await new Promise((r) => setTimeout(r, 30));

        // Fresh title arrives mid-stream
        postStampedMessage(
            {
                type: 'BLACKIYA_TITLE_RESOLVED',
                platform: 'ChatGPT',
                attemptId: 'attempt:title-test',
                conversationId: '123',
                title: 'Translation of Maytah Prohibition',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));

        // Ingest stale-titled canonical data
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(staleConv),
                attemptId: 'attempt:title-test',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 80));

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
        await new Promise((r) => setTimeout(r, 1500));

        // Second canonical sample for stabilisation
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(staleConv),
                attemptId: 'attempt:title-test',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 1500));

        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveBtn?.disabled).toBeFalse();

        downloadCalls.length = 0;
        saveBtn?.click();
        await new Promise((r) => setTimeout(r, 200));

        expect(downloadCalls.length).toBeGreaterThanOrEqual(1);
        expect((downloadCalls[0].data as any).title).toBe('Translation of Maytah Prohibition');
        expect(downloadCalls[0].filename).toContain('Translation');
    }, 15_000);

    it('should use Gemini DOM title fallback on Save when cached title is generic', async () => {
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'Gemini',
            extractConversationId: () => 'gem-title-1',
            evaluateReadiness: evaluateReadinessMock,
            defaultTitles: ['Gemini Conversation', 'Google Gemini'],
            extractTitleFromDom: () => 'Discussion on Quranic Verse Meanings',
            formatFilename: (data: { title: string }) => data.title.replace(/[^a-zA-Z0-9]/g, '_'),
            parseInterceptedData: (raw: string) => {
                try {
                    const p = JSON.parse(raw);
                    return p?.conversation_id ? p : null;
                } catch {
                    return null;
                }
            },
        };

        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

        const conv = buildConversation('gem-title-1', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conv.title = 'Gemini Conversation';

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
                data: JSON.stringify(conv),
                attemptId: 'attempt:gem-title',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 1000));
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
                data: JSON.stringify(conv),
                attemptId: 'attempt:gem-title',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 200));

        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveBtn?.disabled).toBeFalse();
        saveBtn?.click();
        await new Promise((r) => setTimeout(r, 100));

        expect(downloadCalls.length).toBeGreaterThanOrEqual(1);
        expect((downloadCalls.at(-1)?.data as any).title).toBe('Discussion on Quranic Verse Meanings');
        expect(downloadCalls.at(-1)?.filename).toContain('Discussion_on_Quranic_Verse_Meanings');
    }, 10_000);

    it('should use Gemini DOM title fallback when cached title is a "You said …" placeholder', async () => {
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'Gemini',
            extractConversationId: () => 'gem-title-2',
            evaluateReadiness: evaluateReadinessMock,
            defaultTitles: ['Gemini Conversation', 'Google Gemini', 'Conversation with Gemini'],
            extractTitleFromDom: () => "Discussion on Istinja' Rulings",
            formatFilename: (data: { title: string }) => data.title.replace(/[^a-zA-Z0-9]/g, '_'),
            parseInterceptedData: (raw: string) => {
                try {
                    const p = JSON.parse(raw);
                    return p?.conversation_id ? p : null;
                } catch {
                    return null;
                }
            },
        };

        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

        const conv = buildConversation('gem-title-2', 'Assistant response', {
            status: 'finished_successfully',
            endTurn: true,
        });
        conv.title = 'You said ROLE: Expert academic translator';
        (conv.mapping.u1.message.content as any).parts = ['You said ROLE: Expert academic translator'];

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
                data: JSON.stringify(conv),
                attemptId: 'attempt:gem-title-2',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 1000));
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'Gemini',
                url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
                data: JSON.stringify(conv),
                attemptId: 'attempt:gem-title-2',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 200));

        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveBtn?.disabled).toBeFalse();
        saveBtn?.click();
        await new Promise((r) => setTimeout(r, 100));

        expect(downloadCalls.length).toBeGreaterThanOrEqual(1);
        expect((downloadCalls.at(-1)?.data as any).title).toBe("Discussion on Istinja' Rulings");
        expect(downloadCalls.at(-1)?.filename).toContain('Discussion_on_Istinja__Rulings');
    }, 10_000);
});
