# Debug Logs Guide

## Purpose
Use the smallest log artifact that still explains the failure. Default to token-lean debug reports, escalate to full logs/stream dumps only when needed.

## Readiness Model (Current)
Save/Copy are controlled by SFE readiness, not by a single lifecycle event:

1. Lifecycle hint observed: `prompt-sent` / `streaming` / `completed`.
2. Canonical capture ingested and parseable.
3. Readiness gate confirms terminal + stabilized payload.
4. Final state:
- `canonical_ready`: Save enabled.
- `degraded_manual_only`: Force Save enabled (manual confirm required).

Important:
- `completed` means stream hint ended.
- `canonical_ready` means export is safe/complete.
- `degraded_manual_only` means canonical capture timed out; export may be partial.

## High-Signal Events (Debug TXT)
These should usually be enough for first-pass triage:

- Capture/readiness:
- `Successfully captured/cached data for conversation: ...`
- `Capture reached ready state ... eventCode:"captured_ready"`
- `readiness_timeout_manual_only`
- `force_save_degraded_export`
- `snapshot_degraded_mode_used`

- Lifecycle/stream:
- `Lifecycle phase ...`
- `Response finished signal ...`
- `Stream done probe start`
- `Stream done probe success`
- `Stream done probe has no URL candidates`
- Toast states like:
  - `stream-done: canonical capture ready`
  - `stream-done: degraded snapshot captured`
  - `stream-done: awaiting canonical capture`
  - `stream-done: no api url candidates`

- Race/disposal hygiene:
- `attempt_alias_forwarded`
- `late_signal_dropped_after_dispose`

- UI state:
- `Button state ...`
- `Button target missing; retry pending`

## Expected Noise
These are often benign:

- parse misses on non-canonical/aux endpoints
- endpoint candidate filtering by origin
- bounded retry/backoff logs

## Which Artifact To Export
1. Debug report (TXT):
- First choice for most bugs.
- Fastest to review, best signal-to-noise.

2. Full logs (JSON):
- Use for race/order issues, especially multi-tab.
- Use when debug TXT appears incomplete for background-tab behavior.

3. Stream dump (JSON):
- Use for stream parsing/lifecycle bugs.
- Enable before repro.
- Bounded/redacted by default.

## Multi-Tab Note
In multi-tab runs, one debug TXT may not represent all tabs equally. For cross-tab bugs, include:

1. One debug TXT from a failing tab.
2. One full logs JSON from the overall run.
3. Stream dump JSON if streaming signals are suspect.

## Recommended Bug Report Bundle
1. Platform + exact URL(s).
2. Repro steps and timing (foreground/background tab, number of tabs).
3. Debug report TXT.
4. Full logs JSON (required for multi-tab/race bugs).
5. Stream dump JSON (required for stream/timing bugs).
6. Screenshot of final UI (status, Save/Force Save, Calibrate, toast).
