# Problematic Files Virtualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cached entry to and exit from Settings → Problematic Files responsive with a 706-row production-shaped sanitized fixture and a real production-path E2E performance contract.

**Architecture:** A focused list virtualizer mounts only the visible Problematic Files rows and represents the rest with spacer geometry in vertical and mobile-horizontal modes. Existing utility state and detail rendering remain authoritative, while tab navigation becomes the sole render owner during activation. The fixture repository supplies deterministic synthetic Postgres data that matches the workload shape without private catalog content.

**Tech Stack:** Plain JavaScript runtime, CSS, Node test runner, Python fixture generator and unittest/pytest contracts, Playwright, FastAPI/ASGI, isolated Postgres.

## Global Constraints

- Preserve the existing visual layout, selection, focus, keyboard, search, filter, detail, mutation, and artwork behavior.
- Generate exactly 706 sanitized problematic albums; never copy private paths, metadata, media, credentials, or database contents.
- Keep the Problematic Files 1,000 ms target, 200 ms grace, and 1,200 ms hard ceiling unchanged.
- Exercise production routes and Postgres-backed fixture authority; add no test-only runtime branch or route.
- Run JavaScript and Python suites sequentially and run at most one pytest process.
- Preserve unrelated dirty-worktree changes and stage only task-owned paths.

---

### Task 1: Record the approved contract

**Files:**
- Create: `docs/superpowers/specs/2026-09-23-problematic-files-virtualization-design.md`
- Create: `docs/superpowers/plans/2026-09-23-problematic-files-virtualization.md`

**Interfaces:**
- Consumes: owner-approved purpose-built fixed-row virtualization and sanitized 706-row fixture design.
- Produces: durable runtime, fixture, E2E, compatibility, and rollback contract.

- [ ] **Step 1: Add the design specification and this executable plan.**
- [ ] **Step 2: Scan both documents for placeholders and verify every design requirement maps to a task.**
- [ ] **Step 3: Commit only the two documentation files with `docs: design problematic files virtualization`.**

### Task 2: Add the virtual-list seam with tests first

**Files:**
- Create: `music_app/static/js/runtime/problematic-files-virtual-list.js`
- Create: `tests/js/runtime/problematic-files-virtual-list.test.js`
- Modify: `scripts/build-runtime-bundle.cjs`
- Modify: `tests/js/runtime/app-loader-bundle.test.js`

**Interfaces:**
- Produces: `window.ProblematicFilesVirtualList.create({ list, renderRow, rowStride, overscan })`.
- Instance methods: `render(items, selectedKey)`, `reveal(key)`, `dispose()`.
- DOM contract: `[data-problematic-virtual-window]`, `[data-problematic-virtual-spacer="before"]`, `[data-problematic-virtual-spacer="after"]`, and `data-problematic-mounted-count`.

- [ ] **Step 1: Write Node/JSDOM tests for bounded vertical mounting, overscan, scroll updates, selection reveal, horizontal mode, and disposal.**
- [ ] **Step 2: Run `node --test --test-concurrency=1 tests/js/runtime/problematic-files-virtual-list.test.js`; expect failures because the module does not exist.**
- [ ] **Step 3: Implement the minimum virtualizer with one animation-frame scheduler, vertical 68-pixel stride, measured mobile horizontal stride, spacers, range metadata, reveal, and cleanup.**
- [ ] **Step 4: Add the module to the runtime bundle source list before utility renderers and assert bundle order in the loader-bundle test.**
- [ ] **Step 5: Build the runtime bundle and rerun the focused Node tests; expect all passing.**

### Task 3: Integrate virtualization and single render ownership

**Files:**
- Modify: `music_app/static/js/runtime/utility-renderers-and-actions.js`
- Modify: `music_app/static/js/runtime/bootstrap-utility-event-handlers.js`
- Modify: `music_app/static/js/runtime/utility-loaders-and-cover-lookup.js`
- Modify: `music_app/static/css/runtime/utilities.css`
- Modify: `tests/js/runtime/utility-renderers-and-actions.test.js`
- Modify: `tests/js/runtime/bootstrap-utility-event-handlers.test.js`

**Interfaces:**
- Consumes: `ProblematicFilesVirtualList.create(...)` from Task 2.
- Produces: one mounted virtualizer per Problematic Files list; navigation activation token owns exactly one settled render.

- [ ] **Step 1: Add failing renderer tests proving 706 items mount a bounded subset, selected rows can be revealed, loading/empty states dispose the virtualizer, and filters replace its item set.**
- [ ] **Step 2: Add failing navigation tests proving cached and uncached Problematic Files tab activation does not double-render.**
- [ ] **Step 3: Run both focused Node test files and confirm the new assertions fail for the expected eager/double-render behavior.**
- [ ] **Step 4: Replace eager `.map(...).join('')` list construction with virtualizer `render(items, selectedKey)`, retain row update behavior for mounted rows only, and dispose it outside Problematic Files.**
- [ ] **Step 5: Add spacer/window CSS for vertical and existing mobile-horizontal layouts without changing row appearance.**
- [ ] **Step 6: Make navigation the render owner during loader settlement and remove cached duplicate rendering.**
- [ ] **Step 7: Rebuild the runtime bundle and rerun the focused tests; expect all passing.**

### Task 4: Expand the public sanitized fixture

**Files:**
- Modify: `C:/Repositories/album-haven-test-data-gallery-refactor/generators/utility_problematic_files.py`
- Modify: `C:/Repositories/album-haven-test-data-gallery-refactor/tests/test_fixture_contracts.py`

**Interfaces:**
- Produces: `utility-problematic-files` profile with 706 problematic albums and approximately 627 cover-backed rows, while preserving existing named scenarios and problem types.
- Consumed by: application fixture loader and Playwright profile setup.

- [ ] **Step 1: Add failing fixture assertions for 706 problematic albums, cover-backed workload ratio, deterministic Unicode and long-name cases, existing named scenarios, and owner-path/secret rejection.**
- [ ] **Step 2: Run the exact fixture contract test with the repository's configured Python runner; expect count/shape failures.**
- [ ] **Step 3: Extend the generator deterministically using synthetic names and controlled issue distributions; reuse approved generated cover bytes.**
- [ ] **Step 4: Rebuild the profile twice through the existing fixture test and confirm logical hashes match and all new assertions pass.**
- [ ] **Step 5: Commit only generator and fixture-contract changes in the test-data repository with `test: scale problematic files fixture`.**

### Task 5: Update loader and benchmark contracts

**Files:**
- Modify: `scripts/ci/load-fixture-profile.py`
- Modify: `tests/py/test_ci_fixture_loader.py`
- Modify: `tests/e2e/helpers/syntheticPerformanceBenchmark.js`
- Modify: relevant benchmark/helper guard tests under `tests/js/`

**Interfaces:**
- Consumes: fixture profile count and named assertions from Task 4.
- Produces: loader validation and benchmark dataset contract requiring 706 rows.

- [ ] **Step 1: Change tests to expect 706 items and the new fixture aggregate metadata; run the exact Python loader test and Node benchmark guard test to confirm failures.**
- [ ] **Step 2: Update loader constants, fallback contract, and benchmark dataset contract from 18 to 706 without changing behavioral named cases.**
- [ ] **Step 3: Run the focused Node suite, then the focused Python suite sequentially; expect all passing.**

### Task 6: Add real cached-transition E2E performance coverage

**Files:**
- Modify: `tests/e2e/utilityProblematicFiles/utilitiesResponsiveness.spec.js`
- Modify: `tests/e2e/helpers/syntheticPerformanceBenchmark.js`
- Modify: `tests/e2e/poms/utilityProblematicFiles.js` or existing Settings actions only when a reusable visible-ready action is missing.
- Modify: `tests/js/e2e-performance-helper-guards.test.js`

**Interfaces:**
- Produces metrics: `problematicCachedEnterMs`, `problematicCachedExitMs`, `problematicCachedReenterMs`, and `problematicMountedRowCount`.
- Each transition expectation uses `targetMaximum: 1000`, `graceMs: 200`, `maxAllowed: 1200`.

- [ ] **Step 1: Add benchmark expectations and guard tests for all three cached transition metrics and bounded mounted rows.**
- [ ] **Step 2: Extend the thin Playwright scenario to warm both tabs, measure visible-ready transitions through normal clicks, repeat entry, assert the 706-row payload, and assert a mounted-row ceiling below 60.**
- [ ] **Step 3: Run the focused Node guard tests; expect all passing after helper/spec wiring.**
- [ ] **Step 4: Run the production-parity check and focused `utility-problematic-files` Playwright project against isolated Postgres; require all functional and performance assertions to pass unchanged.**

### Task 7: Review and focused verification

**Files:**
- Review: every task-owned diff in both repositories.

**Interfaces:**
- Consumes: completed runtime, fixture, loader, and E2E changes.
- Produces: evidence-backed, review-clean implementation.

- [ ] **Step 1: Run a first full adversarial diff review for correctness, simplicity, cleanup, accessibility, responsive behavior, privacy, and production-path parity; fix every validated finding.**
- [ ] **Step 2: Rerun affected focused tests sequentially.**
- [ ] **Step 3: Run a second full adversarial review of the resulting complete diff; fix findings and add a third pass if any substantive issue remains.**
- [ ] **Step 4: Rebuild the runtime bundle and rerun focused Node, Python, fixture, parity, and Playwright checks sequentially.**
- [ ] **Step 5: Report exact changed files, test evidence, fixture repository commit, app commit status, and manual verification steps.**
