# Album Haven

Album Haven is a local-first music library application for browsing albums and
artists, managing local music, and exploring a collection through a FastAPI web
interface.

Current release: `0.9.41`

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
