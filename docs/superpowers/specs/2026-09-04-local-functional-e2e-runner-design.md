# Local Functional E2E Runner Design

## Goal

Provide one supported Windows command surface for running Album Haven's
fixture-backed functional Playwright tests locally. A developer must not need to
reconstruct CI provisioning, PostgreSQL authentication, fixture copying, port
ownership, or teardown by hand.

## Command surface

Add `scripts/run-functional-e2e-local.ps1` and expose it through npm aliases.
The script supports four operations:

- list the approved functional shards and their exact case titles;
- run one exact case in its owning shard;
- run one complete shard;
- run every functional shard sequentially.

Focused execution accepts an exact case title rather than a Playwright grep
expression. The script resolves ownership from `tests/ci/functional-shards.json`
and delegates execution to `scripts/ci/validate-functional-shards.cjs`. Direct
use of `scripts/run-playwright.cjs` is not a supported substitute for these
fixture-backed cases.

## Local environment ownership

Each invocation creates a unique child directory below the system temporary
directory. That root owns the writable fixture copy, immutable source fixture,
Playwright output, blob reports, database identity, PostgreSQL roles, and the
ports selected for the run.

The source fixture defaults to the locally installed
`../album-haven-test-data/dist` release and must report `fixtures-v1.0.19` in
`manifest.json`. The runner may accept an explicit fixture-distribution path for
diagnostics, but it must apply the same manifest and profile validation. It
copies the `functional-core` profile into invocation-owned immutable and
writable roots before loading the PostgreSQL projection.

Local PostgreSQL connections use `localhost`, not `127.0.0.1`, because the
supported noninteractive local authentication entry is scoped to `localhost`.
The process sets `PGPASSFILE` to
`C:\Users\Rendref\AppData\Roaming\postgresql\pgpass.conf` when that file exists,
while preserving an explicitly supplied `PGPASSFILE`. Missing authentication is
reported as a setup error before Playwright starts.

The runner clears owner runtime paths before delegating to the existing shard
runner. It never targets the owner's application process, database, library, or
media directories.

## Provisioning and execution

For every selected shard, the PowerShell runner performs the existing trusted
sequence:

1. Validate prerequisites, fixture release, requested shard, and exact case.
2. Allocate a unique temporary root, database name, roles, and safe port base.
3. Prepare immutable and writable `functional-core` fixture roots.
4. Provision isolated PostgreSQL through
   `scripts/ci/bootstrap-windows-postgres.ps1`, binding provider setup to the
   invocation-owned provider port.
5. Load the fixture profile through the repository's existing loader.
6. Invoke `scripts/ci/validate-functional-shards.cjs` with `--run-shard` and,
   when requested, `--run-case`.
7. Preserve the original test exit code while performing teardown in `finally`.

All-shard execution is sequential. A failure is recorded without leaving
resources behind; the command returns nonzero after completing the required
cleanup. The runner does not introduce retries, relaxed timeouts, alternate data
authority, or direct low-level Playwright execution.

## Cleanup and diagnostics

Teardown targets only the exact database, roles, ports, and temporary root
allocated by the current invocation. Resolved paths must remain beneath the
system temporary directory and match the runner's unique prefix before recursive
removal is allowed.

On success, disposable temporary fixture and database state is removed. Test
reports remain at a clearly printed invocation-owned output location when a run
fails, unless retaining them would conflict with database or process cleanup.
The console summary prints the selected fixture release, shard and case scope,
ports, output path, test result, and teardown result without printing passwords
or connection secrets.

## Documentation

Add a local functional E2E guide that includes:

- prerequisites and the expected fixture location;
- list, case, shard, and full-suite examples;
- the `localhost` and `PGPASSFILE` authentication rule;
- the distinction between the supported local runner and low-level Playwright
  commands;
- artifact and failure-cleanup behavior.

The npm aliases are the primary documented entry points. Direct PowerShell usage
is documented for advanced parameter control.

## Automated verification

Add test-first contract coverage for:

- npm aliases and supported modes;
- exact shard/case validation;
- `localhost` PostgreSQL provisioning and `PGPASSFILE` selection;
- fixture-release and `functional-core` validation;
- unique temp, port, database, and role ownership;
- delegation to the existing functional-shard runner;
- guaranteed, scoped teardown on success and failure;
- documentation examples remaining aligned with the implemented commands.

After the contract tests pass, run production-path parity and one real focused
functional E2E case through the new local command. Confirm the owned application,
browser, Node, Python, Playwright, PostgreSQL, port, and temporary-directory state
is clean afterward.
