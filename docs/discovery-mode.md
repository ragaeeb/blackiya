# Discovery Mode

## Purpose
Discovery mode is a maintainer diagnostic path used when platform APIs drift and adapters need updating.

It helps answer:
- Which new endpoints now carry conversation content?
- Which endpoints are only lifecycle/completion hints?
- Which payload shapes changed and broke parsing?

## How It Fits Current Architecture
Blackiya now uses layered readiness with SFE:

1. Network stream lifecycle hints
2. Completion endpoint hints
3. DOM transition hints
4. Deferred canonical fetch retries
5. Snapshot/replay fallback

Discovery mode primarily supports layers 1, 2, and 4 by surfacing endpoint/path changes quickly.
It can also help explain why a run ends in `degraded_manual_only` instead of `canonical_ready`.

## What Discovery Captures
On discovery-enabled hosts, interceptor records compact request/response metadata:
- path
- relevant query fragments
- method/status/content-type
- payload size hints
- bounded previews for large responses

Static assets are filtered out.

Current host scope:
1. Enabled capture path is currently wired for Gemini and Grok hosts:
   - `gemini.google.com`
   - `grok.com`
   - `x.com` (Grok surface)
2. ChatGPT is not part of this discovery-host filter today.

If stream dump is enabled, discovery is complemented with frame/chunk-level capture for stream forensics.

## When To Use
Use discovery mode if:
1. Save never enables after clear completion.
2. Lifecycle badge reaches completed but no canonical capture appears.
3. Calibration or auto-capture regresses after platform UI/API changes.
4. Adapter `apiEndpointPattern` / parser assumptions appear stale.
5. You see repeated `stream-done: ...` fallback states without canonical capture.
6. A platform finishes in background tabs but foreground tabs behave differently.

## Workflow
1. Enable discovery diagnostics.
   - In DevTools console on a target host, run:
   - `localStorage.setItem('blackiya.discovery', '1')`
   - Reload tab after toggling.
2. Reproduce once with minimal noise (single tab first).
3. Export debug report TXT.
4. If unclear, export full logs JSON.
5. If stream timing/parsing is unclear, enable stream dump and export JSON.
6. Identify changed endpoints, payload shapes, and lifecycle ordering.
7. Update adapter parsing/patterns and tests.
8. Re-run single-tab, then multi-tab stress.

## HAR Triage Workflow (Automatable)
Use this when you already have a DevTools `.har` export and want a repeatable, agent-friendly summary.

1. Export HAR from DevTools after a clean repro window.
2. Run the analyzer:
   - `bun run har:analyze --input logs/grok.com.har --host grok.com --host x.com --host grok.x.com --hint "Agents thinking" --hint "I have the full text broken into segments P101391 to P101395a."`
3. Review generated files:
   - `logs/har-analysis/grok.com.analysis.json`
   - `logs/har-analysis/grok.com.analysis.md`
4. Use JSON as machine-readable input for agent workflows:
   - endpoint inventory (`endpointSummary`)
   - likely stream endpoints (`likelyStreamingEndpoints`)
   - timeline (`timeline`)
   - hint hits with snippets (`hintMatches`)
5. Use Markdown for quick human triage and PR notes.

Notes:
- The analyzer redacts sensitive URL/header fields (`token`, `authorization`, `cookie`, etc.).
- The analyzer decodes base64 HAR response bodies before hint matching.
- `--hint` is repeatable; pass exact strings you suspect appear in reasoning or stream payloads.
- `--host` is repeatable; useful for mixed captures (e.g., `grok.com` + `x.com` + `grok.x.com`).
- Override output paths with `--output` and `--report` as needed.

To disable:
- `localStorage.removeItem('blackiya.discovery')` (or set to `0`) and reload.

## Platform Notes
- ChatGPT: stream lifecycle is usually visible early; canonical capture may still lag.
- Gemini: often relies on RPC envelopes and can complete with delayed canonical fetch.
- Grok: mixed endpoint families and NDJSON/JSON variants require careful endpoint classification.

Do not treat any single completion hint as canonical-ready.

## Guardrails
- Keep discovery capture opt-in and bounded.
- Redact sensitive headers/cookies by default.
- Prefer deterministic parser updates plus fixture tests over ad-hoc heuristics.
- Keep runtime behavior stable: discovery should add observability, not change readiness semantics.
