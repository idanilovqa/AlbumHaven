# Owner approval: 2026-09-26

Home / Recent: **concept A (Underline)**. Album details: **A (Compact cover)** and **B (Centered cover)** as additional choices. The existing full-width-art layout, Gallery Bar album identity and scrolled thumbnail remain available. Concept C and Home concept B are not selected.

The owner separately approved the thin, knob-free playback line shown in their Spotify reference, and requested it as a mobile player UI option. It follows real playback progress; it is not an indeterminate loading animation.

Approved conversation artifacts (the earlier `options.html` contains the proposals):

- `albumhaven-home-designs.jpg` — SHA-256 `666deca5ad1da11432b299d31fbb3b64bc6ec4e2fda5117b91c8a9689624840d`
- `albumhaven-album-designs.jpg` — SHA-256 `d7ae62386ca5bf29771d1e691386def032f629c4f369983a98996b9734fa8cb8`

The player seekbars depicted in the proposal sheets are superseded by the owner's explicit thin-line reference. These artifacts are design proposals, not implemented-app screenshots.


## Final owner-approved album refinements (supersedes earlier A/B action mockups)

The last approved A is the **side-by-side** design in
`sixteen_horizons_album_interface.png` (SHA-256 `0b69c63ab9af174ea934e456091fccc6c2bc995963833cef7ab68fc6e9089c6b`).
The owner approved it explicitly, with the instruction not to change the real
track table to resemble the stretched mockup table.

- A / `stacked_bar`: square artwork left, artist/title/year • duration beside it.
  Back sits left of the artwork on its top edge. Cover Search and Quick Cover
  Search are **horizontal at the far right**, their **bottom edges aligned with
  the artwork bottom**. No Album pill and no outline around the title.
- B / `editorial_canvas`: square artwork centered, Back on its top-left, Cover
  Search then Quick Cover Search **vertical at its top-right**. Exactly two lines
  centered below: **artist • year**, then **album title**. No Album pill and no
  album/duration line. Approved screenshot: `image(20260927-035632).png`
  (SHA-256 `dfe2aefd7d4ca3f6e79a0e0440a847e401ca9e8b520adf4c262f2d5583c95229`).
- Keep `classic_bar` and its existing Gallery Bar/artwork behavior. Keep the
  existing AlbumTrackTable component and its widths, columns, row treatments,
  playback flow and content; do not copy mockup table styling.
- Small layouts hand identity to the shared Gallery Bar only after the cover and
  copy leave the viewport, and reverse cleanly. Do not show duplicate identity.

## Final player refinements

The owner reversed the combined song/album line: artist, song and album now each
have their own line. Only an overflowing line pans; preserve full accessible
text and reduced-motion behavior. Keep the actual thin seekable progress line,
centered Play/Pause glyphs and the single-line timestamp below the copy, directly
left of Play. Empty playback has a centered Nothing is playing message on Play's
horizontal centerline, without a timeline capsule or layout change.

These are changes to existing presentation only, not new capabilities, accounts,
playback engines or persisted settings. The approved Home A is unchanged.
