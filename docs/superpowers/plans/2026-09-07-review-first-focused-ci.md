# Review-First Focused CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make hosted PR review run before tests, add a non-authoritative label-selected focused E2E repair mode, and automatically promote a passing focused run to an authoritative full-review pipeline.

**Architecture:** Extend the existing dependency-free review classifier into a pull-request pipeline classifier that consumes changed-line evidence and label names. Keep one `pr-gates.yml`: review jobs execute first in full mode, test jobs use terminal-result dependencies rather than success dependencies, and a focused gate owns label promotion after selected E2E shards pass.

**Tech Stack:** GitHub Actions YAML, Node.js 22 CommonJS, Node built-in tests, GitHub REST API.

## Global Constraints

- Fewer than 250 changed functional lines means incremental review; 250 or more means full review.
- Documentation-only ranges skip review, including when `ci:full-review` is present.
- `ci:focused-e2e` requires at least one valid focused target label.
- Focused mode skips review and unrelated suites and cannot satisfy the authoritative release gate.
- E2E runs after reviewers reach terminal state even when a reviewer fails.
- The full pipeline completes every required review and test job before fixes begin.
- Only the successful full pipeline records the reviewed-head marker.
- Existing functional and performance E2E expectations remain unchanged.

---

### Task 1: Pipeline mode and review-scope policy

**Files:**
- Modify: `scripts/ci/classify-pr-review-scope.cjs`
- Modify: `tests/js/pr-review-scope.test.js`

**Interfaces:**
- Consumes: `{ action, baseSha, lastReviewedSha, headSha, numstat, labels }`.
- Produces: the existing review outputs plus `pipelineMode`, `focusedFunctionalShards`, `focusedPhase7Targets`, and `focusedPerformanceShards`.

- [x] **Step 1: Add failing classifier tests**

Add exact cases for 249 lines -> `incremental`, 250 lines -> `full`, docs-only -> `none`, `ci:full-review` plus functional change -> `full`, focused mode target parsing, invalid/absent focused targets -> thrown policy error, and unknown target labels -> thrown policy error.

- [x] **Step 2: Run the classifier test and observe RED**

Run: `node --test tests/js/pr-review-scope.test.js`

Expected: failures for the 250-line boundary and missing pipeline-label outputs.

- [x] **Step 3: Implement label-aware classification**

Add constants for the exact supported labels and normalize `labels` to a string set. Change the incremental condition to `functionalLines < INCREMENTAL_LINE_LIMIT`. In focused mode validate and return selected shard arrays while forcing review mode `none`. In full mode preserve docs-only `none` and let `ci:full-review` override incremental functional changes to `full`.

- [x] **Step 4: Run the classifier test and observe GREEN**

Run: `node --test tests/js/pr-review-scope.test.js`

Expected: all classifier cases pass.

### Task 2: Full and focused gate validators

**Files:**
- Modify: `scripts/ci/validate-cloud-verification-gate.cjs`
- Create: `scripts/ci/validate-focused-e2e-gate.cjs`
- Modify: `tests/js/cloud-verification-gate.test.js`
- Create: `tests/js/focused-e2e-gate.test.js`

**Interfaces:**
- Consumes: full-mode job conclusions or `{ selectedTargets, targetResults }` for focused mode.
- Produces: `{ authoritative, conclusion, errors }`, with `authoritative: false` for every focused result.

- [x] **Step 1: Add failing validator tests**

Require the full validator to reject `pipelineMode !== 'full'`. Require the focused validator to reject no targets, unselected jobs that ran, selected jobs that skipped or failed, and unknown targets; accept only exactly selected successful jobs.

- [x] **Step 2: Run validator tests and observe RED**

Run: `node --test tests/js/cloud-verification-gate.test.js tests/js/focused-e2e-gate.test.js`

Expected: failures because pipeline-mode enforcement and the focused validator do not exist.

- [x] **Step 3: Implement both policies**

Keep the full required-job and review-mode matrix intact, add the `pipelineMode: 'full'` requirement, and implement a pure focused validator with the supported target set exported for tests.

- [x] **Step 4: Run validator tests and observe GREEN**

Run: `node --test tests/js/cloud-verification-gate.test.js tests/js/focused-e2e-gate.test.js`

Expected: all validator cases pass.

### Task 3: Review-first workflow and focused E2E routing

**Files:**
- Modify: `.github/workflows/pr-gates.yml`
- Modify: `tests/js/cloud-verification-gate.test.js`
- Modify: `tests/js/focused-e2e-gate.test.js`

**Interfaces:**
- Consumes: review-scope outputs and pull-request labels.
- Produces: full review-first jobs, target-selected focused E2E jobs, `Focused E2E Verification`, and the authoritative `Cloud Verification Gate`.

- [x] **Step 1: Add failing workflow structure assertions**

Assert review jobs depend only on scope, every test family depends on terminal reviewer results, every E2E condition contains `always()`, focused mode selects only matching matrix rows, the full gate is full-mode-only, and the focused gate never writes the reviewed-head marker.

- [x] **Step 2: Run workflow tests and observe RED**

Run: `node --test tests/js/cloud-verification-gate.test.js tests/js/focused-e2e-gate.test.js`

Expected: failures showing the current tests-before-review dependency direction.

- [x] **Step 3: Publish pipeline outputs from `review_scope`**

Pass `toJson(github.event.pull_request.labels.*.name)` to the classifier and expose pipeline mode plus JSON target arrays as job outputs. Add `labeled` and `unlabeled` pull-request event types.

- [x] **Step 4: Move reviewers before tests**

Remove all test dependencies and result requirements from the three reviewer jobs. Retain same-repository, non-draft, successful-scope, mode, and credential conditions. Increase the third whole-review timeout enough to finish the already observed large-PR review without changing its review scope.

- [x] **Step 5: Make test execution independent of review success**

Add `review_scope`, `pr_agent_review`, `codex_review`, and `ai_code_review` as terminal dependencies of every foundation and E2E family. Use `always()` and pipeline-mode conditions so full-mode jobs run after review even when review failed, while focused mode runs only selected E2E targets.

- [x] **Step 6: Add focused verification and automatic promotion**

Validate selected results, then use `actions/github-script` with `issues: write` to remove `ci:focused-e2e` and all target labels and apply `ci:full-review`. Do not post or update the reviewed-head marker. Leave labels unchanged when any selected target fails.

- [x] **Step 7: Keep full verification authoritative**

Run Cloud Verification Gate only for full mode, validate every required job and review conclusion after all jobs finish, then and only then record the successfully reviewed head.

- [x] **Step 8: Run workflow-focused tests**

Run: `node --test tests/js/pr-review-scope.test.js tests/js/cloud-verification-gate.test.js tests/js/focused-e2e-gate.test.js`

Expected: all workflow and policy tests pass.

### Task 4: Repository-wide process rules

**Files:**
- Modify: `AGENTS.md`
- Modify: `C:/Repositories/album-haven-internal/AGENTS.md`
- Modify: `C:/Repositories/album-haven-internal/docs/agent-workflows/coderabbit-workflow.md`
- Modify: `C:/Repositories/album-haven-internal/docs/agent-workflows/e2e-failure-investigation-workflow.md`

**Interfaces:**
- Consumes: the implemented full/focused workflow contract.
- Produces: standing instructions for future chats and release runs.

- [x] **Step 1: Add the public repository rule**

State the exact review-first order, strict 250-line boundary, docs-only skip, focused labels, automatic full promotion, complete inventory rule, and authoritative-full requirement.

- [x] **Step 2: Reconcile private owner guidance**

Replace the obsolete tests-before-review description and record the same focused/full sequence without weakening Rules 64-68 or the full-suite failure batching rule.

- [x] **Step 3: Verify prose and focused contracts**

Run: `git diff --check`

Run: `node --test tests/js/pr-review-scope.test.js tests/js/cloud-verification-gate.test.js tests/js/focused-e2e-gate.test.js tests/js/check-e2e-production-parity.test.js tests/js/validate-functional-shards.test.js tests/js/validate-performance-matrix.test.js`

Expected: no diff errors and all affected tests pass.

- [x] **Step 4: Commit both repositories**

Commit the app workflow, tests, rules, spec, and plan together. Commit the private owner-rule and workflow documentation changes separately in the internal repository. Leave the test-data repository unchanged unless the active playback fixture correction requires a test-data commit.
