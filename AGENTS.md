# AGENTS.md

Operational guide for AI/code agents working in this repository.

## 1) Project Snapshot

Blackiya is a Chrome MV3 extension that exports conversation data from ChatGPT, Gemini, and Grok as verbatim terminal JSON files, and provides a bounded, on-demand transport-level trace.

The v3 runtime has three user-facing surfaces:

1. **Single-chat ready-terminal export** — an explicit `Save JSON` control on the active conversation. It resolves deterministic adapter-declared detail candidates, validates the server response is ready and terminal, and injects a JSON download. It is fail-fast.
2. **Bulk `Export Chats`** — a popup-driven export of a conversation list from the active platform tab. It discovers conversation IDs from the platform list endpoint, fetches each detail payload, and downloads one JSON file per conversation.
3. **Stream-debug capture** — raw ordered stream frames (SSE, NDJSON/line, or raw) are recorded in memory, bounded, and exported or cleared only on explicit request.

Hard-cut invariants (the v3 model):

- **Explicit, ready-terminal-only export.** The single-chat kernel resolves deterministic detail candidates, advances only after an eligible `404`, validates the server response is ready and terminal, and refuses to save otherwise.
- **Terminal artifact support.** ChatGPT may finish with a multimodal/image, code, or execution artifact instead of text; `finished_successfully` plus `end_turn: true` is accepted for those non-text assistant nodes, while in-progress and non-terminal thoughts remain fail-fast.
- **Fail-fast.** Every non-happy path returns a typed error — no retries, no warm fetch, no snapshot replay, no stabilization, no degraded export.
- **Explicit export is the only write path.** Nothing is written to a user JSON file without a click (`Save JSON` or `Export Chats`).
- **Request-context capture without credential persistence.** Platform auth headers and Gemini batchexecute context are resolved at export time, live only for a single in-memory request, and are never written into the exported JSON or persisted across sessions.
- **No compatibility mode.** Reactive lifecycle badges, canonical/Save-vs-Force-Save controls, SFE probes/leases, calibration, Markdown export, snapshot recovery, and the legacy lifecycle wire protocol are all out of scope.

## 2) Source-of-Truth Docs

Read these first:

1. `docs/architecture.md`
2. `docs/debug-logs-guide.md`

## 3) Runtime Architecture

The v3 runtime is single-world for export, with a thin MAIN-world interceptor for request-context and stream capture.

1. MAIN world interceptor:
   - `entrypoints/interceptor.content.ts`
   - `entrypoints/interceptor/bootstrap.ts`
   - Hooks page `fetch` + `XMLHttpRequest`.
  - Captures provider-allowlisted request-context (platform auth headers, Gemini batchexecute context) and raw stream frames for stream-debug.
   - Cross-world messages are exchanged via `window.postMessage` under a session token.

2. ISOLATED v3 content runtime:
   - `entrypoints/main.content.ts` (entry point; boots a `V3ContentRuntime` against the browser message host)
   - `features/runtime/v3-content-runtime.ts` (wires bulk export + stream-debug bridge into the runtime host)
   - `features/runtime/v3-runtime.ts` (message types, `Export Chats` / stream-debug export + clear options)
   - `features/runtime/v3-stream-debug-bridge.ts` (request/response bridge for stream-debug export + clear)
   - `features/runtime/*-request.ts` (request-context bridges used by the explicit export paths)

Key modules:

- Single-export kernel: `features/single-export/single-export-service.ts` (+ `endpoint-resolver.ts`, `types.ts`)
- Export controls: `features/export-controls/*`
- Bulk export: `features/bulk-export/*` (orchestrator, providers, parsers, fetch, downloads, options, progress)
- Stream-debug: `features/stream-debug/*` (recorder, stream-monitor, xhr-monitor, generation-endpoint, bridge, contract)
- Message contracts: `features/runtime/v3-runtime.ts`, `features/bulk-export/contract.ts`, `features/stream-debug/contract.ts`
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

- Detail export targets `https://grok.com/rest/app-chat/conversations_v2/{id}` with query variants.
- Generation endpoints include `/2/grok/add_response.json` and `/rest/app-chat/conversations/new`.

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
bun run test:e2e
bun run test:e2e -- e2e/harness.playwright.ts
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

1. Keep the kernel fail-fast: one explicit action, typed errors, deterministic adapter-declared candidate fallback only after `404`, and no fallback-on-timeout or retry/backoff.
2. Preserve the ready-terminal validation gates: response `conversation_id` must match the URL id, and both `evaluateReadiness.ready` and `evaluateReadiness.terminal` must be true before download.
3. Keep the complete `mapping` tree verbatim; never synthesize or degrade it.
4. Do not persist request-context (auth headers, Gemini batchexecute context) — resolve it for the explicit action, use expiring defensive snapshots, clear stale identity-bound values, and invalidate the provider snapshot after a 401/403 response.

When changing stream-debug capture:

1. Preserve ordered frames and byte accounting (original vs stored, dropped counts).
2. Keep the recorder bounded (max streams, max frames/bytes per stream, TTL) and in-memory only.
3. Sanitize request URLs to paths (strip query strings and hashes) before storing.
4. Keep export and clear explicit through the token-validated postMessage bridge.

When changing title handling:

1. Prefer stream/API title events.
2. Export-time filename uses `adapter.formatFilename` with a unique-filename guard for bulk export.

## 9) Files Most Likely to Need Careful Review

- `features/runtime/v3-content-runtime.ts`
- `features/runtime/v3-runtime.ts`
- `features/single-export/single-export-service.ts`
- `features/single-export/endpoint-resolver.ts`
- `features/bulk-export/orchestrator.ts`
- `features/stream-debug/recorder.ts`
- `features/stream-debug/bridge.ts`

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

1. ChatGPT: `Save JSON` performs one explicit detail export, requires auth headers, advances to the declared fallback only after `404`, and downloads a terminal JSON archive. A missing `authorization` fails fast with a typed error.
2. Gemini: single-chat export builds a valid batchexecute `POST` and correctly fails with `missing_auth` when the context is absent.
3. Grok: detail fetch resolves through the candidate URL list; generation endpoints are classified correctly for stream-debug.
4. Bulk export: `Export Chats` enumerates the conversation list, applies pacing/timeout, respects `Max chats` (`0 = all`), validates requested ids and ready-terminal payloads, retries `429` within the deadline a bounded number of times, and writes one JSON per conversation.
5. Stream-debug: frames are captured in order, bounded, sanitized, and explicitly exportable/clearable without credential leakage.

## 12) PR Review Triage Rules

When processing external PR review comments:

1. Verify each finding against current code before changing anything.
2. Accept findings that materially improve correctness, regression safety, or diagnosability with low-to-moderate risk.
3. Reject or defer findings when they are overengineering for current scope, high-churn with little ROI, out of scope for the release slice, unrealistic edge cases without evidence, or pure style changes with no reliability benefit.
4. For accepted findings: implement test-first, then a minimal fix, then rerun targeted tests + `bun run compile`.
5. For rejected/deferred findings in review docs: add a concise rationale directly under the point and sign with the reviewing agent's name.
