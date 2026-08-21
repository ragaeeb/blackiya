# Blackiya Architecture

> Scope: ChatGPT, Gemini, Grok — explicit ready-terminal JSON export, bulk `Export Chats`, and bounded stream-debug capture (v3 hard cut).

## 1) System Overview

Blackiya is a Manifest V3 browser extension that lets the user archive their own conversations from ChatGPT, Gemini, and Grok as verbatim JSON files. It does **not** react to a response lifecycle and does **not** auto-capture conversation data.

There are exactly three user-facing behaviors:

1. **Single-chat ready-terminal export.** An explicit `Save JSON` control on the page resolves deterministic adapter-declared detail candidates, validates the server response is **ready and terminal**, and downloads a complete JSON archive. A candidate is tried only after an eligible `404`; every other non-happy path returns a typed, fail-fast error — there are no retries, no warm-fetch, no snapshot replay, no stabilization, and no degraded export.
2. **Bulk `Export Chats`.** From the popup, the user exports a list of conversations from the active platform tab (one JSON file per conversation).
3. **Stream-debug capture.** Raw ordered stream frames (SSE, NDJSON/line, or raw) are recorded in memory, bounded, and exported or cleared only on explicit request. The capture is in-memory only and sanitized for privacy.

Two runtime worlds exist:

- **MAIN world interceptor** (`entrypoints/interceptor.content.ts` → `entrypoints/interceptor/bootstrap.ts`): hooks page `fetch`/`XMLHttpRequest`, captures request-context (auth headers, Gemini batchexecute context), and optionally feeds raw stream frames to the stream-debug recorder.
- **ISOLATED v3 content runtime** (`entrypoints/main.content.ts` → `features/runtime/v3-content-runtime.ts`): hosts the single-chat export control, bulk export runner, and the stream-debug bridge.

There is no Signal Fusion Engine, no probe lease arbitration, no calibration, no Markdown export, and no compatibility mode.

## 2) Runtime Entry & File Map

- Entry point: `entrypoints/main.content.ts`
  - Initializes a session token (`utils/protocol/session-token.ts`).
  - Boots `createV3ContentRuntime(...)` against the browser message host.
  - Wires bulk export (`runBulkExport`), request-context resolution, and the stream-debug bridge.
- Runtime core:
  - `features/runtime/v3-runtime.ts` — message types + typed handler (`createV3Runtime`).
  - `features/runtime/v3-content-runtime.ts` — boots the runtime and the stream-debug bridge.
  - `features/runtime/v3-stream-debug-bridge.ts` — postMessage bridge for stream-debug export/clear.
  - `features/runtime/platform-header-request.ts` and `features/runtime/gemini-context-request.ts` — request-context bridges for explicit actions.
- Interceptor (MAIN world):
  - `entrypoints/interceptor.content.ts`
  - `entrypoints/interceptor/bootstrap.ts`
- Adapter interface + factory:
  - `platforms/types.ts`
  - `platforms/factory.ts`

## 3) Message Contract

The v3 runtime listens for messages on the browser message host (`V3RuntimeMessage`):

- `BLACKIYA_V3_EXPORT_CHATS` — payload holds `{ limit, delayMs, timeoutMs }`. Runs bulk export on the active tab.
- `BLACKIYA_V3_EXPORT_STREAM_DEBUG` — exports the current stream-debug records.
- `BLACKIYA_V3_CLEAR_STREAM_DEBUG` — clears the current stream-debug records.

Responses are `{ ok: true; result? }` or `{ ok: false; error }`.

The stream-debug bridge exchanges messages on the window (same origin, session-token validated):

- `BLACKIYA_V3_STREAM_DEBUG_EXPORT_REQUEST` / `..._EXPORT_RESPONSE`
- `BLACKIYA_V3_STREAM_DEBUG_CLEAR_REQUEST` / `..._CLEAR_RESPONSE`

Bulk export progress is emitted as `BLACKIYA_BULK_EXPORT_PROGRESS` messages with stages `started`, `progress`, `completed`, `failed`.

Export messages and stream-debug bridge responses are token-stamped so a mismatched/absent session token is dropped (no compatibility mode).

## 4) Single-Chat Terminal Export (Fail-Fast)

Primary module: `features/single-export/single-export-service.ts`.

`performSingleExport(timeoutMs, deps)`:

1. Resolves the platform adapter and conversation id **only at click time** from the active page URL (`deps.resolveAdapter(pageUrl)`, `deps.getPageUrl()`).
2. Maps platform + conversation id to a deterministic detail-request candidate list via `features/single-export/endpoint-resolver.ts` (URL, method, headers, body).
3. Dispatches the candidates with one hard timeout budget (`AbortController`). Default `15000ms`, clamped to `[1000, 60000]` (`SINGLE_EXPORT_DEFAULT_TIMEOUT_MS`). ChatGPT advances only when a candidate returns `404`; the timeout covers both headers and body reads. ChatGPT also requires a non-empty, case-insensitive `authorization` header before dispatch.
4. Validates the response:
   - Missing ChatGPT `authorization` → `missing_auth` before dispatch.
   - Non-2xx → `http_failure`; `401/403` → `missing_auth` and provider-scoped request-context invalidation.
   - Empty/bad body or parse failure → `parse_failure`.
   - `parsed.conversation_id` must equal the id from the URL → else `id_mismatch`.
   - `evaluateReadiness.ready` and `evaluateReadiness.terminal` must both be `true` → else `not_terminal`.
5. On success, serializes the complete platform payload (including the full `mapping` tree and platform-specific raw payload fields, preserved verbatim) and injects the download via `deps.downloadJson(jsonString, filename)`.

The kernel returns a discriminated `SingleExportResult`. It never throws on a contract failure path. Errors:

`unsupported_platform`, `missing_conversation_id`, `missing_endpoint`, `missing_auth`, `http_failure`, `download_failure`, `timeout`, `parse_failure`, `id_mismatch`, `not_terminal`.

Invariants: one explicit action per call, deterministic `404` candidate fallback only, no retries/backoff, no fallback-on-timeout, no warm fetch, no snapshot replay, no stabilization, no degraded export.

### 4.1 Deterministic detail URL (endpoint-resolver)

- ChatGPT: `/backend-api/conversation/{id}` (with `/backend-api/f/conversation/{id}` as fallback candidate), `GET`.
- Grok (`grok.com`): `/rest/app-chat/conversations_v2/{id}?includeWorkspaces=true&includeTaskResult=true` (fallback: adapter `buildApiUrls`), `GET`.
- Gemini: batchexecute `POST` to `/_/BardChatUi/data/batchexecute` with `rpcids`, `source-path=/app/{id}`, `_reqid`, and body containing `f.req` + the `at` token. Requires Gemini batchexecute context (`at`, plus optional `bl`, `f.sid`, `hl`, `reqid`, `rt`); missing `at` → `missing_auth`.

## 5) Export Controls (Save JSON Button)

Primary module: `features/export-controls/export-controls.ts`.

A single button (`#blackiya-v3-export-chat-btn`) inside a fixed container (`#blackiya-v3-export-controls`, attribute `data-blackiya-export-controls`).

Button states: `idle` ("Save JSON"), `loading` ("Saving…"), `success` ("✓ Saved"), `error` ("⚠ Failed"). The button is disabled unless `idle`. On success/error it resets to `idle` after a short timer.

On click it resolves an export action context (`{ platform, conversationId }`) and invokes `onExport`. Any failure resets the button to `error` for retry.

There is one export control: `Save JSON`. The legacy controls are not mounted:

`blackiya-lifecycle-badge`, `blackiya-save-btn`, `blackiya-save-markdown-btn`, `blackiya-force-save-json-btn`, `blackiya-calibrate-btn` (see `DESCOPED_CONTROL_IDS` in `features/export-controls/contract.ts`).

## 6) Bulk Export Chats

Primary module: `features/bulk-export/orchestrator.ts` (`runBulkExport`).

- Popup sends `BLACKIYA_V3_EXPORT_CHATS` (`BULK_EXPORT_CHATS_MESSAGE`) to the active tab with `{ limit, delayMs, timeoutMs }`.
- `runBulkExport` resolves the platform adapter from the active URL and:
  1. Discovers conversation IDs from the platform list endpoint.
  2. Fetches each detail payload (paced, per-request timeout).
  3. Parses via the active adapter.
  4. Validates the returned `conversation_id` matches the requested id and requires adapter readiness to be both ready and terminal before download; rejected payloads count as failures.
  5. Attaches canonical export metadata (`captureSource`, `fidelity`, `completeness`).
  6. Downloads one JSON file per conversation.
- Options normalization (`features/bulk-export/options.ts`): default pacing delay `1200ms`, default timeout `20000ms`. `Max chats` of `0` equals all (default). Delay is clamped to `[250, 20000]`, timeout to `[5000, 60000]`.
- Fetch (`features/bulk-export/fetch.ts`): `429` is retried up to `MAX_429_RETRIES = 3` with `retry-after` / `x-rate-limit-reset` awareness, bounded by the remaining request deadline; `401/403` clears the platform headers cache; detail URL candidates fall through on failure.
- Progress (`features/bulk-export/progress.ts`): `started` / `progress` / `completed` / `failed` messages with `discovered`, `attempted`, `exported`, `failed`, `remaining`.
- Result summary: `{ platform, discovered, attempted, exported, failed, elapsedMs, limit, warnings }`.

Platform coverage:

- ChatGPT: list endpoint + detail endpoints; requires a captured non-empty `authorization` header and validates each detail payload before download.
- Grok (`grok.com`): `/rest/app-chat/conversations` list + detail variants.
- Gemini: best-effort via batchexecute RPC (title list + conversation), using intercepted batchexecute request context; missing `at` fails fast rather than falling back to cookie-only detail GET.

## 7) Stream-Debug Capture

Primary modules: `features/stream-debug/*`.

Generation endpoints are classified (`features/stream-debug/generation-endpoint.ts`):

- ChatGPT: `POST /backend-api/f/conversation`
- Gemini: `POST /_/BardChatUi/data/assistant.lamda.bardfrontendservice/streamgenerate`
- Grok: `POST /2/grok/add_response.json` or `POST /rest/app-chat/conversations/new`

The recorder (`features/stream-debug/recorder.ts`) stores in-memory records. Each record has a `streamId`, `platform`, `endpoint`, `method`, sanitized `path`, timestamps, ordered `frames`, terminal `termination`, raw and retained byte/frame accounting, and truncation counters.

Frames carry `sequence`, `frameId`, `kind` (`data`/`raw`/`raw_chunk`/`sse_event`/`ndjson_line`/`done`/`refusal`/`replacement`/`erase`/`transport`), optional event metadata, text, timestamps, byte accounting, and `truncated`.

Framing (`features/stream-debug/stream-monitor.ts`):

- `sse` — split on double-newlines; `[DONE]` is marked as a `done` event.
- `line` (NDJSON) — split on newlines.
- `raw` — record each raw chunk.

XHR streams (`features/stream-debug/xhr-monitor.ts`) append deltas read from `responseText` through the same frame assembler.

Bounded recorder defaults (`features/stream-debug/recorder.ts`):

- max concurrent streams: `64`
- max frames per stream: `512`
- max bytes per frame: `64 KiB`
- max bytes per stream: `512 KiB`
- max retained bytes across streams: `8 MiB`
- TTL: `15 minutes` (idle/ended streams are pruned)

The recorder clamps each frame to its byte budget. When a bound is reached it evicts ordinary frames before transport and terminal/refusal/replacement/erase frames, preserving the late signals needed to diagnose refusals and server-side replacement/erase events. Input truncation and evicted retained bytes are both reflected in the byte/frame counters and `truncated` flag. When the stream count exceeds the cap, the oldest streams are evicted.

Explicit export + clear use the token-validated postMessage bridge (`features/runtime/v3-stream-debug-bridge.ts` + `features/stream-debug/bridge.ts`). Records are returned to the caller on `EXPORT_REQUEST`; `CLEAR_REQUEST` empties the recorder. Stream records are never written into conversation JSON exports.

## 8) Request-Context Capture Without Credential Persistence

Primary modules: `entrypoints/main.content.ts`, `utils/platform-header-store.ts`, and `entrypoints/interceptor/gemini-batchexecute-context-store.ts`.

At explicit export time the runtime requests:

- the active platform adapter,
- the conversation id from the page URL,
  - captured platform auth headers (`features/runtime/platform-header-request.ts`),
  - the Gemini batchexecute context (`at`, `bl`, `f.sid`, `hl`, `_reqid`, `rt` — `features/runtime/gemini-context-request.ts`).

The interceptor stores defensive snapshots in memory with a five-minute expiry and forwards only provider allowlisted headers. Header identity changes replace the prior platform snapshot; a provider's 401/403 response clears that provider's headers, and Gemini also clears its batchexecute context. The snapshots are never written into the exported JSON and are not persisted across sessions. If request-context is missing (`missing_auth`), the kernel fails fast rather than guessing credentials. Conversation JSON reflects the server's terminal response, including the complete mapping and preserved platform payload fields.

## 9) Diagnostics and Debugging

Debug artifacts:

- Stream-debug record(s) — raw ordered stream frames, exported explicitly.
- HAR analysis — `bun run har:analyze --input <file.har> ...` for endpoint drift.
- Deterministic browser harness — `bun run test:e2e -- e2e/harness.playwright.ts` covers terminal success, non-terminal fail-closed behavior, JSON download contents, and artifact-host replacement survival.

Docs:

- `docs/debug-logs-guide.md`

## 10) Non-Goals (Removed in v3)

The following v2 concepts are intentionally **not** part of the v3 runtime:

- Response lifecycle state machine (`idle -> prompt-sent -> streaming -> completed`).
- Signal Fusion Engine, readiness decision modes (`canonical_ready`, `awaiting_stabilization`, `degraded_manual_only`).
- Save vs Force-Save gating and degraded/manual-only exports.
- Probe leases, cross-tab arbitration, calibration, canonical stabilization, warm-fetch, or snapshot/playback recovery.
- Markdown export/transcripts and `export:markdown` conversions.
- Lifecycle/probe toasts and `stream-done` readiness states.
- Compatibility mode and the legacy lifecycle wire protocol.
