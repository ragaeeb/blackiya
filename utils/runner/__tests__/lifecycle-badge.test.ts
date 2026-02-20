/**
 * Tests: Lifecycle badge rendering and state-machine transitions.
 *
 * Covers:
 *  - Badge updates for each lifecycle phase (idle → prompt-sent → streaming → completed)
 *  - Monotonic regression guard (completed → streaming blocked for same attempt)
 *  - Badge updates even when conversationId is null (Gemini / Grok pre-resolution)
 *  - Disposal of stale attempts prevents further state changes
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { STORAGE_KEYS } from '@/utils/settings';

const window = new Window();
(window as any).SyntaxError = SyntaxError;
const document = window.document;
(global as any).window = window;
(global as any).document = document;
(global as any).history = window.history;
(global as any).HTMLElement = window.HTMLElement;
(global as any).HTMLButtonElement = window.HTMLButtonElement;
(global as any).MutationObserver = window.MutationObserver;

import {
    buildBrowserMock,
    buildLoggerMock,
    createLoggerCalls,
    createMockAdapter,
    makePostStampedMessage,
    waitFor,
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

import { getSessionToken } from '@/utils/protocol/session-token';
import { runPlatform } from '@/utils/runner/platform-runtime';

const postStampedMessage = makePostStampedMessage(window as any, getSessionToken);

const waitForRunnerReady = () => waitFor(() => !!document.getElementById('blackiya-save-btn'));

describe('Platform Runner – lifecycle badge', () => {
    beforeEach(() => {
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

    it('should process typed lifecycle messages that include attemptId', async () => {
        runPlatform();
        await waitForRunnerReady();
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
        await waitFor(
            () => document.getElementById('blackiya-lifecycle-badge')?.textContent?.includes('Streaming') ?? false,
        );
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
    });

    it('should update lifecycle badge for each phase in sequence', async () => {
        runPlatform();
        await waitForRunnerReady();

        const badge = () => document.getElementById('blackiya-lifecycle-badge')?.textContent ?? '';
        expect(badge()).toContain('Idle');

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:seq',
                phase: 'prompt-sent',
                conversationId: '123',
            },
            window.location.origin,
        );
        await waitFor(() => badge().includes('Prompt Sent'));
        expect(badge()).toContain('Prompt Sent');

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:seq',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        await waitFor(() => badge().includes('Streaming'));
        expect(badge()).toContain('Streaming');

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:seq',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );
        await waitFor(() => badge().includes('Completed'));
        expect(badge()).toContain('Completed');
    });

    it('should block lifecycle regression from completed to streaming for same attempt and conversation', async () => {
        runPlatform();
        await waitForRunnerReady();

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:mono',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );
        await waitFor(
            () => document.getElementById('blackiya-lifecycle-badge')?.textContent?.includes('Completed') ?? false,
        );
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:mono',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        await waitFor(
            () => document.getElementById('blackiya-lifecycle-badge')?.textContent?.includes('Completed') ?? false,
        );
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Completed');
    });

    it('should update badge but keep save disabled when conversationId is null', async () => {
        runPlatform();
        await waitForRunnerReady();

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:null-conv',
                phase: 'prompt-sent',
                conversationId: null,
            },
            window.location.origin,
        );
        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'Gemini',
                attemptId: 'attempt:null-conv',
                phase: 'streaming',
                conversationId: null,
            },
            window.location.origin,
        );
        await waitFor(
            () => document.getElementById('blackiya-lifecycle-badge')?.textContent?.includes('Streaming') ?? false,
        );

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');
        expect((document.getElementById('blackiya-save-btn') as HTMLButtonElement | null)?.disabled).toBeTrue();
    });

    it('should ignore lifecycle messages from disposed attempts', async () => {
        runPlatform();
        await waitForRunnerReady();

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:stale',
                phase: 'streaming',
                conversationId: '123',
            },
            window.location.origin,
        );
        await waitFor(
            () => document.getElementById('blackiya-lifecycle-badge')?.textContent?.includes('Streaming') ?? false,
        );
        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).toContain('Streaming');

        postStampedMessage(
            { type: 'BLACKIYA_ATTEMPT_DISPOSED', attemptId: 'attempt:stale', reason: 'navigation' },
            window.location.origin,
        );

        postStampedMessage(
            {
                type: 'BLACKIYA_RESPONSE_LIFECYCLE',
                platform: 'ChatGPT',
                attemptId: 'attempt:stale',
                phase: 'completed',
                conversationId: '123',
            },
            window.location.origin,
        );
        await waitFor(() => !document.getElementById('blackiya-lifecycle-badge')?.textContent?.includes('Completed'));

        expect(document.getElementById('blackiya-lifecycle-badge')?.textContent).not.toContain('Completed');
    });
});
