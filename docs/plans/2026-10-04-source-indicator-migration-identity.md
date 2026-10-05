# Source-indicator migration identity repair

Outcome: restore strict sequential numbering without replaying an already applied
source-indicator migration or modifying historical ledger rows or timestamps.

- Scope: canonical `0082_library_source_indicators.sql`, isolated/demo readers,
  sandbox deployment controller, focused compatibility tests, migration docs.
- Prerequisites: known origin/main ends at0080 client-layout; this branch owns0081.
  Owner approved checksum-bound compatibility and deployment tooling changes.
- Acceptance: fresh source applies0082; historical0080 and canonical0082 ledgers
  skip equivalent SQL in both source directions; matching dual entries are safe;
  changed checksums and unrelated unknown migration identities fail closed.
- Compatibility: preserve SQL bytes; accept only the exact historical source-
  indicator checksum. Retain the alias in the deployment controller independently
  of the selected checkout, including older checkouts without the new helper.
- Rollback: retain additive schema/data and the original ledger. Use the updated
  controller for older source checkouts. Other missing migrations still block
  incompatible rollback. Do not revert the compatibility controller first.
- Checkpoint: focused tests and complete local review, then normal hosted review
  and CI before merge/publication. No deployment or database writes in this task.

Sandbox3's deployment metadata identifies the feature worktree, not its ledger.
Production's incomplete historical ledger is outside this repair; no replay or
automatic reconciliation is authorized.

Verification: the initial compatibility matrix failed in 17 expected cases;
two reader regressions demonstrated SQL replay before wiring the alias. Focused
verification, including existing demo tests, passed 65 tests and 16 controller
subtests. The existing demo suite caught an import-path regression, resolved by
loading the helper inside the migration function after launcher path setup.
The canonical SQL
SHA matches the historical Git blob; a file-specific LF attribute prevents
checkout line-ending conversion from invalidating that identity. No database
connections, ledger changes, service changes or deployment occurred.
