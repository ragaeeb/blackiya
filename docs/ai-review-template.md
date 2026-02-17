# AI Review Methodology Template

Date: 2026-02-15
Owner: Blackiya core maintainers

## Purpose

Use this document as the standard operating template for:
1. Creating architecture/proposal docs for AI review.
2. Sending consistent review prompts to multiple AI reviewers.
3. Synthesizing reviews into one adjudicated decision set.
4. Producing the next implementation plan (TDD-first).

If another agent is asked to continue this workflow, instruct them:
- "Follow `docs/ai-review-template.md` exactly."

---

## 1) End-to-End Workflow

1. Create proposal/plan doc (`docs/<topic>.md`).
2. Collect AI reviews into a dedicated folder (`docs/<topic>-review/*.md`).
3. Synthesize all reviews into `docs/<topic>-review/synthesis.md`.
4. Produce revised plan (`docs/<topic>-final-plan.md`).
5. Implement in staged TDD slices.
6. Track post-plan regressions in retro tracker (`docs/post-v2.1-regressions.md`).
7. Run another review cycle only when meaningful deltas accumulate.

---

## 2) What Context To Provide Reviewers

Always include:
1. The current proposal/plan doc.
2. The latest synthesis doc (if this is a second-pass review).
3. Any retrospective/regression log relevant to failure history.
4. Explicit scope boundaries (in-scope / out-of-scope).
5. Locked decisions and preferences (for example: ChatGPT-first, no timeout auto-ready).

For repo-aware reviewers (preferred when possible), provide:
- access to current codebase,
- affected file list,
- critical tests already added,
- key runtime logs.

For doc-only reviewers, provide:
- architecture snippets,
- known incidents and root causes,
- acceptance gates.

---

## 3) Reviewer Prompt Template (Copy/Paste)

Use this at the top of proposal/plan docs.

```md
# Reviewer Instructions (Read First)

You are reviewing a production architecture/implementation proposal for a browser extension that captures LLM conversations and triggers reactive actions after response completion.

Your objectives:
1. Find brittle assumptions, race conditions, and maintainability risks.
2. Identify overengineering and unrealistic scenarios.
3. Stress-test extensibility for new platforms and automation features.
4. Evaluate performance, contention behavior, and logging signal-to-noise.
5. Propose concrete alternatives with implementation-level detail.

Scope constraints:
- Text prompt/text response only.
- Multimodal, agent/deep-research flows are out of scope.
- Privacy model is local-first.

Please respond with exactly:
1. Summary Verdict
2. Critical Risks (ranked)
3. Missing Tests
4. Plan Changes You Recommend
5. Reviewer Metadata
- Model:
- Version:
- Date (YYYY-MM-DD):
```

---

## 4) Review Collection Protocol

1. Create a dedicated folder:
- `docs/<topic>-review/`

2. Save each reviewer output as one file:
- `docs/<topic>-review/<model-name>.md`

3. Keep reviewer outputs unedited (raw).

4. Add weighting tags before synthesis:
- Tier A: reviewers with strong code-specific evidence.
- Tier B: reviewers with useful but less code-grounded analysis.

5. Do not average opinions. Prefer evidence + reproducibility.

---

## 5) Synthesis Template (Required Structure)

Write `docs/<topic>-review/synthesis.md` with:

1. Inputs + weighting
- list every reviewed file
- define Tier A vs Tier B

2. Consensus
- strong areas of agreement

3. Disagreements
- document conflict areas and final chosen direction

4. Point-by-point adjudication
For each major claim:
- Agree / Partially agree / Disagree
- why (tied to code behavior)
- action decision

5. Reviewer-by-reviewer table
- file
- key claims
- assessment quality
- keep vs reject/defer

6. Final synthesized decisions
- 8-12 concrete decisions that directly feed implementation

Rules:
- reject suggestions that violate locked scope.
- call out false positives explicitly.
- record deferred items with reason.

---

## 6) Final Plan Template (Required Sections)

Write `docs/<topic>-final-plan.md` with:

1. Reviewer Instructions
2. Why this version exists
3. Locked invariants
4. Workstreams (TDD-first)
5. API/type changes
6. Test matrix
7. Execution order
8. Acceptance gates
9. Assumptions/defaults

Plan requirements:
- split by implementation phases,
- list exact files to change,
- list exact tests to add/update,
- define rollback controls,
- define what is deferred.

---

## 7) TDD Execution Protocol

For each phase:
1. Write/update failing tests first (RED).
2. Implement minimal code to pass (GREEN).
3. Refactor without changing behavior.
4. Run focused tests for changed surface.
5. Update plan/progress notes.

Never skip:
- race/disposal tests,
- multi-tab deterministic tests for concurrency-sensitive code,
- regression tests for every user-reported failure pattern.

---

## 8) Regression Tracking Protocol

After implementation, append to:
- `docs/post-v2.1-regressions.md`

Required entry fields:
1. Date/time
2. Platform
3. Symptom
4. Reproduction steps
5. Logs/attachments
6. Root cause
7. Fix
8. Tests added/updated
9. Status
10. Residual risk/follow-up

Use this tracker as primary input for next retro review cycle.

---

## 9) Quality Gates Before Asking For Another Review Round

1. New regressions are clustered and documented in tracker.
2. Root causes are validated (not guessed).
3. Relevant tests exist and fail before fixes.
4. Proposed changes are grouped into coherent workstreams.
5. Scope lock is explicit (what will not be tackled this round).

If these are not true, do not start a new agent review cycle yet.

---

## 10) Quick Command Checklist

```bash
# List review files
ls -la docs/<topic>-review

# Read all reviews quickly
rg --files docs/<topic>-review

# Run focused tests after plan changes
bun test <changed-test-files>

# Inspect current delta
git status --short
```

---

## 11) Handoff Shortcuts

For synthesis task handoff:
- "Read `docs/ai-review-template.md` and produce `docs/<topic>-review/synthesis.md` using the required structure."

For final plan task handoff:
- "Read `docs/<topic>-review/synthesis.md` and generate `docs/<topic>-final-plan.md` with TDD-first phases and exact tests/files."

For implementation handoff:
- "Execute `docs/<topic>-final-plan.md` in strict RED->GREEN->Refactor order and keep a focused test log."
