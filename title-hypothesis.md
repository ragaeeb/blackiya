# Title Sync Bug Hypothesis Packet

## Problem Statement

For Grok conversations, the payload posted to the server still has a generic title (`"New conversation"`) even though:

1. The conversation is fully completed/canonical-ready.
2. The payload includes user content that should allow title fallback derivation.
3. Save JSON on page can show a better title in some runs.

Current failing example:

- Conversation ID: `e3d36e64-9ad3-4fbc-b8d9-a66753dfaa6d`
- Server JSON title is still `"New conversation"`.

## Where To Find Artifacts

### Blackiya repo artifacts

- Debug report: `/Users/rhaq/workspace/blackiya/blackiya-debug-2026-03-03-07-06.txt`
- Extendo log copy: `/Users/rhaq/workspace/blackiya/extendo.txt`
- This hypothesis packet: `/Users/rhaq/workspace/blackiya/title-hypothesis.md`

### Server output artifacts

- Translation JSON: `/Users/rhaq/workspace/compilations/translations/e3d36e64-9ad3-4fbc-b8d9-a66753dfaa6d.json`
- Meta JSON: `/Users/rhaq/workspace/compilations/translations/e3d36e64-9ad3-4fbc-b8d9-a66753dfaa6d.meta.json`
- Idempotency record:
  - `/Users/rhaq/workspace/compilations/translations/.idempotency/ab5b99bd49ce0ead54ce8f259a5f6337e2d92fa6d84a8a53aa97b98bba9cff33.json`

### Related codebases

- Blackiya: `/Users/rhaq/workspace/blackiya`
- Extendo: `/Users/rhaq/workspace/extendo`
- Server (`rupture-baby`): `/Users/rhaq/workspace/rupture-baby`

## Observed Runtime Facts (From Latest 07:06 Run)

1. Blackiya emitted only one external event for this conversation:
   - `conversation.ready`
   - Event ID: `e314b1b4-f5d6-4ab4-a486-1bcd12d2f82e`
2. No `conversation.updated` for same conversation appears in debug report.
3. Extendo ingested and posted exactly that one event:
   - `seq: 24`
   - POST 200 succeeded
4. Server stored the posted payload as-is with generic title.
5. The stored payload includes large user prompt text in `mapping`, so first-user-message fallback data exists in the posted body.

## What We Changed So Far (Important Context)

### Blackiya title/event logic changes attempted

1. External event dedupe moved from content-hash-only style to payload-aware behavior:
   - `utils/runner/external-event-dispatch.ts`
2. Added title-change emission regressions:
   - `utils/runner/external-event-dispatch.test.ts`
   - `utils/runner/external-event-emission.test.ts`
3. Added external emit-time title fallback in runner context:
   - `utils/runner/runner-engine-context.ts`
4. Added dispatcher-level title normalization before event build:
   - `utils/runner/external-event-dispatch.ts` now normalizes generic title via `resolveExportConversationTitleDecision(...)`.
5. Added TDD regression for exact failing shape:
   - Generic title + prompt present should emit non-generic title on first external event.

### Extendo checks

1. Extendo is receiving only `conversation.ready` for failing runs.
2. No evidence in latest log that Extendo rewrites title.
3. Extendo posts `record.payload` directly in `conversation-persistence.ts`.

### Server checks

1. `rupture-baby` route writes raw request body directly to `<id>.json`:
   - `/Users/rhaq/workspace/rupture-baby/src/app/api/translations/[id]/route.ts`
2. No server-side title transformation observed.

## Main Hypotheses (Ranked)

## Hypothesis 1 (High confidence): Runtime extension code mismatch/stale load

Behavior in live logs remains identical to pre-fix behavior despite source-level changes and passing tests.

Why plausible:

1. Repeated runs still produce only `conversation.ready` with generic title.
2. Runtime behavior does not reflect added normalization expectations.
3. This can happen if Chrome is running an older built extension bundle (or wrong profile/instance) versus current workspace source.

What to verify:

1. Confirm loaded extension build timestamp and source in `chrome://extensions`.
2. Hard reload extension and all target tabs.
3. Add a temporary unmistakable log marker in external dispatch path and confirm it appears in runtime logs.

## Hypothesis 2 (Medium): The emit path used in production bypasses modified normalization path

There may be another code path producing external events (or old code branch still active) that does not pass through the updated dispatcher normalization.

Why plausible:

1. Debug report only shows send/build logs, not normalized-title logs.
2. Complex runner wiring + background hub + SFE retries could hit a path not covered by current targeted tests.

What to verify:

1. Instrument all event emission callsites with a unique marker and include payload title in logs.
2. Log payload title in background hub at internal ingress (`External event internal message received` equivalent with title).
3. Compare title at:
   - pre-send in content script
   - post-ingest in background hub
   - post-ingest in Extendo

## Hypothesis 3 (Lower): First-user title derivation fails on real payload shape at event-time only

Even though stored payload has user text, event-time object shape could differ just before dispatch due to race/mutation and become generic-only at that instant.

What to verify:

1. Log derived first-user title length and value preview right before `maybeBuildExternalConversationEvent`.
2. Log `payload.title` + `firstUserMessageTitle` + `decision.source`.

## Hypothesis 4 (Low): Extendo or server transforms title

Current evidence does not support this:

1. Extendo posts raw payload.
2. Server writes raw body.

Still worth cross-checking once with explicit title-at-ingest logs in Extendo.

## Suggested Investigation Plan For External Agent

1. Add temporary structured logs that include `payload.title` at each stage:
   - Blackiya content pre-send
   - Blackiya background internal ingest
   - Extendo event persist
   - Extendo pre-POST
2. Add temporary log for title decision internals:
   - `currentTitle`, `isGeneric(currentTitle)`, `derivedFirstUserTitle`, `streamTitle`, `domTitle`, `resolvedTitle`, `source`
3. Validate loaded extension artifact:
   - Confirm that runtime code includes latest strings/symbols from updated source.
4. Reproduce once with one fresh conversation ID and collect:
   - debug report
   - full logs JSON (not only debug report)
   - extendo log
   - server JSON/meta/idempotency record
5. If code mismatch is ruled out, trace call graph for external event emission to ensure all paths use `maybeBuildExternalConversationEvent` from current module.

## Useful Pointers

### Blackiya files

- `/Users/rhaq/workspace/blackiya/utils/runner/external-event-dispatch.ts`
- `/Users/rhaq/workspace/blackiya/utils/runner/runner-engine-context.ts`
- `/Users/rhaq/workspace/blackiya/utils/runner/button-state-manager.ts`
- `/Users/rhaq/workspace/blackiya/utils/title-resolver.ts`

### Extendo files

- `/Users/rhaq/workspace/extendo/src/background/blackiya/event-processor.ts`
- `/Users/rhaq/workspace/extendo/src/background/blackiya/conversation-persistence.ts`
- `/Users/rhaq/workspace/extendo/src/background/blackiya-sync-manager.ts`

### Server file

- `/Users/rhaq/workspace/rupture-baby/src/app/api/translations/[id]/route.ts`

