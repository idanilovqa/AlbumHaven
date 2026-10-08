# Mobile layout refactor

## Task boundary

Owner request dated 2026-09-25. Implement on `2026-09-25-mobile-layout`, based on `2026-09-09-cover-look-up-refactor` at `d4dd05df85d39e912dc20292b3a08c075523e34a`. Do not change or merge the parent branch or main.

The owner explicitly waived the mockup/design-review gate for this task and requested implementation using existing UI components, followed by real rendered screenshots. This exception is task-scoped, not a change to repository policy. Preserve the current server-rendered JavaScript/CSS stack and existing audio architecture.

## Required behavior

- Shared responsive mobile presentation for web and mobile app web surfaces; wide tablets use the desktop layout. Native application packaging is not introduced by a layout refactor.
- Compact app bar without search, with branding, existing controls, and login/profile access. Preserve authentication and initial login redirect.
- Secondary navigation row: left navigation drawer trigger, contextual Back action on inner pages, and a right search trigger that expands and immediately focuses the existing input.
- Artist navigation hidden by default on phones. Left drawer includes Artists, Playlists, and Album tops navigation slots without pretending unavailable future features are implemented.
- Empty search shows Home with the authenticated user's recently played albums, backed by existing listening history.
- Gallery supports full-width album rows, cards with information, and artwork-only covers. Phone grids have two or three columns. Reuse existing artwork, metadata, rating, and accent components.
- Gallery view control unfolds to choose a mode, then closes. Persist selected view and density per user and client/device category.
- Artist Family remains a right-side sliding panel, matching the desktop interaction. It is not a section above the gallery.
- Album details, utilities/settings, appearance, integrations, and cover lookup occupy navigable pages rather than mobile modal overlays. Context belongs in the existing gallery/page bar.
- Album details put artwork and artist/title/year/duration above the shared track table and its duration footer. Artwork opens its full-size view.
- Keep the bottom player mounted through navigation. Player artwork opens the playing album's details. Preserve on-device playback and the existing gapless AudioWorklet/PCM streaming engine.
- Hide and block Edit Tags and Problematic Files on mobile clients. Preserve server authorization; responsive presentation must not grant capabilities. Other owner-only utility functionality is either absent or read-only on mobile.
- Preserve existing appearance profiles and support explicitly linking mobile appearance to web/desktop preferences without merging unrelated device settings.

## Additional acceptance coverage

Include loading, empty/error states, missing/unavailable albums, session expiry/login return, account and password screens, Back/browser-history behavior, drawer focus/Escape behavior, safe-area/keyboard sizing, and resize/orientation transitions. Retain existing non-album-track access where supported. Future playlists and tops must have honest unavailable states.

## Verification

Use focused unit/contract tests for changed seams and production-path browser verification with isolated Postgres and generated media. Capture real screenshots at phone, narrow-phone, and wide-tablet/desktop sizes. Do not substitute generated mockups or app-owned API mocks for screenshots of the implemented application. Existing full PR gates remain authoritative for release readiness; this branch workflow supplies development evidence, not a replacement release gate.

## Delivery status

The mobile view refactor is implemented on `2026-09-25-mobile-layout`, using the
existing components and plain JavaScript/template stack. The owner waived the
mockup review gate for this task only. No parent-branch change, merge, release,
native package or future playlist/top implementation is included.

### Verified implementation

Tested application source: `b9b233cb8fda6cfc337326abc7d44115d42dbab6`.
Hosted run: `36198005259` (Mobile Layout Verification), completed successfully.
Screenshot snapshot: `5e8ea80beadab82f4db6c6ac0822bc0612cac42f`.
The snapshot contains 18 PNGs under `test-results/mobile-screenshots/` and the
Playwright result under `test-results/mobile-layout-results.json`.

- Seven real-app browser scenarios passed with no retries. They cover login and
  Home, drawer/search/Artist Family, persisted gallery modes and density, album
  details and full artwork, settings/integrations/account navigation, narrow-phone
  and wide-tablet geometry, independent mobile appearance, and actual playback
  across page navigation and a track boundary.
- Hosted focused checks passed: 135 JavaScript tests, 12 Python tests, and the
  production-parity gate. An expanded local focused command also includes the
  virtual-grid regressions: all 186 JavaScript tests passed.
- The browser uses the production ASGI app, normal routes, repositories and player,
  backed by disposable PostgreSQL and generated test media. Screenshots do not
  contain the owner's real library and are not generated UI concepts.

### Defects corrected during verification

Same-artist hydration no longer closes an open Artist Family panel. The panel
still closes on a real artist, search, scope or surface change. Drawer labels fit
within their controls, and Home keeps its heading after density changes. Leaving
Home now restores the gallery before measuring virtual rows, preventing one-pixel
cards after search or a wide-tablet resize. Integrations captures wait for the
real Last.fm controls instead of capturing the loading state. Existing browser
assertions, flows, timeouts and retry policy were not weakened in these fixes.

### Testing boundary

The additional related-seam run had 576 passing tests out of 579. Three failures
also reproduce with the original base implementation: the Artist Tree heading
CSS-selector contract, Main-elements/player token isolation, and floating-player
hover-strength CSS. They were not changed to force a pass. Full authoritative PR
regression, owner manual acceptance and release certification remain separate
from this task-specific verification. Physical-device native packaging, platform
background-audio behavior and every error/session-expiry edge case are not
certified by the seven browser scenarios.

### Local handoff

Use this branch rather than the parent. Existing databases need the additive
`migrations/postgres/0080_user_client_layout_preferences.sql` migration applied
through the established migrator workflow before account/device settings can
sync. No existing migration was rewritten.

Check Home at phone width, switch Rows/Cards/No info and two/three columns, then
reopen the account on another mobile session to confirm persistence. Open an
album, play a track, visit Appearance or Integrations, and use player artwork to
return to the album. Verify Artist Family from the right and resize above 900px
for the desktop presentation. Playlists and Album tops have explicit unavailable
states, not fake implementations.

No checklist counters exist in this document. Exact direct-work and process
elapsed times were not recorded. The implementation is retained on the task
branch for the owner's inspection; no publication is implied.
