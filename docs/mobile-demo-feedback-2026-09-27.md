# Mobile demo feedback — 2026-09-27

## Scope

Both owner feedback batches, including the Admin/Password report whose screenshots
were lost. The owner explicitly requested implementation from the written comments;
no replacement screenshots or new design gate is required. Preserve the approved
A/B album compositions, original large-art choice, actual track-table component,
capabilities, account data and streaming audio architecture.

Application base: `7d14d08a97124eef1f3807b76afcffb04fb554cf` on
`2026-09-25-mobile-layout`. Render-only seeding remains on
`2026-09-25-render-demo`. No main/parent branch promotion or release certification.

## Repair inventory and acceptance

All items below are implemented in the prepared patch, but remain unchecked until
real-app verification. Counter: 0/24 verified; implementation is not deployment.

- [ ] M01: Mobile pressed/selected navigation and menu feedback emphasizes text, not a solid row fill. Retain visible keyboard focus.
- [ ] M02: Artists drawer header places Back before the outlined selected tree-icon/Artists button. Reuse the desktop tree icon; do not expose unavailable future modes.
- [ ] M03: Thin player album and elapsed/total timestamp share a baseline. Artist/song/album remain independent overflow rows; Play is not faded while enabled.
- [ ] M04: Gallery and page-bar actions share dimensions and vertical centers, including family, info, view and account navigation.
- [ ] M05: Phone Gallery View unfolds downward without moving the header horizontally. Desktop still unfolds horizontally.
- [ ] M06: A deliberate two-finger Gallery pinch changes 1/2/3-column density, preserves browsing position and persists through the existing account/device preference store. One finger scrolls; suppress accidental card activation after a pinch. Retain the existing keyboard/tap zoom control as an accessibility fallback.
- [ ] M07: Family panel starts directly below its trigger, with the same short join as Album types, an opaque matching surface and no shadow above the panel through the trigger.
- [ ] M08: Family panel accepts the first native touch swipe immediately, before any item selection.
- [ ] M09: Mobile artist information is a centered closeable dialog with contained scrolling, background inertness and keyboard focus containment; desktop retains its anchored panel.
- [ ] M10: Search expands leftward as one pill over 340ms. Its action has no separate fill/outline. Suggestions require actual nonempty typing, not opening/focusing the icon, and align to the complete field.
- [ ] M11: Opening an unrelated menu/panel closes the previous surface, including account menus, Gallery View, Artists, Family, Settings and artist information. Genuine nested controls remain usable.
- [ ] M12: The Settings drawer begins at the main-body top, covers the page header, and shows a narrow vertical navigation list.
- [ ] M13: Mobile Appearance follows Desktop by default. Following sections reject every edit and Reset until Custom mobile is explicitly selected. Existing deliberately saved custom sections are retained.
- [ ] M14: Rules uses the page-bar right dropdown and the same navigation items instead of an inline phone sidebar. Empty rules remain honestly empty.
- [ ] M15: Extended generated previews include seven playable saved loops from three albums, including several clips of one song. Existing IDs, order, edits, removed entries and user-created loops are not reset.
- [ ] M16: Mobile Users remains a semantic table with visible User, Role/access and Actions columns. Status, sessions and invitations remain available inside their associated cells; desktop keeps separate columns.
- [ ] M17: User ellipsis is the shared bare ActionButton with a visible Edit menu. Keep all server-rendered capability restrictions and viewport-safe menu placement.
- [ ] M18: Admin permission labels, fields and secondary text use the active main-surface theme colors. Account navigation uses companion-surface colors, a narrow vertical list and aligned Gallery Bar controls.
- [ ] M19: Header Back follows the page hierarchy, not the chronological browser stack: account detail → Users → Gallery; Password → Gallery; utility page → Gallery; Cover Look Up → its album when opened from an album. Browser Back/Forward still replay browsing history. No Loops/Password cycle.
- [ ] M20: Album Back is bare and integrated with its context. Keep approved A horizontal bottom-right and B vertical top-right cover actions unchanged.
- [ ] M21: Light-theme Cover Look Up selection is outline-only, with additional spacing before section headings/possible matches and no cover-size shift.
- [ ] M22: A mobile row tap starts/resumes/pauses its track; double tap restarts from zero. Interactive child controls retain their own actions and desktop double-click behavior is unchanged.
- [ ] M23: Album details have no contrasting inner white panel; their existing components sit on the main-body background.
- [ ] M24: Card title and artist stay on individual single lines with measured overflow motion. Duration and track count never wrap internally. Rated stars scale to one row; unrated albums have no stars. Reduced motion is respected.

## Verification plan and contracts

Five focused JavaScript seam tests protect pinch thresholds, tap/restart dispatch,
Appearance edit authorization, exclusive surfaces and modal inert restoration.
Four additional real-app mobile scenarios cover native gestures/menus/search,
Admin/table/theme/hierarchy, Follow/Custom/Rules and real track/loop playback.
Use the existing generated PostgreSQL fixture and production routes/components.
All browser selectors and measurements belong in the shared/new POMs.

Two old geometry/locator contracts are explicitly superseded by the owner's new
instructions: the timestamp must now share the album line rather than sit below
it, and the Artists header now has responsive mode-button markup. The POM compares
the timestamp/album centers and selects the visible Artists heading. No scenario,
playback assertion, timeout, retry policy, tolerance or table contract is weakened.
New tests are additive. Preserve failed-run evidence and repair product failures.

Local preparation evidence: 102 existing focused JS tests and five new seam tests
passed; Python fixture syntax compilation and the production-parity guard passed.
Real-app hosted results and actual screenshot review must be recorded before
promotion. Local Jinja/Chromium component probes are not real-app/deployed evidence.

## Generated loop boundary

The opt-in seed runs only after isolated or Render-demo ownership validation and
normal inventory persistence. It uses the normal scoped saved-loop repository and
FFmpeg clip generation before app startup. It never starts the test control server
on Render and never changes credentials, authorization, real media or integrations.
Seven known generated artifact paths may be regenerated after ephemeral hosting
restarts, but existing metadata/order is preserved and removed loops stay removed.
The original small eight-album fixture remains unchanged.

## Desktop continuity and breakpoint repair — October 1, 2026

Gallery View registers as an exclusive surface only for M05’s downward mobile disclosure. Desktop’s horizontal inline unfold preserves the existing Family panel and its frame-by-frame anchor continuity; it is not a competing popup. Changing between these presentations closes the disclosure through its component owner before reconfiguration, retiring any previous exclusive registration. M11’s mobile exclusivity, genuine competing popups, native outside/backdrop actions and the original geometry/timing checks remain unchanged. This repair does not update the historical verification counter above.
