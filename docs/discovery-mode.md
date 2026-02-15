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

## What Discovery Captures
On discovery-enabled hosts, interceptor records compact request/response metadata:
- path
- relevant query fragments
- method/status/content-type
- payload size hints
- bounded previews for large responses

Static assets are filtered out.

## When To Use
Use discovery mode if:
1. Save never enables after clear completion.
2. Lifecycle badge reaches completed but no canonical capture appears.
3. Calibration or auto-capture regresses after platform UI/API changes.
4. Adapter `apiEndpointPattern` / parser assumptions appear stale.

## Workflow
1. Enable discovery diagnostics.
2. Reproduce once with minimal noise (single tab first).
3. Export debug report + full logs.
4. Identify changed endpoints and payload shapes.
5. Update adapter parsing/patterns and tests.
6. Re-run single-tab test, then multi-tab stress.

## Guardrails
- Keep discovery capture opt-in and bounded.
- Redact sensitive headers/cookies by default.
- Prefer deterministic parser updates plus fixture tests over ad-hoc heuristics.

