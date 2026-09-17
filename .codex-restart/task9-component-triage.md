# Task 9 component failure triage

Initial component suite: 8 passed, 8 failed. Source: `.codex-restart/task9-functional-component.stdout.log`; normalized inventory: `task9-component-inventory.json`. Artifacts: `test-results/playwright-artifacts/components/settings-task9-initial/`. Read-only diagnosis only; no tests, CSS changes, baseline updates or tolerance increases. Gallery CSS preserved.

## Three AlbumTrackTable failures: missing fixture dependency

Exact tests in `tests/components/albumTrackTable.spec.js`:

1. line193, `ActionButton hover and keyboard focus share the same outline without shifting layout`.
2. line214, `problem status uses a hidden header track immediately before Length`.
3. line241, `Editorial table aligns left while its final 1px outline fades into the original footer`.

All fail before their assertions in the same fixture render: `ReferenceError: ButtonComponent is not defined`, from `runtime/album-track-table.js:11` shared Play icon rendering. `mountAlbumDetailsComponents` loads CompactDataTable and AlbumTrackTable JS but not the shared Button module. Production loads that approved module. These failures prove an incomplete fixture, not broken table geometry.

Minimal later alignment: load the actual shared Button component before AlbumTrackTable, with its ordinary prerequisites. Preserve the original semantic header, layout, outline and footer assertions. Rerun those exact three first; downstream geometry is still unverified until fixture initialization succeeds.

## Shared footer outline: stale primitive thickness expectation

`tests/components/buttonInteractionOutline.spec.js:100`, `shared footer buttons render themed hover and keyboard-focus outlines while excluded controls stay inert`.

Actual Reset outline is 1px; test expects 2px at117 (and again keyboard focus at126), with offset2px at118. The approved shared Button source `button-component.css:20-21` defines a 1px outline and 1px offset; hover/focus update its theme color rather than its thickness. Task3 adopted that primitive. Later expectations of2px are stale. Keep semantic color, disabled, excluded-control and keyboard behavior checks; align only thickness/offset with the real shared primitive. Do not thicken production controls to satisfy this old test.

## Four player-view failures: old fixture/visual baselines plus one unresolved anchor mismatch

The component fixture manually builds expanded markup at `playerViews.spec.js:25-34`: an outer `playback-control-cluster player-play-cluster` containing a second `loop-play-control-cluster`. The real approved renderer `runtime/playback-control-cluster.js:39-42` uses one compound carrying both classes, its style attribute and real action mount. The test also manually substitutes glyphs and supplies no complete application theme tokens (`--success`, `--panel-2`, `--border` required by the new Capsule surface). Repair that fixture contract before accepting replacement images; do not use its hand-copied markup to redefine production geometry.

### Expanded waveform, line95

`expanded waveform player uses the approved centerline and player-edge metadata anchor` fails at116 with metadata horizontal delta **8px**, expected<=1px. This is not4px; the logged value is8. Earlier soft centerline checks do not fail: chevron, cover, Play and waveform meet the57px centerline in this current fixture. No waveform screenshot comparison runs after the hard failure.

Classification: **unresolved real layout/fixture mismatch**, not an approved baseline change. The approved v002 contract explicitly retains metadata at the inner player-left edge. Current source hardcodes `--player-leading-width:144px` (non-album-and-player.css367) and offsets metadata by its negative value (924), while shared Capsule/Companion widths differ. No runtime measurement updates that variable. This is a concrete source candidate for a real anchor bug, but the failing fixture is not the production compound and this inventory alone does not prove both real style layouts.

Minimal next verification after inventory: mount the actual current renderer and required theme for both styles, keep the<=1 anchor assertion and57px centerline contract, measure real metadata/player edge and Play center. If the8px (or style-dependent) shift persists, fix the layout relation rather than increasing tolerance or changing the expected edge. Prefer a metadata anchor independent of variable control-compound width, or a precisely derived leading width with no layout shift during reveal. Preserve player heights and waveform position.

### Expanded regular, line120

`expanded regular player uses the approved centerline and seekbar-edge text anchors`: screenshot differs3419px (4%). All preceding geometry assertions pass, including shared39px centerline, metadata at seekbar start, text top10/11 and5px below timeline.

Visual inspection of expected/actual shows altered control compound/leading spacing and Play treatment, not a generic screenshot noise pattern. The new approved Capsule is48px Play within56px shell with90/123 revealed widths; old snapshots predate adoption. Missing theme tokens additionally make the fixture's new surface treatment unreliable. Classification: **stale fixture/baseline, pending actual-component render verification**. After fixture alignment, compare to the approved mock, then replace only the independently reviewed outdated baseline if geometry stays correct. Do not accept3419px by loosening screenshot tolerance.

Important approval resolution: v002 `notes.md` still lists regular43px and text14/15, but its `review.json` has a later September5 owner approval: move the complete regular group up4px and retain5px under timeline. Thus current39px and10/11 are intentional. Do not restore43px based solely on the stale notes paragraph. Waveform57px and its left-edge metadata did not change in that approval.

### Docked compact, line148

`docked compact player balances expand, artwork, and transport without exposing expanded content`: screenshot differs66px. All geometry/pointer assertions before screenshot pass (280x76, balanced centerlines, ordering, expanded layer inert). Inspected diff image confines changes to the expand chevron glyph. Classification: **shared Button typography/glyph baseline drift**, not evidenced container-layout regression. Align the fixture with current shared button markup and inspect the glyph against the approved control before replacing the exact baseline. Preserve all bounds and hit checks.

### Floating compact, line172

`floating compact player retains its overlap, glow, and compact-only controls`: screenshot differs19px. Preceding geometry and control assertions pass. Inspected diff is confined to the small expand chevron glyph. Same classification/procedure as docked; no permission to loosen pixel thresholds or alter overlap/glow geometry.

## Cross-check boundaries

- Later environment inspection found that the initial component/functional invocation used installed Chrome150, while the exact pinned Chrome151.0.7922.138 is available in the app-specific cache. Repeat component verification on that pinned executable after fixture repairs before judging small glyph differences or replacing any baseline. The initial differences remain evidence; browser-version rendering is an additional possible contributor, not an established explanation.

- Actual screenshot diffs were viewed locally, not classified by pixel count alone.
- The independently confirmed R7 saved Companion Play interceptor is separate and remains a P1 product issue. These player-view component tests do not instantiate a saved loop or prove native action hit ownership.
- The main expiry Create issue is separately established as a folded-action test-helper error. Do not make folded actions clickable while repairing fixtures.
- Preserve the approved Capsule48-in56/90/123 and Companion52/58/88 dimensions,57px waveform and39px regular centerlines, and relative Play/action hit ownership. No blind baseline regeneration is authorized by this triage.
