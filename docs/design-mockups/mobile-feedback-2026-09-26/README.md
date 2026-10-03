# Mobile feedback design approval

Status: proposed, not approved or implemented. Owner request: 2026-09-26.

`options.html` is a review-only coded composition. It is not loaded by the application.

- Home A: understated underline in-page tabs (recommended).
- Home B: soft segmented in-page tabs.
- Album A: compact 96px artwork beside identity (recommended for track-first use).
- Album B: centered 208px artwork and identity.
- Album C: editorial identity beside 144px artwork.

All alternatives retain the shared AppBar, GalleryBar, ActionButton, AlbumArtbox, AlbumTrackTable and persistent-player families. The only proposed primitive is an understated in-page tabs variant for Home and similar future ranked lists. It supports one selected tab, keyboard focus and arrow/Home/End navigation when implemented. Review-only tabs in this HTML change selection visually; they do not fetch data. News is natively disabled.

Home is mobile-only and uses the authenticated username. GalleryBar contains Recent/News and the Artists action; density, Album types and Gallery view are absent on that surface. The exact empty-state copy is retained. Desktop still opens the library.

The album alternatives illustrate geometry, not new playback behavior. The expanded GalleryBar contains the artwork and identity once, without a repeated body title. After scrolling, it condenses to the small GalleryBar cover and identity in every option. Existing stored layout values will be mapped only after the owner chooses the accepted alternatives. No new permissions, routes, external assets or framework adoption are proposed.

Implementation gate: owner selects the exact option IDs.
