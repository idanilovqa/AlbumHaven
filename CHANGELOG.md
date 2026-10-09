# Changelog

## 0.9.50 - 2026-10-08

- Made Settings, Edit Tags, and album-details dismissal respond immediately while slower cleanup and data loading continue in the background.
- Cut Problematic Files startup work with bounded initial loading, reusable projections, cache-aware diagnostics, and complete background hydration without weakening search results.
- Improved Problematic Files suggestion dragging and changed inactive suggestion labels to a neutral outline so selected labels remain clearly green.
- Prevented collaboration albums with multiple Cyrillic artists from being reduced to an incorrect single-artist suggestion.
- Smoothed and lengthened the startup progress bar, centered its percentage below the bar, and added player-color glow to both elements.
- Kept Problematic Files performance reporting aligned with the 1,000 ms target and 1,200 ms hard ceiling.

## 0.9.49 - 2026-10-07

- Kept notifications clear of transparent waveform seek controls so pointer
  interaction remains available.
- Improved authenticated startup with bounded initial gallery loading, accurate
  global artist and album totals, and the complete artist sidebar.
- Added a PostgreSQL gallery summary with transaction-based invalidation, stable
  ordering and cursors, bounded page hydration, and an accurate fallback when
  the summary is absent or stale.
- Kept artist ordering stable after search and clearing, expanded folder-derived
  artist families, and prevented stale search responses from replacing newer views.
- Replaced previous gallery results with a compact Searching indicator while a
  submitted search is pending.
- Removed the redundant search-preview request so complete search results no
  longer wait for a second response; retained Searching feedback and timing limits.
- Unified selection, search, and scan loading indicators through the same compact
  spinner component.
- Added persistent album-adjacent cover previews, throttled preview backfill,
  and full-size artwork preloading when album details open.
- Displayed linked album editions immediately using the shared tabs on desktop
  and mobile, and retained filtered mobile artist navigation after search.
- Improved Problematic Files layout, year visibility, truncation, suggestion
  selection feedback, and continuous drag selection across displayed suggestions.
- Corrected MP3 gapless boundaries using encoder metadata while preserving
  intentional silence, and reused successful decoder compatibility checks to
  reduce repeated seek preparation.
- Improved mobile artwork navigation and playback seeking, and prevented stray
  text carets outside focused editable controls.
- Made horizontal drags near the thin player's playhead take precedence over
  adjacent Play-button hits while preserving normal taps and cancelled gestures.
- Prevented late Problematic Files responses from replacing playback controls
  in another active utility tab, and refreshed Last.fm log history after failed
  connection attempts.

- Preserved the released 0.9.48 mobile layout and Admin capability behavior while
  reconciling the approved desktop Gallery, player, and appearance presentation.
- Resumed deferred Gallery cover loading only after cached Scan Page navigation
  finishes rendering its replacement view.
- Preserved decoded album-card artwork ahead of pending virtual-window placeholders
  and kept loop action pods from shrinking in constrained layouts.
- Corrected scan-performance database identity propagation and retained focused
  regression coverage for production locators, provider labels, and navigation.
- Added a database-owned normalized artist-search projection with
  revision/readiness checks and the existing live-query fallback, preserving
  multi-alias, raw-metadata, path-derived, active, stale, and category-filtered
  results.
- Preserved ready relation metadata when confirmed missing-album cleanup deletes
  stale inventory, while still advancing the inventory mutation revision.
- Added safe nontransactional migration handling for the concurrent
  artist-search index: validate before ledgering, remove only the named invalid
  index after failure, and leave the next startup able to retry.
- Added explicit Devin and Neal Morse submit-to-first-visible performance budgets
  without treating their still-uncollected baseline and range as zero
  milliseconds.
- Replaced the production-search database's reversible unsalted identity digest
  with a versioned, domain-separated HMAC proof that exposes neither database
  identifiers nor authentication secrets.

## 0.9.48 - 2026-09-30

- Added responsive mobile navigation and Home, with shared account and Settings
  navigation that preserves desktop controls and restores parent routes and scroll.
- Saved client layout preferences per account and device, including Artist Tree
  collapse state and mobile Gallery columns, with reload and save-completion coverage.
- Kept artwork, Gallery, player, and nested menus usable through touch input,
  responsive layout changes, and dismissal of the actual dimmed backdrop.
- Combined mobile Admin presentation with named roles, capability prerequisites,
  protected-owner restrictions, and revision-safe repeated account updates.
- Preserved native clipboard paste, exact Problematic Files identity and rendering
  checks, retained Gallery chrome, and connected-menu paint and calendar coverage.

## 0.9.47 - 2026-09-30

This release includes the unreleased 0.9.46 changes below.

- Added user and access administration with separate Viewer, Listener, Musician,
  Owner, and Admin roles, combined roles, and individual capability grants.
  Existing grants remain intact on ordinary saves; administrators can choose
  to replace individual grants with the selected roles.
- Enforced capability prerequisites and shared UI and server restrictions for
  playback, editing, covers, loops, repair tools, and administration. Preserved
  access to owned practice-loop audio and artwork without full-library playback.
- Restricted TV artwork selection to provider candidates. Mobile and TV block
  tag editing, deletion, and loop creation; TV also blocks practice and
  administration.
- Disabled the unimplemented Move music setting while preserving stored grants.
- Improved Admin navigation, disabled controls, switch and checkbox feedback,
  and light-theme alerts. Connected menus now match their originating content
  surface, including cream content with dark Parchment & Pine chrome.
- Added real-user browser coverage for role and capability boundaries, denied
  controls, client restrictions, and assignment persistence against the real
  application and PostgreSQL. Added isolated demo provisioning for manual tests.
- Kept Artist Tree selection visible after unfolding and refreshed Artist Family
  controls without rebuilding retained gallery cards or rewriting unchanged labels.
- Corrected cover-provider labels and cover-only result counts, and recovered
  artwork loading after detached gallery consumers were canceled.
- Kept Problematic Files selection and details stable across virtual scrolling
  and resize, and restored saved-loop range and hover feedback.
- Strengthened regression coverage and fixture cleanup for native clipboard paste,
  notification delivery, folded-tree persistence, and saved appearance preferences.
- Included the Cover Look Up redesign, Library Status Page, player and gallery
  improvements, account-scoped device appearance storage, and Problematic Files
  virtualization recorded under 0.9.46.

## 0.9.46 - 2026-09-23

- Reworked Cover Look Up and album artwork controls with shared components,
  staged paste/drop/file inputs, source previews, and failure recovery.
- Added a Library Status Page with scan phases, cancellation, failure reporting,
  and access to the library during scans.
- Preserved gallery position and playback while folding the Artist Tree, and
  refined docked, sidebar, and floating player layouts and appearance controls.
- Added account-scoped device appearance storage while keeping Mobile and TV
  editing disabled and preserving their saved compatibility values.
- Unified modal Escape handling, notification actions, connected menus, and
  Edit Tags selection and reorder behavior.
- Virtualized the Problematic Files list while preserving search, filtering,
  selection, and navigation. Cold-load performance optimization remains Phase 9
  debt under an owner-approved temporary timing exception.
- Expanded focused browser and component coverage for these interactions and
  adopted the published v1.0.25 test fixtures.

## 0.9.45 - 2026-09-21

- Reworked Settings around shared navigation, search, rules, suggestions,
  integrations, log history, appearance, and responsive component contracts.
- Moved saved-loop ordering and waveform peaks into account-scoped PostgreSQL
  storage, with migration coverage and cache reuse across later loop playback.
- Loaded saved-loop waveforms immediately, brightened played peaks, dimmed
  upcoming peaks, removed interaction outlines, and limited playback to one loop.
- Added account-scoped Last.fm configuration, retry and status reporting, manual
  scrobble submission, measured-listen accounting, and provider boundary tests.
- Refined the Artist Family panel with fixed geometry, reusable filter pills,
  optional artwork, neutral dropdown motion, and a primary-artist divider.
- Preserved collaboration identities while rendering their visible album-credit
  groups, including the IR8 / Sexoturica split release in Devin Townsend results.
- Kept replacement playback, gallery scroll restoration, warnings, search state,
  album metadata, and responsive layouts stable through interaction races.
- Expanded production-path functional, component, performance, and regression
  coverage for Settings, loops, playback, gallery, search, and artist families.

## 0.9.44 - 2026-09-12

- Reworked the Gallery bar, artist-family selection, album-type controls, and
  artist information panels; kept selection, search, and direct navigation in sync.
- Balanced gallery card widths and cover-only layouts, added hover years with
  a border opening, and restored startup totals, recent searches, and cover sizing.
- Hid Artist Family controls at the library root and removed the notification
  information hover outline while preserving keyboard focus and card controls.
- Excluded guest-only album appearances from related Artist Family sections
  while retaining owned and genuinely shared releases, including during search.
- Labelled additional track artists as featured guests when the track credits
  include the album artists, while preserving distinct primary artist credits.
- Shared album headers, track tables, playback icons, and problem labels with
  loose tracks; preserved version-tab identity and loaded tracks on first open.
- Refined saved-loop controls and the combined waveform, retained regular seeking
  while waveform data loads, and allowed failed waveform requests to recover.
- Kept player controls and highlights stable during pointer interactions and
  limited sticky appearance previews to the player while preserving saved colors.
- Applied saved Appearance colors to the new Artist Family panel and preserved
  related-artist albums when search results refresh after a sidebar selection.
- Migrated the appearance constraint so default and custom panel outlines can be
  saved while preserving existing preferences and color validation.
- Kept Interview and Non-album rarity tracks out of gallery and startup album
  cards while preserving scanned and overridden exceptions in Loose Tracks.
- Corrected soundtrack totals for tracks credited to multiple artists, including
  the 14-track Mulan soundtrack, without merging equal-duration tracks.
- Added account-scoped warning dismissal backed by Postgres. Library/Scan keeps
  unresolved watcher health visible, and new warning events restore the alert.
- Preserved track playback and text selection during double-click and drag actions,
  and kept album identity and artwork fixed while scrolling modal tracks.
- Preserved enabled library sources across search and kept loose-track actions
  scoped to those sources while refreshed results load.
- Loaded paused saved-loop waveforms without evicting pending requests and kept
  their Play controls visibly focused for keyboard users.
- Reused startup asset digests and preserved the gallery scroll position when
  returning from Scan, while preserving the approved account-menu hover styling.
- Expanded isolated real-application regression coverage. PR2 uses the owner's
  hosted-review waiver; all required test suites must pass before publication.

## 0.9.43 - 2026-09-10

- Preserved new watcher failures after recovery when the system clock reports
  the same timestamp, while continuing to discard delayed older warnings.
- Kept status requests responsive while startup pages build their PostgreSQL
  bootstrap payloads.
- Kept pointer-driven player layout changes free of stale focus highlights while
  preserving keyboard and responsive focus transfer.
- Registered the complete component inventory and preserved exact displayed-cover
  byte evidence across navigation and the production image cache.
- Added independent `skip_reviews` and `skip_tests` pipeline labels. PR1 uses an
  owner-approved review waiver; complete passing tests remain required to release.

- Preserved untouched native player components when saving partial appearance
  edits, without reinterpreting existing custom styles; kept duration text opaque.
- Serialized reset-mail claims with account changes, retained newer watcher
  failures during concurrent writes, and refreshed warnings independently of
  inventory updates.
- Restored responsive-test appearance changes, isolated both private-fixture
  environment inputs, rejected malformed Text Tools columns, and corrected
  runnable testing-guide examples.
- Scoped test-runner ownership locks to the actual database so independent
  fixture databases do not block each other during startup.
- Retained encrypted review diagnostics for private failure investigation, with
  run and review-unit binding and no plaintext log upload.
- Reported fixed CI review failure categories without exposing console text or
  private usage data, while retaining complete review and test gates.
- Retried due welcome messages through a bounded background worker when delivery
  is enabled, preserving uncertain delivery outcomes without automatic resend.
- Restored separate main and bonus track durations inside the shared album
  summary and covered saved motion preferences independently of OS settings.
- Scoped missing-album aggregation to the selected artist and preserved complete
  release dates and retained-track years during targeted reconciliation.
- Reported native watcher callback failures, bounded watcher shutdown, and
  reserved descendant track paths during subtree reconciliation.
- Closed expired-throttle cleanup races in password-reset and administrator
  mail actions, and isolated SMTP test doubles between delivery scenarios.
- Preserved legacy selection accents during appearance upgrades and refreshed
  the saved appearance baseline after concurrent changes in another client.
  Kept unsaved colors inside previews while editor controls retain saved colors.
- Enforced administrator body limits while streaming, kept account mutations
  within the current library, and closed authentication cleanup and mail-expiry
  races without changing credential limits.
- Preserved release identity and automatic cover selection during targeted
  scans, kept published inventory revisions monotonic, and retained fixture
  evidence when database cleanup fails.
- Kept pending track edits authoritative over late hydration responses and
  displayed compact-player artwork whose path contains an apostrophe.
- Bounded breached-password network work through worker cleanup, refreshed
  invitation lifetimes after lock waits, and cleared dismissed reauthentication
  passwords from the administrator roster.
- Kept missing albums searchable by canonical and alias artist names, preserved
  alias-folder loose tracks, and respected filesystem case when identifying
  successfully observed library roots.
- Corrected intermediate-width appearance layouts, retained swatch colors during
  interaction, cleared superseded background errors, and respected user scrolling
  after focused-track navigation. Restored Album Details appearance fixtures.
- Covered queued playback cancellation and search classification, corrected
  Windows scheduled-backup path quoting, and aligned focused-CI documentation
  with the default local-verification-to-complete-pipeline process.
- Checked that both local E2E ports can bind before fixture startup, avoiding
  Windows-reserved port ranges even when no process is listening.
- Revalidated the administrator's live session during account creation, checked
  pre-authentication token expiry after row locks, and rejected oversized body
  chunks before copying them into the JSON buffer.
- Preserved later navigation and unrelated album dialogs when missing-album
  removal completes, recovered virtualized albums above the viewport, and kept
  player mode changes working when browser storage access is denied.
- Compared listener capabilities independently of ordering, applied independent
  interaction colors without a palette, and kept invalid waveform drafts visible
  through validation guidance when switching seekbar modes.
- Drained fixture control requests before database cleanup and retained the
  unsaved-appearance confirmation when closing Utilities with its close button.
- Retained complete album credits and root provenance across targeted scans,
  included matching missing albums in exact-artist search, and treated failed
  file-stat observations as incomplete scans instead of missing-file evidence.
- Retained watcher restart intent after failed root replacement, preserved
  directory identity during reconciliation, and refreshed old album credits
  when retagged tracks move to another album.
- Refreshed open album details after a removal conflict and preserved an
  explicitly edited album artist when splitting compilation tracks.
- Kept keyboard focus in the active player when switching layouts, including
  responsive expansion while playback controls are disabled.
- Rejected oversized JSON numbers and excessive nesting in bounded administrator
  requests, kept account enable/disable actions aligned with their labels, and
  limited invitation and reset controls to accounts with current library access.
- Rechecked session expiry after lock waits, retained later authentication
  cooldown deadlines, and allowed expired throttle cleanup to finish without
  breaking in-flight password verification. Preserved valid invitation cookies
  when external invalid or replayed links temporarily withhold them.
- Resolved default appearance editor colors, restored shared footer styles on
  exit, applied saved navigation interaction colors, and cleared replaced
  waveform validation errors when choosing a complete player style.
- Classified whole-PR review changes from the merge base, corrected provider
  port allocation, and preserved scan startup errors and process ownership
  when cleanup fails. Fixed Foobar backup containment and literal TSV quotes.
- Rechecked administrator sessions under mutation locks, shared credential
  attempt and hashing limits across password entry points, and preserved lock
  order and expiry checks during concurrent authentication operations.
- Made external invitation links work with Strict transaction cookies through
  a token-free continuation page. Rejected breached-password redirects and
  preserved request credentials and same-origin CSRF behavior.
- Preserved appearance fields and first-save defaults in Postgres, corrected
  player contrast and background previews, and blocked invalid color saves.
- Preserved current navigation and album-detail state across asynchronous
  refreshes, whole-library counts after removal, and mobile track-table layout.
- Restored appearance fixtures after unfiltered functional runs and stopped
  subsequent tests when restoration or process cleanup could not be proven.
  Tightened focused case selection and bounded application readiness probes.
- Added local authentication and account administration, including secure owner
  bootstrap, sessions, password recovery, invitations, audit records, and
  policy enforcement for private routes and media.
- Expanded the shared application UI with account navigation, appearance
  controls, compact and expanded player layouts, reusable buttons, album
  details, track tables, alerts, and search and navigation refinements.
- Added targeted library filesystem watching, reconciliation, health reporting,
  and transactional missing-album removal backed by Postgres.
- Surfaced Windows native overflow and unexpected watcher emitter or startup
  failures through library health reporting.
- Disabled native filesystem watching on Linux for this release. Linux users
  retain manual rescans and confirmed missing-album removal.
- Protected missing-album removal with pending watcher health, kept missing
  albums in canonical artist groups and search, and made settings saves
  responsive while preserving serialized root replacement.
- Bounded HTTPS shutdown behavior and expanded the JavaScript, Python,
  component, functional, authentication, and performance release gates.
- Applied configured password limits consistently, bounded appearance JSON
  mutations, persisted missed watcher-write health, and made stale bearer-mail
  claims terminal rather than retrying an uncertain delivery. Preserved
  Problematic Files selection and scroll after terminal mutation rendering.
  Preserved recreated tracks across a single watcher debounce window and made
  confirmed missing-album removal round-trip slash and percent-bearing keys.
  Preserved replacement tracks when a move follows a destination deletion,
  canceled stale directory deletions when live descendants arrive, and applied
  watcher health to every root involved in cross-root moves. Rejected invitation
  token exchange on non-loopback plaintext HTTP, surfaced failed targeted
  reconciliation as persistent watcher health, and corrected delayed Problematic
  Files navigation so its active album remains visible after the sidebar opens.
- Kept the required hosted AI review gate compatible with its pinned action's
  Chat Completions request contract and the available per-minute token budget.
- Added complete Codex review assignments with bounded parallel batches,
  explicit file-section and image coverage, an integration review, and private
  per-review usage reporting. Incomplete reviews and findings hold test jobs.
- Serialized watcher flush publication so rapid delete-and-recreate events keep
  their observed order, and moved watcher-health reads and synchronous mail
  delivery callbacks off the ASGI event loop.
- Made focused Phase 7 CI select exact FTC cases before expanding to the related
  suite, kept the authoritative cloud gate fail-closed when classification
  fails, and finalized generated pytest temp cleanup after plugin shutdown.
- Preserved album-wide artist associations when a watcher event changes one disc,
  using the same album-container rules as normal scanning for Main Library,
  Hoard, and New Arrivals. Prevented stale health writes from replacing newer
  warnings and coalesced events received during a running watcher flush.
- Isolated mutating functional cases with the existing Postgres and media
  checkpoints, including after a failed case, while keeping read-only cases
  grouped. Separated reset-link replay cookies from the active reset browser.
  Kept the loaded Problematic Files list visible during background refreshes
  so completed repairs preserve sidebar scroll.
- Restored exact local verification followed by full CI as the normal repair
  workflow; retained case and area selectors for difficult CI-only diagnosis.
- Preserved an existing valid password-reset transaction when an unrelated or
  replayed reset link fails, while keeping invalid-link pages and stale-cookie
  cleanup intact.
- Preserved valid invitation transactions when an invitation link is revisited.
- Redirected malformed reset links to a clean invalid page and moved synchronous
  reset-delivery callbacks off the ASGI event loop.
- Initialized private media policy before the first request, handled malformed
  loop references through the existing private identifier path, and rechecked
  reset and invitation expiry after final transaction locks. Kept SMTP
  disconnects during submission as unknown delivery outcomes to prevent retries
  after an unconfirmed acceptance.
- Restored the browser history position when unsaved appearance changes cancel
  Settings navigation.
- Persisted player-color resets through the account preference store and kept
  Solid player previews consistent. Prevented concurrent invitation rotations
  from copying stale links and retained compact-player geometry when Settings
  hides the library. Corrected duplicate-source track totals, preserved pending
  optimistic edits during refresh, and restored the mobile Editorial album layout.
- Preserved every rapid compact-player queue advance while streaming starts,
  and restored the playing position when the latest selection fails.
- Bounded retained watcher paths and moves within directory groups, and checked
  expanded album tracks for stable writes before parsing or publishing a mutation.
- Shared watcher stability sampling intervals across pending files and moves,
  preventing a delay per file during large batches.
- Preserved live tracks when files or directories move away and back within a
  watcher debounce window, regardless of folder publication order. Directory
  enumeration failures now stop mutation publication.
- Applied gallery categories and search constraints to missing albums, preserved
  whole-album missing-state classification, and corrected sidebar artist counts
  when an artist has both active and missing albums.
- Kept Codex and PR Agent as the hosted reviewers, held tests on review findings,
  and added encrypted usage records with private local reporting.

## 0.9.42 - 2026-08-30

- Reworked the repository landing page around what Album Haven offers users
  today.
- Added concise summaries of the project's main goals and longer-term roadmap.
- Kept current capabilities separate from planned features and retained the
  existing installation, policy, and licensing guidance.

## 0.9.41 - 2026-08-29

- Established a sanitized Album Haven application baseline from the reviewed
  `0.9.40` main tree while keeping the repository private.
- Moved internal planning history into a separate private repository and
  removed owner-specific paths, raw cover fixtures, and real-library seed data
  from the application repository.
- Added public installation, contribution, security, and licensing guidance.
- Included the cloud verification work merged through pull request 48 before
  the public cutover.

Earlier development history and release notes remain in the private archive.
No public source release was made.
