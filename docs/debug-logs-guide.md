# Debug Logs Guide

## Purpose
Debug export stays token-lean while preserving high-signal events needed to diagnose capture/readiness failures across ChatGPT, Gemini, and Grok.

## Current Signal Model (V2/SFE)
Readiness is not based on a single event. We combine lifecycle hints plus canonical capture readiness:

1. Lifecycle hints: `prompt-sent`, `streaming`, `completed`.
2. Canonical capture: intercepted and parseable conversation payload.
3. Readiness gate: canonical terminal + stabilization window.
4. Final state: `captured_ready`.

`completed` means stream/lifecycle completion hint was observed.  
`captured_ready` means Save/Copy is safe to enable.

## High-Signal Lines To Keep
- Capture success:
  - `Successfully captured/cached data for conversation: ...`
  - `Capture reached ready state ... eventCode:"captured_ready"`
- Lifecycle:
  - `Lifecycle phase ...`
  - `Response finished signal ...`
- SFE:
  - `SFE completed hint received`
  - `Awaiting canonical stabilization before ready`
  - `Legacy/SFE readiness mismatch` (shadow diagnostics)
- Calibration:
  - `Calibration strategy`
  - `Calibration passive wait ...`
  - `Calibration fetch response`
  - `Calibration snapshot fallback ...`
- Probe/diagnostic:
  - `Stream done probe start`
  - `Stream done probe success`
  - `Stream done probe has no URL candidates`
- UI:
  - `Button state ...`
  - `Button target missing; retry pending`

## Expected Noise (Lower Severity)
These are often expected, not immediate bugs:
- parse misses on auxiliary endpoints
- endpoint candidates filtered by origin
- transient retries/backoff logs

## When To Export Which Artifact
1. Debug report (TXT): default; fastest and usually sufficient.
2. Full logs (JSON): use when ordering/race detail is needed.
3. Stream dump (JSON): use for streaming-frame forensics (opt-in, bounded, redacted).

## Recommended Bug Report Bundle
1. Exact URL and platform.
2. Repro steps with timing notes.
3. Debug report TXT.
4. Full logs JSON (if race/ordering issue).
5. Stream dump JSON (if stream parsing/lifecycle issue).
6. Screenshot of badge/toast/button state at failure.

