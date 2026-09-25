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

## Progress

Implementation not yet complete. Verification bootstrap added; runtime work and screenshots follow in subsequent commits on this branch.
