# Compact sidebar player variants

Status: proposed; owner approval pending. HTML mock only.

Source: user-supplied cropped compact-player screenshot, retained as current-player.png. Branch: 2026-09-09-cover-look-up-refactor.

Brief: remove the top white line and resting chevron; align a smaller glowing play button with sidebar icons; avoid clipping its glow; unfold album art and an optional expand control on hover like the scissors control; synchronize sidebar/player expansion. Also show dock-to-floating and bottom-artbox variants, the latter with play centered on the dividing line, single click for full player, double click for album details.

Review: open mockup.html directly. Select A/B/C. Toggle sidebar, slow motion, and alignment guides. A: hover/focus play, traverse to artwork and expand control. B: compare floating and docked positions. C: single/double click art and inspect edge alignment. Full-player close restores compact state. Keyboard: Tab/Enter; ArrowUp on art opens album details; Escape closes modal or full player. Reduced motion follows system preference.

Palette follows the screenshot and existing player: dark green rail, green play, parchment gallery. Artwork and library are original illustrative placeholders; no music or user data is loaded.

One animated --rail variable controls the sidebar width, content offset, player width and play alignment. Other positional transitions share its duration/easing without delays. Single-click art waits 300ms to distinguish double-click; this delay is solely a prototype gesture tradeoff, not sidebar animation delay.
