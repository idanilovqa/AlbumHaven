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
- The expanded `fixtures-v1.0.19` distribution is available at
  `..\album-haven-test-data\dist`. Its `profiles\functional-core` directory must
  contain `database`, `media`, and `loopback`.
- PostgreSQL passwordless automation is configured in `PGPASSFILE`. When that
  variable is unset, the command uses
  `C:\Users\Rendref\AppData\Roaming\postgresql\pgpass.conf`.

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
  -FixtureDistribution C:\Repositories\album-haven-test-data\dist `
  -PythonPath C:\Users\Rendref\Miniconda3\python.exe
```

## What the command owns

Every shard receives a unique child directory under the system temporary
directory, a unique PostgreSQL database and three roles, and a checked free app
and provider port pair. The runner copies `functional-core`, loads its normal
PostgreSQL projection, clears owner runtime paths from the child environment,
and invokes `scripts/ci/validate-functional-shards.cjs` with the approved shard
and exact case title.

Successful runs remove their temporary fixture, reports, database, and roles.
Failed runs still tear down PostgreSQL and remove the large fixture copies, but
retain Playwright output and blob reports at the printed
`album-haven-functional-local-*` path for diagnosis. The command never targets
the owner's application process, database, music library, or media paths.

## Avoid the low-level runner

Do not invoke `scripts/run-playwright.cjs` directly for fixture-backed functional
cases. It assumes the fixture projection, isolated database, ports, and cleanup
have already been prepared. Likewise, `npm run test:e2e:functional` is the
low-level multi-config Playwright command; use the `:local` command when running
the approved fixture-backed shard contract on a developer machine.

If setup fails before Playwright starts, verify the fixture release, PostgreSQL
18 service, Python dependency environment, and the `localhost:5432` postgres
entry in `PGPASSFILE`. No interactive password prompt should be required.
