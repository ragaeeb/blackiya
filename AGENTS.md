# AGENTS.md

Operational guide for AI/code agents working in this repository.

## 1) Project Snapshot

Blackiya is a Chrome MV3 extension that exports conversation data from ChatGPT, Gemini, Grok (`grok.com` and `x.com`), Claude, Amazon Nova, Meta Muse, Qwen, Z.ai, and DeepSeek as terminal JSON files, and provides a bounded, on-demand transport-level trace.

The v3 runtime has three user-facing surfaces:

1. **Single-chat ready-terminal export** — an explicit `Save JSON` control on the active conversation. It first checks a bounded in-memory cache of terminal canonical detail responses already loaded by the page, then uses deterministic adapter-declared detail candidates only where the adapter supports a direct request. It validates the conversation id and ready-terminal state before injecting a JSON download. It is fail-fast.
2. **Bulk `Export Chats`** — a popup-driven export for ChatGPT, Gemini, and `grok.com`. It discovers conversation IDs from the platform list endpoint, fetches each detail payload, and downloads one JSON file per conversation.
3. **Stream-debug capture** — raw ordered stream frames (SSE, NDJSON/line, or raw) are recorded in memory, bounded, and exported or cleared only on explicit request.

Hard-cut invariants (the v3 model):

- **Explicit, ready-terminal-only export.** The single-chat kernel prefers an eligible cached response, otherwise resolves deterministic detail candidates where available, advances only after an eligible `404`, validates the server response is ready and terminal, and refuses to save otherwise.
- **Terminal artifact support.** ChatGPT may finish with a multimodal/image, code, or execution artifact instead of text; `finished_successfully` plus `end_turn: true` is accepted for those non-text assistant nodes, an explicitly ended `reasoning_recap` (`metadata.reasoning_status: reasoning_ended`) is accepted even when `end_turn` is false, and a completed deep-research assistant-code node followed by a finished tool-code node is terminal. In-progress and non-terminal thoughts remain fail-fast.
- **Fail-fast.** Every non-happy path returns a typed error — no retries, speculative warm fetch, snapshot replay, stabilization, or degraded export. A cache-only adapter fails when no fresh eligible response has been observed.
- **Explicit export is the only write path.** Nothing is written to a user JSON file without a click (`Save JSON` or `Export Chats`).
- **Bounded cache-first capture.** Page-owned responses are classified before cloning, clone bodies are read through a hard byte cap, then parsed, terminal-validated, and retained in memory for at most five minutes. The cache defaults to 12 entries, 16 MiB per entry, and 48 MiB total; it is never persisted and contains no captured credentials. Provider cache and pending assembly state are cleared when account identity is established or changes and after `401/403` responses.
- **Request-context capture without credential persistence.** Provider-allowlisted headers and Gemini batchexecute context are held in expiring page-local memory for eligible direct requests. They are never written into the exported JSON, the conversation-response cache, or persistent storage.
- **No compatibility mode.** Reactive lifecycle badges, canonical/Save-vs-Force-Save controls, SFE probes/leases, calibration, Markdown export, snapshot recovery, and the legacy lifecycle wire protocol are all out of scope.

## 2) Source-of-Truth Docs

Read these first:

1. `docs/architecture.md`
2. `docs/debug-logs-guide.md`

## 3) Runtime Architecture

The v3 runtime keeps sensitive export work in the MAIN world, with an isolated UI/runtime that forwards command-only requests.

1. MAIN world interceptor:
   - `entrypoints/interceptor.content.ts`
   - `entrypoints/interceptor/bootstrap.ts`
   - Hooks page `fetch` + `XMLHttpRequest`.
  - Captures provider-allowlisted request-context (platform auth/client headers, Gemini batchexecute context), eligible page-owned terminal conversation responses, and raw stream frames for stream-debug.
  - Performs single export, bulk export, stream-debug export/clear, and explicit downloads from the MAIN world.
  - Cross-world messages are exchanged via `window.postMessage` under a session token, carrying commands and typed summaries only. MAIN handlers must require `event.source === window.self` and `event.origin === window.location.origin`; never accept missing, `null`, or synthetic source/origin values. Same-page scripts can still observe/replay safe commands because this bridge cannot be extension-private; that hostile-page threat is outside v3's model, while credentials and payloads never cross.

2. ISOLATED v3 content runtime:
   - `entrypoints/main.content.ts` (entry point; boots a `V3ContentRuntime` against the browser message host)
   - `features/runtime/v3-content-runtime.ts` (wires browser messages to the MAIN-world command requester)
   - `features/runtime/v3-runtime.ts` (message types, `Export Chats` / stream-debug export + clear options)
   - `features/runtime/main-world-command-contract.ts` (command and safe-summary schemas)
   - `features/runtime/main-world-command-request.ts` (isolated-side command requester)
   - `features/runtime/main-world-command-handler.ts` (MAIN-side privileged dispatcher)

Key modules:

- Single-export kernel: `features/single-export/single-export-service.ts` (+ `endpoint-resolver.ts`, `conversation-response-cache.ts`, `conversation-response-capture.ts`, `types.ts`)
- Export controls: `features/export-controls/*`
- Bulk export: `features/bulk-export/*` (orchestrator, providers, parsers, fetch, downloads, options, progress)
- Stream-debug: `features/stream-debug/*` (recorder, stream-monitor, xhr-monitor, generation-endpoint)
- Message contracts: `features/runtime/v3-runtime.ts`, `features/runtime/main-world-command-contract.ts`, `features/bulk-export/contract.ts`; stream record types live in `features/stream-debug/recorder.ts`
- Session token: `utils/protocol/session-token.ts`

There is no SFE, no probe lease arbitration, and no calibration profile. The background service worker is not part of the export path.

## 4) Platform-Specific Notes

### ChatGPT

- Single-chat detail uses `/backend-api/conversation/{id}` with `/backend-api/f/conversation/{id}` as a fallback candidate.
- Requires captured auth headers. If `authorization` is absent at export time, the call fails fast with `missing_auth`.

### Gemini

- Detail export is a batchexecute `POST` (`/_/BardChatUi/data/batchexecute`) with the captured `at`/`bl`/`f.sid`/`hl`/`_reqid` request context. The context object is required; without `at` the call fails fast with `missing_auth`.
- StreamGenerate endpoint (`/_/BardChatUi/data/assistant.lamda.bardfrontendservice/streamgenerate`) is recognized for stream-debug generation classification.

### Grok

- `grok.com` detail export targets `/rest/app-chat/conversations_v2/{id}` with an adapter-declared fallback candidate.
- X-wide injection supports SPA entry into `/i/grok?conversation={id}`, but controls mount only while that valid conversation route is active. The route uses the canonical `GrokConversationItemsByRestId` GraphQL detail response and supports both cache-first and deterministic direct export.
- Generation endpoints include `/2/grok/add_response.json` and `/rest/app-chat/conversations/new`.

### Cache-First Providers

- Claude caches only canonical organization-scoped conversation detail responses.
- Amazon Nova multiplexes RPCs through `POST /api`; capture is eligible only when the `x-amz-target` header identifies the conversation-detail operation.
- Meta Muse multiplexes GraphQL operations through `POST /api/graphql`; capture classifies the request body and assembles the initial detail plus backward pages in cursor order before terminal caching.
- Qwen caches canonical complete-history detail responses and can issue its deterministic detail `GET` when the cache misses. Its completion SSE endpoint is recognized for stream-debug.
- Z.ai assembles the canonical conversation detail with the message-id batch response; neither half is independently eligible for export.
- DeepSeek caches canonical history responses and can issue its deterministic history `GET` when the cache misses.
- Claude, Amazon Nova, Meta Muse, and Z.ai are cache-only. If no eligible response is fresh, single export fails fast with `missing_endpoint` rather than constructing a speculative request.

## 5) Coding Standards

- TypeScript-first.
- Prefer explicit, testable utility functions.
- Prefer inferred function return types; add explicit return types only when they materially improve clarity/safety.
- Prefer `type` aliases over `interface` in TypeScript unless interface-specific behavior is required.
- Prefer arrow functions over classic `function` declarations for new code.
- Do not add decorative section-divider comments (for example `// ----` blocks); use meaningful names and concise functional comments only when needed.
- Keep platform logic isolated to adapter/parser/classifier modules.
- In tests, use Bun convention `it('should ...')` for test names.

## 6) TDD and Regression Policy

For any bug fix:

1. Add or update regression test(s) first.
2. Implement the minimal fix.
3. Re-run targeted tests.
4. Re-run typecheck.
5. Update `docs/architecture.md` (and `docs/PR.md` when present) when behavior/invariants change.

Minimum commands:

```bash
bun test
bun run compile
```

Common targeted commands:

```bash
bun test features/single-export/single-export-service.test.ts --bail
bun test features/bulk-export/orchestrator.test.ts --bail
bun test features/bulk-export/fetch.test.ts --bail
bun test features/stream-debug/recorder.test.ts --bail
bun test features/stream-debug/stream-monitor.test.ts --bail
bun test features/runtime/v3-content-runtime.test.ts --bail
bun test features/export-controls/export-controls.test.ts --bail
bun run har:analyze --input <file.har> --host chatgpt.com
```

Test isolation rules (avoid cross-module pollution):

- Prefer scoped mocking or dependency injection patterns over broad top-level `mock.module(...)` for shared modules.
- Always restore per-test monkey patches to globals/prototypes/DOM methods in `afterEach`.
- Prefer a fresh `Window`/`document` per test; reset `globalThis.window`/`globalThis.document` in teardown.
## 7) Logging and Diagnostics

Debug artifacts:

- Stream-debug record(s) — raw ordered stream frames with byte accounting, exported on explicit request.
- HAR analysis JSON/MD (`bun run har:analyze --input <file.har> ...`).

Guidance:

- Keep stream-debug records bounded, sanitized, and high-signal.
- Keep parser diagnostics silent by default; use tests and HAR artifacts for investigation.
- For endpoint drift, run HAR analysis first, then patch the relevant classifier/parser with tests.

Related docs:

- `docs/debug-logs-guide.md`

## 8) Safe Change Patterns

When changing single-chat export behavior:

1. Keep the kernel fail-fast: one explicit action, typed errors, cache first, deterministic adapter-declared candidate fallback only after `404`, and no fallback-on-timeout or retry/backoff.
2. Preserve the ready-terminal validation gates: response `conversation_id` must match the URL id, and both `evaluateReadiness.ready` and `evaluateReadiness.terminal` must be true before download.
3. Preserve the complete ChatGPT `mapping` tree verbatim. For providers without that native shape, retain the complete canonical provider response in `raw_payload` while building a loss-aware normalized mapping; never export a partial graph as complete.
4. Clone only narrowly classified page-owned detail responses. Keep the conversation cache at five minutes with entry/per-entry/aggregate byte bounds; never persist it or place payloads in cross-world messages.
5. For multiplexed transports, classify with request context: Meta by parsed GraphQL request body, Nova by exact target header, and Z.ai by the paired detail/batch identities. Never classify those providers by URL and method alone.
6. Do not persist or cross-world-transfer request-context (provider headers, Gemini batchexecute context) — resolve it in the MAIN-world explicit-action handler, use expiring defensive snapshots, clear stale identity-bound values, and invalidate the provider snapshot after a 401/403 response.

When changing stream-debug capture:

1. Preserve ordered frames and byte accounting (original vs stored, dropped counts).
2. Keep the recorder bounded (max streams, max frames/bytes per stream, TTL) and in-memory only.
3. Sanitize request URLs to paths (strip query strings and hashes) before storing.
4. Keep export and clear explicit through the token-validated MAIN-world command handler; require exact same-window/same-origin events, return only counts/status, and never transfer frame text. Treat same-page replay of safe commands as the documented, out-of-model MAIN-world limitation.

When changing title handling:

1. Prefer stream/API title events.
2. Export-time filename uses `adapter.formatFilename` with a unique-filename guard for bulk export.

## 9) Files Most Likely to Need Careful Review

- `features/runtime/v3-content-runtime.ts`
- `features/runtime/v3-runtime.ts`
- `features/single-export/single-export-service.ts`
- `features/single-export/endpoint-resolver.ts`
- `features/single-export/conversation-response-cache.ts`
- `features/single-export/conversation-response-capture.ts`
- `features/bulk-export/orchestrator.ts`
- `features/stream-debug/recorder.ts`
- `features/runtime/main-world-command-handler.ts`
- `entrypoints/interceptor/bootstrap.ts`
- `platforms/meta/response-assembler.ts`

## 10) Documentation Hygiene

After meaningful behavior changes:

- Update `docs/architecture.md` if the flow changed.

Keep these docs synchronized:

- `README.md`
- `AGENTS.md`
- `docs/architecture.md`
- `docs/debug-logs-guide.md`

## 11) Release Smoke Checklist

Before shipping:

1. Cache-first single export: an eligible page-owned terminal detail response is reused without another request; expired, oversized, mismatched, incomplete, or non-terminal entries are rejected. The cache remains bounded to 12 entries, 16 MiB per entry, 48 MiB total, and five minutes.
2. ChatGPT and Gemini: cache hits save immediately; cache misses use their deterministic detail requests. ChatGPT still requires auth headers and advances to its declared fallback only after `404`; Gemini still requires batchexecute context.
3. Grok: `grok.com` and valid `x.com/i/grok?conversation={id}` routes show `Save JSON`, while unrelated X routes do not. Both parse their canonical detail shape and use deterministic direct detail fallback when needed.
4. Cache-first providers: Claude, Amazon Nova, Meta Muse, Qwen, Z.ai, and DeepSeek save only identity-matched ready-terminal archives. Meta closes cursor pagination in order, Nova requires the exact target header, and Z.ai requires consistent detail-plus-batch assembly. Cache-only providers fail fast when no eligible response is present.
5. Bulk export: only ChatGPT, Gemini, and `grok.com` enumerate conversation lists; pacing/timeout, `Max chats` (`0 = all`), id/readiness validation, bounded `429` retry, and one-file-per-conversation behavior remain intact.
6. Stream-debug: frames are captured in order, bounded, sanitized, and explicitly exportable/clearable without credential leakage. Qwen completion SSE is classified; unsupported new-provider generation endpoints are not guessed.

## 12) PR Review Triage Rules

When processing external PR review comments:

1. Verify each finding against current code before changing anything.
2. Accept findings that materially improve correctness, regression safety, or diagnosability with low-to-moderate risk.
3. Reject or defer findings when they are overengineering for current scope, high-churn with little ROI, out of scope for the release slice, unrealistic edge cases without evidence, or pure style changes with no reliability benefit.
4. For accepted findings: implement test-first, then a minimal fix, then rerun targeted tests + `bun run compile`.
5. For rejected/deferred findings in review docs: add a concise rationale directly under the point and sign with the reviewing agent's name.
