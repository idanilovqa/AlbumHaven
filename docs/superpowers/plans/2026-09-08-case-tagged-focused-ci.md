# Case-Tagged Focused CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make exceptional hosted exact-case and tagged-related diagnosis safe, while using exact local verification followed directly by complete review-first CI as the normal repair path.

**Architecture:** Parse a bounded hidden PR-body marker into validated exact FTC IDs and product-area tags. Extend functional Playwright discovery and the shard contract so selectors resolve independently of shard placement. The focused gate validates one non-authoritative stage; an authenticated release operator verifies the current head and advances labels through native pull-request events.

**Tech Stack:** GitHub Actions, Node.js 22, Playwright, CommonJS CI validators, GitHub REST API.

## Global Constraints

- Default to focused local verification followed directly by the complete native pull-request pipeline. Use hosted focused stages only for unusually difficult local reproduction or CI-specific failures, state the reason, and return to full CI once the focused failure is fixed.
- Collect all applicable reviews first; failed reviews hold tests. After reviews pass, collect every required test result before fixing the test failure inventory.
- Focused stages are non-authoritative and skip review plus unrelated suites.
- Exact stage runs only explicitly selected FTC cases.
- Related stage runs only cases carrying selected native `@area:<name>` Playwright tags.
- Full review-first CI is mandatory after related success.
- Invalid or empty selectors fail closed and raw PR content is never evaluated or shell-interpolated.
- Run only focused local tests; complete suites run in CI.

---

### Task 1: Selector Parser And Stage Classification

**Files:**
- Create: `scripts/ci/resolve-focused-e2e-selection.cjs`
- Modify: `scripts/ci/classify-pr-review-scope.cjs`
- Modify: `tests/js/pr-review-scope.test.js`
- Create: `tests/js/focused-e2e-selection.test.js`

**Interfaces:**
- Consumes: PR body text, label names, functional discovery metadata.
- Produces: `parseFocusedMarker(body)`, `resolveFocusedSelection(input)`, and workflow outputs `focused_stage`, `focused_cases_json`, `focused_areas_json`, and owning shard JSON.

- [ ] **Step 1: Write failing parser and classifier tests** for one exact case, multiple areas, absent/duplicate/oversized markers, unsupported areas, ambiguous IDs, and exact versus related labels.
- [ ] **Step 2: Run the focused tests to verify RED:** `node --test --test-concurrency=1 tests/js/pr-review-scope.test.js tests/js/focused-e2e-selection.test.js`.
- [ ] **Step 3: Implement bounded marker parsing and stage classification** using `JSON.parse`, normalized arrays, explicit supported-area constants, and exact argument data rather than shell strings.
- [ ] **Step 4: Rerun the focused tests and require GREEN.**
- [ ] **Step 5: Commit** with `ci: resolve exact and related E2E selectors`.

### Task 2: Native Area Tags And Cross-Shard Resolution

**Files:**
- Modify: `tests/e2e/**/*.spec.js`
- Modify: `scripts/ci/validate-functional-shards.cjs`
- Modify: `tests/js/validate-functional-shards.test.js`
- Modify: `tests/ci/functional-shards.json`

**Interfaces:**
- Consumes: Playwright case titles and native `@area:<name>` tags returned by list discovery.
- Produces: validated case metadata `{ case, tags, shard, invocation }` and filtered shard invocations for exact IDs or area names.

- [ ] **Step 1: Add failing validator tests** proving every functional case has a supported area tag, one case can have multiple tags, an area can span shards, and exact/area filters execute no unselected case.
- [ ] **Step 2: Run the validator tests to verify RED:** `node --test --test-concurrency=1 tests/js/validate-functional-shards.test.js`.
- [ ] **Step 3: Add native Playwright tags** to every functional FTC case using the approved taxonomy; tag `FTC-UTIL-PROBLEMS-007` with `@area:problematic-files` and `@area:tag-edit`.
- [ ] **Step 4: Implement discovery, validation, and filtering** without changing fixture or runner ownership.
- [ ] **Step 5: Run list validation and focused validator tests and require GREEN:** `node scripts/ci/validate-functional-shards.cjs --list` followed by the Task 2 test command.
- [ ] **Step 6: Commit** with `test: tag functional E2E by product area`.

### Task 3: Workflow State Machine And Safe Operator Promotion

**Files:**
- Modify: `.github/workflows/pr-gates.yml`
- Modify: `scripts/ci/validate-focused-e2e-gate.cjs`
- Modify: `tests/js/focused-e2e-gate.test.js`
- Modify: `tests/js/cloud-verification-gate.test.js`
- Modify: `tests/js/check-e2e-production-parity.test.js`

**Interfaces:**
- Consumes: focused stage, selected case JSON, selected area JSON, owning shards, and job conclusions.
- Produces: exact and related gate evidence, operator-owned transition rules, and unchanged authoritative full gate behavior.

- [ ] **Step 1: Add failing workflow and gate tests** for exact command routing, non-authoritative gate evidence, no CI-owned mutation or dispatch, new-head reset behavior, and review/test ordering invariants.
- [ ] **Step 2: Run the focused workflow tests to verify RED:** `node --test --test-concurrency=1 tests/js/focused-e2e-gate.test.js tests/js/cloud-verification-gate.test.js tests/js/check-e2e-production-parity.test.js`.
- [ ] **Step 3: Wire selector outputs into the functional matrix** and pass JSON selectors to `validate-functional-shards.cjs` without raw shell interpolation.
- [ ] **Step 4: Keep focused CI read-only after validation** and require an authenticated operator to verify the current head before each native pull-request label transition.
- [ ] **Step 5: Rerun the Task 3 tests plus YAML parsing and `git diff --check`; require GREEN.**
- [ ] **Step 6: Commit** with `ci: require pull-request focused promotion`.

### Task 4: Repository Rules And Operator Documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/local-functional-e2e.md`
- Modify: `docs/superpowers/specs/2026-09-07-review-first-focused-ci-design.md`
- Modify: `docs/superpowers/plans/2026-09-07-review-first-focused-ci.md`
- Modify: `C:\Repositories\album-haven-internal\AGENTS.md`
- Modify: `C:\Repositories\album-haven-internal\docs\agent-workflows\e2e-failure-investigation-workflow.md`
- Modify: `C:\Repositories\album-haven-internal\docs\agent-workflows\coderabbit-workflow.md`

**Interfaces:**
- Consumes: implemented marker, tags, and state transitions.
- Produces: durable repo-wide instructions for future chats and accurate historical design records.

- [ ] **Step 1: Update rules and docs** to require exact local verification followed directly by full review-first CI, retaining the authenticated hosted ladder for exceptional diagnosis.
- [ ] **Step 2: Search for obsolete shard-only focused instructions** and reconcile every active occurrence.
- [ ] **Step 3: Run focused documentation/workflow contract tests and `git diff --check`; require GREEN.**
- [ ] **Step 4: Commit app documentation** with `docs: require case-tagged focused CI`.
- [ ] **Step 5: Commit internal documentation** with the same subject and push it with the publication branch.

### Task 5: Current Repair, Hosted Ladder, And Publication

**Files:**
- Existing commit: `78f2f1b fix: preserve problematic list scroll after mutation`
- PR body and labels for PR #1
- Internal Phase 7 history tracker

**Interfaces:**
- Consumes: exact case `FTC-UTIL-PROBLEMS-007`, areas `problematic-files` and `tag-edit`, committed app/internal/test-data branches.
- Produces: exact hosted result, related tagged result, complete full review/test inventory, merged PR, published `v0.9.43`, synchronized repositories, and closed Phase 7 tracker.

- [ ] **Step 1: Run focused local CI-contract tests and confirm all repositories contain only intended committed work.**
- [ ] **Step 2: Commit remaining app changes and push the branch.**
- [ ] **Step 3: For an explicitly justified hosted diagnosis, set the PR marker and exact-stage label state** for `FTC-UTIL-PROBLEMS-007` plus `problematic-files` and `tag-edit`. Otherwise continue directly to the complete native pull-request pipeline.
- [ ] **Step 4: Require exact hosted GREEN, bind the marker to that head and clear/reapply the related label, then require tagged-related GREEN; create an empty promotion commit, bind full promotion to its SHA, set full-review state, and push it for the reviewer-compatible synchronize run.**
- [ ] **Step 5: Collect every applicable reviewer result first. If a validated finding requires another commit, preserve its evidence and stop the superseded run before expensive tests start; verify its jobs stopped. Failed reviews hold tests. Once reviews pass, let every required test job finish and collect the complete test failure inventory.**
- [ ] **Step 6: Fix the complete applicable finding inventory, verify each fix locally, and push directly to a new complete native pull-request pipeline. Repeat until the authoritative full pipeline is green; focused hosted execution remains exceptional.**
- [ ] **Step 7: After full CI succeeds, merge PR #1, publish `v0.9.43`, and synchronize the app checkout. Verify the existing test-data publication.**
- [ ] **Step 8: Close the three remaining Phase 7 checkboxes with actual review/merge/publication evidence. Publish the approved internal closeout through the separate scratch index, preserving the owner's internal checkout. Verify remote publication and the exact closeout scope.**
