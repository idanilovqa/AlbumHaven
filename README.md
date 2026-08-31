# Album Haven

Album Haven is a local-first music library for people who think in albums. It
turns a personal music collection into a visual, searchable gallery for
browsing artists, opening track lists, managing library details, and listening
from a web interface.

> [!NOTE]
> Album Haven is under active development. The current application is intended
> for local use and still requires hands-on setup; features listed in the
> roadmap are not yet available unless they also appear in the current-feature
> section below.

Current release: `0.9.42`

## What Album Haven does today

- Scans a local music collection and keeps application data in PostgreSQL.
- Presents albums in a cover-focused gallery organized by artists and related
  artist families.
- Searches and filters the local collection.
- Opens album track lists and plays local music through the web interface.
- Finds, previews, selects, and maintains album cover art.
- Records album ratings and track preferences.
- Provides utilities for reviewing library problems and correcting music tags
  and metadata.

## Main goals

- Make large personal music libraries beautiful, fast, and pleasant to browse.
- Support deeper discovery through discographies, artist relationships,
  metadata, releases, and listening context.
- Keep personal media ownership, raw files, and playback access private and
  permission-controlled.
- Grow toward both self-hosted private-library use and metadata-first hosted
  discovery and sharing without confusing shared information with file access.

## Short roadmap

The detailed roadmap is evolving, but the broad direction is:

1. **Strengthen the foundation:** improve the web experience and search, then
   add accounts, permissions, multi-library support, and clearer boundaries
   between hosted metadata and private media.
2. **Expand discovery and listening:** add richer album and artist pages,
   discography and release discovery, lists, favorites, listening history,
   playlists, and integrations such as MusicBrainz and Last.fm.
3. **Reach more devices:** build a Windows desktop client first, followed by
   mobile, TV, and macOS clients as the shared platform matures.

Priorities may change as the application develops. Roadmap items describe
direction rather than promised release dates.

## Requirements

- Python 3.11 or newer
- PostgreSQL
- Node.js 22 when building or testing the browser runtime
- FFmpeg for media-oriented test and playback features

## Install

```text
python -m pip install -r requirements.txt
npm ci
```

Copy `.env.example` to `.env`, then set at least:

```text
MUSIC_DIR=/path/to/your/music
ALBUM_HAVEN_APP_DATABASE_URL=postgresql://album_haven_app@localhost:5432/album_haven_core
```

Use `ALBUM_HAVEN_DATABASE_URL` with the migration role when applying database
migrations. Keep credentials outside the repository.

### Provision the initial owner

After applying the database migrations and setting the Phase 7 authentication
values shown in `.env.example`, run this once from an interactive terminal:

```text
python scripts/bootstrap_auth_owner.py
```

The command reads Rendref's password twice through the terminal's protected
password prompt. It does not accept command-line arguments, redirected input,
or a password environment variable. Password policy screening uses the free
[Pwned Passwords range API](https://haveibeenpwned.com/API/v3): only the first
five characters of a SHA-1 digest are sent over HTTPS, padded responses are
requested, and provisioning stops if a trustworthy screening result is
unavailable. The accepted password is then hashed with the configured Argon2id
policy before the short database transaction begins.

Rerunning the command reconciles the retained account and library but never
replaces an existing credential. If a credential already exists, the command
states that the supplied password was not installed and exits with status `3`.
This provisioning command is not a password reset or emergency recovery
mechanism.

When `ALBUM_HAVEN_WELCOME_EMAIL_ENABLED=true`, provisioning also commits one
password-free welcome message to the Postgres mail outbox. Only after the owner
transaction commits does the command make one bounded SMTP delivery attempt.
The account remains ready if the provider is unavailable; retryable failures
stay durably in the outbox for a later worker attempt. Configure a real TLS or
STARTTLS SMTP provider with the `ALBUM_HAVEN_SMTP_*` values in `.env.example`
to deliver to real email addresses. SMTP credentials are optional only for
providers that do not require authentication.

### Clean up retained security audit events

Security audit events are retained for at least 90 days. Set
`ALBUM_HAVEN_MIGRATOR_DATABASE_URL` to the migration-role connection and run
one bounded cleanup batch with:

```text
python scripts/cleanup_auth_audit.py --batch-size 1000
```

Schedule this command daily or weekly through the host scheduler. Each run
deletes only the oldest eligible batch, so large backlogs require repeated
invocations and normal runs never hold an unbounded delete transaction. The
command deliberately does not use `ALBUM_HAVEN_APP_DATABASE_URL`: the runtime
role retains insert-only access to the append-only audit table, while the
maintenance command uses existing migrator privileges. Output contains only
the deleted-row count; connection details and event contents are never shown.

Expired authentication throttle buckets also need bounded maintenance. Schedule
the following command daily or weekly with the runtime application connection
available through `ALBUM_HAVEN_APP_DATABASE_URL`:

```text
python scripts/cleanup_auth_throttles.py --batch-size 1000
```

The command deletes only buckets whose failure window and any cooldown have
both expired. Active rows are locked or skipped, each transaction is capped at
10,000 rows, and output contains only the deleted-row count.

## Run

```text
python app.py
```

The application listens on the local address configured by the runtime. Album
Haven does not upload your local music library by default.

## Tests

```text
npm run test:js:all
python -m pytest
```

Browser and performance suites have additional database, Chrome, and fixture
requirements. Raw approved cover fixtures live in a separate private test-data
repository. Opt-in local tests resolve them only when
`ALBUM_HAVEN_TEST_DATA_ROOT` points to that repository's source checkout.

## Project policies

- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

Album Haven is licensed under the [ISC License](LICENSE).

Copyright (c) 2026 Ilia Danilov
