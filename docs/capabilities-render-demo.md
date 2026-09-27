# Separate capabilities demo on Render

Deployment branch: `2026-09-25-capabilities-audit`.

Use a **new** free Python service named `albumhaven-capabilities-demo` (or another
`albumhaven-capabilities-*` name). Do not modify the existing `AlbumHaven`
service at `albumhaven.onrender.com`, its mobile branch, database or environment.

## Current deployment status

The Render database-create request was rejected because this workspace already
has its one active free database, dedicated to the mobile demo. The separate
web-service creation call was then blocked by the chat platform before Render
returned a new service. A final service listing still contained only the
existing mobile service. **This capabilities demo is not hosted yet.**

No new database was provisioned at Neon or Render, no live users were created,
and no existing service/database was changed. The scripts below prepare the
fake users on first startup; they do not constitute verified hosted execution.

## One-time setup

1. Create a **new Neon project** on its Free plan, preferably AWS Ohio
   (`us-east-2`), PostgreSQL 17. Keep the default database `neondb`. Do not reuse
   the mobile database or another application's project. A normal signed-in
   Free project avoids the 72-hour expiration of an unclaimed temporary project.
2. In Neon, choose Connect, turn **Connection pooling off**, and copy the
   **direct** database URL with `sslmode=require` (or `verify-full`). Use its
   database-owner login for the initial setup. The launcher creates a separate
   restricted `album_haven_app` login for the serving process. Never paste the
   database password into GitHub or an application page.
3. In Render, choose New -> Web Service -> `idanilovqa/AlbumHaven` and use:

   | Field | Value |
   | --- | --- |
   | Name | `albumhaven-capabilities-demo` |
   | Branch | `2026-09-25-capabilities-audit` |
   | Language | Python 3 |
   | Region | Ohio, matching the new database |
   | Compute plan | Free |
   | Root directory | Empty / repository root |
   | Build command | `python -m pip install -r requirements.txt && node scripts/build-runtime-bundle.cjs && python scripts/capabilities_demo_database.py` |
   | Start command | `python scripts/render_capabilities_demo.py` |
   | Health check | `/health` |
   | Auto-deploy | Off during initial acceptance |

4. Import the privately supplied `albumhaven-capabilities-demo.env` through
   **Environment -> Add from .env**. Fill in only these two missing values:

   - `ALBUM_HAVEN_CAPS_DATABASE_URL`: the full direct Neon connection URL.
   - `ALBUM_HAVEN_CAPS_DATABASE_HOST`: only the host from that same URL, such as
     `ep-your-project.us-east-2.aws.neon.tech` (no scheme, password, path or port).

   Other values in that file are separately generated demo secrets and password
   hashes. Do not attach existing environment groups or copy the mobile app's
   settings. Keep the file out of version control. Create/deploy the new service.

The expected address is `https://albumhaven-capabilities-demo.onrender.com` if
Render assigns that exact name. Use the actual URL returned by Render; this is
not a claim that the address is currently live.

## Fake users and permission testing

| Username | Initial access |
| --- | --- |
| `demo.admin` | Admin only; manages users without Owner's library rights |
| `demo.owner` | Owner only; no account administration |
| `demo.adminowner` | Admin plus Owner |
| `demo.viewer` | Viewer |
| `demo.listener` | Listener |
| `demo.musician` | Musician |
| `demo.practice` | Viewer plus Practice, no loop creation |
| `demo.custom` | Only the fine-grained `library.browse.read` grant |
| `demo.disabled` | Disabled Listener; cannot sign in |
| `demo.nocapabilities` | Active account with no grants; own account only |
| `Rendref` | Isolated demo recovery identity, using the app's fixed bootstrap name; not the real account |

Passwords are provided privately in a separate login file, not committed here.
To test micro-capabilities, sign in as `demo.admin`, open **Admin Panel -> Users
& access -> demo.custom -> Edit**, change individual permissions, and save.
Reopen Edit to check persistence, then sign in as `demo.custom` in a separate
browser profile/private window and reload the application to inspect its access.

Named roles combine. A capability inherited from a role is checked and disabled
until its granting role is removed. Existing explicit permissions survive role
changes unless the administrator chooses **Use selected roles only**. Admin and
Owner remain independent. Mobile/TV capability ceilings continue to apply.

## Data, security and limitations

The launcher seeds eleven real credentialed fake accounts and eight synthetic
albums, sixteen generated quiet-tone tracks and generated covers. Main Library,
Hoard and New Arrivals use separate temporary roots. The unchanged production
ASGI app, policy evaluator, Postgres repositories, authentication and Admin UI
serve the preview. There is no E2E control server or authentication bypass.

Database host/name, TLS, service origin, pre-existing schemas, reserved database
roles and a dedicated ownership marker are validated before setup writes. The
runtime uses a restricted Postgres login. Setup secrets are removed from the
serving process environment. The scripts do not connect to real music or real
integration accounts; outbound email/provider credentials are disabled.

The seed is initialized once and never restores revoked roles or changed
passwords on ordinary restarts. Original generated media is recreated when
Render replaces its ephemeral filesystem. Uploaded covers, file edits and
newly generated loop files do not persist through filesystem replacement.
Database-backed roles, accounts and preferences persist while the Neon project
is retained. Free Render instances sleep after inactivity and share the
workspace's monthly instance-hour and bandwidth/build allowances. No paid
resources or upgrades are authorized by this setup.

## Verification

`python -m pytest tests/py/test_render_capabilities_demo.py -q`: **29 passed**.
Python syntax compilation passed for the two deployment modules. These are
unit checks for connection validation, service/database isolation, environment
configuration and the seed manifest, not live SQL, login or browser evidence.

Required after deployment: verify `/health`, all intended logins, disabled-user
rejection, Admin-only vs Owner-only access, `demo.custom` permission save/reload,
and normal application rendering. The full branch regression/CI and owner
acceptance remain separate unfinished gates. Exact task timings were not recorded.
