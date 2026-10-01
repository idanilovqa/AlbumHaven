# Separate capabilities demo on Render

Deployment branch: `2026-09-25-capabilities-audit`.

Use the existing free Python service named `albumhaven-capabilities-demo`.
Do not modify the separate `AlbumHaven`
service at `albumhaven.onrender.com`, its mobile branch, database or environment.

## Current deployment status

The capabilities demo exists at
[albumhaven-capabilities-demo.onrender.com](https://albumhaven-capabilities-demo.onrender.com).
Render service `srv-das9rmfpn0mc73ffr6s0` follows this branch with automatic
deployment on commit. Its separate Neon database holds the fake accounts.
The service currently runs in Oregon. Reuse this service and its environment;
do not provision another database or recreate its users for a code update.
Deployment status alone does not prove the authenticated application flows.

## One-time setup for a replacement demo

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

For a replacement service, use the actual URL returned by Render.

## Fake users and permission testing

| Username | Initial access |
| --- | --- |
| `demo.admin` | Admin role: manages users and can view the library; no Owner role |
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
To test capabilities, sign in as `demo.admin`, open **Admin Panel -> Users
& access -> demo.custom -> Edit**, change Capabilities, and save. Save remains
on the same user and shows confirmation. Reopen Edit to check persistence, then
sign in as `demo.custom` in a separate
browser profile/private window and reload the application to inspect its access.

Named roles combine. Every library capability includes View; Edit and Delete
also include Play. Required switches are checked and disabled with an
explanation. Removing a capability releases its prerequisites unless another
choice still requires them or they were explicitly selected. Admin itself
does not imply View, though the Admin role includes it. Admin and Owner remain
independent. Web tag editing requires both Edit and Admin. Mobile/TV ceilings
continue to apply.

The form retains old fine-grained grants without exposing a second permission
editor. It discloses these grants because they can still authorize an action
whose coarse switch is off. **Use selected roles only** clears editable
explicit grants. Removing library access revokes all grants in that library.

Repair includes Rules and Logs. Delete currently covers custom covers and
missing inventory; it does not delete live music files. Open folder works only
for a directly connected same-machine desktop. Opening a client's mapped share
from a remote web server still needs a client bridge and path mapping.

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
