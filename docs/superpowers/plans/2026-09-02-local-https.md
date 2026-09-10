# Direct local HTTPS implementation plan

**Goal:** Make the existing launcher serve local HTTPS on its normal port.

**Architecture:** A startup-only certificate module prepares a persistent local
PEM and Uvicorn TLS options. Authentication and application routes remain intact.

**Tech stack:** Python, cryptography, Uvicorn, pytest.

## Scope and authorization

Implement the direct HTTPS design already accepted in this conversation.
Preserve unrelated working-tree changes. No release, merge, or publish is part
of this request. Use sequential focused tests; no parallel pytest processes.

## Task 1: Certificate and launcher integration

- [x] Add `tests/py/test_server_tls.py`: off mode writes nothing; local mode
  creates a matching key and IP/DNS SAN; repeat startup reuses the PEM; expiry
  and host change renew it; corrupt files and mismatched URL/port fail closed;
  a real TLS client validates the generated certificate when explicitly trusted.
- [x] Run `python -m pytest tests/py/test_server_tls.py -q` and record failure.
- [x] Implement `music_app/server_tls.py` with
  `local_https_options(environ, *, data_dir, port) -> dict` and atomic PEM writes.
- [x] Add TLS launcher coverage and integrate options into `app._run_asgi_server`.
  Explicitly set off mode in existing HTTP launcher tests so local `.env` does
  not change their environment. Keep every existing assertion.
- [x] Add cryptography to requirements and run focused certificate, launcher,
  auth configuration, auth route, and password-reset checks sequentially.

## Task 2: Local configuration and verification

- [x] Document local mode in `.env.example`, README, and local auth setup.
  Add the functional acceptance case to the owner test registry.
- [x] Enable local mode in the owner's ignored `.env`; retain the existing
  canonical LAN URL and every unrelated setting.
- [x] Verify real HTTPS against the app without mutating accounts or library
  data. Check owned process cleanup and report what requires device testing.
- [x] Review the diff, record exact checks and limitations, and provide the
  normal startup command and LAN URL. Do not include unrelated files in commits.

## Verification evidence

- Initial certificate tests: 17 expected failures for the missing module.
  Initial launcher tests: two expected failures for absent TLS options.
- Independent review found IPv6 listener mismatch and an encrypted-key password
  prompt risk. Added failing regressions, then fixed IPv6 binding and made
  certificate validation explicitly noninteractive.
- Final focused command passed **323 tests** in 15.99 seconds:

  ```text
  python -m pytest tests/py/test_server_tls.py tests/py/test_app_console_liveness.py tests/py/test_app_factory.py tests/py/test_auth_config.py tests/py/test_auth_asgi.py tests/py/test_auth_session_csrf.py tests/py/test_auth_reset_csrf.py tests/py/test_auth_tokens.py -q --tb=short
  ```

- Production ASGI smoke check on temporary port 5443 verified the LAN hostname
  and generated certificate with an explicitly trusted probe-only SSL context.
  `/login` returned 200 and a Secure login CSRF cookie. A reset link missing its
  token returned 400. No account passwords, library data, or SMTP settings were
  changed and no recovery email was sent.
- An isolated Chromium context accepting this certificate rendered Login and
  passed assertions for `isSecureContext`, `AudioWorkletNode`, and
  `AudioContext.prototype.audioWorklet`. Screenshot: `.tmp/local-https-login.png`.
  This proves API availability, not audible playback or warning handling on all
  browsers. Cross-device login, actual recovery, and playback remain manual.
- The first independent browser probe arrived after the temporary server's
  60-second lifetime. Audit proved server/browser exit and port cleanup. The
  coordinated rerun launched the browser immediately after readiness and passed;
  the server shut down through its ASGI lifespan, the browser closed, and port
  5443 was clear. No application timeout or test contract was changed.
- The existing process on port 5000 was not restarted. The owner should restart
  with `python app.py` to activate the already-enabled local `.env` mode.
- Changes are uncommitted and unrelated working-tree edits remain untouched.
  Exact task/skill-overhead timing was not recorded.
