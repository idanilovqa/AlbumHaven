# Production-backed search benchmark

`FTC-GALLERY-STARTUP-005P` is an owner-invoked, read-only benchmark against the already-running sandbox1 app at `https://sandbox1.albumhaven.org`. It does not start or stop the app, seed data, apply migrations, write to PostgreSQL, touch media, or replace browser responses.

The cases are `Devin` resolving to `Devin Townsend` and `Neal Morse` resolving to `Neal Morse`. Each measurement starts at the real Enter submission. The timed endpoint is the first browser-confirmed paint of the expected album with the complete full-response album inventory applied. A preview-only result, incomplete inventory, wrong query, or invisible card fails. Gallery virtualization may limit mounted cards; it must not limit the available result inventory. Preview response timing remains diagnostic. The atomic search flow has one visible full-result render, so the benchmark must not wait for a second preview-to-full render.

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

## October 6 regression investigation

The owner-authorized local port-5004 investigation is separate from the sandbox1-only command above. The previous first-card benchmark could time a preview and assumed a later render generation. Its shared paint observer now checks full-result membership at the captured browser frame, and both production and mandatory synthetic cases use that check. Budgets are unchanged. Passing helper tests does not establish a passing browser benchmark.

The local blank-gallery failure was reproduced while a search overlapped startup hydration. The old full-request path rebuilt live alias data despite a valid stale projection. The guarded projection fix removes that fallback only when matching current projection fingerprints prove authority. Search requests now run preview and full hydration concurrently under one response owner, and retain the previous coherent applied view until the complete response is ready. Repeated submissions from artist and mobile contexts restart obsolete requests through the existing cancellation path.

The shared browser observer verified complete-result paint and continuous mounted cards. Earlier ready-gallery measurements were 743, 670, 689, and 696 ms for Neal Morse, Devin, Neal Morse, and Devin respectively. These do not establish a reliable pass: a subsequent clean restart measured immediate-startup Neal Morse at **1667.7 ms**, comprising 34.4 ms dispatch, 1369.9 ms full API resource time, and 263.4 ms response-to-paint. Mounted cards remained at least seven throughout. The full response contained approximately 701 KB of decoded JSON.

The following ready-gallery sequence measured **2213.2, 1190.7, 1543.1, and 1051.4 ms** for the same four-query order. Both Neal Morse cases fail the unchanged 1200 ms ceiling. Initial root-gallery readiness also took approximately 80 seconds in that diagnostic. Backend startup/background contention and response processing remain under investigation. Cover readiness is separate from complete-result paint; these measurements do not claim every cover was decoded. The performance regression remains open, and paired calibration has not passed.

Actual-server profiling found an exact-artist preview bypassing the existing rule against preview-triggered settings prewarming. It started an 11.55-second optional Problematic Files preload while full search was still executing. The selected-artist path now applies the same preview guard; the full-result path still queues prewarming. The exact regression failed before the fix, and 16 related tests passed afterward. This is a verified scheduling repair, not a complete performance fix: the next ordinary cold run measured **1519.1 ms**, and its ready sequence measured **1453.1, 1017.3, 1456.1, and 429.1 ms**. Connection-pool acquisition was below 0.1 ms in the profiled run, so that run did not identify pool contention as the bottleneck.

The next verified change reuses the existing request-local album membership cache during family grouping. The regression compares the complete output against the uncached path, including aliases and shared albums, and proves three snapshots for three albums instead of nine. All 56 related family/search tests passed. After restoring the established exact-search family policy as a separate correctness repair, the ordinary ready sequence measured **608.6, 591.3, 655.8, and 422.3 ms**. The same build's immediate-startup Neal Morse search still failed at **1603.5 ms** (1346.3 ms API, 229.1 ms response-to-paint). No result or budget is waived on the strength of the faster ready sequence.

The native synthetic paired-search target initially passed both browser assertions but failed reporter finalization because the spec published only its custom correlation attachment. It now uses the existing performance-report fixture and publishes terminal metrics before enforcing the timing assertion, preserving evidence on hard failures. The executable regression covers 350 ms and 550 ms outcomes; 54 related JavaScript tests passed. The unchanged native target then passed with **Devin 360.8 ms** and **Neal Morse 304.9 ms**, both below the 400 ms target and 500 ms hard ceiling. Its finalized history retains separate records for both queries, and the target policy reports complete metrics and functional checks. This verifies the synthetic target only; the failed real-data startup measurement still prevents claiming complete paired calibration.

A later live-process diagnostic measured startup Neal Morse at **1067.0 ms** (860.7 ms browser API, 128.0 ms response-to-paint). The full repository work took 799.2 ms wall time and 281.2 ms thread CPU; database execution accounted for 531.6 ms wall time. Search-row loading took 248.0 ms, nonalbum loading 132.8 ms, and family grouping 57.0 ms; these stages are inclusive and must not be added to their parent totals. This faster diagnostic did not reproduce or explain the retained 1603.5 ms failure. The ordinary launcher was restored afterward and authenticated gallery loading verified. Startup reliability remains open.

A fixed three-startup diagnostic batch then measured **1545.6 ms (fail), 866.9 ms (pass), and 855.9 ms (pass)** without retries or filtering. Each trial verified unchanged source/build markers and the served runtime bundle hash. The failed trial's API took 1287.9 ms and response-to-paint 227.9 ms; repository work took 1196.0 ms wall / 406.3 ms thread CPU, versus 582.8 / 218.8 and 635.3 / 281.3 ms in the passing trials. Database execute wall totals were 754.9, 376.2 and 392.4 ms respectively; execute wall time includes server/network wait and caller scheduling, so it does not establish server execution time alone. All trials retained seven existing cards until thirteen complete results appeared, without a blank frame. No separate root API request overlapped the searches in the captured browser lifecycle. The failed search's single worker snapshot showed search family processing with other sampled workers idle; that sparse sample does not rule out transient contention. The ordinary launcher and authenticated gallery were restored and verified after the batch. No performance fix is claimed from the two passing trials.


### October 6: index repair and retained cold-search failures

The owner-authorized maintenance execution reported restoring the missing `local_albums_normalized_raw_artists_trgm_idx` using only the additive statement from migration `0083_add_album_raw_artist_search_index.sql`, followed by the normal application role running the existing verifier and receiving `ready`. That execution result was recorded in the task transcript, not a separate retained repair artifact. Independently, the retained post-repair index inventory (`search-plans-1791293027667031400`) records `valid: true` and `ready: true`. This repair does not establish a passing end-to-end search benchmark.

The next fixed batch used the ordinary launcher without profiling, database sampling, or retries. Every trial verified stable source/build markers and the served runtime bundle. Immediate-startup Neal Morse search measured:

| Trial | Complete-result paint | Classification |
| --- | ---: | --- |
| 1 | 937.7 ms | Grace used |
| 2 | 1173.4 ms | Grace used |
| 3 | 1297.2 ms | Hard failure |

These values are retained in the October 6 ordinary cold-run results (`cold-ordinary-20261006-071218-426`). A subsequent single run with wall/thread-CPU stage timing, but no database sampler or retry, measured **1205.8 ms**, also a hard failure (`cold-stage-only-20261006-072508-308`). The 800 ms target, 400 ms grace, and 1200 ms ceiling remain unchanged; the small overrun is not rounded into a pass. The instrumented result and ordinary results remain separate evidence.

A later code repair shares a lazily built normalized-alias lookup within each expansion batch. Regressions preserve first-match alias precedence, exact-name precedence, request-local freshness, and the separate last-match policy used by nonalbum row canonicalization. The exact repeated-build regressions failed before the repair; **73 related Python tests passed** afterward. At that checkpoint, no real-data browser measurement had verified the alias-reuse change; the preceding timings are not its results.

Fresh-session diagnostics covered single startup submission, repeated startup submission, retained selected-artist supersession, and a new query after deep scrolling. The five retained JSON results report completion without recorded errors and no zero-card sample after their search-observation boundary. In the deep-scroll case, at least two viewport-visible cards remained during the observed transition; the final state contained thirteen mounted cards, eight within the viewport. These diagnostics did not reproduce the reported blank screen; they do not establish its cause or resolve an authentication/session-expiry problem. Evidence is retained under the October 6 blank-search run IDs `1791294087533`, `1791294222600`, and `1791294393562`.

### October 6: measured results after alias reuse

The next fixed three-trial batch used the ordinary launcher with no profiling, database sampler, or retries. Each trial verified unchanged source/build markers and the served bundle. Immediate-startup Neal Morse complete-result paint measured **773.0, 718.1, and 604.0 ms**, all below the 800 ms target. The retained evidence is `cold-ordinary-20261006-085153-082/results.json`.

The following ready-gallery sequence measured **673.6, 533.5, 441.7, and 836.8 ms** for Neal Morse, Devin, Neal Morse, and Devin respectively (`ready-after-alias-20261006-0855/browser.json`). The last Devin result used the approved grace band. All seven measurements passed the unchanged 1200 ms ceiling; six met the 800 ms target. These are results from the repaired build, not proof that alias reuse alone accounts for the difference from earlier runs.

The ready-gallery samples retained mounted cards throughout their observation boundaries, but cover readiness remained incomplete: the first three searches still had visible covers not ready in the recorded snapshots. These timings establish complete-result paint, not decoding every cover, and do not resolve the separately reported black flash. The earlier failed trials remain part of the regression history. Complete paired calibration on the current candidate and the full CI pipeline are not yet green; this seven-measurement pass does not replace either gate.

### October 6: owner manual acceptance and remaining completeness issue

After testing the repaired build, the owner reported that the black flash no longer appears and search speed is satisfactory. The latest seven retained measurements already pass the unchanged 1200 ms hard ceiling; no budget relaxation is needed. This manual acceptance updates the earlier unresolved black-flash report while preserving the historical failed measurements and their diagnostic limits.

Real-data benchmarks remain opt-in local diagnostics, excluded from CI. The owner requested no further real-data benchmark runs at this checkpoint. Mandatory synthetic performance coverage and the complete CI pipeline remain required; local measurements and manual speed acceptance do not replace those gates.

Result completeness remains open: the owner reports that Neal Morse search is missing bands. That issue is being investigated separately. Applying the complete server-response inventory at paint does not prove that the response contains every band required by the search contract; the timing passes do not close this correctness issue.
