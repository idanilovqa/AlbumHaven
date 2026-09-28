# Mobile owner feedback — 28 September 2026

Generated-media preview: https://albumhaven.onrender.com

## Request coverage

| # | Result and manual check |
|---|---|
| 1 | Apply/Save use the shared primary action colors, separate from field fills, including Parchment & Pine. |
| 2 | Light-theme fields use a pale card/control surface with the theme’s readable text and border. |
| 3 | Edit Tags alternates track-row shading in light and dark themes, including selected rows. Edit Tags remains desktop-only under the prior mobile scope. |
| 4 | Turning off the selection accent retains the complete preview card border and dimensions. |
| 5 | Home owns its heading and tab rows together. Artist navigation replaces the entire main area with loading until the gallery is ready. |
| 6 | Album context menus are blocked on narrow layouts and mobile clients, including wide mobile tablets. |
| 7 | Gallery view and other gallery actions use the same strong theme-ink focus border. |
| 8 | The zoom magnifier is removed. Cards/covers default to three columns for unsaved mobile preferences; saved density is retained. A brief two-finger hint fades out, respecting reduced motion. Pinch supports one, two and three columns. |
| 9 | Mobile family/artist identity gets the full header width; actions occupy the row below, aligned right. |
| 10 | Card metadata is smaller and closer together. Generated albums include ratings, shown as compact numerical pills on mobile; unrated albums remain represented. |
| 11 | Selected cover candidates have a bold three-pixel outline with light/dark colors. |
| 12 | Mobile Cover Look Up places Save left and Find Better Art right, using the same shared button style and natural text widths. |
| 13 | Gallery loading no longer waits for mark-seen bookkeeping. Stale responses cannot replace a newer gallery. Local Save waits for completion; generated cover choices are restored by content revision on demo restart. |
| 14 | Header action surfaces share 40-pixel sizing and center alignment. |
| 15 | Search sits beside the logo and expands across the other actions. Empty search collapses outside or after submission; a query stays expanded. Clear it to reveal header actions again. |
| 16 | Player metadata starts beside the artwork instead of being centered inside its grid column. |
| 17 | Tapping the full-artwork backdrop closes it; dragging from the image does not accidentally close it. |
| 18 | The notification drawer is at most 75% of the phone viewport, capped at 320 pixels. |
| 19 | Clear and Close use the shared SVG/action-button sizing instead of mismatched raster artwork. |
| 20 | Library status menus inherit the app-bar theme. |
| 21 | Sources menus inherit the same app-bar theme. |
| 22 | Follow Web/Desktop or Custom always has a visible selected state. Saved choices remain intact. |
| 23 | Main elements explains where Player & Seekbar customization lives; the jumping Customize button is removed. |
| 24 | Appearance Reset is left aligned; Cancel and Save are right aligned on the same row. |
| 25 | Main elements previews across the app immediately. Save persists; Cancel or leaving the editor restores saved appearance. Other sections keep their established preview behavior. |
| 26 | Mobile Selection is editable after choosing Custom. Follow intentionally inherits and locks the web values. |
| 27 | Alerts follows the same explicit Follow/Custom behavior and persists a saved mobile customization. |

## Additional defects found in verification

- The Postgres root-browse route rejected the existing All artists flag. It now accepts that normal request and preserves its view state.
- Clearing a pending search through the cached-gallery path could leave loading visible. The retained-view path now dismisses the pending loader.
- Rebuilding cards during a pinch could detach its touch target. Density is committed when the gesture ends.
- Home’s GalleryBar is moved only when its owning page changes, avoiding repeated reparenting during gallery updates.

## Verification status

Final cloud results and deployed commit are pending. This document is a request map, not a completion claim until those results are recorded.

The browser suites use the production ASGI application, ordinary routes, isolated PostgreSQL and generated media. Added cases cover three palettes, real native pinch gestures, loader ownership, search geometry, appearance save/cancel, selected covers, backdrop dismissal, player spacing and desktop tag fields/stripes. Existing playback, loops, account, navigation and responsive-transition scenarios remain in the run.

## Boundaries

The preview uses generated media only. Restart restoration covers the generated original/alternate artwork, not arbitrary external uploads on ephemeral storage. Existing accounts, password hashes, library identities, saved preferences, history and loops must survive startup. Home Top tracks/albums/artists remain the previously approved work-in-progress placeholders. This work does not merge main or certify a production release or native-device background audio.
