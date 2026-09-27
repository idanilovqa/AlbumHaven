# Isolated capabilities demo on Render

This preview deploys `2026-09-25-capabilities-audit`, not the mobile layout branch.
Use a NEW free Python web service named `albumhaven-capabilities-demo` (or a unique
`albumhaven-capabilities-*` suffix). Never modify the AlbumHaven mobile service,
its branch, URL, database or environment.

Render allows one active free PostgreSQL instance per workspace. When that slot
belongs to the mobile demo, this preview uses a NEW claimable Neon database,
not a schema inside the mobile database. Unclaimed Neon databases expire after
72 hours; claim the returned private link into a free Neon account to retain it.
The provider currently limits unclaimed storage to 100 MB and transfer to 1 GB.

Build: `python -m pip install -r requirements.txt && node scripts/build-runtime-bundle.cjs && python scripts/capabilities_demo_database.py`

Start: `python scripts/render_capabilities_demo.py`

Required secret environment settings:

- `ALBUM_HAVEN_AUTH_HMAC_SECRET`: independent random value of at least 32 bytes.
- `ALBUM_HAVEN_CAPS_APP_DB_PASSWORD`: independent random value of at least 32 characters.
- `ALBUM_HAVEN_CAPS_PASSWORD_HASHES`: JSON mapping each listed username to its own Argon2id hash (memory 65536, time 3, parallelism 1 or stronger).
- Initial provisioning only: `ALBUM_HAVEN_CAPS_CREATE_CLAIMABLE=1` and a fresh Fernet `ALBUM_HAVEN_CAPS_BOOTSTRAP_KEY`. The build writes an encrypted deployment-configuration receipt and emits the encrypted receipt, never the database URL or claim token in plaintext. Preserve the key in the private operator context; decode the receipt there.
- After provisioning, set `ALBUM_HAVEN_CAPS_DATABASE_URL` and `ALBUM_HAVEN_CAPS_DATABASE_HOST` to that new database's verified TLS URL and host. This avoids provisioning a replacement on later builds. Turn `ALBUM_HAVEN_CAPS_CREATE_CLAIMABLE` off. Do not commit any connection string, private claim link, plaintext password or hash map.
- `PYTHON_VERSION=3.12.10` and `PYTHONUNBUFFERED=1` are suitable runtime settings.

Fake users: `demo.admin` (Admin only), `demo.owner` (Owner only),
`demo.adminowner` (both), `demo.viewer`, `demo.listener`, `demo.musician`,
`demo.practice` (View plus Practice), `demo.custom` (only fine-grained library
browse), `demo.disabled` (disabled Listener), and `demo.nocapabilities` (active
with no grants). The isolated protected recovery account retains the app's fixed
`Rendref` bootstrap name; it is NOT a connection to the real account or library.
Passwords are provided privately, never published in this repository.

Sign in as `demo.admin`, open Admin Panel / Users & access, and edit `demo.custom`
to test individual permissions without role-inherited grants. Existing users'
changes are not reset on redeploy/restart. Selected roles combine; a role's
inherited switch is disabled until the granting role is removed. Use selected
roles only deliberately clears editable explicit additions.

The launcher applies unchanged repository migrations, uses the normal database
inventory adapter, seeds eleven real credentialed accounts and eight synthetic
albums with sixteen generated quiet-tone tracks, then starts the production
ASGI app. No E2E control server or authentication bypass is exposed. The app
serves with a restricted PostgreSQL role; setup credentials are removed from its
process environment. Real provider credentials and outgoing email are disabled.

Render free web services sleep after inactivity and have ephemeral filesystems.
Database-backed assignments persist while the external database is retained.
Media edits/uploads/generated loops do NOT survive filesystem replacement;
original synthetic media is regenerated. Shared free web-service hour and
bandwidth limits still apply. Do not treat this as production or attach real
music, integration accounts or personal data.

Verification status: deployment preparation only until the actual Render build,
login, assignment-save/readback and denial checks are recorded. No full-suite
or browser acceptance claim is implied by adding these scripts.
