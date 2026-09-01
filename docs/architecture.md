# Blackiya Architecture

> Scope: ready-terminal single-chat JSON export for ChatGPT, Gemini, Grok (`grok.com` and `x.com`), Claude, Amazon Nova, Meta Muse, Qwen, Z.ai, and DeepSeek; bulk `Export Chats` for ChatGPT, Gemini, and `grok.com`; and bounded stream-debug capture (v3 hard cut).

## 1) System Overview

Blackiya is a Manifest V3 browser extension that lets the user archive their own conversations from supported AI platforms as terminal JSON files. It does **not** run a reactive response-lifecycle state machine and never writes a conversation file automatically. It does passively clone narrowly classified, page-owned canonical detail responses into a bounded in-memory terminal cache so an explicit save can avoid a redundant request.

There are exactly three user-facing behaviors:

1. **Single-chat ready-terminal export.** An explicit Blackiya icon control (accessible as `Save JSON`) first checks the terminal response cache. On a miss it resolves deterministic adapter-declared detail candidates only where the adapter supports a direct request. Every payload is conversation-id-checked and required to be **ready and terminal** before download. A direct candidate is tried only after an eligible `404`; every other non-happy path returns a typed, fail-fast error—there are no retries, speculative warm fetches, snapshot replay, stabilization, or degraded export.
2. **Bulk `Export Chats`.** From the popup, the user exports a ChatGPT, Gemini, or `grok.com` conversation list (one JSON file per conversation).
3. **Stream-debug capture.** Raw ordered stream frames (SSE, NDJSON/line, or raw) are recorded in memory, bounded, and exported or cleared only on explicit request. The capture is in-memory only and sanitized for privacy.

Two runtime worlds exist:

- **MAIN world privileged side** (`entrypoints/interceptor.content.ts` → `entrypoints/interceptor/bootstrap.ts` and `bootstrap-main-bridge.ts`): hooks page `fetch`/`XMLHttpRequest`, clones eligible page-owned detail responses, owns bounded response/request-context stores and raw stream frames, performs explicit provider requests, validates payloads, and triggers downloads.
- **ISOLATED v3 content runtime** (`entrypoints/main.content.ts` → `features/runtime/v3-content-runtime.ts`): hosts the UI and browser-extension message handlers. It sends command-only requests to MAIN and receives typed status, error, and progress summaries.

The worlds communicate through a token-validated `window.postMessage` command channel. Its messages contain operation names, bulk options, request ids, and sanitized summaries only. Platform headers, Gemini batchexecute context, stream records, frame text, conversation payloads, and serialized JSON never cross that channel.

There is no Signal Fusion Engine, no probe lease arbitration, no calibration, no Markdown export, and no compatibility mode.

## 2) Runtime Entry & File Map

- Entry point: `entrypoints/main.content.ts`
  - Initializes a session token (`utils/protocol/session-token.ts`).
  - Boots `createV3ContentRuntime(...)` against the browser message host.
  - Wires the Blackiya icon control and popup commands to the MAIN-world command requester.
- Runtime core:
  - `features/runtime/v3-runtime.ts` — message types + typed handler (`createV3Runtime`).
  - `features/runtime/v3-content-runtime.ts` — boots the isolated runtime against the command requester.
  - `features/runtime/main-world-command-contract.ts` — command, summary, error, and progress schemas.
  - `features/runtime/main-world-command-request.ts` — isolated-side command requester; it never accepts sensitive payloads.
  - `features/runtime/main-world-command-handler.ts` — token-validated MAIN-side command dispatcher.
- Interceptor (MAIN world):
  - `entrypoints/interceptor.content.ts`
  - `entrypoints/interceptor/bootstrap.ts`
  - `entrypoints/interceptor/bootstrap-main-bridge.ts` — creates privileged operations over the existing MAIN-world stores.
- Cache-first single export:
  - `features/single-export/conversation-response-cache.ts` — five-minute, entry/byte-bounded terminal conversation cache.
  - `features/single-export/conversation-response-capture.ts` — exact-request classification, parser/readiness gating, and response-clone ingestion.
  - `platforms/meta/response-assembler.ts` — request-body-classified, cursor-ordered Meta GraphQL assembly.
  - Z.ai platform assembly — combines the page-owned detail and message batch before producing one eligible terminal conversation.
- Adapter interface + factory:
  - `platforms/types.ts`
  - `platforms/factory.ts`

## 3) Message Contract

The v3 runtime listens for messages on the browser message host (`V3RuntimeMessage`):

- `BLACKIYA_V3_EXPORT_CHATS` — payload holds `{ limit, delayMs, timeoutMs }`. Runs bulk export on the active tab.
- `BLACKIYA_V3_EXPORT_STREAM_DEBUG` — exports the current stream-debug records.
- `BLACKIYA_V3_CLEAR_STREAM_DEBUG` — clears the current stream-debug records.

Responses are `{ ok: true; result }` or `{ ok: false; error, errorKind? }`. The result is a bounded status summary: single export returns platform/filename, bulk returns counts/warnings, stream-debug export returns stream/frame counts and filename, and stream-debug clear returns the number of cleared streams. The MAIN side performs every download before sending success.

The world command channel uses:

- `BLACKIYA_MAIN_WORLD_COMMAND` — operation plus request id and, for bulk export, normalized options.
- `BLACKIYA_MAIN_WORLD_PROGRESS` — bulk counts and sanitized progress messages.
- `BLACKIYA_MAIN_WORLD_RESULT` — typed success or error summary.

The channel requires the exact page window (`event.source === window.self`) and exact page origin (`event.origin === window.location.origin`); absent, `null`, synthetic, and cross-origin values are rejected. This is an authorization gate for the extension command path, not a page confidentiality or command-integrity boundary: same-page scripts can observe and replay the token-stamped safe commands because a MAIN-world `window.postMessage` bridge cannot be extension-private. That hostile-page replay scenario is outside v3's threat model. Credentials, conversation payloads, stream records, and frame text never cross the channel.

Bulk export progress is emitted as `BLACKIYA_BULK_EXPORT_PROGRESS` messages with stages `started`, `progress`, `completed`, `failed`. The isolated runtime removes the internal MAIN-world request envelope before forwarding each progress message to the background worker, which shows the remaining count on the extension action badge and clears it on completion.

Export messages and MAIN-world command responses are token-stamped so a mismatched/absent session token is dropped (no compatibility mode).

## 4) Single-Chat Terminal Export (Fail-Fast)

Primary module: `features/single-export/single-export-service.ts`.

`performSingleExport(timeoutMs, deps)`:

1. Resolves the platform adapter and conversation id **only at click time** from the active page URL (`deps.resolveAdapter(pageUrl)`, `deps.getPageUrl()`).
2. Looks up `{ adapter.name, conversationId }` in the bounded in-memory cache and revalidates identity plus ready-terminal state. An eligible hit is serialized and downloaded without another provider request.
3. On a cache miss or ineligible entry, maps platform + conversation id to a deterministic detail-request candidate list via `features/single-export/endpoint-resolver.ts` (URL, method, headers, body). If the adapter has no deterministic request, the kernel returns `missing_endpoint` immediately.
4. Dispatches direct candidates with one hard timeout budget (`AbortController`). Default `15000ms`, clamped to `[1000, 60000]` (`SINGLE_EXPORT_DEFAULT_TIMEOUT_MS`). A candidate advances only when an eligible `404` is available; the timeout covers both headers and body reads. ChatGPT and DeepSeek require a non-empty, case-insensitive `authorization` header before dispatch.
5. Validates the direct response:
   - Missing ChatGPT or DeepSeek `authorization` → `missing_auth` before dispatch.
   - Non-2xx → `http_failure`; `401/403` → `missing_auth` and provider-scoped request-context invalidation.
   - Empty/bad body or parse failure → `parse_failure`.
   - A declared or streamed body above `16 MiB` is cancelled and returns `response_too_large`.
   - `parsed.conversation_id` must equal the id from the URL → else `id_mismatch`.
   - `evaluateReadiness.ready` and `evaluateReadiness.terminal` must both be `true` → else `not_terminal`. ChatGPT treats a `finished_successfully` assistant node with `end_turn: true` as terminal even when its output is a multimodal/image, code, or execution artifact with no text. It also treats a `finished_successfully` `reasoning_recap` with `metadata.reasoning_status: reasoning_ended` as terminal when ChatGPT omits `end_turn`, and accepts a completed deep-research assistant-code/tool-code branch with or without ChatGPT's trailing empty terminal assistant placeholder. In-progress and non-terminal thoughts remain rejected.
6. On success, serializes the complete platform archive (including the full normalized `mapping` tree and provider response retained in platform-specific raw payload fields) and injects the download via `deps.downloadJson(jsonString, filename)`. The boundary idempotently adds `.json` when needed. In production this kernel runs in the MAIN-world privileged command handler; the isolated button receives only a typed status summary or error.

The kernel returns a discriminated `SingleExportResult`. It never throws on a contract failure path. Errors:

`unsupported_platform`, `missing_conversation_id`, `missing_endpoint`, `missing_auth`, `http_failure`, `download_failure`, `timeout`, `response_too_large`, `parse_failure`, `id_mismatch`, `not_terminal`.

Invariants: one explicit action per call, eligible cache first, deterministic `404` candidate fallback only, no retries/backoff, no fallback-on-timeout, no speculative warm request, no snapshot replay, no stabilization, and no degraded export.

### 4.1 Cache-First Capture

The MAIN-world interceptor observes page-owned `fetch` and XHR traffic without consuming or delaying the page response. Page Fetch forwarding begins concurrently with capture planning; streamed request-body inspection fails open after `25ms` and cancels only its clone. It classifies status, URL, method, request context, and declared response size before cloning. Eligible response captures are sequence-checked before cloning, limited to three concurrent bounded reads, and stream-read through the cache's hard per-entry byte cap; oversized/erroring readers are cancelled. The bounded text is then parsed and terminal-validated before the normalized archive enters `ConversationResponseCache`.

Default cache bounds:

- maximum entries: `12`
- maximum bytes per entry: `16 MiB`
- maximum retained bytes: `48 MiB`
- expiry: `5 minutes`

The cache is page-local and in-memory only. It is not browser storage, is not restored after reload/session teardown, and never contains request headers, cookies, tokens, or Gemini RPC context. Oversized, malformed, conversation-id-inconsistent, incomplete, or non-terminal candidates are not eligible. A matching non-terminal detail response or exact-provider generation start invalidates the prior terminal snapshot immediately, so an explicit save cannot export a superseded turn. Canonical ChatGPT, Gemini, Grok, Claude, Qwen, DeepSeek, and exact-target Nova request starts advance a per-conversation sequence; delayed responses from an older sequence cannot overwrite or evict a newer snapshot. DeepSeek conditional-cache requests, Meta pagination, and Z.ai message-batch halves do not advance that sequence because they are not independently complete snapshots. Expired entries and pending assembly text are pruned by scheduled expiry even without later cache access; oldest-entry removal enforces the entry and aggregate-byte bounds. First establishing or changing an allowlisted identity-bearing request-context field clears that provider's cached conversations and pending multi-response assembly while advancing a provider epoch, so delayed pre-invalidation clones cannot repopulate state. An observed `401/403` also clears the recognized provider's request context and conversation state and advances that epoch.

That invalidation is deliberately not described as universally account-bound. The current sanitized request evidence establishes no reliable non-secret ordinary account-switch or logout marker for five providers:

| Provider | Observable sanitized context | Why it is not an account/logout boundary |
| :--- | :--- | :--- |
| Claude | Organization id in the canonical conversation URL | Organization routing can change without identifying the signed-in account. |
| Meta Muse | GraphQL document id, conversation id, and pagination cursor | These identify an operation or conversation, not the viewer account. |
| Amazon Nova | RPC target and non-unique `userType`; request credentials are excluded from identity tracking | The target/type identifies the operation or class of caller, not one account. |
| DeepSeek | Expiring bearer authorization plus client/cache metadata | Authorization changes invalidate provider state but are never persisted; the remaining metadata is shared across accounts. |
| Z.ai | Region in request context; user ids occur only inside conversation responses | Region is not identity, and response identifiers are not promoted into a separate retained account tracker. |

For those providers, state is still cleared on a recognized `401/403` and page/session teardown, and stale entries become ineligible through scheduled cache expiry. An ordinary in-tab account change that produces neither an identity-bearing request-context change nor an auth failure is not claimed detectable. New invalidation signals must be supported by sanitized evidence and must not require persisting an account identifier or credential.

Multiplexed and multi-response transports require more context than URL/method matching:

- **Meta Muse:** `POST /api/graphql` carries unrelated operations. The interceptor reads Request clones and response clones through the hard byte cap before parsing, parses the request body to distinguish conversation detail from backward pagination, and retains bounded cursor-keyed halves regardless of clone-completion order. When Meta embeds the initial detail in the page's Next.js Flight data, the explicit save action reads that bounded page-local payload and joins it with the already captured backward pages. Pagination halves neither invalidate the shared snapshot nor advance provider identity epochs. The assembler uses the same five-minute/12-entry/16-MiB/48-MiB bounds plus a 100-page-per-conversation cap; only a closed, ready-terminal archive enters the shared cache.
- **Amazon Nova:** unrelated RPCs share `POST /api`. The response is eligible only when the exact `x-amz-target` request header identifies the conversation-detail operation. Nova message strings are AES-GCM encrypted in that response; capture decrypts them with the response-local key, then discards the key and caches only the decrypted archive. A missing or invalid key fails closed.
- **Z.ai:** the metadata detail and message batch are individually insufficient. Request and response clones are byte-capped before parsing, and either bounded half may finish cloning first. The detail `GET` invalidates the matching shared snapshot when a new sequence starts; a message-batch half does not invalidate it or advance provider identity epochs. Assembly requires matching finite `message_version` revisions, validates the conversation/current-node identity, exact requested message IDs, single-root cycle-free full graph coverage, and terminal current leaf before caching the merged archive.

### 4.2 Provider Support and Direct Requests

| Provider | Eligible page-owned response | Direct fallback after cache miss | Bulk export |
| :--- | :--- | :--- | :--- |
| ChatGPT | Canonical mapping detail `GET`, or a closed flat-message `/backend-api/conversations/{id}` detail response | Adapter-declared detail candidates; auth required | Yes |
| Gemini | Conversation batchexecute RPC | Deterministic batchexecute `POST`; captured `at` context required | Yes |
| Grok (`grok.com`) | Canonical REST conversation detail | Adapter-declared REST candidates | Yes |
| Grok (`x.com/i/grok`) | Canonical conversation-items GraphQL query | Deterministic conversation-items GraphQL `GET` | No |
| Claude | Canonical organization-scoped conversation detail, including current `tree=True`/inline-comparison responses with nil-root graphs | No; cache-only | No |
| Amazon Nova | Target-header-classified conversation RPC | No; cache-only | No |
| Meta Muse | Request-body-classified, cursor-complete GraphQL archive | No; cache-only | No |
| Qwen | Canonical complete-history detail | Deterministic detail `GET` | No |
| Z.ai | Identity-consistent detail + message batch assembly | No; cache-only | No |
| DeepSeek | Canonical history detail, including the current null-parent root shape | Deterministic history `GET` | No |

Cache-only does not mean degraded or partial export. It means the Blackiya icon reuses a fresh terminal response the site itself loaded and returns `missing_endpoint` when no eligible cached response exists.

Canonical Grok detail payloads replace prior parser graph state so server-removed or replaced nodes cannot survive into a later export. Incremental Grok transports retain their merge behavior, and readiness follows only the active `current_node` ancestry rather than inactive alternative branches.

Direct request details:

Every adapter-built candidate must use HTTPS, contain no userinfo, and match an exact origin declared by that adapter before captured request headers are read or forwarded. One unsafe candidate rejects the entire candidate set.

ChatGPT's page may load a closed flat-message detail response from `/backend-api/conversations/{id}`. The interceptor caches it only when `page_info` reports neither a previous nor next page, retains the source `messages` array verbatim, and builds the ordered mapping used by shared readiness validation. This cache hit avoids a redundant explicit request. Paginated flat responses remain ineligible.

- ChatGPT: `/backend-api/conversation/{id}` (with `/backend-api/f/conversation/{id}` as fallback candidate), `GET`.
- Grok (`grok.com`): `/rest/app-chat/conversations_v2/{id}?includeWorkspaces=true&includeTaskResult=true` (fallback: adapter `buildApiUrls`), `GET`.
- Grok (`x.com`): canonical `GrokConversationItemsByRestId` GraphQL `GET` with numeric conversation identity.
- Gemini: batchexecute `POST` to `/_/BardChatUi/data/batchexecute` with `rpcids`, `source-path=/app/{id}`, `_reqid`, and body containing `f.req` + the `at` token. Requires Gemini batchexecute context (`at`, plus optional `bl`, `f.sid`, `hl`, `reqid`, `rt`); missing `at` → `missing_auth`.
- Qwen: canonical complete-history `GET` with the required history direction/limit query.
- DeepSeek: canonical history `GET` keyed by the active conversation id and requiring the captured page-injected bearer authorization. The full response may use `parent_id: null` for its root; later conditional-cache requests do not invalidate it, and responses with no messages are not exportable archives.

## 5) Export Controls (Blackiya Icon)

Primary module: `features/export-controls/export-controls.ts`.

A single icon-only button (`#blackiya-v3-export-chat-btn`) inside a fixed container (`#blackiya-v3-export-controls`, attribute `data-blackiya-export-controls`). It uses the packaged Blackiya icon asset and keeps a state-aware accessible label and tooltip for idle, loading, success, and error states.

Button states: `idle` ("Save conversation JSON (current data)"), `loading` ("Saving JSON..."), `success` ("JSON saved"), `error` ("Save failed. Click to retry."). The button is disabled unless `idle`. On success/error it resets to `idle` after a short timer.

On click it resolves an export action context (`{ platform, conversationId }`) and invokes `onExport`. Any failure resets the button to `error` for retry.

There is one export control: the Blackiya icon. The legacy controls are not mounted:

`blackiya-lifecycle-badge`, `blackiya-save-btn`, `blackiya-save-markdown-btn`, `blackiya-force-save-json-btn`, `blackiya-calibrate-btn` (see `DESCOPED_CONTROL_IDS` in `features/export-controls/contract.ts`).

## 6) Bulk Export Chats

Primary module: `features/bulk-export/orchestrator.ts` (`runBulkExport`).

- Popup sends `BLACKIYA_V3_EXPORT_CHATS` (`BULK_EXPORT_CHATS_MESSAGE`) to the active tab with `{ limit, delayMs, timeoutMs }`. The isolated runtime forwards that operation to the MAIN-world command handler; provider requests and downloads stay in MAIN.
- MAIN-side `runBulkExport` resolves the platform adapter from the active URL and:
  1. Discovers conversation IDs from the platform list endpoint.
  2. Fetches each detail payload (paced, per-request timeout).
  3. Parses via the active adapter.
  4. Validates the returned `conversation_id` matches the requested id and requires adapter readiness to be both ready and terminal before download; rejected payloads count as failures.
  5. Attaches canonical export metadata (`captureSource`, `fidelity`, `completeness`).
  6. Downloads one JSON file per conversation.
- Options normalization (`features/bulk-export/options.ts`): default pacing delay `1200ms`, default timeout `20000ms`. `Max chats` of `0` equals all (default). Delay is clamped to `[250, 20000]`, timeout to `[5000, 60000]`.
- Command waiting: the isolated MAIN-world requester does not apply the single/stream `15s` bridge deadline to bulk operations. It waits for the MAIN-side run to finish; each provider request and bounded `429` retry remains governed by the normalized bulk timeout, so the popup cannot report a bridge timeout while MAIN is still downloading files.
- Fetch (`features/bulk-export/fetch.ts`): `429` is retried up to `MAX_429_RETRIES = 3` with `retry-after` / `x-rate-limit-reset` awareness, bounded by the remaining request deadline; `401/403` clears the platform headers cache and fails the active run before any candidate or later conversation can reuse its rejected request context; non-auth detail failures retain candidate fallback behavior.
- Progress (`features/bulk-export/progress.ts`): `started` / `progress` / `completed` / `failed` messages with `discovered`, `attempted`, `exported`, `failed`, `remaining`.
- Result summary: `{ platform, discovered, attempted, exported, failed, elapsedMs, limit, warnings }`.

Platform coverage (intentionally unchanged by the wider single-save support):

- ChatGPT: list endpoint + detail endpoints; requires a captured non-empty `authorization` header and validates each detail payload before download.
- Grok (`grok.com`): `/rest/app-chat/conversations` list + detail variants.
- Gemini: best-effort via batchexecute RPC (title list + conversation), using intercepted batchexecute request context; missing `at` fails fast rather than falling back to cookie-only detail GET.

`x.com` Grok, Claude, Amazon Nova, Meta Muse, Qwen, Z.ai, and DeepSeek are not bulk providers in this release. The popup must fail clearly rather than implying that single-save support includes list enumeration.

## 7) Stream-Debug Capture

Primary modules: `features/stream-debug/*`.

Generation endpoints are classified (`features/stream-debug/generation-endpoint.ts`):

- ChatGPT: `POST /backend-api/f/conversation`
- Gemini: `POST /_/BardChatUi/data/assistant.lamda.bardfrontendservice/streamgenerate`
- Grok: `POST /2/grok/add_response.json` or `POST /rest/app-chat/conversations/new`
- Qwen: `POST /api/v2/chat/completions`

No generation endpoint is registered for Claude, Amazon Nova, Meta Muse, Z.ai, or DeepSeek in this release. Their supplied reload/detail traffic did not establish a generation transport, so the classifier does not speculate. Grok generation capture includes the exact `/2/grok/add_response.json` transport on its declared Grok and X origins.

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
- TTL: `15 minutes` (idle or ended streams are pruned by a scheduled in-memory expiry, even without another recorder operation)

The recorder clamps each frame to its byte budget. When a bound is reached it evicts ordinary frames before transport and terminal/refusal/replacement/erase frames, preserving the late signals needed to diagnose refusals and server-side replacement/erase events. Input truncation and evicted retained bytes are both reflected in the byte/frame counters and `truncated` flag. When the stream count exceeds the cap, the oldest streams are evicted.

Explicit export + clear use the token-validated MAIN-world command handler (`features/runtime/main-world-command-handler.ts`). MAIN serializes the bounded records and triggers the stream-debug JSON download itself, then returns only `{ streamCount, frameCount, filename }`. Clear empties the recorder and returns only the cleared-stream count. Stream records and frame text never cross into the isolated runtime and are never written into conversation JSON exports.

## 8) Request Context and Conversation Cache Privacy

Primary modules: `entrypoints/main.content.ts`, `utils/platform-header-store.ts`, and `entrypoints/interceptor/gemini-batchexecute-context-store.ts`.

At explicit export time, the MAIN-world command handler reads the active adapter, page URL, provider-allowlisted auth/client snapshot, and (for Gemini) batchexecute context directly from its page-local stores. The isolated runtime does not request or receive those values. The interceptor stores defensive request-context snapshots in memory with a five-minute expiry. When an allowlisted identity-bearing request-context field is available, establishing or changing that field replaces the prior platform snapshot and clears that provider's conversation/assembly cache. A recognized provider `401/403` response clears both request context and conversation state; Gemini also clears its batchexecute context.

This is a request-context boundary, not a universal account-session detector. Claude, Meta Muse, Amazon Nova, DeepSeek, and Z.ai currently expose no reliable non-secret account-switch/logout signal in the sanitized request context described above. Their organization, operation, conversation, client, cache, region, and response-body user fields must not be treated as proof of an account change.

Request context and conversation data remain separate:

- Request-context stores contain only provider-allowlisted headers/RPC fields needed for eligible direct requests.
- The conversation-response cache contains serialized terminal conversation archives and no captured request headers, cookies, or tokens.
- Neither store is persisted, placed in extension storage, or transferred through the cross-world command channel.
- Cache-first download is still explicit: observing a response only retains it temporarily; no file is written until the Blackiya icon is clicked.

If request-context is missing (`missing_auth`) or a cache-only provider has no eligible response (`missing_endpoint`), the kernel fails fast rather than guessing credentials or request shapes.

## 9) Diagnostics and Debugging

Debug artifacts:

- Stream-debug record(s) — raw ordered stream frames, exported explicitly.
- HAR analysis — `bun run har:analyze --input <file.har> ...` for endpoint drift.
- Unit/integration tests — `bun test` cover readiness, single-export, bulk-export, runtime, and stream-debug behavior with sanitized fixtures.
- Compile/build checks — `bun run compile` and `bun run build` validate the TypeScript graph and production MV3 bundle.

Docs:

- `docs/debug-logs-guide.md`

## 10) Non-Goals (Removed in v3)

The following v2 concepts are intentionally **not** part of the v3 runtime:

- Response lifecycle state machine (`idle -> prompt-sent -> streaming -> completed`).
- Signal Fusion Engine, readiness decision modes (`canonical_ready`, `awaiting_stabilization`, `degraded_manual_only`).
- Save vs Force-Save gating and degraded/manual-only exports.
- Probe leases, cross-tab arbitration, calibration, canonical stabilization, speculative warm-fetch requests, or snapshot/playback recovery. Bounded reuse of a terminal detail response that the page already loaded is part of v3 and is not snapshot recovery.
- Markdown export/transcripts and `export:markdown` conversions.
- Lifecycle/probe toasts and `stream-done` readiness states.
- Compatibility mode and the legacy lifecycle wire protocol.
