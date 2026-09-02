# Change-Aware PR Reviews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate hosted PR reviews on successful E2E jobs, select no/incremental/full review scope from the last successfully reviewed head, and add the pinned AI Code Review // VERY POWERFULL action for full reviews.

**Architecture:** A dependency-free Node classifier converts Git numstat output and pull-request event metadata into one review mode. The workflow feeds that mode into three review jobs and passes the job conclusions to a mode-aware final validator. PR Agent uses `/review -i` for incremental pushes, Codex receives the selected SHA range, and the third action runs only for full reviews.

**Tech Stack:** GitHub Actions YAML, Node.js 22 CommonJS scripts, Node's built-in test runner, Git.

## Global Constraints

- Treat files under `docs/` and root-level Markdown files as documentation; treat other changed paths as functional.
- Count functional additions plus deletions and use an inclusive 250-line incremental limit.
- Treat binary functional changes as full-review changes.
- Require successful JavaScript, component, Windows Node, Python, production-parity, Phase 7, functional E2E, and performance E2E jobs before a hosted reviewer runs.
- Skip the third reviewer in `none` and `incremental` modes.
- Pin AI Code Review // VERY POWERFULL to `e4c07fe82e4c70a3cf152773423f608a88e9497d` and disable its linter feature.
- Preserve the current same-repository and non-draft secret boundary.

---

### Task 1: Review scope classifier

**Files:**
- Create: `scripts/ci/classify-pr-review-scope.cjs`
- Create: `tests/js/pr-review-scope.test.js`

**Interfaces:**
- Consumes: `{ action, baseSha, lastReviewedSha, headSha, numstat }`.
- Produces: `classifyReviewScope(input)` with `{ mode, baseSha, headSha, functionalChange, functionalLines, hasBinaryFunctionalChange }`.

- [x] **Step 1: Write failing policy tests**

Cover root Markdown and `docs/` as documentation, `.github/` Markdown as functional configuration, mixed changes, 249/250/251 lines, binary files, initial events, missing successful baselines, and synchronize SHA selection.

- [x] **Step 2: Run the focused test and confirm the missing module failure**

Run: `node --test tests/js/pr-review-scope.test.js`

Expected: FAIL because `scripts/ci/classify-pr-review-scope.cjs` does not exist.

- [x] **Step 3: Implement the pure classifier and CLI**

Implement these exports:

```js
function isDocumentationPath(filePath) {}
function parseNumstat(numstat) {}
function classifyReviewScope(input) {}
function runCli(env = process.env) {}
module.exports = { isDocumentationPath, parseNumstat, classifyReviewScope, runCli };
```

The CLI will run `git diff --numstat --no-renames <selected-base> <head>`, write lowercase booleans and scalar values to `GITHUB_OUTPUT`, and fail on missing or malformed SHAs.

- [x] **Step 4: Run the focused classifier tests**

Run: `node --test tests/js/pr-review-scope.test.js`

Expected: PASS.

### Task 2: Mode-aware cloud gate

**Files:**
- Modify: `scripts/ci/validate-cloud-verification-gate.cjs`
- Modify: `tests/js/cloud-verification-gate.test.js`

**Interfaces:**
- Consumes: `input.reviewMode` plus `input.jobResults.ai_code_review`.
- Produces: the existing `{ authoritative, conclusion, errors }` result with mode-specific reviewer expectations.

- [x] **Step 1: Extend gate tests before implementation**

Add `review_scope` and `ai_code_review` to the job inventory. Test trusted `none`, `incremental`, and `full` modes, including each forbidden skipped/success result. Keep fork expectations deterministic.

- [x] **Step 2: Run the focused gate test and confirm failures**

Run: `node --test tests/js/cloud-verification-gate.test.js`

Expected: FAIL because the validator does not accept `reviewMode` or the third reviewer.

- [x] **Step 3: Implement mode-specific expectations**

Keep foundation and E2E jobs mandatory. Require reviewer results as follows:

```js
const REVIEW_EXPECTATIONS = {
  none: { pr_agent_review: 'skipped', codex_review: 'skipped', ai_code_review: 'skipped' },
  incremental: { pr_agent_review: 'success', codex_review: 'success', ai_code_review: 'skipped' },
  full: { pr_agent_review: 'success', codex_review: 'success', ai_code_review: 'success' },
};
```

Reject missing and unknown modes.

- [x] **Step 4: Run the focused gate tests**

Run: `node --test tests/js/cloud-verification-gate.test.js`

Expected: PASS.

### Task 3: Workflow wiring and hosted reviewers

**Files:**
- Modify: `.github/workflows/pr-gates.yml`
- Modify: `.github/codex/prompts/review.md`
- Modify: `tests/js/cloud-verification-gate.test.js`

**Interfaces:**
- Consumes: `review_scope.outputs.mode`, `base_sha`, `head_sha`, and all test/E2E conclusions.
- Produces: `pr_agent_review`, `codex_review`, `ai_code_review`, and an authoritative final cloud result.

- [x] **Step 1: Add failing workflow assertions**

Assert that the classifier job exists, each reviewer requires successful functional and performance E2E results, PR Agent switches between `/review -i` and `/review`, Codex uses classifier SHAs, the third action uses the immutable pin only in full mode, and Cloud Verification Gate forwards the mode and all reviewer results.

- [x] **Step 2: Run the workflow-focused test and confirm failures**

Run: `node --test tests/js/cloud-verification-gate.test.js`

Expected: FAIL on missing scope and third-review wiring.

- [x] **Step 3: Add `review_scope` and update PR Agent**

Read the bot-authored successful-review marker, checkout full history in `review_scope`, run the classifier, and expose its outputs. Keep PR Agent automatic review for non-push events. For synchronize events enable push handling and select `github_action_config.push_commands` as `['/review -i']` in incremental mode or `['/review']` in full mode.

- [x] **Step 4: Constrain Codex and add the third reviewer**

Pass classifier base/head SHAs to Codex. Add `ai_code_review` with credential preflight, immutable action pin, and `ENABLE_LINTERS: 'false'`. Gate on the action step's exit status because the pinned implementation declares outputs but does not set them. Give the job `contents: read`, `issues: write`, and `pull-requests: write` only.

- [x] **Step 5: Wire the final gate**

Pass `REVIEW_MODE`, `REVIEW_SCOPE_RESULT`, and `AI_CODE_REVIEW_RESULT` to fork and trusted validation. Require a successful scope job, let the validator enforce the review-result matrix, and record the current head only after trusted validation succeeds.

- [x] **Step 6: Run focused JavaScript tests**

Run: `node --test tests/js/pr-review-scope.test.js tests/js/cloud-verification-gate.test.js`

Expected: PASS.

### Task 4: Durable workflow documentation

**Files:**
- Modify: `../album-haven-internal/docs/agent-workflows/coderabbit-workflow.md`
- Modify: `../album-haven-internal/docs/agent-workflows/album-haven-skill-guardrails.md`

**Interfaces:**
- Consumes: the final workflow mode and gate contracts.
- Produces: owner workflow guidance matching CI behavior.

- [x] **Step 1: Replace the obsolete E2E-failure review contract**

Document that hosted reviewers require successful functional and performance E2E, describe `none`, `incremental`, and `full`, and name the third reviewer as a full-mode-only gate.

- [x] **Step 2: Check prose and diffs**

Run: `git diff --check`

Expected: no output and exit code 0.

- [x] **Step 3: Run the complete affected JavaScript test set**

Run: `node --test tests/js/pr-review-scope.test.js tests/js/cloud-verification-gate.test.js tests/js/check-e2e-production-parity.test.js tests/js/validate-foundation-gates.test.js tests/js/validate-functional-shards.test.js tests/js/validate-performance-matrix.test.js`

Expected: PASS.

- [x] **Step 4: Review final repository state**

Run: `git status --short` and `git diff --check`.

Expected: only the plan and requested pipeline, test, prompt, and owner-document changes appear; no whitespace errors.
