# Compact sidebar player: owner design decisions

Date: 2026-09-21. Source: owner follow-up on sidebar-player/v001.
Artifact: [revised interactive mock](mockup.html). Palette: [theme.json](theme.json).

## Decision and approval boundary

The owner explicitly selected the tree-wide docked design from v001 as the replacement direction for the current application docked player. A/B/C must all be selectable behaviors in Appearance, not competing proposals from which only one ships. The reassembly animations are required in implementation.

The revised v002 applies the positioning corrections. Its exact revised pixels and the proposed settings presentation await visual review. No production implementation, release, or manual acceptance is claimed. Prior restrictions on invented application chrome remain: only the specified docked-player design, controls, transitions, and newly requested palette transfer.

## Required behavior

- Shared expanded state: the player spans the full Artist Tree width using the selected v001 dock composition. Replace the existing docked presentation.
- Sidebar expand/collapse is a top navigation item on the icon centerline, not a control beside the bottom player.
- A / Sidebar play button: no top white rule or resting chevron; 32px play centered at x=32 in the 64px rail. Lower play by 18px from v001 (bottom clearance 16px). Lower its hover art/expand cluster equally. Preserve scissors-like unfolding, keyboard reachability and glow beyond the rail.
- B / Floating player: preserve the existing app floating design, controls, drag behavior and ownership. Reference existing 96px footprint, 22px shell radius, 70px art with 17px radius, 34px play, and expand control. Move play to overlap the lower-right corner. The substantive change is continuous dock-to-floating and floating-to-dock reassembly. The mock illustrates geometry/color, not a replacement floating implementation.
- C / Artbox with corner play: retain the small bottom artbox. Lower play to overlap its lower-right corner. Play stays in front of the sidebar dividing line, centered on that line. In v002 the 44px artbox ends at local y=72 and the 32px play center is (64,72), intersecting the artbox corner at x=54. Single art click expands the full player; double click opens album details. Preserve an accessible alternative; the mock offers ArrowUp on art for details.
- Behavior changes and sidebar folding preserve current track, playback state, position and audio continuity.

## Animation acceptance contract

Preserve visible repositioning and reassembly of the same artwork and controls. Sidebar, dock, art, play, labels and content reflow start together and settle together. No after-the-sidebar delay, remount flash, width-measurement chase or staggered second animation.

Reference timing: 420ms with cubic-bezier(.22,1,.36,1); A hover reveal: 300ms with the same easing. Slow motion is review-only. Repeated/reversed toggles retarget smoothly from current positions. Honor reduced motion with a near-instant equivalent and retain focus. The mock's 300ms single-click discrimination is separate from sidebar motion; confirm production gesture handling against the existing contract.

## Appearance and theme

Expose three compact-sidebar choices: Sidebar play button (A), Floating player (B), Artbox with corner play (C). They share the tree-wide dock when the Artist Tree expands.

Add independent floating-player outer-edge color configuration: selected play color (including the existing green treatment), dark/near-black theme edge, and custom color. Edge changes must not recolor play or artwork. Reuse Appearance draft, preview, Save, Cancel, Reset and persistence semantics. Mock settings only demonstrate choices.

Add the mock palette as another reusable theme. Working name: Parchment & Pine; proposed catalog ID: parchment-pine. Exact semantic colors are in theme.json. Preserve beige content with dark pine navigation/player; do not flatten it into a global light or dark treatment. Retain other palettes and custom player overrides.

## Delivery and implementation checkpoints

Outcome: usable Appearance-controlled dock/compact-player experience, independent floating edge color and reusable owner-requested palette. Checklist IDs: SP-01 shared dock, SP-02 top toggle, SP-03 A, SP-04 B, SP-05 C, SP-06 coordinated motion, SP-07 Appearance preferences, SP-08 palette, SP-09 regression/manual acceptance.

Prerequisites: exact revised-artifact review; inspect current Appearance schema, device profiles, floating behavior and component ownership; confirm any new capability/client decisions and automated-test proposal before production implementation. Reuse NavigationTree, CompactPlayer, AlbumArtbox, PlaybackControlCluster and Appearance components. Preserve the streaming/audio architecture.

Compatibility/rollback: preserve current saved settings and sibling Appearance fields. Define explicit mapping for existing docked/floating/follow-sidebar/stay-docked records before implementation. Do not silently select a new default or reinterpret stay-docked. Runtime preferences remain Postgres-backed; design JSON is not runtime persistence. Rollback preserves stored values and restores prior presentation without dropping preferences.

Proposed support boundary: desktop web required; Tauri optional through the shared renderer; narrow web retains its fallback and requires compatibility verification; native Android, TV and Apple unsupported for this desktop-sidebar slice. This proposal does not grant new client support or authority.

Acceptance: all three preferences through preview/save/cancel/reset/reload; A lower alignment/hover reach; C corner geometry and single/double click; B existing controls/drag plus independent edge colors; uninterrupted playback; repeated and reversed reassembly; reduced motion, keyboard focus, zoom and narrow layouts; new palette on real application surfaces.

Merge/publish checkpoint: focused checks, owner manual acceptance, required hosted review and complete CI precede production merge/publication. This update only revises and records the mock. Split later delivery only at a complete tested outcome boundary.
