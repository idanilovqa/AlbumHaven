# Album folder membership and cover integrity

Owner-approved repair, October 7, 2026. Worktree `multi-root-libraries`, branch `2026-09-23-multi-root-libraries`. Custom Collections remains paused. Preserve all existing dirty work.

## Outcome and evidence

Repair the complete local album journey: physical album roots and CD child folders define membership alongside tags. A same-tag song in an unrelated mixed folder must not enter the complete album's details or supply its cover. Such duplicates remain actionable in Problematic Files. Rank eligible local artwork from the correct physical album root; the accepted automatic quality requirement is at least 1200 pixels in both dimensions. Preserve explicit in-app manual selections.

Read-only production evidence: Neal Morse One (album 2821) has 17 properly located disc tracks plus one `45. Cradle To The Grave.mp3` from a mixed folder; Lifeline (2830) has 14 proper disc tracks plus `46. Fly High.mp3` from that mixed folder. Both album records point to the same 200-square Bright Eyes Windows AlbumArt image; 95 albums reference it. Correct One and Lifeline cover.jpg originals remain intact. Migration 0041 blanket-marked pre-existing cover records as user-owned, so the user marker alone does not prove an explicit in-app selection.

## Delivery boundary

One cohesive bugfix delivery includes membership, duplicate diagnostics, cover candidate ranking, genuine manual provenance, migration/reconciliation, tests and docs. Prerequisites: current Postgres schema and existing shared UI. No new UI styling or redesign. Rollback must preserve actual manual choices and original media; never rewrite historical migration checksums. Any new migration is additive. No deployment or live-data mutation before isolated verification establishes the reconciliation contract. No automatic publication of the accumulated branch.

## Accepted behavior

- Group a complete album by its physical parent or recognized CD/disc children, preserving valid editions and complete alternate-source copies.
- Exclude unrelated singleton duplicates from regular details and complete-source tabs; retain them in Loose Tracks and duplicate-file diagnostics with original location and edit actions. These outside copies remain allowed as loose tracks; excluding album membership must not discard the files or their tag problems.
- Use only artwork associated with the valid album root/disc children for album cover ranking. Prefer higher-quality eligible local artwork; a tiny generic mixed-folder image must not beat a proper local cover.
- Owner clarified automatic quality accepts 1200 by 1200 or larger, with both dimensions meeting the minimum. An undersized image may remain as a fallback when no acceptable artwork exists, with its quality problem visible; do not manufacture an acceptable result.
- A genuine manually selected compliant cover avoids automatic provider work. A smaller manual cover may be searched. Automatic replacement of a protected manual selection requires visually matching artwork and a measurable quality improvement. Different artwork produces the existing improvement notification, requiring user choice.
- Ownership provenance must distinguish real in-app choices from blanket legacy markers without inferring that every existing marker is safe to clear.
- Existing user flags cannot distinguish historical manual selections from migration backfills. New explicit provenance records subsequent in-app selections; it cannot reconstruct old choices.
- The owner authorized replacing undersized existing covers regardless of legacy user flags, including different artwork inside the correct folder. The next repair run uses `ALBUM_HAVEN_COVER_REPAIR_MIN_EDGE=2000`: both decoded dimensions must meet 2000 before a quality replacement succeeds. Preserve the fallback when no adequate candidate exists. After this run completes, restore 1200 by changing configuration and restarting. Never reset on startup or an unrelated job's completion. New explicit selections retain normal 1200 protection and same-art-only upgrades.
- No future migration or backfill may label an inherited cover as a user selection merely because its path or URL exists. This prohibition is recorded in AGENTS.md. Repair proven inherited contamination with additive reconciliation, without blanket clearing ownership. Record corrected values for rollback and guard replacements against concurrent explicit selections.

## Verification matrix

Use generated media and isolated Postgres through the production ASGI app; mocks apply only to third-party providers. Existing acceptance contracts remain unchanged except additive cases directly requested here.

1. Complete album root plus unrelated same-tag duplicate: gallery and Album Details retain exact proper tracks; unrelated copy remains visible as a duplicate problem. Reload and rescan preserve this.
2. CD1/CD2 grouping remains one complete album. Complete copies and distinct editions remain correctly scoped; neither album tags alone nor a matching title steals unrelated tracks. For the generated two-copy fixture, Album Details returns exactly four tracks from its selected physical source and exactly two complete `duplicate_sources`, each with four tracks. Both source payloads and both existing duplicate-source tabs (`Files 1` and `Files 2`) must collectively contain all eight eligible paths, with four rows per tab; release/edition tabs remain a separate control. Orphan and mixed-folder copies must not become extra source tabs; they remain in Loose Tracks and Problematic Files.
3. Unrelated 200-square art versus valid 1600/2400-square album art: gallery displays eligible local artwork; no original file is destroyed; reload/rescan use the same correct source.
4. Explicit acceptable manual cover: automatic run completes without querying providers or replacing it.
5. Explicit undersized manual cover plus larger visually matching provider art: automatic quality upgrade persists, including origin/provenance and reload.
6. Explicit undersized manual cover plus larger different provider art: current choice remains; existing notification offers the alternative; user choice remains required.
7. Legacy user-marked covers without explicit provenance: repair proven inherited contamination and allow undersized legacy artwork to be replaced by different adequate artwork even inside the legitimate folder, as authorized by the owner. A legacy user flag alone does not protect undersized artwork. Genuine explicit selections retain protection; concurrent explicit Save must block a stale legacy replacement.
8. Exact boundary dimensions and rectangular undersized artwork: threshold decisions use both edges and actual decoded pixels. During the 2000 repair run, 1999 by 2000 and 2000 by 1999 do not satisfy the target; 2000 by 2000 does. Explicit 1200 artwork remains protected. Shared artwork/query memoization must keep explicit 1200 and legacy 2000 eligibility separate in either processing order.
9. Repair-to-normal configuration transition: a negative provider cache entry from the 2000 run must not block a useful 1600 candidate after configuration returns to 1200 and the process restarts. Negative cache validity includes the effective quality target; old entries without a target retain the normal 1200 meaning.

Test execution is serialized: one pytest maximum, no Python/JavaScript overlap, scoped E2E process/port cleanup. Record red/green, two full relevant-diff review passes and final proof. Full release CI and publication remain separate gates.

## Verification evidence

Latest focused verification reported by the root task:

- Python: 1056 passed, 4 deselected (43.99 seconds). The deselected cases are two existing browse baseline failures and two tests for the paused Custom Collections feature; they are not accepted as passing. Seven added diagnostic cases prove independent duplicates in a mixed folder without treating different editions, years, artists, titles, or durations as copies.
- New canonical publication, rollback, and post-commit manual-Save race regressions: 6 passed. Full metadata rereads preserve trusted app-owned selection authority before album validation. Guarded repair publication synchronizes eligible file entries from the actual canonical selection in the same transaction, returns committed entries, and rebuilds runtime albums. A newer manual Save advances the generation under the shared lock and prevents a stale runtime overlay.
- Private Sandbox3 launcher: 55 passed.
- JavaScript fixture and functional-shard contracts: 52 passed. The shard contract now asserts all eight isolated cover cases and their exact execution order, including the four new integrity cases. Syntax checks passed for both ownership files and the existing cover-lookup spec.
- Production-parity check: the remaining finding is the unchanged `productionViewObserver.js:192` baseline flag `allowBootstrapFallback = true`. The file matches HEAD and was absent from the task baseline patch. Its guarded initial-document presence observation does not create a successful full response; the lexical checker classifies the flag as a behavior fallback. This remains an open parity-gate finding.
- Initial isolated E2E inventory found two new-test interaction errors: release/edition tabs were used to switch physical copies. The tests now use the existing duplicate-source controls and retain exact source membership assertions. It also exposed genuine explicit-provenance hydration and stale persisted image-dimension defects; their responsible runtime seams have been repaired.
- Final isolated E2E acceptance is pending for the matrix of four new ownership/membership cases plus three existing FTC-COVERS-019 scenarios. Failed or indeterminate cases require complete reruns after their fixes. Do not record final acceptance, deployment approval, or publication readiness before the complete results are collected.
- The added different-art precondition in FTC-COVERS-019 must acknowledge its suggestion through the real lookup-gallery opening before the existing same-art upgrade scenario begins. Assert retained bytes, the unseen indicator, and the offered alternative first; then opening the gallery clears the indicator without Save or cover replacement. Automatic upgrades do not acknowledge an unseen alternative on the user's behalf. The existing same-art indicator and later-indicator-restoration assertions remain unchanged.
- A later FTC-ALBUM-DETAILS-023 attempt passed physical-source, separate-edition, and Loose Tracks checks, then waited for the hidden Problematic Files tab because the test had not opened Settings. The wrapper exited with an unknown result, zero completed cases, and no case blob. This attempt is indeterminate, not a whole-case pass; its Problematic Files and reload/rescan checks were not reached. The test now opens Settings through the existing production action before selecting that tab, preserving every subsequent assertion. A complete rerun remains required.
- FTC-COVERS-026 originally compared the displayed 480-pixel JPEG derivative against full-size PNG bytes. Retained response evidence proved those were different legitimate representations of the same saved selection. The corrected test captures its settled displayed derivative after Save and reload, then compares those displayed bytes after each rescan/reload. Separately, the existing full-size production `/cover` response must retain the exact saved candidate bytes before and after rescans, alongside path, revision, user ownership, explicit provenance, and zero automatic-provider work. This correction has not yet been verified by a complete rerun.
- Complete relevant-diff review passes identified and repaired stale membership precedence, rejected duplicate-source leakage, threshold memoization/cache reuse, and incomplete persistence guards. Subsequent review retained exact membership and artwork assertions and found no remaining validated issue; this does not replace the pending E2E or release gates.

## Work checklist

### Latest isolated rerun (2026-10-07)

The 1200-pixel rerun reached and passed every scenario step in FTC-COVERS-025,
FTC-ALBUM-DETAILS-023, and FTC-COVERS-026. This includes corrected artwork after
reload, exact physical source membership, independent duplicate diagnostics,
Loose Tracks retention, real manual Save, and two rescans preserving explicit
selection bytes with zero album-specific automatic provider queries. However,
each Playwright wrapper returned an unknown error with zero recorded completed
cases after the scenario steps. These remain indeterminate whole-case results;
the wrapper failure must be diagnosed and complete results collected.

The outer process (12832), observed owned descendants, and listening ports
56803/56805 exited. Failure artifacts are retained at
`C:\Users\Rendref\AppData\Local\Temp\album-haven-functional-local-fd873841082a-cover_providers`.
No Sandbox3 activation or live repair was performed. A separate late-open modal
race regression is being fixed before the next E2E wave.

- [x] Record owner requirements and root-cause evidence.
- [x] Trace membership, persistence and manual-provenance seams.
- [x] Add failing focused tests and additive E2E scenarios.
- [x] Implement shared folder membership and scoped local-cover selection.
- [x] Implement provenance-safe cover policy and reconciliation.
- [x] Run focused suites and extensive isolated E2E matrix.
- [x] Review complete relevant diff twice; repair all confirmed findings.
- [x] Report verified behavior, remaining limits and activation state.

## Verification evidence

- Python: `1056 passed, 4 deselected`; the deselections are two existing browse baselines and two paused Custom Collections cases.
- Related JavaScript: `428 passed`; the two final focused race and diagnostic regressions also pass.
- Runtime bundle rebuilt from 77 modules.
- FTC-COVERS-025, FTC-ALBUM-DETAILS-023 and FTC-COVERS-026 each passed after the final runtime change.
- FTC-COVERS-027 passed with `ALBUM_HAVEN_COVER_REPAIR_MIN_EDGE=2000`.
- Each E2E wave ended with no owned process remainder and no listeners on ports 22805 or 22807.
- Sandbox3 remains unchanged; no live scan or database repair was run.
