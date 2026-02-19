import { describe, expect, it, mock } from 'bun:test';
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

const _buildConversation = (
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

const _evaluateReadinessMock = (data: any) => {
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
const currentAdapterMock: any = createMockAdapter();
const storageDataMock: Record<string, unknown> = {};
const runtimeSendMessageMock: (message: unknown) => Promise<unknown> = async () => undefined;

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
import {
    beginCanonicalStabilizationTick,
    clearCanonicalStabilizationAttemptState,
    resolveShouldSkipCanonicalRetryAfterAwait,
    shouldRemoveDisposedAttemptBinding,
} from './platform-runner';

/** Stamps the session token onto a test message before posting via window.postMessage */
const _postStampedMessage = (data: Record<string, unknown>, origin: string) => {
    const token = getSessionToken();
    window.postMessage(token ? { ...data, __blackiyaToken: token } : data, origin);
};

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
        expect(shouldRemoveDisposedAttemptBinding('attempt:raw-a', 'attempt:raw-b', resolve)).toBeTrue();
    });

    it('keeps mapped attempts that resolve to a different canonical attempt', () => {
        const resolve = resolveFromMap({
            'attempt:raw-a': 'attempt:canonical-a',
            'attempt:raw-b': 'attempt:canonical-b',
        });
        expect(shouldRemoveDisposedAttemptBinding('attempt:raw-a', 'attempt:raw-b', resolve)).toBeFalse();
    });
});

describe('canonical stabilization retry helpers', () => {
    it('allows only one in-flight retry tick per attempt', () => {
        const inProgress = new Set<string>();
        expect(beginCanonicalStabilizationTick('attempt-1', inProgress)).toBeTrue();
        expect(beginCanonicalStabilizationTick('attempt-1', inProgress)).toBeFalse();
        expect(inProgress.has('attempt-1')).toBeTrue();
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
        expect(timerIds.has('attempt-1')).toBeFalse();
        expect(retryCounts.has('attempt-1')).toBeFalse();
        expect(startedAt.has('attempt-1')).toBeFalse();
        expect(timeoutWarnings.has('attempt-1')).toBeFalse();
        expect(inProgress.has('attempt-1')).toBeFalse();
    });

    it('re-checks disposal and conversation mismatch after await boundaries', () => {
        const disposed = resolveShouldSkipCanonicalRetryAfterAwait(
            'attempt-1',
            true,
            undefined,
            (attemptId) => attemptId,
        );
        expect(disposed).toBeTrue();

        const mismatched = resolveShouldSkipCanonicalRetryAfterAwait(
            'attempt-1',
            false,
            'attempt-2',
            (attemptId) => attemptId,
        );
        expect(mismatched).toBeTrue();

        const canonicalAliasMatch = resolveShouldSkipCanonicalRetryAfterAwait(
            'attempt-1',
            false,
            'alias-attempt-1',
            (attemptId) => (attemptId === 'alias-attempt-1' ? 'attempt-1' : attemptId),
        );
        expect(canonicalAliasMatch).toBeFalse();
    });
});
