# Compact sidebar player: owner design decisions

Date: 2026-09-21. Source: owner follow-up on sidebar-player/v001.
Artifact: [revised interactive mock](mockup.html). Palette: [theme.json](theme.json).

## Decision and approval boundary

The owner explicitly selected the tree-wide docked design from v001 as the replacement direction for the current application docked player. A/B/C must all be selectable behaviors in Appearance, not competing proposals from which only one ships. The reassembly animations are required in implementation.

The approved v004 applies the latest positioning corrections and supersedes the A/C and sidebar layout in v001/v002. The owner approved all designs, with a small upward C correction and a request to offer slow motion in Appearance; v004 applies that authorized correction (3px up) and moves the speed control into Appearance. No production implementation, release, or manual acceptance is claimed. Prior restrictions on invented application chrome remain: only the specified docked-player design, controls, transitions, and newly requested palette transfer.

## Required behavior

- Shared expanded state: the player spans the full Artist Tree width using the selected v001 dock composition. Replace the existing docked presentation.
- The mock sidebar contains exactly one icon: the tree expand/collapse button at the top. Remove the brand icon and Albums, Artists, Favorites and Playlists icon rows. Keep the expanded artist tree.
- A / Sidebar play button: no top rule or compact chevron, including during hover. Keep 32px play centered at x=32 in the 64px rail, 8px above the bottom. Hover/focus reveals a single 50px album artbox directly above play with a smooth upward unfolding motion. Preserve pointer travel between play and artwork, keyboard access and unclipped lateral glow. Artwork opens album details as before.
- B / Floating player: preserve the existing app floating design, controls, drag behavior and ownership. Reference existing 96px footprint, 22px shell radius, 70px art with 17px radius, 34px play, and expand control. Move play to overlap the lower-right corner. The substantive change is continuous dock-to-floating and floating-to-dock reassembly. The mock illustrates geometry/color, not a replacement floating implementation.
- C / Artbox with corner play: retain the 44px bottom artbox and move play lower over its bottom-right corner. In v004 artwork bottom/right are local y=72/x=54; play center is (64,75), with 16px radius, so the circle overlaps that corner and extends 19px below the art. Keep play in front of and centered on the sidebar divider. Single art click expands the full player; double click opens album details; ArrowUp remains an accessible details alternative.
- Behavior changes and sidebar folding preserve current track, playback state, position and audio continuity.

## Animation acceptance contract

Preserve visible repositioning and reassembly of the same artwork and controls. Sidebar, dock, art, play, labels and content reflow start together and settle together. No after-the-sidebar delay, remount flash, width-measurement chase or staggered second animation.

Reference timing: 420ms with cubic-bezier(.22,1,.36,1); A hover reveal: 300ms with the same easing. Slow motion is a required user-facing Appearance preference. Standard reassembly is 420ms; Slow motion is 1400ms, matching the reviewed mock. The upward A artwork reveal retains its 300ms timing. Reduced motion overrides either selection. Repeated/reversed toggles retarget smoothly from current positions. Honor reduced motion with a near-instant equivalent and retain focus. The mock's 300ms single-click discrimination is separate from sidebar motion; confirm production gesture handling against the existing contract.

## Appearance and theme

Expose three compact-sidebar choices: Sidebar play button (A), Floating player (B), Artbox with corner play (C). They share the tree-wide dock when the Artist Tree expands.

Add independent floating-player outer-edge color configuration: selected play color (including the existing green treatment), dark/near-black theme edge, and custom color. Edge changes must not recolor play or artwork. Reuse Appearance draft, preview, Save, Cancel, Reset and persistence semantics. Mock settings only demonstrate choices.

Add the mock palette as another reusable theme. Working name: Parchment & Pine; proposed catalog ID: parchment-pine. Exact semantic colors are in theme.json. Preserve beige content with dark pine navigation/player; do not flatten it into a global light or dark treatment. Retain other palettes and custom player overrides.

## Delivery and implementation checkpoints

Outcome: usable Appearance-controlled dock/compact-player experience, independent floating edge color and reusable owner-requested palette. Checklist IDs: SP-01 shared dock, SP-02 top toggle, SP-03 A, SP-04 B, SP-05 C, SP-06 coordinated motion, SP-07 Appearance preferences, SP-08 palette, SP-09 regression/manual acceptance, SP-10 saved animation speed.

Prerequisites: visual approval is recorded; inspect current Appearance schema, device profiles, floating behavior and component ownership; confirm any new capability/client decisions and automated-test proposal before production implementation. Reuse NavigationTree, CompactPlayer, AlbumArtbox, PlaybackControlCluster and Appearance components. Preserve the streaming/audio architecture.

Compatibility/rollback: preserve current saved settings and sibling Appearance fields. Define explicit mapping for existing docked/floating/follow-sidebar/stay-docked records before implementation. Do not silently select a new default or reinterpret stay-docked. Runtime preferences remain Postgres-backed; design JSON is not runtime persistence. Rollback preserves stored values and restores prior presentation without dropping preferences.

Proposed support boundary: desktop web required; Tauri optional through the shared renderer; narrow web retains its fallback and requires compatibility verification; native Android, TV and Apple unsupported for this desktop-sidebar slice. This proposal does not grant new client support or authority.

Acceptance: all three preferences through preview/save/cancel/reset/reload; A bottom alignment/upward hover reveal without a compact chevron; C corner geometry and single/double click; B existing controls/drag plus independent edge colors; uninterrupted playback; repeated and reversed reassembly; reduced motion, keyboard focus, zoom and narrow layouts; new palette on real application surfaces.

Merge/publish checkpoint: focused checks, owner manual acceptance, required hosted review and complete CI precede production merge/publication. This update only revises and records the mock. Split later delivery only at a complete tested outcome boundary.

## Latest owner review

The owner accepted option B (no player changes in v003). A now unfolds only artwork above bottom-aligned play; C play moves another 6px lower. The sidebar mock has only its top tree toggle icon. Tree-wide dock, animations, all three Appearance behaviors and the additional theme remain required. All designs are now owner-approved, with C raised 3px in v004 and slow motion promoted into Appearance. This supersedes the earlier pending-review statement.

## Final owner approval

The owner said: "You can move play button in Option C slighly higher. Otherwise - all approved. Note that I liked slow motion two. Add it to the appearance settings. Write up detailed implemntation plan". v004 applies C top=59px (previously 62px) and adds Standard/Slow motion under Appearance. This is design approval and authorization to plan, not production manual acceptance or publication approval. See ../../../../superpowers/plans/2026-09-21-sidebar-player-appearance.md.
