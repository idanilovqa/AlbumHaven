# Local Functional E2E Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a supported Windows command that provisions, runs, and cleans Album Haven's fixture-backed functional Playwright tests locally.

**Architecture:** A PowerShell orchestration script owns local prerequisite discovery, fixture copies, isolated PostgreSQL identities, safe ports, environment export, delegation to the existing functional-shard runner, and teardown. npm scripts and a focused guide provide the public command surface; Node contract tests execute the non-mutating list mode and inspect the safety-critical orchestration contract.

**Tech Stack:** PowerShell 7/Windows PowerShell, Node.js test runner, npm scripts, PostgreSQL 18 local service, Playwright functional shard runner.

## Global Constraints

- Use Windows-native PowerShell plus npm aliases.
- Use `fixtures-v1.0.20` and the `functional-core` profile.
- Use `localhost` for local PostgreSQL authentication.
- Preserve an explicit `PGPASSFILE`; otherwise use `postgresql\pgpass.conf` beneath the current user's standard application-data directory when present.
- Run all shards sequentially and never start more than one Playwright process.
- Never target owner application, database, library, media, or runtime paths.
- Teardown may remove only invocation-owned databases, roles, ports, and temporary roots.
- Do not add retries, relaxed timeouts, alternate data authority, or direct low-level Playwright execution.

---

### Task 1: Define the local runner contract test-first

**Files:**
- Create: `tests/js/run-functional-e2e-local.test.js`
- Create: `scripts/run-functional-e2e-local.ps1`

**Interfaces:**
- Consumes: `tests/ci/functional-shards.json`, `scripts/ci/validate-functional-shards.cjs`, `scripts/ci/bootstrap-windows-postgres.ps1`.
- Produces: `scripts/run-functional-e2e-local.ps1 -List`, `-Shard <name>`, `-Case <exact title>`, and `-All`.

- [x] **Step 1: Write failing list and source-contract tests**

Create a Node test that runs PowerShell with `-List`, verifies all four approved
shards and exact case titles, and asserts the script contains the safety-critical
contract: release/profile checks, `localhost`, pgpass selection, unique temp
ownership, bootstrap provision/teardown, exact shard delegation, `finally`, and
owner-runtime environment clearing.

```js
test('local functional runner lists approved shards without provisioning', () => {
  const result = spawnSync(powershell, ['-NoProfile', '-File', runnerPath, '-List'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  for (const shard of contract.shards) assert.match(result.stdout, new RegExp(shard.name));
});

test('local functional runner owns setup, delegation, and teardown', () => {
  assert.match(source, /fixtures-v1\.0\.19/);
  assert.match(source, /functional-core/);
  assert.match(source, /-HostName\s+localhost/);
  assert.match(source, /validate-functional-shards\.cjs/);
  assert.match(source, /finally\s*\{/);
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/run-functional-e2e-local.test.js
```

Expected: FAIL because `scripts/run-functional-e2e-local.ps1` does not exist.

- [x] **Step 3: Implement parameter validation and list mode**

Add a strict parameter set with mutually exclusive `-List`, `-All`, and
`-Shard`; allow `-Case` only with or without `-Shard`, resolving an omitted shard
from the exact case title. Load `functional-shards.json`, reject unknown or
ambiguous cases, and make `-List` exit before fixture, database, or process setup.

```powershell
[CmdletBinding(DefaultParameterSetName = 'All')]
param(
    [Parameter(ParameterSetName = 'List', Mandatory = $true)][switch]$List,
    [Parameter(ParameterSetName = 'All')][switch]$All,
    [Parameter(ParameterSetName = 'Shard', Mandatory = $true)][string]$Shard,
    [Parameter(ParameterSetName = 'Shard')][Parameter(ParameterSetName = 'All')][string]$Case
)
```

- [x] **Step 4: Implement isolated local orchestration**

Resolve Node, Python, PostgreSQL 18 binaries, fixture distribution, and pgpass.
Validate `manifest.json` release and the expanded `profiles/functional-core`
directories. For each selected shard, allocate a GUID-based temp root and safe
free port base, copy immutable and writable fixtures, provision through
`bootstrap-windows-postgres.ps1 -HostName localhost -ExpectedMajorVersion 18
-SkipFixtureLoad`, import the generated environment file, load the fixture with
`load-fixture-profile.py`, and call the shard validator with exact arguments.

```powershell
$arguments = @($validator, "--run-shard=$ShardName")
if ($CaseTitle) { $arguments += "--run-case=$CaseTitle" }
& $node @arguments
if ($LASTEXITCODE -ne 0) { $runFailed = $true }
```

In `finally`, call bootstrap teardown using the exact state path and suffix,
clear secret/runtime variables, validate the temp root prefix and parent, and
remove it on success. On failure retain only the report/output subtree after all
database, role, process, and fixture cleanup is complete.

- [x] **Step 5: Run the focused contract test and verify GREEN**

Run the Step 2 command.

Expected: all tests pass and list mode performs no provisioning.

- [x] **Step 6: Commit Task 1**

```powershell
git add -- scripts/run-functional-e2e-local.ps1 tests/js/run-functional-e2e-local.test.js
git commit -m "test: add safe local functional e2e runner"
```

### Task 2: Publish npm commands and local usage rules

**Files:**
- Modify: `package.json`
- Create: `docs/local-functional-e2e.md`
- Modify: `tests/js/run-functional-e2e-local.test.js`

**Interfaces:**
- Consumes: Task 1 PowerShell parameter contract.
- Produces: npm aliases `test:e2e:functional:local:list`, `test:e2e:functional:local`, and documented argument forwarding.

- [x] **Step 1: Add failing npm and documentation contract tests**

Assert that package scripts call only the new PowerShell entry point, that the
guide includes list/case/shard/all examples, and that it explicitly requires the
supported runner rather than direct `run-playwright.cjs` for fixture-backed
functional cases.

```js
assert.equal(
  packageJson.scripts['test:e2e:functional:local'],
  'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-functional-e2e-local.ps1',
);
assert.match(guide, /npm run test:e2e:functional:local -- -Shard gallery-search-visual/);
assert.match(guide, /Do not.*run-playwright\.cjs/is);
```

- [x] **Step 2: Run the focused test and verify RED**

Run the Task 1 test command.

Expected: FAIL because the npm aliases and guide do not exist.

- [x] **Step 3: Add npm aliases and the guide**

Add:

```json
"test:e2e:functional:local": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-functional-e2e-local.ps1",
"test:e2e:functional:local:list": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-functional-e2e-local.ps1 -List"
```

Document prerequisites, fixture location/release, PostgreSQL host and pgpass
behavior, exact commands, output retention, teardown, and troubleshooting.

- [x] **Step 4: Run the focused test and verify GREEN**

Run the Task 1 test command.

Expected: all tests pass.

- [x] **Step 5: Commit Task 2**

```powershell
git add -- package.json docs/local-functional-e2e.md tests/js/run-functional-e2e-local.test.js
git commit -m "docs: publish local functional e2e commands"
```

### Task 3: Verify the real local path and cleanup contract

**Files:**
- Modify only if verification exposes a defect: `scripts/run-functional-e2e-local.ps1`, `tests/js/run-functional-e2e-local.test.js`, `docs/local-functional-e2e.md`

**Interfaces:**
- Consumes: Task 2 npm command surface.
- Produces: verified local focused E2E execution and residue audit.

- [x] **Step 1: Run command and parity contracts**

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/run-functional-e2e-local.test.js tests/js/validate-functional-shards.test.js
& 'C:\Program Files\nodejs\node.exe' scripts/check-e2e-production-parity.cjs
```

Expected: zero failures and zero production-path violations.

- [x] **Step 2: Run one real focused case through the npm alias**

```powershell
npm run test:e2e:functional:local -- -Case "FTC-MOBILE-WEB-007 keeps ratings on one line while narrower galleries preserve selected card scale"
```

Expected: the command resolves `gallery-search-visual`, provisions the isolated
fixture, reports one passed Playwright test, and tears down PostgreSQL state.

- [x] **Step 3: Audit owned residue**

Verify no invocation-prefixed temp roots, database/roles, application/browser
processes, or selected port listeners remain. Do not inspect or terminate
unrelated processes.

```powershell
Get-ChildItem ([IO.Path]::GetTempPath()) -Directory -Filter 'album-haven-functional-local-*'
```

Expected: no successful-run temp roots and zero task-owned database, role,
process, or port records.

- [x] **Step 4: Run diff and focused regression checks**

```powershell
git diff --check -- package.json scripts/run-functional-e2e-local.ps1 docs/local-functional-e2e.md tests/js/run-functional-e2e-local.test.js
& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/run-functional-e2e-local.test.js tests/js/validate-functional-shards.test.js tests/js/e2e-action-production-paths.test.js
```

Expected: zero diff errors and all focused Node tests pass.

- [x] **Step 5: Commit verification fixes if any**

If Step 2 or Step 3 required a test-first correction, stage only the files in
this plan and commit them:

```powershell
git add -- package.json scripts/run-functional-e2e-local.ps1 docs/local-functional-e2e.md tests/js/run-functional-e2e-local.test.js
git commit -m "fix: harden local functional e2e cleanup"
```
