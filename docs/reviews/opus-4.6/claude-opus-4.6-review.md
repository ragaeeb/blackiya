# Deep Code Review: Blackiya Extension

> **Reviewer:** Claude Opus 4.6 (Thinking)
> **Date:** 2026-02-17
> **Scope:** Full codebase sweep — architecture, code quality, performance, testing, maintainability
> **Codebase snapshot:** 381 tests passing across 45 test files, ~12,400 lines across 12 key source files

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Critical Issues](#2-critical-issues)
3. [Architecture Concerns](#3-architecture-concerns)
4. [Code Smells & Duplication](#4-code-smells--duplication)
5. [Performance Concerns](#5-performance-concerns)
6. [Brittleness & Hardcoded Values](#6-brittleness--hardcoded-values)
7. [Error Handling Gaps](#7-error-handling-gaps)
8. [Inconsistencies](#8-inconsistencies)
9. [Testing Gaps](#9-testing-gaps)
10. [Recommended Refactoring Plan](#10-recommended-refactoring-plan)
11. [File-by-File Summary](#11-file-by-file-summary)

---

## 1. Executive Summary

Blackiya is a well-intentioned browser extension with a solid adapter pattern and a comprehensive test suite (381 tests, 949 assertions). However, the rapid iteration through 61 regression fixes (V2.1-001 through V2.1-061) has created significant technical debt. The two largest files — `platform-runner.ts` (4,641 lines) and `interceptor.content.ts` (3,127 lines) — are the primary sources of maintainability risk.

### By the Numbers

| Metric | Value | Concern Level |
|--------|-------|---------------|
| `platform-runner.ts` | 4,641 lines, ~150 nested functions in single closure | Critical |
| `interceptor.content.ts` | 3,127 lines, 10+ module-level Maps with no cleanup | High |
| Magic numbers across codebase | 50+ instances | Medium |
| `#region agent log` instrumentation remaining | 8 instances across 3 files | Medium |
| Duplicated patterns across adapters | 12+ identified | Medium |
| `any` type usage in hot paths | 15+ instances | Medium |
| Missing error handling in parsers | 5 identified | High |
| Integration tests | 9 files, all SFE-focused | Gap: no interceptor or adapter integration tests |

### Severity Summary

| Severity | Count |
|----------|-------|
| Critical | 3 |
| High | 12 |
| Medium | 35+ |
| Low | 30+ |

---

## 2. Critical Issues

### CRIT-1: `platform-runner.ts` is a God Object (4,641 lines)

**Location:** `utils/platform-runner.ts`

The entire platform runner is a single exported function `runPlatform()` that spans ~4,450 lines. It contains:
- **50+ mutable closure variables** (lines 206-259)
- **~150 nested functions** accessing shared mutable state
- Responsibilities for: lifecycle management, calibration, stream probing, readiness evaluation, DOM snapshot building, export pipeline, button state, message bridge, and more

**Why this is critical:**
- Impossible to unit test individual subsystems in isolation
- Every change risks side effects via shared mutable state
- New developers (human or AI) cannot reason about the function
- The 61-regression history (V2.1-001 through V2.1-061) is a direct consequence of this coupling

**Recommendation:** Decompose into focused modules:
```
utils/runner/lifecycle-manager.ts      — lifecycle state machine
utils/runner/calibration-runner.ts     — calibration pipeline
utils/runner/stream-probe.ts           — stream probe panel/logic
utils/runner/readiness-resolver.ts     — readiness decision logic
utils/runner/export-pipeline.ts        — save/copy/download
utils/runner/dom-snapshot.ts           — DOM snapshot building
utils/runner/message-bridge.ts         — postMessage handler routing
utils/runner/state.ts                  — PlatformRunnerState class
utils/runner/index.ts                  — thin orchestrator
```

### CRIT-2: `interceptor.content.ts` Has Unbounded Memory Growth

**Location:** `entrypoints/interceptor.content.ts` lines 52-61

Ten module-level `Map`/`Set` objects grow without any cleanup, eviction, or TTL:

```typescript
const completionSignalCache = new Map<string, number>();
const transientLogCache = new Map<string, number>();
const capturePayloadCache = new Map<string, number>();
const lifecycleSignalCache = new Map<string, number>();
const attemptByConversationId = new Map<string, string>();
const conversationResolvedSignalCache = new Map<string, number>();
const disposedAttemptIds = new Set<string>();
const streamDumpFrameCountByAttempt = new Map<string, number>();
const streamDumpLastTextByAttempt = new Map<string, string>();
const latestAttemptIdByPlatform = new Map<string, string>();
```

In a long session (tabs open for hours, many conversations), these grow indefinitely. The content script runs in the MAIN world and shares memory with the page.

**Recommendation:** Add periodic cleanup (e.g., every 60s, evict entries older than 5 minutes) or use a bounded LRU cache (the project already has `utils/lru-cache.ts`).

### CRIT-3: `interceptor.content.ts` `main()` Is 665 Lines

**Location:** `entrypoints/interceptor.content.ts` lines 2465-3130

The `main()` function contains the entire fetch interceptor setup, XHR interceptor setup, proactive fetch retry logic, message listener setup, and stream dump configuration — all in a single function.

**Recommendation:** Extract into:
```
interceptor/fetch-interceptor.ts       — fetch() wrapper
interceptor/xhr-interceptor.ts         — XHR wrapper
interceptor/proactive-fetcher.ts       — retry/backoff logic
interceptor/message-handler.ts         — postMessage listener
interceptor/stream-monitors.ts         — per-platform stream monitors
```

---

## 3. Architecture Concerns

### ARCH-1: Interceptor Duplicates Logic Per Platform Instead of Using Adapters

**Location:** `interceptor.content.ts` lines 700-1500

The interceptor has per-platform functions that duplicate structure:
- `trimGeminiPayloadHistory` / `trimGrokPayloadHistory` — identical except for limits
- `wireGeminiXhrProgressMonitor` / `wireGrokXhrProgressMonitor` — same XHR progress pattern
- `monitorGeminiResponseStream` / `monitorGrokResponseStream` — same fetch stream pattern
- `syncGeminiSeenPayloadOrderFromSet` / similar Grok patterns — same O(n²) dedup

**Impact:** Adding a new platform (e.g., Claude) requires copying and adapting 300+ lines of boilerplate.

**Recommendation:** Create a generic `StreamMonitor` class/factory:
```typescript
interface StreamMonitorConfig {
    platform: string;
    bufferLimits: { maxBytes: number; keepTailBytes: number };
    historyLimits: { maxPayloads: number; maxSignals: number };
    parser: (buffer: string) => ParsedChunk[];
    dedupeIntervalMs: number;
}
```

### ARCH-2: Platform-Specific DOM Heuristics Live in the Runner

**Location:** `platform-runner.ts` lines ~3443-3522

`isChatGPTGenerating()`, `isGeminiGenerating()`, `isGrokGenerating()` use platform-specific CSS selectors but live in the runner rather than in the adapters.

**Recommendation:** Add `isPlatformGenerating?(): boolean` to the `LLMPlatform` interface and implement in each adapter. The runner should not contain platform-specific selectors.

### ARCH-3: Title Resolution Is Scattered Across 5+ Locations

Title resolution logic exists in:
1. Platform adapters (`extractTitleFromDom`, `defaultTitles`, `parseTitlesResponse`)
2. `InterceptionManager` (`specificTitleCache`, `preserveSpecificTitle`)
3. `platform-runner.ts` (`getConversationData` title fallback, export-time generic detection)
4. `gemini-stream-parser.ts` (`collectGeminiTitleCandidates`)
5. `gemini.ts` adapter (`collectGeminiTitleCandidates` — different implementation)

This distributed ownership caused regressions V2.1-037, V2.1-045, V2.1-050, V2.1-053, V2.1-056, V2.1-058, V2.1-059, V2.1-060, V2.1-061 — **11 title-related regressions** out of 61 total (18%).

**Recommendation:** Centralize into a `TitleResolver` class:
```typescript
class TitleResolver {
    resolve(conversationId: string, sources: TitleSource[]): string;
    isGeneric(title: string, platform: string): boolean;
    remember(conversationId: string, title: string): void;
}
```

### ARCH-4: Signal Fusion Engine Resolution Map Never Prunes

**Location:** `utils/sfe/signal-fusion-engine.ts` line ~154

The `resolutions` Map stores resolution data for every attempt ever processed. Disposed and superseded attempts remain in the map indefinitely.

**Recommendation:** Prune entries for disposed/superseded attempts after a TTL (e.g., 30 seconds).

---

## 4. Code Smells & Duplication

### DUP-1: Buffer Truncation Pattern (5 Copies)

**Locations:** `interceptor.content.ts` lines 735-738, 1018-1021, 1281-1286, 1382-1385, 1716-1723

Identical pattern repeated:
```typescript
if (buffer.length > maxBufferBytes) {
    buffer = buffer.slice(buffer.length - keepTailBytes);
}
```

**Fix:** Extract `truncateBuffer(buffer: string, maxBytes: number, keepTailBytes: number): string`.

### DUP-2: History Trimming Pattern (4 Copies)

**Locations:** `interceptor.content.ts` lines 704-721, 1099-1117

`trimGeminiPayloadHistory`/`trimGeminiDeltaHistory` vs `trimGrokPayloadHistory`/`trimGrokSignalHistory` are structurally identical.

**Fix:** Extract `trimHistory(set: Set<string>, order: string[], limit: number)`.

### DUP-3: `evaluateReadiness` Nearly Identical for Gemini/Grok

**Locations:** `platforms/gemini.ts` lines 458-509, `platforms/grok.ts` lines 593-654

Both:
1. Collect assistant messages from mapping
2. Sort by `update_time ?? create_time`
3. Check for missing/in-progress/terminal states
4. Extract and normalize text
5. Compute `contentHash` via `hashText`

**Fix:** Extract `evaluateConversationReadiness(data, options?: { requireEndTurn?: boolean })` in `utils/`.

### DUP-4: `formatFilename` Identical Structure Across Adapters

**Locations:** `chatgpt.ts` lines 763-786, `gemini.ts` lines 803-808, `grok.ts` lines 1148-1170

All follow: sanitize title → truncate to 80 → append timestamp.

**Fix:** Extract `formatConversationFilename(data, options)` in `utils/conversation-filename.ts`.

### DUP-5: ConversationData Default Metadata (3 Copies)

**Locations:** `chatgpt.ts` lines 476-483, `gemini.ts` lines 552-558, `grok.ts` lines 58-65

Same boilerplate:
```typescript
moderation_results: [],
plugin_ids: null,
gizmo_id: null,
// ...
```

**Fix:** Extract `createDefaultConversationMetadata()` in `utils/types.ts`.

### DUP-6: `dedupeText` Identical in Both Stream Parsers

**Locations:** `gemini-stream-parser.ts` lines 78-88, `grok-stream-parser.ts` lines 30-41

Exact same function.

**Fix:** Move to `utils/text-utils.ts` (which already exists).

### DUP-7: `isLikelyText` Heuristics Nearly Identical

**Locations:** `gemini-stream-parser.ts` lines 8-35, `grok-stream-parser.ts` lines 4-28

Same structure with different thresholds.

**Fix:** Extract `isLikelyStreamText(value, { minLen, maxLen })` in `utils/text-utils.ts`.

### DUP-8: Gemini Title Candidate Collection (2 Diverging Implementations)

**Locations:**
- `platforms/gemini.ts` lines 85-124 (uses `GEMINI_GENERIC_TITLES` Set)
- `utils/gemini-stream-parser.ts` lines 111-136 (uses `GENERIC_TITLE_RE` regex)

These can diverge over time (and have — see V2.1-056 where `"Conversation with Gemini"` was added to one but not the other).

**Fix:** Centralize in `utils/gemini-title-utils.ts`.

### DUP-9: Fetch/XHR Capture Logic Duplicated

**Locations:** `interceptor.content.ts`
- `handleApiMatchFromFetch` (lines ~2097-2152)
- `processXhrApiMatch` (lines ~2385-2407)
- `inspectAuxConversationFetch` (lines ~2173-2202)
- `processXhrAuxConversation` (lines ~2385-2407)

**Fix:** Extract shared `processCapturedPayload(url, body, source: 'fetch'|'xhr')`.

---

## 5. Performance Concerns

### PERF-1: O(n²) Payload Dedup in Stream Monitors

**Locations:** `interceptor.content.ts` lines 745-746, 950-957

`seenPayloadOrder.includes(payload)` in a loop over all payloads is O(n²). Over a long conversation with many chunks, this accumulates.

**Fix:** Use `seenPayloads` Set (which already exists) for the includes check, and only use the order array for trimming.

### PERF-2: `collectSearchRoots()` Walks All Shadow Roots

**Location:** `utils/ui/button-manager.ts` lines 274-296

Called on every `inject()` and `cleanupOrphanedControls()`. On pages with many shadow DOM hosts (Gemini), this can be expensive.

**Recommendation:** Cache search roots with a short TTL or debounce cleanup operations.

### PERF-3: Logger Sends One Message Per Log Entry

**Location:** `utils/logger.ts` lines 86-94

Content scripts send `browser.runtime.sendMessage()` for every single log entry. During active streaming, this can flood the message channel.

**Recommendation:** Batch log messages (e.g., flush every 500ms or every 10 entries).

### PERF-4: DOM Snapshot Scans Up to 6000 Nodes

**Location:** `interceptor.content.ts` line ~1834

`findConversationCandidate` traverses the DOM looking for conversation data. On large pages this can cause jank.

**Recommendation:** Add early exit conditions and consider caching the last-known conversation root.

### PERF-5: Stream Dump Storage Can Exceed Chrome's 5MB Quota

**Location:** `utils/diagnostics-stream-dump.ts` lines 79-81

Default limits: 25 sessions × 240 frames × 1200 chars = ~7.2MB max. Chrome's `storage.local` quota is ~5MB.

**Fix:** Reduce defaults (e.g., `maxSessions: 10`, `maxFramesPerSession: 150`) or add quota-aware pruning.

---

## 6. Brittleness & Hardcoded Values

### BRIT-1: 50+ Magic Numbers

Across the codebase, timeout values, buffer limits, retry intervals, and threshold constants are scattered as inline literals:

| File | Examples |
|------|----------|
| `interceptor.content.ts` | `50`, `30`, `100` (queue limits), `5000`, `2000` (dedupe), `900_000`, `700_000`, `1_000_000` (buffer limits), `[900, 1800, 3200, 5000, 7000, 9000, 12000, 15000]` (backoff) |
| `platform-runner.ts` | `2500` (snapshot timeout), `4500`, `1500` (debounce), `1400`, `20000` (DOM quiet), `800` (watcher interval), `4000`, `12000` (throttle) |

**Fix:** Create `utils/constants.ts` with named constants:
```typescript
export const BUFFER_MAX_BYTES = 900_000;
export const BUFFER_KEEP_TAIL_BYTES = 700_000;
export const DEDUPE_INTERVAL_MS = 5000;
export const PROACTIVE_BACKOFF_MS = [900, 1800, 3200, 5000, 7000, 9000, 12000, 15000];
// etc.
```

### BRIT-2: `INTERCEPTOR_RUNTIME_TAG` Is Manually Versioned

**Location:** `interceptor.content.ts` line 63

```typescript
const INTERCEPTOR_RUNTIME_TAG = 'v2.1.1-grok-stream';
```

This will inevitably fall out of sync with `package.json`.

**Fix:** Import version from `package.json` (WXT/Vite supports this) or remove.

### BRIT-3: Gemini Numeric Array Keys Are Undocumented Magic

**Locations:** `platforms/gemini.ts` — `obj['11']` (title), `candidate[37]` (reasoning), `candidate[1]` (text), `source[21]` (model)

These are positional indices in Google's obfuscated batchexecute format. They're not explained.

**Fix:** Add named constants and document:
```typescript
const GEMINI_PAYLOAD_KEYS = {
    TITLE: '11',        // Title metadata in conversation payload
    TEXT: 1,            // Assistant text content at index 1
    REASONING: 37,      // Reasoning/thinking content at index 37
    MODEL_SLUG: 21,     // Model identifier slot
} as const;
```

### BRIT-4: Platform DOM Selectors Will Break

Multiple places use CSS selectors tied to platform-specific DOM structure:
- ChatGPT: `[data-testid="model-switcher-dropdown-button"]`, `button[aria-label="Stop generating"]`
- Gemini: `header [aria-haspopup="menu"]`, `[class*="generating"]`
- Grok: `[data-testid="grok-header"]`, `[role="banner"]`

These are inherently brittle but unavoidable for a content script extension. **Document the selectors and their purpose** so they can be updated quickly when platforms change.

### BRIT-5: Framework Globals in DOM Snapshot

**Location:** `interceptor.content.ts` lines 2015-2020

Relies on `__NEXT_DATA__`, `__remixContext`, etc. These are framework internals that change across versions.

---

## 7. Error Handling Gaps

### ERR-1: `processQueuedMessages` Can Lose Messages on Error

**Location:** `utils/managers/interception-manager.ts` lines 314-330

```typescript
for (const message of queue) {
    if (message?.type === 'LLM_CAPTURE_DATA_INTERCEPTED' && message.data) {
        this.handleInterceptedData(message);  // Can throw!
    }
}
(this.globalRef as any).__BLACKIYA_CAPTURE_QUEUE__ = [];  // Clears ALL messages
```

If `handleInterceptedData` throws on message #3 of 10, messages #4-10 are lost.

**Fix:** Wrap the loop body in try/catch and continue processing remaining messages.

### ERR-2: Grok `parseJsonIfNeeded` Can Throw Unhandled

**Location:** `platforms/grok.ts` line ~641

```typescript
const parseJsonIfNeeded = (data: string | any): any =>
    typeof data === 'string' ? JSON.parse(data) : data;
```

`JSON.parse` can throw, but many callers don't wrap in try/catch.

**Fix:** Add try/catch and return null on failure, or rename to `tryParseJsonIfNeeded`.

### ERR-3: `common-export.ts` Missing Null Safety on `message.author`

**Location:** `utils/common-export.ts` lines 192, 204, 214, 229, 240

```typescript
if (message.author.role !== 'assistant') { ... }
```

If `message.author` is null/undefined (malformed data), this throws. The `ConversationData` type says `message` in a `MessageNode` can be `null`, but even when non-null, `author` could be missing from malformed platform data.

**Fix:** Add optional chaining: `message.author?.role`.

### ERR-4: `downloadAsJSON` Has No Error Handling

**Location:** `utils/download.ts` lines 70-84

- `JSON.stringify` can throw on circular references
- `document.body` might not exist in some contexts
- No user feedback on failure

**Fix:** Wrap in try/catch, provide user-facing error feedback.

### ERR-5: Stream Dump `flush()` Has No Quota Error Handling

**Location:** `utils/diagnostics-stream-dump.ts` lines 326-350

`storage.set()` can reject when quota is exceeded. The error propagates and the batch is lost.

**Fix:** Catch quota errors and prune old sessions before retrying.

### ERR-6: Gemini `getGeminiTitlesPayload` Can Throw

**Location:** `platforms/gemini.ts` lines 254-261

`JSON.parse(titleRpc.payload)` is not wrapped in try/catch. If the payload is malformed, the entire title flow crashes.

---

## 8. Inconsistencies

### INCON-1: Adapter Creation Patterns

| Adapter | Pattern |
|---------|---------|
| ChatGPT | `createChatGPTAdapter()` factory function returning a frozen object |
| Gemini | Direct object literal assigned to `geminiAdapter` |
| Grok | Direct object literal assigned to `grokAdapter` |

**Fix:** Use the same pattern for all three. The factory pattern is slightly more testable.

### INCON-2: Naming Conventions for Title Functions

| Adapter | Functions |
|---------|-----------|
| ChatGPT | `isPlaceholderTitle`, `deriveTitleFromFirstUserMessage` |
| Gemini | `isGenericGeminiTitle`, `normalizeGeminiDomTitle`, `normalizeGeminiTitleCandidate`, `collectGeminiTitleCandidates`, `extractTitleFromGeminiDomHeadings`, `extractTitleFromGeminiActiveConversationNav` |
| Grok | `getTitleFromFirstItem` |

The naming conventions are inconsistent (`isPlaceholder` vs `isGeneric`, `derive` vs `get` vs `extract` vs `collect`).

### INCON-3: Error Log Levels for Parse Failures

| Location | Level | Description |
|----------|-------|-------------|
| `interceptor.content.ts` `inspectAuxConversationFetch` | `info` | `'aux read err'` |
| `interceptor.content.ts` `handleApiMatchFromFetch` | `warn` | `'API read err'` |
| `interceptor.content.ts` `processXhrApiMatch` | `error` | `'XHR read err'` |

Same class of error, three different log levels.

### INCON-4: `extractConversationId` vs `extractConversationIdFromUrl`

These function names overlap and mean different things:
- `extractConversationId(url)` — extracts from page URL
- `extractConversationIdFromUrl(url)` — extracts from API/completion-trigger URL

The distinction is not obvious from the names.

### INCON-5: `any` Usage vs Strict Types

`platforms/types.ts` uses `any` in `isConversationPayload?: (payload: any) => boolean`. The rest of the interface is well-typed. Message handlers in `platform-runner.ts` also use `message: any` extensively.

**Fix:** Replace with `unknown` and add type guards.

---

## 9. Testing Gaps

### Current Coverage

**Well tested (unit tests):**
- Platform adapters: parseInterceptedData, extractConversationId, evaluateReadiness, formatFilename
- SFE: state transitions, attempt tracking, readiness gate, cross-tab probe lease
- Interception manager: title preservation, generic title detection
- Stream parsers: text extraction, title candidates
- Request classifiers: endpoint classification
- Common export: message chain building, export format
- Button manager: DOM operations, dedup
- Download: filename sanitization, timestamp generation

**Integration tests (9 files, all SFE/runner-focused):**
- attemptid-rebind-race
- cross-world-attemptid-propagation
- dispose-retry-race
- existing-conversation-load
- legacy-message-compat
- multi-tab-deterministic
- navigation-dispose-sequence
- probe-lease-collision-expiry
- supersede-during-probe

### Critical Testing Gaps

#### GAP-1: No Interceptor Tests

The interceptor (`interceptor.content.ts`) has **zero test coverage**. At 3,127 lines, this is the second largest file. It contains:
- Fetch/XHR interception logic
- Platform-specific stream monitoring
- SSE parsing for ChatGPT
- NDJSON parsing for Grok
- Batchexecute parsing for Gemini
- Proactive fetch retry logic

**Recommended tests:**
- Unit: `processChatGptSseDataPayload` with real SSE fixtures
- Unit: Gemini XHR progress monitor with incremental buffers
- Unit: Grok NDJSON stream monitor with partial chunks
- Unit: Proactive fetch backoff/cooldown logic
- Integration: Full fetch interception → postMessage → runner pipeline (mocked fetch)

#### GAP-2: No End-to-End Pipeline Tests

There are no tests that simulate the complete flow:
1. Intercepted network response → `LLM_CAPTURE_DATA_INTERCEPTED` message
2. → InterceptionManager parse + cache
3. → SFE lifecycle signals
4. → Readiness evaluation
5. → Button state update
6. → Export pipeline

**Recommended E2E tests:**
```
integration/chatgpt-capture-pipeline.test.ts
integration/gemini-capture-pipeline.test.ts
integration/grok-capture-pipeline.test.ts
```

Each should:
- Mock `window.postMessage` with realistic message sequences
- Verify correct lifecycle transitions
- Verify correct readiness decisions
- Verify exported JSON matches expected structure
- Verify title resolution works correctly

#### GAP-3: No Title Resolution Integration Tests

Given 11 title-related regressions, this is the highest-impact gap.

**Recommended tests:**
```typescript
// integration/title-resolution.test.ts
describe('title resolution pipeline', () => {
    it('ChatGPT: SSE title overrides placeholder');
    it('Gemini: stream title overrides generic');
    it('Gemini: DOM fallback when stream title is generic');
    it('Gemini: specific title survives snapshot clobber');
    it('Grok: DOM title fallback for "New conversation"');
    it('All: first-user-message fallback when all else fails');
});
```

#### GAP-4: No Calibration Pipeline Tests

Calibration logic (queue-flush → passive-wait → endpoint-retry → page-snapshot) is complex and entirely untested as a pipeline.

**Recommended tests:**
```typescript
// integration/calibration-pipeline.test.ts
describe('calibration pipeline', () => {
    it('reaches canonical_ready through endpoint retry');
    it('falls back to page snapshot after endpoint exhaustion');
    it('passive wait respects DOM quiet period');
    it('profile persistence across sessions');
});
```

#### GAP-5: No `getButtonInjectionTarget` Tests

All three adapters implement `getButtonInjectionTarget()` but none are tested. These are the most fragile platform-dependent code (CSS selectors).

**Recommended approach:** Use `happy-dom` or `jsdom` to create minimal DOM structures and verify selector matching.

#### GAP-6: No Multi-Platform Navigation Tests

SPA navigation handling differs per platform. No tests verify:
- Gemini conversation switch (URL: `/app/{id}`)
- Grok conversation switch (query param: `?conversation={id}`)
- ChatGPT route change (`/c/{id}`)

#### GAP-7: `common-export.ts` Missing Defensive Tests

No tests for malformed input:
- Missing `message.author`
- Circular `mapping` references
- Empty `mapping`
- `message.content` with unexpected structure

#### GAP-8: Stream Dump Storage Quota Tests

No tests verify behavior when `storage.local` quota is exceeded.

#### GAP-9: Button Manager Edge Cases

No tests for:
- `setSuccess()` timeout firing after `remove()`
- Multiple rapid `inject()` / `remove()` cycles
- Shadow DOM injection targets

---

## 10. Recommended Refactoring Plan

### Phase 1: Quick Wins (1-2 days)

| # | Action | Impact | Risk |
|---|--------|--------|------|
| 1 | Fix variable shadowing bug in `handleAttemptDisposedMessage` | Bug fix | Low |
| 2 | Add try/catch to `processQueuedMessages` loop | Data loss prevention | Low |
| 3 | Add optional chaining in `common-export.ts` for `message.author` | Crash prevention | Low |
| 4 | Wrap `parseJsonIfNeeded` in try/catch | Crash prevention | Low |
| 5 | Remove/gate `#region agent log` instrumentation (8 instances) | Code cleanliness | Low |
| 6 | Extract `truncateBuffer()` and `trimHistory()` helpers | Dedup | Low |
| 7 | Extract `dedupeText` and `isLikelyStreamText` to `utils/text-utils.ts` | Dedup | Low |
| 8 | Reduce stream dump defaults to fit within 5MB quota | Correctness | Low |

### Phase 2: Shared Utilities (2-3 days)

| # | Action | Impact | Risk |
|---|--------|--------|------|
| 9 | Create `utils/conversation-filename.ts` for shared `formatFilename` | Dedup, consistency | Low |
| 10 | Create `utils/conversation-readiness-evaluator.ts` for shared readiness logic | Dedup | Medium |
| 11 | Centralize title resolution into `TitleResolver` class | Prevents future title regressions | Medium |
| 12 | Centralize Gemini title candidate logic | Prevents divergence | Low |
| 13 | Create `utils/constants.ts` for magic numbers | Maintainability | Low |
| 14 | Add `createDefaultConversationMetadata()` helper | Dedup | Low |

### Phase 3: Architecture (1-2 weeks)

| # | Action | Impact | Risk |
|---|--------|--------|------|
| 15 | Decompose `platform-runner.ts` into focused modules | Maintainability, testability | High |
| 16 | Decompose `interceptor.content.ts` into focused modules | Maintainability, testability | High |
| 17 | Move platform DOM heuristics to adapters | Separation of concerns | Medium |
| 18 | Create generic `StreamMonitor` for interceptor | Extensibility | Medium |
| 19 | Add bounded LRU caches to interceptor module-level state | Memory safety | Medium |

### Phase 4: Test Coverage (ongoing)

| # | Action | Impact |
|---|--------|--------|
| 20 | Add interceptor unit tests (SSE, NDJSON, batchexecute parsing) | Critical gap |
| 21 | Add end-to-end capture pipeline tests per platform | Regression prevention |
| 22 | Add title resolution integration tests | Prevents the #1 regression category |
| 23 | Add calibration pipeline tests | Complex untested logic |
| 24 | Add `getButtonInjectionTarget` tests with DOM mocks | Fragile code coverage |

---

## 11. File-by-File Summary

### `entrypoints/interceptor.content.ts` (3,127 lines)

| Category | Finding | Severity |
|----------|---------|----------|
| Architecture | `main()` is 665 lines | Critical |
| Memory | 10+ module-level Maps/Sets with no cleanup | Critical |
| Duplication | Buffer truncation (5 copies), history trimming (4 copies), stream monitors (2 copies each) | High |
| Performance | O(n²) payload dedup, 6000-node DOM scan | Medium |
| Brittleness | `INTERCEPTOR_RUNTIME_TAG` manually versioned, framework globals | Medium |
| Types | `data?: any` in `log()`, `isConversationLike(candidate: any)` | Medium |
| Testing | **Zero test coverage** | Critical |

### `utils/platform-runner.ts` (4,641 lines)

| Category | Finding | Severity |
|----------|---------|----------|
| Architecture | Single 4,450-line closure with 150+ nested functions and 50+ shared mutable vars | Critical |
| Bug | Variable shadowing in `handleAttemptDisposedMessage` (loop var shadows outer) | High |
| Duplication | DOM snapshot logic, calibration, stream probe all inlined | Medium |
| Inconsistency | `message: any` in all message handlers | Medium |
| Maintainability | `#region agent log` instrumentation (6 instances) | Medium |
| Error handling | `alert()` for user errors, swallowed errors in calibration | Medium |
| Magic numbers | 20+ hardcoded timeouts and limits | Medium |

### `platforms/chatgpt.ts` (815 lines)

| Category | Finding | Severity |
|----------|---------|----------|
| Quality | Well-structured overall, factory pattern | Good |
| Duplication | `formatFilename`, `evaluateReadiness`, default metadata shared with others | Medium |
| Complexity | `normalizeConversationCandidate` (55 lines, many branches) | Low |
| Testing | `buildApiUrl`, `extractConversationIdFromUrl`, `isPlatformUrl` untested | Low |

### `platforms/gemini.ts` (858 lines)

| Category | Finding | Severity |
|----------|---------|----------|
| Duplication | Title candidate collection duplicated with `gemini-stream-parser.ts` | High |
| Error handling | `getGeminiTitlesPayload` — `JSON.parse` without try/catch | Medium |
| Brittleness | Numeric keys (`'11'`, `[37]`, `[1]`, `[21]`) undocumented | Medium |
| Inconsistency | Object literal (not factory function) | Low |

### `platforms/grok.ts` (1,212 lines)

| Category | Finding | Severity |
|----------|---------|----------|
| Error handling | `parseJsonIfNeeded` can throw unhandled | High |
| Duplication | `evaluateReadiness`, `formatFilename`, default metadata shared with others | Medium |
| Complexity | `parseGrokResponse` (62 lines with state object and loop) | Medium |
| Testing | `extractTitleFromDom`, `getButtonInjectionTarget` untested | Low |

### `utils/managers/interception-manager.ts` (349 lines)

| Category | Finding | Severity |
|----------|---------|----------|
| Bug | `processQueuedMessages` clears queue even if handler throws — messages lost | High |
| Types | `(this.globalRef as any).__BLACKIYA_CAPTURE_QUEUE__` — unsafe global access | Medium |
| Mutation | `preserveSpecificTitle` mutates `incoming.title` in place (non-obvious) | Medium |

### `utils/ui/button-manager.ts` (675 lines)

| Category | Finding | Severity |
|----------|---------|----------|
| Memory | `setSuccess()` timeout not cleared on `remove()` — callback on detached nodes | Medium |
| Performance | `collectSearchRoots()` walks all shadow DOM hosts on every inject | Medium |
| Lifecycle | Event listeners never explicitly removed (rely on GC) | Low |
| Style | Injected `<style>` never removed | Low |

### `utils/diagnostics-stream-dump.ts` (356 lines)

| Category | Finding | Severity |
|----------|---------|----------|
| Storage | Default limits can exceed 5MB Chrome quota | High |
| Error handling | No quota error handling on `flush()` | Medium |
| Logic | `finalizeSessions()` marks pruned[0] as truncated (confusing) | Low |

### `utils/common-export.ts` (274 lines)

| Category | Finding | Severity |
|----------|---------|----------|
| Safety | `message.author.role` used without optional chaining (5 locations) | High |
| Edge cases | No cycle detection beyond `visited` set | Low |

### `utils/sfe/signal-fusion-engine.ts` (335 lines)

| Category | Finding | Severity |
|----------|---------|----------|
| Memory | `resolutions` Map never pruned | Medium |
| Quality | Well-structured state machine, good transition table | Good |

### `utils/logger.ts` (~190 lines)

| Category | Finding | Severity |
|----------|---------|----------|
| Performance | One `sendMessage` per log entry (no batching) | Medium |
| Types | `(logObj as any)._meta` — weak typing | Low |

### `utils/download.ts` (85 lines)

| Category | Finding | Severity |
|----------|---------|----------|
| Safety | `downloadAsJSON` doesn't sanitize filename or handle errors | Medium |
| Edge cases | `JSON.stringify` can throw on circular refs | Low |

### `utils/logs-storage.ts` (~120 lines)

| Category | Finding | Severity |
|----------|---------|----------|
| Error handling | No retry on `storage.set()` quota failure | Medium |

---

## Appendix: Remaining Debug Instrumentation

The following `#region agent log` markers remain in the codebase and should be reviewed for removal or conversion to `logger.debug`:

| File | Line(s) | Description |
|------|---------|-------------|
| `utils/platform-runner.ts` | ~985, ~991 | Stabilization retry skip/scheduling |
| `utils/platform-runner.ts` | ~1018 | Stabilization retry scheduled |
| `utils/platform-runner.ts` | ~1429 | Lifecycle transition tracking |
| `utils/platform-runner.ts` | ~2196, ~2205 | Warm fetch skip/dedup |
| `platforms/grok.ts` | ~1110 | Parse entry debug |
| `utils/managers/interception-manager.ts` | ~70 | Message listener attachment |

**Recommendation:** Convert useful ones to `logger.debug()` (gated by log level) and remove the `#region`/`#endregion` wrappers. Remove any that are purely diagnostic from the regression debugging sessions.

---

*End of review.*
