# Sidebar Player and Appearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use executing-plans to implement this plan task-by-task. Follow the repository's separate subagent handoffs for implementation, test authoring, verification, review, commit and publishing. Do not execute the plan merely because it has been written. Steps use checkbox syntax for tracking.

**Goal:** Replace the docked player with the approved tree-wide composition, support A/B/C compact-sidebar behaviors, preserve smooth reassembly at Standard or Slow speed, provide independent floating-edge color, and add the Parchment & Pine theme.

**Architecture:** Extend the existing CompactPlayer/NavigationTree/Appearance ownership boundaries under the explicit current-stack compact-player exception in the private compact-player plan. One presentation resolver determines the visible layout; one coordinated geometry timeline drives sidebar, dock, artwork and play. Existing playback, streaming, queue, loop, transport and account/profile authorities remain unchanged.

**Tech Stack:** Current Jinja templates, plain JavaScript runtime modules and generated bundle, CSS transitions/custom properties, FastAPI, Postgres, node:test, pytest and Playwright. No new framework or animation dependency.

**Plan date:** 2026-09-21.
**Requested branch/worktree:** 2026-09-09-cover-look-up-refactor; C:/Users/Rendref/.codex/worktrees/bf02/album-haven-app.
**Inspected HEAD:** f14640c9afdd1c1640b2b1b383f8549034063a25, with substantial owner/concurrent uncommitted work. File descriptions below include the inspected working tree, not just that commit. Re-read changed boundaries when execution starts.

## Global Constraints

- The owner requested implementation after approving this plan, then explicitly authorized coordination with the overlapping remaining-UI task. SP-D1 execution is in progress; SP-D2 remains gated by D1 acceptance and delivery.
- [Approved artifact](../../design-mockups/components/sidebar-player/v004/mockup.html), [requirements](../../design-mockups/components/sidebar-player/v004/requirements.md), [approval](../../design-mockups/components/sidebar-player/v004/review.json), [palette](../../design-mockups/components/sidebar-player/v004/theme.json). v004 supersedes v001-v003; the old v001 URL is a convenience copy of the latest mock. Use v004 as the exact implementation reference.
- The owner approved all variants, authorized C slightly higher, and requested slow motion in Appearance. v004 raises C by 3px. Do not reopen those design decisions. Design approval does not constitute production manual acceptance.
- This remains the bounded current-stack Compact Player exception documented in C:/Repositories/album-haven-internal/docs/future-feature-plans/compact-player-plan.md. Do not use it to waive React requirements for unrelated post-migration work or migrate/rewrite the audio engine.
- Keep one audible AudioWorklet clock, one same-origin PCM WebSocket, continuity/decoder ownership, queue identity, seek/loop state and listen-session behavior intact.
- Runtime preferences stay Postgres-backed. Do not add file/JSON/localStorage persistence for new appearance settings. Existing compact/expanded device-state behavior is a separate existing contract and is not expanded by this work.
- Reuse existing registered components, theme tokens, native color controls, account appearance endpoints and staged settings footer. Do not ship mock gallery artwork, mock chrome, demo toast actions, alignment guides or fake playback.
- Local checks are focused. One pytest process at a time across all workers. Complete release inventories run in review-first CI, not locally.
- Protect unrelated working-tree changes. No blanket staging, cleanup, reset or history rewrite. Do not publish the currently accumulated branch as one unit without a safe split/checkpoint plan.
- Keep progress observable at least every 60 seconds; audit exact owned processes/ports after interruption and after each E2E wave. Never kill processes by broad name.
- Every unit includes its implementation, meaningful tests, documentation, manual acceptance and release checkpoint. Finish the current unit before unrelated scope.

## 1. Current implementation and ownership map

Paths are relative to the application worktree named above unless explicitly absolute.

| File | Responsibility and required change |
| --- | --- |
| music_app/templates/index.html | Persistent expanded/compact player markup and Artist Tree toggle/rail; adopt approved compact presentation without replacing the audio element/owner. |
| music_app/templates/partials/playback-control-cluster.html | Existing transport macro; reuse for play/pause behavior rather than duplicate its authority/state handling. |
| music_app/static/js/runtime/compact-player-helpers.js | Existing eligibility, style, dock behavior, geometry, drag and queue helpers; add deterministic presentation/motion/edge resolution. |
| music_app/static/js/runtime/compact-player-controller.js | Apply layout, synchronize track/state, focus, resize, drag and album activation; separate configured style from effective presentation. |
| music_app/static/js/runtime/shell-navigation-drawer.js | Fold state and focus owner; notify player in the same layout transaction as the tree. |
| music_app/static/css/app-chrome.css | Current sidebar is 240px expanded/56px folded; implement approved 64px folded rail and coordinated geometry without altering unrelated Settings chrome. |
| music_app/static/css/runtime/non-album-and-player.css | Existing expanded/docked/floating selectors, 220ms transitions, rail-compact chevron; replace superseded compact rules with A/B/C and shared motion tokens. |
| music_app/static/css/runtime/shell-persistent-player.css | Persistent player lane/overlay boundary; preserve layer, modal and narrow-screen behavior. |
| music_app/static/js/appearance-backgrounds.js | Normalize, apply, draft, preview, Save/Cancel/Reset, section field ownership, player settings markup/bindings. |
| music_app/static/js/appearance-device-profiles.js | web_desktop/mobile/tv section custom/follow inheritance; preserve desktop-only applicability. |
| music_app/static/js/appearance-palettes.js | Fixed catalog and palette/player resolver; add Parchment & Pine and narrowly scoped panel ink/edge tokens. |
| music_app/static/css/appearance-backgrounds.css | Consume theme tokens and existing settings controls; do not recolor the whole app with mock-only rules. |
| music_app/services/appearance_preferences_postgres.py | Closed-shape normalization, canonical defaults, profile fields, row expansion, revision-controlled and legacy SQL write paths. |
| music_app/routes/appearance_asgi.py | Existing aggregate route, trusted profile, CSRF and revision behavior; route new fields through the same authority. |
| music_app/templates/partials/appearance-bootstrap.html | Server-rendered first-paint preference state; include new canonical fields without a flash to the wrong layout. |
| migrations/postgres/ | Next numbered additive migrations; existing 0075/0076 are already in this working tree and must not be rewritten or reused. |
| scripts/build-runtime-bundle.cjs; music_app/static/js/runtime-bundle.js; music_app/static/app.js | Existing build/loader contract. Rebuild with the script; never hand-edit generated bundle content. |

Observed flow: toggleArtistTreeFold changes the shell class and dispatches a synthetic resize. The player resize handler then measures the rail with getBoundingClientRect and writes its own width; player transitions are independently 220ms. That coupling is a concrete risk for delayed/retargeted animation. Remove dependence on intermediate measured widths for fold animation; retain real resize/clamp behavior.

The backend has several accepted payload shapes and separate save_preferences/save_device_profiles SQL paths. Adding a field only to the editor or one SQL path will lose preferences. The tasks below explicitly cover every path.

### Support and authority

| Surface | Classification |
| --- | --- |
| Desktop web >900px | required: all A/B/C, Appearance preferences, theme and coordinated motion |
| Tauri | optional: shared web renderer, existing trusted desktop profile |
| Narrow web <=900px | compact-player feature unsupported; existing regular player/drawer fallback must remain correct; theme still works |
| Native Android | unsupported for this desktop compact-player delivery |
| Native TV | unsupported for this desktop compact-player delivery; preserve existing TV profile data/inheritance |
| Native Apple | unsupported for this desktop compact-player delivery |

Hosted and self-hosted retain the existing own-account account.self.appearance.read/write authority, trusted server-derived profile, same-origin/session-CSRF writes and no-store responses. No new role preset, admin grant, playback capability or account selector. Record new preference actions under that existing authority; any implementation that actually expands it must stop at that change rather than infer permission.

## 2. Approved UI and motion contract

| State | Required result |
| --- | --- |
| Tree expanded + docked configuration | Full tree-width footer: cover at left, approved title/artist text, play at right; match v004. No cropped full-player remnants. |
| A: tree compact | 32px play centered under the single top tree toggle, 8px above the bottom. No top rule and no compact chevron. On hover/focus, one 50px artbox unfolds directly above play with a continuous pointer corridor. |
| B: tree compact | Existing 96px floating design with 70px art, 22px shell radius, 17px art radius, existing expand control, 34px play overlapping lower-right. Preserve drag, clamp, pointer cancellation and album activation; animate reassembly to/from the tree-wide dock. |
| C: tree compact | 44px art at rail bottom; play centered on the rail divider in front of it. Relative to the 100px mock footer, art right/bottom are (54,72), play top is 59 and center is (64,75). |
| Sidebar | One top tree toggle icon; no extra mock navigation/brand icons. Preserve actual app navigation elsewhere. Fold/unfold the existing tree, not its selected artist/search. |
| Full player | Existing expanded behavior, waveform/standard seekbar and controls retained. Compact/full transitions do not restart playback. |

The approved dock replaces the former expand/cover/previous-play-next row with the mock's cover/metadata/play composition. Keep previous/next queue operations in their existing full-player controls and shared controller; only retire superseded dock-only UI. Update layout assertions explicitly for this approved delta, not playback/queue expectations.

A art activation retains the reviewed mock's album-details action. C single click expands the full player; double click opens album details without first opening the full player. Keyboard Enter/Space is immediate single activation; ArrowUp on art provides album details. B retains the existing floating click/double-click/drag contract; do not copy C's single-click behavior onto B merely because the mock shares handlers.

### Appearance controls

Retain Compact player style: Docked / Floating. Under Docked, use the existing behavior setting for:

| Label | Stored docked_compact_player_behavior |
| --- | --- |
| Sidebar play button (A) | follow_sidebar |
| Floating when sidebar collapses (B) | float_on_collapse |
| Artbox with corner play (C) | artbox |
| Keep full-width dock when sidebar collapses | stay_docked (existing compatibility choice) |

Stay Docked drag behavior: while the Artist Tree is collapsed, the player may be dragged from any empty player surface, including metadata, but buttons and artwork retain their normal click behavior and never start a drag. Expanding the Artist Tree animates the player back into its dock and clears the session drag position. Every later collapse starts from the default docked position.

The separate Floating style remains always floating, including with the tree expanded. It is not B. Existing users must not silently change styles.

Add under the player Appearance section:
- Player & sidebar animation: Standard / Slow motion.
- Floating player outer edge: Play button color / Theme edge / Custom color, with the existing color picker enabled only for Custom.
- Parchment & Pine in the ordinary theme catalog, not a player-only preset.

Standard reassembly duration = 420ms; Slow motion = 1400ms; easing = cubic-bezier(.22,1,.36,1). A hover-art reveal remains 300ms as in the reviewed mock. Slowness applies only to sidebar/player presentation, not audio, playback controls, seek responsiveness, unrelated dialogs or network operations. All reassembly dimensions/positions/fades share the selected duration and start transaction with no delayed second phase. prefers-reduced-motion takes precedence (1ms or equivalent immediate completion). Keep the saved Slow preference so it resumes if reduced motion is disabled.

## 3. Persistence and compatibility contract

Reuse current fields; add only the new independent preferences.

~~~json
{
  "compact_player_style": "docked",
  "docked_compact_player_behavior": "float_on_collapse",
  "compact_player_motion": "slow",
  "floating_player_edge": {"source": "theme", "color": null},
  "palette_id": "parchment-pine"
}
~~~

This is a field fragment, not a replacement for the route's complete aggregate/revision envelope.

- docked_compact_player_behavior allowed values: follow_sidebar, float_on_collapse, artbox, stay_docked. Existing follow_sidebar becomes the approved A presentation; stay_docked stays pinned at expanded width.
- compact_player_motion allowed values: normal, slow; default normal.
- floating_player_edge is a closed object with source=player|theme|custom and color=null or six-digit HEX. player/theme require null; custom requires a valid color. Normalize color using existing _color. Reject arrays, booleans, malformed values, partial objects and unexpected keys.
- Database columns: compact_player_motion TEXT NOT NULL DEFAULT 'normal'; floating_player_edge JSONB NOT NULL DEFAULT '{"source":"player","color":null}'::jsonb. Use JSONB only within Postgres, not file storage. Add matching check constraints with explicit JSON types/key-count/null checks; SQL CHECK must not accidentally accept SQL NULL from a missing JSON key.
- Preserve every preexisting row and sibling setting. Existing floating outlines keep the player-color source until explicitly changed. Selecting the new theme does not override a separately saved player/edge customization.
- Put both fields in the player section of the current profile model. Top-level desktop backing rows retain client_profile='desktop'; editor section keys remain web_desktop/mobile/tv. Do not conflate those names or trust a new client-supplied profile.
- Legacy writes omitting either new field preserve the current value on UPDATE; only brand-new rows use defaults. An explicit player-section Reset resets these fields; full workspace Reset follows the existing reset contract.
- Preserve mobile/tv custom/follow records and unrelated sections. The new desktop controls are hidden on unsupported runtime surfaces, even if profile data is inherited.
- Existing revision conflicts remain conflicts; do not overwrite another tab's values. Failed Save keeps a retryable draft and cannot become persistent browser-only success.

No destructive down migration. Rolling back UI should leave added columns and stored values intact. A rollback build must tolerate the new palette/behavior values or first map only incompatible rows to documented predecessors while saving their original values in the existing supported database migration mechanism. Do not recommend blindly deploying an older binary that rejects a new palette or overwrites unknown enum values. Maintain a tested compatibility release; no schema drop/data loss.

## 4. Delivery units

| Unit | Outcome / included IDs | Prerequisites | Acceptance and rollback | Merge/publish checkpoint |
| --- | --- | --- | --- | --- |
| SP-D1 | Parchment & Pine available throughout Appearance; SP-08 | Approved palette, current branch checkpoint, catalog/token inspection | Saves/reloads; mixed light content/dark rail/player; old palettes unchanged; additive DB allowlist, compatible rollback retains value | Focused palette checks, manual theme acceptance, required full review-first CI, merge/publish/sync before D2 |
| SP-D2 | Complete dock + A/B/C + edge + Standard/Slow; SP-01–07, SP-09–10 | D1 synchronized main, approved v004, preference contract and automated-case proposal | All behaviors and profile compatibility, uninterrupted audio, accessible motion/gestures; additive schema and compatibility rollback above | Focused checks, exact owner manual script, approved E2E additions, two-pass local review and required full CI before merge/publish/sync |

These are cohesive user outcomes, not a PR for every internal task. D2 must not ship a selector for an unavailable behavior, an unfinished dock or a half-persisted setting. Each internal task below may be committed separately for review without making it a public delivery.

## 5. Task 0 — Checkpoint and execution intake

**Files:** approved v004 artifacts; this plan; existing remaining-UI implementation plan; private compact-player plan/permission/component registries.

- [x] Read current AGENTS.md and applicable private workflow guardrails; confirm the current-stack exception still applies.
- [x] Capture HEAD, status and scoped diffs in the named worktree. Identify other running tasks/owners before touching files with concurrent changes.
- [ ] Build a safe delivery branch/checkpoint from current intended work; do not stage or publish unrelated accumulated files. Use a commit handoff for that checkpoint.
- [x] Re-read the file map against the execution base. If upstream has migrated this exact boundary to React, reuse its current owner rather than resurrect legacy code.
- [x] Confirm v004 approval is linked in the owning plan and component registry; retain the owner's exact quote in review evidence.
- [ ] Register the test proposal/case IDs in the private functional-case registry before execution. Reuse FTC-PLAYER-019–022 and add named subcases below rather than inventing conflicting global IDs.
- [ ] Assign independent subagent handoffs for implementation, test authoring, verification, review, commit and publish while enforcing one pytest process.

Read-only intake commands:

~~~powershell
rtk git status --short
rtk git rev-parse HEAD
rtk git diff -- music_app/static/js/runtime/compact-player-controller.js music_app/static/js/appearance-backgrounds.js music_app/services/appearance_preferences_postgres.py
rtk rg --files migrations/postgres
~~~

Expected: an explicit owned base and delivery scope, not a clean-state claim when the worktree is dirty. Migration filenames in Tasks 1/3 are next-slot proposals; reserve the actual next free numeric IDs during this checkpoint and record them here before writing them.

## 6. Task 1 — SP-D1 palette, schema allowlist and scoped tokens

**Files**
- Modify: music_app/static/js/appearance-palettes.js; music_app/static/js/appearance-backgrounds.js; music_app/static/css/appearance-backgrounds.css.
- Modify: music_app/services/appearance_preferences_postgres.py.
- Create: migrations/postgres/0077_allow_parchment_pine_appearance_palette.sql if still the next free slot.
- Tests: tests/js/runtime/appearance-palettes.test.js; tests/py/test_appearance_palettes.py; tests/py/test_postgres_migrations.py; tests/components/appearanceWorkspace.spec.js.
- Documentation: approved theme.json plus private component registry.

**Interface:** resolveAppearance continues returning main, panel, tokens, player, mode. Add palette id parchment-pine; do not fork the resolver or add page-local hardcoded colors.

- [x] Add failing resolver and backend tests for the new ID, selected panel index, existing palettes and explicit custom player override precedence. Example new JS case:

~~~javascript
test('Parchment & Pine keeps beige content and dark player', () => {
  const { resolveAppearance } = require('../../../music_app/static/js/appearance-palettes.js');
  const value = resolveAppearance({ palette_id: 'parchment-pine', panel_index: 0 });
  assert.equal(value.main.toLowerCase(), '#e8e0cf');
  assert.equal(value.panel.toLowerCase(), '#101512');
  assert.equal(value.tokens.player.toLowerCase(), '#10251e');
  assert.equal(value.tokens.play.toLowerCase(), '#38b977');
});
~~~

- [x] Run that exact new test before implementation and record the expected unknown-palette failure.
- [x] Add the palette using exact approved theme.json roles. Main=#E8E0CF; main ink=#393C32; main muted=#777C6C; line=#C7C4B4; rail=#101512; rail ink=#E2F0E5; rail muted=#98A79B; rail line=#354237; player=#10251E; player ink=#D7E4DA; play=#38B977; play ink=#083820; focus=#81DFA9.
- [x] Reuse the existing three companion slots with mock-derived surfaces: Pine #101512, Deep Pine #11241D, Lifted Pine #15241B. Companion 0 is the exact approved reference; do not invent another palette.
- [x] Keep mode='light' for beige main content; add only needed scoped panel-ink/panel-muted/panel-line tokens using existing fallback values for old palettes. Set local color-scheme:dark on dark rail/player controls. One global light ink token must not make rail labels unreadable.
- [x] Map theme floating edge=#101512 as a palette token for D2. Keep waveform, control overrides and existing native component provenance authoritative.
- [x] Extend APPEARANCE_PALETTE_IDS and the existing database palette allowlist in an additive migration modeled after 0071. Preserve all old IDs and the existing palette/player-shape constraint clauses verbatim apart from the added ID.
- [x] Test migration against representative custom-background, default, existing fixed-palette and custom-player rows; verify IDs/counts, revision and values are unchanged.
- [ ] Run focused checks below, verify actual DOM colors and readable controls, then commit this coherent palette change.

~~~powershell
rtk node --test --test-name-pattern="Parchment" tests/js/runtime/appearance-palettes.test.js
rtk powershell -NoProfile -File scripts/test.ps1 tests/py/test_appearance_palettes.py -q
rtk node --test tests/js/runtime/appearance-palettes.test.js tests/js/runtime/appearance-editor-theme.test.js
~~~

Migration verification must use the repository's isolated Postgres fixture and the new specific migration case, not an owner's database.

## 7. Task 2 — SP-D1 acceptance and delivery

- [ ] Verify palette preview, Save/reload, Cancel, Reset, companion selection and current player override in the real application.
- [ ] Check main gallery, Artist Tree, Appearance, album dialog and player; inspect contrast without changing unrelated layout. If an approved color fails readability, record the exact foreground/background issue and adjust only the necessary semantic role with owner review.
- [ ] Obtain owner manual acceptance for the live palette; then add the approved palette persistence case to tests/e2e/specs/appearanceControls.spec.js and its existing Appearance action/POM abstractions.
- [ ] Run focused component/palette verification; complete at least two full local diff review passes. Fix every validated finding; a substantive second-pass finding requires another full pass.
- [ ] Follow all required repository review handoffs; preserve review evidence/cost accounting. Push to the complete native review-first PR pipeline. Let all required applicable suites finish.
- [ ] Fix the full genuine failure inventory with narrow local reproduction; rerun the complete pipeline. Do not replace full CI with a focused hosted pass.
- [ ] Merge/publish only after required gates, then synchronize local main and start SP-D2 from that base. Attach any created PR to the task.

## 8. Task 3 — SP-D2 backend preference contract

**Files**
- Modify: music_app/services/appearance_preferences_postgres.py; music_app/routes/appearance_asgi.py; music_app/templates/partials/appearance-bootstrap.html.
- Create: migrations/postgres/0078_sidebar_compact_player_preferences.sql if free after D1.
- Tests: tests/py/test_compact_player_appearance.py; tests/py/test_appearance_device_profiles.py; tests/py/test_account_appearance_asgi.py; tests/py/test_appearance_compatibility_live.py; tests/py/test_appearance_concurrency_live.py; tests/py/test_postgres_migrations.py.

**Interface:** fields/enums/defaults in Section 3, through existing aggregate GET/PUT and device sections. Existing routes/revision envelopes and account identity remain unchanged.

- [x] Add failing normalization tests for each behavior, normal/slow, all edge sources and invalid enum/color/object shapes. Example using existing pure expansion contract:

~~~python
def test_compact_motion_default_and_slow_value_are_canonical():
    from music_app.services.appearance_preferences_postgres import expand_appearance_preferences
    base = {"main_surface_color": None, "panel_background_color": None}
    assert expand_appearance_preferences(base)["compact_player_motion"] == "normal"
    assert expand_appearance_preferences(
        {**base, "compact_player_motion": "slow"}
    )["compact_player_motion"] == "slow"
~~~

- [ ] Run the exact failing case, then extend the existing normalization functions rather than add another appearance service. Reuse this closed edge validator pattern:

~~~python
def _floating_player_edge(value):
    if not isinstance(value, Mapping) or set(value) != {"source", "color"}:
        raise ValueError("Floating player edge requires source and color.")
    source = _closed_choice(
        value["source"], frozenset({"player", "theme", "custom"}),
        "Unknown floating player edge source."
    )
    color = _color(value["color"])
    if source == "custom" and color is None:
        raise ValueError("A custom floating player edge color is required.")
    if source != "custom" and color is not None:
        raise ValueError("Linked floating player edge cannot store a fixed color.")
    return {"source": source, "color": color}
~~~

- [x] Add optional new keys to currently accepted payload shapes without converting strict validation into arbitrary-key acceptance. Omitted optional fields must remain distinguishable from explicit reset/default values on write.
- [x] Update _STORAGE_FIELDS, row/select expansions, canonical defaults, _DEVICE_SECTION_FIELDS and aggregate read/write fields consistently.
- [x] Update both save_device_profiles and every relevant save_preferences branch: revision-controlled aggregate, canonical preferences, legacy compact-only and background-only writes. Keep insert column/value order and SQL parameters aligned. Use COALESCE/explicit presence logic to preserve omitted fields, not unconditional defaults on UPDATE.
- [x] Add the two columns/check constraints and extend docked behavior's allowed values in the new migration. Do not modify applied 0076. Check JSON key/type/null cases at DB level as well as Python.
- [ ] Test own-account/profile isolation, CSRF, revision conflicts, invalid payload atomic rejection, explicit Reset, missing fields on old clients, and preservation of custom mobile/tv player sections.
- [x] Verify server bootstrap contains effective initial settings so the client does not briefly paint the legacy compact state.
- [ ] Run focused backend tests sequentially; commit schema/service/route/tests together within D2.

~~~powershell
rtk powershell -NoProfile -File scripts/test.ps1 tests/py/test_compact_player_appearance.py::test_compact_motion_default_and_slow_value_are_canonical -q
rtk powershell -NoProfile -File scripts/test.ps1 tests/py/test_compact_player_appearance.py tests/py/test_appearance_device_profiles.py tests/py/test_account_appearance_asgi.py -q
~~~

Live migration/concurrency selections run only against uniquely owned test schemas through existing fixtures. Never launch these pytest commands concurrently.


## 9. Task 4 — SP-D2 staged Appearance controls and profile handling

**Files**
- Modify: music_app/static/js/appearance-backgrounds.js; music_app/static/js/appearance-device-profiles.js; music_app/static/css/appearance-backgrounds.css.
- Tests: tests/js/runtime/appearance-workspace.test.js; tests/js/runtime/appearance-device-profiles.test.js; tests/js/runtime/appearance-palettes.test.js; tests/components/appearanceWorkspace.spec.js.
- Reuse: music_app/static/js/utilities/appearance-tab.js as the existing host; do not duplicate settings in another modal.

**Interface:** the existing createController draft/save/reset lifecycle owns all added fields. applyAppearance emits current root attributes/tokens and the existing album-haven-appearance-change event.

- [x] Add failing draft tests: change A/B/C, edge, and motion; immediate preview; Cancel restores all three; Save and reopen retain them; a failed/conflicting Save retains draft and original authoritative saved values.
- [x] Extend canonicalEmpty, normalizePreference, appearancePreferenceSections, PLAYER section fields and profile-copy/reset logic with the same defaults as Python.
- [x] Keep the legacy top-level Docked/Floating selector. Extend its dock behavior group with A/B/C and preserve the existing stay-docked option. Disable inapplicable controls without discarding their saved values.
- [x] Render Standard/Slow motion in the existing player Appearance section using the approved shared selector. Reuse the source/custom-color control pattern for floating outer edge; do not expose raw JSON.
- [x] Add draft-controller setters following existing setCompactPlayerStyle/setDockedCompactPlayerBehavior patterns. One setter changes one setting and previews through the existing apply hook, not a direct DOM-only mutation.
- [x] Apply data-compact-player-motion=normal|slow and --compact-floating-edge-color through the normal token path. Theme edge resolves from the selected palette, player source resolves from effective play color, custom resolves to its validated RGB value.
- [x] Preserve other desktop/player overrides and device-section custom/follow semantics; do not reset them when switching the active profile tab.
- [x] Include search labels so existing Settings search finds "compact", "sidebar", "floating", "edge" and "slow motion". No new Settings section.
- [ ] Verify actual rendered controls and shared footer behavior, then commit controller/editor/tests together.

Focused verification:

~~~powershell
rtk node --test tests/js/runtime/appearance-workspace.test.js tests/js/runtime/appearance-device-profiles.test.js tests/js/runtime/appearance-palettes.test.js tests/js/runtime/settings-appearance-search.test.js
rtk npm run test:component -- tests/components/appearanceWorkspace.spec.js
~~~

Expected: saved/draft differences and profile isolation asserted through public controller behavior; component tests exercise real controls rather than only matching source strings.

## 10. Task 5 — SP-D2 deterministic presentation and motion resolution

**Files**
- Modify: music_app/static/js/runtime/compact-player-helpers.js.
- Tests: tests/js/runtime/compact-player-helpers.test.js.

**Interfaces to add to the existing helper exports**
- resolveCompactPlayerPresentation({eligible, mode, style, behavior, artistTreeFolded}) -> expanded | docked | rail_play | floating | rail_artbox.
- resolveCompactPlayerMotion({speed, reducedMotion}) -> {durationMs, hoverDurationMs}.
- normalizeDockedCompactPlayerBehavior recognizes the extended enum; frontend fallback is follow_sidebar, backend still rejects invalid persisted input.

Reference implementation of the small pure decision boundary:

~~~javascript
function resolveCompactPlayerPresentation({
  eligible, mode, style, behavior, artistTreeFolded,
} = {}) {
  if (!eligible || mode !== 'compact') return 'expanded';
  if (normalizeCompactPlayerStyle(style) === 'floating') return 'floating';
  const dockBehavior = normalizeDockedCompactPlayerBehavior(behavior);
  if (!artistTreeFolded || dockBehavior === 'stay_docked') return 'docked';
  if (dockBehavior === 'float_on_collapse') return 'floating';
  return dockBehavior === 'artbox' ? 'rail_artbox' : 'rail_play';
}

function resolveCompactPlayerMotion({speed, reducedMotion} = {}) {
  return reducedMotion
    ? {durationMs: 1, hoverDurationMs: 1}
    : {durationMs: speed === 'slow' ? 1400 : 420, hoverDurationMs: 300};
}
~~~

- [x] Add table-driven failing tests for all styles/behaviors with folded/unfolded, compact/expanded and eligible/ineligible inputs. Include always-floating vs B and stay-docked compatibility.
- [ ] Add exact reduced-motion/slow/default assertions:

~~~javascript
test('reduced motion wins over the saved slow preference', () => {
  const h = loadHelper();
  assert.deepEqual(
    plain(h.resolveCompactPlayerMotion({speed: 'slow', reducedMotion: true})),
    {durationMs: 1, hoverDurationMs: 1}
  );
});
~~~

- [x] Add enum normalization and invalid-input fallback tests without weakening server validation.
- [x] Implement the two helpers and export them through the existing global/CommonJS boundary.
- [x] Keep queue/drag helpers unchanged; re-run their existing cases to prove the additional presentation states did not change queue eligibility or drag thresholds.
- [ ] Commit the resolver/tests inside D2. Do not expose unfinished selectors in a published release.

~~~powershell
rtk node --test --test-name-pattern="presentation|reduced motion|docked|floating" tests/js/runtime/compact-player-helpers.test.js
rtk node --test tests/js/runtime/compact-player-helpers.test.js
~~~

## 11. Task 6 — SP-D2 approved markup, layout and single geometry timeline

**Files**
- Modify: music_app/templates/index.html; music_app/static/css/app-chrome.css; music_app/static/css/runtime/non-album-and-player.css.
- Modify: music_app/static/js/runtime/compact-player-controller.js; music_app/static/js/runtime/shell-navigation-drawer.js.
- Reference: music_app/templates/partials/playback-control-cluster.html; music_app/static/js/runtime/playback-control-cluster.js; music_app/static/css/runtime/shell-persistent-player.css.
- Tests: tests/components/playerViews.spec.js; tests/components/artistTreeReflow.spec.js; tests/js/runtime/shell-navigation-drawer.test.js; tests/js/runtime/shell-persistent-player-layout.test.js.

**Interfaces:** shell fold state is the authoritative input. The controller consumes resolveCompactPlayerPresentation and effective motion/edge settings; presentation changes must not change compactPlayerStyle (the stored choice).

- [ ] Add failing browser component cases for 64px compact rail, single top toggle, tree-wide dock, A bottom alignment/upward art reveal/no chevron, B current floating dimensions/corner play, and C approved corner position.
- [x] Reuse a stable compact player root/art/play node throughout A/B/C and dock transitions. Do not rebuild the player with innerHTML on every fold. Existing expanded-player markup stays mounted with inert/focus handling.
- [x] Replace dock-only cropped layout with approved cover/metadata/play composition. Apply title/artist text via textContent and current track display data. Preserve unknown-art/no-track/loading/ownership-lock states and accessible play labels.
- [x] Keep one tree toggle at the top in each visible rail state, with aria-controls and aria-expanded matching the existing tree. Reuse current action_button macro and handler; do not transplant fake navigation items from the mock.
- [x] Change compact shell width from 56px to approved 64px in its shared shell boundary. Scope to application Artist Tree; do not change Settings navigation widths.
- [x] Introduce one registered, inherited length variable for the current animated rail width, set at the common layout ancestor accessible to both the fixed player and shell. Read it in both consumers; do not transition a measured width a second time.

Reference CSS geometry mechanism (integrate with existing selectors; no duplicate style system):

~~~css
@property --compact-rail-width {
  syntax: "<length>";
  inherits: true;
  initial-value: 240px;
}
:root {
  --compact-motion-duration: 420ms;
  --compact-motion-easing: cubic-bezier(.22,1,.36,1);
  transition: --compact-rail-width var(--compact-motion-duration)
    var(--compact-motion-easing);
}
:root[data-compact-player-motion="slow"] {
  --compact-motion-duration: 1400ms;
}
#app-shell {
  --app-sidebar-width: var(--compact-rail-width);
}
@media (prefers-reduced-motion: reduce) {
  :root { --compact-motion-duration: 1ms; }
}
~~~

The fold owner sets the target rail width to 64px/expanded width in the same transaction that applies effective player presentation. Do not animate width/left again on elements already consuming the interpolated variable. Artwork/play/floating offset properties use the same duration/easing and no transition delay. Existing layout measurements may initialize expanded width/left and handle genuine viewport changes, not chase intermediate animation frames.

- [x] Replace the player dependency on synthetic resize with a direct, named compact-presentation synchronization at the shell fold boundary. Audit other resize consumers before removing the synthetic event; unrelated listeners must retain their necessary layout updates.
- [ ] Keep the fixed player's coordinate space correct under app bar, scroll, resize and Settings/overlay transitions. Do not assume the rail's left edge is always zero when current shell state says otherwise.
- [x] Preserve distinct always-floating and float-on-collapse state. For B, use the prior floating position for the current visit after a user drags it; reassemble back into the dock when the tree expands, then return to the clamped visit position on the next collapse. Reset on a new page visit.
- [x] Limit drag eligibility to effective floating presentation, not stored style alone. During drag, position changes are immediate; end-of-drag does not trigger a delayed 1400ms chase.
- [x] Set floating border/ring to --compact-floating-edge-color while preserving existing surface/glow/focus treatment. The edge must not be overwritten by waveform-edge or forced back to green on hover.
- [x] Ensure all shadows and overlapping play controls are outside rail overflow clipping. Clamp the union of floating shell and protruding controls, not just the old 96px shell box.
- [x] Verify intermediate frames: rail and dock share the edge continuously, play/art move monotonically toward targets, reverse from their current positions, and settle together. Do not approve only final screenshots.
- [ ] Re-run focused layout/component checks and commit.

~~~powershell
rtk node --test tests/js/runtime/shell-navigation-drawer.test.js tests/js/runtime/shell-persistent-player-layout.test.js tests/js/runtime/compact-player-helpers.test.js
rtk npm run test:component -- tests/components/playerViews.spec.js tests/components/artistTreeReflow.spec.js
~~~

Do not blindly regenerate snapshots to conceal discrepancies. Change only the approved dock/compact frames after checking the exact v004 visual and preserving existing full-player assertions.

## 12. Task 7 — SP-D2 interaction, focus and playback continuity

**Files**
- Modify: music_app/static/js/runtime/compact-player-controller.js; music_app/static/js/runtime/compact-player-helpers.js only where pure gesture decisions belong.
- Tests: tests/components/compactPlayerFocus.spec.js; tests/components/playerViews.spec.js; tests/js/runtime/compact-player-helpers.test.js.
- Existing playback owners remain unchanged: music_app/static/js/runtime/player-loop-playback.js and the streaming facade. A change there requires concrete evidence, not presentation convenience.

- [ ] Test A hover and keyboard focus: art reveals above play; pointer traverses the gap without closing; focus into art keeps it visible; leaving both closes it. Invisible artwork must not intercept clicks or remain in the tab order.
- [ ] Remove the compact A chevron from both visible rendering and focus/accessibility tree. Do not introduce a replacement icon the owner dropped.
- [ ] Test C single click vs double click, immediate keyboard single activation, ArrowUp details, touch activation, cancelled drag and rapid repeated activation. Preserve the reviewed 300ms discrimination without delaying keyboard activation. Clear the pending single-click timer on double click, presentation switch, track change and teardown.
- [ ] Test B's existing drag threshold (6px), pointer capture/cancel, suppressed post-drag click, resize clamp, keyboard expansion and double-click details. Keep its existing no-drag click behavior; C-specific expansion must not leak into B.
- [ ] Preserve focus when the active control disappears: move to corresponding incoming play/control, never to body or a hidden node. Pointer activation must not accidentally pin a keyboard-only focus ring or keep the art hover open indefinitely.
- [ ] Exercise idle/no current track, paused/playing, first/last queue track, ownership locked in another tab, loading/missing art and source changes. Only presentation changes; disabled semantics remain authoritative.
- [ ] Confirm folds, B relocation, motion speed, edge color and theme do not call playback start/stop, select another track, recreate AudioWorklet/WebSocket, seek, reset a loop or drop listen-session identity.
- [ ] Respect media-query changes live: turning reduced motion on during a slow transition completes safely; returning to normal restores the saved speed. No perpetual requestAnimationFrame loop or lingering observer/listener is introduced.
- [ ] Run focused tests below and commit validated interaction changes.

~~~powershell
rtk node --test tests/js/runtime/compact-player-helpers.test.js tests/js/runtime/playback-control-cluster.test.js
rtk npm run test:component -- tests/components/compactPlayerFocus.spec.js tests/components/playerViews.spec.js
rtk npm run build:runtime
rtk node --test tests/js/runtime/app-loader-bundle.test.js
~~~

Generated bundle diff is expected only after source changes; build reproducibility and loader ordering must pass.

## 13. Task 8 — SP-D2 focused verification and owner manual acceptance

Run the focused JS/Python/component selections already listed once against the final implementation; do not rerun unchanged broad suites just to fill time. Keep pytest serial. Then provide a real application build and this manual script, recording browser/viewport, saved settings and playback fixture.

1. Open Appearance on desktop. Confirm Parchment & Pine, Docked/Floating, A/B/C/stay-docked, Standard/Slow motion and floating edge choices are present in the intended sections.
2. Start a known album and collapse the full player. With the tree expanded, verify the new dock occupies exactly the tree width and matches the approved cover/metadata/play layout.
3. Select A; collapse the tree. Confirm only the top tree toggle remains, play is centered and 8px above the rail bottom, no white rule/chevron, glow crosses the sidebar edge.
4. Hover play and travel upward to art, then outside. Repeat using Tab and Shift+Tab. Art opens above play smoothly and remains reachable. Activate art to open the playing album's details.
5. Expand/collapse repeatedly in Standard mode, including reversing mid-transition. Watch the rail, artwork, labels and play reassemble without a pause or second catch-up.
6. Select Slow motion in Appearance. Preview, Save, reload, and repeat step 5. Reassembly takes about 1.4 seconds while play/pause and seek respond immediately.
7. Turn on system reduced motion. Verify geometry changes complete near-instantly despite saved Slow; turn it off and confirm Slow resumes.
8. Select B. Expand/collapse tree and confirm dock/floating reassembly. Drag the floating player, fold/unfold again, resize, and test expand/details gestures. Every control remains reachable at viewport edges.
9. Select each floating edge source, including a dark theme edge and a custom contrasting color. Verify only the shell edge/ring changes; play/art/waveform keep their intended colors. Save/reload and Cancel a later change.
10. Select C. Confirm play is centered on the divider and overlaps the artbox lower-right at the v004 position. Single art click opens full player; double click opens album details without a full-player flash. Test Enter/Space and ArrowUp.
11. Pause and resume, move to queue ends using the regular controls, enable a loop, and fold repeatedly. Verify the same track/position and continuous audio/loop behavior, including ownership lock in a second tab.
12. Verify old always-floating and stay-docked preferences still behave as before. Verify a second account is unaffected and mobile/tv custom profile data was not overwritten.
13. Resize to 900px and below. Existing regular-player/drawer fallback appears, all necessary controls stay accessible, and new compact controls do not leak into the narrow layout.
14. Check 125% and 200% zoom, no-track/missing artwork, Settings open/close, album details and keyboard focus restoration.
15. Save/Cancel/Reset each new preference; reload; provoke a legitimate revision conflict through two Appearance tabs and confirm it does not silently overwrite another draft.

Record pass/fail per step and exact screenshots for dock/A/B/C at normal and reduced-motion final states. A failed step returns to the responsible task; do not move forward because the mock was approved. Wait for owner acceptance before adding the feature's new functional E2E contract.

## 14. Task 9 — Approved E2E coverage and performance assessment

**Existing files to extend**
- tests/e2e/specs/playerViewModes.spec.js (FTC-PLAYER-019/020/021/022, @area:playback).
- tests/e2e/specs/appearanceControls.spec.js.
- tests/e2e/poms/components/compactPlayer.js; tests/e2e/poms/components/compactPlayerStyleControl.js.
- tests/e2e/poms/utilityAppearanceTab.js; tests/e2e/actions/utilityAppearanceActions.js.
- tests/ci/functional-shards.json and tests/ci/test-data-matrix.json only when registration/ownership requires updates.
- C:/Repositories/album-haven-internal/docs/functional-test-cases.md.

### Test-case additions

| Case family | Concrete coverage |
| --- | --- |
| FTC-PLAYER-019 reassembly | Same selected track, exact-stream PCM/non-zero samples and renderer progress before/during/after A/B/C folds; loop and ownership remain unchanged |
| FTC-PLAYER-020 floating | B vs always-floating, drag threshold/cancel/click suppression, corner play, all-control viewport clamp, saved edge source/color |
| FTC-PLAYER-021 dock/rail | Tree-wide approved dock, single top toggle, A upward artwork/no chevron, C corner placement and distinct single/double-click behavior, keyboard reach/focus |
| FTC-PLAYER-022 Appearance | A/B/C/stay-docked + Standard/Slow persistence; old payload omission preservation; profile isolation; reduced-motion priority; existing narrow fallback |
| Existing Appearance journey | Parchment & Pine and companion selection, mixed surfaces, overrides; preview/save/cancel/reset/reload and revision conflict for added fields |

The old rail-compact chevron-visible assertion conflicts with the explicitly approved no-chevron design; replace that specific visual assertion with the stronger A contract. Do not weaken existing audio, queue, ownership, drag, profile, or narrow-screen expectations. Move old dock-only transport layout assertions to their still-supported full-player journey where needed; retain queue behavior coverage.

- [ ] Add cases only after owner accepts the live implementation and approves the test proposal. Each state-mutating case uses unique owned preferences and restores them.
- [ ] Drive the production app using existing fixture/POM/action layers. No test-only routes, API responses, DOM mutations or injected playback states.
- [ ] Use existing playbackEvidence exact-stream/renderer evidence, not only an icon or title, for audio-continuity assertions.
- [ ] Register exact case title/ownership in the native selectors; keep @area:playback and other existing tags.
- [ ] Run the narrow existing player journey locally via the supported selector:

~~~powershell
rtk powershell -NoProfile -File scripts/run-functional-e2e-local.ps1 -Case "FTC-PLAYER-019 / FTC-PLAYER-020 / FTC-PLAYER-021 / FTC-PLAYER-022 switches expanded, docked, and floating player views without sharing runner state"
rtk npm run check:e2e-production-parity
~~~

If the execution base changes the registered title, use the exact title returned by the script's -List output and record it, not an approximate grep or a direct unauthenticated hosted dispatch.

### Performance assessment

Shared rail-width animation triggers gallery reflow. Profile normal and slow folds with representative small and large libraries, including rapid reversal and resize. Inspect layout/paint work, dropped frames, synchronous measurements, event/listener counts and retained DOM. Do not use a global animation loop or repeatedly write interpolated widths.

Timing checks distinguish deliberate duration from startup lag: a 1400ms slow transition is intentional, not a latency failure. Check that visible motion begins with the sidebar and the player settles with it, not after an extra duration. Reduced motion must not run the slow path.

First record whether profiling shows measurable risk. Add performance E2E only when that assessment justifies it, with an explicit product target and the required separate grace band (200ms below 1000ms targets, 400ms at/above 1000ms) and hard ceiling. Do not widen an existing benchmark or invent a lower standard to pass this design. Slow-motion duration itself is not permission to relax playback or interaction performance contracts.

After each E2E wave, audit the exact owned application/browser/Playwright/Python/Node tree and task ports. Do not start another heavyweight wave until those owned processes have exited.

## 15. Task 10 — Review, CI, publication and documentation closure

- [ ] Reconcile the complete D2 diff against v004, SP-01–SP-10, the field matrix, compatibility scenarios and all manual results.
- [ ] Complete at least two adversarial full local review passes, including tests/docs/CSS and generated-source ownership. Fix validated findings; if pass two finds a substantive problem, perform a third full pass afterward. Challenge needless helpers, duplicate state, selector conflicts, stale timers/listeners and repeated geometry measurements.
- [ ] Follow the repository's required Branch Review Process Flow and review handoffs. Preserve hosted-review scope, tokens/cost/elapsed evidence and unknown costs as unknown.
- [ ] Commit the cohesive D2 unit with a scoped Conventional Commit. Push to the native complete PR pipeline, retaining required reviewers and test gates.
- [ ] Applicable reviewers must succeed before tests begin. Collect all genuine failures while the head remains a merge candidate. A validated review finding requiring a new commit permits cancelling its superseded run before expensive tests, with stopped-job evidence.
- [ ] Reproduce each genuine failure narrowly locally, fix the whole inventory, then rerun complete CI. Do not treat a focused hosted job, skipped tests or cancelled run as publication approval.
- [ ] After manual acceptance and all required gates, merge/publish and synchronize local main. Finish D2 before unrelated work.
- [ ] Update the private compact-player plan, component/permissions/functional-case registries and owning implementation plan with final behavior, actual migration IDs, accepted tests, links to approved artifacts and release evidence.
- [ ] Preserve the immutable v004 approval record. Mark production implementation/manual acceptance separately with evidence instead of rewriting historical approval.
- [ ] Attach every created PR to the task and report final user outcome plus any unresolved limitations.

## 16. Plan self-review and execution status

Coverage mapping:
- SP-01 tree-wide replacement: Tasks 6, 8, 9.
- SP-02 one top toggle: Tasks 6, 8, 9.
- SP-03 A bottom play/upward art/no chevron: Tasks 5–9.
- SP-04 B existing floating design/corner play: Tasks 5–9.
- SP-05 C slightly raised corner/single-double click: Tasks 6–9.
- SP-06 coordinated animation: Tasks 5–9.
- SP-07 behavior/edge preferences: Tasks 3–4, 6, 8–9.
- SP-08 palette: Tasks 1–2.
- SP-09 compatibility, accessibility, audio and release acceptance: Tasks 3–10.
- SP-10 saved Slow motion: Tasks 3–9.

Plan reviewed for missing requirements, field-name consistency, current-stack ownership, database write-path coverage, stale visual assertions, delivery boundaries and no unintended audio changes. Runtime execution remains unchecked. Static validation of the HTML mock is not a production browser test. Manual acceptance and future CI are required at the explicit checkpoints above.


## Owner plan approval — September 21, 2026

The owner approved this implementation plan with the message "Approved". Design approval and implementation-plan approval are recorded. Per the repository planning-request guidance, this planning-origin task remains documentation-only until an explicit request for code implementation. No implementation tasks are marked complete; production work, focused verification, manual acceptance, CI and publication remain pending.


## Execution handoff - September 21, 2026

The owner requested "Implement" and then "Yes. Coordinate". Task `4 UI refactor the rest` released the D1 files and confirmed no active writer or test process. The execution base is HEAD `f14640c9afdd1c1640b2b1b383f8549034063a25` plus its existing uncommitted prerequisite work. Migrations 0075/0076 and all unrelated changes are preserved. Migration 0077 is reserved for the palette allowlist.

A recoverable pre-edit copy and SHA256 manifest of D1 files is stored at `C:/Users/Rendref/AppData/Local/Temp/sidebar-player-d1-y6ZtJm`. This is a local recovery checkpoint, not a commit or a publishable dependency base. Per the coordination handoff, no staging, commit, reset or publication occurs during this shared-worktree implementation. The safe dependency split and commit handoff remain open before any delivery; D2 requires fresh ownership coordination and the existing D1 gates.

Execution scope: SP-D1 palette, scoped semantic colors, additive allowlist migration, focused unit/integration/component verification and live owner acceptance. Separate workers own test authoring, runtime implementation and verification. Existing playback behavior and SP-D2 preferences remain unchanged in D1.

Contrast intake: approved main-muted #777C6C on main #E8E0CF measures 3.27:1. Preserve the reference palette; validate actual small-text consumers and present any necessary semantic-role adjustment for owner review. Other measured pairs: main ink 8.57:1, rail muted 7.32:1, player ink 12.26:1.

No completion checkbox changes at intake; production acceptance, review, CI and publication remain pending.


### SP-D1 focused implementation and review result

Implemented Parchment & Pine with three companions, saved palette allowlist, scoped dark-panel tokens and readable light-content text. Automatic panel action colors and focus now resolve at the existing shared interaction boundary; explicit colors and player-linked outlines retain precedence. The approved muted swatch remains in the catalog, while small main/editor text uses content ink for contrast.

Focused verification: 70 Node palette/editor tests, 68 Python palette tests, one isolated live migration test, one migration-manifest test and one rendered component test passed (141 total). The pressed-panel control regression reproduced at 2.009:1 before its fix and passed the 4.5:1 guard afterward. The live test verified all four representative rows and revisions unchanged. Migration 0077 matches 0071 exactly except the added palette ID. Two complete local review passes finished; the second found no substantive issue. Scoped git diff --check passed.

The first component/migration attempts exposed fixture schema, canonical-input, stylesheet-order, viewport and overlay issues; these were corrected without changing production constraints or weakening expectations. Test-owned processes exited; the isolated database had no retained test sessions. No full suite, owner-database migration, real-app acceptance, staging, commit, CI or publication is claimed.

Changed application files for this task (preexisting unrelated changes preserved):
- music_app/static/js/appearance-palettes.js
- music_app/static/js/appearance-backgrounds.js
- music_app/static/css/appearance-backgrounds.css
- music_app/services/appearance_preferences_postgres.py
- migrations/postgres/0077_allow_parchment_pine_appearance_palette.sql
- tests/js/runtime/appearance-palettes.test.js
- tests/py/test_appearance_palettes.py
- tests/py/test_appearance_migration_live.py
- tests/py/test_postgres_migrations.py
- tests/components/appearanceWorkspace.spec.js
- docs/superpowers/plans/2026-09-21-sidebar-player-appearance.md

Private documentation: docs/functional-test-cases/appearance-customization.md adds approved named subcases; its automation counter remains 0/6. Direct-work versus process-overhead timing was not separately recorded.

Next checkpoint: provide the normal real-app build, obtain owner theme acceptance using Task 2, and resolve the shared prerequisite delivery base before staging/publication. SP-D2 player behaviors remain unimplemented and retain their existing gates.

Checkbox reconciliation: 12/85 implementation checklist items complete; no unchecked delivery/manual/release gate is inferred complete.


### Real-app manual review build

The overlapping task explicitly released its live bf02 review server after an escalated listener check corrected the earlier stale-process assumption. The first guarded shutdown aborted before mutation; the subsequent authorized shutdown verified PID39892 identity and stopped only its recorded process tree. Old server and descendants exited and port5001 was clear before replacement.

Fresh normal-database inspection showed0074-0076 already present. Only0077 was applied, in one transaction with an Appearance-table lock, complete before/after row equality check and ledger entry. All preferences were preserved. Migration SHA256: 1a25d6a48a4744e5b92b8f84795b490673074cc2a9a6536cfe21cbbadf50b5be. The private table backup is retained beside the scoped recovery baseline; it is not a publication artifact.

The replacement server uses the existing .codex-restart/restart-5001.py wrapper in bf02, PID39408, started2026-09-21T18:10:09-06:00. Review URL: https://localhost:5001. Logs: .codex-restart/sidebar-player-d1-5001-20260921-181009.stdout.log and .stderr.log. Listener ownership, completed startup and zero startup errors verified. Browser reaches the expected sign-in page with no console warning/error. No authenticated real-app theme journey or owner acceptance is claimed. Server remains running intentionally for manual review; test workers are stopped and test lane released.

Owner manual script: sign in, open Settings > Appearance > Main elements, choose Parchment & Pine and each companion, verify preview, Save and reload, then edit and Cancel. Check gallery, Artist Tree, player and an album dialog for readable default/hover/focus/disabled states. Confirm existing explicit player colors survive selection; switch to an old palette and back to check reset. Small main/editor text uses darker content ink than the retained muted swatch. Report acceptance or defects before SP-D2.

This build record supersedes the earlier pre-launch note that no normal-database migration had occurred. No staging, commit, full CI, publication or SP-D2 implementation occurred. Checklist remains12/85.


### SP-D2 owner acceptance and implementation continuation

The owner replied "I approve all. Start implementing" after the SP-D1 manual-review checkpoint. This records owner acceptance of the theme build and authorization to implement SP-D2 now in the coordinated shared worktree. D1/D2 commit separation, required CI and publication remain pending; this continuation does not claim those gates passed.

Task `4 UI refactor the rest` released all requested D2 source, Appearance, backend, test and generated-bundle boundaries. Its concurrent Album Details work owns only tag-editor-and-optimistic-updates.js, track-modal-and-lightbox.css and focused Album Details tests. This task owns the final combined runtime-bundle.js rebuild. A short focused Node lane was granted to that task before D2 verification; no concurrent test execution is authorized.

D2 pre-edit recovery copies: `C:/Users/Rendref/AppData/Local/Temp/sidebar-player-d2-ac9nncbe`. Additive migration 0078 is reserved. Independent contract-test authoring is complete; independent RED verification precedes runtime edits. Backend and Appearance implementation workers are preparing against the exact approved contracts. No D2 implementation or verification checkbox is marked complete at this checkpoint.


### SP-D2 first implementation and verification checkpoint

Implemented backend preference fields, strict validation and additive `0078_add_compact_player_motion_and_floating_edge.sql`; Appearance staged controls and search; stable dock/A/B/C nodes and synchronized motion. These changes remain uncommitted in the shared prerequisite worktree. Independent initial RED reproduced missing behavior. Focused GREEN evidence so far:103 Appearance Node tests,75 Python preference/profile/route tests,1 migration manifest test. Player/shell tests initially45 passed/1 failed: hidden tree reset the dock coordinate; implementation now preserves the last valid coordinate pending rerun.

The exact v004 main-artwork interaction also governs the expanded tree dock: single click (300ms pointer discrimination) opens the full player, double click opens details, keyboard activation is immediate and ArrowUp opens details. This preserves a full-player entry point after removing its superseded dock chevron. A hover artwork remains direct details; B retains its existing floating behavior. The main-cover mock handler supplies this existing approved contract.

Independent component tests now cover geometry, intermediate shared-edge animation, reduced motion, A hover/focus/inert state, B drag/clamp and C pointer/keyboard activation. Seven guarded isolated-live cases cover0078 preservation/constraints and all repository write branches. Execution and full two-pass review are underway. No live0078 migration, refreshed review build, player manual acceptance, functional E2E, full CI or release is claimed.


### SP-D2 focused verification and review result

All299 focused checks have passing evidence:103 Appearance Node,50 final player/shell/bundle Node,75 backend preference/profile/route tests,1 migration manifest,7 guarded live Postgres migration/write-path cases,63 rendered component cases. The component inventory was completed before fixes; targeted reruns then passed every corrected case. The final sidebar run uses production stylesheet order and real keyboard Tab input. Two compact screenshots were visually reviewed before refreshing their approved changed baselines; expanded-player snapshots remain intact.

Two complete baseline-relative local review passes finished. Fixed idle dock/C expansion, reduced-motion specificity, hidden-rail coordinate preservation, dock artwork expansion, redundant synchronization and final stylesheet cascade. PASS2 found no further production issue; its fixture-order correction was applied and verified. Four older Appearance assertions were proven stale against the pre-D2 baseline and corrected to existing2px selection outlines and shared action colors without runtime changes. No known focused failure remains.

Generated runtime rebuilt from73 modules. Test-owned Node/Python/browser processes exited; scoped diff check passed; Git-process audit selected0. Live build update is now authorized following the verified additive0078 path. Playback engine was not changed; these component checks do not claim authenticated audible continuity or production manual acceptance.

### Exact SP-D2 owner manual acceptance script

1. Open https://localhost:5001, sign in, and refresh. In Settings > Appearance > Player and Seekbar choose Docked and Play button in sidebar; Save. Collapse the regular player and Artist Tree. Check bottom-centered play, no top line/chevron, and artwork opening upward on hover or keyboard focus. Open details from that artwork.
2. Expand the tree: check tree-wide cover/title/artist/play dock. Click art once to reopen the full player; double-click for album details. Repeat without a loaded track to confirm the full player remains reachable.
3. Select Float on collapse and Save. Fold/unfold repeatedly. Check retained floating design, lower-right play, drag position retained for this visit and all controls reachable at viewport edges. Verify the separate Floating style remains floating with the tree open.
4. Select Album art in sidebar and Save. Check44px cover and slightly raised play across its lower-right corner/divider. Single click expands after300ms; double-click opens details without a full-player flash. Enter/Space expands immediately; ArrowUp opens details.
5. Select Slow motion. Fold, unfold and reverse midway; tree/player should reassemble together. Turn operating-system reduced motion on: motion becomes immediate; turn it off and saved Slow resumes.
6. Under floating edge, compare Player color, Theme color and Custom. Save/reload; edit then Cancel; Reset the Player section. Check Parchment & Pine and existing explicit player colors remain independently selectable.
7. With a real track playing, repeat A/B/C transitions while checking continuous audio, unchanged track/queue/Loop state, normal seek controls after expansion, keyboard focus and narrow-screen fallback.

Owner acceptance of this new live player build remains the checkpoint before functional E2E and release. No staging/commit/full CI/publication is claimed; shared prerequisite split and release gates remain open.


### SP-D2 live manual review build

Normal database migration0078 applied atomically after isolated verification. Existing Appearance rows, all old fields and revisions were unchanged; new defaults validated. SHA256 `f6755a6d75c527fd8a0d8dfc0b08cb47818d8a1a6d131ddf211103cb924ac26d`. Private backup: `C:/Users/Rendref/AppData/Local/Temp/sidebar-player-d2-f37fde8d86/appearance-before-0078.dump`.

Old server39408 and owned child36148 exited; port5001 was clear before replacement. Current review server7996 with child31860 started2026-09-21T19:20:30.155858-06:00. Logs `.codex-restart/sidebar-player-d2-5001-20260921-192030.stdout.log` and `.stderr.log`. Listener ownership, completed startup, /status200 and expected sign-in redirect verified. In-app browser opens the sign-in page with no warnings/errors. Server remains running intentionally for owner review. No authenticated audible-playback/manual acceptance is claimed. Test lane released to the coordinated task.

Checklist now41/85; remaining compound commit/delivery, production acceptance, functional E2E and full CI/release items remain open. See exact manual script above. Owner acceptance is required by the repository feature workflow before functional E2E and publication.


### Owner visual correction: dock play proportions and symbol alignment

Owner live-build feedback: "Play button looks small to the overall space. Its symbol is not at the centerline." This supersedes the dock-only32px reference: expanded-tree dock play is44px, vertically centered in its100px footer, with16px right inset and70px metadata clearance. A/C remain32px and floating remains34px. Shared compact play/pause glyphs now use a stable, centered SVG instead of font characters; play triangle optical centroid and pause geometry align at12,12 in a24px viewBox. Focused verification pending at this entry.

Dock sizing follow-up verified:40 Node contracts,3 rendered geometry/state cases and2 visually reviewed screenshot replays pass(45 total). Two bounded review passes found no production issue. Test fixture now preserves the SVG when selecting Pause; dock/floating baselines refreshed after visual inspection. Owned test/browser processes exited. Final combined runtime bundle supplied by the coordinated task; live5001 serves corrected44px CSS and SVG path. Owner can hard-refresh to review.


### Owner visual correction: shorter tree-wide dock

Owner requested reduced height for the expanded-tree dock. Its footer and reserved tree space are now targeted at72px instead of100px, retaining50px artwork and44px play centered at y36(art top11, play bottom14, metadata top17). Compact A/C footer100px and floating96px remain unchanged. This supersedes the dock-height references above; focused existing geometry/snapshot verification follows.

Shorter dock verified:5 focused browser cases pass(dock SVG/center, dock screenshot,A/B/C geometry); two bounded review passes clean. Dock-only snapshot visually inspected at280x72; full waveform100 and compact A/C100/B96 unchanged. Live5001 serves72px CSS. Test runners exited and lane released; no bundle rebuild/restart.


### Owner visual correction: Artist Tree header centerline

The Artists label inherited10px bottom margin from the later generic sidebar h2 rule, offsetting it in the centered header flex row. The existing header rule now scopes to.sidebar .shell-navigation-rail-header h2 and resets only margin-block. Horizontal12px inset and shared chevron/button remain unchanged. Focused rendered header verification pending at this entry.

Header correction verified:single ArtistTreeReflow rendered case passed8.8s using actual sidebar/header classes and shared ActionButton SVG. Title margin-bottom0 and chevron/title centerline delta<=1px asserted, fold/unfold still passes. Two bounded review passes clean; live5001 CSS verified. Test runner exited; shared lane released.


### Owner visual correction: larger raised A rail play

Owner requested larger play and more bottom clearance in compact sidebar A. A is now40px centered on64px rail(right12), bottom16px; hover art top-14 maintains8px gap above play. Dock44/B34/C32 preserved. Three focused A/B/C browser cases passed14.6s; two bounded CSS reviews clean; screenshot inspected. Live5001 serves updated CSS; no runtime rebuild. Test runners exited and shared lane released.


### Owner visual correction: Stay docked frame

When Stay docked is selected and Artist Tree is folded, the full-width dock now has14px rounded corners and a1px inset outline derived from player ink at28% opacity. This CSS-only frame preserves72px geometry, controls, visible glow and motion. Other presentations remain unchanged. Two read-only bounded review passes and scoped diff check passed; live5001 serves the rule. No new automated tests or bundle rebuild for this reversible styling adjustment.
