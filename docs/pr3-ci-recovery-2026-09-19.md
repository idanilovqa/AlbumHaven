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
