# Task 9 independent UI review

Read-only source review while the initial full functional/performance inventories run. No test execution or production/test edits for these findings. Preserve the user-edited `music_app/static/css/gallery-main.css`. Findings below are source-supported; proposed regressions still need RED observation after the initial inventory.

## R1 - Re-selecting an Appearance or Rules row destroys the navigation/editor (P2)

- `music_app/static/js/runtime/bootstrap-utility-event-handlers.js:185-197`: Appearance always assigns the key and calls `renderUtilityModalContent`, including the already selected key. The draft-leave guard only governs different keys.
- `music_app/static/js/runtime/utility-renderers-and-actions.js:488-505`: Appearance replaces all navigation HTML and mounts the selected editor again. Its mount methods unmount/recreate editor markup. Native focus is left on the detached navigation button; local preview state is reset even though selection did not change.
- Same failure for Rules: bootstrap handler 176-181, Rules renderer 230-231 replaces tree/detail on every selected-row click.
- Minimal repair: same-key no-op at action owner; keyed or stable navigation selection updates for genuine key changes, retaining row nodes, scroll and focused target. Only replace the detail when a different section needs different content. Do not globally suppress legitimate membership/loading updates or retain an incorrect detail.
- Regression: actual handler plus real renderer harness, retain original row/tree/editor identities and scroll; repeat pointer and Enter selection; assert no replacement and preview/draft unchanged. For different keys, assert original tree rows remain connected/focused while the expected new detail appears. Include Rules in the same ownership contract.

## R2 - Clicking the active top tab remounts its contents; active Loops loses playback (P1)

- `bootstrap-utility-event-handlers.js:53-73` invokes loaders and final full render without checking whether the clicked tab is already active.
- `utility-loop-playback.js:73-88` does not short-circuit same-tab actions; returning its active string does not suppress the caller.
- `utility-loaders-and-cover-lookup.js:630-632` also renders on an already authorized cached Loops load.
- `utility-renderers-and-actions.js:403-409` increments loop view generation and disposes mounted loop actions; later code recreates detail markup. Thus active Loops click is not harmless: it replaces audio/range/controller state. Appearance's branch also renders twice, needlessly resetting its editor.
- Minimal repair: action owner treats a click on the already active tab as a no-op, except explicitly necessary keyboard focus/header alignment. Also respect a denied/deferred Appearance-leave result before loading or rendering the old tab. Preserve actual tab-change lifecycle disposal.
- Regression: retain actual saved audio, range/controller and editor/tree nodes; invoke real active-tab pointer/keyboard action; verify identities, playing state, range and focus remain. Separately assert real tab changes still dispose the outgoing owner once.

## R3 - A rejected period request relabels the old snapshot as the new date range (P2)

- `utility-log-history-query.js:59-66` assigns `state.periodLabel` before `capture` succeeds.
- `capture` (43-53) leaves the old query/snapshot/items and temporary row intact on failure, adding only the error. UI console/tree/search use the mutated label.
- Reproduction design: successfully apply period A; begin period B and reject its page request with 503. A's actual snapshot/items remain displayed under B's dates. Export still submits A's query/token. Cancel after failure does not restore A's label.
- Minimal repair: compute label locally and commit it atomically with the successful query/snapshot; leave the prior complete presentation untouched on failure. Keep the attempted draft and visible error available for retry/cancel.
- Regression: rejected replacement period and subsequent Cancel preserve A's label, query, token, items and temporary row; successful B commits all of them together. Do not weaken snapshot/export equality checks.

## R4 - Recent-activity pagination discards earlier navigation rows (P2)

- `utility-log-history-ui.js:23`: every empty-query page response assigns `owner.logHistory = data.items`, regardless of cursor.
- `utility-log-history-query.js:75-81`: `loadMore` correctly merges page items in the captured console collection.
- `utility-log-history-ui.js:93-99`: navigation uses `owner.logHistory` and removes nodes absent from that array. Loading page 2 therefore removes page 1 from the tree while the console contains both pages.
- Related ownership issue: the fetch adapter writes navigation state before the controller epoch check, so an obsolete empty-query response can update the base navigation despite its capture being discarded.
- Minimal repair: publish accepted, accumulated ordinary-query membership from the controller's successful generation path. First-page refresh replaces authoritative membership; later pages append/deduplicate with the same snapshot. Keep period/individual collections separate from ordinary navigation. Move state mutation out of the unguarded transport callback.
- Regression: two real-shaped 500-event pages retain page-one nodes, scroll and selection while adding the second page once. A delayed superseded first-page response cannot alter navigation. Verify the complete displayed collection still exports against its original captured query/snapshot.
- Additional usability check before repair acceptance: after selecting an individual event, explicit Refresh currently refreshes only that event query; the ordinary navigation never obtains newer events because the only base-list assignment requires an empty query. Provide an explicit authoritative ordinary-list refresh without silently replacing a captured period/detail snapshot.

## R5 - A failed tag edit's Log History link no longer opens its event (P2)

- `tag-editor-and-optimistic-updates.js:909-910` still supplies a real failed log event ID; `notification-ui-helpers.js:59-64` puts it on the visible repair-alert action.
- `bootstrap-utility-event-handlers.js:18-26` writes only legacy `selectedLogHistoryId`, then calls `openUtilityLogHistoryTab`.
- `utility-loaders-and-cover-lookup.js:1057-1060` forces the active controller refresh; `utility-log-history-ui.js:37` overwrites that legacy selected ID from controller state. There is no `selectEvent(id)` capture on this path, so it opens recent activity or the previous selected query instead of the requested failure.
- Minimal repair: carry the explicit event ID through the open action and call the controller's authorized `event_ids` selection after establishing the current Log History owner. Do not synthesize/merge an operational event or bypass scope. A missing/expired ID must show its real empty/expired result.
- Regression: real alert-click handler receives ID B while controller is on A (and also before initial history load), captures B with `event_ids:[B]`, selects its detail and exports the same token; late unrelated load must not replace B.

## R6 - Late Library selection completion can remount a different Integration detail (P2)

- Integrations same-selected-row behavior is already correct: `bootstrap-utility-event-handlers.js:204` returns immediately. Keyed list reconciliation (renderer 553-584) retains the tree. Replacing detail on a genuine different selection is expected.
- Separate asynchronous defect: `library-settings.js:116-121` sets Library, waits for settings, then unconditionally renders the current modal. A user can select Foobar/Scrobbling or another tab before that response. Loader finalization also calls render (315-345); the old completion then recreates the current unrelated detail despite no new selection.
- Minimal repair: capture utility identity and intended selected Integration/active tab, and refresh visible Library detail only if still the same owner. Populate the original owner's cache if safe, without remounting unrelated content. Keep real Library initial-load/error rendering.
- Regression: deferred real Library load, switch to Foobar and focus a real control/open its selector, resolve Library; assert Foobar detail/control identities, focus and selected Integration unchanged. Repeat after utility-context replacement.

## Approved behavior and non-findings

- Problems already has a hydrated same-row guard and tree-preservation render path (`bootstrap-utility-event-handlers.js:151-173`); Loops same-group click skips detail render and double-click collapse is intentional. Integrations same-row early return is intentional and correct.
- Appearance draft preview does not apply to the live app before Save. The old tests that expect draft/live mutation are stale; do not restore that behavior. Current own-account generation guards and saved-theme application were inspected without another concrete regression in that bounded seam.
- Appearance conflict keeps the draft and requires an explicit reviewed retry; capability loss reverts unauthorized staged loop-style changes while allowing unrelated edits. Do not remove these approved safeguards to satisfy old fixtures.
- Log History backend now prunes in a separate committed transaction then uses a bounded REPEATABLE READ snapshot for head/token/rows. Latest event version is chosen before filtering, and token signature binds library/query/revision/retention epoch. Earlier prune/late-version issues have focused coverage; this review found no additional concrete backend snapshot defect.
- These new findings are not classifications of stale full-suite tests. They need independent RED regressions and focused verification after all required initial inventories have been collected.

## Initial real shell inventory: S02 is a test-sequence defect, not an open-menu Escape defect

Real browser results reported by the inventory owner: S01 passed 5.2s, S03 passed 6.0s, S04 passed 6.3s, S05 passed 6.0s; S02 failed 15.7s at `settingsRefactorShell.spec.js:79`, expecting the Settings-scoped Filters button to be focused but finding no visible Settings dialog.

Failure artifact: `C:/Users/Rendref/AppData/Local/Temp/album-haven-functional-local-287951cfb4c3-gallery_search_visual/output/wave-01-02-playwright-config-js/settingsRefactorShell-FTC--effef-n-and-keyboard-anchor-focus-functional/error-context.md`. Its browser accessibility snapshot confirms Settings was closed.

Source and sequence evidence:

- The new S02 spec clicks `Missing cover art`, checks its `aria-selected`, then presses Escape on that option without reopening the menu (74-77). The clear-selection half repeats the same mistake.
- The actual option click intentionally sets `problemDropdownOpen = false` at `bootstrap-utility-event-handlers.js:131` and rerenders. The hidden menu option remains queryable, so the attribute assertion does not establish an open popup.
- Open-menu Escape is explicitly stopped/consumed at bootstrap 1097-1105 only when `problemDropdownOpen` is true. Here it is already false; the global Escape therefore closes Settings as designed. Passing S05 exercises Escape while the menu really is open.

Minimal later test-only correction: after choosing a filter, assert the menu is hidden; reopen with Filters ArrowDown and assert it is visible with a focused option; then press Escape and assert both visible Settings and focused Filters. Repeat after clearing the selected filter. Preserve combined search/valid-selection assertions. Do not alter production Escape propagation based on this false premise. The test remains unchanged until all required initial inventories complete.

## Initial exclusion inventory: FTC-UTIL-PROBLEMS-001 waits before approving the new Revert confirmation

Case: `problematicFileNavigation.spec.js:184`, `FTC-UTIL-PROBLEMS-001 scopes exclusions with optimistic persistence and reload`. It fails in `utilityRulesActions.js:175`, waiting 60 seconds for the Undecoded characters row to detach after clicking Revert. The locator resolves to the same visible album-rule row 122 times.

Exact artifact directory: `C:/Users/Rendref/AppData/Local/Temp/album-haven-functional-local-5b464751c0d3-playback_utilities/output/wave-01-01-playwright-config-js/problematicFileNavigation--00ba5-stic-persistence-and-reload-functional/`.

Read-only trace evidence from its `trace.zip`:

- `0-trace.trace`, click `call@108` at 51973.917 targets the row's `Revert rule` button.
- Snapshot `after@call@108` contains `repair-confirm-modal` without `hidden`, title `Revert rule?`, message `Revert the rule for ?? This problem can appear again in Problems.`, and No/Yes buttons. The question marks are the real fixture album title and punctuation, not an encoding inference.
- Next `call@110` at 52021.335 waits for the rule row to detach. No Yes action occurs.
- `0-trace.network` contains three successful GET `/utilities/rules` requests and no POST `/utilities/rules/problem-ignores/revert`. Thus no failed mutation response exists to diagnose: the test never authorized the mutation through the real UI.
- The final error-context snapshot follows cleanup and no longer shows the dialog; it must not supersede the actual click-time trace.

Source matches the approved behavior: bootstrap handler 403-413 calls `openRuleRevertConfirm`; `utility-list-builders.js:2840-2843` sets pending action; `utility-loaders-and-cover-lookup.js:1250-1267` opens the shared No/Yes confirmation. Existing actions `revertRuleContaining`, `revertRuleByKey`, and `beginRevertRuleContaining` assume immediate mutation and omit this step.

Minimal test-only correction after initial inventory: add confirmation dialog/No/Yes locators to the owning Rules POM. Actions click Revert, assert correct visible confirmation, click Yes, then retain existing optimistic row-detachment and HTTP acknowledgement checks. Install request/response observation before acceptance; retain the persistence gate so the test still proves optimistic removal before acknowledgement. Add a separate No branch proving row and persisted rule unchanged with no request. Do not remove confirmation or make the production revert immediate to satisfy these old helper assumptions. No source/test edits or new runners were used for this diagnosis.

## R7 - Saved Companion's invisible actions wrapper blocks the real Play button (P1, real browser RED)

Case: `loops.functional.spec.js:68`, `FTC-SETTINGS-L02 native panel drag persists order while another loop retains playback and its pending range`. This failure is distinct from the earlier test helper that hovered an overlapped range handle. Here the ordinary native Play click itself never reaches Play: Playwright reports the saved actions span intercepting pointer events repeatedly until the 240-second case timeout.

Exact artifact: `C:/Users/Rendref/AppData/Local/Temp/album-haven-functional-local-5b464751c0d3-playback_utilities/output/wave-02-03-playwright-config-js/loops.functional-FTC-SETTI-a7a81-yback-and-its-pending-range-functional/trace.zip`.

Read-only trace evidence:

- `0-trace.trace` snapshot `after@call@934` records a saved `utility-loop-play-cluster` with `data-loop-control-style=companion`, `data-loop-action-state=idle`, `data-loop-action-engaged=false`.
- Native click `call@946` at 131310.627 targets the actual `[data-loop-play]` in the playing-reorder fixture panel.
- The real error log identifies `<span data-playback-control-loop-actions class="loop-play-control-actions utility-loop-actions">` as the hit interceptor (436 retries reported by the inventory owner). No forced click or synthetic dispatch was used.
- Captured served CSS `resources/8527c016658dd6c35f1e04b56303a128b39103c0.css` includes `.utility-loop-actions { z-index: 7; }`. This is the actual loaded style, not a stale-source inference.

Source explanation in `music_app/static/css/runtime/non-album-and-player.css`:

- Shared Play has z-index 5 (604-624); shared actions wrapper z-index 4 (625-633).
- Companion has a 52px Play circle and actions wrapper at left26/top26, width58/height26 (634-642). That wrapper's rectangle begins at the circle center and overlaps its lower-right quadrant.
- Saved-only `.utility-loop-actions { z-index:7 }` (1136-1138) lifts the structural wrapper over Play. This differs from the expanded main player, which retains wrapper z4.
- The inner `.loop-edit-actions` has opacity0/pointer-events:none while folded (930-943), but its parent wrapper remains pointer-events:auto. Making a child inert does not make that overlapping parent inert. The invisible parent can still intercept while idle, folded, or capability-hidden.
- Capsule's wrapper starts at x52 with Play at x4..52, so its center avoids this specific overlap. Its empty structural wrapper still should not own non-action hits. Expanded main Companion currently has the correct relative z4/z5 stacking; retain that order.

Minimal repair after initial inventory: preserve outer `.utility-loop-play-cluster` z7 (which clears adjacent timeline/range siblings), remove/override the saved-only inner wrapper elevation so Play remains above it, and make the non-action wrapper pointer-transparent. Restore pointer events only on the revealed legitimate action surface/buttons through the existing engagement contract. Preserve approved circle sizes, Capsule90/123 geometry, Companion58/88 geometry, clipping, reveal/fold delays, semantic glows and keyboard ownership. Do not solve by moving the Play hit point, using force:true, hiding required loop controls, or changing the approved dimensions.

Regression proposal: real mounted expanded-main and saved-loop controls in Capsule and Companion; inspect actual elementFromPoint ownership at Play center plus representative lower-right circle points while idle/unrevealed, revealed, editing and folded. Native Play clicks must toggle the same audio owner without entering loop edit. Revealed scissors and editing Create/Cancel must still receive their own native clicks, including overlap-neighbor cases, and denied/hidden actions must not intercept. Assert hit ownership in a browser (DOM-only CSS-string tests cannot establish stacking). Run this exact existing FTC-SETTINGS-L02 again after the minimal fix and retain its genuine drag/order/persistence/player identity assertions. No production or test edits were made during this diagnosis.

## Main Create interception is a folded-action helper error, not an extension of R7

Final artifact: `C:/Users/Rendref/AppData/Local/Temp/album-haven-functional-local-5b464751c0d3-playback_utilities/output/wave-02-05-playwright-config-js/loop-edit-expiry.functiona-87a9e-oduction-session-controller-functional/trace.zip`.

Independent read of `input@call@424`: the main owner has `class="loop-edit-actions is-active"`, `data-loop-action-owner="global-player"`, state `editing`, engaged `false`; its targeted Create button has tabindex `-1` and aria-disabled `false`. The distinction is fold visibility, not session eligibility. The helper clicks the folded action and its parent correctly receives the hit.

`loop-edit-expiry.functional.spec.js:47-50` opens the editor, explicitly calls `moveAwayFromLoopAction`, drags the end boundary, then saves. `globalPlayerActions.js:585-588` proves the move-away has folded the compound (engaged false and opacity0). `saveLoopWithName` calls `openLoopNameDialog`, whose line872 directly clicks Create without revealing it again.

Later test-only correction: the pointer-save helper should reveal through the real Play/compound hover (or the approved keyboard focus path when specifically testing keyboard behavior), wait for engaged true and opacity1, then click the real Create button. Retain the 300ms initial reveal and 500ms active fold grace; do not force clicks, set application state, or make hidden/folded actions pointer-active. This does not weaken R7: saved Companion's Play itself is supposed to remain interactive while folded, and its parent-blocked Play is the separate proven product defect. No production/test edits or runners were used for this distinction.

## R1-R6 repair sequencing and regression ownership (read-only follow-up)

No production/test edits or test execution in this follow-up. These are bounded repair instructions for after the initial inventories finish.

### R1/R2: stop redundant actions before invoking lifecycle owners

- In `bootstrap-utility-event-handlers.js`, compare the requested tab/key with the current value immediately after reading it, before calling loaders, leave guards, or renderers. Keep native keyboard focus behavior: arrow navigation may focus the appropriate header, but activation of the current header must not reload its content. Do not make generic `renderUtilityModalContent` a no-op; legitimate capability, loading, membership and error updates still use it.
- For a different top tab, capture the previous tab, call `setUtilityActiveTab`, and verify the requested transition actually occurred before dispatching a loader or rendering. The existing deferred Appearance confirmation callback already owns the eventual approved transition. The initial caller must return while confirmation is pending or declined. Otherwise it remounts the very draft the user chose to keep. Remove the duplicate Appearance render in the successful branch. Do not add a second outgoing Loops disposal in the caller; the transition owner already disposes it.
- Appearance/Rules genuine row changes should reconcile their stable NavigationTree rows (as Integrations already does), update selected attributes and preserve search/scroll/focused row. The detail may change for a different key. Avoid caching only by selected key across data/capability changes: that would hide legitimate refreshed Rules details or permission changes.
- Exact test owners: `settings-refactor-shell.test.js` existing `S01 all six Settings tabs route through the live click handler` and keyboard table; `bootstrap-utility-event-handlers.test.js` existing `all Appearance pages share one draft without a leave confirmation` and `switching away from Loops clears session-only Space ownership`; `settings-appearance-search.test.js` mounted-navigation tests. Add active-tab cases for Loops and Appearance, deferred/cancelled leave cases, and same-selected Appearance/Rules pointer/native-click cases. Extend the real handler/renderer harness with retained node/controller/audio references, rather than a render-call spy alone. Assert actual different selection still updates details and one real Loops departure disposes its owner.
- Keep `utility-integration-settings.test.js` existing `integration selection retains mounted tree buttons and scroll instead of rebuilding` and `clicking the selected integration does not reload or replace its detail` as unchanged positive neighbors. Integration same-key behavior is already correct.

### R3: commit the period presentation as one accepted result

- In `utility-log-history-query.js`, pass the candidate label as capture metadata; assign it only after the epoch check alongside accepted query/snapshot/items/temporary row, before saving `periodCapture`. Do not update a global pending label that another overlapping capture could read. Keep the attempted draft available when the request fails and preserve the old complete presentation until success.
- Extend `utility-log-history-query.test.js`: `canceling an export draft preserves the captured query and causes no download`, `one temporary query row retains its identity and clear restores ordinary event selection`, and `late response for replaced query cannot replace the visible snapshot`. Observe period A success, B rejection, Cancel; compare label/query/snapshot/items/row ID and export payload with A. Then B success must change those fields together. Include overlapping B/C completion order so an older success cannot supply the newest label.
- Extend `utility-log-history-live.test.js` existing `ordinary tree selection and a changed period label retain exact nodes and ordering` to use the actual controller transitions, not manually assigned presentation objects alone.

### R4: publish navigation and grants only after generation acceptance

- `utility-log-history-ui.js` transport callback must return response data without writing `owner.logHistory` or `owner.allowedActions`. Both writes currently precede the controller epoch check. Transfer accepted response metadata through a narrow controller acceptance callback/state field after identity/epoch validation; the live owner then publishes it only if it is still the current utility object.
- Ordinary base-query first-page acceptance replaces the authoritative base collection. An accepted continuation merges its accumulated controller items, preserving prior IDs and order. Validate the same snapshot before any collection/grant publication. Period and individual captures must not overwrite the base NavigationTree. Loading/error emissions with old state must not be mistaken for a newly accepted response.
- Exact tests: extend `utility-log-history-query.test.js` `later pages retain query and snapshot and deduplicate public event IDs` and `library change clears data and rejects a delayed prior-library response`; extend live tests `live loader delegates to captured server query and keeps authoritative navigation separate from detail`, `missing current export projection removes a previously granted export action`, and the exact-node tree test. Deferred real-fetch fixtures should prove: page 2 retains page 1 tree nodes; replaced base response changes neither tree nor grants; wrong continuation token changes neither; old-library completion cannot touch the new owner. Keep export equality with the accepted query/token.
- Base-navigation refresh and selected console refresh are distinct. Do not fix the stale tree by silently changing an individual/period capture to `{}`. If refreshing base membership while preserving a selected capture, give that base request its own accepted generation and publish only base data; leave the selected query/token explicit. A deep-link/base-load race must be covered with R5 before integrating this seam.

### R5: carry the failure entry ID through the actual open operation

- Change the alert action/open helper seam to accept the explicit entry ID, rather than assigning the legacy `selectedLogHistoryId` field. Establish the current utility/controller owner and accepted tab transition before requesting `selectEvent(id)`. Do not let the existing `openUtilityModal(...forceLoad:true)` start a later generic refresh that supersedes this capture. Either finish the required initial base load first with an ownership check or use the independent base-navigation acceptance seam from R4; then the event selection is the authoritative detail action.
- If Appearance leave confirmation defers opening, carry the requested ID in that accepted continuation; do not force-open the old tab or consume it against the wrong owner. If another user selection/context change occurs while loading, the old opening intent must not override it on completion.
- Replace the insufficient legacy assertion in `bootstrap-utility-event-handlers.test.js` `failure alert Log History link selects its exact entry before opening the tab`: today it proves only a field assignment and stubs the actual open method. Add real open/controller integration in `utility-log-history-live.test.js` for first open and existing event A -> failure link B, including deferred base response, context replacement and missing B. Assert the rendered event, `event_ids` query and export token agree; never insert a synthetic alert event or export A when B is unavailable.

### R6: allow old-owner cache completion without old-owner presentation

- Capture the utility object plus Library settings state in `loadUtilityLibrarySettings`; guard all visible rendering and error toasts against the current utility, visible Integrations tab and current `library` selection. An obsolete request may finish its captured cache state, but must not recreate Foobar/Scrobbling content or emit a foreign-context toast. The initial loading render needs the same ownership condition. A cached result must not force a generic render when Library is not active.
- Remove or guard the additional unconditional render after the await in `handleLibrarySettingsIntegrationSelection`. Choose one owner for the accepted completion render, rather than rendering once in loader `finally` and again in the selection helper. Do not discard valid late data solely because the user temporarily selected Foobar; cache reuse is safe when ownership is unchanged.
- Extend `library-settings.test.js` `loadUtilityLibrarySettings stores normalized settings and drafts` and `handleLibrarySettingsIntegrationSelection loads the library settings detail when the library integration is selected`; combine the real helper with `utility-integration-settings.test.js` retained-tree/detail harness. Deferred GET success and failure after Library -> Foobar must retain the exact Foobar input/menu/detail and focused node, with no obsolete toast. A utility replacement must receive no old cache or presentation writes. Current Library success/failure must still end its loading state and display the real result once.

Implementation ownership can stay narrow: navigation owner handles R1/R2 plus the alert dispatch; log controller/live-loader owner handles R3/R4/R5 together; Library settings owner handles R6. Shared build remains a separate serialized step after focused GREEN. This avoids concurrent edits to the same bootstrap/renderer functions and prevents a partial R4 transport change from breaking R5 opening order.

### Lifecycle regression preparation (not yet executed)

Authored only `tests/js/runtime/settings-lifecycle-regressions.test.js`: 13 runtime behavioral cases for R1-R6. Uses actual bootstrap click/transition, log query/controller/live transport/open, and Library loader/selection functions. A mount boundary models node disconnection, focus loss and audio disposal; asynchronous fetch promises are explicitly controlled. No source-string assertions, E2E discovery changes, source repairs, existing-test edits or test execution. RED evidence is pending the initial-inventory release. Deep-link cases intentionally require the open operation to issue the targeted event query; if implementation chooses independent base priming, retain eventual exact event/epoch assertions while allowing that explicit sequence. Existing tree reconciliation tests remain required focused neighbors.

Component evidence qualification: the initial functional/component run used user Chrome 150. Before classifying or updating any component glyph/snapshot baseline, rerun with the verified pinned Chrome 151 at `C:/Users/Rendref/.cache/album-haven/chrome-for-testing-151.0.7922.138/chrome.exe`. The 66/19-pixel compact glyph differences may include browser rendering differences; no automatic baseline updates.

## Task 9 UI repair verification checkpoint

R1-R6 original 15 cases were observed failing in `task9-new-regressions-red.log`; the owned lifecycle repairs passed in the combined 149-case wave (143 passed, six failures: two new navigation races, two CI prerequisites, two root-owned stale fixtures). The two independent-navigation races were then observed RED and fixed by sharing base-navigation generation across ordinary first-page/continuation and navigation-only requests, while preserving the selected-console epoch. `task9-ui-focused-2.log`: 66/66 passed including all lifecycle/query/live/root-neighbor cases. A final returning-to-pending-Library regression was observed RED and fixed; `task9-lifecycle-final.log`: 18/18 passed, zero failures/cancelled/skips.

R7 preserves the approved control geometry and disclosure timing: the structural action mount is pointer-transparent; the saved inner mount stays below Play (z4), while the outer compound remains z7 above neighboring waveform layers. The actual shared action controller and actual playback component were exercised with native Play, Enter, Create, Cancel, fold, and Play again for main/saved Capsule/Companion. All four native cases passed; both style waveform geometry cases passed. No forced clicks or hidden-action activation workaround was added.

The player fixture now uses real PlaybackControlCluster and shared Button renderers. Its inline base CSS initially retained an external-file BOM and lost all three required root tokens; an exact computed-style RED showed empty --success/--panel-2/--border. Stripping the initial BOM during fixture decoding restores actual external stylesheet behavior. Theme presence remains asserted. Waveform metadata now shares the player's actual grid instead of subtracting the stale fixed144px leading width; all <=1px anchors and57px/39px centers pass. Original thresholds and baselines remain unchanged at this checkpoint.

Pinned Chrome 151 verification: `task9-components-repair-2.log` has22 cases,17 passed/5 failed in28.8s. All six new player geometry/native cases and shared footer behavior passed. Four remaining failures are player screenshot comparisons (3184/3383/190/19 changed pixels); one newly reached AlbumTrackTable outline2px/actual1px failure belongs to its fixture owner. The component node/browser process matches were audited empty after normal exit before releasing the slot; no application server or ports were used.

Visual inspection supports a bounded four-image baseline refresh after root review: current expanded Capsule and chevron spacing differ from old hand-built controls; current waveform inner edge is6px from the already committed Task4 size-control CSS, while the old baseline used28px; the regular text follows the actual seekbar edge. Docked markup now uses real shared SVG transport chevrons; floating uses the committed bare chevron. There is no reason to increase image tolerance, restore the old player geometry, or modify Gallery CSS. Baseline updates are still pending at this checkpoint.

Owned production changes: `bootstrap-utility-event-handlers.js`, `utility-renderers-and-actions.js`, `utility-log-history-query.js`, `utility-log-history-ui.js`, `utility-loaders-and-cover-lookup.js`, `library-settings.js`, `static/css/runtime/non-album-and-player.css`, and `templates/partials/navigation-tree-assets.html`. Owned tests: new `settings-lifecycle-regressions.test.js`; coupled `navigation-tree.test.js` and `appearance-waveform-recents.test.js` DOM fixtures; `components/playerViews.spec.js`; approved shared1px assertion alignment in `components/buttonInteractionOutline.spec.js`. No generated bundle, applied migration, Gallery stylesheet, existing E2E file, screenshot baseline, or performance budget was changed by this repair owner.

Root reviewed all four actual and four expected player PNGs and accepted only the four baseline replacements from `settings-task9-components-repair-2`. Those exact files were copied unchanged to the existing Windows snapshot paths. Approval covers the real Capsule56/48 treatment, shared chevrons and already-tested metadata/seekbar alignment. No new screenshot tolerance, CSS weakening, or additional snapshot was changed. A fresh component verification remains pending the serialized test slot.

Final bounded Save follow-up: five controlled late/current Save cases were observed RED in `task9-ui-neighbors-3.log`. Captured Library Save results now update only their owned cache, guard global status/polling by current utility identity, and guard detail/toast presentation by current visible Library selection. Same-library successful mutations still invalidate the appropriate Problems cache even after switching to Foobar. Current Library completion renders exactly once after releasing its busy state. Root-authorized neighbor inventory also exposed15 stale fixture/assertion failures (Rules querySelectorAll11, player fixed-width/offset2, legacy alert field1, missing active/visible Library fixture1); each was aligned without weakening substantive behavior. `task9-ui-neighbors-4.log`:86/86 passed, no failures/cancelled/skips. New lifecycle file now has23 cases. Added coupled test owners are `bootstrap-utility-event-handlers.test.js`, `library-settings.test.js`, `utility-rules-search.test.js`, and `player-and-waveform.test.js`.

Owned source is frozen for independent review and root rebuild. Final owned diff whitespace check passed. User Gallery CSS remains untouched with SHA256 `0F012C134D17FA4E334C4CE99A03BF46FF28E414ADADB63A5F7D16EA19C1DA86`. No runner/browser is owned by this worker. Next required checks are rebuilt runtime, fresh full22 component acceptance after the four approved baseline copies/table fixture correction, and the root's broader application/native-loop/final full-suite verification. No commit, merge or publish was performed by this repair owner.


## Album Details duration semantic restoration

Approved missing-album-and-album-details/v001 notes75-102 retain the final total strip. The adapter computed main/bonus durations but discarded them after replacing the legacy footer. Two exact behavioral tests reproduced missing summary fields/text (2 failed, 0 passed, 205ms). The adapter now derives both durations from actual explicit disc groups; the shared table renders both labeled lines within its single existing final strip. Ordinary albums retain the aggregate total. No CSS or geometry changed. Both full focused Node files passed68/68 in303ms; runner exited normally, no browser/pytest launched. Diffcheck passed and user Gallery CSS SHA256 remains0F012C134D17FA4E334C4CE99A03BF46FF28E414ADADB63A5F7D16EA19C1DA86. Rebuild and real FTC-ALBUM-DETAILS-005 verification remain in the root pipeline.
