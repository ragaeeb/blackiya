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
1. `/Users/rhaq/workspace/blackiya/docs/architecture.md`
2. `/Users/rhaq/workspace/blackiya/docs/handoff.md`
3. `/Users/rhaq/workspace/blackiya/docs/post-v2.1-regressions.md`
4. `/Users/rhaq/workspace/blackiya/docs/debug-logs-guide.md`
5. `/Users/rhaq/workspace/blackiya/docs/discovery-mode.md`

## 3) Runtime Architecture

Two-world design:

1. MAIN world interceptor:
- `/Users/rhaq/workspace/blackiya/entrypoints/interceptor.content.ts`
- Hooks `fetch` + `XMLHttpRequest`
- Emits protocol events via `window.postMessage`

2. ISOLATED world runner:
- `/Users/rhaq/workspace/blackiya/entrypoints/main.content.ts`
- `/Users/rhaq/workspace/blackiya/utils/platform-runner.ts`
- Handles lifecycle state, SFE readiness, UI gating, export

Supporting modules:
- Adapter interface: `/Users/rhaq/workspace/blackiya/platforms/types.ts`
- Adapter factory: `/Users/rhaq/workspace/blackiya/platforms/factory.ts`
- SFE: `/Users/rhaq/workspace/blackiya/utils/sfe/*`
- Interception cache: `/Users/rhaq/workspace/blackiya/utils/managers/interception-manager.ts`
- UI buttons: `/Users/rhaq/workspace/blackiya/utils/ui/button-manager.ts`
- Protocol types: `/Users/rhaq/workspace/blackiya/utils/protocol/messages.ts`

## 4) Platform-Specific Notes

### ChatGPT
- SSE-heavy; strongest lifecycle signals.
- Reference behavior for readiness and streaming transitions.

### Gemini
- StreamGenerate + batchexecute/RPC parsing.
- Uses `/Users/rhaq/workspace/blackiya/utils/gemini-stream-parser.ts` and request classifier.

### Grok
- NDJSON/REST across multiple endpoint forms.
- Uses:
  - `/Users/rhaq/workspace/blackiya/utils/grok-stream-parser.ts`
  - `/Users/rhaq/workspace/blackiya/utils/grok-request-classifier.ts`
- Endpoint classification is critical to avoid premature completion or lifecycle regressions.

## 5) Coding Standards

- TypeScript-first.
- Prefer explicit, testable utility functions.
- Keep platform logic isolated to adapter/parser/classifier modules.
- Avoid broad DOM heuristics as lifecycle source of truth for non-ChatGPT platforms.
- No silent behavior changes without tests.

## 6) TDD and Regression Policy

For any bug fix:
1. Add or update regression test(s) first.
2. Implement minimal fix.
3. Re-run targeted tests.
4. Re-run typecheck.
5. Update regression log doc.

Minimum commands:
```bash
bun test
bun run tsc --noEmit
```

Common targeted commands:
```bash
bun test /Users/rhaq/workspace/blackiya/platforms/grok.test.ts --bail
bun test /Users/rhaq/workspace/blackiya/platforms/gemini.test.ts --bail
bun test /Users/rhaq/workspace/blackiya/platforms/chatgpt.test.ts --bail
bun test /Users/rhaq/workspace/blackiya/utils/platform-runner.test.ts
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

When changing title handling:
1. Prefer stream/API title events.
2. Use adapter DOM fallback only when title is generic.
3. Keep export-time title decision logs for debugging.

## 9) Files Most Likely to Need Careful Review

- `/Users/rhaq/workspace/blackiya/entrypoints/interceptor.content.ts`
- `/Users/rhaq/workspace/blackiya/utils/platform-runner.ts`
- `/Users/rhaq/workspace/blackiya/platforms/gemini.ts`
- `/Users/rhaq/workspace/blackiya/platforms/grok.ts`

## 10) Documentation Hygiene

After meaningful behavior changes:
- Update `/Users/rhaq/workspace/blackiya/docs/post-v2.1-regressions.md`
- Update `/Users/rhaq/workspace/blackiya/docs/handoff.md`
- Update `/Users/rhaq/workspace/blackiya/docs/architecture.md` if flow changed

Keep these four docs synchronized:
- `README.md`
- `AGENTS.md`
- `docs/architecture.md`
- `docs/handoff.md`
