# Case-Tagged Focused CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate exact-case, tagged-related, and full review-first CI stages for E2E repair pushes.

**Architecture:** Parse a bounded hidden PR-body marker into validated exact FTC IDs and product-area tags. Extend functional Playwright discovery and the shard contract so selectors resolve independently of shard placement, then let the focused gate advance labels from exact to related to authoritative full mode.

**Tech Stack:** GitHub Actions, Node.js 22, Playwright, CommonJS CI validators, GitHub REST API.

## Global Constraints

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

### Task 3: Workflow State Machine And Gate Promotion

**Files:**
- Modify: `.github/workflows/pr-gates.yml`
- Modify: `scripts/ci/validate-focused-e2e-gate.cjs`
- Modify: `tests/js/focused-e2e-gate.test.js`
- Modify: `tests/js/cloud-verification-gate.test.js`
- Modify: `tests/js/check-e2e-production-parity.test.js`

**Interfaces:**
- Consumes: focused stage, selected case JSON, selected area JSON, owning shards, and job conclusions.
- Produces: exact-stage label transition, related-stage full promotion, marker cleanup, and unchanged authoritative full gate behavior.

- [ ] **Step 1: Add failing workflow and gate tests** for exact command routing, exact-to-related transition, related-to-full promotion, no promotion on failure, marker cleanup, and review/test ordering invariants.
- [ ] **Step 2: Run the focused workflow tests to verify RED:** `node --test --test-concurrency=1 tests/js/focused-e2e-gate.test.js tests/js/cloud-verification-gate.test.js tests/js/check-e2e-production-parity.test.js`.
- [ ] **Step 3: Wire selector outputs into the functional matrix** and pass JSON selectors to `validate-functional-shards.cjs` without raw shell interpolation.
- [ ] **Step 4: Implement the two focused-gate transitions** with idempotent GitHub label/body updates and no reviewed-head marker.
- [ ] **Step 5: Rerun the Task 3 tests plus YAML parsing and `git diff --check`; require GREEN.**
- [ ] **Step 6: Commit** with `ci: automate exact related and full E2E stages`.

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

- [ ] **Step 1: Update rules and docs** to require exact local, exact hosted, related tagged hosted, then full review-first CI.
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
- [ ] **Step 3: Set the PR marker and exact-stage label state** for `FTC-UTIL-PROBLEMS-007` plus `problematic-files` and `tag-edit`.
- [ ] **Step 4: Require exact hosted GREEN, then tagged-related GREEN, then allow automatic full promotion.**
- [ ] **Step 5: Let every full review and test job finish; collect the complete combined failure inventory before fixing anything.**
- [ ] **Step 6: Address every genuine review and test finding, use focused local verification for each fix, and repeat the staged hosted ladder until the authoritative full pipeline is green.**
- [ ] **Step 7: Close the three remaining Phase 7 checkboxes with factual review/merge/publication evidence, commit, and push internal documentation.**
- [ ] **Step 8: Merge PR #1, publish `v0.9.43`, synchronize app/internal/test-data local and remote branches, and verify all three worktrees are clean.**
