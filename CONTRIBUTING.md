# Contributing

Album Haven is not accepting external contributions or pull requests at this
time. The source code is available under the ISC License, but the contribution
policy may change independently in the future.

Do not use a pull request to report a vulnerability. Follow `SECURITY.md`.

## Local checks

The public JavaScript and Python checks run without raw private cover artwork:

```text
npm run test:js:all
python -m pytest
```

Some opt-in browser and performance suites require PostgreSQL, Chrome, FFmpeg,
and fixture archives prepared by project maintainers. Source-checkout tests that
need approved raw covers require `ALBUM_HAVEN_TEST_DATA_ROOT`; ordinary unit-test
discovery does not require that private repository.

Maintainer pull requests into `main` must pass the repository's required CI
gate before merge.
