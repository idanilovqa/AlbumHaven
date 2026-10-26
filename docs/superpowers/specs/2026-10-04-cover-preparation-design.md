# Cover preparation performance

## Outcome and scope

Reduce repeated work when preparing an automatic cover-only pass, preserving
the selected jobs, ordering, user-owned artwork, and cancellation safeguards.
The owner approved the proposed scope and requested implementation on October 4.
The owner approved this written specification on October 4, 2026 and requested
implementation. Adjacent metadata recovery remains a separately scoped unit.

This is one delivery unit extending the fast-automatic-cover-search plan. It
does not include new arrivals or move workflows, provider changes, a full scan,
new persistence, parallel filesystem work, or deployment during the active pass.

## Evidence

The current planner memoizes cover decisions but normalizes the same query
identity repeatedly and performs an existence check also owned by the upgrade
helper. The manual-start path prepares jobs before submission and the executor
prepares them again. Existing image-dimension caching must be retained.

The observed initial preparation took 987.906 seconds. Warm planning and the
start of the first job occurred within 30.11 seconds after submission, so the
duplicate planning alone does not explain the initial delay. Small warm-file
samples do not establish cold-library throughput; no reduction is promised.

## Design

1. Reuse normalized keys within one planning call, keyed by the full effective
   artist, album, edition, and year tuple. A later identity change must produce
   the appropriate new decision. Keep existing cover-decision memoization.
2. Let the existing upgrade helper own missing-file detection; remove the
   redundant caller-side existence probe without changing corrupt-image or
   one-small-dimension behavior.
3. Pass the prepared jobs and required request context into the submitted
   execution path. Standalone execution still prepares its own jobs. Preserve
   snapshot ownership, generation/cancellation checks, submission-failure
   cleanup, and the existing persistence owners. Do not retain plans globally.

Do not trust hydrated dimensions without file-revision validation. Do not skip
track-path, metadata, or user-ownership aggregation after a folder is queued.
Do not introduce a new persistent cache or concurrency mechanism.

## Acceptance and verification

- Unchanged inputs produce the same ordered jobs and track membership.
- Shared cover/query identities require one upgrade decision; changed identity
  is reevaluated where the existing contract requires it.
- Missing, corrupt, disappearing, undersized, and sufficient images preserve
  current behavior. Multiple cover paths and later missing tracks remain safe.
- User-owned artwork and force-refresh behavior remain unchanged.
- Manual submission prepares once; standalone execution remains supported.
- Cancellation, stale generations, and submission errors cannot leave active
  flags stuck or execute a stale prepared plan.
- Separate test authoring establishes failing regressions before implementation.
  Run focused tests sequentially, then independent full relevant-diff review.
- Compare identical generated inputs before and after, recording preparation
  elapsed time and operation counts. Label warm measurements explicitly.

## Compatibility, rollback, and delivery gates

No public API, schema, settings, permission, UI, or client-support change is
intended. Rollback reverts this delivery's source changes; no data migration is
needed. An unexpected contract change requires renewed design review.

The current sandbox3 cover pass must finish using its loaded code. No production
database/media tests, maintenance restart, redeployment, or new pass is part of
this delivery. Preserve manual acceptance, E2E, hosted review, CI, and publication
gates. Preparation changes are not automatically published with the accumulated
multi-root branch; the existing safe delivery-boundary requirement remains.

## Adjacent work

Audit recovery/checkpointing against the existing implementation before adding
code: the owning plan already records local-cover reconciliation, per-album
image-selection persistence, and lookup checkpoints every 25 jobs. Live outcome
verification is distinct from implementation and is not performed by this work.

The private arrivals/move plan retains separate capability, deployment/client,
design, mockup, and acceptance gates. Intake may identify those decisions; this
specification does not authorize a new destructive move workflow.
