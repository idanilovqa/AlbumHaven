# Ninety-day sessions and reusable E2E authentication

**Owner-approved scope (2026-09-02):** Set application sessions to 90 days and log in once per runner for tests that do not exercise login or another identity. The owner approved reusing authentic browser state in response to the proposed design.

**Design:** Both idle and absolute defaults and maximums become 90 days. Session and session-CSRF cookies persist for the configured absolute lifetime. Revocation and shorter explicit configuration remain effective. Existing sessions retain their issued expiry; signing in again applies the new policy. No UI mockup is needed because this changes session policy and test prerequisites only.

**Approval-review checkpoint:** Automatic approval review rejected the backend
patch because the request did not explicitly name an extension of the idle
timeout. The owner has been asked to confirm both 90-day limits and persistent
cookies. Backend files are unchanged pending that clarification; session-policy
documentation describes the proposed target, not implemented behavior. The new
lifetime tests are preserved in `2026-09-02-session-policy-tests.patch` rather than
left failing in the active test suite. The initial focused Python run reported
five expected failures and 258 passes. No rejection workaround was attempted.

Authenticate through the production login form once per Playwright worker (the runner configurations currently use one worker), capture the genuine session and CSRF cookies in memory, and initialize fresh contexts with that state. Include readiness probes, browser warmup, and additional fresh contexts. Never persist credentials into test-data repositories or artifacts. Authentication and alternate-user suites opt out and retain their current flows. Test-owned data isolation remains required. This is the owner-approved exception for genuine authentication-state restoration under the E2E browser-state rule; no other browser mutation or product bypass is authorized.

**Verification:** Add focused coverage for 90-day configuration, expiry boundaries and persistent cookie attributes; verify login is performed once, state is reused in independent contexts, failures are surfaced, and opt-out suites retain clean sessions. Run Python and JavaScript checks sequentially, the production-parity gate, and a bounded real-app check if the environment supports it. Do not change functional assertions or performance budgets.

## Implementation

- [ ] Update session configuration, issuance defaults, and login-cookie persistence.
- [x] Replace repeated ordinary-test login with reusable runner authentication, including auxiliary contexts.
- [x] Verify harness regression coverage and inspect the harness diff.
- [x] Document the test contract and record the pending session-policy decision.

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
No release or publish is requested while backend authorization remains unresolved.
