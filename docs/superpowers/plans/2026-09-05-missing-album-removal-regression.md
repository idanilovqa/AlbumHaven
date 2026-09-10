# Missing Album Removal Regression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore production missing-album deletion and prove smooth, correctly ordered gallery removal through the real Playwright path.

**Architecture:** Put the privileged multi-table mutation in one migration-owned security-definer PostgreSQL function and keep the app role limited to function execution. Extend the existing watcher E2E to observe the public request, modal lifecycle, in-place gallery reconciliation, layout continuity, and durable deletion.

**Tech Stack:** PostgreSQL 18 SQL migrations, Python service contract tests, Node.js, Playwright.

## Global Constraints

- PostgreSQL remains the only durable authority for app-owned runtime data.
- The E2E must use the production ASGI application, normal UI controls, and real PostgreSQL path.
- Keep the existing 240000 ms scenario timeout and do not add retries or alternate success paths.
- Preserve unrelated staged and unstaged work in the shared checkout.

---

### Task 1: Add the bounded removal function

**Files:**
- Create: `migrations/postgres/0061_create_missing_album_removal_function.sql`
- Modify: `migrations/postgres/README.md`
- Test: `tests/py/test_postgres_migrations.py`

**Interfaces:**
- Consumes: `library.confirm_missing_album_removal(target_album_key text)` call from `PostgresMissingAlbumRemovalService`.
- Produces: one row containing `album_found`, `active_file_count`, `stale_private_paths`, `root_private_paths`, `unresolved_root_count`, `removed_album_key`, `removed_album_count`, and `inventory_mutation_revision`.

- [ ] **Step 1: Run the existing migration contract and confirm RED**

Run: `pytest -q tests/py/test_postgres_migrations.py::test_missing_album_removal_uses_a_bounded_security_definer_capability`

Expected: FAIL because `0061_create_missing_album_removal_function.sql` does not exist.

- [ ] **Step 2: Create the migration**

Move the previously tested transactional CTE from the service boundary into:

```sql
create or replace function library.confirm_missing_album_removal(target_album_key text)
returns table (
  album_found boolean,
  active_file_count bigint,
  stale_private_paths text[],
  root_private_paths text[],
  unresolved_root_count bigint,
  removed_album_key text,
  removed_album_count bigint,
  inventory_mutation_revision bigint
)
language sql
security definer
set search_path = pg_catalog
as $function$
  select false, 0, array[]::text[], array[]::text[], 0, null::text, 0, 0
  where false;
$function$;

revoke all on function library.confirm_missing_album_removal(text) from public;
grant execute on function library.confirm_missing_album_removal(text) to album_haven_app;
```

Replace the empty typed body in the planning signature with the complete CTE
from the staged service implementation. Change `%(album_key)s` to
`target_album_key`; keep every relation schema-qualified.

Qualify every schema and relation name inside the function. Keep the current
service-side filesystem recheck so a root disconnect or reappeared file rolls
back the transaction.

- [ ] **Step 3: Register the migration in the README**

Add `0061_create_missing_album_removal_function.sql` to the ordered migration
list and document its bounded capability grant.

- [ ] **Step 4: Run focused migration and service tests**

Run: `pytest -q tests/py/test_postgres_migrations.py::test_missing_album_removal_uses_a_bounded_security_definer_capability tests/py/test_missing_album_removal_postgres.py`

Expected: PASS.

### Task 2: Strengthen the production-path deletion E2E

**Files:**
- Modify: `tests/e2e/specs/libraryFilesystemWatcher.functional.spec.js`

**Interfaces:**
- Consumes: `POST /api/library/albums/{album_key:path}/confirm-removal`, Album Details POM, app confirmation POM, and gallery card POM.
- Produces: regression coverage for successful response, modal closure, no error toast, no navigation, stable scroll, correct surviving-card order, immediate removal, and reload durability.

- [ ] **Step 1: Add assertions that expose the current failure and missing smoothness contract**

Before accepting the dialog, register a response waiter for the exact removal
endpoint, record the main-frame URL and scroll position, and start collecting
main-frame navigation events. After accepting, assert:

```js
expect(removalResponse.ok()).toBe(true);
await expect(trackModalActions.trackModal.appConfirmDialog.overlay).toBeHidden();
await expect(trackModalActions.trackModal.dialog).toBeHidden();
await expect(page.getByText('Unable to remove album from Album Haven.')).toHaveCount(0);
expect(mainFrameNavigations).toEqual([]);
expect(await page.evaluate(() => window.scrollY)).toBe(scrollYBefore);
expect(remainingTitles).toEqual([EARLIER_ALBUM, LATER_ALBUM]);
```

Keep the current card absence, Postgres deletion, reload, and post-reload card
absence assertions.

- [ ] **Step 2: Run the unchanged production-path scenario and confirm RED**

Run the repository's configured command for only
`tests/e2e/specs/libraryFilesystemWatcher.functional.spec.js` in the functional
project.

Expected: FAIL at the removal response while migration `0061` is not applied to
the isolated database.

- [ ] **Step 3: Apply normal migration setup and rerun the focused E2E**

Use the existing isolated-app migration path. Do not seed the function outside
the migration runner and do not intercept the request.

Expected: PASS with the original timeout.

- [ ] **Step 4: Repeat the focused E2E**

Run the same scenario with `--repeat-each=5`.

Expected: 5 passes with no retry.

### Task 3: Verify the regression boundary

**Files:**
- Verify only; do not edit unrelated files.

**Interfaces:**
- Consumes: migration, service, runtime, and E2E changes from Tasks 1 and 2.
- Produces: evidence that the fix works through focused and broader relevant suites.

- [ ] **Step 1: Run focused Python tests**

Run: `pytest -q tests/py/test_postgres_migrations.py tests/py/test_missing_album_removal_postgres.py tests/py/test_missing_album_projection.py`

Expected: PASS.

- [ ] **Step 2: Run focused JavaScript tests**

Run: `node --test --test-concurrency=1 tests/js/runtime/tag-editor-and-optimistic-updates.test.js tests/js/runtime/bootstrap-gallery-event-handlers.test.js tests/js/validate-functional-shards.test.js`

Expected: PASS.

- [ ] **Step 3: Run the functional shard validator**

Run the repository package command that validates functional shard membership.

Expected: PASS with the watcher scenario still registered.

- [ ] **Step 4: Review the scoped diff**

Confirm the diff contains only the new migration, migration documentation,
regression design and plan, and E2E assertion changes attributable to this bug.
