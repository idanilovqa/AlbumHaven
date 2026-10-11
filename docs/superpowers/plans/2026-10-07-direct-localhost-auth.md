# Direct localhost authentication repair

## Outcome and scope

Restore direct HTTP loopback sign-in when the same loopback address is also a
configured trusted reverse proxy. Owner approved this repair on October 7, 2026.
No new screen, permission grant, remote folder-launch exception, or database
change is included. Existing localhost Open folder eligibility remains separate.

## Cause and implementation boundary

The authentication transport check currently classifies trusted-proxy peers
before checking for direct loopback requests. Direct localhost has no forwarded
HTTPS header and therefore receives HTTP 400. The same-origin and request-source
checks also classify the direct connection as proxy traffic.

Use one direct-loopback predicate: HTTP transport, loopback peer and hostname,
and no Forwarded or X-Forwarded-* headers (including empty values). Apply it to
transport, exact same-origin validation, and request-source classification.
Keep Secure/HttpOnly cookie behavior and public/proxy HTTPS requirements intact.

## Acceptance and delivery checklist

- [x] Reproduce direct localhost login rejection with trusted loopback proxy configured.
- [x] Prove successful direct login GET/POST, secure cookies, and loopback source classification.
- [x] Prove forwarded/downgraded/public HTTP cannot use the loopback exception.
- [x] Prove cross-origin login remains rejected.
- [x] Run focused authentication regressions sequentially in the shared test slot.
- [x] Complete two reviews of the full relevant diff and fix validated findings.
- [x] Activate only after the running scan is terminal or the owner explicitly authorizes cancellation/restart.
- [x] Verify live localhost login-page availability and public HTTPS authentication boundary after activation.
- [ ] Owner verifies authenticated localhost sign-in and folder action in their browser session.

Compatibility: no schema or configuration migration; ordinary trusted HTTPS
proxy behavior remains unchanged. Rollback is a source revert and controlled
restart, never interruption of active library work. This is one focused repair
delivery; broader branch CI, manual acceptance, merge, and release gates remain
open. No publication is implied by the repair.

## Verification evidence

Initial 18-case selection: three direct-loopback variants failed with 400 instead
of 200; the other 15 denial cases passed. After the fix, `test_auth_asgi.py`,
`test_auth_reset_csrf.py`, `test_auth_invitation_csrf.py`, and
`test_auth_session_csrf.py` passed 136 tests in 7.05 seconds, exit 0. Pytest emitted
one configuration warning for `cache_dir` because cacheprovider was explicitly
disabled. Two independent complete reviews found no actionable findings.

Owner authorized safe scan cancellation and restart. UI cancellation returned
500 because the scan publication transaction blocked authentication account-row
locks and exhausted the connection pool. The exact scan backend (45176, client
port 63642, mapped to sandbox3 server PID 29064) was verified before cancelling
its active local-track-file insert with `pg_cancel_backend`. Its transaction
rolled back; the backend disappeared, blocked sessions cleared, and the worker
logged `Library indexing failed` with `canceling statement due to user request`
at 00:34:34 Denver time. The UI showed No Active Scan Running. This is a cancelled
attempt recorded as an error, not a completed scan.

After verifying old server/launcher exit and port 5003 clearance, sandbox3
restarted at 00:35:36 Denver time with launcher 23540/server 10152 and unchanged
scan-enabled arguments. Existing 159,545-file hydration succeeded. Local HTTP
and public HTTPS login returned 200; unauthenticated bootstrap returned 401 on
both. Chrome displayed the real localhost sign-in form; user credentials were
not entered, so authenticated browser-cookie acceptance remains owner verification.
Sandbox4 PID 37736 remained untouched. No new scan was submitted.
