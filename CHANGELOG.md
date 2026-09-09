# Changelog

## 0.9.43 - 2026-09-09

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
