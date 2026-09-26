# Login-protected Render demo

This is an isolated preview, not a release or a merge. Deployment branch
`2026-09-25-render-demo` starts at mobile branch commit
`46bea34a62fa5a82ebfbab0f0ff400953b67999b`. Hosting files do not replace the
application UI, routes, repositories, player, or existing tests.

## Resources and cost boundary

Use `free` for the Python web service and PostgreSQL 17 database, both in Oregon.
The dedicated database is `albumhaven-mobile-demo-db` (logical database
`albumhaven_mobile_demo_db`). Do not attach a real library, paid disk, worker,
external account, or production database. Do not upgrade a plan without owner
approval. Free-tier platform bandwidth/build limits still apply.

## Service configuration

Repository: `https://github.com/idanilovqa/AlbumHaven`
Branch: `2026-09-25-render-demo`
Build: `python -m pip install -r requirements.txt && node scripts/build-runtime-bundle.cjs`
Start: `python scripts/render_demo.py`
Auto-deploy: disabled; deploy explicitly after the verification workflow passes.

Required private environment variables:

- `ALBUM_HAVEN_DEMO_DATABASE_URL`: the dedicated database's Internal Database URL.
- `ALBUM_HAVEN_DEMO_DATABASE_HOST`: that database's exact internal hostname.
- `ALBUM_HAVEN_DEMO_APP_DB_PASSWORD`: a new random password of at least 32 characters.
- `ALBUM_HAVEN_DEMO_PASSWORD_HASH`: an Argon2id hash of a new private demo login password,
  using at least memory cost 65536, time cost 3, parallelism 1, salt length 16, hash length 32.
- `ALBUM_HAVEN_AUTH_HMAC_SECRET`: an independent random secret of at least 32 bytes.

Render supplies `PORT` and `RENDER_EXTERNAL_URL`. The real bootstrap account is
named `Rendref`, as required by this version of the app. This is a newly seeded
demo account, not the owner's existing account or password. Its email is the
non-deliverable `demo@example.test`; outbound mail and configured integration
credentials are disabled. Cover lookup uses the existing offline/manual mode.

Do not paste database URLs, passwords, or hashes into repository files or logs.
The connector does not expose the database connection secret. Copy the internal
URL from the database's Connect menu into the web service's Environment page;
there is no need to open the database's external IP allowlist.

## Startup and data

The launcher rejects unrelated database names and hosts and refuses an existing
schema unless it carries this demo's ownership marker. It applies the unmodified
repository migrations with a checksum ledger and serializes startup with a
Postgres advisory lock. It creates the existing application roles and serves
through the restricted `album_haven_app` role, never the database-owner role.

Before ASGI startup, the launcher reuses only the generated-media seed helpers
used for the mobile screenshots: eight fictional albums with 24 MP3 test-tone
tracks and generated covers. No test control, reset, fake login, or SMTP server
is started. All UI and playback use the production application and database.

The fixed `/tmp/albumhaven-mobile-demo/media` location is regenerated on restart.
Account credentials, appearance, preferences, and listening history stay in the
managed PostgreSQL database; startup does not reset them. Changes to generated
media files are temporary. The free database itself expires after 30 days, so
this is not long-term storage. No production data is copied or migrated.

## Verification and limitations

`Render Demo Verification` runs the launcher with a disposable PostgreSQL 17
database owned by a non-superuser with CREATEROLE, seeds twice, checks inventory
and credential/history retention, verifies restricted DB privileges, then uses
the normal ASGI login and account routes. Local launcher guard tests use unittest.

A successful CI smoke test is not proof that the public Render deployment works.
After the service goes live, verify HTTPS, unauthenticated login redirect,
responsive Home, album search/details, saved preferences, and actual audio.
Physical Android/iOS behavior and full release regression are separate checks.
