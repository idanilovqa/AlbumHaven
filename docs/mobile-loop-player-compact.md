# Compact mobile saved-loop players

Owner follow-up, 2026-09-27. Continue the existing mobile-layout task and its
current-stack component-reuse/design waiver. Do not change desktop composition,
audio architecture, capabilities, album layouts, the album table, or hosting.

## Composition

Reuse the saved-loop card, PlaybackControlCluster, range, repeat control and
ButtonComponent. At phone widths the card has a title and original timestamps,
a 44-pixel Play/Pause control alongside the seekbar, then playback time and
Repeat, Pitch and Speed buttons. Pitch/Speed open compact check-marked pickers;
permanent plus/minus controls remain desktop-only. The pickers use the same
pitch-preview and speed actions, close on Escape/outside click/navigation, and
are mutually exclusive with other disclosures. A portaled picker cannot be
clipped by the size-contained loop card. Failed pitch previews restore the last
applied pitch rather than showing an unapplied choice.

Use Solid Black and Parchment & Pine's existing surface, line, ink and play
colors. No phone-only palette or hardcoded opposing light/dark panel. Preserve
original loop timestamps, real playback time, seeking and repeat. SVG transport
glyphs replace emoji on the phone without rebuilding the glyph each audio tick.

## Generated demonstration

The opt-in existing fixture adds Bridge study to Northlight / After the Rain /
Open Water: Opening motif, Rhythm study, Transition and Bridge study are four
playable clips in one song page. Eight clips in total. Normal scoped Postgres
seeding retains existing IDs, edits, order, removals and owner-created clips;
only missing generated media is regenerated. No production account is reset.

## Acceptance cases

- MLP01: all four cards fit 320, 390 and 430 pixel phone widths without horizontal
  scrolling; time does not wrap, Play and seekbar share a centerline.
- MLP02: repeat, pause and seek affect the existing clip. The Speed menu applies
  2x on that same audio owner. Pitch +2 uses the existing server preview and
  reports completion. A failed preview restores the applied setting.
- MLP03: opening Pitch closes Speed, Escape restores trigger focus, and both
  menus stay inside the viewport without widening a card.
- MLP04: capture the real application in Solid Black and Parchment & Pine, with
  four clips in one group and both menus. Capture desktop reference with its
  inline pitch/speed controls retained.

Additive coverage: three focused unit tests and three production-path browser
scenarios in the existing isolated Postgres/generated-media mobile suite. No
existing expectation, timeout, retry or unrelated fixture is weakened. Run the
mobile preview gates before promoting app changes to render-demo; this is not
a full release or a merge to main.

## Mobile index → song navigation (owner follow-up)

The owner approved the compact blocks, then explicitly requested the existing
loop navigation tree as a separate mobile index. Entering Loops now shows only
that tree and its existing filter at the top. Selecting a song (or its nested
loop item) opens the full song group. The filter belongs to the index: even a
query matching one clip must not remove the song's other loop players.

Song identity and the existing cover component have one visible owner, the
shared Gallery/Page Bar; the desktop detail header remains desktop-only. No
loop search or navigation tree is visible on the song page. Header Back returns
to the list with its filter and scroll retained, then to the parent/main page.
Browser Back/Forward and direct song reload use the existing mobile page history;
unknown or removed song IDs fall back to the list after data loads. No capability,
server route, persistence, fixture population, or audio architecture change.

Acceptance MLP05: index-only entry; filter and no-match state; explicit song
activation; all four clips despite a single-clip filter; one song identity; no
loop search in detail; hierarchy Back and browser Forward/reload; both themes.
The existing MLP01 cover-size measurement now locates the same 56px component in
the shared Page Bar instead of the duplicate body header. Two additive browser
scenarios cover this owner-requested navigation flow without changing playback,
picker, width, timeout, retry, or desktop checks.
