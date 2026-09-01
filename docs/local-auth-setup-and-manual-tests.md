# Local authentication setup and testing

This guide covers the Phase 7 private-web authentication flow on a local Album
Haven installation. It assumes PostgreSQL already contains the Album Haven
database, the `album_haven_migrator` and `album_haven_app` roles exist, and the
repository migrations can be applied with the migrator connection.

## Install and configure

Install the Python and browser-runtime dependencies from the repository root:

```powershell
python -m pip install -r requirements.txt
npm ci
Copy-Item .env.example .env
```

Set these values in `.env` for a loopback-only local server:

```text
MUSIC_DIR=C:\path\to\your\music
ALBUM_HAVEN_APP_DATABASE_URL=postgresql://album_haven_app:YOUR_APP_DB_PASSWORD@localhost:5432/album_haven_core
ALBUM_HAVEN_MIGRATOR_DATABASE_URL=postgresql://album_haven_migrator:YOUR_MIGRATOR_DB_PASSWORD@localhost:5432/album_haven_core
ALBUM_HAVEN_BOOTSTRAP_USERNAME=Rendref
ALBUM_HAVEN_BOOTSTRAP_EMAIL=your-real-or-local-test-address@example.com
ALBUM_HAVEN_PUBLIC_BASE_URL=http://127.0.0.1:5000
ALBUM_HAVEN_AUTH_HMAC_SECRET=YOUR_PRIVATE_RANDOM_VALUE_OF_AT_LEAST_32_BYTES
ALBUM_HAVEN_AUTH_HMAC_KEY_VERSION=1
ALBUM_HAVEN_WELCOME_EMAIL_ENABLED=false
ALBUM_HAVEN_PASSWORD_RESET_EMAIL_ENABLED=false
```

Generate the HMAC secret with a local password manager or a cryptographically
secure random generator. Keep it stable between server restarts and outside
Git. Changing it invalidates derived security state.

Apply every SQL migration in filename order with the migrator connection. Set
`PGPASSFILE` to a protected libpq password file, then put the password-free
migrator URL in the current shell. This keeps the password out of command and
PowerShell history:

```powershell
$env:PGPASSFILE = 'C:\secure\album-haven-pgpass.conf'
$env:ALBUM_HAVEN_MIGRATOR_DATABASE_URL = 'postgresql://album_haven_migrator@localhost:5432/album_haven_core'
Get-ChildItem migrations\postgres\*.sql |
  Sort-Object Name |
  ForEach-Object { psql -X -v ON_ERROR_STOP=1 $env:ALBUM_HAVEN_MIGRATOR_DATABASE_URL -f $_.FullName }
```

The migrations are idempotent, but you should still back up a database that
contains data you care about before upgrading it.

## Create the owner credential

Run the bootstrap once in an interactive terminal:

```powershell
python scripts/bootstrap_auth_owner.py
```

Your owner username is `Rendref`. Album Haven does not define, store, or print a
default password. The password is the value you enter twice at this prompt. It
must contain 15 to 256 Unicode code points, must not contain the username or
email context, and must pass Pwned Passwords screening. Store it in your
password manager.

If the credential already exists, bootstrap preserves it and exits with code
`3`. Use the normal Profile password-change page or email recovery. When both
are unavailable, run the local emergency command:

```powershell
python scripts/break_glass_auth_owner.py
```

Break-glass recovery replaces Rendref's credential and revokes every active
Rendref session and password-reset token. Run it only from the machine or
operator environment that has the application database credential.

## Start the site

Start the ASGI server from the repository root:

```powershell
$env:MUSIC_APP_PORT = '5000'
python app.py
```

Open `http://127.0.0.1:5000/login`. Keep that host spelling consistent during
the session. Switching between `127.0.0.1` and `localhost` changes the browser
origin and cookie scope.

For access from another device, put Album Haven behind an HTTPS reverse proxy,
set `ALBUM_HAVEN_PUBLIC_BASE_URL` to its exact external origin, and list any
additional exact HTTPS origins in `ALBUM_HAVEN_TRUSTED_ORIGINS`. Do not expose
the development HTTP listener directly to the internet.

## Create managed users

Sign in as `Rendref`, open **Settings**, then **Users & access**, and choose
**Add user**. Supply:

- A unique username.
- A unique contact email.
- A temporary password that meets the same password policy.
- A role preset and any explicitly required capabilities.

The account becomes active as soon as creation succeeds. The welcome email
contains no password. Give the temporary password to the user through a
separate trusted channel and have the user replace it from Profile after the
first login.

For local testing, use unique data such as
`phase7_listener_20260831_01` and `phase7_listener_20260831_01@example.test`.
The `.test` address cannot receive real mail. Use a real address only after you
configure TLS or STARTTLS SMTP and enable the relevant mail flags.

## Manual acceptance cases

Use a private browser window for each identity so sessions do not overlap.

### 1. Owner sign-in and private-route boundary

1. Open `/` while signed out.
2. Confirm the server returns an authentication-required response.
3. Open `/login` and sign in as `Rendref` with the bootstrap password.
4. Confirm the gallery loads and the Settings entry is available.
5. Try the wrong password in a fresh private window and confirm the response
   does not reveal whether the username or password was wrong.

### 2. Logout and password change

1. Sign in as Rendref and log out.
2. Confirm the private page no longer opens in that window.
3. Sign in again, open Profile, and change the password.
4. Confirm the old password fails and the new password succeeds.
5. Confirm other Rendref browser sessions were revoked by the change.

### 3. Managed-user creation and authorization

1. As Rendref, create a listener with unique username, email, and password.
2. Sign in as that listener in another private window.
3. Confirm permitted library browsing works.
4. Open `/admin/members` directly and confirm access is denied.
5. Confirm the listener cannot see or invoke account-management controls.

### 4. Administrator account lifecycle

1. As Rendref, edit the listener and change its allowed capabilities.
2. Confirm the listener gains only the selected actions after a new request.
3. Revoke the listener's sessions and confirm its active window loses access.
4. Disable the listener with the required confirmation.
5. Confirm sign-in fails while disabled.
6. Re-enable it and confirm re-enabling does not create a session; the user
   must sign in again.

### 5. Email recovery

1. Configure an SMTP provider with TLS or STARTTLS and set
   `ALBUM_HAVEN_PASSWORD_RESET_EMAIL_ENABLED=true`.
2. Submit Forgot password with an existing account and with a nonexistent
   account. Confirm both browser responses look the same.
3. Follow the real account's email link and complete the reset.
4. Confirm the link cannot be reused and every earlier session is revoked.
5. Confirm no password, token, or reset link appears in application logs.

### 6. Break-glass owner recovery

Perform this case last because it invalidates all Rendref sessions.

1. Sign in as Rendref in two private browser windows.
2. Stop the server and run `python scripts/break_glass_auth_owner.py` from an
   interactive terminal.
3. Enter and confirm a new compliant password.
4. Restart the server.
5. Confirm both earlier windows have lost access.
6. Confirm the old password fails and the new password succeeds.
7. Inspect the protected security audit and confirm one successful credential
   event with reason `break_glass_reset`, without password or token material.

### 7. Responsive pages

1. Check Login, Forgot password, Profile, Users & access, Add user, and Edit
   user at a desktop width.
2. Repeat at approximately 390 CSS pixels wide.
3. Confirm forms, navigation, errors, and destructive confirmations remain
   visible and keyboard accessible without horizontal page scrolling.

## Automated Phase 7 suites

Run the two production-path suites separately. Each provisions isolated test
data and starts the production ASGI application:

```powershell
npm run test:e2e:phase7:auth
npm run test:e2e:phase7:admin
```

The pull-request workflow runs these commands in separate Windows jobs so each
suite receives a fresh runner and independent process tree.
