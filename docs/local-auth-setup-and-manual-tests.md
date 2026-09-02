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
ALBUM_HAVEN_INVITATION_EMAIL_ENABLED=false
ALBUM_HAVEN_INVITATION_TOKEN_SECONDS=259200
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
must contain 8 to 256 Unicode code points, must not contain the username or
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

## Configure SMTP

Album Haven works with a transactional email provider that exposes SMTP. Obtain
an SMTP host, port, security mode, username, password, and verified sender from
the provider. Use a provider-generated SMTP credential instead of your account
password.

For STARTTLS on port 587, add these values to `.env`:

```text
ALBUM_HAVEN_PUBLIC_BASE_URL=https://music.example.com
ALBUM_HAVEN_INVITATION_EMAIL_ENABLED=true
ALBUM_HAVEN_PASSWORD_RESET_EMAIL_ENABLED=true
ALBUM_HAVEN_SMTP_HOST=smtp.provider.example
ALBUM_HAVEN_SMTP_PORT=587
ALBUM_HAVEN_SMTP_SECURITY=starttls
ALBUM_HAVEN_SMTP_FROM_ADDRESS=album-haven@music.example.com
ALBUM_HAVEN_SMTP_FROM_NAME=Album Haven
ALBUM_HAVEN_SMTP_USERNAME=YOUR_PROVIDER_SMTP_USERNAME
ALBUM_HAVEN_SMTP_PASSWORD=YOUR_PROVIDER_SMTP_PASSWORD
```

Use `ALBUM_HAVEN_SMTP_SECURITY=tls` for a provider's implicit-TLS port, such as
465. Production delivery rejects plaintext SMTP. Plaintext works only with an
explicit loopback test server and
`ALBUM_HAVEN_SMTP_ALLOW_PLAINTEXT_LOOPBACK=true`.

Verify the sender address or domain with the provider before testing. Restart
Album Haven after changing `.env`, create a pending test user with **Send
invitation email** selected, and confirm the message arrives. Check the spam
folder and the provider's delivery log if it does not. Keep SMTP credentials
out of Git, terminal transcripts, screenshots, and support bundles.

## Create managed users

Sign in as `Rendref`, open **Settings**, then **Users & access**, and choose
**Add user**. Supply:

- A unique username.
- A unique contact email.
- A role preset and any explicitly required capabilities.

The new account appears as **Pending invitation** and has no credential. Use the
row's three-dot menu to copy an invitation link or send it through configured
SMTP. Each copy or send rotates the prior link. The current link expires after
72 hours, works once, and lets the recipient choose a password that Album Haven
never shows to the administrator.

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

1. As Rendref, create a listener with a unique username and email.
2. Confirm the roster shows **Pending invitation** and no password-reset action.
3. Copy the invitation link twice. Confirm the first link shows the same generic
   invalid-or-expired result used for expired, consumed, revoked, disabled, and
   malformed invitations.
4. Open the second link in another private window, choose a compliant password,
   and sign in as the listener.
5. Confirm the second link now shows the generic invalid-or-expired result.
6. Confirm permitted library browsing works, `/admin/members` returns a denial,
   and the listener cannot invoke account-management controls.

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

### 6. Invitation delivery

1. Configure SMTP as described above and set
   `ALBUM_HAVEN_INVITATION_EMAIL_ENABLED=true`.
2. Create a unique listener with **Send invitation email** selected.
3. Confirm the captured or delivered message contains an invitation URL and no
   password.
4. Open the link in a private window, choose a password, and sign in.
5. Resend an invitation for another pending test account. Confirm the older link
   fails with the generic invalid-or-expired result and the new link works once.

### 7. Break-glass owner recovery

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

### 8. Responsive pages

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

The E2E launcher forces invitation mail to its loopback capture server and
ignores inherited SMTP credentials. Running either suite cannot send mail to a
real address. The admin-management suite remains a separate command and GitHub
job from the auth-lifecycle suite.
