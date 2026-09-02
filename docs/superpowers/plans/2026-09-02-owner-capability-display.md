# Owner capability display correction

## Requested behavior and cause

The owner requested that their existing bootstrap account show the Owner role and every currently displayed granular capability checked. The roster already recognizes `is_bootstrap_owner`; the account-detail template instead hard-codes Listener and reads only individually stored grants, which can be empty for an owner whose full access comes from server policy.

This is a correction to the existing Phase 7 user editor, not a new role-assignment or authorization model. Reuse its existing select, permission switches, note, and effective-access row. No new visual component or screen is introduced.

## Scope and safeguards

- Display Owner for the server-identified bootstrap owner, with all 12 currently displayed managed capabilities checked as inherited full access.
- Make inherited switches read-only and visibly inactive; explain that Owner supplies those permissions. Retain hidden submitted capability values so the existing Save changes payload remains valid when native disabled inputs are omitted from FormData.
- Show Owner/full access rather than Listener/customized in the effective-access summary.
- Preserve Listener defaults and editable explicit permissions for ordinary users. Do not make Owner assignable through ordinary user creation or editing.
- Keep the existing server policy, protected-owner checks, managed-capability allowlist, and database schema unchanged. Do not expose `system.admin` as an ordinary grant. A valid save of inherited Owner settings must preserve its membership and stored grants rather than run the ordinary-member replacement path.
- This display correction preserves existing deployment and client behavior; it creates no new platform or hosted-service commitment.

## Functional and automated checks

- [x] Add failing route-render tests for an owner with empty stored grants, checked inherited switches, valid submitted values, and unchanged ordinary-user behavior.
- [x] Implement Owner labeling, inherited checked state, and protected presentation using the existing editor controls.
- [x] Extend FTC-PERMISSIONS-009 additively: no Owner option for new/ordinary users; Owner selected and every visible capability checked/read-only on the bootstrap-owner editor. Preserve all existing authority, invitation, and account-navigation assertions.
- [x] Run focused Python and JavaScript checks sequentially, production-parity validation, and the dedicated Admin Management suite (five existing cases plus the new Owner Save regression) against isolated Postgres and loopback SMTP.
- [x] Review the scoped changes and hand off for local owner testing. Do not merge.
- [x] Preserve Owner membership and grants when saving its read-only inherited settings, with a mutation-service regression and a normal-browser save/reopen check.

No performance threshold or E2E fixture change is needed for this bounded rendering correction. The private functional case retains its current automated status and counts.

## Manual acceptance

1. Refresh the app (restart the server if templates are cached).
2. Open Settings gear → Admin Panel → Users → Rendref's three-dot menu → Edit.
3. Confirm Capability role reads Owner and Effective access reads Owner/full access.
4. Confirm all current granular capabilities are checked and identified as inherited/read-only.
5. Open another user's editor or Add user: Listener and editable granular permissions remain; Owner is not available for assignment.
6. Save the unchanged Owner form, then reopen it. Owner and all inherited capabilities remain; saving does not demote membership or replace stored grants.

## Evidence

Test-first evidence: the owner render test failed on the missing Owner option before implementation (one failed, ten passed). The corrected template passed all eleven tests in `tests/py/test_admin_members_asgi.py`. Initial independent focused verification passed 26 Python tests across both admin route files, 20 JavaScript tests across the admin runtime and Account/Admin presentation suites, production parity, and whitespace checks. No production database or SMTP configuration is changed by this correction.

Review follow-up: initial rendering/runtime verification passed, including all five existing Admin Management E2E cases. Independent review identified that the newly valid Owner Save payload exposed an existing ordinary-member mutation path that would overwrite owner membership and stored grants. The correction preserves the existing locked bootstrap-owner protection and treats its valid read-only save as a no-op. Disabling or detaching the protected owner remains denied. No database repair or new authorization model is introduced. The mutation regression initially observed 17 SQL statements rather than the intended authority lock alone; after correction all 16 mutation/render tests passed. Final focused verification passed 31 Python and 20 JavaScript tests plus production parity. Independent follow-up review found no remaining issue; the six-case browser run is pending.

Final browser verification passed all six Admin Management cases in 42.2 seconds, exit 0, including Owner Save/reopen with unchanged owner membership, capability row IDs/keys/revocation flags, and account state. Evidence: `test-results/owner-capability-save.stdout.log`. All tracked test processes exited and ports 6190–6192 were clear afterward. Final checks passed 31 Python tests, 20 JavaScript tests, production parity, and `git diff --check`. The correction remains local and uncommitted for owner testing; nothing was pushed or merged. This plan has no aggregate checklist counter; all six implementation/verification items are complete.

## Changed files and timing

### Follow-up: protect the Owner Library access switch

The owner explicitly requested that Library access be checked and disabled for the protected bootstrap Owner. This aligns the existing control with the server's existing refusal to detach that owner. It does not change ordinary-user controls, Account enabled, or backend authority.

- [x] Add failing render coverage for checked/disabled Owner library access and a hidden `current_library_access=on` value, preserving valid Save submission.
- [x] Apply the minimal template correction using the existing disabled-switch styling; leave ordinary-user library access editable.
- [x] Add assertions to the existing Owner Save/reopen and FTC-PERMISSIONS-009 browser paths, verify focused tests plus the six-case admin suite, and review the correction.

Manual check: open Users → Rendref → Edit. Library access must be checked and greyed out, cannot be toggled, and remains checked after Save changes and reopening. An ordinary user's library-access switch remains editable. No migration or bootstrap rerun is required.

Follow-up test-first evidence: two render regressions failed before the template change (13 passed). All 15 route tests passed afterward, including a membership-only administrator context and an ordinary account without membership. Final verification passed 35 Python tests, 20 JavaScript tests, production parity, and all six Admin Management E2E cases in 40.4 seconds (exit 0). Independent review found no issue. Evidence: `test-results/owner-library-access.stdout.log`. All tracked test processes exited and ports 6190–6192 were clear; the owner's server was untouched. All three follow-up checklist items are complete, with no functional-case status or counter change. Changes remain local and uncommitted; nothing was pushed or merged.

The follow-up changes seven files: this plan, `music_app/templates/admin-account-detail.html`, `tests/py/test_admin_members_asgi.py`, `tests/e2e/phase7/admin-management/adminManagement.spec.js`, `tests/e2e/phase7/poms/authPages.js`, and private `docs/functional-test-cases/users-and-permissions.md` plus `docs/functional-test-cases.md`. Exact follow-up elapsed time and direct-work/process-overhead split were not recorded.

### Original Owner capability correction inventory

Eleven files change for this correction, excluding earlier navigation fixes and unrelated owner work:

- `music_app/templates/admin-account-detail.html`
- `music_app/static/css/admin-members.css`
- `music_app/services/admin_member_mutation_postgres.py`
- `tests/py/test_admin_members_asgi.py`
- `tests/py/test_admin_member_mutation_postgres.py`
- `tests/e2e/support/phase7AuthApp.py`
- `tests/e2e/phase7/admin-management/adminManagement.spec.js`
- `tests/e2e/phase7/poms/authPages.js`
- `docs/superpowers/plans/2026-09-02-owner-capability-display.md`
- Private `docs/functional-test-cases/users-and-permissions.md`
- Private `docs/functional-test-cases.md`

Exact elapsed time and the direct-work/process-overhead split were not recorded. Functional-case statuses and the Users And Permissions Automated 9/12 counter remain unchanged.
