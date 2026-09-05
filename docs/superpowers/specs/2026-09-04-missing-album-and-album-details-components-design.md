# Missing Album And Album Details Components Design

## Status

The owner approved all visual artifacts on September 4, 2026, including the
final correction that the two playing-row spectra follow the row's exact
rounded outline, start half a perimeter apart, and move in the same direction
at identical speed. Automated-test approval is the remaining gate before
implementation.

This design supersedes only the Web UI section of the targeted filesystem
watcher design. Watcher lifecycle, targeted reconciliation, Postgres inventory,
root health, removal authority, and event-to-visible measurement stay unchanged.

## Scope And Existing Contracts

- Keep a watcher-detected missing album in its existing gallery order and DOM
  identity until an owner or administrator confirms removal.
- Make `inventory_status = missing` authoritative even when cached artwork
  remains available.
- Replace page-local album-card and Album Details markup with reusable
  current-web components that can later map one-for-one to React components.
- Reuse `CompactDataTable`, shared Button, confirmation, toast, appearance, and
  playback controllers. Do not fork audio, queue, seek, or track identity.
- Add per-account Album Details layout and playing-animation choices to the
  existing Postgres-backed Appearance record.

Web desktop and narrow web are required. Tauri is deferred because no desktop
repository exists. Android, TV, and Apple are unsupported. Missing-album removal
uses `library.inventory.manage`; Appearance choices reuse
`account.self.appearance.read/write` and never grant media access.

## Components

`GalleryCard` composes a square `AlbumArtbox` and the existing album metadata.
Missing state cannot alter sort keys, card identity, or placement.

`AlbumArtbox` owns loaded, loading, no-art, and missing-inventory states plus a
bottom-right action slot. Every state remains square. Missing inventory uses a
theme-aware crossed-circle placeholder rather than cached art.

`SmallAlert` is a reusable near-circular compact alert. Pointer expansion is
owned by the compact alert itself, never by the surrounding artbox; keyboard
focus on the album trigger still expands it. The expanded state reserves a
stable width and explicit trailing padding so its label cannot touch the rounded
edge. It supports `error`, `warning`, and `info`, derives its outline, dark
tinted fill, icon, and text from the same semantic family as `OnPageAlert`, and
says `Album not found` for this feature.

`AlbumDetailsHeader` preserves the current three icon-only actions at
`34px × 34px` and supports `Classic Bar`, `Stacked Bar`, and `Editorial Canvas`.
Identity separators use a fat dot. In the stacked form, actions align with the
first line, not the full block's vertical center.

`OnPageAlert` supports the same three severities with title, body, icon, and
shared-Button slots. Missing Album Details puts it beside the square artbox,
renders no artbox alert and no track table, and offers `Remove from library`
plus `Keep as missing` when authorized.

`AlbumTrackTable` composes `CompactDataTable` at compact density. It retains the
existing explicit play control, track number, title, optional secondary credit,
duration, double-click behavior, queue ownership, and progress updates. It has
no generic `Tracks` heading; multi-disc releases show stored disc labels or
`CD 1`, `CD 2`, and `Bonus CD`. Each labeled disc is a separate table block,
with its label outside the table border; only the first table renders the
column-header row. When an album has exactly one main-disc group plus one or
more bonus-disc groups, the main group has no `CD 1` label. Numbered labels
remain visible when two or more main-disc groups make the release a genuine
multi-disc album.

## Table State And Motion

- Hover applies a surface change only.
- Search emphasis persists under hover, backlights the whole row in the current
  theme, and adds a left accent without marking the matched word.
- Playing keeps a continuous theme/player-accent outline.
- With motion enabled, two elongated spectra without dot-shaped heads travel on
  the exact rounded row outline, including corners and vertical sides. Their
  offsets differ by exactly 50% of the path length and they share duration,
  direction, timing function, and iteration clock.
- With motion disabled or reduced motion requested, only the static accent
  outline remains.
- The Play activation chase is one-shot and provisional; its detailed tail
  tuning may change later without changing playback behavior.
- Track numbers, titles, durations, and totals use the selected palette's
  primary ink; column headings and secondary credits use its muted ink.
  Durations are plain time text with no leading dot, including during playback
  refresh. The perimeter spectrum may use slightly reduced opacity to soften
  its edges without changing its path, timing, direction, or opposite spacing.
- Total Length is semantically a separate right-anchored strip but visually the
  table's continuous final row. The preceding table keeps a square lower-right
  corner so its right outline meets the strip without a gap. The strip has no
  top or left border; its bottom edge and fill fade completely before the left
  half, and it alone owns the final rounded lower-right corner.

## Appearance Values

- `album_details_layout = classic_bar | stacked_bar | editorial_canvas`
- `album_playing_row_animation = enabled | disabled`

The server validates values, preserves sibling Appearance fields, and returns
defaults for absent or invalid legacy data. The browser applies saved values on
load and after save without maintaining an independent durable fallback.

## Functional Cases And Proposed Automation

Focused JavaScript/component tests will prove component APIs, semantic states,
square geometry, alert variants, focus/reduced-motion behavior, exact header
action sizing, table density, row-state precedence, perimeter path invariants,
disc labels, footer structure, and unchanged playback selectors.

Focused Python tests will prove Appearance validation/default/preservation and
missing-album projections. Existing watcher and removal integration tests remain
the backend source of truth.

After manual acceptance, the proposed Playwright change is:

1. Revise `FTC-LIBROOTS-017` from `Album deleted` to `Album not found` and add
   preserved position, square missing art, compact/focus-expanded alert, full
   details alert, and absent track-table assertions.
2. Add `FTC-ALBUM-DETAILS-019` for all three persisted layouts, `34px × 34px`
   header actions, square cover, compact shared table, multi-disc headings, and
   the separate dissolving total-length strip.
3. Add `FTC-ALBUM-DETAILS-020` for hover/search/playing precedence, animation
   setting and reduced-motion fallback, plus playback start/pause, queue,
   progress, and audio-source continuity through existing production controls.

No new performance threshold is proposed. The slice must run existing gallery
scroll/hover, Album Details latency, and idle-memory guards. Watcher latency
continues to collect real measurements before any owner-approved threshold.

## Approved Artifacts

The durable private record is
`docs/design-mockups/components/missing-album-and-album-details/v001/notes.md`.
Its approved images are gallery SmallAlert v5; missing-state Classic Bar,
Stacked Bar, and Editorial Canvas v3; normal-state Classic Bar v9, Stacked Bar
v3, and Editorial Canvas v3.
