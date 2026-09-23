# Remaining UI: Task 1 intake checkpoint

Date: 2026-09-10. Owner plan: [implementation plan](2026-09-10-cover-look-up-and-remaining-ui-implementation.md). Cases: [acceptance matrix](2026-09-10-remaining-ui-use-cases.md).

Task 1 completed on September 20, 2026. This checkpoint records approved technical contracts, fresh baseline evidence, ownership, delivery boundaries, and planned case mappings. It does not claim runtime implementation, manual acceptance, merge, publication, or release.

## Preserved work and visual evidence

Target: `C:/Users/Rendref/.codex/worktrees/bf02/album-haven-app`, branch `2026-09-09-cover-look-up-refactor`, rebased onto `origin/main` `a5c23fc8`; replayed branch HEAD `f14640c9` before the uncommitted remaining-UI work.

All 33 SHA256 entries in `docs/design-mockups/screens/remaining-ui/v001/approved-artifacts.json` matched their files. `review.json` records final visual approval. The full-page reference authorizes Artist Tree folding and gallery reflow only. Preserve the actual main page, cards, spacing, Appearance and Edit Tags layouts, and player identity/behavior. Do not alter frozen v001 files.

The pre-rebase owner state is retained in `stash@{0}` (`codex-pre-rebase-remaining-ui-2026-09-20`). Preserve all untracked plans and mocks. Current uncommitted lightbox chevron changes are part of this work and remain outside commits until requested.

Fresh real-app baselines were captured from `https://localhost:5001/` on September 20, 2026 at `1920x911`, DPR `1`, dark mode, `Solid Black` palette and custom player. The browser showed no console warnings/errors. Evidence covered the expanded Artist Tree and real Gallery/app bar/player, the current five-section Appearance editor, and the complete current Edit Tags editor. The full-page mock's invented app chrome/cards remain explicitly excluded; only Artist Tree folding and gallery reflow transfer from that artifact.

## Remaining-family ownership inventory

| Family | Disposition and live owner | Approved artifact | Planned focused evidence |
| --- | --- | --- | --- |
| Button/ActionButton, SearchInput, caret and selection controls | Extend registered shared owners in `button-component.js`, search/runtime CSS and Appearance interaction resolution; keep playback controls excluded | component showcase and approved full-page control examples | `button-component.test.js`, new `remaining-ui-interactions.test.js`, existing component specs |
| TriggerAnchor, menus, Settings Header/TabBar, scrollbars | Reuse final `origin/main` Settings implementation; extend shared geometry/keyboard/style owners only | trigger/search/Settings component artifacts | new `remaining-ui-shell.test.js`, existing search and Settings tests |
| NavigationTree and gallery sizing | Extend `navigation-tree.js` plus live shell/gallery measurement owners; no replacement tree or card design | approved Artist Tree/full-page fold states | `shell-navigation-drawer.test.js`, `artistTreeReflow.spec.js` |
| GalleryCard, AlbumArtbox, AlbumDetailsHeader/TrackTable | Reuse registered album components and current modal dimensions; migrate touched duplicate markup only | album details and cover lookup artifacts | cover-modal runtime tests and component geometry |
| Cover Look Up source input and notification cards | Extend existing cover lookup/task owners and current backend jobs; retain stable album/task authorization | cover lookup, source-entry and notification artifacts | new source-input tests, existing modal/drawer/task tests, changed Python only |
| ImageLightbox, alerts and confirmation | Reuse shared owners; centered full-size SVG chevrons are the first completed slice | lightbox/notification/dialog artifacts | `lightbox-control-stacking.test.js`, modal/drawer tests, approved E2E after manual acceptance |
| Edit Tags and EditorFooter | Preserve exact live form/list/footer; extend stable selection/reorder at existing editor owner | Edit Tags artifact as behavior reference only | existing tag-editor tests plus new reorder boundary cases |
| GalleryBar and scan FullPage body | Extend the existing abstract GalleryBar with a separate Library Scan instance; FullPage owns body below it | corrected scan reference | new scan full-page test plus existing loader/status tests |
| Appearance profiles | Extend current Appearance UI and Postgres preference owner; migrate legacy base losslessly and retain current layout/player values | Appearance device artifacts | new device-profile JS tests and focused Postgres/API tests |
| Remaining Settings/main/admin/login consumers | Reuse registered families and final Settings layouts; migrate only duplicate primitive markup/styles encountered in Task 10 | approved component catalog | per-consumer focused tests and final two-pass diff review |

Approved case IDs are mapped in the private functional index to their existing area owners. They remain planned and do not change automation counters. The private migration tracker records the seven delivery units and their required review/manual/CI checkpoints.

## Branch reconciliation

Heads were inspected locally; upstream freshness is not claimed. Recheck moving heads and dirty files before applying changes.

| Source | Observed state | Reuse and conflict handling |
| --- | --- | --- |
| Gallery `2026-09-05-gallery-refactor` | Advanced from shared `8111f2e` to `6baadb5` during intake; `.codex-run/` untracked | Reuse the committed soundtrack-duration query fix and its `gallerySoundtrackDuration.spec.js` coverage; do not reproduce it. Its gallery bar change removes the divider only. |
| Settings `2026-09-08-settings-refactor` | `c0821b6`, with preceding `ee8e702` and `03dd32e`, plus substantial uncommitted work | Treat current live source as the reuse reference. Do not bulk-copy dirty files or use the historical checkpoint as current verification. |
| Harbor Mint | Matching existing palette changes in target and Settings | Preserve once. Retain backend normalization, tests, and later Settings migration compatibility. |

Settings reuse owners (under `music_app/static/` unless stated otherwise):

- `js/runtime/utility-renderers-and-actions.js`: `syncUtilityTabAlignment`, active-edge measurements, tab reveal, ResizeObserver and disposal.
- `css/runtime/utilities.css`: joined contour, header placement, neutral filters and wide Settings rows. The tab bar still has `gap: 6px`; zero-gap tabs remain an explicit remaining-UI delta.
- `js/navigation-tree.js`: wide variant, artwork/subtitle/year/trailing slots, `updateItem`, stable selection.
- `js/runtime/trigger-anchor.js`: nested parent ownership and child dismissal.
- `js/button-component.js`: existing copy/cover/search icon paths.
- `js/appearance-backgrounds.js`, `music_app/routes/appearance_asgi.py`, and `music_app/services/appearance_preferences_postgres.py`: loop-control preference, drafts, capability reconciliation and omission-preserving saves.
- Settings suggestions/rules, loops, integrations and log-history modules: existing work belongs to Settings; do not rebuild these features here.

Preserve Settings' explicitly approved caret suppression even inside inputs (`#utility-modal, #utility-modal *`). The remaining global noneditable-only policy must not undo that scoped rule.

Gallery styling needs selective reconciliation: target retains the divider; Gallery removes it; dirty Settings also adds tinted fill, radius and padding. Do not import the extra Settings gallery styling as part of the fold/reflow approval.

Settings currently carries untracked migrations 0063 through 0067, including 0065 loop-control style and 0066 Harbor Mint. Allocate no device migration number until integration ownership is reconciled. Preserve player preferences, aggregate revisions and omission behavior.

Other shared conflict owners: `utility-loaders-and-cover-lookup.js`, `track-modal-and-gallery.js`, `tag-editor-and-optimistic-updates.js`, `track-modal-lightbox-helpers.js`, `gallery-refresh-and-status.js`, `css/gallery-main.css`, the runtime build list and generated bundle. Reconcile sources first, then regenerate the bundle through the existing build.

## Verified current action mappings

Source: `music_app/services/private_route_boundary.py`; grant behavior: `policy_evaluator.py`.

| Action | Existing route and policy key |
| --- | --- |
| Read status | `GET /status`: `app.status.read`; library browse grants can satisfy shell/status reads |
| Start/full rescan | `POST /refresh-api`: `library.refresh` |
| Cancel scan | `POST /cancel-refresh-api`: `library.refresh.cancel` |
| Read refresh | `GET /refresh`: `library.refresh.read` |
| Lookup/start | `POST /utilities/cover-lookup/gallery` and `/start`: `library.covers.lookup` |
| Cancel lookup | `POST /utilities/cover-lookup/task/{task_id}/cancel`: `library.covers.lookup.cancel` |
| Read/manage tasks | `library.covers.tasks.read` and `library.covers.tasks.manage` on existing task endpoints |
| Read remote art/save art | `library.covers.remote.read` / `library.covers.write` on existing endpoints |
| Fetch/cancel covers | `library.covers.fetch` / `library.covers.fetch.cancel` |
| File location/tag edit | `library.files.open_location` / `library.files.edit_tags` |
| Own Appearance | `GET/PUT /account/appearance`: `account.self.appearance.read/write` |

These are observed mappings, not approval of expanded scopes. Current policy supports bootstrap-owner authority, own-account self-service and matching explicit grants, narrowed by deployment/client/origin constraints. Do not infer roles from screen names. Exact target/task/host authorization still needs the Task 1 inventory and denial proposal.

## Approved technical decisions

1. Renderer: **approved 2026-09-20** — use the current JavaScript stack for this remaining-UI scope only. No React migration belongs to this scope. This does not create a reusable exception for other features.
2. Cross-profile editing: **approved 2026-09-20** — this UI refactor adds no permission, grant, preset membership, or cross-account authority. Preserve every existing Cover Lookup, scan, tag-edit, file-location, task, and Appearance authorization check. `account.self.appearance.read/write` remains active-user own-account self-service. The Web/Desktop Appearance selector may target `web_desktop`, `mobile`, or `tv` presentation values for that same account; the selected profile is a validated resource target, never authority by itself.
3. Appearance contract: **approved 2026-09-20** — profiles are `web_desktop`, `mobile`, and `tv`; sections are `main`, `player`, `interaction`, `alerts`, and `album`. `web_desktop` is the base and cannot follow. Mobile/TV sections independently Follow the latest Web/Desktop values or Customize. Dormant custom values remain stored while following. First Customize copies effective base values; later Customize restores retained custom values. Profile/tab switching preserves drafts. Save is atomic under the existing revision-conflict contract; stale/failed writes retain drafts. Migrate the legacy single profile losslessly to Web/Desktop, initialize Mobile/TV to follow, and preserve all player/waveform preferences. Keep the current Appearance screen layout.
4. Permission/preset/deployment/client matrix: **approved 2026-09-20** — preserve existing grants and preset membership. Web desktop and narrow/touch web are required. Tauri is optional through the existing web renderer and existing bridges only. Android, TV, and Apple native clients are unsupported in this delivery. Mobile/TV Appearance profiles support responsive web and future clients without claiming native support. Hosted and self-hosted deployments support browser-only UI and own-account Appearance. Scan, Open Location, folder browsing, and other host-bound actions remain limited by existing media-host/server policy and bridges. Add no filesystem access, native bridge, or remote-host capability.
5. Component ownership: **approved 2026-09-20** — preserve the registered Button/ActionButton, TriggerAnchor, SearchInput, NavigationTree, Settings Header/TabBar, GalleryCard, AlbumArtbox, AlbumDetailsHeader, AlbumTrackTable, CompactDataTable, ImageLightbox, alerts, notification cards, EditorFooter, and confirmation owners. Device profiles compose existing framed selection and Button controls. NavigationTree owns folding. The existing GalleryBar is the shared abstract header-bar component: Gallery and Library Scan use separate instances of it. Library Scan GalleryBar owns Back, title, live summary/status, and scan-relevant actions. FullPage owns only the scan content body below it. Add no copied bar implementation, nested shell, page-local visual tokens, or duplicate live owner.
6. Automated-test scope and sequence: **approved 2026-09-20** — add failing focused tests before each slice. Use JavaScript/unit coverage for shared controls, menus/tabs, Artist Tree folding, GalleryBar/FullPage, Cover Lookup, notifications/lightbox, Edit Tags reorder, and Appearance profiles. Use Python/Postgres coverage only for changed server behavior: Appearance migration/API, cover-task state, scan-state mapping, authorization preservation, revision conflict, and account isolation. Use component/browser geometry coverage for tree reflow, connected menus, drag insertion, GalleryBar instances, and responsive layouts. Reuse the approved case IDs. Run focused local tests, then provide the port-5001 manual build. Add functional E2E after owner manual acceptance. Use CI for complete JavaScript/Python suites. Add performance E2E only when measurement finds uncovered risk.

Task 1 exit evidence is complete: asset hashes, applicable plan reads, fresh real-app baseline, source/component inventory, renderer/permission/storage/client/component/test approvals, private registry entries, case-owner mappings and delivery tracker are recorded. Runtime implementation and acceptance remain open under Tasks 2–10.
