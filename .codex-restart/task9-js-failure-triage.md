# Task9 initial JavaScript failure triage

Read-only diagnosis of `.codex-restart/task9-full-js.log`: 2628 passed, 42 failed. No production or test edits and no reruns were performed for this diagnosis. All required initial inventories must finish before fixes.

Classification: 12 infrastructure failures (7 discovery/ownership drift, 5 E2E helper guard violations), 30 stale fixture/source/date expectations. No runtime product defect or missing environment prerequisite established by these failures. Discovery totals changed from matrix140 to command141 during the run; reconcile the final frozen discovery rather than blindly editing totals.

## 1. not ok 81 - approved test-data matrix records every discovered case

- Location: `tests/js/ci-fixture-data-contracts.test.js:351:1`
- Classification: Infrastructure: discovery/ownership drift
- Evidence and minimal proposed fix: Reconcile latest frozen case discovery, approved matrix and exact shard ownership; update obsolete 138/97/15/30 totals without weakening completeness or uniqueness.

## 2. not ok 89 - functional shard contract owns all 97 browser-functional cases exactly once

- Location: `tests/js/ci-fixture-data-contracts.test.js:479:1`
- Classification: Infrastructure: discovery/ownership drift
- Evidence and minimal proposed fix: Reconcile latest frozen case discovery, approved matrix and exact shard ownership; update obsolete 138/97/15/30 totals without weakening completeness or uniqueness.

## 3. not ok 95 - read-only inventory command reports complete discovery and ownership totals

- Location: `tests/js/ci-fixture-data-contracts.test.js:689:1`
- Classification: Infrastructure: discovery/ownership drift
- Evidence and minimal proposed fix: Reconcile latest frozen case discovery, approved matrix and exact shard ownership; update obsolete 138/97/15/30 totals without weakening completeness or uniqueness.

## 4. not ok 104 - public run index links retained prior runs to authenticated Actions evidence

- Location: `tests/js/cloud-test-report.test.js:184:1`
- Classification: Fixture: wall-clock dependency
- Evidence and minimal proposed fix: Aug24/25 fixture dates have expired under actual 14-day retention; inject clock or use relative fixture dates, retaining retention behavior.

## 5. not ok 224 - utility loop summaries read the group header instead of a saved-loop title

- Location: `tests/js/e2e-action-production-paths.test.js:4494:1`
- Classification: Infrastructure: E2E helper contract
- Evidence and minimal proposed fix: Move utilityLoopsActions.js:294 control-style locator into LoopEntryCard POM; keep selector ownership guards.

## 6. not ok 227 - loop functional coverage proves progress, repeat, and both live control orders

- Location: `tests/js/e2e-action-production-paths.test.js:4559:1`
- Classification: Infrastructure: E2E helper contract
- Evidence and minimal proposed fix: Move utilityLoopsActions.js:294 control-style locator into LoopEntryCard POM; keep selector ownership guards.

## 7. not ok 229 - loop hover evidence moves the real mouse to target geometry without locator scrolling

- Location: `tests/js/e2e-action-production-paths.test.js:4665:1`
- Classification: Infrastructure: E2E helper contract
- Evidence and minimal proposed fix: Replace newly added globalPlayer.playButton.hover() with boundingBox and page.mouse.move; preserve the no-auto-scroll evidence guard.

## 8. not ok 231 - loop creation coverage uses the shared app dialog and POM-owned inline range surfaces

- Location: `tests/js/e2e-action-production-paths.test.js:4727:1`
- Classification: Infrastructure: E2E helper contract
- Evidence and minimal proposed fix: Move utilityLoopsActions.js:294 control-style locator into LoopEntryCard POM; keep selector ownership guards.

## 9. not ok 257 - utility and cover actions consume POM locators instead of constructing selectors

- Location: `tests/js/e2e-performance-helper-guards.test.js:421:1`
- Classification: Infrastructure: E2E helper contract
- Evidence and minimal proposed fix: Move utilityLoopsActions.js:294 control-style locator into LoopEntryCard POM; keep selector ownership guards.

## 10. not ok 356 - Account and Admin navigation keep Users discoverable and omit redundant links

- Location: `tests/js/phase7-account-admin-presentation.test.js:17:1`
- Classification: Fixture: shared navigation macro
- Evidence and minimal proposed fix: Assert/render navigation_tree_item macro instead of old literal button/a regexes; preserve Users/My account/Sign Out links, selection and logout.

## 11. not ok 357 - Admin navigation offers My account instead of unavailable placeholders

- Location: `tests/js/phase7-account-admin-presentation.test.js:25:1`
- Classification: Fixture: shared navigation macro
- Evidence and minimal proposed fix: Assert/render navigation_tree_item macro instead of old literal button/a regexes; preserve Users/My account/Sign Out links, selection and logout.

## 12. not ok 358 - Account navigation identifies the current user settings as My account

- Location: `tests/js/phase7-account-admin-presentation.test.js:30:1`
- Classification: Fixture: shared navigation macro
- Evidence and minimal proposed fix: Assert/render navigation_tree_item macro instead of old literal button/a regexes; preserve Users/My account/Sign Out links, selection and logout.

## 13. not ok 943 - app loader fetches one generated runtime bundle instead of individual runtime modules

- Location: `tests/js/runtime/app-loader-bundle.test.js:108:1`
- Classification: Fixture: module inventory
- Evidence and minimal proposed fix: Add utility-log-history-query.js and utility-log-history-ui.js to expected ordered manifest; retain generated-bundle parity assertion.

## 14. not ok 968 - Backgrounds editor follows black and light draft palettes and panel companions

- Location: `tests/js/runtime/appearance-editor-theme.test.js:67:3`
- Classification: Fixture: approved preview-only draft
- Evidence and minimal proposed fix: Inspect draft tokens on the actual preview; assert editor/live app retain saved theme. Do not restore whole-editor draft recoloring.

## 15. not ok 969 - Backgrounds Cancel restores saved editor colors and mode without changing the app

- Location: `tests/js/runtime/appearance-editor-theme.test.js:84:3`
- Classification: Fixture: approved preview-only draft
- Evidence and minimal proposed fix: Inspect draft tokens on the actual preview; assert editor/live app retain saved theme. Do not restore whole-editor draft recoloring.

## 16. not ok 970 - Backgrounds Reset pins default editor tokens and successful Save alone updates the app

- Location: `tests/js/runtime/appearance-editor-theme.test.js:96:3`
- Classification: Fixture: approved preview-only draft
- Evidence and minimal proposed fix: Inspect draft tokens on the actual preview; assert editor/live app retain saved theme. Do not restore whole-editor draft recoloring.

## 17. not ok 971 - Seekbar editor follows black and light draft palettes and panel companions

- Location: `tests/js/runtime/appearance-editor-theme.test.js:67:3`
- Classification: Fixture: approved preview-only draft
- Evidence and minimal proposed fix: Inspect draft tokens on the actual preview; assert editor/live app retain saved theme. Do not restore whole-editor draft recoloring.

## 18. not ok 972 - Seekbar Cancel restores saved editor colors and mode without changing the app

- Location: `tests/js/runtime/appearance-editor-theme.test.js:84:3`
- Classification: Fixture: approved preview-only draft
- Evidence and minimal proposed fix: Inspect draft tokens on the actual preview; assert editor/live app retain saved theme. Do not restore whole-editor draft recoloring.

## 19. not ok 973 - Seekbar Reset pins default editor tokens and successful Save alone updates the app

- Location: `tests/js/runtime/appearance-editor-theme.test.js:96:3`
- Classification: Fixture: approved preview-only draft
- Evidence and minimal proposed fix: Inspect draft tokens on the actual preview; assert editor/live app retain saved theme. Do not restore whole-editor draft recoloring.

## 20. not ok 979 - palette and companion edits stay in the preview and save one complete preference

- Location: `tests/js/runtime/appearance-palettes.test.js:101:1`
- Classification: Fixture: approved Appearance fields/tokens
- Evidence and minimal proposed fix: Add loop_control_style: 'capsule' to expected aggregate payloads only.

## 21. not ok 982 - Custom player colors copies all effective values and survives palette, panel and background reset

- Location: `tests/js/runtime/appearance-palettes.test.js:136:1`
- Classification: Fixture: approved Appearance fields/tokens
- Evidence and minimal proposed fix: Add loop_control_style: 'capsule' to expected aggregate payloads only.

## 22. not ok 985 - Cancel restores the saved nested player group after edits, resets and palette changes

- Location: `tests/js/runtime/appearance-palettes.test.js:180:1`
- Classification: Fixture: approved Appearance fields/tokens
- Evidence and minimal proposed fix: Add loop_control_style: 'capsule' to expected aggregate payloads only.

## 23. not ok 986 - failed grouped save retains every draft value and retry applies the complete server preference

- Location: `tests/js/runtime/appearance-palettes.test.js:194:1`
- Classification: Fixture: approved Appearance fields/tokens
- Evidence and minimal proposed fix: Add loop_control_style: 'capsule' to expected aggregate payloads only.

## 24. not ok 987 - load failure leaves grouped preferences untrusted until a successful full reload

- Location: `tests/js/runtime/appearance-palettes.test.js:215:1`
- Classification: Fixture: approved Appearance fields/tokens
- Evidence and minimal proposed fix: Add loop_control_style: 'capsule' to expected aggregate payloads only.

## 25. not ok 988 - session clear discards palette and custom waveform group and rejects a late save

- Location: `tests/js/runtime/appearance-palettes.test.js:232:1`
- Classification: Fixture: approved Appearance fields/tokens
- Evidence and minimal proposed fix: Add loop_control_style: 'capsule' to expected aggregate payloads only.

## 26. not ok 990 - automatic, theme, player, and custom outline sources resolve against the effective Appearance

- Location: `tests/js/runtime/appearance-palettes.test.js:272:1`
- Classification: Fixture: approved Appearance fields/tokens
- Evidence and minimal proposed fix: Automatic/player outline now uses effective Play color, not controls.border; preserve theme/custom expectations. Owner confirmed approved token behavior.

## 27. not ok 991 - saved theme application publishes the resolved player-aware interaction outline token

- Location: `tests/js/runtime/appearance-palettes.test.js:307:1`
- Classification: Fixture: approved Appearance fields/tokens
- Evidence and minimal proposed fix: Automatic/player outline now uses effective Play color, not controls.border; preserve theme/custom expectations. Owner confirmed approved token behavior.

## 28. not ok 993 - Harbor Mint saves its companion while retaining custom player colors through reset

- Location: `tests/js/runtime/appearance-palettes.test.js:348:1`
- Classification: Fixture: approved Appearance fields/tokens
- Evidence and minimal proposed fix: Add loop_control_style: 'capsule' to expected aggregate payloads only.

## 29. not ok 999 - Player & Seekbar preserves independent player and waveform tabs when the utility shell remounts the editor

- Location: `tests/js/runtime/appearance-v009-player-isolation.test.js:117:1`
- Classification: Fixture: declaration shape
- Evidence and minimal proposed fix: Existing active tab variables remain outside mount but declaration now also includes loopCreateAllowed; update exact regex or assert remount behavior.

## 30. not ok 1029 - actual Seekbar renderer supplies its color editor host to the shared instance with lazy recovery

- Location: `tests/js/runtime/appearance-waveform-recents.test.js:205:1`
- Classification: Fixture: mounted-tree DOM
- Evidence and minimal proposed fix: Provide realistic list.querySelectorAll/keyed row DOM methods for reconciliation; retain lazy recovery, navigation order and identity assertions.

## 31. not ok 104 - tests\\js\\runtime\\gallery-tree-selection-performance.test.js

- Location: `tests/js/runtime/gallery-tree-selection-performance.test.js:1:1`
- Classification: Fixture: missing runtime dependency
- Evidence and minimal proposed fix: Load/stub matching gallery-main-interactions getFilteredGalleryMainModel owner (exists at line227); retain virtual grid performance assertions.

## 32. not ok 1642 - Appearance navigation uses the compact shared rows in approved order and defaults to Main elements

- Location: `tests/js/runtime/navigation-tree.test.js:83:1`
- Classification: Fixture: mounted-tree DOM
- Evidence and minimal proposed fix: Provide realistic list.querySelectorAll/keyed row DOM methods for reconciliation; retain lazy recovery, navigation order and identity assertions.

## 33. not ok 130 - tests\\js\\runtime\\response-state-helpers.test.js

- Location: `tests/js/runtime/response-state-helpers.test.js:1:1`
- Classification: Fixture: fail-closed capability projection
- Evidence and minimal proposed fix: Expected status at line511 needs allowed_actions:{}; retain all other status normalization checks.

## 34. not ok 2011 - the template loads the persistent shell ownership layer last

- Location: `tests/js/runtime/shell-persistent-player-layout.test.js:90:1`
- Classification: Fixture: stylesheet order
- Evidence and minimal proposed fix: Shared trigger-anchor.css now follows shell stylesheet; assert shell remains after modal/drawer styles rather than absolute final position.

## 35. not ok 2098 - buildUtilityIntegrationDetail renders the local playlist import analyze surface

- Location: `tests/js/runtime/utility-list-builders-local-playlist-import.test.js:77:1`
- Classification: Fixture: superseded unsupported import surface
- Evidence and minimal proposed fix: Load actual shared Button/window and assert approved disabled Import-only surface; remove obsolete Analyze/Preview UI expectations.

## 36. not ok 2099 - buildUtilityIntegrationDetail renders returned local playlist preview status

- Location: `tests/js/runtime/utility-list-builders-local-playlist-import.test.js:115:1`
- Classification: Fixture: superseded unsupported import surface
- Evidence and minimal proposed fix: Load actual shared Button/window and assert approved disabled Import-only surface; remove obsolete Analyze/Preview UI expectations.

## 37. not ok 2373 - removed mutation owner keeps its scrim until the nearest previous survivor detail is hydrated

- Location: `tests/js/runtime/utility-problematic-focused-track-render.test.js:391:1`
- Classification: Fixture: DOM/controller contract
- Evidence and minimal proposed fix: Add fake FilterButton.setAttribute for actual renderer; preserve mutation-owner scrim and hydration assertions.

## 38. not ok 2377 - empty log history visibly explains session-only storage and keeps export explicit

- Location: `tests/js/runtime/utility-problematic-focused-track-render.test.js:690:1`
- Classification: Fixture: DOM/controller contract
- Evidence and minimal proposed fix: Replace obsolete session-only log expectation with scoped persisted history/query empty and explicit export; load actual query controller seam.

## 39. not ok 2590 - foundation validator enforces the approved portable and Windows gate contract

- Location: `tests/js/validate-foundation-gates.test.js:81:1`
- Classification: Infrastructure: discovery/ownership drift
- Evidence and minimal proposed fix: Reconcile latest frozen case discovery, approved matrix and exact shard ownership; update obsolete 138/97/15/30 totals without weakening completeness or uniqueness.

## 40. not ok 2591 - functional shard contract pins the approved four-way 97-case assignment

- Location: `tests/js/validate-functional-shards.test.js:87:1`
- Classification: Infrastructure: discovery/ownership drift
- Evidence and minimal proposed fix: Reconcile latest frozen case discovery, approved matrix and exact shard ownership; update obsolete 138/97/15/30 totals without weakening completeness or uniqueness.

## 41. not ok 2594 - validator accepts the exact approved ownership and rejects every ownership drift class

- Location: `tests/js/validate-functional-shards.test.js:149:1`
- Classification: Infrastructure: discovery/ownership drift
- Evidence and minimal proposed fix: Reconcile latest frozen case discovery, approved matrix and exact shard ownership; update obsolete 138/97/15/30 totals without weakening completeness or uniqueness.

## 42. not ok 2605 - all four shards use explicit effect-compatible wave budgets

- Location: `tests/js/validate-functional-shards.test.js:713:1`
- Classification: Infrastructure: discovery/ownership drift
- Evidence and minimal proposed fix: Reconcile latest frozen case discovery, approved matrix and exact shard ownership; update obsolete 138/97/15/30 totals without weakening completeness or uniqueness.

