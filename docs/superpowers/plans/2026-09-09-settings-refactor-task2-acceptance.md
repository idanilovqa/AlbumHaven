# Settings refactor Task 2: manual acceptance

## Owner workflow override — September 9, 2026

The owner subsequently instructed the orchestrator to perform the manual validation, continue through all remaining Tasks 3-9, and present the completed work for one final owner review. This explicit instruction supersedes intermediate owner manual-acceptance stops throughout this plan and its linked checkpoint/report, including older per-slice wording retained as history. The orchestrator must still execute and record each slice's exact real-app manual checks before dependent progression. Approved test-first work, focused checks, builds, independent reviews and required regression/E2E checkpoints remain in force. No merge, push or publication is authorized. Preserve the original uncommitted work. Do not request the same per-slice approval again.


Date: September 9, 2026
Branch: `2026-09-08-settings-refactor`
Plan: [Settings refactor](2026-09-09-settings-refactor.md)
Technical decision evidence: [Approved checkpoint](2026-09-09-settings-refactor-checkpoint.md)

Status: Task 2 manual validation is complete under the owner's final-only review override. The orchestrator executed the real-app checks; implementation may proceed to Task 3 while preserving automated checkpoints. Final owner review remains due after Tasks 3-9.

## Problems selection defect and correction

The orchestrator reproduced the defect on an existing Problems row. Immediately after click, the row was at y482.7 with sidebar scrollTop 38035 and focus retained. After asynchronous detail completion, the row moved to y1597.7 while scrollTop became 36920 and focus was lost; the list bottom was y855.3. The cause was full sidebar replacement during selection/detail refresh. The correction retains mounted rows for selection and asynchronous detail completion, updates metadata/count/selection in place, and keeps unchanged artwork images. Repeated cached selection does not rebuild details. Explicit filter, collection and mutation refreshes retain their normal reconciliation; existing stale-response guards remain active. No saved data was mutated.

Fresh browser verification on the rebuilt runtime kept Vega-Tables at y482.656, scrollTop 38035 and focused=true both immediately after click and after its uncached detail loaded. A native coordinate click on nearby Variations retained y414.656, scrollTop 38035 and focus; repeating that click also stayed stable. A second uncached native click on Very also retained y550.656, scrollTop 38035 and focus through delayed detail completion, with the correct detail title. Native clicks avoided the locator tool's automatic centering, which otherwise introduced unrelated scrolling. Final correction verification passed **263/263 focused JS tests**, including **39 Settings cases**, with no failures, skips or cancellations. Eight additional selection/hydration cases were added; seven expected behavior failures were witnessed before implementation and the genuine collection-refresh case already passed.

## Open the build

Use [the running local app](https://localhost:5001/) in the already-authenticated Chrome session. Use the `localhost` hostname; the authenticated session is not shared with `127.0.0.1`. No application restart is required. Reload after the final runtime build, wait for library initialization to finish, then open Settings and follow the steps below.

The branch retains the current JavaScript/CSS/template stack. This handoff covers S01-S05: the joined six-tab Settings header, shared search/filter composition, wide NavigationTree rows and available/missing Artbox behavior. Later Problems suggestions, loop styles/reorder, log persistence/export, integration changes and Appearance preference work remain in their owning slices.

## Evidence before owner acceptance

The orchestrator inspected the authenticated live app without mutating saved application data:

- Six tabs accepted pointer activation and keyboard navigation; tab hitboxes remained reachable.
- Filters used the shared anchor and restored focus for its keyboard close action.
- Problems and Loops displayed artwork; selection and copying worked.
- At 390px width, Appearance navigation initially collapsed to 1px; after the layout correction the sidebar measured 157px and showed all five choices in 40px rows, wrapping into two columns with the last choice on a full row.
- After resizing from 1200px desktop to 390 by 844, selected Appearance remained visible at x201-302. Hidden Filters measured 0px width.
- Keyboard Enter on available artwork reproduced a lightbox defect: focus stayed on the underlying trigger after opening. The shared focus lifecycle is now fixed: the final browser recheck confirmed Enter focuses the lightbox Close control; Tab/Shift+Tab stay in the standalone modal; Escape closes only the lightbox and returns focus to the artwork; reopening and using pointer Close also restores the trigger.

Independent focused verification before the last two review fixes passed 249/249 JS tests, including 29 Settings tests. Runtime build, syntax, generated-bundle parity and diff checks passed. The preceding 248-test run found one isolated VM missing shared Artbox/modal dependencies; the test author registered the real dependencies and retained its assertions. No test/build process remained after that run.

Earlier independent verification after both review fixes: **255/255 focused JS tests passed**, with zero failures, skips or cancellations. This includes **31 Settings tests**, the existing lightbox suite and its three added focus cases. `npm run build:runtime` regenerated the bundle from 67 modules; syntax checks passed for all 14 changed/untracked JS files and generated-bundle parity matched current sources. `git diff --check` passed with line-ending warnings only. A read-only process audit found no remaining Node test/build or pytest commands. All four initial Harbor Mint hashes still matched.

The first correction verification found 14 failures in the isolated bootstrap harness (249/263 passed), caused by its missing filter-element seam after dismissal changed to a narrow control refresh. The test author supplied that seam to the real filter renderer, awaited two asynchronous handlers and explicitly asserted one content refresh plus one filter refresh. The final 263/263 rerun passed. Current source syntax checks cover 15 changed/untracked JS files; runtime build (67 modules), generated parity, diff checks and original-file preservation passed.

Final focused command:

```powershell
node --test --test-concurrency=1 tests/js/runtime/settings-refactor-shell.test.js tests/js/runtime/bootstrap-utility-event-handlers.test.js tests/js/runtime/utility-list-builders.test.js tests/js/runtime/utility-list-builders-foobar.test.js tests/js/runtime/utility-list-builders-local-playlist-import.test.js tests/js/runtime/utility-problematic-tab.test.js tests/js/runtime/utility-problematic-review-contracts.test.js tests/js/runtime/utility-problematic-load-diagnostics.test.js tests/js/runtime/utility-problematic-focused-track-render.test.js tests/js/runtime/navigation-tree.test.js tests/js/runtime/album-artbox.test.js tests/js/runtime/trigger-anchor.test.js tests/js/runtime/shell-navigation-drawer.test.js tests/js/runtime/track-modal-lightbox-helpers.test.js
npm run build:runtime
```

Independent review found no unresolved actionable Task 2 defect after checking both P2 fixes and the selection correction, including metadata hydration, filter/mutation boundaries, mounted sidebar identity and stale request guards. The lightbox reuses its existing bound keydown owner, releases the saved focus reference on close and skips detached triggers; no new global listener lifecycle was added.

These focused results do not clear the earlier Task 1 baseline. That baseline was 265/271 JS and 190/195 Python, with each failure preserved in the checkpoint. Task 2 verification has not rerun the broader baseline or Python, and it does not claim those failures were repaired.

Preservation check: all four initial Harbor Mint source/test file hashes remained unchanged during independent verification. Existing untracked owner artifacts were preserved. No commit, E2E authoring, merge, push or publication has occurred in this handoff.

## Exact manual script

Use existing authorized records. For missing-art/year checks, select an existing record with that state; do not alter saved data to manufacture it. If none exists, record that case as unavailable for this live dataset rather than claiming it passed.

### FTC-SETTINGS-S01: tabs and header

1. Open Settings and click Problematic files, Rules, Loops, Log History, Integrations and Appearance in order.
2. Focus a tab. Use Right Arrow through the last tab to the first, then Left Arrow through the first to the last. Press Home and End.
3. Confirm the selected tab and focus move together, its outline joins the body, and the upper-right Close is reachable. Confirm no Utilities title/subtitle or duplicate sidebar section heading remains.
4. Press an unrelated key while focused on a tab; it must not switch sections. Close and reopen Settings.

### FTC-SETTINGS-S02: search and Filters

1. Open Problematic files. Type a visible artist/album/track value into search and confirm matching results.
2. Open Filters and select one available problem type. Confirm search and the existing problem filter both apply; clear each through its normal control and confirm the broader results return.
3. Focus Filters and press Down Arrow. Confirm the dropdown opens and its first option receives focus. Press Escape; confirm only the dropdown closes and focus returns to Filters.
4. Edit search with Home/End and arrow keys; confirm normal input navigation remains usable. Inspect another tab where Filters is unavailable; its hidden control must consume no width.

### FTC-SETTINGS-S03: tree artwork and metadata

1. Inspect rows in Problems and Loops with available artwork. Confirm shared square art, correct title/song and artist, and the real year where supplied.
2. Inspect rows without artwork/year. Confirm the crossed-disc state and absence of a fabricated year.
3. Scroll deep into Problems and select an uncached row by pointer or keyboard. Wait for its detail request. Confirm the same row stays focused and visible at the same scroll position. Select a nearby cached row, then select it again; neither tree nor detail should flash or jump. Repeat with Filters open; closing it must not replace the tree. Confirm counts stay hidden.
4. Confirm hydrated title/artist/year/count remain accurate without restarting unchanged artwork. Change search/filter criteria and confirm actual result membership refreshes. Scroll the list and confirm visible/nearby art loads without eager requests for every offscreen row; browser-native lazy loading may preload nearby rows.

### FTC-SETTINGS-S04: header artwork and modal focus

1. In Problems, focus available header artwork and press Enter. Confirm the full-size modal opens and focus moves to its Close control.
2. Press Tab and Shift+Tab. Confirm focus stays in the visible modal. Close with Escape, then reopen and close with its button; confirm focus returns to the invoking artwork each time.
3. Repeat those actions from a Loops header. Confirm the selected problem/song context remains unchanged and artwork hover/focus uses a neutral outline.
4. Inspect a missing-art header. Confirm the crossed-disc state offers no enlargement action. A failed or denied image must not expose an actionable broken enlargement.

### FTC-SETTINGS-S05: resize, copying and lifecycle

1. Select Appearance at desktop width, resize to approximately 390 by 844, and confirm the selected tab stays visible, the five navigation choices remain reachable, and the detail editor can scroll.
2. Visit another tab and open Filters where available. Resize again; confirm the header contour and dropdown remain aligned. Manually scroll the tab strip and confirm it does not snap back against your action.
3. Select and copy visible text. Edit search and move keyboard focus across controls. Confirm copying/editing works without blinking carets and focus remains visible.
4. Close/reopen Settings three times and repeat tab/resize interactions. Confirm no duplicated reactions, stalled controls or disruption of the existing persistent player.

## Performance scope

Task 2 measures six tab bounds on activation/resize, with observer and anchor cleanup at close. It adds no full-table query and keeps existing list-scale, gallery and Utilities responsiveness/memory budgets. New tree artwork must use browser-controlled lazy loading and async decoding so offscreen rows do not eagerly request the whole list; header art remains immediately available. Focused tests and the final browser DOM check verify lazy/async tree artwork and eager/async header artwork. The final browser run also confirmed Loops header Enter moves focus to Close and Escape restores its Enlarge trigger while Settings stays open, without triggering audio. It restored the default viewport, cleared the temporary search and left Problems open for acceptance.

Focused lifecycle/resize checks and the manual responsive/scroll checks above cover this shell slice. No new performance E2E is required for Task 2 alone. Existing performance contracts remain unchanged; any measured regression requires diagnosis against those budgets. Later large tables, reorder and log-query slices retain their separate assessments.


### Orchestrator manual completion under the owner override

The final rebuilt authenticated app passed six pointer tabs, arrow wrapping/Home/End and unrelated-key preservation. Search for Sigur returned three albums; adding Missing year returned zero, and removing it restored three. Escape returned focus to Filters. An existing missing-art Kipelov row showed the missing Artbox without enlargement and did not invent its unknown year. At 390px, all five Appearance choices stayed in 40px rows, the active tab remained at x201-302 and hidden Filters width was zero. Three close/reopen cycles passed; one CDP action timed out after completing, and the immediate snapshot confirmed Settings open before the subsequent two explicit cycles passed. A final fresh clipboard check used Home then Shift+End to select offsets 0-5, copied Sigur successfully, and confirmed the computed caret is transparent. Earlier checks on this same final runtime established art modal keyboard/focus return and exact deep-tree selection stability. No saved data was mutated. These checks satisfy the slice's manual validation under the owner's override; they do not claim the earlier full-suite baseline failures are repaired.

## Acceptance checkpoint

The orchestrator has completed the five manual flows above under the explicit owner override. Continue the approved implementation and test sequence; collect final owner review after Tasks 3-9.

Task 3 and the approved functional E2E sequence may proceed after this recorded manual validation. Merge, push and publication remain excluded by the owner's request.
