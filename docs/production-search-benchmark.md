# Production-backed search benchmark

`FTC-GALLERY-STARTUP-005P` is an owner-invoked, read-only benchmark against the already-running sandbox1 app at `https://sandbox1.albumhaven.org`. It does not start or stop the app, seed data, apply migrations, write to PostgreSQL, touch media, or replace browser responses.

The cases are `Devin` resolving to `Devin Townsend` and `Neal Morse` resolving to `Neal Morse`. Each measurement starts at the real Enter submission and records preview response completion, expected-card DOM readiness, the next paint, and the later full-payload paint.

The target is 800 ms. Results from 801 ms through 1200 ms use the approved 400 ms grace band. Results above the 1200 ms hard ceiling fail.

Before navigation, the benchmark installs a narrow safety route. It passes same-origin GET and HEAD requests unchanged. It records only method, origin, and path before aborting any write or foreign-origin request. Trace, screenshots, and video stay disabled. Retained metrics contain the case ID, query, budget, classification, sanitized readiness booleans, and phase timings. They exclude response payloads, artist arrays, authentication data, database identity proofs, and local paths.

## Readiness proof

Create a short-lived operator attestation before measuring. The preflight:

- opens the operator connection in a read-only transaction;
- hashes this worktree's exact `0084_create_local_artist_search_projection.sql` file;
- requires the `ops.schema_migrations` row for that filename to contain the same SHA-256;
- derives a domain-separated HMAC-SHA256 database identity proof using the
  sandbox1 runtime's existing authentication HMAC secret and key version; and
- writes only sanitized evidence to the local attestation file.

The app role keeps its existing privileges. It does not receive access to `ops.schema_migrations`. The authenticated `/status` response derives the same keyed proof through the normal application pool and returns no database name, address, port, role, URL, credential, or secret. The benchmark accepts only the version-2 attestation and status schemas, compares their scheme, key version, and proof before timing, and retains only `databaseIdentityMatched: true`. Legacy unsalted SHA-256 attestations fail closed.

The readiness check also requires `relation_projection.ready === true`, a nonempty projection builder version, and a positive album total. The benchmark never applies migration 0084. Apply and validate migrations only through the deployment runbook.

## Run

Sign in through the normal sandbox1 UI and save a local Playwright storage-state file. Supply the operator database URL and the sandbox1 runtime's current HMAC secret and key version through temporary benchmark-only environment variables. They never appear in the command line or attestation; remove them immediately after creating the attestation. Obtain the values through the machine's existing private deployment-secret workflow rather than copying them into source, shell history, or retained artifacts.

```powershell
$attestation = Join-Path $env:TEMP 'album-haven-production-search-database.json'
$env:ALBUM_HAVEN_PRODUCTION_SEARCH_OPERATOR_DATABASE_URL = '<operator PostgreSQL URL>'
$env:ALBUM_HAVEN_PRODUCTION_SEARCH_IDENTITY_HMAC_SECRET = '<sandbox1 runtime HMAC secret>'
$env:ALBUM_HAVEN_PRODUCTION_SEARCH_IDENTITY_HMAC_KEY_VERSION = '<sandbox1 runtime HMAC key version>'
python -m scripts.attest_production_search_database --output $attestation
Remove-Item Env:ALBUM_HAVEN_PRODUCTION_SEARCH_OPERATOR_DATABASE_URL
Remove-Item Env:ALBUM_HAVEN_PRODUCTION_SEARCH_IDENTITY_HMAC_SECRET
Remove-Item Env:ALBUM_HAVEN_PRODUCTION_SEARCH_IDENTITY_HMAC_KEY_VERSION

$env:PLAYWRIGHT_REAL_APP_URL = 'https://sandbox1.albumhaven.org'
$env:ALBUM_HAVEN_PRODUCTION_SEARCH_BENCHMARK_APPROVAL = 'I_ACKNOWLEDGE_READ_ONLY_PRODUCTION_SEARCH_BENCHMARK'
$env:ALBUM_HAVEN_PRODUCTION_SEARCH_STORAGE_STATE = '<ignored-local-storage-state.json>'
$env:ALBUM_HAVEN_PRODUCTION_SEARCH_DATABASE_ATTESTATION = $attestation
npm run test:e2e:performance:production-search
```

The exact URL, approval token, authentication state, and a fresh attestation are mandatory. `--list` discovery runs no case and does not require them. CI execution is rejected.

## Paired production and synthetic calibration

Run both datasets with one command after creating the production attestation and setting the required environment variables above:

```powershell
npm run test:e2e:performance:paired-search-calibration
```

The orchestrator runs the production benchmark first. The synthetic phase does not run when production fails. A passing production phase starts the dedicated synthetic pair on managed port 5011 with the same run ID. Both synthetic cases use a fresh browser context, the same root-album setup, and an explicit expected artist.

The command writes one combined JSON artifact under `test-results/paired-search-calibration/<run-id>/paired-search-calibration.json`. It contains the two queries, expected artists, sanitized submit-to-first-visible timings, production classifications, and per-case synthetic-to-production ratios. It excludes response payloads, artist arrays, authentication data, database identity values, and local paths.

The production contract remains an 800 ms target plus 400 ms grace, with results above 1200 ms failing. Synthetic results use a 400 ms target, 100 ms grace band, and 500 ms hard ceiling; results above 500 ms fail.

Synthetic data provides deterministic regression coverage. The production run proves the user-visible target against the owner's real library.
