# Running functional E2E locally

Use the local functional E2E command for every fixture-backed Playwright case.
It prepares an invocation-owned fixture copy and PostgreSQL database, delegates
to the same functional-shard runner used by CI, and removes its state afterward.

## Prerequisites

- Node dependencies are installed in this repository.
- PostgreSQL 18 is installed at `C:\PostgreSQL\18` and the
  `postgresql-x64-18` service is available.
- Python resolves from `PLAYWRIGHT_PYTHON` or `PATH` and has the application test
  dependencies installed.
- The expanded `fixtures-v1.0.22` distribution is available at
  `..\album-haven-test-data\dist`. Its `profiles\functional-core` directory must
  contain `database`, `media`, and `loopback`.
- PostgreSQL passwordless automation is configured in `PGPASSFILE`. When that
  variable is unset, the command uses the current user's standard application-data
  path at `postgresql\pgpass.conf`.

The runner connects through `localhost`. Do not replace it with `127.0.0.1`:
pgpass host matching is exact, and the supported local entry is scoped to
`localhost`.

## Commands

List every functional shard and its exact case titles without provisioning
PostgreSQL or copying fixtures:

```powershell
npm run test:e2e:functional:local:list
```

Run one exact case. The command resolves its owning shard automatically:

```powershell
npm run test:e2e:functional:local -- -Case "FTC-MOBILE-WEB-007 keeps ratings on one line while narrower galleries preserve selected card scale"
```

During release repair work, reproduce and verify the failing exact case locally,
then run the complete review-first CI pipeline. Use focused hosted runs only for
an unusually difficult or CI-specific failure that needs repeated hosted
feedback; after that focused run passes, return to the complete pipeline.
Preserve native `@area:<name>` tags for diagnosis and reporting. Do not substitute
a complete local shard for exact local reproduction, or treat a shard as a
product area.

The pipeline runs applicable reviewers independently and holds test jobs until
all required reviews succeed. Intentional review skips must match the classified
scope and pull-request context. Collect all review results before fixing their
findings; once reviews pass, collect the complete test failure inventory. If a
validated review finding requires a new commit, preserve its evidence and cancel
the superseded run. Verify its jobs have stopped, fix and verify locally, then
push to a new complete native pull-request pipeline. Held or cancelled runs do
not record review coverage or authorize publication. Final full CI must pass.

GitHub may withhold downloadable job logs until the job finishes. For live case
progress, use the signed-in Actions job page. An unchanged test-execution step
alone does not prove a hang.

Run one complete shard:

```powershell
npm run test:e2e:functional:local -- -Shard gallery-search-visual
```

Run all four functional shards sequentially:

```powershell
npm run test:e2e:functional:local -- -All
```

With no arguments, `test:e2e:functional:local` also runs all four shards
sequentially. Only one Playwright process runs at a time.

Advanced direct PowerShell usage can override the expanded fixture distribution
or Python executable without changing the supported setup path:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-functional-e2e-local.ps1 `
  -Shard gallery-search-visual `
  -FixtureDistribution $env:ALBUM_HAVEN_TEST_DATA_DIST `
  -PythonPath $env:PLAYWRIGHT_PYTHON
```

## What the command owns

Every shard receives a unique child directory under the system temporary
directory, a unique PostgreSQL database and three roles, and a checked free app
and provider port pair. The runner copies `functional-core`, loads its normal
PostgreSQL projection, clears owner runtime paths from the child environment,
and invokes `scripts/ci/validate-functional-shards.cjs` with the approved shard
and exact case title.

Read-only cases share an invocation. Each mutating case runs in its own app
invocation, with the captured PostgreSQL and media baseline restored before the
next invocation. An ordinary test failure is retained in the final result while
the remaining cases continue from that baseline.

Successful runs remove their temporary fixture, reports, database, and roles.
After ordinary test failures, the runner tears down PostgreSQL and removes the
large fixture copies, retaining Playwright output and blob reports at the
printed `album-haven-functional-local-*` path for diagnosis.

Exit code 2 means the runner could not verify an owned process had stopped. It
stops the remaining cases and shards, preserves the database, fixture, and
failure evidence, and prints their temporary root. Verify the recorded owned
process tree and scoped ports are clear before cleaning up those exact resources
or starting another test wave. The command never targets the owner's
application process, database, music library, or media paths.

## Avoid the low-level runner

Do not invoke `scripts/run-playwright.cjs` directly for fixture-backed functional
cases. It assumes the fixture projection, isolated database, ports, and cleanup
have already been prepared. Likewise, `npm run test:e2e:functional` is the
low-level multi-config Playwright command; use the `:local` command when running
the approved fixture-backed shard contract on a developer machine.

If setup fails before Playwright starts, verify the fixture release, PostgreSQL
18 service, Python dependency environment, and the `localhost:5432` postgres
entry in `PGPASSFILE`. No interactive password prompt should be required.
