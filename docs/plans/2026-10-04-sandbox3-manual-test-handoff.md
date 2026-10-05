# Sandbox3 manual-test handoff

## Current repair evidence

- Appearance and component-inventory focused verification: 100/100 Node tests passed; complete CI and independent review remain pending.
- Startup investigation reproduced a full followup request being rewritten to sidebar-only data. The correction must preserve ordinary root pagination and the existing full-startup acceptance contract; no performance threshold changes are authorized.
- Python investigation identified repeated exception resolution when duplicate projection rebuilds file entries already normalized by the problematic-files projection. Reuse belongs at the shared projection seam, preserving output and one resolution per row. Rollback is removal of that reuse, not altered assertions. Focused verification remains pending.
- Fresh service inspection still finds the original maintenance server on port 5003 and production on port 5000. Normal sandbox deployment is blocked on the owner's data-mode choice; no service or production database change has been made.
- Startup focused verification reached 161/161 after an additional regression exposed automatic page loading cancelling the queued full startup fetch. Keep pagination suspended until startup hydration completes. Browser and hosted verification remain pending.
- All six unchanged exception-resolution-once tests now pass with shared projection reuse. The last exact by-track-path payload check passed after explicitly accounting for its existing internal persisted-album identity. Migration collision, live Postgres cases, provisioning skips, and complete CI remain unresolved.
- Library State initial focused verification reached 41 Node and 36 Python passes. Independent review subsequently requested preparation-mode and terminal-counter rendering repairs; those require fresh checks before this unit can be marked complete.
- Python consolidated verification passed 417 tests in 16.61 seconds (exit 0): both complete focused browse/palette modules and the two repaired isolated fixture-generation cases. Evidence: private `tmp/ci22-inventory/python-consolidated.xml`. This does not include the migration collision, live database assertion, or provisioning skips. Independent two-pass review of the four-file repair found no validated issue.
- Appearance/inventory is committed as `d62a95165138eb6aaa7d198f68e213d8636b696f`; seven files only, index clear, no push or deployment. Exact implementation versus process elapsed time was not recorded.

Owner requested normal sandbox3 browsing, visible Library State progress, all
approved fixes, continued CI repairs, and reconciliation of outstanding requests.
This checklist coordinates existing owning plans; it does not approve new UI,
permissions, database changes, merge, or publication.

## Delivery units and gates

- [ ] Library State: preserve the approved four-card UI; show completed albums,
  downloaded covers, meaningful percentage, preparation-inclusive elapsed time,
  ETA or unknown, and unavailable/stale state. Center the block when sole content.
  Owner: existing September 21 Library State spec and remaining-UI plan.
  Compatibility: existing UI and status API; additive telemetry only. Verify
  focused tests and rendered behavior before the manual-test deployment.
- [ ] CI appearance/inventory: align test fixtures and registration with the
  approved source indicators; preserve all discovered cases and thresholds.
- [ ] CI Python: reproduce and repair the complete reported failure inventory;
  distinguish fixture drift from actual browse/identity/schema regressions.
- [ ] CI functional/performance: resolve gallery hydration/navigation failures
  without weakening existing full-view or responsiveness acceptance contracts.
- [ ] Deploy: use the deployment runbook and this feature worktree only. Confirm
  the owner's database choice before replacing maintenance with normal sandbox3;
  preserve current production service and database unless separately authorized.
  Verify local/public login, private bootstrap denial, owner browsing, covers,
  artist/search actions, settings loading, and Library State.
- [ ] Cover recovery/retry: retain the timeout investigation plan's unresolved
  read-only-file permission, mixed-album scope, durable-outcome audit, and exclusive
  writer gates. Never label errors as no candidates or silently restart a pass.
- [ ] Manual move: initial permission/client/deployment scope is approved; exact
  technical design, mockup, and functional cases still require their explicit
  approval before exposing the new action.
- [ ] Family grouping: preserve the diagnosed distinction between folder-derived
  family ancestry and external artist relations; proposed grouping changes must
  specify the desired contract before implementation.
- [ ] Remaining multi-root/preparation checks: reconcile their existing owning
  plans and provide a precise manual script; do not infer completion from commits.

## Verification and release boundary

Run one test command at a time for this coordinated batch, including one pytest
process globally. Complete two severe relevant-diff reviews per repaired unit.
After focused verification, commit coherent units and push the complete native
PR22 pipeline with the existing owner-authorized `skip_reviews` waiver; never
add `skip_tests`. Full CI must finish before collecting the next failure batch.
Manual acceptance, unresolved designs, full CI, and release gates stay open.
An accumulated branch needs a safe delivery split before publication.

## Current operational evidence

The original cover executor has a terminal completed record; its server remains
on 5003. Production is currently running on 5000, while the ordinary sandbox3 task
is disabled. This differs from the original maintenance handover. Deployment must
not restore obsolete task state or start concurrent cover writers.

The normal deployment controller provisions isolated sandbox data. The owner has
been asked to choose an isolated current-production copy, existing sandbox data,
or production data with production stopped. No choice has yet been assumed.
