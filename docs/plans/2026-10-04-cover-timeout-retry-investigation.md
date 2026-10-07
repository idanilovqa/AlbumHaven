# Cover timeout and retry investigation

Owner authorized investigation, fixes, and a targeted retry of unsuccessful cover
lookups. Never convert an incomplete provider search into a definitive no-match.

## Approved authoritative selected-cover propagation

Fix false failures where a valid authoritative selected image is in a parent CD
folder or another existing folder. Carry a distinct `selected_cover_path` from
one fresh batch canonical-selection read at cover-pass snapshot preparation,
through cover-job planning and the provider. The value is pass-only: do not store
a long-lived runtime hydration alias, because manual selections and cross-folder
album updates do not share one runtime publication seam. Reuse the scoped
Postgres read contract and refresh each pass, including fallback callers.
Do not repurpose physical track-file `cover_path`, add per-job database
queries, or change catalog identity. Decode an explicit selected image before
counting it as retained or comparing quality. Missing/corrupt explicit selections
remain missing; do not substitute unrelated folder artwork for them.

Regression scope: snapshot/physical-path separation, parent-CD and cross-folder
selection, valid retained outcomes, improved different artwork offered without
replacement, invalid selections, and unchanged mixed-album/concurrent-selection
guards. Use fixture files and fake persistence/transport only. Preserve existing
generation checks and guarded writes. Source-only rollback; focused RED/GREEN
and independent full-diff review before any commit. No live database/media,
deployment, push, commit or operational retry belongs to this slice.

Implementation uses one set-based adapter query per preparation, with deduplicated
positive album IDs, bootstrap-owner/library scope, live files and active roots.
Missing authority aborts preparation; an authoritative row with no cover remains
valid. `selected_cover_path` and `selected_cover_origin` exist only in the pass
snapshot. Physical path/origin/revision tuples remain unchanged and form the
concurrency baseline from preparation through result application. Changed
authority is explicitly reported; only a valid current selection may be retained.
Provider blocked-write, unsuccessful-write and exception exits cannot substitute
unrelated folder artwork for an invalid explicit selection.

Focused proof (2026-10-05): initial propagation RED 7 failures; concurrent-state
RED 3; blocked-write fallback RED 2; pass-snapshot RED 1; preparation-race,
origin-separation and exception regressions RED 5, then missing-authority RED 1.
Final focused verification: **108 passed, 197 deselected, 3 existing warnings in
7.48s**, exit 0, in the root's final verification (process/session 36831). This includes complete runtime/planning test files plus relevant
snapshot, provider, executor and recovery guards. No live provider, database or
media operations. Final independent full-diff review reported no remaining findings.

## Approved bounded Spotify cooldown retry

The owner approved one bounded deferred Spotify-only retry after ordinary jobs
finish. Preserve provider order and early acceptance. Immediately before a queued
Spotify transport sends, recheck the latest shared cooldown and retain its expiry.
Only unresolved, no-accepted-candidate outcomes explicitly dependent on that
cooldown enter the deferred set. Successful jobs and other provider work are not
repeated. At the deferred pass, eligible jobs get at most one Spotify-only retry;
future cooldowns remain explicitly deferred with their retry time. Never wait for
an arbitrarily distant expiry or keep the pass alive indefinitely.

Acceptance uses fake clocks and transport/provider stubs: queued-send race,
ordinary-before-deferred order, expiry extension, one retry maximum, no successful
job replay, selected-artwork protection, and one final counter/event per album.
A partial Spotify-only no-match cannot replace an incomplete whole-search cache
result; retain original resolver evidence. Reuse the current executor, cache and
guarded writer; no new durable worker, schema, UI or JSON persistence. Rollback is
source-only. Focused RED/GREEN and independent complete review precede any commit;
no live providers, database, deployment, operational retry or push is authorized
by this implementation unit.

Implementation steps (Python, current provider/executor interfaces):

- [x] Reproduce queued Spotify sends after a newly extended cooldown in
  `test_cover_provider_spotify.py`; add expiry-bearing failure classification
  in `cover_provider_spotify.py` and preserve manual no-result behavior.
- [x] Reproduce expiry propagation and Spotify-only search selection in provider
  tests; update `cover_refresh_provider.py` without changing normal resolver order
  or early acceptance. Carry initial incomplete trace into the partial retry so
  no negative whole-search result is written.
- [x] Reproduce bounded deferred execution, future-expiry reporting and exactly
  one final job result in `test_state.py`; update `cover_refresh_execution.py`
  with an in-memory deferred list processed only after the ordinary queue.
- [ ] Run focused tests sequentially, inspect complete diff twice, and hand off
  source/tests/documentation for independent review. Do not commit or push.

Focused evidence: queued-send regression failed before repair; Spotify tests then
passed 26/26. Provider/executor regressions reproduced missing expiry propagation
and deferred work. Review regressions reproduced lost first-429 quota logging,
manual queued-request incompatibility, and non-monotonic finalized progress (10
failures); all were repaired. A conclusive Spotify retry now supersedes only its
own earlier cooldown failure, copying the historical trace and retaining previous
status/reason/expiry. Other providers' incomplete outcomes remain authoritative;
only a genuinely complete all-provider no-match may populate the negative cache.
Final focused verification: 102 passed, 64 deselected, one existing Pillow
deprecation warning, 4.42 seconds. Serial/parallel jobs finalize exactly once;
new cooldowns after the single retry remain deferred with the latest expiry.
Transport and provider dependencies were stubbed. Final independent review is
pending; this is not operational retry evidence or release authorization.

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

## October 6 current-status reconciliation

This checkpoint supersedes earlier operational statements that no retry or
deployment had occurred. The historical evidence and unchecked gates above remain
unchanged. The October 5 retry ended with `worker_failed` and a `RuntimeError`:
235 recorded search/download results, including 61 downloads. The last progress
snapshot contained 232 results; queue position 664 does not measure completion.
The executor did not finish its selected queue, and no fresh retry has started.

The bounded read-only audit checked current database targets for those 235
results, including six multi-album targets, and decoded all 61 downloaded images
without failure. One apparent mismatch came from a two-disc album selecting its
second downloaded image album-wide. The album-scoped follow-up found no membership,
staleness, path or revision mismatch; scan-validation path differences invalidate
cache reuse without overriding the canonical selection. Lookup inspection covered
11,513 entries, including 1,681 negative entries. These checks establish scoped
current-state consistency and readable media. They do not establish historical
write attribution, final persistence for the original pass, or queue completion.

Source repairs now reject recovery across known distinct album IDs and log safe
stage/counter diagnostics before propagating genuine persistence errors. Focused
recovery verification passed 33 cases. The historical failure's exact guard
predicate remains unattributed; current consistency does not prove its cause.

The operator closed the terminal maintenance service and deployed the feature
worktree with uncommitted repairs to sandbox3 for shared browsing. No cover pass
is active. Local and public login checks returned the expected page, and
unauthenticated bootstrap checks returned 401. Authenticated gallery/search and
owner manual acceptance remain open. Production remains unchanged. This sandbox
handoff is a manual-test deployment, not a verified release or production promotion.

Counter regressions now specify additive `covers_completed`: one accepted terminal
result per selected physical-folder job, including download, failure and skip.
Deferred first attempts count zero; final settlement counts once. The denominator
remains selected jobs, while legacy `covers_processed` retains queue-position
semantics. Python and JavaScript tests cover explicit zero, legacy fallback,
out-of-order results and stale ownership. The earlier syntax-only checkpoint is
historical: implementation and focused RED/GREEN verification are complete,
including the background cover-generation guard and completed-search tooltip.
This counter measures accepted terminal search results, not durable persistence.
Browsing-enabled maintenance composition remains unimplemented; its prospective
safety tests are unrun, and composition approval and fresh-retry gates remain open.

Before another pass, record its exact authorized selection and recheck exclusive
writer ownership against current services, canonical selections and manual-cover
protection. Normal unsuccessful-cover selection is not the historical diagnostic
allowlist. Complete the remaining focused repairs and review, then require the
full native CI pipeline and applicable E2E/manual gates. Root-gallery performance
still fails its unchanged acceptance ceiling. No completion checkmark, release
authorization or fresh operational retry follows from this reconciliation.

## Approved cross-instance writer ownership (October 6)

The owner approved shared production Postgres/media across branch hostnames,
existing-task-table ownership, caller-generated tokens, no automatic takeover,
crash quiescence proof, and a compatible production rollout through normal gates.
Production must remain available for browsing. Routine production shutdown is
not the coordination model. This approval settles the ownership design;
implementation, acceptance and fresh-retry gates remain open.
No new external API, permission grant, UI or schema is part of the foundation.

### COORD-F: durable ownership foundation

Outcome: an internal Postgres repository can atomically reserve one library's
writer slot. This unit does not integrate writers or make shared operation safe.
Prerequisite: verify migration 0028's scoped unique index and runtime privileges
in the isolated test database; verify deployed compatibility before activation.

Create `music_app/services/library_operation_postgres.py` with
`PostgresLibraryOperationRepository(config, connect=...)`. Resolve the existing
bootstrap library from the configured database, as current repository adapters
do. Its internal interface is:

```python
claim(*, owner_token: str, owner_identity: dict, operation: str) -> bool
release(*, owner_token: str) -> bool
read_owner() -> dict | None
```

Use `ops.cover_lookup_tasks` with source family `library_writer_ownership_v1`
and constant task key `library-writer`. Store the token, operation and owner
identity in metadata; keep `album_key` and selected path null and provider payload
empty. Owner identity records host, PID, process-start identity and instance ID;
these are private diagnostic evidence, not credentials or a liveness oracle.
The existing library/source-family/task-key index owns uniqueness. Existing
notification cleanup excludes this family, and album-key remapping cannot match
its null album key. Do not reuse notification upserts or process-local revisions.

Claim uses one conditional insert/upsert: insert active ownership when absent,
or replace only an explicitly released row. An active row rejects every claim,
including the same token. Worker handoffs carry the token without reacquiring it.
Commit the short transaction before returning success. Release conditionally
marks only the active row with the matching token released; stale/missing tokens
return false. `read_owner` returns active ownership metadata or null. Do not add
expiry predicates, timeout takeover, process-local authority or a long-held DB
transaction. Reject empty tokens/operation and incomplete owner identity.
Require a positive integer PID (not a boolean), and reject invalid release tokens
before opening a connection. Missing bootstrap-library context raises an explicit
error for claim, release and read; it must not look like contention or an empty slot.

Database failures propagate without starting work or clearing ownership. If
commit acknowledgement is lost, the caller reads through a new connection and
compares its already-generated token before deciding whether it owns the slot.
An inconclusive read blocks work. Connection loss after a successful claim leaves
the durable active row intact. Only explicit release permits another writer.

- [x] COORD-F1: Author and observe failing repository tests for competing claims,
  release/reclaim, stale-token rejection, namespace isolation, old active rows,
  and lost commit acknowledgement. Use isolated Postgres only.
- [x] COORD-F2: Implement the repository with short parameterized transactions;
  pass the same focused tests and inspect the complete diff twice.
- [ ] COORD-F3: Complete independent review and required full native CI; record
  its separate merge/publish checkpoint. Keep runtime activation absent.

Compatibility/rollback: no schema changes, no callers until integration, no
notification behavior change. Revert the unused source module to roll back the
foundation. Do not delete an active ownership row as a rollback shortcut.
Author tests in `tests/py/test_library_operation_postgres.py`; run only after
the root grants the global pytest lane:
`rtk python -m pytest tests/py/test_library_operation_postgres.py -q`.
Missing isolated database configuration is a setup prerequisite, not a pass.

October 6 focused foundation evidence: the dedicated isolated Postgres run first
observed all 29 cases RED in 6.43 seconds with the implementation absent. After
adding the 117-line repository, the same 29 cases passed in 12.70 seconds with
zero skips and native pytest/launcher exit 0, verified by the root against stdout.
Two complete local review passes covered the entire source and test files,
approved ownership contract, migration 0028 conflict index, notification cleanup,
validation, short transactions, lost commit acknowledgement, stale release and
fixture isolation. Both passes found no validated findings; no review edits or
additional test execution occurred. This closes COORD-F1/F2 only. COORD-F3's
required full native CI and separate merge/publish checkpoint remain open; there
was no new commit or push during focused verification. The foundation remains unused, and every COORD-I
integration, acceptance, rollout and activation gate remains open.

### COORD-I: complete writer integration and safe activation

Outcome: one accepted operation owns all of its media/catalog mutations while
other instances continue browsing. Depends on COORD-F and the complete writer
inventory below. This vertical slice must not expose a partially protected path.

- [ ] COORD-I1: Acquire before snapshot preparation or file effects in scan
  admission, cover refresh/lookup, cover selection/fetch/delete/link, tag edits,
  structural moves/repairs, root import/change/removal and catalog mutations.
  Trace shared services as well as routes; keep existing permission checks.
- [ ] COORD-I2: Cover startup tag-intent recovery, legacy exclusion migration,
  relation-projection readiness/rebuild, automatic/cold scans, watcher and targeted
  reconciliation. Defer background work while busy; do not drop required repairs.
- [ ] COORD-I3: Carry the same token through executor children and scan-to-cover
  followups. Release only after all workers and commit/rollback finish. A local
  cancellation flag, HTTP completion or `shutdown(wait=False)` is insufficient.
  Reject competing writes as busy without blocking read-only browsing.
- [ ] COORD-I4: Preserve publication transaction locks, generation checks and
  local folder guards. Never hold the inventory-publication advisory key on an
  owner connection while a child connection needs that same key.
- [ ] COORD-I5: Prove crash recovery against exact host/PID/start identity and all
  owned descendants. Heartbeats are diagnostic only. If death/quiescence cannot
  be proved, keep the record active. Reconcile filesystem/tag intents before an
  operator-authorized token-conditional release; do not expose blanket unlock.
- [ ] COORD-I6: Test two instances, startup/background writers, chained workers,
  disconnect, cancellation with surviving children, crash recovery and browsing
  during contention. Complete owner manual acceptance and applicable E2E gates.
- [ ] COORD-I7: Release coordinated production through normal review/full CI/
  merge/publish/deployment verification before enabling sandbox writers. Verify
  older branches are browse-only with startup/background writes suppressed.
  Reconcile deployment-runbook shared-browse guidance with this approved model.
- [ ] COORD-I8: Verify the published build and current service ownership, then
  separately record the exact authorized retry selection and manual-cover guards.

Old production does not participate in this protocol. Installing the foundation
or protecting only sandbox routes cannot exclude its background writers. During
rollback, disable new writer admission and prove the current operation quiescent
before restoring an uncoordinated build; keep other shared writers disabled.
Retain active rows on uncertainty. No foundation checkpoint authorizes production
promotion, cross-instance media writes or a fresh cover pass. No existing
operational checkbox is closed by this design; this plan has no numeric counter.

### COORD-I lifecycle intake: source inspection only (October 6)

Read-only lifecycle intake is complete for the release conditions below. This is
source-inspection evidence, not implemented coordination or verified runtime
safety. Existing COORD-I acceptance and rollout gates remain open.

A finished Future is not sufficient release evidence: save-task finalizers and
cover workers can catch failures and return normally. Integration must distinguish
worker settlement from durable operation success. Release only after every
accepted child has settled and persistence/publication is confirmed, or required
compensation is proven complete. HTTP completion, cancellation flags and
`runtime_shutdown` using `shutdown(wait=False)` do not establish settlement.

Carry the same ownership token through scan-to-cover followups, save-task
finalizers, the move executor and targeted reconciliation. The parent remains
responsible for all accepted descendants; a child must not independently release
the operation's slot merely because its own Future finished.

Retain ownership on lost commit acknowledgement, uncertain rollback, journal
failure, partial filesystem mutation, outstanding children or publication
failure. These states require outcome reconciliation and the approved explicit
recovery process, not automatic takeover or unconditional release in a completion
callback. Preserve existing transaction, generation and filesystem guards.

No implementation, tests, database/media operations or service changes were
performed for this intake. It does not authorize activation, production rollout,
a fresh cover pass or closure of any checklist item.

### COORD-I cover admission map (October 6, implementation pending)

Source inspection identifies the following boundaries for COORD-I1/I3. The
implementation must protect service callers as well as authenticated routes.

| Entry | Existing service boundary | Required ownership handoff |
| --- | --- | --- |
| Bulk UI `/utilities/fetch-covers-unsuccessful` in `api_wave_d_asgi_routes.py` | `cover_refresh_runtime.start_manual_cover_refresh_request` / `start_manual_cover_refresh` | Claim before snapshot preparation; carry ownership with the prepared context and submitted worker. |
| Single-album UI `/utilities/fetch-cover` | `state.refresh_cover_artwork_for_track_paths_for_state` / `cover_refresh_runtime.refresh_cover_artwork_for_track_paths_request` | Apply the same claim before planning or file effects. |
| Background cover work | `cover_refresh_runtime.start_background_cover_refresh_request` / `start_background_cover_refresh` | Inherit an existing scan token or claim before accepting work. |
| Direct refresh callers | `cover_refresh_runtime.refresh_cover_artwork_request` / `refresh_unsuccessful_cover_artwork_request` | Require the ownership context even without an HTTP request. |
| Scan-to-cover followup | `state.refresh_library_for_state` and `scan_state.refresh_library_state` callbacks | Retain the scan token through queued cover work; do not release and reacquire between phases. |

Current admission functions discard submitted Futures. The background/manual
worker wrappers catch exceptions and update status, so a successful Future alone
cannot authorize release. Track accepted work and propagate its durable result.
Release with the matching token only after child settlement, required provider
outcome persistence, cache/publication commit, and proven recovery or rollback.
Cancellation currently changes a local generation; it must not release ownership
while accepted children remain. Preparation or submission rejection permits
release only after proving that no accepted work or uncertain effect remains.
Retain the active row after uncertain commits or incomplete compensation.

Focused acceptance must cover two-instance contention; direct, single, bulk and
background entrypoints; scan-to-cover continuity; preparation/submission failure;
empty queues and persisted no-candidate success; accepted-child persistence
failure; cancellation/disconnect with surviving children; wrong-token release;
uncertain commit retention; and browsing during contention. Extend the existing
state, cover-runtime/API and ownership-repository tests. These are pending cases,
not executed safety evidence.

Cover wiring alone cannot activate shared writes. Other cover mutation routes
(`local-select`, `local-delete`, `pasted-image-save`, `save-remote`, `add-remote`),
lookup workers, tags, moves, repairs, roots, catalog changes, watcher work,
startup recovery, scans and relation rebuilds remain in the COORD-I inventory.
Keep `SHARED_LIBRARY_BROWSE_ONLY` protections until that inventory, coordinated
production rollout and compatibility checks pass. This intake changes no
permission model, deployment state, rollback rule or COORD checklist status.

Manual Move design belongs to the private
`docs/future-feature-plans/library-roots-and-arrivals-plan.md` and the app's
`docs/superpowers/plans/2026-09-23-multi-root-libraries.md`. Those plans record the
owner-only frontend/server restriction and right-click entry. This cover intake
does not implement Move or waive its design, mockup and acceptance gates.


## October 6 accepted-outcome drain and mixed-folder verification

This checkpoint supersedes the earlier bare-raise and unrun accepted-result
notes for these scoped repairs. The executor now retains the first mandatory
provider-outcome persistence exception, attempts persistence for accepted parallel
and deferred results, stops new sequential admission and deferred provider retries,
and raises before final cache/publication completion. Drain-only handling avoids
new selection recovery. Candidate snapshots retain their best-effort contract.

Mixed physical folders with multiple positive canonical album IDs now receive one
explicit `mixed_album_folder` terminal result before candidate initialization or
provider dispatch. Their existing artwork and track selections remain unchanged.
A review found that the local rejection also set the run-wide publication-conflict
flag, suppressing valid clearing for an unrelated album. The failing regression
proved that missing snapshot; the repair separates local rejection from genuine
concurrent-selection conflicts without relaxing the existing publication guards.

Retained evidence under `C:/temp/pr22-local-1855858`:

- `cover-outcome-settlement-red-v2`: 3 failed, 2 passed; accepted sibling outcome
  attempts were missing. The drain repair then passed all 5 selected cases.
- `cover-mixed-folder-red-v1`: 1 failed, 1 passed; mixed identity reached the
  provider. `cover-mixed-folder-green-v1`: both cases passed after the guard.
- `cover-mixed-folder-related-red-v1`: 8 passed, 1 failed at independent snapshot
  publication. `cover-mixed-folder-related-green-v1`: 9 passed in 2.43 seconds.
- `cover-outcome-settlement-green-v4`: all 5 provider-settlement cases passed
  against the combined source in 2.81 seconds, 134 deselected.

Each prefix retains stdout, stderr and native exit evidence. The root verified
expected RED exit 1, GREEN exit 0, stderr and exact owned-process cleanup. Drain
review pass 1 found no finding; author/root review found the cross-job issue above
and required its RED/fix/GREEN cycle. The combined independent pass 2 found no
remaining validated finding. These scoped results do not establish whole-branch
acceptance.

Failure statistics and outer worker-wrapper propagation still need reconciliation;
finished Futures alone do not prove durable success. COORD integration/activation,
verified operational retry, deployment of these repairs, owner manual acceptance,
remaining CI repairs and the full pipeline remain open. No tests, source changes,
service/database/media actions, push or cover pass occurred while recording this
checkpoint.

## October 6 owner-requested checkpoint and pause

The owner requested committing pending work and pausing. This is an unfinished
checkpoint, not a verified release. Retained focused evidence records observer
83/83 GREEN and cover outcome reporting 7/7 GREEN, with native exit 0 and owned
process cleanup. Subsequent wrapper propagation tests produced 13 failures and
3 passes before the source repair. Original-exception propagation and identity,
cover-generation and scan-generation guards are implemented but not yet verified.

Independent review identified the background check/write locking gap. Three new
lock regressions are authored but unrun; lock wiring is NOT implemented. The
19-case wrapper selection remains pending. No further tests were run for this
checkpoint. Preserve these failing/unverified states when resuming; do not claim
the wrapper or whole-operation lifecycle complete.

The unchanged native family E2E rerun, full CI, deployment of current repairs,
owner acceptance, authorized cover retry, and all COORD integration/activation
gates remain open. No push, deployment, new cover pass, or gate waiver accompanies
this checkpoint commit.

## October 6 background worker lock verification

This supersedes the preceding unverified wrapper-lock checkpoint only. Background
workers now capture ownership and perform the identity/cover-generation/
scan-generation failure check and status update under the supplied cache lock.
The refresh callback runs outside the lock; normal state wiring supplies
`_CACHE_LOCK`. Original exceptions still propagate, and success behavior is unchanged.

Retained evidence in `C:/temp/pr22-local-1855858`: `cover-worker-lock-red-v1`
records 3 failed and 16 passed in 4.12 seconds, native exit 1. After repair,
`cover-worker-lock-green-v1` records the complete cover-runtime file: 48 passed
in 3.08 seconds, native exit 0. Both prefixes retain stdout, stderr, exit and
process-audit artifacts. The root verified the evidence; two independent full
scoped reviews found no validated findings. No tests were rerun for this commit.

Scan failure propagation and accepted-child/whole-operation coordination remain
pending. This scoped commit does not enable UI scans or shared writers, deploy a
build, start a cover pass, complete CI, or close COORD/release/acceptance gates.

## October 6 scan worker failure propagation

Genuine scan execution and publication errors now propagate after guarded failure
reporting. Handled cancellation/supersession, stale-generation protection, cleanup
and best-effort hooks remain unchanged. This supersedes only the pending scan
propagation statement above.

Retained evidence in `C:/temp/pr22-local-1855858`: the
`scan-worker-propagation-red-v1` selection recorded 8 failed and 5 passed in
4.03 seconds, native exit 1; `scan-worker-propagation-green-v1` recorded the
complete scan-state file: 43 passed in 10.17 seconds, native exit 0. The root
verified both results; two scoped reviews found no findings. No tests were rerun
for this commit. Cover-runtime 48-case and scan-state 43-case local proof does
not establish accepted-child/whole-operation durability, shared-writer integration,
UI activation, deployment, full CI success or completion of any COORD/release gate.
