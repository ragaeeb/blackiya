# Debug Logs Guide

## Purpose

Use the smallest artifact that still explains the failure. In the v3 runtime there is no reactive lifecycle state; readiness is evaluated only during an explicit save, so diagnostics reduce to:

1. **Stream-debug records** — raw ordered stream frames for transport/parse triage.
2. **Fail-fast export errors** — typed, metadata-only error results from the single-chat kernel.
3. **HAR analysis** — redacted endpoint/timeline summaries for platform drift.

### MAIN-world bridge note

The command bridge accepts only events from the exact page window and exact page origin; absent, `null`, synthetic, and cross-origin source/origin values are rejected. Same-page scripts can nevertheless observe and replay the token-stamped safe commands because `window.postMessage` in MAIN cannot be extension-private. This hostile-page scenario is outside v3's threat model, and the bridge never carries credentials, conversation payloads, stream records, or frame text.

## Artifacts at a Glance

| Artifact | When to export | Contents |
| :--- | :--- | :--- |
| Stream-debug record(s) | Endpoint drift, framing/parse problems, malformed or truncated stream payloads | Ordered frames with byte accounting |
| HAR analysis (JSON/MD) | Changed endpoints or unclear payload paths | Redacted endpoint/timeline summary from a `.har` |

## Stream-Debug Records

Stream-debug capture is bounded, in-memory, and exported **explicitly** (it is not written into conversation JSON). The MAIN-world handler serializes and downloads the trace locally; the isolated UI receives only a stream/frame count and filename. Generation endpoints are recognized per platform:

- ChatGPT: `POST /backend-api/f/conversation`
- Gemini: `POST /_/BardChatUi/data/assistant.lamda.bardfrontendservice/streamgenerate`
- Grok: `POST /2/grok/add_response.json`, `POST /rest/app-chat/conversations/new`

Each record captures:

- identity: `streamId`, `platform`, `endpoint`, `method`, sanitized `path`
- timing: `startedAt`, `lastActivityAt`, optional `endedAt`
- ordered `frames` with `sequence`, `frameId`, `kind`, optional event metadata (`done`/`refusal`/`replacement`/`erase`/`close`/`abort`/`error`), text, timestamps, byte accounting, and `truncated`
- termination: `termination` (`close`/`abort`/`error`) with timestamp
- accounting: raw byte/frame totals, retained byte totals, dropped byte/frame totals, and `truncated`

Framing is `sse`, `line` (NDJSON), or `raw`. A `[DONE]` marker in an SSE stream is emitted as a `done` event frame.

### Reading truncation

The recorder is capped (max concurrent streams, max frames per stream, max bytes per stream, TTL). When a stream hits a cap:

- byte overflow is clamped and counted in the dropped/truncated byte and frame counters;
- ordinary frames are evicted before transport and terminal/refusal/replacement/erase frames when a count or byte cap is hit;
- the record `truncated` flag is set.

This priority-aware eviction preserves late refusal, replacement, and erase signals when a platform streams a large body. The monitor also bounds incomplete framing buffers, so it does not retain an unbounded response body outside the recorder.

A `truncated` stream does **not** mean the export failed — it means the debug trace was bounded. Treat a truncated trace as expected only when the source stream genuinely exceeds the bounded budget.

### When to use

Use a stream-debug record when:

1. The platform changed endpoints or payload framing (no frames captured, or a generation request is absent).
2. A payload is malformed or does not parse on the expected platform path.
3. A stream terminates unexpectedly (`abort`/`error`) and you need the raw ordered trace to see where it stopped.

## Metadata-Only Errors (Fail-Fast)

The single-chat kernel returns a typed, fail-fast result and never writes a partial export. Each error variant is metadata-only — it carries enough context to triage without exposing body contents or credentials.

| Error (`kind`) | Meaning | Next step |
| :--- | :--- | :--- |
| `unsupported_platform` | Adapter does not match the active page origin | Confirm you are on a supported host |
| `missing_conversation_id` | No conversation id in the page URL | Open a real conversation URL |
| `missing_endpoint` | Adapter has no detail URL for the platform | Adapter/path drift — verify against HAR |
| `missing_auth` | No auth header / Gemini `at` context captured (or HTTP `401/403`; the stale provider snapshot is cleared and the active bulk run stops) | Trigger one normal platform request, then retry |
| `http_failure` | Unexpected HTTP status (non-2xx, non-auth) | Inspect status + endpoint via HAR |
| `download_failure` | The validated payload could not be handed to the browser download path | Retry the explicit save and inspect browser download permissions |
| `timeout` | Request exceeded the hard timeout | Confirm the conversation is terminal, then retry explicitly; flag latency if persistent |
| `parse_failure` | Empty body, parser returned null, or parser threw | Check payload shape via stream-debug/HAR |
| `id_mismatch` | Response `conversation_id` differs from the URL id | Stale/redirected id — reopen and retry |
| `not_terminal` | `evaluateReadiness.ready` or `.terminal` was false | Response was not ready/terminal — retry when complete; an explicitly ended ChatGPT `reasoning_recap` or completed deep-research tool branch is accepted even when no final text assistant exists |

There is no `degraded_manual_only` or partial/downgraded export path in v3. If `Save JSON` fails, the error variant tells you exactly which gate rejected it.

## HAR Analysis

When endpoint families changed or stream payload paths are unclear:

```bash
bun run har:analyze --input logs/grok.com.har --host grok.com --hint "Agents thinking"
```

The analyzer writes redacted endpoint/timeline summaries plus hint matches for faster parser/classifier updates.

## Recommended Bug Report Bundle

1. Platform + exact URL(s) and extension version.
2. Repro steps and timing.
3. The fail-fast error result shown by `Save JSON` (if export failed).
4. The redacted HAR analysis if the issue involves endpoint or payload drift.
5. A stream-debug export if the issue is framing/parse/transport related.
6. Screenshot of the final UI state.
