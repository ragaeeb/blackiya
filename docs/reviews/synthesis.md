# Blackiya V2 Retro Review Synthesis

Date: 2026-02-15

## 1) Inputs And Weighting

Reviewed files:
- `docs/reviews/claude-opus-4.6-high.md`
- `docs/reviews/claude-sonnet-4.5-thinking.md`
- `docs/reviews/gemini-3.0-pro.md`
- `docs/reviews/gemini-3.0-flash.md`
- `docs/reviews/claude-sonnet-4.5.md`
- `docs/reviews/gpt-5-thinking-mini.md`
- `docs/reviews/gpt-5.2-thinking.md`
- `docs/reviews/gpt-5.2.md`
- `docs/reviews/grok-4-expert.md`
- `docs/reviews/grok-4.1-thinking.md`
- `docs/reviews/kimi-k2.5.md`
- `docs/reviews/nova-2-pro.md`
- `docs/reviews/qwen3-max.md`
- `docs/reviews/glm-5-.md`

Weighting policy used in this synthesis:
- Tier A (higher weight): `claude-opus-4.6-high`, `claude-sonnet-4.5-thinking`, `gemini-3.0-pro`, `gemini-3.0-flash`.
- Tier B (supporting): all other reviews.

I also cross-validated high-impact claims against current code:
- `utils/platform-runner.ts`
- `utils/sfe/readiness-gate.ts`
- `utils/sfe/attempt-tracker.ts`
- `platforms/chatgpt.ts`
- `platforms/gemini.ts`
- `platforms/grok.ts`
- `platforms/types.ts`
- `utils/sfe/types.ts`

---

## 2) Collective Agreement (Strong Consensus)

1. Direction is correct: `attemptId` + SFE + adapter-owned readiness improved real correctness.
2. Core unresolved risk is still concurrency and orchestration, not parsing mechanics alone.
3. Current `legacy fallback` (`3200ms`) undermines deterministic canonical-only readiness.
4. ChatGPT-specific hardening improved behavior, but Gemini/Grok readiness parity is missing.
5. Fixed timing constants are brittle under variable network/backend latency.
6. More deterministic concurrency testing is needed beyond targeted regression tests.
7. `platform-runner.ts` is too monolithic, creating maintenance and race-risk concentration.

---

## 3) Major Disagreements Across Reviewers

| Topic | Position A | Position B | Synthesis Decision |
|---|---|---|---|
| Cross-tab coordination | Implement now (BroadcastChannel/probe claim) | Defer as overengineering | Implement minimal optional probe lease after correctness invariants are fixed. |
| Legacy fallback | Keep as pragmatic UX unlock | Remove/disable as invariant violation | Remove as auto-ready authority; replace with explicit degraded/manual path. |
| Snapshot fallback | Keep as operational fallback | Never authoritative | Keep snapshot fallback only as degraded/manual pathway, not canonical-ready authority. |
| Adaptive probe budgets | High ROI now | Premature before deterministic harness | Add lightweight jitter now, full adaptive tuning later. |
| Stream text heuristics | Expand/fix for i18n now | Low priority UX only | Keep preview-only, add Unicode-safe join fix, keep out of readiness/export logic. |

---

## 4) Unique High-Value Points (Not Widely Repeated)

1. Duplicate `PlatformReadiness` type in two modules was flagged with precise evidence and is valid.
2. `ReadinessGate` has a timeout branch that returns blocked forever (`stableMs > maxStabilizationWaitMs` -> still `stability_window_not_elapsed`), likely a logic bug.
3. `buildLegacyAttemptId(platform, undefined)` can produce shared synthetic IDs (`legacy:ChatGPT:unknown`) and should not be used as last-resort identity.
4. Route-change disposal currently preserves `captured_ready` attempts; this helps some UX flows but risks long-session stale residency and state bloat.
5. Unbounded runner maps are real and measurable maintenance/perf risk in long SPA sessions.

---

## 5) Point-By-Point Assessment (Agree/Disagree)

## 5.1 `PlatformReadiness` duplicated in `platforms/types.ts` and `utils/sfe/types.ts`
- Reviewers: Tier A strong.
- Assessment: **Agree**.
- Why: Confirmed in code; risk of silent divergence.
- Action: Single source of truth in `platforms/types.ts`; `utils/sfe/types.ts` re-exports.

## 5.2 Gemini/Grok missing `evaluateReadiness`
- Reviewers: Tier A strong, Tier B repeated.
- Assessment: **Agree**.
- Why: Only ChatGPT adapter currently defines `evaluateReadiness`.
- Action: Implement strict readiness for Gemini and Grok before relying on SFE parity there.

## 5.3 Legacy fallback (`CANONICAL_STABILIZATION_LEGACY_FALLBACK_MS`) violates canonical-only invariant
- Reviewers: Tier A strong consensus.
- Assessment: **Agree**.
- Why: `isConversationReadyForActions` can return true when SFE not ready.
- Action: Remove auto-ready behavior; convert to degraded/manual gate only.

## 5.4 `ReadinessGate` timeout logic is a dead-state bug
- Reviewers: Tier A repeated.
- Assessment: **Agree**.
- Why: If `stableMs > maxStabilizationWaitMs`, gate still returns blocked with `stability_window_not_elapsed`.
- Action: Introduce explicit `stabilization_timeout` outcome and caller policy.

## 5.5 `attemptId` split-brain/race between MAIN and ISOLATED worlds
- Reviewers: Tier A detailed.
- Assessment: **Partially Agree**.
- Why: Existing stale-message checks reduce damage, but legacy fallback ID generation can still produce aliasing and split state in edge ordering.
- Action: Remove shared legacy IDs, add alias migration or unique fallback IDs, add dedicated race test.

## 5.6 Preserve/skip `captured_ready` attempts on route disposal
- Reviewers: Tier A flagged.
- Assessment: **Partially Agree**.
- Why: Preserving `captured_ready` was intentional for reopen UX, but no TTL/eviction policy creates residency risk.
- Action: Add TTL/size-limited eviction for completed attempts and clear active mapping on route transitions where appropriate.

## 5.7 Unbounded maps in `platform-runner.ts`
- Reviewers: Tier A + Tier B.
- Assessment: **Agree**.
- Why: Multiple closure maps have no cap.
- Action: Move to bounded caches (LRU/TTL) for preview, attempt map, auto-capture maps.

## 5.8 `SFE_SHADOW_ENABLED` hardcoded true and rollback path absent
- Reviewers: Tier A.
- Assessment: **Agree**.
- Why: Hardcoded constant found; no runtime toggle path.
- Action: Add storage-driven runtime switch and explicit fallback mode semantics.

## 5.9 Snapshot fallback should never be authoritative
- Reviewers: Mixed, but strong Tier A caution.
- Assessment: **Agree (with nuance)**.
- Why: Snapshot path is valuable for diagnostics and emergency recovery but lower fidelity.
- Action: Keep snapshot as degraded/manual path; mark export metadata `captureSource` and fidelity status.

## 5.10 BroadcastChannel cross-tab coordination now vs defer
- Reviewers: Split.
- Assessment: **Partial/Phased**.
- Why: It can reduce herd contention, but adds distributed-state complexity.
- Action: Add minimal optional probe-lease mechanism only after invariant fixes and deterministic tests.

## 5.11 Unicode/i18n spacing regex concerns
- Reviewers: Gemini Pro and others.
- Assessment: **Agree** for preview quality.
- Why: current regex is ASCII-centric.
- Action: Use Unicode-safe boundaries for preview; keep preview independent from readiness/export.

## 5.12 Suggestion to “fallback guess ready if schema fields missing”
- Reviewers: isolated suggestion (GLM).
- Assessment: **Disagree**.
- Why: This reintroduces false-ready risk; correctness should fail safe (not-ready/degraded) on schema uncertainty.
- Action: Add schema-drift detection + degraded/manual override, not auto-ready guesses.

## 5.13 “BroadcastChannel is overengineering; keep tab isolation forever”
- Reviewers: some (GLM) vs others recommending coordination.
- Assessment: **Disagree** with absolute stance.
- Why: 8-tab stress is a real workload and contention is already observed.
- Action: lightweight, optional coordination is justified after core invariants.

---

## 6) Reviewer-By-Reviewer Assessment

| Reviewer File | Weight | High-Impact Points | My Assessment |
|---|---|---|---|
| `claude-opus-4.6-high.md` | Tier A | Duplicate `PlatformReadiness`, legacy auto-ready invariant break, missing Gemini/Grok readiness, attempt ID race risk, readiness-gate timeout bug | **Mostly Agree**. Strongest technical review; all major concerns corroborated in code. |
| `claude-sonnet-4.5-thinking.md` | Tier A | Hardcoded `SFE_SHADOW_ENABLED`, unbounded maps, fallback bypass, attempt identity risk | **Mostly Agree**. Accurate and actionable; especially strong on operational risks. |
| `gemini-3.0-pro.md` | Tier A | i18n regex concerns, timeout fragility, DOM fallback fidelity warnings | **Partially Agree**. Good i18n/fidelity callouts; some supplementary sections were noisy/duplicative and lower confidence. |
| `gemini-3.0-flash.md` | Tier A | ReadinessGate timeout bug, map eviction concerns, probe scheduler disconnect | **Mostly Agree**. Concise and code-grounded. |
| `claude-sonnet-4.5.md` | Tier B | Invariant violations, snapshot authority caution, modularity gap | **Mostly Agree**. Useful reinforcement of Tier A findings. |
| `gpt-5-thinking-mini.md` | Tier B | Per-attempt queueing, canonical sample ring buffer, deterministic fuzz harness | **Partially Agree**. Strong directionally; some proposals are larger than needed for immediate fix set. |
| `gpt-5.2-thinking.md` | Tier B | Canonical-only readiness insistence, remove auto snapshot authority, add supersede/dispose race tests | **Mostly Agree**. Good correctness-first emphasis. |
| `gpt-5.2.md` | Tier B | Ownership ambiguity, need single arbiter, export atomicity concerns | **Partially Agree**. Valuable architecture framing; a few claims were high-level and not directly evidenced in code. |
| `grok-4-expert.md` | Tier B | Platform drift risk, fixed timeout brittleness, broader chaos testing | **Partially Agree**. Good risk framing, but less concrete than Tier A reviews. |
| `grok-4.1-thinking.md` | Tier B | Keep pushing sample history, caution on fallback heuristics | **Partially Agree**. Reasonable but less specific on implementation details. |
| `kimi-k2.5.md` | Tier B | Heuristic-stacking warning, recommend BroadcastChannel now | **Partially Agree**. Good systems perspective; immediate coordination-first approach is not first priority. |
| `nova-2-pro.md` | Tier B | Readiness drift, disposal race, add minimal cross-tab coordination | **Mostly Agree**. Practical and balanced recommendations. |
| `qwen3-max.md` | Tier B | Strong push for cross-tab lease and adaptive probe strategy | **Partially Agree**. Useful implementation snippets; sequencing should come after invariant restoration. |
| `glm-5-.md` | Tier B | Deterministic harness first, avoid overengineering, suggests permissive schema fallback | **Mixed**. Agree on deterministic harness priority; disagree on permissive auto-ready fallback behavior. |

## 7) Reviewer Quality Notes

1. The four Tier A reviews were materially aligned on the most important correctness risks.
2. Some reports included repeated sections or mixed metadata blocks; we used only technically corroborated points.
3. Tier B feedback was useful for breadth (i18n, UX, diagnostics clarity) but less precise on current code reality.

---

## 8) Final Synthesis Decisions

These are the decisions carried into v2.1 planning:

1. Canonical-only readiness is restored as strict invariant.
2. Legacy timeout fallback is removed as auto-ready authority.
3. Snapshot fallback remains available but only as degraded/manual pathway.
4. Gemini/Grok get first-class `evaluateReadiness` implementations.
5. Identity/disposal hardening is prioritized (attempt alias/race, timer cleanup, map bounds).
6. Deterministic concurrency harness is required before introducing more heuristic complexity.
7. Cross-tab coordination is phased and optional, not mandatory first step.
