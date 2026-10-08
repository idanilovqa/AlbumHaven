# Automatic cover progress and Spotify quota cutoff

## Owner-approved outcome

After the first Spotify HTTP 429 in an automatic run, skip Spotify for every
subsequent album in that run. Do not queue Spotify retries. Other providers
continue. Count each album exactly once after its ordinary search finishes.
Show a separate subline: “Spotify quota reached — skipped for this run”.
Persist “Spotify cover search quota exceeded” against only the triggering album
in Problematic Files, alongside “Missing cover art” when applicable.

This final owner decision supersedes the earlier proposed retry backlog,
parallel retry worker, and permanent automatic-provider exclusion. Manual Spotify
lookup remains available. New runs respect any still-active shared cooldown;
they may use Spotify again after that cooldown expires. A cooldown observed by
another in-flight worker must not blame that worker's album.

## Evidence

Sandbox3 reached queue item 2488 of 3353 after about 497 minutes (5 albums/minute),
while only 754 outcomes appeared completed. Spotify returned HTTP 429,
QUOTA_EXCEEDED, and an approximately 81,305-second cooldown. Deferred outcomes
were excluded from the displayed checked count and inflated the ETA.

## Delivery DCP-1

Prerequisites: existing automatic provider ordering, Spotify transport cooldown,
guarded cover writes, completed-album counters and Postgres provider outcomes.

Acceptance cases:
- First actual quota response stops Spotify for the entire run; other providers
  continue even after the cooldown would expire.
- Serial and parallel album workers share the cutoff; only the first actual
  quota response creates a quota problem. Passive cooldown observers do not.
- No Spotify retry queue, second attempt, or retry counters remain.
- Every album finalizes once; skipped Spotify calls do not reduce checked count.
- The existing ETA uses ordinary completed albums; the quota notice is a subline.
- New run startup clears the prior UI notice; generation checks protect newer runs.
- Problematic Files summary and detail show the durable quota problem, retain
  missing-cover problems, and clear the quota problem after a later successful
  Spotify search or conclusive no-candidate response.
- Existing manual Spotify behavior remains covered.

Implementation reuses the existing executor and Postgres operations table.
One run-scoped cutoff object coordinates workers. No schema, provider pacing,
permission, component layout, or credential changes are needed. The existing
status payload gains one boolean; old clients and servers remain compatible.
Rollback is source-only. Preserve all unrelated uncommitted changes.

Checkpoint: focused automated tests, real isolated-Postgres verification, two
complete scoped review passes, then safe activation. This debugging task does not
authorize publication of the accumulated branch. Backend activation must preserve
the current search; do not restart an active worker solely to change its display.

## Verification

- Final focused provider, executor, progress, runtime, Spotify/manual registry and
  deadline verification: 352 passed in 22.16 seconds. Existing Pillow deprecation
  warnings remain.
- Final JavaScript progress/status/ownership verification: 66 passed.
- Quota problem projection: 4 passed in 20.43 seconds, including two real
  isolated-Postgres cases (with and without existing artwork). Tests own the
  dedicated fake E2E database lock and use its migrator/runtime roles. They verify
  durable outcomes, summary/detail reads, cache invalidation and recovery clearing.
- A wider relevant Python selection produced 658 passes and two unrelated failures:
  test_postgres_root_sidebar_reads_one_repeatable_read_snapshot_and_rolls_it_back
  and test_postgres_search_batch_loads_private_album_rating_overlays. Both failures
  were reproduced after removing this task's browse modifications in memory in a
  separate test process; on-disk user changes were preserved. They are not waived.
- Two complete scoped review passes completed. Review found and repaired concurrent
  quota attribution and album-scope problem projection. Final reconciliation found
  no remaining findings in this correction.
- Runtime bundle rebuilt from 77 modules; JavaScript syntax and git diff whitespace
  checks pass. Sandbox3 serves the bundle with the quota notice (HTTP 200).
- No backend restart, live provider request, production mutation, commit, push,
  merge or publication. Sandbox3 PID 10152 remains the active old-code worker;
  its queue reached approximately 2648/3353 during verification. Safe backend
  activation and live manual acceptance remain pending.
- Manual acceptance after activation: start an ordinary automatic cover run with
  available Spotify quota. On its first 429, verify the quota subline, increasing
  album progress and continuing non-Spotify lookups. Verify the triggering album's
  Problematic Files error; subsequent albums must not acquire that error merely
  because Spotify was skipped. Do not generate live quota traffic solely to test.
