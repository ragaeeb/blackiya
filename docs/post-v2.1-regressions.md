# Post-V2.1 Regressions Tracker

Date started: 2026-02-15
Purpose: track every post-V2.1 regression, root cause, fix, and test coverage so the next retro/review cycle has concrete evidence.

## How To Use This File

1. Add a new row for every user-observed regression.
2. Link logs/screenshots/JSON artifacts.
3. Do not close an issue until a regression test exists.
4. Keep entries chronological.
5. If unresolved, keep `Status=Open` and add next action.

---

## Regression Log

| ID | Date | Platform | Symptom | Repro Summary | Root Cause | Fix Summary | Tests Added/Updated | Status | Artifacts |
|---|---|---|---|---|---|---|---|---|---|
| V2.1-001 | 2026-02-15 | ChatGPT | Save could auto-enable from timeout path | Long/unstable canonical stabilization path | Legacy timeout fallback treated elapsed time as readiness | Removed timer-forced ready; timeout now transitions to `degraded_manual_only` | `utils/platform-runner.test.ts`, `utils/sfe/readiness-gate.test.ts` | Resolved | `docs/v2.1-final-plan.md` |
| V2.1-002 | 2026-02-15 | ChatGPT | Timeout blocker mislabeled in gate output | Stability wait exceeded | Readiness gate returned `stability_window_not_elapsed` instead of explicit timeout | Added `stabilization_timeout` blocker semantics | `utils/sfe/readiness-gate.test.ts` | Resolved | `docs/v2.1-review/synthesis.md` |
| V2.1-003 | 2026-02-15 | ChatGPT | Wrong attempt identity under fallback causing bleed risk | Late ID resolution + fallback attempt IDs | Shared `legacy:*:unknown` fallback IDs | Switched to immutable unique `attemptId` fallback + alias forwarding model | `integration/attemptid-rebind-race.test.ts`, `utils/platform-runner.test.ts` | Resolved | `docs/v2.1-final-plan.md` |
| V2.1-004 | 2026-02-15 | ChatGPT | Snapshot fallback could be treated as ready authority | Canonical fetch instability path | Snapshot fallback used as effective readiness promotion in prior flow | Snapshot restricted to degraded/manual-only exports with metadata | `utils/platform-runner.test.ts` | Resolved | `docs/v2.1-review/synthesis.md` |
| V2.1-005 | 2026-02-15 | ChatGPT | Latest assistant terminal semantics could false-positive | Older assistant message terminal, latest not terminal | Readiness check used broad `some(end_turn===true)` behavior | Tightened to latest assistant text turn terminality | `platforms/chatgpt.test.ts` | Resolved | `docs/v2.1-final-plan.md` |
| V2.1-006 | 2026-02-15 | Multi-tab | Race/disposal late signals could mutate state | Supersede/dispose while retries/signals still in flight | Missing deterministic protection for late signals | Added race-focused integration coverage and drop semantics | `integration/dispose-retry-race.test.ts`, `integration/multi-tab-deterministic.test.ts` | Resolved | `docs/v2.1-final-plan.md` |
| V2.1-007 | 2026-02-15 | ChatGPT | `Save JSON` could appear enabled during active streaming in one tab | 8-tab concurrent run where one tab inherited ready cache while a new attempt was already in-flight | Button readiness evaluation could rely on cached readiness before streaming lifecycle state was applied for the active attempt | Bound `prompt-sent` attempt before stale filtering and added a hard UI guard: if lifecycle is `prompt-sent`/`streaming`, keep Save disabled regardless of cached readiness | `utils/platform-runner.test.ts` (`should keep Save disabled while streaming even when cached data is ready`) | Resolved | `logs/blackiya-debug-2026-02-15-19-39.txt` |
| V2.1-008 | 2026-02-15 | ChatGPT | Completed conversations stayed in degraded/manual mode across many tabs; force-save exported partial payloads until refresh | 8-tab run where interceptor proactive canonical fetch exhausted (`fetch gave up ...`) and canonical recovery stalled | Recovery path combined three issues: (1) proactive fetch exhaustion, (2) warm-fetch short-circuit on any cached object (including partial), (3) completed non-terminal canonical state not consistently driving retry fetch scheduling | Updated canonical recovery pipeline: warm-fetch only short-circuits on ready cache, stabilization retries now warm-fetch first, completed lifecycle can schedule stabilization retry when canonical probing is unresolved, and force-save performs last-chance warm-fetch before degraded export | `utils/platform-runner.ts`, `utils/platform-runner.test.ts` (updated stabilization/degraded scenarios), `integration/multi-tab-deterministic.test.ts` | Resolved (Monitoring) | `logs/blackiya-debug-2026-02-15-19-39.txt`, `logs/refreshed.txt`, `logs/Translation_of_Arabic_Grammar_2026-02-15_14-36-01.json`, `logs/Translation_of_Arabic_Grammar_2026-02-15_14-46-53.json` |
| V2.1-009 | 2026-02-15 | ChatGPT | Multi-tab completion still landed in Force Save/degraded across all tabs until refresh | 8-tab run (`blackiya-debug-2026-02-15-20-26.txt`) where stream ended, snapshot fallback captured, and several conversations stayed degraded with partial force-save output | Two coupled issues remained: (1) degraded snapshot captures could satisfy local readiness and short-circuit warm-fetch retries, and (2) degraded captures could still advance SFE canonical stabilization path enough to suppress further canonical recovery attempts before high-fidelity API capture arrived | Refactored capture-fidelity policy and applied it to runner flow: warm-fetch short-circuit now requires high-fidelity capture; degraded captures no longer ingest as canonical samples; completed+degraded attempts explicitly schedule stabilization retries; retry loop now re-schedules while capture remains degraded | `utils/sfe/capture-fidelity.ts`, `utils/sfe/capture-fidelity.test.ts`, `utils/platform-runner.ts`, `utils/platform-runner.test.ts` (`should upgrade from degraded snapshot mode to canonical-ready when API capture arrives`) | Resolved (Monitoring) | `logs/blackiya-debug-2026-02-15-20-26.txt`, `logs/refreshed.txt`, `logs/69922a57-451c-832f-8bc7-947dbf21bb7d.json`, `logs/refreshed.json` |

---

## Open Regressions

Use this section for active bugs needing immediate triage.

| ID | Date | Platform | Symptom | Severity | Owner | Next Action |
|---|---|---|---|---|---|---|
| (none) | - | - | - | - | - | - |

---

## Entry Template (Copy/Paste)

```md
### V2.1-XXX - <short title>
- Date:
- Platform:
- Symptom:
- Reproduction steps:
1.
2.
3.
- Expected behavior:
- Actual behavior:
- Logs/artifacts:
- Root cause:
- Fix:
- Tests added/updated:
- Status: Open | Resolved | Monitoring
- Residual risk:
- Follow-up action:
```

---

## Next Retro Input Checklist

Before next AI review cycle, ensure this file has:
1. Every regression linked to a test.
2. Every resolved regression linked to commit/PR or changed file paths.
3. A short "what slipped past the original plan" note per issue.
4. Open issues grouped by platform (ChatGPT/Gemini/Grok).
