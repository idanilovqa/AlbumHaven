# One-command trusted HTTPS startup

From the repository directory, run:

```powershell
python start_https.py
```

Stop any existing Album Haven process using the same port first. Stop this
server with one Ctrl+C. Use HTTPS, not HTTP, on the selected port. The launcher
allows active requests up to five seconds to drain; after that Uvicorn cancels
the remaining request tasks and runs the application's normal shutdown cleanup.
This bound prevents active cover requests or browser connections from leaving
the process waiting indefinitely. Filesystem watcher shutdown cancels queued
targeted reconciliation without joining an active daemon worker. Album Haven's
daemon executors are also excluded from Python's interpreter-exit worker join,
so active background work cannot reintroduce the wait after lifecycle cleanup.
On Windows, the launcher also filters the specific benign Proactor `WinError
10054` emitted
when the browser resets a connection during shutdown; other asyncio errors are
still reported.

This is the single-file version of the direct Uvicorn/mkcert command. It reads
the repository's `.env` through normal configuration, uses `MUSIC_APP_PORT`
(default 5000), and resolves these files under `MUSIC_APP_DATA_DIR`:

- `tls/trusted-server.pem`
- `tls/trusted-server-key.pem`

On Windows the default app-data directory is under Local AppData. The launcher
does not depend on a PowerShell `$certDir` variable, the shell's working
directory, Chocolatey, or mkcert being on PATH. It requires an existing matching
certificate/key pair. It never installs trust, generates/replaces certificates,
or falls back to HTTP. Forwarded headers are disabled for this direct listener;
nonempty `ALBUM_HAVEN_TRUSTED_PROXIES` is rejected before startup.

To check only the files and matching key, without starting the server:

```powershell
python start_https.py --check
```

The check does not prove Windows/browser trust, certificate hostname coverage,
expiry, successful login, or playback. The certificate must cover every address
used in the browser. Use the normal account credentials; each hostname has its
own login cookies.

## First-time certificate setup or missing files

Install mkcert using its [official Windows instructions](https://github.com/FiloSottile/mkcert#windows).
Run `mkcert -install` once to trust its local CA on this machine. Then generate
the pair below, adjusting the directory to your configured `MUSIC_APP_DATA_DIR`
and replacing the example LAN IP with your server's address:

```powershell
$certDir = "$env:LOCALAPPDATA\Album Haven\tls"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
mkcert -cert-file "$certDir\trusted-server.pem" -key-file "$certDir\trusted-server-key.pem" localhost 127.0.0.1 ::1 192.168.1.50
```

Do not regenerate an existing pair unless you intend to replace it. Keep the
private keys private and out of the repository. Other client machines need
their own installation of the public CA certificate to trust this server.

Keep `ALBUM_HAVEN_PUBLIC_BASE_URL` set to the canonical HTTPS LAN URL used by
email links. Include that origin and the intended localhost origins in
`ALBUM_HAVEN_TRUSTED_ORIGINS`, with the same port as the launcher. This setting
controls request security, not certificate trust.

`python app.py` remains the existing launcher: its `MUSIC_APP_TLS_MODE=local`
uses the separately generated self-signed `local-server.pem`. Use
`python start_https.py` when you want the mkcert pair instead.

## Verification record

The reported FileNotFoundError was consistent with `$certDir` being unset in a
new PowerShell session. The actual pair existed in the configured app-data
directory and loaded successfully, with names for localhost, loopback, and the
configured LAN IP. No user key material was modified.

Focused tests cover absolute paths with spaces, missing files, invalid keys,
invalid ports, normal ASGI factory invocation, and check-only startup. An
initial run failed all nine cases because the launcher did not exist. The final
focused command passed 31 tests before review. Review added a regression for
rejecting trusted-proxy configuration before starting this direct listener; it
failed before the guard was implemented. The final run passed all 32 tests:

```text
python -m pytest tests/py/test_start_https.py tests/py/test_server_tls.py -q --tb=short
```

`python C:\Repositories\album-haven-app\start_https.py --check` also passed
against the owner's existing pair from outside the repository. No real server
was started or restarted for this validation. No certificate trust, accounts,
database, or existing certificate files were changed.

Independent review found no remaining actionable issues after the proxy guard.
This handoff changes only `start_https.py`, `tests/py/test_start_https.py`, and
this guide. Existing unrelated working-tree changes remain untouched. Exact
direct-task, process-overhead, and total timing were not recorded.
