# Gallery warning and regression implementation plan

**Goal:** Implement the approved separate warning icon and dismissible alert, retain active warnings on Library/Scan, and cover missing gallery interactions with real-app E2E tests.

**Architecture:** Reuse the existing action button, warning icon, on-page alert, and Scan page. Store an account-scoped acknowledgement fingerprint in the existing Postgres library metadata through a dedicated repository. A fingerprint includes warning type, opaque root identity and detection time, so a new warning resurfaces. Acknowledgement never modifies watcher health. Use authenticated self-service routes and existing CSRF enforcement. Desktop web is required; other clients are outside this gallery change.

- [x] Add failing focused tests for stable warning identity, account-scoped persistence, and dismissal/new-warning behavior.
- [x] Add repository and bounded authenticated acknowledgement route; project dismissal state with status.
- [x] Add warning toolbar action and anchored alert with Dismiss and Library/Scan actions; render persistent Scan warning with existing permitted Full Rescan action.
- [x] Verify focused Python and JS checks, rebuild runtime and verify the production UI in an isolated app.
- [x] Audit existing E2E coverage and extend POM/actions and specs for uncovered year, search, cover, selection, track, modal, startup and warning behaviors.
- [x] Run affected E2E cases against an isolated Postgres fixture app; diagnose failures, preserve logs and audit owned processes. Keep one pytest process at a time.

Do not stage unrelated skill removals or scratch files, push, run a full release suite, or modify the settings worktree.

## Verification and remaining activation

- FTC-GALLERY-031, FTC-GALLERY-032 and FTC-GALLERY-033 passed through the production E2E runner, one isolated database/app/browser run at a time.
- Focused JavaScript/runtime and CI contract checks: 238 passed. Python checks run sequentially in separate processes: 32 watcher/dismissal, 81 policy/boundary, 61 read routes, 60 bootstrap (234 total).
- Version switching now preserves the current tab order and labels while hydrating a previously unopened edition. The focused regression failed before the fix and passed afterward.
- The current app on HTTPS port 5001 serves this gallery checkout, but Windows denied stopping its PID 23360. Restart the gallery launcher from this checkout to activate the new Python acknowledgement route. The existing listener was verified still running after the denied stop; no replacement was launched.
- Full release/CI remains outstanding. Published fixtures-v1.0.22 lacks the earlier Mulan fixture, so FTC-GALLERY-030 still requires its fixture release/pin update. An earlier combined watcher-health/bootstrap run exposed executor test-isolation leakage; the files pass separately, and comprehensive regression must revisit that ordering.
- No commits, staging changes, or pushes were performed. The 59 previously staged skill deletions are preserved; `.codex-run/` remains scratch-only.
