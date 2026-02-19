/**
 * Tests: DOM snapshot capture – fallback mode, promotion to canonical, and security.
 *
 * Covers:
 *  - Re-requests fresh snapshot when cached one has assistant-missing (V2.1-019)
 *  - Unstamped snapshot responses are ignored (security)
 *  - Ready snapshot promoted to canonical when warm fetch fails (V2.1-018)
 *  - Degraded snapshot mode upgrades to canonical-ready when API capture arrives
 *  - Fidelity promoted to high when canonical API capture arrives after degraded snapshot (V2.1-015)
 *  - Save stays enabled when a late degraded snapshot arrives after canonical-ready
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

/** Helper: attach a snapshot response listener that replies with the given data. */
const attachSnapshotResponder = (makeData: (requestCount: number) => unknown) => {
    let count = 0;
    const handler = (event: MessageEvent) => {
        const msg = (event as any).data;
        if (msg?.type !== 'BLACKIYA_PAGE_SNAPSHOT_REQUEST') {
            return;
        }
        count += 1;
        postStampedMessage(
            { type: 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE', requestId: msg.requestId, success: true, data: makeData(count) },
            window.location.origin,
        );
    };
    window.addEventListener('message', handler as any);
    return {
        get callCount() {
            return count;
        },
        dispose: () => window.removeEventListener('message', handler as any),
    };
};

describe('Platform Runner – snapshot capture', () => {
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

    it('should re-request fresh DOM snapshot when cached snapshot has assistant-missing (V2.1-019)', async () => {
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

        // First snapshot: user-only (assistant-missing). Subsequent: full conversation.
        const responder = attachSnapshotResponder((count) => ({
            title: 'Thinking Model Response',
            create_time: 1_700_000_000,
            update_time: 1_700_000_120,
            conversation_id: '123',
            current_node: count <= 1 ? 'u1' : 'a1',
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'gpt',
            safe_urls: [],
            blocked_urls: [],
            mapping:
                count <= 1
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
                      },
        }));

        try {
            runPlatform();
            await new Promise((r) => setTimeout(r, 80));

            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:thinking',
                    phase: 'prompt-sent',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((r) => setTimeout(r, 20));
            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:thinking',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );

            await new Promise((r) => setTimeout(r, 5000));

            expect(responder.callCount).toBeGreaterThan(1);
            const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(saveBtn?.disabled).toBeFalse();
            expect(saveBtn?.title?.includes('Force Save')).toBeFalse();
        } finally {
            responder.dispose();
        }
    }, 15_000);

    it('should ignore unstamped page snapshot responses', async () => {
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            buildApiUrls: () => [],
            parseInterceptedData: () => null,
        };

        const unstampedHandler = (event: MessageEvent) => {
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

        window.addEventListener('message', unstampedHandler as any);
        try {
            runPlatform();
            await new Promise((r) => setTimeout(r, 80));

            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:unstamped',
                    phase: 'prompt-sent',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((r) => setTimeout(r, 20));
            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:unstamped',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );

            await new Promise((r) => setTimeout(r, 2800));

            const text = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
            expect(text.includes('UNSTAMPED SNAPSHOT SHOULD NOT APPLY')).toBeFalse();
            expect(text.includes('stream-done: degraded snapshot captured')).toBeFalse();
        } finally {
            window.removeEventListener('message', unstampedHandler as any);
        }
    });

    it('should promote ready snapshot to canonical when warm fetch fails (V2.1-018)', async () => {
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

        const responder = attachSnapshotResponder(() =>
            buildConversation('123', 'Final answer from snapshot', { status: 'finished_successfully', endTurn: true }),
        );

        try {
            runPlatform();
            await new Promise((r) => setTimeout(r, 80));

            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:snap-fallback',
                    phase: 'prompt-sent',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((r) => setTimeout(r, 20));
            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:snap-fallback',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );

            await new Promise((r) => setTimeout(r, 1700));
            const text = document.getElementById('blackiya-stream-probe')?.textContent ?? '';
            expect(text).toContain('stream-done: degraded snapshot captured');
            expect(text).toContain('Final answer from snapshot');

            await new Promise((r) => setTimeout(r, 3000));
            const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(saveBtn?.disabled).toBeFalse();
            expect(saveBtn?.title?.includes('Force Save')).toBeFalse();
        } finally {
            responder.dispose();
        }
    }, 15_000);

    it('should upgrade from degraded snapshot mode to canonical-ready when API capture arrives', async () => {
        const canonical = buildConversation('123', 'Canonical answer from API', {
            status: 'finished_successfully',
            endTurn: true,
        });
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            buildApiUrls: () => [],
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

        const responder = attachSnapshotResponder(() =>
            buildConversation('123', 'Snapshot partial answer', { status: 'finished_successfully', endTurn: true }),
        );
        try {
            runPlatform();
            await new Promise((r) => setTimeout(r, 80));

            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:recover',
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
                    attemptId: 'attempt:recover',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((r) => setTimeout(r, 700));

            expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();

            postStampedMessage(
                {
                    type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                    platform: 'ChatGPT',
                    url: 'https://chatgpt.com/backend-api/conversation/123',
                    data: JSON.stringify(canonical),
                    attemptId: 'attempt:recover',
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
                    attemptId: 'attempt:recover',
                },
                window.location.origin,
            );
            await new Promise((r) => setTimeout(r, 250));

            const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(saveBtn?.disabled).toBeFalse();
            expect(saveBtn?.title).not.toContain('Force Save');
        } finally {
            responder.dispose();
        }
    });

    it('should promote fidelity to high when canonical API capture arrives after degraded snapshot (V2.1-015)', async () => {
        const canonical = buildConversation('123', 'Full canonical response from API', {
            status: 'finished_successfully',
            endTurn: true,
        });
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            buildApiUrls: () => [],
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

        const responder = attachSnapshotResponder(() =>
            buildConversation('123', 'Snapshot partial answer', { status: 'finished_successfully', endTurn: true }),
        );
        try {
            runPlatform();
            await new Promise((r) => setTimeout(r, 80));

            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:fidelity',
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
                    attemptId: 'attempt:fidelity',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );

            await new Promise((r) => setTimeout(r, 700));
            expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();

            postStampedMessage(
                {
                    type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                    platform: 'ChatGPT',
                    url: 'https://chatgpt.com/backend-api/conversation/123',
                    data: JSON.stringify(canonical),
                    attemptId: 'attempt:fidelity',
                },
                window.location.origin,
            );

            await new Promise((r) => setTimeout(r, 2500));

            const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(saveBtn?.disabled).toBeFalse();
            expect(saveBtn?.title).not.toContain('Force Save');
        } finally {
            responder.dispose();
        }
    }, 10_000);

    it('should keep Save enabled when a late degraded snapshot arrives after canonical-ready', async () => {
        const canonical = buildConversation('123', 'Stable canonical answer', {
            status: 'finished_successfully',
            endTurn: true,
        });
        const degraded = buildConversation('123', 'Partial snapshot answer', { status: 'in_progress', endTurn: false });

        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            buildApiUrls: () => [],
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

        const responder = attachSnapshotResponder(() => degraded);
        try {
            runPlatform();
            await new Promise((r) => setTimeout(r, 80));

            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:late-snap',
                    phase: 'prompt-sent',
                    conversationId: '123',
                },
                window.location.origin,
            );
            await new Promise((r) => setTimeout(r, 20));

            postStampedMessage(
                {
                    type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                    platform: 'ChatGPT',
                    url: 'https://chatgpt.com/backend-api/conversation/123',
                    data: JSON.stringify(canonical),
                    attemptId: 'attempt:late-snap',
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
                    attemptId: 'attempt:late-snap',
                },
                window.location.origin,
            );
            await new Promise((r) => setTimeout(r, 150));

            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:late-snap',
                    phase: 'completed',
                    conversationId: '123',
                },
                window.location.origin,
            );

            await new Promise((r) => setTimeout(r, 1200));

            const saveBtn = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            expect(saveBtn?.disabled).toBeFalse();
            expect(saveBtn?.title?.includes('Force Save')).toBeFalse();
        } finally {
            responder.dispose();
        }
    }, 15_000);
});
