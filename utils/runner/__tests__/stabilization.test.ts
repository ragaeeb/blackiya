/**
 * Tests: Canonical stabilisation and SFE readiness transitions.
 *
 * Covers:
 *  - Single canonical sample promoted to ready after stabilisation retry
 *  - Degraded manual-only (Force Save) mode after hash never stabilises
 *  - Save enabled when RESPONSE_FINISHED arrives before canonical data (multi-tab)
 *  - Probe lease denied → "lease held by another tab" shown in probe
 *  - Parse failure in stream probe does NOT show toast
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

/** Full canonical conversation fixture returned by parseInterceptedData mock. */
const canonicalParsedData = () => ({
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

describe('Platform Runner – stabilisation', () => {
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

    it('should promote a single canonical sample to ready after stabilisation retry', async () => {
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            parseInterceptedData: canonicalParsedData,
        };

        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://test.com/backend-api/conversation/123',
                data: '{"ok":true}',
                attemptId: 'attempt:single-sample',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:single-sample',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );

        await new Promise((r) => setTimeout(r, 80));
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();

        await new Promise((r) => setTimeout(r, 1300));
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeFalse();
    });

    it('should enter degraded Force-Save mode when canonical hash never stabilises', async () => {
        let counter = 0;
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            evaluateReadiness: () => {
                counter += 1;

                return {
                    ready: true,
                    terminal: true,
                    reason: 'terminal',
                    contentHash: `unstable-${counter}`,
                    latestAssistantTextLength: 24,
                };
            },
            parseInterceptedData: canonicalParsedData,
        };

        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                url: 'https://test.com/backend-api/conversation/123',
                data: '{"ok":true}',
                attemptId: 'attempt:unstable',
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:unstable',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );

        await new Promise((r) => setTimeout(r, 120));
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();

        await new Promise((r) => setTimeout(r, 7600));
        const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveBtn?.disabled).toBeFalse();
        expect(saveBtn?.title).toContain('Force Save');
        expect(document.getElementById('blackiya-copy-btn')).toBeNull();
    }, 15_000);

    it('should enable Save when RESPONSE_FINISHED arrives before canonical data (multi-tab scenario)', async () => {
        const canonical = buildConversation('123', 'Full response text', {
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

        // Lifecycle without conversationId (tab was backgrounded, SSE stalled)
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:multitab',
                phase: 'prompt-sent',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:multitab',
                phase: 'streaming',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));

        // DOM watcher fires RESPONSE_FINISHED (no "completed" from SSE)
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                attemptId: 'attempt:multitab',
                conversationId: '123',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 50));

        // First canonical sample from interceptor's proactive fetch
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonical),
                attemptId: 'attempt:multitab',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 1200));

        // Second canonical sample for stability confirmation
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonical),
                attemptId: 'attempt:multitab',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 1500));

        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeFalse();
    }, 10_000);

    it('should skip stream probe when probe lease is denied by coordinator', async () => {
        let fetchCalls = 0;
        const origFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => {
            fetchCalls += 1;
            return { ok: true, text: async () => '{}' };
        };

        browserMockState.sendMessage = async (message: unknown) => {
            const typed = message as { type?: string };
            if (typed?.type === 'BLACKIYA_PROBE_LEASE_CLAIM') {
                return {
                    type: 'BLACKIYA_PROBE_LEASE_CLAIM_RESULT',
                    acquired: false,
                    ownerAttemptId: 'attempt:owner',
                    expiresAtMs: Date.now() + 10_000,
                };
            }
            return { type: 'BLACKIYA_PROBE_LEASE_RELEASE_RESULT', released: false };
        };

        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            buildApiUrls: () => ['https://test.com/backend-api/conversation/123'],
            parseInterceptedData: () => null,
        };

        try {
            runPlatform();
            await new Promise((r) => setTimeout(r, 80));

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
            await new Promise((r) => setTimeout(r, 40));

            expect(document.getElementById('blackiya-stream-probe')?.textContent).toContain(
                'stream-done: lease held by another tab',
            );
            expect(fetchCalls).toBe(0);
        } finally {
            (globalThis as any).fetch = origFetch;
        }
    });

    it('should not show parse-failure toast when stream probe cannot parse payload', async () => {
        const origFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => ({ ok: true, text: async () => '{"not":"conversation"}' });

        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            buildApiUrls: () => ['https://test.com/backend-api/conversation/123'],
            parseInterceptedData: () => null,
        };

        try {
            runPlatform();
            await new Promise((r) => setTimeout(r, 80));

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
            await new Promise((r) => setTimeout(r, 40));

            expect(
                document
                    .getElementById('blackiya-stream-probe')
                    ?.textContent?.includes('Could not parse conversation payload'),
            ).toBeFalse();
        } finally {
            (globalThis as any).fetch = origFetch;
        }
    });
});
