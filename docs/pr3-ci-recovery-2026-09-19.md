# PR 3 CI recovery — September 19, 2026

## Destination and provenance

The owner requested recovery of the pending patches onto the existing
`2026-09-08-settings-refactor` branch, followed by complete native CI. No helper
branch is merged, and no merge, release or manual acceptance is authorized.
The original verified head was `ff81ffd4e846fa6606054b9d3b30dadffa4a6e18`.
The recovered application and E2E batch is present in
`a145d344e45248422aabff652e891df468baa2ac`; the reconciled seven-file follow-up
is `ac6fc5bb62603df90eb9e8148e6f9d8c545d940e`.

## Completed failure inventory

PR Gates #205, run `35430873883`, attempt 2, completed before the follow-up was
published. Its failed jobs were portable JavaScript `105865221141`, Windows
JavaScript `105865221126`, and playback/Utilities `105865221206`.
Python, components, Gallery/search/visual, metadata, cover providers, Auth,
Admin, production parity and the performance jobs passed on that candidate.

Direct GitHub API downloads retained in the helper branch under
`.chat-editor/pr205-proof` identify the remaining causes. Both JavaScript jobs
reported that discovery includes 68 component cases and 207 total cases while
the count regression still expected 67 and 206. The test-data ownership matrix
also lacked the new retained-canvas component case. Playback/Utilities reported
an over-expanded expected exclusion request and a neutral-Space helper that
focused a native navigation button. The direct evidence does not substantiate
the earlier chat log summaries about a loop-name leading space or a missing
`toHaveCSS` test stub. Those speculative changes were not published.

## Corrections and preserved acceptance

The request checker now expects one covering album rule, not redundant file
rules for the same reason. Independently selected file reasons and file-only
selections remain exact request assertions. The visible confirmation still
lists every highlighted problem; the original persistence, rollback, reload
and 18-row restoration assertions remain unchanged.

The neutral-Space helpers click the existing noninteractive track heading and
focus the document body before sending a real Space key. They no longer treat
NavigationTree's native button as a neutral shortcut target. All original
paused-state, ownership handoff, progress, PCM, repeat, pitch, node-identity and
focus-retention checks remain. The scenario files and application keyboard
handlers are unchanged. This follows the owning Settings plan's distinction
between native button activation and neutral/range playback shortcuts.

The new component's exact title is now registered in `test-data-matrix.json`.
The count test requires 68 component cases, 207 discovered cases and 207
ownership records; no discovered case is removed or skipped.

## Verification

New regressions first reproduced six helper failures on unchanged code, with
the existing file-only selection passing. After correction, all 37 focused
helper checks passed locally, and all 56 related playback runtime checks
passed. Production parity passed.

The publication executor checked the expected PR head, source Git blob hashes,
patch SHA-256 digests, all seven output hashes and the exact staged file list.
It then passed the affected helper and production-path tests, the real complete
discovery-count check and production parity before a non-force push. The
successful executor run is `35434361528`; it does not replace full PR Gates.

This commit emits a native synchronize event for the repaired branch. Full PR
Gates must finish on this head before reporting CI acceptance. The owner's
`skip_reviews` label remains unchanged; tests are not waived. No timeout,
retry, performance budget, approved screenshot baseline, fixture population,
permission or audio-engine behavior is relaxed. Final full-CI and manual
acceptance are not claimed by this document.

## Final repair pass after PR Gates 207

The complete PR Gates 207 run (`35434479136`) on
`b3283d2ac7a3dc7951196a9e611785de89a89e1c` finished before this repair.
Portable and Windows JavaScript failed the second pair of matrix-count checks
that still expected 206 instead of the actual 207 approved cases. Those two
checks now agree with the already-correct discovery and ownership inventories.
No case is removed, skipped or reclassified.

The completed playback/Utilities log exposed two scenario failures and one
runner failure. FTC-UTIL-PROBLEMS-001 reached the mobile Rules layout and found
Revert 14px from the row edge, outside its unchanged 12px top-right contract.
Only stacked mobile exclusion tables now use 10px row padding; desktop 10px/14px
padding and the original browser assertions remain unchanged.

The saved-loop Cancel helper attempted to activate controls that had folded
while the pointer was adjusting a range. The owning Settings plan B05 requires
that 500ms fold and immediate reveal when returning to Play. Save and Cancel now
use the existing native Play-hover reveal helper before their unchanged native
clicks. No force click, timer change, hidden-state success, selection reset or
persistence assertion was introduced. A browser probe using the real shared
control renderer confirmed fold, reveal, native cancellation and the idle state.

The I01 browser scenario passed but the runner failed during finalization.
The runner reparsed its accumulated output and synchronously enumerated Windows
processes on each late provider log, treating a cached result as a new lifecycle
transition. Lifecycle transitions are now handled once per authenticated phase.
All output and authenticated failures are still processed; original cleanup,
nonce checks, child-close requirements and finalization deadlines remain intact.
The new regression checks a burst of 400 ordinary output chunks, confirms one
process snapshot per phase and verifies that late failures still return failure.

Five new regressions reproduced four failures before implementation and all
passed after it. Focused browser geometry confirms 10px mobile insets and
unchanged desktop spacing. Local production parity passed. The Windows executor
`35450720857` passed the complete affected runner and fixture contract files,
37 related helper checks and production parity before publication. It verified
source/output hashes, patch checksum, the exact five-file inventory and the
unchanged destination head before a non-force push of
`f9402dd6ebbf1b00d00957f5e3d23dae8159f61a`.

A fresh complete PR Gates run is required on this promotion commit. This record
is not a full-CI, merge, release or manual-acceptance claim.
