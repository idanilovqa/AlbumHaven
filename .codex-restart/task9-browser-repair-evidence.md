# Browser repair evidence

## Focused helpers

- Bootstrap literal JSON extraction, preference restoration, and visible metadata parsing: 15/15 passed, 155.7 ms (tool output 851cfc). Fourteen changed JavaScript files passed syntax checks.
- Theme-color measurement initially failed the production parity guard because OffscreenCanvas drawing occurred inside evaluate. Conversion moved outside read-only browser evaluation; 2/2 focused cases passed, 94.6 ms, and the unchanged production parity guard passed (b09fda).
- Later touch, limited-member, duration-POM, and picker-settlement additions still require focused verification.

## Native reorder

- First repair run, wrapper 30068, failed after the normal 240-second timeout. Captured actual order was Target, Move, Playing (newest first); asking Move after Target was an exact no-op. Native drag call 1026 completed normally, with no mutation request as required. No production change was justified.
- Evidence: `task9-functional-native-repair.stdout.log`, corresponding stderr, and retained temp fixture `album-haven-functional-local-8c998593e04a-playback_utilities`. Normal teardown finished; exact owned processes, ports 30936/30938, and database state marker were absent.
- Corrected existing L02 derives source/destination from captured rendered IDs, ensuring a different order. Wrapper 3596: **1/1 passed**, case 23.1 seconds, Playwright run 30.2 seconds. Real drag sent reorder POST, updated panels and tree, preserved the exact playing audio element and progressing playback plus unsaved range, and survived reload.
- Evidence: `task9-functional-native-repair-2.stdout.log` and stderr. Wrapper exit 0 at 2026-09-10T10:51:51Z. Exact owned tree absent; ports 35132/35134 clear; database marker absent.

## Integration picker

- First I01 invocation, wrapper 25192, failed in 20.7 seconds on case-sensitive error expectation (`Duplicate` versus lowercase regex).
- Captured selected paths also exposed an actual product race: child navigation awaits a fetch while retaining the previous parent selection; immediate Choose returns that stale parent. UI owner received this finding for a focused regression and fix.
- Normal path POM now waits for exact displayed child path and verifies exact child textbox result. Error matching accepts sentence capitalization. No test failure is claimed fixed until rerun.
- Evidence: `task9-functional-integration-roots.stdout.log` and stderr, retained fixture `album-haven-functional-local-2370e2326a0d-playback_utilities`. Wrapper exit 1; exact process tree absent; ports 40333/40335 clear; database marker absent.
- I02 separate help wave, wrapper 37400: **1/1 passed**, Playwright run 11.9 seconds. The real guide retained one content scroller and reachable Close at desktop and 390px widths, and both unsupported Import actions stayed disabled. Wrapper exit 0 at 2026-09-10T10:59:59Z; recursive owned process audit empty; ports 27357/27359 absent. Shared test slot released.

## Contract preservation

### September 12 focused browser repair

- Admin full run: 6/8 passed in 1.4 minutes. Owner hover sampling caught an active Chromium oklab transition; measurement now awaits finite native animation completion before resolving the unchanged color comparison. Regression: 1 RED then 3 GREEN. Limited-member assertion now checks absence of the denied key, matching `AllowedActions.as_payload()`'s allow-only projection; real status observation and unrelated Appearance Save remain. Native rerun pending.
- Long Loops failed at the first geometry assertion (4.1 seconds): expected Play-to-main gap 8px, observed 12px. Authority is plan B02's approved 48px Play centered in the 56px Capsule and `player.css`'s shared 8px column gap. The three assertions now derive `8 + (56 - 48) / 2` and independently check Play48 and Capsule56. All geometry tolerances remain <=1px. No runtime change; native rerun pending.
- Logs: `task9-phase7-admin-sep12-repair.log.stdout` and `task9-functional-loop-journey-sep12.log`. Admin owned process/port cleanup was empty and database teardown completed. Loops wrapper 28528, outer44520 and recorded Node43552/13908/48012 exited; ports57245/57247 clear, wrapper isolated-app/temp cleanup completed.
- Ready commands, to run only after root grants the exclusive test slot: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .codex-restart/task9-phase7-inventory.ps1 -Run -Kinds admin -LogSuffix '-sep12-repair-2'`, then `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .codex-restart/task9-functional-monitor.ps1 -Phase loop-journey *> .codex-restart/task9-functional-loop-journey-sep12-2.log`. Audit each wave before starting the next.
- Read-only follow-up corrected measurement ownership: `rootBounds` is the inner 34px scissors wrapper; separately measured `clusterBounds` now uses existing `expandedPlaybackControls.root` for the approved outer 56px Capsule. All three gap checks use that field. Native verification remains pending.
- Additional concrete stale contract found: `UtilityLoopTree.countForGroup` targets removed `.utility-loop-group-count`, while `buildUtilityLoopTree` renders the shared hidden numeric `.navigation-tree-count` (`countHidden: true`). Three remaining journey assertions expect legacy visible strings `2 loops`/`1 loop`; this needs shared numeric/hidden count verification while retaining independently visible detail saved-loop counts. Reported to root; not changed during read-only audit.

### Required legacy Problems case migration (September 12, pending execution)

- Matrix entries 12/13/75/76/77 require Problems013, selected identity mutation007, navigation011, scoped optimistic001 and rollback001. The proposal subset portion of scoped001 is configured, not an unrelated historical suite.
- Problems table now uses the production outline CompactDataTable owner and exact `Track / file`, `Problems`, `Suggested edits` columns. Album labels precede one `Detected problems` heading; no removed global counter or uppercase section headings are invented. Exact track file identity comes from the rendered row's real path, separate from visible track title/artist metadata.
- Suggested edit labels expose actual `data-problem-suggestion-id`, owning row path, visible field/original/corrected text and pressed state. Strict title-only repair selects exactly one real proposal, verifies that exact ID in the actual edit-tags POST and committed outcome, and retains existing physical TIT2-only and PostgreSQL field assertions. Problem selection remains independent from proposal selection. Obsolete repair/ignore chooser methods removed.
- Exclusion confirmation captures real selected file keys and actual album aggregate reason, reads the authenticated matching detail response to resolve authorized targets, compares the entire displayed target confirmation text, and verifies exact submitted `{row_key, scope, path/album_key}` items. Cancel, persistence, optimistic state, rollback and unrelated rule preservation cases remain. The existing generic confirmation string assertion is replaced by stronger internal exact-target checks.
- Counter assertions now prove each intended file/reason disappears, unrelated files retain that reason, and album-cover exclusion preserves the remaining exact track rows. Independent drag scenarios explicitly clear earlier selection through real label clicks; no selection state injection.
- Loop tree count migration complete: exactly one shared count node, `hidden` attribute, exact numeric2/2/1. Capsule field is outer `clusterBounds`; scissors `rootBounds` remains unchanged. All native verification pending.
- Four changed Problems files passed syntax checks; bounded source search found no remaining removed chooser/count/generic confirmation references in the required boundary. No test runner started while the merge replay owns the slot.

### Focused September 12 verification

- Pinned Node22, wrapper28520/Node43324: 22-file batch produced 532 passed / 1 failed out of533 in23.99s. The sole failure was a source guard still requiring the obsolete8px Play-to-main gap. Guard now checks approved Play48, outer Capsule56, derived12, and unchanged<=1px comparisons at allthree states.
- Production parity initially identified four violations: two Problems action-owned selectors and two swallowed native animation rejections. Selectors moved to owning POM arguments; both Settings menu and Tag Editor await finite animation completion without swallowing rejection.
- Focused repair verification:168/168 passed in1.80s; production parity passed with zero violations. Logs `task9-sep12-pom-focused.log`, `task9-sep12-pom-fixes.log`, `task9-sep12-pom-parity-fixed.log`. Original wrapper/Node descendants and final scoped Node/parity processes absent. Protected Gallery CSS hash remains `0F012C134D17FA4E334C4CE99A03BF46FF28E414ADADB63A5F7D16EA19C1DA86`. Slot released to root; Admin/Loops native reruns remain pending.

### Second native repair inventory

- Admin `-sep12-repair-2`:7/8 passed in1.7m. Denied012 passed real capability/absent controls/unrelated Appearance Save/signout. Owner011 fails the hover color comparison after transition settlement. Exact wrapper46896/outer5320 exited,6210–6212 clear, state `.tmp/task9-phase7-a9963e94/admin/postgres.state.json` absent, DB and3 roles dropped.
- Hover cause: expected14%waveform accent token differs from preexisting neutral5%text/95%panel dropdown rule (`appearance-backgrounds.css:793`, committed Gallerybaseline d0a34749). September2 shared-account-menu/v001 approved record specifies an older navy hover, so that record alone does not prove later neutral visual approval. Root informed; no helper/runtime change yet.
- Loops `task9-functional-loop-journey-sep12-2.log`:0/1 passed, failure at12.4s. Native disabled no-track geometry48/56/12 and real signed-track playback passed. After waveform selection, metadata parent `.player-main` intentionally spans shellcolumns via subgrid (runtime/non-album-and-player.css927–936); actual timeline remains column2. Existing `mainLeftGapFromPlay` measured the metadata parent instead of timeline surface, causing152px error. Screenshot extracted directly from retained trace: `task9-loop-waveform-gap-failure.jpeg`. Proposed correction is separately named timeline gap from existing actual timeline bounds; preserve parent widths/continuity and<=1px tolerance. No helper/runtime change yet.
- Loops retained trace under temp `album-haven-functional-local-7a2668c004e1-playback_utilities`; wrapper33424/outer48948/Node6808 and recorded Chrome/Python tree exited,54609/54611 clear, no state marker, normal DB+3role teardown. Slot released to root for optimistic regression.

- A01 first touch wave 35496 stopped before feature assertions: new preference isolation used URL-filtered cookies, excluding the secure loopback session. Added regression covering secure loopback plus unrelated host; **1 RED then 6/6 GREEN**. Lookup now matches exact hostname/root path while retaining captured origin/session identity. Failed browser evidence remains in `task9-functional-appearance-touch-1.*` and fixture `album-haven-functional-local-d0a88e564ffe-playback_utilities`; exact owned tree exited, ports 22802/22804 clear, database dropped normally.

- I01 corrected rerun 28052: **1/1 passed, 35.4 seconds**. Exact child navigation/Cancel, duplicate and unavailable-new-root errors, persisted valid roots, unchanged offline configured root, reload, and restoration all passed. Real scan completion precedes dependent saves. Logs `task9-functional-integration-roots-3.stdout.log` and stderr; authoritative wrapper exit 0; all recorded owned processes exited, ports 34966/34968 clear, database and roles dropped normally.

- I01 rerun 36140 passed exact child picking, duplicate rejection (400), unavailable new-root rejection (400), and initial valid Save (200). Immediate subsequent unchanged Save returned the intentional active-scan 409; finally cleanup hit the same guard. This was test sequencing, not a remaining picker defect. Added existing real scan-completion readiness before dependent saves. Evidence: `task9-functional-integration-roots-2.stdout.log` / stderr; retained fixture `album-haven-functional-local-9edb780ca3f1-playback_utilities`; all known owned processes absent, ports 32676/32678 clear and normal database teardown completed.

- Rules and Problems readiness uses shared Search/list/detail; removed redundant heading/count no longer blocks. Rules metrics count real navigation rows; timing limits unchanged.
- TrackModal delegates headings and visible final-strip summary to AlbumTrackTable. Main/bonus exact duration meanings remain; UI owner restored both lines inside the existing strip.
- Existing limited-member journey asserts actual `/status` loop-create denial before absent controls, and saves unrelated Appearance preferences through the real API. Listener default authority: `music_app/routes/admin_asgi.py` `_LISTENER_DEFAULTS`.
- Existing A01 now uses touch-enabled browser context and exercises both persisted styles with native tap Play/Create/Cancel. No case title/count added for these extensions.
