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

### Approved complete outcome recording

Owner approved the proposed Problematic Files categories and shared-browsing
safety guard, and explicitly requires the next cover pass to record fast-job
reasons as well as slow jobs. Narrow delivery: one structured final event for
every completed cover job using the existing private logging seam, with job
identity, terminal category, reason, provider trace and elapsed time. Record after
recovery/conflict classification so the event describes the final result. Preserve
existing cover decisions, counters, authentication and Postgres data authority;
do not introduce file-backed application state. Acceptance covers fast download,
failed and skipped jobs plus recovery-conflict final reason. Focused RED/GREEN,
two scoped reviews, then commit and full CI; deployment/retry remain separately
verified operations. Rollback is source-only.

Implemented `Cover fetch outcome` after per-job recovery/application, retaining
legacy slow/warning events and unchanged counter semantics. Five regressions
failed before implementation; 50 focused executor/recovery cases passed afterward
in 7.95 seconds (45 unrelated cases deselected). Fast download/failure/skip and
provider-disabled results each have exactly one final event; recovery conflicts
log their final reason. Two complete root scoped reviews found no remaining
findings. No deployment or retry yet. Total implementation/process time was not
recorded. Deployment must retain INFO-level private logs for the complete pass.

### Outcome accounting and request-error follow-up

The retained completion messages reconcile exactly to 7,936 unique jobs:
4,705 downloaded, 2,740 skipped, and 491 failed. Structured per-job evidence
attributes the 2,519 timeout outcomes to 371 failed and 2,148 skipped jobs;
the 79 no-candidate outcomes comprise 36 failed and 43 skipped jobs. These
dimensions must not be added together. Remaining attribution is under audit;
provider-attempt counts alone cannot classify the remaining failed albums.

Spotify HTTP classification is a separate narrow bug-fix candidate: automatic
request handling currently raises search failure for rate-limit/server/network
errors but returns no result for other HTTP errors. Reproduce whether rejected
requests or authorization errors can become a false no-match before changing
that boundary. Acceptance: HTTP failures remain incomplete searches, a valid
empty response remains no-match, and existing manual behavior, provider fallback,
deadlines and retry count are preserved. Use transport-stub focused regressions,
two scoped reviews and a separate commit; no live retry or publication implied.

Edition compatibility investigation confirms that historical app-written MP3
editions and external track subtitles both use TIT3. Raw tags cannot distinguish
their authorship. Native non-ID3 VERSION values and explicit edition tags must
remain intact. Do not globally strip TIT3 or merge persisted catalog identities;
the exact affected-record repair and future inference policy remain design-gated.

### Nine-folder diagnosis and proposed repair

Read-only audit inspected all 107 indexed paths in the nine rejected folders;
all paths exist and none of their cache rows is stale. Private per-folder proof:
`album-haven-internal/tmp/nine-cover-folder-audit-20261004.md`.

- Three catalog identity defects: Art Zoyd's Le Mariage uses each track's TIT3
  subtitle as an album edition; I Monster's Neveroddoreven uses two track-remix
  subtitles; Art Zoyd's Symphonie uses TSST disc/set subtitles despite matching
  album tags and MusicBrainz album ID. These are not duplicate physical albums.
- Three genuine tag conflicts: Pepel/Pesni dlya radio share a folder; Apollo 13
  includes one Apollo 13 Score track and conflicting years; The Mask Of Zorro
  includes one track tagged Tina Arena / In Deep. Do not rewrite these tags or
  infer that a combined release is incorrect without owner review.
- Three missing/empty-file splits: Archspire has two valid nonempty MP3s with
  no tags; Deep Forest's Comparsa and Pacifique each include one physically
  present zero-byte alternate filename, alongside the tagged original files.

The folder planner selects one identity for all tracks in a physical folder.
Targeted persistence rejects multiple authoritative album IDs before invoking
the physical artwork commit callback. This is a local identity/persistence
failure, not a provider no-match. Preserve the guard; per-album jobs sharing the
same cover filename would still overwrite one another.

Current Problematic Files has no cross-album folder-identity reason. Exact live
account-scoped flags/exclusions were not queried and remain unverified.

Proposed design, awaiting exact owner approval: correct edition interpretation
without losing genuine existing editions; expose Empty audio file and Mixed
album metadata in one folder through existing Problematic Files surfaces and
permissions; reject ambiguous destinations before provider calls. Do not delete
files, rewrite music tags or merge catalog records as part of diagnosis.
Existing edition writes use the version tag, so compatibility must be designed
before removing subtitle/version fallbacks. A targeted catalog repair requires
its own reviewed scope and retained pre-change evidence. No product or data fix
has yet been applied for these nine cases; existing checkboxes remain unchanged.

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

## October 5 request-error evidence

Follow-up exact-folder verbose-log audit recovered 27 of the original 65 missing
job reasons: 16 remote-not-better, six local-noncover-better, and five negative-cache
TTL results. Two of those cached misses were failed Swan Lake CD2/CD3 jobs with
an explicit 12-hour TTL. Current unrecorded final reasons: 11 failed and 27 skipped.
The original structured-only counts below are retained as historical evidence.
All 63 attributed provider failures have Spotify failed and four other providers
no-candidate; cooldown evidence is uniquely folder-attributable for 43 identities
and shared across same-identity folders for 20. All four failed exceptions are
inventory guards (Archspire, Art Zoyd Symphonie, Apollo 13, Mask Of Zorro), not
read-only replacements. Four explicit protected-cover outcomes had candidates
but no returned local cover; remote versus missing/inaccessible user selection
still needs read-only persistence inspection. Never override that protection.

Private log audit reconciles all completion identities and preserves exact source
lines in `album-haven-internal/tmp/cover-run-audit-20261004/REPORT.md` and adjacent
diagnostic artifacts. Within the 491 failed jobs: 371 timeout, 63 provider error,
36 no-candidate, four exceptions, four protected-cover improvement outcomes, and
13 unretained individual reasons. Slow-only detailed logging leaves 65 fast jobs
without exact reason attribution (13 failed, 52 skipped). Do not guess those
reasons from adjacent interleaved provider messages.

Deezer returned 10,035 successful search responses but 4,219 artwork HTTP403s,
all at synthesized 2000-pixel URLs. A bounded header-only check of one exact
logged artwork confirmed 403 at 2000 pixels and 200/image/jpeg at 1000 pixels.
The automatic single-cover path discards the provider URL in favor of the
synthesized URL with no fallback. The automatic path now uses the supplied
highest existing cover URL; manual synthesis and existing image-quality/identity
checks remain unchanged. The regression failed before the fix (one failure,
1.87 seconds); all nine Deezer tests then passed in 1.15 seconds. The exact test
process audit was clear. Root and independent complete scoped reviews found no
remaining findings; this is not a deployed fix or operational retry result.

Spotify recorded one quota-exhausted HTTP429 and 2,805 cooldown skips, not 2,805
HTTP failures. The retained log omits the actual Retry-After header. A separate
classification regression reproduced four automatic failures: HTTP400/401/403/404
were returned as empty results. The narrow correction raises the existing
automatic-search failure for all request errors; manual behavior, timeout and
429 cooldown handling remain unchanged. Focused verification: four RED failures
with 21 controls passing, then 75 passing Spotify/deadline cases. Two independent
scoped review passes found no remaining findings. Not yet deployed or retried.

Shared HTTP investigation reproduced the same false-negative boundary for
automatic denied requests and Apple API errors. The responsible HTTP handler
now raises the existing search-failure signal for 401/403, and for Apple API
client errors identified by existing caller-owned search/artist API contexts.
Expected Bandcamp discovery and alternate-artwork 404/410 misses remain empty;
manual behavior, existing timeout/429/server-error handling and retry counts are
unchanged. The transport-stub regression produced 24 expected RED failures with
25 compatibility controls passing. Focused HTTP/deadline verification then passed
111 tests in 10.67 seconds; the test process exited. Two complete root scoped
reviews traced actual Apple caller contexts, error propagation and compatibility
controls without remaining findings. No provider traffic or deployment occurred.

The private targeted-retry inventory offers 2,930 conservative review targets:
2,820 directly mapped incomplete/error outcomes, all 65 fast jobs whose exact
reason was unretained, and 45 additional retained-cover jobs with uniquely linked
Deezer artwork403 evidence. The 79 no-candidate jobs lack explicit Deezer403
linkage; prior negative-cache effects are unknown. This inventory is diagnostic
evidence, not a runnable authorization marker; revalidate current ownership,
catalog identities and manual selections before retry. No new pass has started.

## Bandcamp scheduling evidence (retained)

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
