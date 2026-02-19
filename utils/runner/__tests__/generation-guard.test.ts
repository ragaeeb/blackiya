/**
 * Tests: Generation guard – Save must stay disabled during active AI generation.
 *
 * Covers:
 *  - Save disabled while streaming even when cached data is ready
 *  - Save disabled for ChatGPT thoughts-only captures even after fallback window
 *  - Save stays enabled after canonical-ready despite transient DOM stop-button re-checks
 *  - Recovery from blocked network finished → Save enabled after DOM completion transition
 *  - Save disabled during active generation despite repeated network finished hints
 *  - RESPONSE_FINISHED spuriously rejected when stop-button is visible (V2.1-019 flicker fix)
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { STORAGE_KEYS } from '@/utils/settings';

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

let currentAdapterMock: any = createMockAdapter(document);
const browserMockState = {
    storageData: {} as Record<string, unknown>,
    sendMessage: async (_: unknown) => undefined as unknown,
};

mock.module('@/platforms/factory', () => ({
    getPlatformAdapter: () => currentAdapterMock,
    getPlatformAdapterByApiUrl: () => currentAdapterMock,
}));
mock.module('@/utils/download', () => ({ downloadAsJSON: () => {} }));
mock.module('@/utils/logger', () => buildLoggerMock(createLoggerCalls()));
mock.module('wxt/browser', () => buildBrowserMock(browserMockState));

import { runPlatform } from '@/utils/platform-runner';
import { getSessionToken } from '@/utils/protocol/session-token';

const postStampedMessage = makePostStampedMessage(window as any, getSessionToken);

describe('Platform Runner – generation guard', () => {
    beforeEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
        document.body.innerHTML = '';
        currentAdapterMock = createMockAdapter(document);
        browserMockState.storageData = { [STORAGE_KEYS.STREAM_PROBE_VISIBLE]: true };
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

    it('should keep Save disabled while streaming even when cached data is ready', async () => {
        const ready = buildConversation('123', 'Canonical ready answer', {
            status: 'finished_successfully',
            endTurn: true,
        });
        currentAdapterMock = {
            ...createMockAdapter(document),
            evaluateReadiness: evaluateReadinessMock,
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

        // Seed with canonical data + stabilise
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'TestPlatform',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(ready),
                attemptId: 'attempt:seed',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 40));
        await new Promise((r) => setTimeout(r, 950));
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'TestPlatform',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(ready),
                attemptId: 'attempt:seed',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 40));
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'TestPlatform',
                attemptId: 'attempt:seed',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeFalse();

        // New prompt arrives → streaming → RESPONSE_FINISHED → should lock Save again
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'TestPlatform',
                attemptId: 'attempt:new',
                phase: 'prompt-sent',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'TestPlatform',
                attemptId: 'attempt:new',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'TestPlatform',
                attemptId: 'attempt:new',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 20));

        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();
    });

    it('should keep Save disabled for ChatGPT thoughts-only captures even after fallback window', async () => {
        currentAdapterMock = {
            ...createMockAdapter(document),
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
        await new Promise((r) => setTimeout(r, 80));

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://test.com/backend-api/conversation/123',
                data: '{"ok":true}',
                attemptId: 'attempt:thoughts',
            },
            window.location.origin,
        );

        await new Promise((r) => setTimeout(r, 3800));
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();
    });

    it('should keep Save enabled after canonical-ready despite transient DOM stop-button re-checks', async () => {
        const canonical = buildConversation('123', 'Stable canonical answer', {
            status: 'finished_successfully',
            endTurn: true,
        });
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            evaluateReadiness: evaluateReadinessMock,
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
                attemptId: 'attempt:noflicker',
                phase: 'prompt-sent',
                conversationId: '123',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:noflicker',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:noflicker',
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
                data: JSON.stringify(canonical),
                attemptId: 'attempt:noflicker',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 1050));
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonical),
                attemptId: 'attempt:noflicker',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 180));
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeFalse();

        // Simulate stop button reappearing (transient generating marker)
        const stopButton = document.createElement('button');
        stopButton.setAttribute('data-testid', 'stop-button');
        stopButton.disabled = false;
        document.body.appendChild(stopButton);
        await new Promise((r) => setTimeout(r, 1700));

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                source: 'completion-endpoint',
                attemptId: 'attempt:noflicker',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 120));

        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeFalse();
    }, 15_000);

    it('should recover from blocked network finished and enable Save after DOM completion transition', async () => {
        const canonical = buildConversation('123', 'Long reasoning answer', {
            status: 'finished_successfully',
            endTurn: true,
        });
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            evaluateReadiness: evaluateReadinessMock,
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
                attemptId: 'attempt:dom-recovery',
                phase: 'prompt-sent',
                conversationId: '123',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:dom-recovery',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 80));

        const stopButton = document.createElement('button');
        stopButton.setAttribute('data-testid', 'stop-button');
        stopButton.disabled = false;
        document.body.appendChild(stopButton);

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                attemptId: 'attempt:dom-recovery',
                conversationId: '123',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonical),
                attemptId: 'attempt:dom-recovery',
            },
            window.location.origin,
        );

        await new Promise((r) => setTimeout(r, 900));
        await new Promise((r) => setTimeout(r, 120));
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();

        stopButton.remove();
        await new Promise((r) => setTimeout(r, 1100));

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonical),
                attemptId: 'attempt:dom-recovery',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 1500));

        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveBtn?.disabled).toBeFalse();
        expect(saveBtn?.title?.includes('Force Save')).toBeFalse();
    }, 12_000);

    it('should keep Save disabled during active generation despite repeated network finished hints', async () => {
        const canonical = buildConversation('123', 'Ready canonical answer', {
            status: 'finished_successfully',
            endTurn: true,
        });
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            evaluateReadiness: evaluateReadinessMock,
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

        // Seed ready data
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonical),
                attemptId: 'attempt:gen-guard',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 1050));
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonical),
                attemptId: 'attempt:gen-guard',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 200));
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeFalse();

        // Stop button simulates ongoing generation
        const stopButton = document.createElement('button');
        stopButton.setAttribute('data-testid', 'stop-button');
        stopButton.disabled = false;
        document.body.appendChild(stopButton);

        for (let i = 0; i < 5; i += 1) {
            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_FINISHED',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:gen-guard',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((r) => setTimeout(r, 40));
        }

        await new Promise((r) => setTimeout(r, 120));
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();
    }, 15_000);

    it('should not enable button when RESPONSE_FINISHED arrives during active generation (V2.1-019 flicker fix)', async () => {
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            evaluateReadiness: evaluateReadinessMock,
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
                attemptId: 'attempt:flicker',
                phase: 'prompt-sent',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 50));

        const stopButton = document.createElement('button');
        stopButton.setAttribute('data-testid', 'stop-button');
        document.body.appendChild(stopButton);

        // RESPONSE_FINISHED while stop button is visible → should be rejected
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                attemptId: 'attempt:flicker',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 50));

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(
                    buildConversation('123', 'Final answer', { status: 'finished_successfully', endTurn: true }),
                ),
                attemptId: 'attempt:flicker',
            },
            window.location.origin,
        );

        await new Promise((r) => setTimeout(r, 3000));
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();
        stopButton.remove();
    }, 15_000);
});
