/**
 * Tests: Attempt registry – aliasing, supersession, and disposal.
 *
 * Covers:
 *  - Alias chain cleanup on upstream alias disposal
 *  - No spurious supersession when rebinding resolves to same canonical attempt
 *  - Stale deltas from superseded attempts are ignored by the stream probe
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

const jsonParsingAdapter = () => ({
    ...createMockAdapter(document),
    parseInterceptedData: (raw: string) => {
        try {
            const p = JSON.parse(raw);
            return p?.conversation_id ? p : null;
        } catch {
            return null;
        }
    },
});

describe('Platform Runner – attempt registry', () => {
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

    it('should clear aliased conversation bindings when disposing an upstream alias attempt', async () => {
        currentAdapterMock = jsonParsingAdapter();
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

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
            await new Promise((r) => setTimeout(r, 15));
        };

        // Build alias chain A → B, bind conv-2 to raw A
        await postLifecycle('attempt:chain-a', 'conv-1');
        await postLifecycle('attempt:chain-b', 'conv-1');

        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/conv-2',
                data: JSON.stringify(
                    buildConversation('conv-2', 'Partial response', { status: 'in_progress', endTurn: false }),
                ),
                attemptId: 'attempt:chain-a',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));

        // Extend alias chain to A → B → C
        await postLifecycle('attempt:chain-c', 'conv-1');

        const postedMessages: any[] = [];
        const origPost = window.postMessage.bind(window);
        (window as any).postMessage = (payload: any, target: string) => {
            postedMessages.push(payload);
            return origPost(payload, target);
        };

        try {
            await postLifecycle('attempt:chain-d', 'conv-2');
            await new Promise((r) => setTimeout(r, 40));
        } finally {
            (window as any).postMessage = origPost;
        }

        const superseded = postedMessages
            .filter((p) => p?.type === 'BLACKIYA_ATTEMPT_DISPOSED' && p?.reason === 'superseded')
            .map((p) => p.attemptId);
        expect(superseded).not.toContain('attempt:chain-c');
    });

    it('should not supersede when rebinding resolves to the same canonical attempt', async () => {
        currentAdapterMock = jsonParsingAdapter();
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

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
            await new Promise((r) => setTimeout(r, 15));
        };

        // Establish alias: alias-a → canon-a
        await postLifecycle('attempt:alias-a', 'conv-1');
        await postLifecycle('attempt:canon-a', 'conv-1');

        // Bind conv-2 using the upstream alias
        postStampedMessage(
            {
                type: 'LLM_CAPTURE_DATA_INTERCEPTED',
                platform: 'ChatGPT',
                url: 'https://chatgpt.com/backend-api/conversation/conv-2',
                data: JSON.stringify(buildConversation('conv-2', 'Partial', { status: 'in_progress', endTurn: false })),
                attemptId: 'attempt:alias-a',
            },
            window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 30));

        const postedMessages: any[] = [];
        const origPost = window.postMessage.bind(window);
        (window as any).postMessage = (payload: any, target: string) => {
            postedMessages.push(payload);
            return origPost(payload, target);
        };

        try {
            await postLifecycle('attempt:alias-a', 'conv-2');
            await new Promise((r) => setTimeout(r, 30));
        } finally {
            (window as any).postMessage = origPost;
        }

        const superseded = postedMessages
            .filter((p) => p?.type === 'BLACKIYA_ATTEMPT_DISPOSED' && p?.reason === 'superseded')
            .map((p) => p.attemptId);
        expect(superseded).not.toContain('attempt:canon-a');
    });

    it('should ignore stale stream delta from a superseded attempt', async () => {
        runPlatform();
        await new Promise((r) => setTimeout(r, 80));

        // Establish a newer active attempt
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
        await new Promise((r) => setTimeout(r, 10));

        // Emit a delta from an older superseded attempt
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
        await new Promise((r) => setTimeout(r, 20));

        expect(
            document.getElementById('blackiya-stream-probe')?.textContent?.includes('Should not render'),
        ).toBeFalse();
    });
});
