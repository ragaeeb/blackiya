# AGENTS.md

Operational guide for AI/code agents working in this repository.

## 1) Project Snapshot

Blackiya is a Chrome MV3 extension that captures conversation data from:
- ChatGPT
- Gemini
- Grok (grok.com + x.com Grok surface)

Core goals:
1. Detect response lifecycle (`idle -> prompt-sent -> streaming -> completed`)
2. Capture canonical conversation JSON
3. Gate export readiness correctly (`Save JSON` vs `Force Save`)
4. Provide high-signal diagnostics (debug report + optional stream dump)

## 2) Source of Truth Docs

Read these first:
1. `docs/architecture.md`
2. `docs/debug-logs-guide.md`
3. `docs/discovery-mode.md`

## 3) Runtime Architecture

Two-world design:

1. MAIN world interceptor:
- `entrypoints/interceptor.content.ts`
- Core implementation: `entrypoints/interceptor/bootstrap.ts`
- Hooks `fetch` + `XMLHttpRequest`
- Emits protocol events via `window.postMessage`

2. ISOLATED world runner:
- `entrypoints/main.content.ts`
- `utils/platform-runner.ts` (compat re-export)
- Core implementation: `utils/runner/index.ts`
- Handles lifecycle state, SFE readiness, UI gating, export

Supporting modules:
- Adapter interface: `platforms/types.ts`
- Adapter factory: `platforms/factory.ts`
- SFE: `utils/sfe/*`
- Lease arbitration: `utils/sfe/probe-lease-*`, `entrypoints/background.ts`
- Interception cache: `utils/managers/interception-manager.ts`
- UI buttons: `utils/ui/button-manager.ts`
- Protocol types: `utils/protocol/messages.ts`
- Protocol contract: lifecycle/finished/delta messages require `attemptId` (legacy attempt-less messages removed)

## 4) Platform-Specific Notes

### ChatGPT
- SSE-heavy; strongest lifecycle signals.
- Reference behavior for readiness and streaming transitions.

### Gemini
- StreamGenerate + batchexecute/RPC parsing.
- Uses `utils/gemini-stream-parser.ts` and request classifier.

### Grok
- NDJSON/REST across multiple endpoint forms.
- Uses:
  - `utils/grok-stream-parser.ts`
  - `utils/grok-request-classifier.ts`
- Endpoint classification is critical to avoid premature completion or lifecycle regressions.

## 5) Coding Standards

- TypeScript-first.
- Prefer explicit, testable utility functions.
- Prefer inferred function return types; add explicit return types only when they materially improve clarity/safety.
- Prefer `type` aliases over `interface` in TypeScript unless interface-specific behavior is required.
- Prefer arrow functions over classic `function` declarations for new code.
- Keep platform logic isolated to adapter/parser/classifier modules.
- Avoid broad DOM heuristics as lifecycle source of truth for non-ChatGPT platforms.
- No silent behavior changes without tests.
- In tests, use Bun convention `it('should ...')` for test names.

## 6) TDD and Regression Policy

For any bug fix:
1. Add or update regression test(s) first.
2. Implement minimal fix.
3. Re-run targeted tests.
4. Re-run typecheck.
5. Update `docs/handoff.md` status and `docs/architecture.md` when behavior/invariants change.

Minimum commands:
```bash
bun test
bun run tsc --noEmit
```

Common targeted commands:
```bash
bun test platforms/grok.test.ts --bail
bun test platforms/gemini.test.ts --bail
bun test platforms/chatgpt.test.ts --bail
bun test utils/platform-runner.test.ts
```

## 7) Logging and Diagnostics

Debug artifacts:
- Debug report TXT (token-lean summary)
- Full logs JSON
- Stream dump JSON (optional, bounded)

Guidance:
- Prefer high-signal logs.
- Add dedupe/TTL for frequently emitted lines.
- Keep noisy exploratory logging behind explicit diagnostic modes.

## 8) Safe Change Patterns

When changing lifecycle/completion logic:
1. Update endpoint classifier first (if needed).
2. Ensure completion hints are readiness-gated where required.
3. Validate that late/background signals cannot regress state (`Completed -> Streaming`).
4. Verify multi-tab behavior with attempt binding/supersession.
5. Keep probe lease arbitration always-on and owner-safe (no setting gate).

When changing title handling:
1. Prefer stream/API title events.
2. Use adapter DOM fallback only when title is generic.
3. Keep export-time title decision logs for debugging.

## 9) Files Most Likely to Need Careful Review

- `entrypoints/interceptor/bootstrap.ts`
- `utils/runner/index.ts`
- `platforms/gemini.ts`
- `platforms/grok.ts`

## 10) Documentation Hygiene

After meaningful behavior changes:
- Update `docs/architecture.md` if flow changed

Keep these docs synchronized:
- `README.md`
- `AGENTS.md`
- `docs/architecture.md`

## 11) Release Smoke Checklist

Before shipping:
1. ChatGPT: verify streaming updates are live, completion transitions to `completed`, and Save only enables at `canonical_ready`.
2. Gemini: verify StreamGenerate lifecycle stability and correct title export without requiring refresh.
3. Grok: verify long-thinking sessions do not regress `Completed -> Streaming` and Save stays readiness-gated.
4. Export metadata: verify canonical vs degraded exports set `captureSource`, `fidelity`, and `completeness` correctly.

## 12) PR Review Triage Rules

When processing external PR review comments:
1. Verify each finding against current code before changing anything.
2. Accept findings that materially improve correctness, regression safety, or diagnosability with low-to-moderate risk.
3. Reject or defer findings when they are:
   - Overengineering for current scope
   - High-churn with little ROI
   - Out of scope for the release slice
   - Unrealistic edge cases without evidence
   - Pure style changes with no reliability benefit
4. For accepted findings: implement test-first, then minimal fix, then rerun targeted tests + `bun run tsc --noEmit`.
5. For rejected/deferred findings in review docs: add a concise rationale directly under the point and sign with the reviewing agent's name.
