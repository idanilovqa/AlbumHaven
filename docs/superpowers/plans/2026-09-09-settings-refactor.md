# Settings and Player Refinement Implementation Plan

## Owner validation update — September 12, 2026

The owner asked to stop agent-led broad browser validation, finish the mockup implementation first, and hand the complete Settings version back for their own visual validation. This supersedes the delegated manual-validation requirement below for remaining checks. Finish witnessed defects already under repair and their focused checks; do not start additional manual or comprehensive browser waves before this handoff. Preserve the recorded failures and distinguish implemented behavior from final acceptance. Full regression and publication gates remain unfulfilled, not waived or reported as passing. No merge, push or publication; preserve Gallery and all original uncommitted work.

## Owner workflow override — September 9, 2026

The owner subsequently instructed the orchestrator to perform the manual validation, continue through all remaining Tasks 3-9, and present the completed work for one final owner review. This explicit instruction supersedes intermediate owner manual-acceptance stops throughout this plan and its linked checkpoint/report, including older per-slice wording retained as history. The orchestrator must still execute and record each slice's exact real-app manual checks before dependent progression. Approved test-first work, focused checks, builds, independent reviews and required regression/E2E checkpoints remain in force. No merge, push or publication is authorized. Preserve the original uncommitted work. Do not request the same per-slice approval again.


> **For agentic workers:** Use the executing-plans skill to implement this plan task by task. Checkbox steps track delivery. The owner's subsequent explicit implementation request authorizes runtime changes; publication is excluded.

**Goal:** Implement the final Settings/Utilities and player requirements approved throughout the September 8–9 conversation.

**Architecture:** Extend the current Utilities shell, existing shared components and playback controllers. Keep mutations and durable state behind authorized APIs and Postgres repositories. Mock samples and DOM-only interactions are visual references, not production behavior.

**Tech Stack:** Existing browser JavaScript, CSS, templates, generated runtime bundle, FastAPI/ASGI, Postgres, Node tests, Python tests and Playwright. The owner's explicit instruction is “use current stack”; do not introduce a framework migration.

## 1. Authority and implementation status

Branch: `2026-09-08-settings-refactor`, derived from `gallery-refactor`. Preserve existing work. No merge, push, deployment or release is authorized for this implementation request.

Owner approval: “All mocks approved.” Exact visual artifacts are under `docs/design-mockups/screens/utilities-refactor/v002/`. `navigation.html` is the final six-tab reference; prefer it over older `index.html` where they differ. `play-loop-options.html` contains both approved player variants. `appearance-0.html` through `appearance-4.html` capture existing editors, not replacement implementations. `review.json` records approval and `approved-artifacts.json` fingerprints the approved assets. Inspect final `revision-v003.js`, `navigation-v003.css`, `revision.css`, `play-loop-refinement.css`, `capsule-hover-delay.js` and `loops-capsule.*` alongside the rendered artifacts.

The original pasted handoff provides context; later explicit user decisions supersede it. Its proposed title, counts, checkbox column, Add loop action and timezone section must not return. Visual approval does not imply backend contracts or live manual acceptance. Sample artwork, statistics, credentials, paths and proposed metadata are not production fixtures. Do not ship inert Appearance iframes, fake folder trees or toast-only save operations.

The prior saved-loop plan (`docs/superpowers/plans/2026-09-06-saved-loop-player.md`) contains older no-glow/fixed-design instructions: this newer A/B visual approval supersedes those cosmetics while preserving its audio/waveform obligations. The existing persistent shell plan (`2026-09-02-persistent-settings-shell.md`) remains relevant to lifecycle ownership.

Technical approval: on September 9, 2026 the owner replied `approve` to the explicit approval question for [Task 1 technical checkpoint](2026-09-09-settings-refactor-checkpoint.md). Its decisions and capability mapping are accepted. Current-stack implementation is explicitly authorized; preserve all initial uncommitted work. Approval does not substitute for each slice's live manual acceptance.

## 2. Global constraints

- Reuse the registered Header, TabBar, NavigationTree, SearchInput, anchored dropdown, Button/icon Button, Input, CompactDataTable, labels, Artbox, SectionSeparator, Modal, scrollbar, ConsoleLog, Loop and PlaybackControlCluster families. Do not copy frozen mock components into live runtime.
- Map extensions to the private `docs/ui-component-system.md`; record actions, scope, role-preset membership, deployment and client constraints in `docs/permissions-and-capabilities.md` before technical approval.
- All colors and interactions derive from shared theme tokens. Preserve keyboard operation, disabled behavior, reduced motion, selection and copying. Final caret request suppresses blinking carets everywhere in these surfaces, including inputs, while keeping editing functional and focus discernible.
- Durable settings, rules, loop order, roots, history and statistics are Postgres-backed. No JSON/file fallback, process-global durable state, mock query-string capability flag or client-only authorization.
- Preserve existing streaming audio architecture, waveform rendering/style, seek, pitch, speed, repeat, loop expiry and save flow. The player redesign changes presentation and reveal timing, not the audio engine.
- Existing Appearance flow and subelement locations remain intact. LAN serving was a review convenience, not a product feature; VPN/firewall changes and Sites deployment are outside implementation scope.

### Local delivery boundaries and safe split — September 12

The owner's no-merge/no-publication instruction remains authoritative. Gallery development has its own worktree; continue only in the existing Settings worktree. Preserve its separate owner edit to `gallery-main.css`. Do not switch, reset, clean, stash, commit or amend the Gallery worktree.

The accumulated Settings branch is not one proposed release. Preserve its existing Task 2–4 commits and separate the remaining outcomes in dependency order:

| Unit | Outcome and included checks | Prerequisites and acceptance | Compatibility and rollback | Merge/publish checkpoint |
| --- | --- | --- | --- | --- |
| Saved-loop order | Task 5/L05, source artwork/year and surviving player/tree identity | Committed player slice; scoped order/concurrency tests; native L02, reload and playback continuity | Additive scoped order storage; existing default order retained; revert only the unit's reviewed changes, never drop saved media | Local verified checkpoint only; publication not authorized |
| Captured log history | Task 6/H01–H03, scoped periods, console and matching export | Shared shell; authorized snapshot/query tests; actual H03 download | Additive version storage; preserve log rows and permission checks on rollback | Local verified checkpoint only; publication not authorized |
| Integration settings | Task 7/I01–I08, host roots, measured statistics, honest import/help states | Approved host/capability model; root and listening service tests; actual I01/I02 and measured-play manual evidence | Preserve root configuration and files, measured ledger and credentials; revert UI/service changes without deleting persisted data | Local verified checkpoint only; publication not authorized |
| Account Appearance | Task 8/A01–A03/B08, Harbor Mint and gated persisted player style | Committed shared player; account revision/grant tests; touch A01, limited member and cross-surface validation | Default capsule and existing palettes remain supported; retain additive stored preference data | Local verified checkpoint only; publication not authorized |

Task 9 regression tests, ownership mappings and documentation belong with the behavior they verify. Shared regression infrastructure or pre-existing compatibility repairs require a separate tested foundation checkpoint when they cannot be assigned to one outcome. All units retain the required final comprehensive regression and delegated manual acceptance.

Safe extraction procedure: freeze and fingerprint the accumulated Settings files; map overlapping runtime, bundle and test hunks to the units above; construct dependency-ordered local candidate commits with each unit's implementation, tests and documentation together; regenerate the bundle and verify each candidate before accepting its boundary. Do not divide by file count or silently include another outcome's hunks. Preserve the original accumulated files until content equivalence is checked. Any preservation checkpoint is not a release claim. Do not rewrite existing history, auto-publish, or manipulate Gallery changes to achieve the split.

Read-only extraction review confirmed the 37-file Task5 snapshot matches its recorded hashes; 21 files contain later changes and must not be reverted to that snapshot. CSS and API import hunks mix multiple outcomes, so ordinary whole-hunk staging is insufficient. Prefer candidate order shared compatibility foundation, saved-loop order (0063), captured logs (0064), Appearance (0065/0066), then Integrations (0067), preserving migration order without renumbering or changing applied bytes. Final ownership/test manifests must be refreshed after active authors finish.

## 3. Final requirements and use cases

### S — Shared shell, tree, search and artwork

S01. Six connected tabs: Problematic files, Rules, Loops, Log History, Integrations, Appearance. Remove Utilities title/subtitle and put tabs at the top within the shared header composition. Close is upper-right. No invisible header hit area may block tabs.

S02. Selected tab joins the main body without a bottom divider. Its themed blueish outline dissipates down its sides and continues along the body divider on both sides. Recompute alignment on resize/tab changes; preserve keyboard focus and narrow-layout usability.

S03. Remove the tab-name/count heading above every left search and move contents up. Search is the existing component. Integrated Filters opens the shared anchored dropdown, not a popup modal or native select. Anchor hover, outline and animation match the app.

S04. Wide NavigationTree is an extension of the existing component, preserving motion, hover and selection. Album/folder rows show Artbox, title, smaller band/artist and year if available; track count belongs in the hidden secondary column. Do not invent unknown years.

S05. All apparent album art uses Artbox. Missing artwork uses the shared crossed-disc state. Available artwork opens full size from both Problematic files and Loops headers. Missing art must not imply an enlargement. No green Artbox hover outlines; retain neutral keyboard focus. Text selection and copying work without random blinking carets anywhere, including embedded-looking content.

### P — Problematic files and Suggested edits

P01. Album information and album-level problem labels precede one full-width Detected problems table. Preserve applicable contextual actions as shared icon buttons: Open in Explorer, Edit Tags, Fetch Cover, Find on Discogs, using their existing capabilities/client support.

P02. Exactly three content columns: Track / file, Problems, Suggested edits. No checkbox column or separate album/track problem boxes. Distribute available width, eliminate dead space at the left, and left-align wrapped labels consistently. Check Rules table density too.

P03. Problems are error labels: reddish hover/outline, selected and disabled treatments from themes. Drag-across selects only the same problem type. Album-header selection selects that type across applicable tracks. Cover-art problems stay at album level, never in per-track rows.

P04. Filters initially have no selections, meaning all types. Selecting types filters to their union; clearing all restores all. Filter rows have neutral gray themed overlays, not red hover fills or stacked fighting outlines. Search/filter combine and retain valid navigation context.

P05. Suggested edits is always a column, not a button. Every displayed label is actionable and concise, showing field plus actual current → corrected value: `Artist: JosÃ© → José`, `Year: missing → 2008`, `Track: missing → 04`. These are examples only. No verbose source explanation, “Sample matching release metadata,” “no reliable suggestion,” or inert cover-art proposal.

P06. Automatically offer reliable encoding corrections, year inference, track-number inference and any other supported existing problem type where evidence justifies a correction. Inventory the whole existing problem catalog and record a reliable source or no-proposal result for each type. Encoding transformations must be unambiguous/reversible; year and numbering must have trustworthy metadata/order evidence. Uncertain or unavailable evidence means no proposal. Generation never writes tags.

P07. Suggested labels use positive greenish/neutral-gray theme tokens and independent selection. Click toggles one proposal; drag locks to the originating field/problem type. Dragging Year across Artist or Track cannot select those. A pointer click must not leave a persistent hover outline after exit; keyboard focus remains accessible.

P08. Create Exception is adjacent to Apply, visibly differentiated with muted error styling, no dropdown arrow and no extra surrounding helper text. It acts on selected problems/targets, not selected suggestions. Confirmation names the affected targets and effect. Success refreshes problems and Rules; failure preserves actionable state.

P09. No selected proposals: button says Apply All and applies eligible visible proposals. Explicit selections: says Apply and affects only those proposals. Hidden filtered proposals are not silently included. Use the existing confirmed tag-edit workflow; revalidate permissions and original values/revisions before writing. Partial failures identify unresolved targets and retain them; successful proposals disappear without removing unrelated issues.

P10. Key use cases: fix only year; fix only encoding; select a matching type across tracks; apply all visible; create album/track exceptions independently; retry failed/stale edits; open art without changing selection. Corrections never implicitly create exclusion rules.

### R — Rules

R01. Shared shell/search, left rule-type navigation including Version exceptions and Problem exclusions, right type heading/brief explanation and full-width reusable table. Identify target album/folder/track; use Artbox for artwork.

R02. Each row offers Revert rule. Shared modal title `Revert rule?`, explicit target/effect, actions No / Yes. No does nothing; Yes performs the existing authorized mutation and refreshes counts and affected problem/version state. Failed revert must not appear successful.

### L — Saved loops

L01. Parent songs extend NavigationTree. No drag icon before song name. Double-click expands/collapses children with correctly centered rotating chevron and a discoverable keyboard/explicit expansion path. Preserve applicable parent drag behavior without inventing cross-song loop transfer.

L02. Children are indented items with drag grip, name and duration; no nested table header or “saved loops” text above them. They are not individually selectable or highlighted: all loops for the selected song appear in the main area.

L03. Main loop panel contains grip, user-assigned name, right-side `Original timestamps` start/end in original-song coordinates, and red trash. Current/total playback time stays at the right. No pencil, X deletion or Add loop action; new loops here come only through slicing. Player controls belong to the loop component/footer.

L04. Full panel border including first top edge, enough padding to avoid clipped trash/glow. Keep current waveform style, pitch/speed/repeat and playback flow. No fake waveform/sample audio in production.

L05. Drag displays a move state and insertion cue at the intended boundary; dropping animates neighboring panels into the new order and synchronizes the tree. Persist order through tab/song changes and reload. Cancel, outside/same-position drop and failed persistence remove cues and retain/restore valid order. Reduced motion retains the cue without travel animation. Reordering must not restart audio or lose a pending loop edit. Provide equivalent accessible reordering through the shared component contract.

L06. Delete uses shared red icon Button and confirmation Modal. Cancel changes nothing. Confirm deletes only the authorized named loop and reconciles counts, tree and playback through current behavior.

### B — Player designs and exact interaction timing

B01. Retain both styles. A: Joined capsule encapsulates Play, grows right with close-set scissors/X. B: Companion button is a small capsule joined by a curve to Play; its top meets Play centerline and curved left connection reaches Play bottom center. B's X is smaller than its scissors.

B02. Normal-scale reference: A Play 48 px in 56 px shell; idle-revealed width 90 px, editing width 123 px, action slots 32 px, glyph boxes 26 px. B Play 52 px; pod begins at left/top 26 px, height 26 px, idle/edit widths 58/88 px; scissors 22 px, X 18 px. Inspect approved geometry rather than enlarged-demo scaling.

B03. Waveform centerline equals Play centerline. Both variants expand over the waveform, never shift it or change its width/style. Add bottom padding for downward extension. Glyphs and dissipating glows must remain visible and unclipped.

B04. Idle pointer enters Play: start 300 ms reveal timer. Exit before expiry cancels reveal. After expiry show scissors; moving within the compound perimeter does not restart timers. Leaving while scissors has not been pressed hides immediately, without the editing grace period.

B05. Click scissors: enter the existing range-selection flow and expand into scissors to save plus X to cancel. Exit while creating a loop: 500 ms folding delay. Return before expiry cancels folding. Expiry hides back to Play without cancelling selection/range. Hover Play during an active edit reveals save/cancel again immediately, without the initial idle delay.

B06. Save scissors proceeds to the actual existing save/create UI, not a mock toast. X cancels through existing semantics. Preserve Play/Pause in all states, busy/disabled handling, expiry and retryable save failures. Dispose reveal/fold timers on unmount, song/tab changes, cancel/save and capability loss. Mouse focus must not pin the capsule open. Keyboard focus must provide discoverability; touch needs an explicit usable reveal path before claiming support.

B07. Idle scissors hover retains shaded background. B fills the curved join too, not just its rectangular button area. Expanded actions have no solid rectangular hover background: scissors itself glows green; X stays neutral at rest and turns saturated bright red on hover. Both have broad soft outward-fading glows, controlled by theme tokens. The latest request overrides older pale-pink/permanent-red/no-glow designs.

B08. Appearance → Player & Seekbar adds A/B choice without moving existing subelements or changing Save/Cancel/Reset. Persist using account Appearance settings and apply to applicable shared players, including Loops. Only users with effective loop-create capability see it (owner's musician/practice context); never infer authority from a role-name string. Without capability, also remove unavailable loop actions. Proposed migration default is A, matching the integrated mock; confirm in technical review.

### H — Log History

H01. Keep individual event navigation and useful event/source/time metadata. Right content is the approved terminal-like ConsoleLog: monospace, green success lines and white/gray others, reusable scrolling, large-output support and copying.

H02. Search filter supports a period. Applying it creates a temporary descriptive query entry in the tree; selecting it shows all matching authorized logs chronologically in one console. Clear removes query entry and restores normal navigation. Cover empty results, reversed range and stable same-timestamp ordering. Define timezone/boundaries explicitly; removing the misplaced Last.FM timezone control does not remove timestamp conversion requirements.

H03. Preserve Export log and Export all logs from the handoff. Export all opens the shared filter modal: Today/7 days/30 days/Custom dates, log types, source, Cancel / Export logs. Console and export use the same authorized filtering contract. An include-paths option is allowed only with explicit path-disclosure authority; no credentials/tokens/private raw paths leaked. Bound/page/stream large queries and exports.

### I — Integrations

I01. Left entries: Library, Scrobbling, Foobar2000, Import Local Playlist. Preserve the existing general section layout and shared inputs/buttons/dropdowns.

I02. Scrobbling: simple Last.FM section with existing connect/disconnect flow, Scrobbled/Queued counts and green Connected status spaced away from heading, check vertically centered. Remove misplaced timezone section, redundant “account connected” input and extra verbiage. Do not invent a new credentials flow.

I03. Playback statistics contains Local playcount and Total listening time using real account-scoped local history, distinct from Last.FM counts. No sample 1,248/86-hour values. Before implementation define qualifying plays, actual listened-time accumulation versus nominal track duration, seeks/repeats/loops, imported histories, duplicates and multiple devices. Prefer existing listen-history semantics; imported counts must not be treated as measured duration without evidence.

I04. Library supports several paths each for Main Library, Hoard (unlistened music), New Arrivals (incoming music). Paste/edit path or choose a folder repeatedly. Folder-icon action is inside input; red trash is inside the same shell. Equal row widths, no Browse word, no inner dividers/outlines between text/actions, one outer focus treatment. Accessible icon names are required.

I05. Browse opens a real supported folder picker for local/NAS locations, not Computer/NAS buttons and fabricated Albums/Unlistened/Incoming folders. Distinguish server library roots from browser file uploads. Cancel is no-op; invalid, inaccessible, duplicate and overlapping roots need defined handling. Keep machine-specific paths out of source. Removing a root does not delete music. Reconcile indexing/watchers only after successful authorized save, not on each keystroke.

I06. Foobar2000: SQLite DB path; history format selector using the shared dropdown, not native browser styling; Import button. Formats represented in the approved mock are Playback Statistics XML, Text Tools — standard, Text Tools — enhanced. Reconcile actual existing parser support rather than inventing “two regular log formats” from an early guess.

I07. Read setup instructions is left-aligned and clearly named. Wide agreement/document-reading Modal, about 1000 px max and viewport responsive; fixed header/footer with Close and one shared scrolling content area. No tiny window, nested iframe/double scroll or redundant Cancel. Reuse the existing detailed guide, portable profile/backup instructions, identifier limitations and Text Tools presets under `docs/future-feature-plans/foobar-reference-assets/`.

I08. Import Local Playlist has one left-aligned Import control, visibly and behaviorally disabled. No new import wizard/mock or parser implementation here. Preserve future intent: multiple local playlist files including Foobar, choose/exclude entries, convert into one or several playlists or album tops, warn that lists exclude duplicates. Explicitly deferred, not partially exposed functionality.

### A — Appearance and palette

A01. Preserve current Main elements, Player & Seekbar, Selection & Hover, Alerts, Album page flow, subelement positions, preview, Save, Cancel and Reset. Improve shared search and add only the requested palette and A/B preference. Do not ship inert captured editors.

A02. Harbor Mint is application-wide, based on the liked navy/teal mock: base #111E2C, panel #0E1B29, control #203043, ink #E6EDF5, muted #9AAFC2, accent/play #52D7AA, waveform edge #9AAFC2. Use central palette mapping and companion panels including Blue frame. Verify Gallery/main/Admin/Utilities/player, not only Settings. Do not switch existing users' default without selection.

A03. Preliminary branch changes already exist in `appearance-palettes.js`, `appearance_preferences_postgres.py` and tests. Reuse/audit instead of adding a duplicate. Prior checks reported unrelated existing expectation failures; establish a fresh baseline rather than claiming those passed during visual review.

## 4. Technical decision checkpoint

The owner approved the expanded contracts in the [Task 1 checkpoint](2026-09-09-settings-refactor-checkpoint.md) on September 9, 2026. That report is authoritative where this summary is less specific:

| Area | Contract |
|---|---|
| Suggestions | Stable proposal ID, target, field/problem type, previous/proposed value, evidence and source revision; revalidate authority/revision before mutation |
| Order | Authorized song/owner-scoped ordered loop IDs plus revision; atomic Postgres update; no cross-song transfer |
| Roots | Host/client/deployment-aware picker adapter, explicit browse/configure/index/path-disclosure authority and overlap policy |
| Statistics | Lock qualifying-play, elapsed-time, deduplication and imported-history semantics against existing listen ledger |
| Log period | Browser-local IANA timezone; inclusive visible end date becomes next local midnight; UTC half-open [from,to); approved retention/page/export bounds in checkpoint |
| Preference | Approved `loopControlStyle: capsule | companion`, default capsule, existing staged account Appearance persistence |
| Selection | Independent problem/proposal sets; drag gesture fixed to one type; stable IDs; hidden proposals excluded from unintended application |

Inventory actual capability IDs before wiring. Loop-style visibility gating is explicitly requested; tag edits, rule changes, deletion, exports, filesystem access and other users' statistics still require their own existing or approved capabilities. Update the private registry and obtain approval only for unresolved technical choices, not already approved visuals.

Approved client matrix; touch interaction review remains a delivery check before claiming player touch support:

| Client | Classification | Constraint |
|---|---|---|
| Desktop web | Required | Full approved flow and keyboard support |
| Narrow/touch web | Required for shared shell; player touch interaction needs explicit review | No hover-only inaccessible save actions |
| Tauri | Optional | Authorized native picker bridge if supported |
| Android | Unsupported in this slice | No implied delivery |
| TV | Unsupported in this slice | No implicit remote-control hover |
| Apple native | Unsupported in this slice | macOS browser remains desktop web |

Local/self-hosted roots belong to the actual media host. Hosted deployments do not gain server filesystem browsing from a visible settings control. Private-node-only folder browsing and existing authorized hosted/self-hosted account functions follow the approved checkpoint.
## 5. Implementation slices and file ownership

Paths below are repository-relative unless explicitly private. New files are marked Create. Task 1 found inactive utilities modules in the original file lists; use the verified live owners below and resolve later slices through production callers. Read complete owning sources/plans before editing. Resolve routes/repository dependencies through actual callers; do not invent endpoint paths or add unused scaffolding. Each task includes failing behavior checks, implementation, focused verification, manual acceptance and a coherent commit. Code-level patches follow technical-contract approval; this document specifies outcomes rather than pretending unresolved APIs already exist.

### Task 1 — Technical approval and baseline

Files: this plan; private `docs/permissions-and-capabilities.md`, `docs/ui-component-system.md`; current shell/saved-loop plans cited above.

- [x] Confirm real boot/load paths and source/generated ownership, effective capability IDs, client/deployment matrix and section 4 contracts.
- [x] Reconcile prior saved-loop visual constraints with the newer approval while retaining audio contracts.
- [x] Verify approved hashes; map every visible extension to its existing component and record functional-case IDs.
- [x] Obtain technical approval for unresolved data/capability/client choices. Record a current focused-test baseline and genuine pre-existing failures.

Progress: 32/32 approved hashes matched during intake and again on September10. Approval is recorded in the checkpoint and private permissions registry. The private UI registry now maps all S/P/R/L/B/H/I/A extensions to existing component families; the shell, Problems/Rules, player/loops, history, and integration/Appearance functional documents record their owning case IDs. This mapping does not claim complete automated coverage or final acceptance. Baseline: 265/271 JS and 190/195 Python passed; all failures are retained in the checkpoint, without claiming they are unrelated. No numeric progress counter exists to reconcile.

### Task 2 — Shell, navigation and artwork (S01–S05)

Modify live owners: `music_app/static/js/runtime/utility-renderers-and-actions.js`, `music_app/static/js/runtime/bootstrap-utility-event-handlers.js`, `music_app/static/js/runtime/utility-list-builders.js`, `music_app/static/js/settings-navigation.js`, `music_app/static/js/navigation-tree.js`, `music_app/static/js/runtime/album-artbox.js`, `music_app/static/css/settings-navigation.css`, and canonical loaded `music_app/static/css/runtime/utilities.css`. Resolve artwork/modal dependencies through their existing callers. `music_app/static/js/utilities/shell.js` and sibling tab modules are not in production boot/bundle references; do not implement there. Build `music_app/static/js/runtime-bundle.js` through `scripts/build-runtime-bundle.cjs`, never hand-edit the generated bundle. The persistent app shell/player identity remains owned by the existing shell lifecycle.

Approved catalog reference: private `docs/ui-component-system.md`, Settings refactor S01-S05 extension v001. Functional requirements remain S01-S05 in section 3; the approved proposal and private FTC mapping are recorded below.
Tests: `tests/js/runtime/bootstrap-utility-event-handlers.test.js`, `tests/js/runtime/utility-list-builders.test.js`; later real-app shell coverage uses `tests/e2e/phase7/poms/settingsShell.js`.

- [x] Add failing tests for six-tab activation, header interception, filter anchoring, keyboard navigation and available/missing-art activation.
- [x] Compose the shared header/tabs/search/tree/Artbox and remove superseded live markup, including duplicate headings.
- [x] Verify resize, narrow shell, neutral artwork hover/focus, full-size modal and selection/copy without carets.
- [x] Run focused checks and runtime build, deliver manual script, complete orchestrator manual validation under the owner override and commit this complete slice.

Task 2 selection correction: the owner-reported Problems tree jump is fixed. Selection and asynchronous detail completion retain mounted rows, focus, scroll and unchanged artwork while metadata updates in place; cached repeated selection avoids detail churn. Genuine filter/collection/mutation refreshes remain active. Final independent verification passed 263/263 focused JS tests, including 39 Settings cases; runtime build/parity, syntax/diff and original-file preservation checks passed. The rebuilt live app preserved the exact deep-list and neighboring-row geometry through uncached and repeated cached clicks. The acceptance report records numeric before/after evidence. Final status: orchestrator manual validation completed under the owner's final-only review override; committed locally as `ee8e702` (Refactor Settings shell navigation and artwork).

Historical Task 2 progress before this defect (superseded by the completed checkpoint above): shared composition is implemented. Independent verification of the resize revision passed 249/249 focused JS tests, including 29 Settings cases. Both P2 review fixes are implemented and reviewed: lazy/async tree artwork with eager headers, and shared lightbox focus entry/containment/return. Final independent verification passed 255/255 focused JS tests, including 31 Settings tests and three added lightbox cases; runtime build/parity, syntax/diff and original-file preservation checks passed. Final live recheck passed, including lightbox focus entry/Tab containment/return and lazy tree/eager header image attributes. The preceding revision reached owner manual review, which exposed the tree-jump defect corrected above. Browser inspection confirmed six-tab interaction, Filters focus, artwork/copying, hidden filter width and corrected 390px Appearance navigation. The [Task 2 acceptance report](2026-09-09-settings-refactor-task2-acceptance.md) owns the exact manual script and final evidence slot. At that historical checkpoint, owner live acceptance was pending; the later owner override and local commit supersede that stop. Task 1's later-surface mapping checkbox stays open.

### Task 2 test-authoring handoff and performance assessment

The approved unit/integration, manual-acceptance, then functional-E2E sequence initially added 21 focused Node tests in `tests/js/runtime/settings-refactor-shell.test.js`. The test-author handoff witnessed 15 initial RED assertions with no harness errors; the additional arrow-navigation and hidden-count tests also failed for missing behavior. This is test-first evidence, not a passing-verification claim. The suite later grew to 29 tests before the two P2 review fixes; the selection correction grew Settings coverage to 39 cases; final verification passed 263/263 focused JS tests. Seven new expected behavior failures were witnessed before the fix, alongside one already-passing genuine collection refresh case. The acceptance report preserves earlier 255-test evidence separately.

Coverage includes six-tab activation; ArrowLeft/ArrowRight wrapping, Home/End and unhandled/modified-key preservation; Filters ArrowDown and Escape/focus restoration; shared anchor cleanup and label; both header Artboxes in ready/missing states; both tree types with artwork, real or absent year, hidden count; shared NavigationTree escaping/link semantics; and redundant-heading removal.

| Functional case | Owning plan requirements | Proposed real-app flow and checks |
| --- | --- | --- |
| `FTC-SETTINGS-S01` | S01-S02 | Open six tabs by pointer/keyboard, exercise wrap/Home/End, preserve unsupported keys; inspect selected joined header geometry and upper-right Close without hit interception. |
| `FTC-SETTINGS-S02` | S03 | Search and filter together, clear each, open Filters by keyboard, escape to its anchor; verify shared anchored placement and retained valid selection. |
| `FTC-SETTINGS-S03` | S04 | Inspect Problems and Loops tree rows with ready/missing art and known/unknown year; show real title/artist metadata and hidden count without invented values. |
| `FTC-SETTINGS-S04` | S05 | Open available art from Problems and Loops headers, close with restored focus; missing art has crossed-disc state and no enlargement; opening art preserves selected context. |
| `FTC-SETTINGS-S05` | S02-S05 | Resize desktop/narrow shell, revisit tabs and close/reopen; verify contour/filter alignment, neutral artwork focus, usable input editing and selection/copy without blinking carets. |

Private owner: `docs/functional-test-cases/app-shell-and-shared-components.md`, indexed from `docs/functional-test-cases.md`. The five planned functional scenarios use the configured real-app functional suite and `tests/e2e/phase7/poms/settingsShell.js`, with isolated normal Postgres product data seeded before startup and generated ready/missing-art records. Each scenario owns any changed data. Existing authorization and media routes remain active; app-owned responses are not mocked. Functional E2E authoring waits for live owner acceptance. The next manual handoff must give exact steps for these five scenarios; approved mockups and Node assertions do not count as live acceptance.

Performance assessment: the shell measures only six tab bounds and updates their selected contour. Observe resize-driven measurement and disposal of ResizeObserver/anchor listeners when the owning shell lifecycle ends; do not leave idle polling or accumulating listeners. Tree rendering retains existing list scale and queries, with no new full-table query. New tree artwork requires native lazy loading and async decoding to avoid eager requests for all offscreen rows; focused tests verify this bounded image-loading correction, with live checks passed and owner manual acceptance retained. Preserve current gallery and Utilities responsiveness/memory contracts and budgets. Focused resize/lifecycle checks plus manual desktop/narrow inspection cover this shell-only change; no new performance E2E is required for Task 2 alone. A measured regression reopens diagnosis under the existing budgets. Later suggestion tables, loop reordering and log queries retain their own required assessments.

### Task 3 — Problems, suggestions and Rules (P01–P10, R01–R02)

Modify live owners: `music_app/static/js/runtime/utility-list-builders.js`, `runtime/bootstrap-utility-event-handlers.js`, `runtime/problematic-album-helpers.js`, `runtime/problem-exclusion-mutations.js`, `runtime/utility-renderers-and-actions.js`, `runtime/utility-loaders-and-cover-lookup.js`, the existing tag-editor mutation owner reached through callers, `music_app/routes/api_problematic_albums.py`, `music_app/routes/api_wave_a_asgi_routes.py`, `music_app/services/edit_workflows.py`, `music_app/services/repair_previews.py` and `music_app/services/utility_rule_mutations.py`. Paths prefixed `runtime/` are under `music_app/static/js/`. The `static/js/utilities/problematic-tab.js` and `rules-tab.js` modules are not production owners. Read the Task 3 intake handoff in the checkpoint before test authoring.
Create: `music_app/services/problem_suggestions.py`, `tests/py/test_problem_suggestions.py`, `tests/js/runtime/utility-suggested-edits.test.js`.
Existing tests: `tests/js/runtime/utility-problematic-review-contracts.test.js`, `utility-problematic-tab.test.js`, `problem-exclusion-mutations.test.js` in the same directory.

- [x] Enumerate every real problem type, reliable evidence and no-proposal outcome; identify the existing authorized tag-write seam and its transaction/error semantics. Recorded in the checkpoint Task 3 intake; implementation gaps remain explicit there.
- [x] Write failing cases for unambiguous/ambiguous encoding, missing year/number, mixed-type drag, album-level selection, no track cover issues, actual before/after values, stale data, partial failure and permission denial.
- [x] Implement proposal computation first, then independent selection and confirmed application through existing mutations. Avoid automatic writes or invented metadata.
- [x] Implement table widths/wrapping, neutral filter menu, positive proposals/error problems, Apply All/Apply and separate Create Exception/Revert workflows.
- [x] Verify successful writes refresh exact targets and retain unresolved issues; run JS then Python focused checks, build, manual review and commit.

Task 3 final evidence: independent focused verification recorded 326/326 JavaScript and 371/371 Python cases, followed by 196/196 related JavaScript cases for the manually discovered Rules search defect. Runtime build (67 modules), syntax, production parity and diff checks passed. Orchestrator real-app manual validation is complete under the owner's final-only review override; exact writes, physical readback, No/Yes Rules behavior, search and preserved tree geometry are recorded in [Task 3 validation](2026-09-09-settings-refactor-task3-validation.md). This complete slice is committed locally in the accompanying commit; no merge, push or publication.

### Task 4 — Player variants and saved-loop presentation (B01–B07, L01–L04/L06)

Modify: `music_app/static/js/runtime/playback-control-cluster.js`, `music_app/static/js/runtime/loop-range-controls.js`, `music_app/static/js/runtime/utility-loop-playback.js`, `music_app/static/js/utilities/loops-tab.js`, `music_app/static/css/runtime/non-album-and-player.css`.
Tests: `tests/js/runtime/playback-control-cluster.test.js`, `loop-range-controls.test.js`, `loop-edit-session-expiry.test.js`, `utility-loop-playback.test.js`; component coverage `tests/components/loopRangeControls.spec.js`.

- [x] Write fake-clock behavior tests: idle hidden at 299 ms/revealed at 300; early exit cancels; idle exit hides immediately; active exit retained at 499/folded at 500; returning cancels; range survives; disposal cancels timers.
- [x] Add tests for real save flow, cancel, busy/failure states, capability loss and unchanged playback/range contracts.
- [x] Implement presentation variants and lifecycle-owned timers inside the shared component, not document-global mock listeners.
- [x] Apply panels/source timestamps/full borders/red deletion; remove individual child-loop selection and Add loop; preserve tree expansion and existing audio controls.
- [x] Verify waveform coordinates do not move on reveal, all glyphs/glows fit, keyboard remains usable and reduced motion is respected. Focused tests, build, manual acceptance, commit.

Task 4 completed focused verification and orchestrator manual acceptance. The final grant-cache regression passed 89 focused cases; prior Python source-window verification passed 44 cases, with shared controls, native keyboard ownership, lifecycle, build/syntax/parity evidence recorded in [Task 4 validation](2026-09-09-settings-refactor-task4-validation.md). Real saves, nested source timestamps, folded range retention, native Cancel, stable playback, narrow geometry and first-open action projection passed. Task 8 retains the persisted A/B appearance selector and validation of both variants through that UI; Task 9 retains touch interaction and functional/regression automation. This local checkpoint does not claim those later tasks complete.

### Task 5 — Durable reorder (L05)

Modify: `music_app/static/js/utilities/loops-tab.js`, `music_app/services/loops.py`, `music_app/routes/api_loop_helpers.py` and the existing loop repository reached from that service.
Create: `tests/js/runtime/utility-loop-reorder.test.js`, `tests/py/test_loop_reorder.py`; extend `tests/py/test_api_loop_helpers.py`.

- [x] Settle order ownership/revision against current schema; add a migration only if existing storage cannot represent it.
- [x] Write failing tests for successful order persistence, duplicate/foreign/missing IDs, stale revision, cancelled/outside/same-position drag, rollback and currently playing loop identity.
- [x] Implement the insertion cue, animated placement, stable-ID tree synchronization and atomic persistence; accessible reorder uses the same mutation.
- [x] Verify real browser dragging actually changes order, then reload and switch tabs/songs. FTC-SETTINGS-L02 passed on pinned Chrome151: native drag changed panel and tree order, retained the playing media node and pending range, and survived reload. Earlier manual navigation and accessible-reorder evidence remains in Task5 validation; the first Task9 drag diagnostic correctly rejected an accidental no-op.
- [ ] Run focused JS then Python checks, build, manual acceptance, commit.

### Task 6 — Log periods and exports (H01–H03)

Modify: `music_app/services/log_history.py`, `music_app/static/js/runtime/browser-log-history-store.js`, `music_app/static/js/runtime/utility-loaders-and-cover-lookup.js`, `music_app/static/js/runtime/utility-list-builders.js` and the existing log route identified through callers.
Create: `tests/py/test_log_history_period.py`; extend `tests/js/runtime/browser-log-history-store.test.js`.

- [x] Write failures for interval boundaries/timezone conversion, equal timestamps, empty results, reversed dates, unauthorized rows, clear behavior, large histories and console/export parity.
- [x] Implement one normalized authorized query shared by the temporary tree entry, console and export.
- [x] Reuse ConsoleLog, scroll and modal components, preserving colored lines and copy behavior.
- [ ] Run focused JS then Python checks, build, manually compare individual/period/export results, commit.

### Python CI repair checkpoint — September 18, 2026 (H01–H03, I02–I03)

The owner authorized one batched repair of the 28 Python failures on PR #3,
followed by native Python CI iteration; this supersedes the historical no-push
instruction for these repairs only. No merge or release is authorized. The
baseline Python job `105648723733` in run `35359910906` reported 28 failures,
5,673 passes and four allowed skips. No task checkbox changes are made here;
the plan has no numeric checkbox counter to update.

The repair preserves existing permission and persistence contracts: bootstrap
route fixtures configure their initial media host without resetting deliberate
scope changes, route expectations include approved capability/cover metadata,
version mutations assert request-owned history scope, and snapshot tests retain
their single-transaction checks with the nullable album parameter. Last.fm unit
seams assert account/library arguments; history and measured completion use
uniquely owned real PostgreSQL rows. Pytest owns mock teardown so an earlier
failed assertion cannot replace the counters used by a later integration test.

H01/H03 regression acceptance: a rejected Last.fm connection retains its safe
integration, status, failure stage, error kind/code, retryability and track
number through normalization and persisted readback. Passwords, session keys,
provider responses and raw private paths remain excluded or redacted. I03
regression acceptance: a repeated rendered-PCM completion retains one scoped
ledger row and one provider submission, with measured seconds and UTC times;
no legacy JSON settings file or nominal-duration substitute is introduced.

Ten narrow bootstrap/metadata checks passed before publication. Full API and
PostgreSQL verification remains pending the native Python CI result; the
complete PR and the existing final manual-acceptance gate are not yet green.

### Task 7 — Integration sections (I01–I08)

Modify: `music_app/static/js/runtime/library-settings.js`, `music_app/static/js/runtime/utility-list-builders.js`, `music_app/static/js/runtime/utility-loaders-and-cover-lookup.js`, `music_app/services/library_settings.py`, `library_roots.py`, `library_roots_postgres.py`, `listen_history.py`, `listen_history_postgres.py`, `foobar_integrations.py` in the same services directory.
Tests: `tests/js/runtime/library-settings.test.js`, `utility-list-builders-foobar.test.js`, `utility-loaders-local-playlist-import.test.js`; Create `tests/py/test_playback_statistics.py`.
References: `docs/future-feature-plans/foobar-reference-assets/how-to-modal-copy.md`, `text-tools-standard-preset.txt`, `text-tools-enhanced-preset.txt`, `README.md`.

- [x] Approve path authority/overlap policy, statistics definitions and actual import formats before dependent behavior changes.
- [x] Add failing multi-root save/remove/cancel/invalid/NAS/duplicate/permission cases, statistics deduplication/duration cases and disabled playlist activation checks.
- [x] Implement real root picker/settings, simple Scrobbling status and statistics, shared Foobar dropdown/import and one-scroll wide guide. No sample values or fake paths.
- [x] Keep playlist Import disabled. Confirm removal of roots never deletes music and watcher/index behavior only follows successful save.
- [ ] Run focused tests sequentially, build and manually accept each complete integration sub-slice before committing it.

### Task 8 — Appearance palette and gated style (A01–A03, B08)

Modify: `music_app/static/js/appearance-palettes.js`, `music_app/static/js/appearance-backgrounds.js`, `music_app/static/js/utilities/appearance-tab.js`, `music_app/services/appearance_preferences_postgres.py`, `music_app/routes/appearance_asgi.py`.
Tests: `tests/js/runtime/appearance-backgrounds.test.js`, `tests/py/test_appearance_palettes.py`, `test_appearance_preferences_postgres.py`, `test_account_appearance_asgi.py` in the same Python directory.

- [x] Add failing preference round-trip, invalid enum, migration default, staged Save/Cancel/Reset and capability-absence cases without blocking unrelated Appearance edits.
- [x] Audit/reuse Harbor Mint work; persist style with existing Appearance preferences and expose only with loop-create capability.
- [ ] Verify palette across Gallery/main/Admin/Utilities/player and both styles without moving existing editor subelements.
- [ ] Focused JS then Python checks, build, live manual acceptance, commit.

### Task 9 — Acceptance and regression

- [x] Record the case IDs from section 3 in the owning private functional-case documents. Approved automation followed delegated live slice acceptance. The five owning case documents now map exact test titles and distinguish browser coverage, manual/service evidence and remaining final acceptance; partial scenarios are not represented as fully automated.
- [x] Extend real-app owners: `tests/e2e/specs/problematicFileNavigation.spec.js`, `loops.functional.spec.js`, `loop-edit-expiry.functional.spec.js`, `appearanceControls.spec.js`; add log/integration cases under the applicable configured area. All new functional cases use the real isolated application; final full reruns remain required below.
- [x] Assess large tables/drag, log queries/exports, tab responsiveness, waveform/reorder and idle-timer cleanup for measurable performance risk. Existing gallery, utility, scan, playback and idle-memory performance contracts remain unchanged. Native L02 verifies media/DOM/range continuity under actual reorder; log paging/export and generation-race tests bound query work and reject stale results; controller tests retain exact reveal/fold/disposal boundaries. The assessment and full initial inventory are recorded in the owning case documents and Task9 validation; final complete performance reruns remain required.
- [x] Run the complete initial required suite inventory before fixes. JavaScript, Python, functional, component, performance, authentication and administration results are retained in Task 9 validation artifacts. JS/Python and heavyweight browser waves ran sequentially, with scoped cleanup. Final clean-state reruns remain required below.
- [ ] Complete review/full native CI and manual acceptance without weakening tests or thresholds. No publication merely because visuals were approved.

## 6. Verification commands

Use existing repository environment/setup scripts for Postgres and real-app E2E. New tests become available in their owning slice. A new test must first fail for missing behavior, then pass after implementation; final expected outcome is zero genuine failures and a successful runtime build.

```powershell
node --test tests/js/runtime/loop-range-controls.test.js tests/js/runtime/playback-control-cluster.test.js
node --test tests/js/runtime/utility-suggested-edits.test.js tests/js/runtime/problem-exclusion-mutations.test.js
python -m pytest tests/py/test_problem_suggestions.py -q
node --test tests/js/runtime/utility-loop-reorder.test.js
python -m pytest tests/py/test_loop_reorder.py tests/py/test_api_loop_helpers.py -q
node --test tests/js/runtime/browser-log-history-store.test.js
python -m pytest tests/py/test_log_history_period.py tests/py/test_playback_statistics.py -q
npm run build:runtime
```

Before release use the configured `npm run test:js:all`, Python suite via `npm test`, `npm run check:e2e-production-parity` and applicable functional/performance commands from `package.json`, in the required sequence. Missing setup is a prerequisite failure, never success. Do not start heavyweight regression merely to validate this documentation-only plan.

## 7. Exact manual acceptance itinerary

1. Open all six tabs by mouse/keyboard, close/reopen and resize. Inspect joined active tab, right Close, filters and absent redundant headings. Select/copy text and check no caret/green Artbox hover.
2. Problems: clear filters, choose Year, add Encoding. Inspect real before/after labels. Drag Year across another type; only Year selects. Apply Year; encoding remains. Apply All visible, test stale/failure behavior, create an exception separately and revert it in Rules. Open available art; inspect missing art.
3. Loops: select a song, expand/collapse, click child without separate selection. Reorder a main panel and verify cue/animation/tree/reload order; cancel another drag. Check source timestamps, playback time, complete top border, full-size artwork and trash cancel/confirm.
4. Test A then B: hover shorter/longer than 300 ms; idle exit hides immediately. Enter creation, leave shorter/longer than 500 ms, return and confirm retained range. Save through the real save UI and cancel another edit. Check neutral X at rest, red/green dissipating icon-only active hover, full idle B curved fill and no waveform movement.
5. Logs: open an event, select a period covering several events, inspect temporary tree entry/combined console, clear it, try empty/inverted ranges and compare filtered export contents.
6. Library: paste and browse several roots per category, cancel picker, remove a root, test unavailable NAS/duplicate path, save/reload. Equal-width input shells and one focus outline remain; no files deleted.
7. Scrobbling: status spacing/check alignment, no misplaced timezone, real local statistics separate from scrobble counts. Foobar: each supported format, Import and wide left-opened guide with one scrollbar. Playlist Import cannot activate.
8. Appearance: Harbor Mint preview/save/reload, cancel/reset other changes. Select A/B, save and verify applicable players. With loop-create capability absent, no style selector or unavailable loop action; unrelated Appearance works and all existing subelement locations remain.

## 8. Completion and exclusions

Complete means the section 3 cases have real authorized current-stack behavior, durable data where required, focused checks, owner live manual acceptance and required regression evidence. Mock approval is not live acceptance.

Excluded: implementing the future playlist conversion workflow, rewriting waveform/audio architecture, framework migration, unsupported native client delivery, public Sites deployment, VPN/firewall product changes, fabricated statistics/metadata and uncertain corrections presented as actionable.

Runtime implementation is authorized and the section 4 technical checkpoint is approved. Tasks 2, 3 and 4 have completed their focused verification and orchestrator manual checkpoints. Tasks 5–8 are implemented with focused and manual evidence in their validation reports; native drag, remaining regression findings, final validation and local commits remain open. Task 9 completed the initial regression inventory and is repairing witnessed failures before final clean-state reruns. Intermediate manual validation remains delegated to the orchestrator under the owner's final-only review instruction. No merge or publication.
