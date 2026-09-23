# Utilities component review v002

Branch: 2026-09-08-settings-refactor. Current stack explicitly approved by owner.

## Basis

On September 9, 2026 the owner rejected v001's visual divergence and supplied 14 corrections. This version was prepared after inspecting the signed-in live app at https://localhost:5001 in Chrome: Gallery, the Settings menu, Integrations, Loops, and all five Appearance sections. The live saved palette was Solid Black + Soft black, with black/gray surfaces, neutral selected navigation bodies, green selection edges, and green player controls.

SearchInput, NavigationTree, Button/ActionButton, trigger-anchor, album-header, compact-table, and player CSS are frozen local snapshots of their existing source files under components/. The trigger-anchor JavaScript is also a frozen copy. These are review assets; no live runtime stylesheet, audio, backend, session, or mutation endpoint is imported. Proposed wide/nested NavigationTree composition retains shared row styling. Exact production component adoption remains part of the later implementation design.

## Owner corrections applied

1. Search embeds its filter control; it opens an anchored dropdown using the copied trigger-anchor geometry, connected outline, and unfold animation.
2. Problematic Files uses wide navigation rows with art, album/folder name, smaller artist/year line, and a hidden track-count column.
3. Problem table has no checkboxes. Drag over matching labels; an album-level label selects that type across tracks. No helper/count text surrounds Create Exception.
4. Loops uses extended navigation rows with indented child loop items, child drag handles only, no table header or extra Saved loops label. Double-click a song to expand/collapse; its chevron indicates expansion state.
5. No Add loop action. Existing slicing affordance stays with Play.
6. Loop panels are draggable. Preserve round green Play, slicing, pitch, right-aligned timestamps, repeat, and speed. Trash opens a confirmation dialog; no pencil/X actions.
7. Preserve console Log History with green and gray/white output.
8. Scrobbling replaces Last.FM in navigation; keep simple username/password, one Connected indicator, counts, Connect/Disconnect. Remove the invented Connection input and excess copy.
9. Library proposes multiple path rows for Main Library, Hoard, and New Arrivals using the existing multi-root concept.
10. Foobar shows SQLite DB path, documented export-format choices, and the original detailed guide rendered in a help dialog.
11. Import Local Playlist has only a disabled Open playlists control. No importer/conversion/selection-flow mockup was created.
12. Appearance uses sanitized inert DOM snapshots of all five existing editors. The shared sidebar search is updated; settings actions do not alter the live app. Synthetic waveform replaces an image containing hidden track metadata. Iframe responsive rules are adjusted to preserve the live desktop column composition.
13. Remove sidebar title/count above search in every tab.
14. Utilities header consumes the existing album-header styling and ActionButton styling in the preview composition.

## Clarified behavior

- The timezone is not supplied by Last.fm. It is an app preference persisted beside Last.fm settings, used for recent-listen windows and playback metadata. Omitted from Scrobbling mockup; backend preference unchanged. Its eventual settings location needs a separate decision.
- Current Library already supports multiple Main/Hoard/New Arrivals roots. Existing Main layout and destination policy controls must be retained in production; this path-focused review does not approve their removal.
- Foobar currently exposes help/reference contracts, not completed DB/import/sync operations. Formats in its plan are Playback Statistics XML, standard Text Tools, enhanced Text Tools. Older hashed XML is a compatibility limitation, not a second proven importer.
- The full original private Foobar guide is more detailed than the currently served public copy. This preview includes its inline standard/enhanced presets and backup/export instructions; machine-specific repository links are omitted from the rendered guide.

## Verification and limits

Browser verified: header problem label selects all six same-type labels including its five tracks; Create Exception becomes enabled; no table checkboxes; song double-click collapses children; trash opens Delete loop confirmation; Main Library Add path creates a second input; playlist picker disabled; Foobar help renders the complete guide; Appearance original content is embedded. JavaScript syntax check passed.

Local screenshot: references/revised-loops.png. Live baseline screenshots were inspected during browser work; live DOM snapshots ground the preserved Appearance references.

Preview behavior only: no audio, real paths, imports, exports, or live preference saves. Path/connection edits are temporary and reset on navigation. Filter check states demonstrate dropdown interaction; full filter policy, narrow layouts, keyboard reorder, and application tests remain implementation work. Appearance references are inert rather than a second settings implementation. No production files changed.

Automatic approval review caught a hidden local path in the original encoded waveform snapshot. All data attributes, media URLs, and raw/encoded drive paths were removed; saved Appearance files passed the privacy scan before further review.

Status: in_review for visual feedback, not approved for production implementation.

September 9 owner refinement: problem labels use red semantic colors for default, hover, focus, active, selected and disabled states, including selected-disabled. The active tab covers the baseline and shares the body background; its blue outline fades down the side edges. Navigation tree retained as positively reviewed. Mockup-only refinement; production shared-component adoption remains within the Utilities review workflow.


Problem filter alternative: unchecked by default; empty selection means all types. Selected types combine with OR and hide other problem labels and nonmatching track rows. Menu selection persists while reopening and navigating preview tabs. One outer menu frame, borderless rows, muted red selected fill/checkmark, and a keyboard-only focus outline. This is sample-data filtering in the mockup.


Loop and history refinement: loop sections expose a visible drag grip; delete uses red danger colors with explicit padding and centered 34px controls. Log filter offers local From/To timestamps, creates one temporary Custom period navigation item, and combines sample events chronologically in the console with retained green success output. Clear removes the range entry; inverted ranges show inline validation. Preview only: real log query scope, retention, pagination and permission enforcement remain part of the production technical design. Verified two-event range, invalid range, clearing, and loop delete-control bounds in browser.


Library folder entry refinement: Main Library, Hoard and New Arrivals use an embedded Browse action in each path input. Choosing a sample local/NAS folder fills that row and leaves another empty row for repeated selection. Populated rows retain Remove. Browser dialog is explicitly simulated; production must use the applicable native or server-authorized folder picker rather than imply the web browser can expose arbitrary filesystem paths. Verified two selected folders plus an empty row in Main Library.


Table width refinement: native mockup tables explicitly use display:table rather than inheriting the reusable grid component root's block display. Detected Problems uses the full content width with 44% for track identity. Both Rules tables allocate 40% for album identity and a compact trailing action column; remaining space belongs to the rule description.


Problem filter menu refinement: replace red interaction colors with neutral overlays derived from the active Appearance ink/panel/selection tokens. Selected rows retain fill and checkmark; keyboard focus follows the configured interaction outline. Error labels in the results keep their red semantic treatment.


Selected tab refinement: blue anchor color continues onto the horizontal body divider, fading outward over 100px on both sides of the selected tab. The open join beneath the tab remains clear. Divider coordinates update with tab selection and viewport resizing.


Loop source range: each segment header now shows its original-song start and end timestamps on the right, separate from elapsed loop playback. Sample ranges 0:08–0:26 and 1:12–1:36 match the 18s and 24s loop durations.


Artbox refinement: all mockup art() placements now invoke the frozen actual buildAlbumArtboxHtml renderer with its production stylesheet, including navigation and album headers. Available header artwork in Problematic Files and Loops opens a full-size sample Artbox dialog; empty covers retain the actual component empty state. Sample cover content remains synthetic and contains no private assets. Verified no old disc.art elements and opening/closing artwork from both headers. Production adoption should reuse the existing artwork lightbox controller.


Foobar instructions reader: opener is left-aligned Read setup instructions. Guide HTML is embedded directly, replacing nested iframe scrolling. A responsive 1000px-wide document dialog keeps title and Close fixed while only its article scrolls. Scroll styling reuses the Gallery scrollbar rules. Verified zero iframes and exactly one vertically scrollable region in the open reader.


Compact shell alternative: remove the visible Utilities title/subtitle row and place tabs at the top of the shell, retaining Close at the upper right. Content moves upward by the former header height. Existing tab semantics and divider glow remain. This is a visual review refinement, not production approval.


Companion refinement: owner prefers B. Oval 64x38 loop target meets the 52px Play circle at its bottom center, with scissors offset clear of overlap. Waveform center aligns with Play; the player accommodates the downward extension. Waveform drawing and colors remain unchanged.


Dual control refinement: A reveals loop action on hover/focus and keeps Play inside its expanding housing; B capsule top is at Play center and bottom at Play bottom. Both expand to inline scissors and Cancel, using the original action controller, with green/red hover glow respectively. Expansion overlays the waveform with stable layout. Verified both waveform center deltas are zero, waveform X positions unchanged during expansion, expanded Cancel fits, and both Cancel actions work. Waveform rendering remains unchanged.
