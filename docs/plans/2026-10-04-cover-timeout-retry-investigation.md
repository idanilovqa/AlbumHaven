# Cover timeout and retry investigation

Owner authorized investigation, fixes, and a targeted retry of unsuccessful cover
lookups. Never convert an incomplete provider search into a definitive no-match.

## Evidence and delivery boundary

The October 3 executor completed 7,936 jobs: 4,705 downloads, 2,740 retained-cover
results, and 491 missing-cover results. Of 2,519 timeout outcomes, 2,518 include
Bandcamp. Spotify recorded quota exhaustion and subsequent cooldown skips.
The 36 exceptions comprise 27 access-denied replacements and nine inventory
persistence mismatches; underlying causes still require investigation.

First delivery: prevent known-account Bandcamp catalog discovery from waiting
behind unrelated MusicBrainz discovery in automatic searches. This advances
Task 2 of the fast-automatic-cover-search plan, not its overall completion.

- Prerequisite: reproduce starvation with a stalled MusicBrainz dependency.
- Acceptance: a valid catalog candidate is reachable before the same deadline;
  exhausted/incomplete discovery remains retryable; manual behavior and identity
  validation remain unchanged; no duplicate automatic catalog probes.
- Compatibility: retain provider interfaces, absolute budgets, selected-cover
  protection, and existing persistence authorities. Rollback is source-only.
- Checkpoint: failing regression, focused verification, two complete scoped
  reviews, then scoped commit; no publication or release-gate waiver.

## Pending

MusicBrainz follow-up delivery: reproduce stale automatic request timeouts after
queue/rate-slot waits and retries, then re-clamp each request to the existing
absolute budget. Make automatic slot/backoff waits cancellation-aware without
adding retries or changing manual request policy. Acceptance uses deterministic
fake clocks and transport stubs, checks timeout propagation and no negative cache
on deadline/cancellation, then focused tests and independent scoped review.
Compatibility/rollback: unchanged public call contract and manual timeout/retry
behavior; source-only rollback. No operational retry belongs to this slice.

- [x] Reproduce and fix independent catalog starvation (focused verification and
  two complete scoped review passes; operational measurement still pending).
- [x] Verify remaining MusicBrainz timeout after queue/backoff waits (focused
  repair and two complete scoped review passes).
- [ ] Diagnose file replacement and inventory mismatch causes.
- [ ] Verify original persisted cover and lookup outcomes.
- [ ] Establish exclusive writer ownership using current service state.
- [ ] Run only the authorized unresolved retry set and audit outcomes.

The original completion event explicitly leaves persistence unverified. A database
read found 14,709 albums, 14,170 nonempty cover paths, 159,550 file rows (five stale),
and one automatic candidate snapshot still marked running. These aggregate counts
are not proof of successful per-album persistence or file existence. Production and
maintenance service state must be checked afresh before a retry.

## Bandcamp scheduling evidence

The automatic direct-account worker previously stopped after guessed album URLs;
catalog discovery waited for both that worker and MusicBrainz. A stalled
MusicBrainz dependency consumed the deadline before the known account homepage
could expose a title-preserving alternate slug. The regression failed because
the catalog was never requested; the manual cancellation control passed.

The direct worker now continues into its known-account catalogs for automatic
searches only, under the unchanged cancellation/deadline. The later fallback
does not repeat visited catalogs. Identity validation and provider outcome
classification are unchanged. An initial test fixture used an unrelated slug
and was correctly rejected; the final fixture uses `test-album-2`.

Focused checks on October 4:

- `test_cover_provider_bandcamp.py`: 36 passed, 2.69 seconds. Cases cover
  automatic/manual, stalled/completed discovery, candidate/no candidate, and
  absence of duplicate known-account catalog requests.
- `test_cover_refresh_provider.py -k 'timeout or deadline or bandcamp or negative'`:
  7 passed, 23 deselected, 1.71 seconds.

This proves the scheduling defect and focused repair, not the fraction of the
2,518 observed Bandcamp timeouts attributable to it or live retry throughput.
No provider requests, deployment changes, or data mutations were performed by
these tests.

## MusicBrainz budget evidence

Deterministic regressions reproduced five failures: a five-second request timeout
remained five seconds after two seconds spent waiting for the request lock or
rate slot; retry reused five seconds despite 1.75 seconds elapsed; cancellation
during slot/backoff waits was delayed by their whole two/0.75-second sleep.
Seven existing/manual control cases passed on the unmodified implementation.

Each request now re-clamps its timeout immediately before transport invocation.
Automatic slot/backoff sleeps check cancellation in bounded intervals and stop
at the existing absolute deadline; manual sleeps, retry count, and cooldown
policy are unchanged. Deadline exceptions escape without negative-cache writes.
Focused MusicBrainz tests initially passed 12/12; added coverage checks all three
existing retry exception branches and deadline exhaustion without negative
caching. The combined MusicBrainz HTTP, CAA, Bandcamp, and automatic-provider
test command exited successfully. No live network traffic was used.

The global request lock still serializes transport calls; this slice does not
redesign lock ownership or claim that blocked lock acquisition itself is now
interruptible. Once admitted, automatic work cannot start a request with a stale
pre-wait budget.

Review follow-up: the final exhausted transport attempt could still negative-cache
after consuming the deadline when no cancellation callback was supplied. A
six-case regression reproduced three automatic failures with three manual
controls passing (network error, HTTP 503, and generic transport/payload error).
Each terminal exception path now checks remaining automatic budget before its
negative-cache write. The complete MusicBrainz HTTP test file passed 24 tests in
0.83 seconds after this repair; manual terminal caching remains unchanged.

Combined independent verification: 152 passed in 9.94 seconds across Bandcamp,
MusicBrainz HTTP, remote-cover HTTP, automatic deadline, and cover-refresh
provider tests. Two existing Pillow getdata deprecation warnings remain. Both
slices received two full scoped review passes; the first HTTP review found the
terminal negative-cache issue above, which was reproduced and fixed before the
second pass. No remaining scoped findings. This is not whole-branch acceptance.
Two initial verification commands referenced nonexistent test filenames and ran
no tests; the corrected existing-file command supplied the evidence above.
Only the two implementation checkboxes are complete; no numeric progress counter
exists. Operational audit and retry remain pending, recorded in private OPERATION.md.
