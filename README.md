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
