# Cover Look Up and Remaining Shared UI Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task by task. Checkboxes track delivery. This document authorizes no merge, release or deployment.

**Date:** 2026-09-10

**Goal:** Complete the remaining shared UI refactor using approved mocks and final review corrections, preserving the established app, Settings, Appearance, Edit Tags and player designs.

**Architecture:** Shared components own geometry, interaction states and theme tokens; feature adapters supply authorized data/actions. Postgres remains the durable authority. Gallery and Library Status Page instantiate the same abstract GalleryBar. FullPage owns only the Library Status Page body in the main content slot; navigation, app chrome and persistent playback remain shell-owned.

**Tech stack:** Current source uses FastAPI, Postgres and the JavaScript/CSS runtime bundle. Repository policy requires React for new post-migration UI unless the owner explicitly grants a current-stack exception. The Settings exception is feature-specific and is not automatically inherited. Task 1 resolves this boundary before implementation; existing source paths below identify owners, not permission to retain duplicate renderers.

## Approval and precedence

The owner approved all mocks and requested this plan on September 10. The subsequent correction explicitly limits the full-page mock: **preserve the overall look of the real main app page despite implementing the compact bar**. Its approval covers fold/reflow behavior only, not invented app chrome, card presentation, spacing or omission of the player. Capture the actual app before implementation and compare against that baseline.

Final explicit review corrections take precedence over mock simplifications and earlier proposals. Visual approval is not production acceptance or approval of unspecified backend permissions. The three button finishes demonstrate theme-dependent treatments, not three new product themes or a mandate to hardcode one palette. Review controls, placeholder albums, simulation selectors and toast-only actions do not ship.

A leftover mixed Navigation & utility sections specimen does not authorize combining Problems, Loops and Rules into a new screen. The simplified Edit Tags form does not authorize replacing the real form. Appearance snapshots are references, not iframe implementations. Preserve player appearance, controls, waveform, playback state and element identity throughout.

## Exact references

- [Approved board](../../design-mockups/screens/remaining-ui/v001/index.html): anchors `cover`, `artist-rail`, `edit-tags`, `appearance`, `library-scan`, `library-status-dropdown`, `button-options`, `action-button-options`, `dropdown-specimen`, `search-specimens`.
- [Full-page fold/reflow reference](../../design-mockups/screens/remaining-ui/v001/full-page.html): behavior only; preserve actual application styling.
- [Approval record](../../design-mockups/screens/remaining-ui/v001/review.json), [approved asset hashes](../../design-mockups/screens/remaining-ui/v001/approved-artifacts.json), [historical review notes](../../design-mockups/screens/remaining-ui/v001/notes.md), [initial brief](2026-09-09-cover-look-up-refactor-brief.md).
- [Complete use-case matrix](2026-09-10-remaining-ui-use-cases.md): normative acceptance criteria; every case maps to a task below.
- [Settings plan](2026-09-09-settings-refactor.md), [historical technical checkpoint](2026-09-09-settings-refactor-checkpoint.md), [final Settings navigation](../../design-mockups/screens/utilities-refactor/v002/navigation.html). Reconcile against the current settings branch; its checkpoint is not current verification evidence.
- Shared plans: [convergence index](2026-09-06-shared-ui-convergence-index.md), [ActionButton](2026-09-04-shared-action-button.md), [unfolding actions](2026-09-08-unfolding-action-button.md), [lightbox](2026-09-06-image-lightbox.md), [alerts/toasts](2026-09-06-unified-alerts-and-toasts.md), [account/admin](2026-09-06-account-and-admin-components.md), [persistent shell](2026-09-02-persistent-settings-shell.md), [album details](2026-09-04-missing-album-and-album-details-components.md), [table alignment](2026-09-04-editorial-track-table-alignment.md).
- Private references: [component registry](C:/Repositories/album-haven-internal/docs/ui-component-system.md), [permissions registry](C:/Repositories/album-haven-internal/docs/permissions-and-capabilities.md), [delivery guardrails](C:/Repositories/album-haven-internal/docs/agent-workflows/album-haven-skill-guardrails.md), [mock workflow](C:/Repositories/album-haven-internal/docs/agent-workflows/local-mockup-review-workflow.md), [functional-case index](C:/Repositories/album-haven-internal/docs/functional-test-cases.md), [migration tracker](C:/Repositories/album-haven-internal/docs/migration-plan.md).

Freeze v001 approved visuals. Further material visual revisions require a new version. Historical in-review banners/notes do not override review.json. No existing missing implementation is marked complete by this approval.

## Global requirements

1. Preserve actual main-app look, expanded Artist Tree, Appearance navigation/editor layout, every Edit Tags field and all player behavior. Only explicitly requested changes alter them.
2. Reuse registered components. Do not ship mock CSS override stacks, copied static components, synthetic progress, iframes, query-string authority or dummy actions. Remove superseded live rendering when a boundary is migrated.
3. Automatic non-playback hover uses muted player-background color mixed into neutral fill/edge; no saturated hardcoded green. Dropdown rows stay neutral; error/destructive interactions stay reddish. Keep visible keyboard focus and disabled semantics.
4. Action button outlines is a saved Appearance preference: on = current resting border/fill, off = bare icons with quiet hover. It covers app/gallery bars, headers, art and navigation actions consistently; it does not remove focus or connected-menu state, or restyle text buttons/player controls.
5. Shared Artist Tree scrollbar style applies throughout main pages, admin/login, dialogs, menus, lists, tables and notifications. Preserve forced-colors/native accessibility exceptions.
6. No blinking caret on clickable/noneditable UI. Preserve real input behavior, text selection and copying; retain the settings branch's separately established caret policy on its surfaces.
7. Durable account/device appearance and library data remain Postgres-backed; never add file/localStorage authority. No credentials, local media paths or private fixtures in artifacts.
8. One pytest process at a time. Use exact owned-process cleanup and independent uniquely owned mutable fixtures. Mock inspection is not production acceptance.

## Technical decisions and required gates

### Appearance contract (proposal for technical approval)

Web / Desktop is the base; Mobile and TV have Follow Web / Desktop or Customize on every Appearance tab. Follow defaults for new device sections, hides details and dynamically inherits future saved base changes. Customize exposes the unchanged editor and overrides only that device/section. Switching sections/profiles preserves staged drafts. Save/Cancel retain the current aggregate workflow.

Proposed profile keys: `web_desktop`, `mobile`, `tv`. Section keys: `main`, `player`, `interaction`, `alerts`, `album`. Each nonbase section has `mode: follow | customize` and validated existing-section values. Base cannot follow another profile. Action outlines belongs to interaction. Proposed dormant-value rule: retain custom values while following; first Customize copies effective base values, later Customize restores the draft/custom values. Confirm this rule and schema before implementation.

Migrate old single-profile preferences losslessly to Web/Desktop; initialize Mobile/TV to follow. Use server-derived account identity and the existing expected-revision conflict contract. Save atomically; stale/failed writes preserve drafts. Same-account devices of one type share saved appearance; users remain isolated. Do not discard player preferences during migration.

### Permissions, deployments and clients

Existing inspected capabilities: `account.self.appearance.read/write`, `library.covers.lookup`, `library.covers.lookup.cancel`, `library.covers.tasks.read/manage`, `library.covers.remote.read`, `library.covers.write`, `library.covers.fetch`, `library.covers.fetch.cancel`, `library.files.open_location`, `library.files.edit_tags`. Preserve each existing authorized account/library/album/task/host scope and explicit grants. Server enforcement remains mandatory; hiding a button is insufficient.

Resolve actual scan/status/rescan/cancel policy mappings before registering them; this plan invents no capability names. External search is user-initiated; pasted remote links retain current safe-fetch policy, not unrestricted URL fetching. Fold/search/filter/zoom are view state but underlying reads/media remain authorized.

Proposed support: desktop and narrow/touch web **required**; Tauri web renderer **optional** subject to existing bridge availability; Android, TV and Apple native **unsupported** for this implementation slice. Mobile/TV profile data and inherited web rendering are **required**, not proof of native clients. Apple browsers use web support. Existing hosted/self-hosted action constraints remain; filesystem actions retain current permitted host/client deployment boundaries.

Task 1 must obtain the unresolved technical approvals: renderer migration versus explicit current-stack exception; cross-profile editing policy (Web/Desktop all profiles versus Mobile/TV own only); migration/dormant custom-state contract; exact capability/preset/deployment/client matrix. Do not reopen approved visuals. Record each planned action and component extension in private registries before dependent implementation.

## Source ownership

All paths below are relative to the application checkout. New test filenames are planned files. Task 1 determines renderer-specific new component paths after the technical gate, rather than inventing an unapproved frontend stack.

| Family | Current source owners |
| --- | --- |
| Boot/build | `music_app/templates/index.html`; `scripts/build-runtime-bundle.cjs` |
| Button/ActionButton | `music_app/static/js/button-component.js`; `music_app/static/css/button-component.css` |
| Appearance/theme | `music_app/static/js/appearance-backgrounds.js`; `music_app/static/js/appearance-palettes.js`; `music_app/static/css/appearance-backgrounds.css`; `music_app/routes/appearance_asgi.py`; `music_app/services/appearance_preferences_postgres.py` |
| Search/tree/fold | `music_app/static/css/search-input.css`; `music_app/static/js/navigation-tree.js`; `music_app/static/css/navigation-tree.css`; `music_app/static/js/runtime/shell-navigation-drawer.js` |
| Tabs/menu | `music_app/static/css/runtime/utilities.css`; `music_app/static/css/settings-navigation.css`; `music_app/static/js/settings-navigation.js`; `music_app/static/css/trigger-anchor.css`; `music_app/static/js/runtime/utility-renderers-and-actions.js` |
| Album/gallery | `music_app/static/js/runtime/album-details-components.js`; `music_app/static/js/runtime/track-modal-and-gallery.js`; `music_app/static/js/runtime/gallery-card-component.js`; `music_app/static/js/runtime/gallery-main-components.js`; `music_app/static/css/runtime/album-track-table.css` |
| Cover panel | `music_app/static/js/runtime/cover-lookup-modal-and-drawer.js`; `music_app/static/css/runtime/cover-lookup-modal.css`; `music_app/static/css/runtime/cover-lookup-drawer-and-related.css` |
| Notifications/jobs | `music_app/static/js/runtime/cover-lookup-notification-helpers.js`; `music_app/static/js/runtime/notification-ui-helpers.js`; `music_app/services/cover_lookup_tasks.py`; `music_app/services/cover_lookup_notifications.py` |
| Cover server | `music_app/routes/api_cover_helpers.py`; `music_app/services/cover_provider_registry.py` |
| Tags/table | `music_app/static/js/runtime/tag-editor-and-optimistic-updates.js`; `music_app/static/js/runtime/utility-loaders-and-cover-lookup.js`; `music_app/static/js/runtime/compact-data-table.js`; `music_app/static/css/runtime/compact-data-table.css` |
| Modal/lightbox/alerts | `music_app/static/js/runtime/track-modal-lightbox-helpers.js`; `music_app/static/js/runtime/modal-and-overlay-helpers.js`; `music_app/static/js/runtime/alert-components.js` |
| Scan | `music_app/static/js/runtime/loader-status-helpers.js`; `music_app/static/js/runtime/core-state-and-helpers.js`; `music_app/static/js/runtime/status-ui-helpers.js`; `music_app/static/js/runtime/gallery-refresh-and-status.js` |

Do not assume older `static/js/utilities/*.js` modules are live; the Settings checkpoint identifies runtime owners. Reconcile completed settings work before modifying shared files. Do not reimplement its suggestions, loops, logs, integrations or player changes here.

## Implementation sequence

Each task is an independently reviewable slice. For logic changes: write the specified failing cases, demonstrate RED, implement the smallest complete change, demonstrate GREEN, build, inspect the real UI and record manual results. Commit task-owned files only when the applicable workflow permits. Keep unrelated working-tree changes intact.

### Delivery units recorded September 20, 2026

Each unit is independently reviewable and publishable only after its own focused checks, required review/CI, and owner manual acceptance. All units preserve the current JavaScript/CSS renderer, existing authorization, rollback through the prior runtime owners, the persistent shell/player, and the approved case matrix.

| Unit | Outcome and included cases | Prerequisites | Merge/publish checkpoint |
| --- | --- | --- | --- |
| Shared controls, tabs and menus | Semantic control states, outline plumbing, search ordering, dropdown geometry, joined Settings tabs and shared scrollbars; UI01–UI12, DD01–DD06, TB01–TB03 | Task 1 contract; final Settings owners from `origin/main` | Tasks 2–3 focused tests and manual theme/zoom/accessibility check |
| Artist Tree and gallery reflow | Real NavigationTree folds while the live gallery remeasures into reclaimed width; NAV01–NAV08 | Shared controls; current Gallery owners from `origin/main` | Task 4 tests, player identity proof and two-width manual check |
| Album Details, Cover Look Up and notifications | Shared album/art/card/header/footer/lightbox composition with preserved jobs, persistence and authorization; ART01–ART04, COV01–COV13, NTF01–NTF06, DLG01–DLG05 | Shared controls/menus and existing cover services | Tasks 5–6 focused JS/Python checks and manual lookup/failure review |
| Edit Tags | Existing layout and fields gain shared controls plus stable selection/reorder behavior; TAG01–TAG09 | Shared controls/menus and current tag-save contract | Task 7 focused tests and owner data-safe manual script |
| Library Status Page | A Library Status Page `GalleryBar` instance owns Back/title/status/actions above a `FullPage` scan body; SCN01–SCN11 | Shared controls/menus and current scan state/actions | Task 8 focused state/geometry tests and active-scan manual review |
| Appearance profiles | Atomic per-account `web_desktop` base plus per-section Mobile/TV Follow/Customize and retained overrides; AP01–AP11 | Shared outline plumbing; allocate migration from current head | Task 9 JS/Python/Postgres checks and cross-session manual review |
| Remaining consumers and audit | Registered families reach remaining Settings/main/admin/login consumers without changing approved layouts; GOV01–GOV05 | Prior units | Task 10 two-pass local review, focused regression, port-5001 acceptance, then approved functional E2E and full CI |

### Task 1 — Approval, ownership and technical checkpoint

**Files:** this plan/case matrix, mock approval metadata; private component/permission/case registries and migration tracker.
**Cases:** GOV01–GOV05.

- [x] Verify approved asset hashes. Read complete applicable Settings/convergence/component plans, not only summaries.
- [x] Capture the real main page, expanded tree, Appearance and Edit Tags baseline. Record viewport/theme. Explicitly exclude the full-page mock's invented app chrome/cards from adoption.
- [x] Inventory every remaining family as reuse, extension or migration with exact owner, artifact and tests. Reconcile completed checklist items; no duplicated implementation.
- [x] Present the concrete technical gate above, including renderer ownership. If React, approve the build/mount adapter and migrate complete touched boundaries while preserving persistent shell/player nodes. Do not silently reuse a Settings-only exception.
- [x] Register planned actions, scopes, role presets, deployment/client constraints and component contracts. Add case IDs to private case owners and update tracker without marking runtime complete.

**Exit:** approved technical contract, source map and test proposal. Visual design is already approved subject to final corrections.

### Task 2 — Shared controls, tokens and outline preference plumbing

**Files:** button/appearance/search owners above; new `tests/js/runtime/remaining-ui-interactions.test.js`; existing `tests/components/buttonInteractionOutline.spec.js` and `tests/components/searchInput.spec.js`.
**Cases:** UI01–UI12, AP07.

- [ ] Add resolver/style cases for non-green player themes, neutral dropdowns, red destructive/error controls, outline on/off and playback exclusions. Include computed browser styles, not only CSS string assertions.
- [ ] Implement semantic automatic hover from effective player background plus neutrals. Approved dark examples start near 14% tint for fill and 22% for edge; do not freeze hex colors or override explicit user customizations accidentally.
- [ ] Remove superseded broad hardcoded hover rules. Apply shared behavior to all consumers, including Renumber, Browse Library, notifications and gallery/header actions. Existing ID styles cannot hide hover.
- [ ] Extend ActionButton with effective outlined/bare presentation while retaining hit targets, disabled state and keyboard focus. Wire saved preference in Task 9; playback is excluded.
- [ ] Adopt subdued checkbox/radio selected states; noneditable caret policy; correct search/filter/clear ordering and centered SVG chevron.
- [ ] Run `node --test tests/js/runtime/button-component.test.js tests/js/runtime/remaining-ui-interactions.test.js`, build, and inspect dark/black/light/custom-player themes.

### Task 3 — Menus, touching tabs and scrollbar convergence

**Files:** tab/menu/tree/search owners; new `tests/js/runtime/remaining-ui-shell.test.js`.
**Cases:** DD01–DD06, TB01–TB03, UI05–UI10.

- [ ] Test search clear/filter ownership, menu arrows/Home/End/Escape/outside click, and geometry after resize/scroll/above-below flip.
- [ ] Reuse final settings branch TabBar with zero gap, joined active contour and no content remount. Older copied 6px gap is superseded.
- [ ] Keep select-input menus plainly framed/neutral. Context dropdowns retain established connected fade with valid border tokens. Measure split edge geometry: matching 1px divider row, opening below trigger, no crossing/double line. No green menu-item hover.
- [ ] Inventory all scrolling surfaces, including admin/login and nested dialogs; apply shared Artist Tree scrollbar styling without breaking overflow or forced-colors support.
- [ ] Run new shell tests and configured search component tests. Manually check 100/125/150% zoom, narrow layout, focus and popup flipping.

### Task 4 — Artist Tree folding and gallery reflow

**Files:** navigation/gallery owners; extend `tests/js/runtime/shell-navigation-drawer.test.js`; new `tests/components/artistTreeReflow.spec.js` after test proposal approval.
**Cases:** NAV01–NAV08.

- [ ] Test fold state, focus transfer, selected artist/search/scroll preservation, grid measurement and player node identity.
- [ ] Preserve current expanded rows; put collapse before Artists. Fold to one tree action with the approved many-branched glyph. Respect outline preference; no Settings shortcuts or green rail redesign.
- [ ] Reclaim real layout width, not a visual transform over an unchanged column. Preserve actual app bar, gallery bars/cards/typography/spacing and player; only reflow within the freed space.
- [ ] Recalculate existing grid/virtualization using current card-size settings. Mock 240px-to-56px and 4-to-5 columns are demonstration geometry, not fixed production counts. Preserve visible album anchor and observer cleanup.
- [ ] Run tree tests, then toggle at a width that gains a column and a width that does not. Repeat with active search and playback. Compare screenshots to real baseline, not mock artwork.

### Task 5 — Album Details, Cover Look Up and source entry

**Files:** album/gallery/cover owners; new `tests/js/runtime/cover-lookup-source-input.test.js`; extend `tests/js/runtime/cover-lookup-modal-open.test.js` and `tests/js/runtime/cover-lookup-modal-and-drawer.test.js`.
**Cases:** ART01–ART04, COV01–COV13.

- [ ] Test stable album identity, card selection versus enlargement, counts and zero/empty/local-only states.
- [ ] Preserve actual modal/table/total-strip dimensions. Componentize information. Artwork click opens full size; only lookup/fast-fetch remain in its action overlay with keyboard/touch access.
- [ ] Compose shared Header/Section/compact GalleryCard/Artbox/EditorFooter. Default one Find Better Art above results; Cancel/Save and selection in footer. Do not ship review placement switches.
- [ ] Local section always remains with N images and appropriate zero message. Hide empty remote/possible sections. Remove Current source. Keep uppercase section labels and aligned provider rows despite title wrapping.
- [ ] Adopt readable provider names/logos: Apple, Spotify, Deezer purple heart, Bandcamp, Discogs, CAA and YouTube Music. Validate asset provenance/licensing before shipping.
- [ ] Google/Yandex derive encoded query from active album artist/title/year; no separate query field. Trailing logos/external marker indicate navigation. Respect existing external-link handling.
- [ ] Implement compact growing paste/drop/picker input with removable previews, staged direct-image/album links and bounded validation through current services. Remove redundant helper line. Preserve valid staged items after error; revoke object URLs; save only through authorized actions.
- [ ] Preserve actual backend jobs, image validation and save/conflict/retry semantics. Run named JS tests and sequentially `python -m pytest tests/py/test_api_cover_helpers.py tests/py/test_cover_lookup_tasks.py` with configured Postgres fixtures.

### Task 6 — Notification panel, full-size artwork and confirmations

**Files:** notification/lightbox/alert owners; extend `tests/js/runtime/cover-lookup-notification-helpers.test.js`; new `tests/js/runtime/remaining-ui-dialogs.test.js`; existing `tests/components/coverLookupTaskCard.spec.js`.
**Cases:** NTF01–NTF06, DLG01–DLG05.

- [ ] Test card activation for its own authorized album and separate Retry/Clear propagation.
- [ ] Shared panel/header/cards show live progress/elapsed/status and empty states. Closing panel does not cancel jobs; subscriptions clean up. Stale/removed/unauthorized targets fail honestly.
- [ ] Reuse ImageLightbox with loading/missing/failure, Close/Escape and focus return. Closing child lightbox cannot discard parent state.
- [ ] Content-sized alerts keep adjacent actions and wrap responsively. Compact confirmation has no internal dividers; Keep editing preserves drafts and Discard stays red. Do not globally remove section dividers.
- [ ] Run named tests; inspect keyboard, overflow and reduced motion. No new task persistence is introduced.

### Task 7 — Edit Tags conversion without redesign

**Files:** tag/table owners; extend `tests/js/runtime/tag-editor-and-optimistic-updates.test.js`, `tests/js/runtime/utility-tag-edit-optimistic.test.js`; new `tests/js/runtime/tag-editor-reorder-boundary.test.js`.
**Cases:** TAG01–TAG09.

- [ ] Inventory every current field, mixed-value rule, validation, footer action and selection behavior from real UI before conversion. Preserve exact layout; mock sample fields are not exhaustive.
- [ ] Use shared form elements and current compact filename list with trailing format badge. No extra table header, index column, second format line or redesigned tag form.
- [ ] Preserve filename sweep selection and Ctrl/Cmd/Shift semantics; reorder only from grip. Accent belongs at row's far left before the grip. No grip hover outline; accessible reorder equivalent remains available.
- [ ] Add failing first/middle/last/below-list/same-place/outside/Escape/failed-save cases. Exclude dragged row in midpoint lookup; no next row means append. Indicator shows actual boundary, including below last row; cleanup always removes drag state.
- [ ] Preserve selected identities, mixed values, Renumber and transaction/optimistic rollback. Reorder does not silently write tags outside the current Save workflow.
- [ ] Run all named tests. Manually move first to last and back; select multiple filenames, reorder, renumber, Save and Cancel with uniquely owned data.

### Task 8 — Library Status Page FullPage and status menu

**Files:** scan owners/template main slot; new `tests/js/runtime/library-scan-full-page.test.js`; extend `tests/js/runtime/library-loader-visibility.test.js`, `tests/js/runtime/gallery-refresh-and-status.test.js`.
**Cases:** SCN01–SCN11, DD04–DD06.

- [ ] Test backend-to-view mapping for initial loading, discovery, scanning, cover updates, artist relations, full rescan, cancelling, cancelled, idle/completed, no music and error.
- [ ] Reusable FullPage body mounts below a Library Status Page instance of the shared abstract GalleryBar in the gallery/main slot, preserving outer tree/app bar/player. The GalleryBar owns the simple back arrow immediately before Library Status Page, without a title divider. No nested app shell, modal, state tabs, duplicate search/revert bar or simulation widgets.
- [ ] Active copy is Scanning the library. Use approved animated spinner, actual counts/current filename/elapsed and ETA only when available; no fake progress or noisy per-tick announcements.
- [ ] Compact phase map shows Discover files, Read tags & metadata, Update cover art, Refresh artist relations. Reached/completed stages stay bright, current is distinct, future dim. Failure/cancellation cannot paint uncompleted work as done; handle modes that omit phases honestly.
- [ ] Browse Library and back preserve ongoing work; quiet Cancel calls current authorized cancellation and waits for terminal status. No empty checkbox/status placeholder. Ensure Browse Library shared hover is visible.
- [ ] Status ActionButton/menu derives Full Rescan/Go to Scan Page and Fetch/Cancel Covers from actual state/capabilities; all neighboring action chrome follows preference. Preserve shared anchor geometry.
- [ ] Run new scan and existing two runtime tests. Exercise real active scan with nonempty Postgres-backed test library; empty scans alone cannot validate intermediate states. Browse/play during scan and verify failure/cancel recovery.

### Task 9 — Persistent device Appearance

**Files:** Appearance owners; new `tests/js/runtime/appearance-device-profiles.test.js`; extend `tests/py/test_appearance_preferences_postgres.py`, `tests/py/test_account_appearance_asgi.py`; allocate a forward migration in the existing sequence after inspecting current head.
**Cases:** AP01–AP11.

- [ ] After technical approval, add failing profile normalization, section resolution, revision conflict, migration preservation and account-isolation tests. Do not silently change API contracts.
- [ ] Implement Postgres-backed base/per-device/per-section values using validated existing field schemas. No migration number is reserved in this plan because the settings branch is still moving.
- [ ] Keep exact Appearance navigation/layout. Neutral device selector and per-tab Follow/Customize affect visibility and draft scope; no obsolete apply-to checkboxes. Save/Cancel preserve aggregate behavior.
- [ ] Add action-outline preference in the existing interaction editor without rearranging its other contents. Preview must not alter actual playback UI beyond already-owned preview behavior.
- [ ] Run new JS tests and sequentially `python -m pytest tests/py/test_appearance_preferences_postgres.py tests/py/test_account_appearance_asgi.py`. Verify migration, inheritance, dormant overrides, stale writes and authorization.
- [ ] Manually verify same-account/same-type restore across sessions, cross-account isolation, per-tab custom settings and later base changes. Validate supported web profiles without claiming native TV/mobile apps.

### Task 10 — Remaining consumer adoption and real acceptance

**Files:** remaining consumers from Task 1; Settings owners; private registries/cases/tracker; this checklist.
**Cases:** GOV01–GOV05 and every applicable matrix case.

- [ ] Adopt shared art/info/sections/table-label variants in Problems/Loops and wide rows across six Settings areas without replacing their independently approved layouts or functionality. Convert remaining main/admin/login inputs, bars, footers, alerts, modal bodies and scrollbars.
- [ ] Audit every action by role, theme, semantic color, outline preference, pointer/keyboard/disabled states. Remove superseded runtime paths only after checking boot/build references; never ship old/new live owners together.
- [ ] Run focused checks per slice; then complete JS/Python regression inventory. Collect every genuine full-suite failure before fixing; preserve evidence and do not weaken tests to hide it.
- [ ] Assess measurable risks: gallery reflow/virtualization/cover scheduling, scan subscriptions and profile repaint. Preserve existing budgets. Add performance E2E only for uncovered measurable risk, not every visual change.
- [ ] Give owner the manual itinerary below on a real build and record acceptance separately. Only then add approved independent functional E2E using existing POMs and real Postgres fixtures.
- [ ] Reconcile registry adoption/checklist counts, inspect full diff and complete required review. No merge/push/release is authorized by this plan request.

## Proposed behavior contracts and focused assertions

These snippets specify expected behavior; adapt implementation syntax to the approved renderer, preserving existing public APIs where possible.

```js
// Shared action styling contract; values resolve through theme, not page CSS.
// role: primary | secondary | action | destructive | playback
// actionChrome: outlined | bare; has no effect on playback or text-button roles.
// resolveAppearance(saved, profile, section) returns a normalized section.
function resolveSection(base, deviceSection) {
  return !deviceSection || deviceSection.mode === 'follow'
    ? base
    : deviceSection.values;
}
// Reorder contract: result is next stable ID or null for end; pointer Y is viewport Y.
function insertionBefore(rows, draggedId, y) {
  return rows.filter(row => row.id !== draggedId)
    .find(row => y < row.top + row.height / 2)?.id ?? null;
}
```

Test vectors (actual automation must exercise component/service behavior, not merely duplicate these helpers):

| Input/action | Assertion |
| --- | --- |
| Base interaction changes while Mobile follows | Mobile effective values change; TV custom interaction stays unchanged |
| Customize Alerts on Mobile then navigate Main and back | Alerts remains custom; Main still follows; unsaved draft retained |
| Old saved account has player override and no device keys | Migration preserves override in base; new devices inherit it |
| Rows A/B/C, drag A below C | Result B/C/A; selected stable IDs unchanged |
| Drag C above A | C/A/B; cancel restores pre-drag order |
| Fold sidebar at threshold viewport | Main left edge moves; gallery gains column; player DOM identity unchanged |
| Hover destructive Discard in blue/green theme | Red-family feedback; no generic player-colored edge |
| Hover select option / context menu item | Neutral fill, no green outline; keyboard operation intact |
| Action chrome off | Resting icon surface/border absent; hit target unchanged; focus remains visible |
| Open dropdown under app bar | Divider and menu edge align outside anchor; line absent through anchor |

## Verification commands and evidence

Run from implementation checkout with configured dependencies and isolated test Postgres; never print credentials.

```powershell
npm run build:runtime
node --test tests/js/runtime/button-component.test.js tests/js/runtime/shell-navigation-drawer.test.js
npm run test:js:all
npm run test:quiet
npm run check:e2e-production-parity
npm run test:e2e:functional:local:list
```

Build/focused checks precede broader regression. Use supported local functional-runner selectors from its listing; do not invent flags. New test paths above are planned, not claims they exist. No production tests ran merely to author this plan. Never run simultaneous pytest processes. Runtime bundles are generated, not edited directly.

Existing automation references: `tests/e2e/poms/coverLookup.js`, `tests/e2e/poms/scanPage.js`, `tests/e2e/poms/navigationPanel.js`, `tests/e2e/poms/searchToolbar.js`, `tests/e2e/specs/appearanceControls.spec.js`, `tests/e2e/specs/coverLookup.spec.js`, `tests/e2e/specs/searchTreeCorrectness.spec.js`. Use real Postgres authority; no JSON compatibility branch or mock-page substitution. Update page objects for shared contracts rather than copying selectors into tests.

Each case records build/commit, owned fixture, expected/actual result, automated/manual evidence and cleanup. Run accessibility focus, reduced motion and responsive checks where applicable. Audit exact owned test/server processes after abnormal exit. Track historical baseline failures separately from regressions.

## Owner manual itinerary

1. Open the real app in its existing theme; compare baseline chrome/cards/player. Fold/expand tree, preserve current artist and search, and observe reclaimed width at two viewport sizes.
2. Toggle action outlines in Appearance, Save/reload and inspect app/gallery/header/tree actions. Check neutral/dropdown, red destructive, primary and secondary states with another player color. Confirm player is unchanged.
3. Open album details; enlarge art, return, use lookup/fast fetch. In Cover Look Up select versus zoom, inspect all counts/provider rows, external search and paste/drop/picker. Save one owned test album; cancel another.
4. Start lookup and close panel; reopen, activate another album's notification, Retry failure, clear completed and inspect empty state.
5. Edit Tags: compare all real fields to baseline, sweep/toggle/range select, drag first to last below list, back to first, cancel drag, renumber and exercise save/discard.
6. Scan a nonempty test library; inspect reached phases, browse while running, return, cancel; verify no music/error/completion. Open context menu near top/bottom and resize.
7. Mobile follows every tab and hides details. Customize one tab, switch away/back, save/reload. Change base and verify only following sections update; test TV and second account separately.
8. Inspect touching Settings tabs, scrollbars in main/admin/login/dialogs, compact confirmation, checkbox/radio, search order, chevron center, keyboard focus and reduced motion.

Completion requires all applicable cases passing, original layout/player contracts preserved, shared components used by all scoped consumers, migrations/authorization verified, owner real-build acceptance and required regression/review. Mock approval alone is not completion.


## Sidebar player owner follow-up — September 21, 2026

The owner selected the tree-wide docked player and coordinated reassembly as the replacement direction, requested all A/B/C compact states as Appearance behaviors, independent floating-edge color, and the mock colors as another theme. [Sidebar player v002 requirements](../../design-mockups/components/sidebar-player/v002/requirements.md) and [palette](../../design-mockups/components/sidebar-player/v002/theme.json) record this follow-up. They supersede conflicting compact-player presentation assumptions only. The prior statement that button-finish samples are not themes does not negate this new explicit theme request. Current scope: mock and requirements only; revised-artifact review and production gates remain pending.


### Sidebar player v003 correction

Latest owner direction supersedes the earlier sidebar/A/C mock: only one sidebar icon, the top tree toggle; A play at the bottom with artwork unfolding upward and no compact chevron; C play lower over the artbox bottom-right corner. B is accepted and unchanged. All three Appearance behaviors, tree-wide dock, reassembly animations, edge-color settings and palette requirements remain. [Current requirements](C:/Users/Rendref/.codex/worktrees/bf02/album-haven-app/docs/design-mockups/components/sidebar-player/v003/requirements.md). Mock changes only; production implementation pending.


## Approved sidebar player implementation plan — September 21, 2026

Owner approved A/B/C and tree-wide reassembly, authorized C 3px higher and requested Slow motion in Appearance. [Detailed plan](2026-09-21-sidebar-player-appearance.md) governs the bounded work; [approved v004](../../design-mockups/components/sidebar-player/v004/review.json) supersedes earlier pending-design statements. Two cohesive units: Parchment & Pine; complete player/Appearance update. Production implementation/manual acceptance remain pending.
