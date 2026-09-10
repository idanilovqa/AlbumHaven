# Review-First Focused CI Design

> Superseded for focused selection and promotion by
> `2026-09-08-case-tagged-focused-ci-design.md`. Current reviewer selection,
> ordering, and failure-inventory rules are defined in
> [the contributor guidance](../../../AGENTS.md#review-first-ci-execution).

## Goal

Make pull-request verification review-first, preserve a complete combined failure inventory, and provide a non-authoritative focused E2E repair loop that automatically promotes to a full reviewed pipeline after the selected E2E shards pass.

## Pipeline modes

The workflow has two modes derived from pull-request labels:

- `full` is the default and the only release-authoritative mode.
- `focused-e2e` is selected by `ci:focused-e2e`. One or more target labels must also be present. Functional targets use `ci:e2e:<shard>`, where `<shard>` is `gallery-search-visual`, `cover-providers`, `metadata-mutations`, or `playback-utilities`. Phase 7 targets use `ci:e2e:phase7-auth` or `ci:e2e:phase7-admin`. Performance targets use `ci:e2e-performance:<shard>` with an existing performance shard name.

A focused run skips foundation suites and all reviewers. It runs only the selected E2E jobs, reports a focused verification result, and cannot update the successfully-reviewed-head marker or satisfy the authoritative Cloud Verification Gate.

When every selected focused target succeeds, the workflow removes all focused target labels and `ci:focused-e2e`, applies `ci:full-review`, and thereby starts a new full pipeline automatically. Failed focused runs leave the labels in place so the next pushed fix repeats the same target set.

## Review scope

Full mode runs the review-scope job before any test job. The classifier keeps documentation-only ranges at `none`, but `ci:full-review` forces `full` when functional or E2E-relevant changes exist. It must not force review for a range containing only root Markdown and `docs/` changes.

For a synchronize event with an authenticated successfully reviewed baseline:

- fewer than 250 changed functional lines and no binary functional file selects `incremental`; PR Agent and Codex review only the baseline-to-head diff;
- 250 or more changed functional lines, a binary functional file, a missing or unusable baseline, or `ci:full-review` selects `full`; all three hosted reviewers review the whole PR;
- no functional or E2E-relevant changes selects `none`; all reviewers skip.

The threshold is strict: 249 lines are incremental and 250 lines are full.

## Ordering and failure collection

In full mode, `review_scope` runs first, followed by all applicable hosted reviewers. Foundation, Python, JavaScript, component, production-parity, functional E2E, Phase 7 E2E, and performance E2E jobs start only after the review jobs reach terminal conclusions.

Test jobs use `always()`-based conditions and do not require review success. A failed or timed-out reviewer therefore does not suppress E2E. Likewise, one failing test family does not suppress another. The Cloud Verification Gate waits for every required job and reports failure only after the complete review and test inventory exists.

## Safety and release authority

Review jobs remain same-repository, non-draft jobs so untrusted forks cannot receive secrets. Focused mode never writes the reviewed-head marker. Only a successful full-mode Cloud Verification Gate may write that marker or authorize merge and publication.

The automatic label transition requires `issues: write` on the focused gate only. Test and reviewer jobs keep their existing least-privilege permissions.

## Repository policy

The public contributor rules and private owner workflow rules will state:

- focused local tests precede the hosted focused E2E repair run;
- focused hosted runs use explicit target labels and are non-authoritative;
- a successful focused run automatically starts a full review-first pipeline;
- the full pipeline must finish every review and test job before findings are fixed;
- fixes address the combined review and test inventory;
- E2E contracts remain protected and may not be weakened to clear failures.

## Verification

Focused Node tests will prove strict 249/250 scope behavior, label parsing, required focused targets, forced whole-PR review, documentation-only review skipping, mode-aware final-gate behavior, workflow ordering, E2E execution after failed review, automatic focused-to-full promotion, and the invariant that focused runs cannot record review coverage.
