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

The responsive runtime, Home, gallery modes, navigable detail/settings/cover pages,
account-scoped preferences and persistent-player integration are implemented on this
branch. The native packaging and future playlist/top features remain outside scope.

The last hosted run at `f659a98fbd9add2a80f2cbd8c8570525f2179bfd` passed six of seven
mobile scenarios, including actual playback across page navigation, mobile appearance
customization, and saving gallery preferences into a fresh login. It exposed an
Artist Family lifecycle defect: a late canonical refresh of the same optimistic
artist view dismissed the panel after the user opened it.

The continuation fixes that lifecycle at the shared rendering boundary. An open
Family panel retains its content and focus on same-context hydration, but closes
when artist, search, scope or surface changes, or when another artist navigation or
scan page is pending. The failing browser scenario and its assertions are unchanged.
Six added unit cases cover refresh retention and navigation dismissal. Focused local
verification: 134 JavaScript tests, 12 Python tests, and production parity passed.
Hosted verification and final screenshot inspection remain in progress.

No checklist counters exist in this document; no checkbox totals were changed.
No merge, release, or full PR-gate certification is implied by branch verification.


### Rendered-screen follow-up

The seven mobile scenarios passed in hosted run `36196874885` on source
`23bbb2c697d0bcbe3a60749968a8d538e576a78b`. Screenshot inspection then identified
clipped library-section labels and a Home heading overwritten by gallery geometry
refreshes. The follow-up preserves Home context in the shared chrome renderer and
gives the existing drawer buttons content-sized flex tracks. It adds assertions
for label fit and Home context without removing or changing any prior acceptance
flow. Final screenshots are recaptured after this change.

Additional local related-seam verification ran 579 JavaScript tests: 576 passed.
Three failures also reproduce with the original base implementation: the Artist
Tree heading CSS-selector contract, Main-elements/player token isolation, and the
floating-player hover-strength CSS contract. Those inherited appearance issues
are not changed by this task and remain outside its mobile acceptance result.
No checklist counters or checkbox totals changed.


### Home-to-gallery geometry

Hosted run `36197332874` passed the seven mobile scenarios on source
`8fcd8378505c2cccf05d863add6605365631efcd`. The subsequent wide-tablet screenshot
exposed a real layout error: the virtual grid measured its container while Home
still hid it, leaving one-pixel card tracks. The shared gallery renderer now
synchronizes Home visibility before measurement. Two regression cases reproduce
the search and wide-tablet transitions. The browser scenario also checks that
the resulting cards have readable width. The Integrations capture now waits for
the real Last.fm controls rather than its loading heading. No existing scenario,
assertion, timeout or retry policy is weakened. Final hosted verification and
rendered-screen inspection are pending. No checklist counters were changed.
