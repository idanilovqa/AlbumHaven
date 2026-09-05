# Missing Album And Album Details Manual Acceptance

## Build under test

- Checkout: `C:\Repositories\album-haven-app`
- Base commit: `03a455f`
- Runtime bundle: freshly generated with `npm run build:runtime`
- Database migration: `0058_album_details_appearance.sql`
- Use the owner's normal keyed application URL. The unkeyed automation tab cannot enter this session.

Do not use an irreplaceable album for the deletion exercise. Copy a small album into a watched test library first so it can be restored.

## 1. Watcher and missing gallery card

1. Start Album Haven normally and open the keyed web UI.
2. Note the test album's exact position among its neighboring cards.
3. Delete or move the album directory outside every configured library root.
4. Wait for the maintenance watcher to reconcile it; do not start a full scan.
5. Confirm the existing card stays in the same position and keeps its title, artist, year, rating, and identity.
6. Confirm the artbox remains square, uses the crossed-circle missing treatment, and does not revive cached cover art.
7. Confirm the bottom-right red alert is compact and nearly circular.
8. Hover the alert and then keyboard-focus the album card. Confirm it expands to `Album not found` without resizing or moving the card.
9. Repeat at a narrow window width and with reduced motion enabled. Text must remain available even when interpolation is suppressed.

## 2. Missing Album Details

1. Open the missing album.
2. Confirm the header retains artist, album, year, release type, and the `Missing` tag.
3. Confirm Edit tags, Open folder, and Close remain icon-only and `34px × 34px`; unavailable operations must not be offered.
4. Confirm the square missing artbox has no compact hover alert.
5. Confirm the reusable red page alert appears to the right with `Album details unavailable`, `Remove from library`, and `Keep as missing` as authorized.
6. Confirm no track table, `Tracks` heading, skeleton rows, or total-length footer appears.
7. Choose `Keep as missing` and confirm the library entry remains.
8. Reopen it, choose `Remove from library`, confirm the action, and confirm the modal closes and the gallery card disappears immediately.

## 3. Present Album Details layouts

For each Appearance > Album page choice—Classic Bar, Stacked Bar, and Editorial Canvas—save the setting, close and reopen a present album, then reload the app.

Confirm:

- the saved layout persists;
- every artbox is square;
- artist and album use a fat-dot separator where they share a line;
- Stacked Bar aligns the top-right actions with the first information line;
- the three header actions remain icon-only and no larger than the existing `34px × 34px` buttons;
- Editorial Canvas uses the truncated integrated header and left-top artbox;
- the same compact track table is used in all layouts.

## 4. Track table states and playback

1. Open a single-disc album. Confirm there is no generic `Tracks` heading or `CD 1` heading.
2. Open a multi-disc album. Confirm `CD 1`, `CD 2`, `Bonus CD`, or stored disc names appear as appropriate.
3. Confirm rows are vertically dense and contain Play/Pause, track number, title/credit, and duration.
4. Hover a row. Confirm only the surface hover changes; no left accent appears.
5. Open an album from a matching track search. Confirm matching rows keep the theme-colored backlight and left accent while hovered.
6. Play a track. Confirm the one-shot play-button chase settles, the active row keeps a static theme/player-colored outline, and the two perimeter spectra remain opposite while following the rounded row border.
7. Turn Appearance > Album page > Currently playing animation off. Confirm the active outline remains but spectra stop. Repeat with reduced motion enabled.
8. Confirm the total-length strip has only right and bottom edge emphasis and dissolves completely into the background at the left.
9. Start, pause, seek, resume, change track, close/reopen Album Details, and use the bottom player. Confirm there is one audible source and queue, progress, seek, and next-track behavior are unchanged.

## Automated evidence before handoff

- Focused JavaScript integration: 333 passed.
- Focused Python integration: 255 passed in 5.03 seconds.
- Runtime bundle build: exit 0, 63 modules.
- Full runtime inventory was also run. Seven unrelated existing failures remain in the dirty checkout: six Appearance editor-preview assertions and one non-album editor harness missing `showRepairAlert`. These are outside this feature's owned test set.

Functional E2E cases `FTC-LIBROOTS-017`, `FTC-ALBUM-DETAILS-019`, and `FTC-ALBUM-DETAILS-020` remain intentionally unimplemented until this manual acceptance is recorded.
