/**
 * Tests: SPA navigation – conversation switching and attempt lifecycle.
 *
 * Covers:
 *  - No spurious attempt creation when refreshButtonState fires on a different conversation (H-01)
 *  - Stream deltas preserved when navigating INTO the same conversation
 *  - Attempt disposal when navigation switches to a DIFFERENT conversation
 *  - Auto-calibration deferral on first-prompt navigation with no pre-bound attempt
 *  - Stabilisation retry survives lifecycle reset-to-idle after navigation
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
const logCalls = createLoggerCalls();
const browserMockState = {
    storageData: {} as Record<string, unknown>,
    sendMessage: async (_: unknown) => undefined as unknown,
};

mock.module('@/platforms/factory', () => ({
    getPlatformAdapter: () => currentAdapterMock,
    getPlatformAdapterByApiUrl: () => currentAdapterMock,
}));
mock.module('@/utils/download', () => ({ downloadAsJSON: () => {} }));
mock.module('@/utils/logger', () => buildLoggerMock(logCalls));
mock.module('wxt/browser', () => buildBrowserMock(browserMockState));

import { runPlatform } from '@/utils/platform-runner';
import { getSessionToken } from '@/utils/protocol/session-token';

const postStampedMessage = makePostStampedMessage(window as any, getSessionToken);

const waitUntil = async (predicate: () => boolean, timeout = 5000, interval = 20): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout) {
            throw new Error('waitUntil timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
};

const waitForRunnerReady = () => waitUntil(() => !!document.getElementById('blackiya-save-btn'));

const waitForLifecycleState = (label: 'Prompt Sent' | 'Streaming' | 'Completed') =>
    waitUntil(() => document.getElementById('blackiya-lifecycle-badge')?.textContent?.includes(label) === true);

describe('Platform Runner – SPA navigation', () => {
    beforeEach(() => {
        window.dispatchEvent(new (window as any).Event('beforeunload'));
        document.body.innerHTML = '';
        currentAdapterMock = createMockAdapter(document);
        logCalls.debug.length = 0;
        logCalls.info.length = 0;
        logCalls.warn.length = 0;
        logCalls.error.length = 0;
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

    it('should not create a spurious active attempt when refreshButtonState fires on a different conversation (H-01)', async () => {
        currentAdapterMock = {
            ...createMockAdapter(document),
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
        await waitForRunnerReady();

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
        await waitForLifecycleState('Prompt Sent');

        const postedMessages: any[] = [];
        const origPost = window.postMessage.bind(window);
        (window as any).postMessage = (payload: any, target: string) => {
            postedMessages.push(payload);
            return origPost(payload, target);
        };

        try {
            currentAdapterMock.extractConversationId = () => 'conv-h01-b';
            delete (window as any).location;
            (window as any).location = { href: 'https://chatgpt.com/c/conv-h01-b', origin: 'https://chatgpt.com' };
            window.dispatchEvent(new (window as any).Event('popstate'));
            postStampedMessage(
                {
                    type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                    platform: 'ChatGPT',
                    attemptId: 'attempt:h01-next',
                    phase: 'prompt-sent',
                    conversationId: 'conv-h01-b',
                },
                window.location.origin,
            );
            await waitUntil(() =>
                postedMessages.some(
                    (p) =>
                        p?.type === 'BLACKIYA_RESPONSE_LIFECYCLE' &&
                        p?.attemptId === 'attempt:h01-next' &&
                        p?.conversationId === 'conv-h01-b',
                ),
            );
        } finally {
            (window as any).postMessage = origPost;
        }

        const disposals = postedMessages.filter((p) => p?.type === 'BLACKIYA_ATTEMPT_DISPOSED').map((p) => p.attemptId);
        expect(disposals).not.toContain('attempt:h01-active');
    });

    it('should keep ChatGPT stream deltas after navigation into the same conversation route', async () => {
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            extractConversationId: (url: string) => url.match(/\/c\/([a-z0-9-]+)/i)?.[1] ?? null,
        };
        delete (window as any).location;
        (window as any).location = { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' };

        runPlatform();
        await waitForRunnerReady();

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
        await waitForLifecycleState('Streaming');

        (window as any).location.href = 'https://chatgpt.com/c/conv-same-nav';
        window.dispatchEvent(new (window as any).Event('popstate'));
        await waitUntil(() => (window as any).location.href.includes('/c/conv-same-nav'));

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
        await waitUntil(
            () =>
                document
                    .getElementById('blackiya-stream-probe')
                    ?.textContent?.includes('delta-after-same-conversation-navigation') === true,
        );

        expect(
            document
                .getElementById('blackiya-stream-probe')
                ?.textContent?.includes('delta-after-same-conversation-navigation'),
        ).toBeTrue();
    });

    it('should dispose prior ChatGPT attempt when navigation switches to a different conversation route', async () => {
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            extractConversationId: (url: string) => url.match(/\/c\/([a-z0-9-]+)/i)?.[1] ?? null,
        };
        delete (window as any).location;
        (window as any).location = { href: 'https://chatgpt.com/c/conv-old', origin: 'https://chatgpt.com' };

        runPlatform();
        await waitForRunnerReady();

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
        await waitForLifecycleState('Streaming');

        (window as any).location.href = 'https://chatgpt.com/c/conv-new';
        window.dispatchEvent(new (window as any).Event('popstate'));
        await waitUntil(() => (window as any).location.href.includes('/c/conv-new'));

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
        const infoLogsBeforeRecovery = logCalls.info.length;
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:nav-new-active',
                phase: 'streaming',
                conversationId: 'conv-new',
            },
            window.location.origin,
        );
        await waitUntil(() => logCalls.info.length > infoLogsBeforeRecovery);

        expect(
            document
                .getElementById('blackiya-stream-probe')
                ?.textContent?.includes('delta-from-disposed-old-conversation'),
        ).toBeFalse();
    });

    it('should defer auto calibration on first-prompt navigation even when no attempt is pre-bound', async () => {
        currentAdapterMock = {
            ...createMockAdapter(document),
            name: 'ChatGPT',
            isPlatformGenerating: () => true,
            extractConversationId: (url: string) => url.match(/\/c\/([a-z0-9-]+)/i)?.[1] ?? null,
        };
        delete (window as any).location;
        (window as any).location = { href: 'https://chatgpt.com/c/conv-old', origin: 'https://chatgpt.com' };

        runPlatform();
        await waitForRunnerReady();

        (window as any).location.href = 'https://chatgpt.com/c/conv-new';
        window.dispatchEvent(new (window as any).Event('popstate'));
        await waitUntil(
            () =>
                logCalls.info.some(
                    (e) =>
                        e.message === 'Auto calibration deferred: response still generating' &&
                        (e.args?.[0] as any)?.conversationId === 'conv-new',
                ),
            4500,
            20,
        );

        const deferred = logCalls.info.find(
            (e) =>
                e.message === 'Auto calibration deferred: response still generating' &&
                (e.args?.[0] as any)?.conversationId === 'conv-new',
        );
        expect(deferred).toBeDefined();
    });

    it('should schedule stabilisation retry after navigation resets lifecycle to idle', async () => {
        const canonical = buildConversation('123', 'Full canonical answer from API', {
            status: 'finished_successfully',
            endTurn: true,
        });
        const degraded = buildConversation('123', 'Partial thinking output...', {
            status: 'in_progress',
            endTurn: false,
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
        await waitForRunnerReady();

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:nav-retry',
                phase: 'prompt-sent',
            },
            window.location.origin,
        );
        await waitForLifecycleState('Prompt Sent');
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
        await waitForLifecycleState('Streaming');
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_FINISHED',
                platform: 'ChatGPT',
                attemptId: 'attempt:nav-retry',
                conversationId: '123',
            },
            window.location.origin,
        );
        await waitUntil(() =>
            logCalls.info.some((entry) => String(entry.message).includes('Response finished signal')),
        );

        // Degraded snapshot triggers stabilisation retry
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'stream-snapshot://ChatGPT/123',
                data: JSON.stringify(degraded),
                attemptId: 'attempt:nav-retry',
            },
            window.location.origin,
        );
        await waitUntil(() => {
            const saveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            return !!saveButton && saveButton.disabled;
        });

        // First canonical sample
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonical),
                attemptId: 'attempt:nav-retry',
            },
            window.location.origin,
        );
        await waitUntil(() => {
            const saveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
            return !!saveButton && saveButton.disabled;
        });

        // Second canonical sample for SFE stability
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/123',
                data: JSON.stringify(canonical),
                attemptId: 'attempt:nav-retry',
            },
            window.location.origin,
        );
        await waitUntil(
            () => {
                const saveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
                return !!saveButton && !saveButton.disabled;
            },
            8000,
            20,
        );

        const saveButton = document.getElementById('blackiya-save-btn') as HTMLButtonElement | null;
        expect(saveButton).not.toBeNull();
        expect(saveButton?.disabled).toBeFalse();
    }, 15_000);
});
