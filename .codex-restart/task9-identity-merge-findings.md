# Settings identity merge regression

The exact FTC-TAGS-021 native case reproduced on a fresh isolated functional-core
fixture: the first three steps passed, then the immediate merged album contained
13 tracks instead of 16. This does not depend on previous shared-shard tests.

The fourth diagnostic captured the database concurrently with the immediate UI
checkpoint. In library 1, artist 40, two same-title/same-year (1988)/same-edition
(null) albums existed: year-key album 129 held 3 tracks and base-key album 401
held 13. All file cache years and album artists matched. The temporary source
album 402 was empty. The final HTTP response already reported completed.
Earlier post-checkpoint sampling saw the later 16-track base album and empty
year-key row, demonstrating why sampling only after the screenshot was too late.

The targeted album rename selects the exact year-key destination. Existing
semantic reconciliation excludes every explicitly separated release, leaving
the semantically identical base destination separate. The fix opts explicit
album-name mutations into targeted same-year/edition reconciliation. Global
reconciliation and year-only mutations keep their previous separate-release
behavior. The opt-in cannot run without target album identities.

## Evidence

- Native first reproduction: `task9-identity-merge-replay-1.stdout.log` (0/1).
- Immediate database evidence: fourth trace under temporary root
  `album-haven-functional-local-ea07f2c63826-gallery_search_visual`, attachment
  `immediate-postgres-identity`, resource
  `2bd1281ebdfc7d8ead4c422719156eddb66427c2`.
- Fourth native run passed immediate and 20-second UI checks but failed the
  persisted identity count: [129, 401] instead of one identity. It is not green.
- Third diagnostic had a test-only SQL column error; it is not product evidence.
  Corrected SQL subsequently passed EXPLAIN in an explicit read-only transaction
  against the preserved manual Settings database, followed by ROLLBACK.
- Actual live-PG album rename regression: `task9-identity-python-red.log`,
  expected one 16-track row but received 13+3, 1 failed in 2.84 s.
- Focused fixed regression: `task9-identity-python-green.log`, 1 passed in 2.53 s.
  The test also retains different-year and Deluxe-edition albums, original track
  identities, and the separate-release rule.
- Complete related file: `task9-identity-python-related.log`, 45 passed in 4.73 s.
  Existing year-only/global separate behavior, new no-target guards, and commit
  ordering pass. The first related run found one test double with an outdated
  signature; it now explicitly checks the album-merge opt-in while retaining its
  original ordering assertions. First-run evidence is preserved separately.

All four browser waves and the focused PG waves completed normal owned database
teardown; their audited process trees, task ports, and database markers are clear.
Optional browser instrumentation was removed from the spec. Diagnostic artifacts
remain only under `.codex-restart` and retained temporary traces.

## Remaining checks

Run the uninstrumented native FTC-TAGS-021 case after the root agent's fixture
cleanup repair. No native passing claim is made yet.
