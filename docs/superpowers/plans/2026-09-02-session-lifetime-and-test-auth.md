# Ninety-day sessions and reusable E2E authentication

**Owner-approved scope (updated 2026-09-03):** Set application sessions to a 90-day absolute lifetime and a 30-day idle timeout, and log in once per runner for tests that do not exercise login or another identity. The owner approved reusing authentic browser state in response to the proposed design.

**Design:** Idle defaults and maximums become 30 days; absolute defaults and maximums become 90 days. Session and session-CSRF cookies persist for the issued absolute lifetime. Revocation and shorter explicit configuration remain effective. Existing sessions retain their stored absolute expiry; signing in again applies the new policy. Activity renews the idle deadline, clamped to the issued absolute deadline. No UI mockup is needed because this changes session policy and test prerequisites only.

Compatibility: when a deployment configures only a shorter absolute lifetime,
cap the implicit idle default to that lifetime. Explicit idle values longer than
the absolute lifetime still fail validation. This preserves previously valid
single-override configurations without extending their configured absolute limit.

**Resolved approval-review checkpoint:** The initial 90-day idle proposal was
rejected because idle-timeout authorization was ambiguous. On September 3 the
owner explicitly chose a 90-day lifetime and initially 14 days idle, then corrected
the idle choice to 30 days. The final authorized policy is therefore 30 days idle
and 90 days absolute. The saved draft tests have been adapted into the active
test suite and the obsolete 90/90 patch file has been removed.
The initial draft's red run reported five expected failures and 258 passes.

Authenticate through the production login form once per Playwright worker (the runner configurations currently use one worker), capture the genuine session and CSRF cookies in memory, and initialize fresh contexts with that state. Include readiness probes, browser warmup, and additional fresh contexts. Never persist credentials into test-data repositories or artifacts. Authentication and alternate-user suites opt out and retain their current flows. Test-owned data isolation remains required. This is the owner-approved exception for genuine authentication-state restoration under the E2E browser-state rule; no other browser mutation or product bypass is authorized.

**Verification:** Add focused coverage for 90-day configuration, expiry boundaries and persistent cookie attributes; verify login is performed once, state is reused in independent contexts, failures are surfaced, and opt-out suites retain clean sessions. Run Python and JavaScript checks sequentially, the production-parity gate, and a bounded real-app check if the environment supports it. Do not change functional assertions or performance budgets.

## Implementation

- [x] Update session configuration, issuance defaults, and login-cookie persistence.
- [x] Replace repeated ordinary-test login with reusable runner authentication, including auxiliary contexts.
- [x] Verify harness regression coverage and inspect the harness diff.
- [x] Document the test contract and the approved session-policy decision.

No migration checklist item is advanced by this owner-requested maintenance task. Existing issued database sessions are not rewritten.

Harness verification: 176 focused JavaScript checks passed, and the E2E
production-parity gate passed. The ordinary two-scenario browser run stopped
before tests during provider-storage fixture setup: it could not resolve exactly
one expected local album. The existing Phase 7 auth scenarios passed 6/6; the
generic wrapper then reported a final-result mismatch because that dedicated
config does not install its final-result reporter. This is retained as an
invocation/reporting limitation, not a clean wrapper pass. Its owned processes
and ports were clear. A separate ordinary-fixture reuse smoke passed 2/2 against
the production app and isolated Postgres in 19.0 seconds, with exactly one
production-form login marker and a successful wrapper exit. The two independent
browser contexts each reached `/account` with HTTP 200 and visible signed-in
account UI. The first temporary smoke discovery failed because its directory
lacked the ES-module declaration used by `tests/e2e/package.json`; adding that
declaration to the temporary diagnostic directory corrected discovery without
changing production code or established tests.

Evidence: `test-results/auth-reuse-smoke-20260902/corrected-stdout.log` and
`corrected-stderr.log`; ordinary fixture prerequisite failure in
`test-results/auth-reuse-20260902/stderr.log`; auth opt-out evidence in
`test-results/auth-optout-20260902`. No full regression or performance suite was
run. No functional-case status changed; Users And Permissions remains 10/13.
This continuation implements only the approved session policy. Existing unrelated
appearance changes remain outside this task. No release or publish is requested.

September 3 completion: final focused verification passed 367 tests in 7.55
seconds across `test_auth_config.py`, `test_auth_asgi.py`,
`test_auth_sessions_postgres.py`, `test_auth_login_postgres.py`,
`test_auth_session_csrf.py`, `test_auth_profile_password_postgres.py`, and
`test_auth_password_reset_lifecycle_postgres.py`. Independent scoped review found
no remaining actionable issues after the shorter-configuration correction. The
test process and its children exited. No browser or full-regression rerun was
needed for these backend-only policy changes; prior harness evidence remains
recorded above. Restart the application and sign out/in to obtain a new session
with the revised lifetime; existing stored absolute expiries remain unchanged.
