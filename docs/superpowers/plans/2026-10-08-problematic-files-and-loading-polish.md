# Problematic Files and loading polish implementation plan

## Delivery unit

Outcome: fast complete-safe Problematic Files entry plus the three approved UI fixes.

Included cases: `FTC-UTIL-PROBLEMS-001`, `FTC-UTIL-PROBLEMS-009`, and `FTC-UTIL-PROBLEMS-010`.

Prerequisites: released `origin/main` v0.9.49, immutable `fixtures-v1.0.25`, Postgres library-browse authority, existing virtualized Problematic Files renderer.

Acceptance:

- first 50 summaries and first detail paint within 1,000 ms target / 1,200 ms hard ceiling;
- background completion retains all 706 fixture summaries and full search/filter behavior;
- default API remains complete;
- selected Suggested Edit labels are unmistakably green;
- drag-select and drag-deselect apply at origin and remain stable across crossed labels;
- startup progress is longer, smooth, and displays a synchronized percentage.

Rollback: revert the cohesive delivery; no schema or persisted-data rollback is required.

Merge/publish checkpoint: focused verification, at least two complete local review passes, owner manual acceptance, then normal review-first CI. Do not publish from this plan commit.

## Tasks

1. Add failing repository/API tests for a SQL-bounded first page and unchanged complete default response.
2. Add failing runtime tests proving initial paint, background authoritative replacement, selection preservation, and search/filter waiting.
3. Restore the Problematic Files readiness contract to 1,000 ms target plus 200 ms grace.
4. Implement ordered candidate-ID discovery and selected-album row loading for the first 50 without complete projection construction.
5. Implement the two-stage client load and diagnostics.
6. Add failing interaction/style tests, then implement stronger selected green and origin-immediate crossed-index drag behavior.
7. Add failing startup-progress component tests, then implement responsive width, percentage, smooth interpolation, completion, and reduced-motion behavior.
8. Rebuild the runtime bundle.
9. Run focused JavaScript, component, Python, production-parity, and unchanged performance/functional cases sequentially. Preserve the worker-authentication failure evidence if it still blocks the canonical target.
10. Complete two adversarial full-diff review/fix passes; add a third if pass two finds a substantive issue.

## Evidence checkpoint

Baseline evidence is recorded in the companion design. Task-scoped artifacts live under `test-results/problematic-files-*`; the disposable database is `album_haven_ci_bugfixes_1008_a` and must be torn down through its recorded bootstrap state after verification.

