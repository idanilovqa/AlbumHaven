# Changelog

## 0.9.43 - 2026-09-05

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
