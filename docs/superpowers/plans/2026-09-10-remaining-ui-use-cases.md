# Remaining UI — review use cases and acceptance matrix

Date: 2026-09-10. Companion to the [implementation plan](2026-09-10-cover-look-up-and-remaining-ui-implementation.md). These requirements consolidate the conversation; final explicit corrections supersede earlier rejected sketches. All cases are proposed real-app acceptance coverage, not claims of implementation or passing tests.

Evidence types: **C** component/browser interaction; **U** unit/service contract; **I** Postgres/API integration; **M** owner manual. Add functional E2E only after the approved test proposal and real-build acceptance. Each ID maps to the task named in its group. Test disabled/denied behavior using actual policy projections and server enforcement; do not infer permissions from screen names.

## Shared controls — Tasks 2–3

| ID | Scenario and required result | Evidence |
| --- | --- | --- |
| UI01 | Find Better Art and Save visibly primary through restrained dark solid fill; Cancel remains secondary. No bright white replacement in dark neutral theme. | C,M |
| UI02 | Hover every non-playback control, including Renumber and Browse Library: subtle effective player-derived fill/edge transition, no residual bright-green rule. Change player to a non-green color and verify derivation. | C,M |
| UI03 | Error/destructive buttons, labels and interactive objects keep reddish hover/pressed/focus in every theme; Discard never acquires green/player edge. | C,M |
| UI04 | Checkbox/radio checked states use subdued neutral styling with readable check/dot; pointer/keyboard/disabled and forced-colors remain usable. | C,M |
| UI05 | Empty search exposes Search; populated plain search exposes Search then Clear; filter variant exposes Search, Filters then Clear. X always rightmost. | C |
| UI06 | Clear empties and returns input focus; Filter opens its own panel, never another example's; Enter searches. Shared outer focus encloses input/actions. | C,U |
| UI07 | Select chevron graphic center aligns with control centerline at normal/zoom/narrow sizes; text-glyph baseline does not shift it. | C,M |
| UI08 | Clicking labels, headings or clickable text produces no blinking caret. Text selection/copy and real input editing remain functional; keyboard focus stays visible. | C,M |
| UI09 | Same scrollbar family appears in all main/admin/login/settings/list/table/menu/modal/notification overflow surfaces, with no clipping or nested scroll regressions. | C,M |
| UI10 | Keyboard focus is distinct from hover; reduced motion disables unnecessary travel/animation; disabled controls cannot activate. | C,U |
| UI11 | Outlines on: existing resting action-button surface and border everywhere. Off: bare icon like folded tree/Search/Settings, with quiet hover and retained hit target/focus. No mixed library-button-only outline. | C,M |
| UI12 | Action showcase styles map to actual gallery lookup, header close/edit/folder and app/gallery bar actions; theme supplies colors. Existing player/loop/compact/docked playback remains unchanged. | C,M |

## Dropdowns and tabs — Tasks 3, 8

| ID | Scenario and required result | Evidence |
| --- | --- | --- |
| DD01 | Select-input dropdown opens with regular neutral full frame, no connected dissipating color treatment. | C,M |
| DD02 | Hover Album/EP/Single or any menu row: neutral fill with no green outline. Keyboard option focus/selected check remain visible. | C |
| DD03 | Arrow/Home/End selection, Enter/Space commit, Escape/outside dismissal and focus return work without accidental activation; disabled entries skipped. | C,U |
| DD04 | Library status is an app-bar anchored dropdown, not a modal header/card. Existing resting action design and outline preference apply. | C,M |
| DD05 | Connected menu top edge visible and continuous outside trigger opening; divider never crosses button; no offset/doubled line. Resize/zoom/scroll/upward flip recomputes geometry. | C,M |
| DD06 | Status entries reflect idle/running cover/library jobs and permissions: Full Rescan or Go to Scan Page, Fetch or Cancel Covers. Context/keyboard access works; denied action does not mutate. | U,I,C |
| TB01 | Tabs touch: zero gaps, established settings branch geometry, no new visual system. | C,M |
| TB02 | Active contour joins content and fades as established; selected tab has no stray bottom divider. Resize/activation keeps edge aligned. | C,M |
| TB03 | All six Settings destinations remain separate, keyboard-operable and unhindered by invisible header overlays. Navigation retains content state. | C,M |

## Artist Tree and real main-page layout — Task 4

| ID | Scenario and required result | Evidence |
| --- | --- | --- |
| NAV01 | Expanded Artist Tree remains exactly the existing component with current rows/counts/selection. Collapse sits before Artists; no replacement nested sample tree. | C,M |
| NAV02 | Folded rail is neutral/light and contains only Artist Tree, independent of Settings. No green filled rail or utility shortcuts. | C,M |
| NAV03 | Folded symbol is the approved fine-lined many-branched bare tree, inspired by Gondor, not a pine or hierarchy diagram. Respects outline preference. | C,M |
| NAV04 | Folding actually shrinks sidebar allocation and moves main content left; no empty column/overlay remains. Gallery fills freed width and gains columns only when sizing permits. | C,U,M |
| NAV05 | Expand restores width/artist state; current search/filter, artist selection and scroll/visible album anchor survive both directions. | C,U |
| NAV06 | Reflow respects existing gallery-size setting and responsive/virtualized behavior; no hardcoded 4/5 columns or eager duplicate cover loads. | C,U,M |
| NAV07 | Pointer/keyboard toggle, focus handoff, narrow viewport, repeated toggles and reduced motion remain usable; no leaked observers/listeners. | C,U |
| NAV08 | Preserve real app bar, gallery bar, card design, typography, spacing, theme and persistent player before/after folding. Full-page mock's liberties are explicitly not approved replacements. Audio/player identity is stable. | C,M |

## Album details and cover discovery — Task 5

| ID | Scenario and required result | Evidence |
| --- | --- | --- |
| ART01 | Existing modal width, art/table relationship, track row geometry and total strip remain intact except approved action-column removal. Album information becomes shared components. | C,M |
| ART02 | Click/Enter/Space artwork opens full size. No dedicated full-size icon in Album Details; cover lookup/fast fetch are independent overlay controls. | C |
| ART03 | Hover, keyboard focus and supported touch expose usable art actions without activating enlargement or shifting layout. | C,M |
| ART04 | Existing gallery/action/album components are reused; missing/loading/unavailable art never implies a valid enlargement. | C,U |
| COV01 | Header, compact gallery cards, sections/dividers, body and footer use shared families and existing compact density/glow. | C,M |
| COV02 | Whole candidate card selects; separate zoom action opens full size without changing selection. Current selection retained through unrelated updates. | C,U |
| COV03 | Every displayed image subsection shows N images, including singular and zero local counts. No unexplained Current source label. | U,C |
| COV04 | Local covers always visible, including empty message. Empty remote/possible sections absent. Initial not-searched and completed-no-results are distinct. | U,C |
| COV05 | Titles can wrap while provider marks/names align across cards. Apple/Spotify/Deezer/Bandcamp/Discogs/CAA/YouTube Music use recognizable reviewed assets and readable labels. | C,M |
| COV06 | Find Better Art is dominant, single default action above results; Save is affirmative and Cancel secondary in footer. No review placement toggle in product. | C,M |
| COV07 | Google/Yandex indicate external navigation with trailing logo and external marker; query uses current album artist/title/year, correctly encoded. No manual query field. | U,C |
| COV08 | Compact memo grows as needed and accepts paste/drop/picker images; Add Image opens picker when appropriate; removable thumbnails retained until discarded/saved. | C,U |
| COV09 | Direct image and album links use current supported processing; unsupported inputs fail visibly without losing valid draft items. No redundant helper line below input. | U,I,C |
| COV10 | Save persists authorized selected cover; Cancel leaves original intact; failures/conflicts retain draft and allow retry. No write from mere selection/enlargement. | I,C |
| COV11 | Rapid switching of albums cannot show/save another album's asynchronous candidates or external query; stable album IDs used throughout. | U,I,C |
| COV12 | Partial/provider failure, no results, loading, remote-image failure and retry remain truthful; local covers not hidden by failure. | U,I,C |
| COV13 | Narrow layout keeps cards/actions usable; no copied mock data, paths or credentials; actual provider jobs/capabilities/media validation preserved. | I,C,M |

## Notifications and dialogs — Task 6

| ID | Scenario and required result | Evidence |
| --- | --- | --- |
| NTF01 | Sliding notification panel has shared header/controls/cards; running/completed/failed/empty states and elapsed/progress are visible. | C,U |
| NTF02 | Entire notification activates its specific album's Cover Look Up by click/keyboard; label is Open Cover Look Up. | C,U |
| NTF03 | Retry/Clear remain separate actions and do not bubble into album navigation. Failed retry stays failed until real state changes. | C,U,I |
| NTF04 | Closing panel does not cancel jobs; reopening restores authoritative task status. Clear completed leaves running tasks intact. | I,C |
| NTF05 | Removed/unauthorized album and stale task handles fail safely; no cross-account/task disclosure. | I,U |
| NTF06 | Scrolling, live updates, elapsed timer and reduced-motion progress clean up when unmounted; no duplicate subscriptions. | C,U |
| DLG01 | Shared lightbox opens from valid artwork, supports existing full-size behavior, Close/Escape and focus restoration. | C |
| DLG02 | Loading/missing/unavailable/error art states remain explicit; child viewer closure preserves parent draft/selection. | C,U |
| DLG03 | Confirmation is content-sized with less dead space, existing outer frame and no header/body/footer horizontal dividers. | C,M |
| DLG04 | Keep editing/Cancel preserves changes; Discard only discards intended draft with red-family interactions. | C,U |
| DLG05 | Alerts fit message/action content, wrap on narrow screens and keep Retry adjacent. Preserve other section dividers/toast semantics. | C,M |

## Edit Tags — Task 7

| ID | Scenario and required result | Evidence |
| --- | --- | --- |
| TAG01 | Real current form remains unchanged in fields/layout/density/validation, including fields absent from mock. Every input/element uses shared components. | C,M |
| TAG02 | Current compact filename list with trailing format badge; no added headers/index/format rows. Selected accent is far left of whole row before grip. | C,M |
| TAG03 | Filename drag-sweep selects contiguous tracks; Ctrl/Cmd toggles/adds and Shift range uses anchor; multi-selection/mixed values stay correct. | C,U |
| TAG04 | Small separate grip reorders; hovering grip has no outline. Filename selection never starts reorder and grip drag never changes selection accidentally. | C,U |
| TAG05 | First-to-last drop on lower half of final row and below list both work. Last-to-first and middle insertions work; cue shows intended boundary. | C,U |
| TAG06 | Same-position drop, outside drop, Escape, dragend and aborted drag leave valid order and no stale cue/opacity. | C,U |
| TAG07 | Selection uses stable IDs through reorder; form values/anchor remain consistent; accessible reorder path available. | C,U |
| TAG08 | Numeric footer input/Renumber retain actual behavior and validation; Renumber gets shared muted hover. Reorder/renumber obey existing Save transaction. | C,U,I |
| TAG09 | Save, optimistic refresh, failure/rollback and unsaved confirmation preserve real data semantics. Cancel changes no persisted tags. | I,C |

## Library Scan — Task 8

| ID | Scenario and required result | Evidence |
| --- | --- | --- |
| SCN01 | Scan is a FullPage in main content replacing Gallery. No nested artist tree, app bar, Album Haven/search/revert row, player or modal. Actual outer shell remains intact. | C,M |
| SCN02 | Simple back arrow immediately left of Library Scan; no horizontal divider below title. | C,M |
| SCN03 | Active text exactly Scanning the library, with better restrained spinner and real file/folder/elapsed/ETA values when known. No Discovering music files replacement heading. | C,U |
| SCN04 | Compact map shows real scan phases, not informational middle panels. Earlier reached steps stay bright when next starts; current distinct, future dim. | C,U |
| SCN05 | Initial load, discovery, scanning, covers, relations, full rescan and completion/idle have truthful status. Completed phases cannot regress from out-of-order events. | U,I,C |
| SCN06 | Browse Library/Back opens available library while job continues. Cancel is a separate quieter action, placed below continuation; neither navigation nor panel closure cancels implicitly. | C,I |
| SCN07 | Cancel enters pending state until server acknowledges; repeated activation does not duplicate cancellation. Cancelled view distinguishes partial results from complete. | U,I,C |
| SCN08 | No music, errors and recoverable failures show appropriate feedback/actions; no empty checkbox or empty alert box. | C,U |
| SCN09 | Browse Library has visible subtle hover transition, reduced-motion alternative and keyboard focus. | C |
| SCN10 | State-preview tabs/selectors, fabricated progress and status cards are absent from product. Existing scan services/capabilities stay authoritative. | C,I |
| SCN11 | Scan/browse/status updates do not remount/redesign/interfere with player. Long-running work unsubscribes cleanly and status is restored on returning. | C,U,M |

## Appearance — Task 9

| ID | Scenario and required result | Evidence |
| --- | --- | --- |
| AP01 | Preserve current Appearance navigation tree, five editor sections, layout/previews/Save/Cancel. No separate modal or replacement editor. | C,M |
| AP02 | Web / Desktop, Mobile, TV selector uses professional neutral styling, not green selected buttons. | C,M |
| AP03 | Every Mobile/TV tab offers Follow Web / Desktop first and Customize second. Follow is default for new sections and hides all editor details below it. | C,U |
| AP04 | Customize reveals unchanged controls for that device/tab; another tab can still follow. Tab/profile navigation preserves each draft mode/value. | C,U |
| AP05 | Later saved base changes update all following sections; customized sections stay independent. Switching modes follows technically approved dormant-value rule. | U,I,C |
| AP06 | Appearance is saved per account/device type and restored on other same-type devices. Base migration preserves every existing preference, especially player overrides. | I,U |
| AP07 | Action button outlines persists and inherits through interaction section. All matching actions agree; keyboard focus and connected-menu contour remain usable in bare mode. | I,C |
| AP08 | Save commits aggregate draft; Cancel restores saved values even after visiting several profiles/tabs. Failed/stale revision preserves draft for reconciliation. | I,U,C |
| AP09 | Another user cannot read/write preferences. Cross-device editing eligibility follows explicitly approved server policy, never client-only hiding or guessed role names. | I |
| AP10 | Native app support is not implied by device profile labels. Required web layouts and touch inputs are verified; unsupported native actions remain unavailable. | C,M |
| AP11 | No old apply-to checkboxes, disabled-but-visible followed editor, inert iframes or localStorage persistence reach production. | C,I |

## Governance and whole-app adoption — Tasks 1, 10

| ID | Scenario and required result | Evidence |
| --- | --- | --- |
| GOV01 | Every remaining brief item mapped to existing implementation, reusable extension or explicitly deferred technical gate; completed Settings work reused, not duplicated. | M |
| GOV02 | Problematic/Loops art/info/tables and wide navigation across all Settings destinations use approved families while preserving their established screens. Rejected combined utility redesign does not ship. | C,M |
| GOV03 | Global adoption covers main/admin/login, headers, footers, modal bodies, inputs, scrollbars, search, dropdowns and actions. Spot fixes alone do not satisfy the shared-style requirement. | C,M |
| GOV04 | Component and permission registries, case index/area docs, future-plan governance and migration tracker agree; no page-local primitive without reusable catalog mapping. | M |
| GOV05 | Approved mock hashes retained; production manual acceptance, test results and release approval recorded separately. No unreviewed capability/native support claim or player redesign. | M |

## Existing case-area references

Reconcile these IDs into the existing private functional index and area files during Task 1, avoiding duplicate scenarios:

- [App shell/shared components](C:/Repositories/album-haven-internal/docs/functional-test-cases/app-shell-and-shared-components.md)
- [Cover fetch / lookup](C:/Repositories/album-haven-internal/docs/functional-test-cases/cover-fetch-and-cover-lookup-gallery.md)
- [Gallery startup/performance](C:/Repositories/album-haven-internal/docs/functional-test-cases/gallery-startup-and-performance-sensitive-browsing.md)
- [Settings problems/suggestions](C:/Repositories/album-haven-internal/docs/functional-test-cases/settings-problems-and-suggestions.md)
- [Users/permissions](C:/Repositories/album-haven-internal/docs/functional-test-cases/users-and-permissions.md)

Use the private index to resolve current owning Edit Tags, scan and Appearance area files before writing them. This public planning matrix is review traceability, not a substitute for that registry. No functional E2E coverage is claimed complete here.
