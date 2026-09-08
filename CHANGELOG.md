# Changelog

## 0.9.43 - 2026-09-07

- Added local authentication and account administration, including secure owner
  bootstrap, sessions, password recovery, invitations, audit records, and
  policy enforcement for private routes and media.
- Expanded the shared application UI with account navigation, appearance
  controls, compact and expanded player layouts, reusable buttons, album
  details, track tables, alerts, and search and navigation refinements.
- Added targeted library filesystem watching, reconciliation, health reporting,
  and transactional missing-album removal backed by Postgres.
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
- Serialized watcher flush publication so rapid delete-and-recreate events keep
  their observed order, and moved watcher-health reads and synchronous mail
  delivery callbacks off the ASGI event loop.
- Made focused Phase 7 CI select exact FTC cases before expanding to the related
  suite, kept the authoritative cloud gate fail-closed when classification
  fails, and finalized generated pytest temp cleanup after plugin shutdown.

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
