# Shared app bar — manual acceptance

This change adds one shared app bar to the library and Settings pages. It preserves the current application stack and existing controls.

## Desktop

1. Sign in and open the library. Reload to pick up the new stylesheet.
2. Confirm the logo sits inside a full-width top bar. The Artists tree begins beneath it. The top bar and tree have a continuous background, and the main content has a subtly different background with rounded upper corners.
3. Search for a known artist or album and press Apply. Verify results and existing artist/filter behavior. Open recent searches and confirm the popover appears above the gallery.
4. Open notifications, library status, and the Settings menu. Check placement and existing actions. Do not start a scan unless you intend to.
5. Through the account menu, open Admin Panel, then My account. Verify the same bar, its home logo, and the Settings navigation beneath it. Check the logo returns to the retained library and that browser Back/Forward works.
6. Start a track through the usual player flow, then repeat Settings navigation. Verify the existing player stays visible and playback continues. The app-bar change does not replace the player.
7. Load /admin/members and /account directly in a separate tab. Verify the same bar and home link, with controls appropriate to the signed-in account.

## Narrow window

1. Reduce the viewport to about 390 pixels wide.
2. Confirm logo and actions fit in the first row, with search and Apply beneath them. No horizontal page scrolling should be needed.
3. Open Artists from the gallery controls. Confirm the drawer begins beneath the app bar and stops above the player. Select an artist, reopen, and check Escape/backdrop dismissal.
4. Open Users and My account. Confirm the compact Settings navigation fits beneath its bar and the content scrolls within its own area.
5. At an intermediate width around 800 pixels, confirm the artist drawer still works beneath the single-row bar. Returning to a wide desktop window restores the expanded tree.

Report any visual or interaction mismatch. Owner manual acceptance is the next gate before adding the approved functional E2E coverage and running the later regression/review flow.
