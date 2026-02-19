/**
 * Shared test utilities for platform-runner tests.
 *
 * IMPORTANT: This file intentionally contains NO mock.module calls and NO
 * references to mocked modules. All mock.module registrations must live at the
 * top of each individual test file so Bun can hoist them before any imports.
 *
 * What belongs here:
 *   - Pure factory / builder functions (no side-effects)
 *   - Type helpers used across multiple test files
 *
 * What does NOT belong here:
 *   - mock.module calls
 *   - Mutable state (currentAdapterMock, storageDataMock, …)
 *   - beforeEach / afterEach hooks
 *   - Window / document references (they differ per test-file Window instance)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MockAdapter = {
    name: string;
    extractConversationId: (url?: string) => string | null;
    getButtonInjectionTarget: () => Element;
    formatFilename: (data: { title: string }) => string;
    parseInterceptedData: (raw: string) => Record<string, unknown> | null;
    [key: string]: unknown;
};

export type ConversationOptions = {
    status: string;
    endTurn: boolean;
};

export type ConversationBuildOverrides = {
    omitAssistant?: boolean;
    userText?: string;
    title?: string;
};

export type ReadinessResult = {
    ready: boolean;
    terminal: boolean;
    reason: string;
    contentHash: string | null;
    latestAssistantTextLength: number;
};

// ---------------------------------------------------------------------------
// Conversation fixture builder
// ---------------------------------------------------------------------------

/**
 * Builds a minimal canonical conversation fixture with one user turn and one
 * assistant turn.  Re-used across every test suite that exercises readiness,
 * stabilisation, snapshot, and export flows.
 */
export const buildConversation = (
    conversationId: string,
    assistantText: string,
    options: ConversationOptions,
    overrides: ConversationBuildOverrides = {},
) => {
    const userText = overrides.userText ?? 'Prompt';
    const includeAssistant = overrides.omitAssistant !== true;

    return {
        title: overrides.title ?? 'Test Conversation',
        create_time: 1_700_000_000,
        update_time: 1_700_000_120,
        conversation_id: conversationId,
        current_node: includeAssistant ? 'a1' : 'u1',
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
                children: includeAssistant ? ['a1'] : [],
                message: {
                    id: 'u1',
                    author: { role: 'user', name: null, metadata: {} },
                    create_time: 1_700_000_010,
                    update_time: 1_700_000_010,
                    content: { content_type: 'text', parts: [userText] },
                    status: 'finished_successfully',
                    end_turn: true,
                    weight: 1,
                    metadata: {},
                    recipient: 'all',
                    channel: null,
                },
            },
            ...(includeAssistant
                ? {
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
                  }
                : {}),
        },
    };
};

// ---------------------------------------------------------------------------
// Readiness evaluator (mirrors the real adapter contract)
// ---------------------------------------------------------------------------

/**
 * Deterministic readiness evaluator used in tests that need SFE to reach
 * captured_ready.  Matches the shape returned by real platform adapters.
 */
export const evaluateReadinessMock = (data: unknown): ReadinessResult => {
    const mapping = (data as any)?.mapping ?? {};
    const assistants = Object.values(mapping)
        .map((node: any) => node?.message)
        .filter((message: any) => message?.author?.role === 'assistant');
    const latest = assistants[assistants.length - 1] as any;
    const text = (latest?.content?.parts ?? []).join('').trim();
    const terminal = latest?.status !== 'in_progress' && latest?.end_turn === true;
    return {
        ready: terminal && text.length > 0,
        terminal,
        reason: terminal ? 'terminal' : 'in-progress',
        contentHash: text.length > 0 ? `h:${text.length}:${terminal ? 1 : 0}` : null,
        latestAssistantTextLength: text.length,
    };
};

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Returns a minimal mock adapter that satisfies the PlatformAdapter interface.
 * Accepts the test-file's local `document` so the injection target is wired
 * to the right Happy DOM instance.
 */
type DocumentLike = { body: unknown };

export const createMockAdapter = (document: DocumentLike): MockAdapter => ({
    name: 'TestPlatform',
    extractConversationId: () => '123',
    getButtonInjectionTarget: () => document.body as Element,
    formatFilename: () => 'test.json',
    parseInterceptedData: () => ({ conversation_id: '123' }),
});

// ---------------------------------------------------------------------------
// postStampedMessage factory
// ---------------------------------------------------------------------------

/**
 * Returns a `postStampedMessage` helper bound to the test file's local
 * `window` instance and session token getter.
 *
 * Usage in test files:
 *
 *   import { getSessionToken } from '@/utils/protocol/session-token';
 *   const postStampedMessage = makePostStampedMessage(window, getSessionToken);
 */
export const makePostStampedMessage =
    (win: Window & typeof globalThis, getToken: () => string | null | undefined) =>
    (data: Record<string, unknown>, origin: string): void => {
        const token = getToken();
        win.postMessage(token ? { ...data, __blackiyaToken: token } : data, origin);
    };

// ---------------------------------------------------------------------------
// Logger call recorder factory
// ---------------------------------------------------------------------------

/**
 * Creates a set of mutable arrays that accumulate logger calls.  Pass these
 * into mock.module('@/utils/logger', …) to capture log output for assertions.
 *
 * Returns:
 *   { calls, logger } — `calls` is the raw buckets; `logger` is the mock object.
 */
export type LoggerCalls = {
    debug: Array<{ message: unknown; args: unknown[] }>;
    info: Array<{ message: unknown; args: unknown[] }>;
    warn: Array<{ message: unknown; args: unknown[] }>;
    error: Array<{ message: unknown; args: unknown[] }>;
};

/**
 * Creates a fresh set of log-call buckets.
 *
 * IMPORTANT – stale-closure pitfall:
 * Declare the result as `const logCalls = createLoggerCalls()` at module scope.
 * In `beforeEach`, reset the arrays **in place**:
 *
 *   logCalls.debug.length = 0;
 *   logCalls.info.length  = 0;
 *   logCalls.warn.length  = 0;
 *   logCalls.error.length = 0;
 *
 * Do NOT do `logCalls = createLoggerCalls()` — that rebinds the local variable
 * but the mock.module closure still holds the original array references, so
 * assertions will read from an empty object and always see 0 entries.
 */
export const createLoggerCalls = (): LoggerCalls => ({
    debug: [],
    info: [],
    warn: [],
    error: [],
});

export const buildLoggerMock = (calls: LoggerCalls) => ({
    logger: {
        debug: (message: unknown, ...args: unknown[]) => calls.debug.push({ message, args }),
        info: (message: unknown, ...args: unknown[]) => calls.info.push({ message, args }),
        warn: (message: unknown, ...args: unknown[]) => calls.warn.push({ message, args }),
        error: (message: unknown, ...args: unknown[]) => calls.error.push({ message, args }),
    },
});

// ---------------------------------------------------------------------------
// Browser mock factory
// ---------------------------------------------------------------------------

export type BrowserMockState = {
    storageData: Record<string, unknown>;
    sendMessage: (message: unknown) => Promise<unknown>;
};

/**
 * Returns the `{ browser }` object expected by mock.module('wxt/browser', …).
 * The state object lets tests swap storageData and sendMessage between runs.
 */
export const buildBrowserMock = (state: BrowserMockState) => ({
    browser: {
        storage: {
            onChanged: {
                addListener: () => {},
                removeListener: () => {},
            },
            local: {
                get: async () => state.storageData,
                set: async () => {},
            },
        },
        runtime: {
            getURL: () => 'chrome-extension://mock/',
            sendMessage: async (message: unknown) => state.sendMessage(message),
        },
    },
});
