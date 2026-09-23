# Pipeline controls and deferred PR1 review

Trusted same-repository pull requests support two independent labels:

- `skip_reviews`: skip Codex and PR Agent without making paid review calls. Full test selection is unchanged. CI retains explicit waiver evidence and does not record a successfully reviewed-head baseline.
- `skip_tests`: skip every test family. Review selection is unchanged. Cloud Verification Gate cannot succeed because a complete passing test pipeline is still required for merge and release.

With neither label, the normal review-first pipeline applies. With both labels, both groups are skipped and the merge/release gate cannot pass. Forks cannot activate these controls. Label changes trigger a new native pull-request run.

The owner authorized PR1 to merge and publish after all required tests pass, with `skip_reviews` retained and `skip_tests` absent. This is an explicit review waiver, not evidence of zero findings or complete review coverage. Existing test assertions, isolation requirements, retries and performance limits remain unchanged.

## Preserved review scope

Before applying the waiver, two remote branches were preserved:

- `codex/pr1-review-snapshot-2026-09-10`: `4167a9072d5ef013de2f2b193fb09ea77657e37a`.
- `codex/pr1-review-base-2026-09-10`: `e0845f83552e1b0043cf435dcb82d5b959e31a05`.

Keep both branches unchanged. The first contains the current implementation and eight verified repairs; the second retains its original comparison base. Comparing the snapshot to main after PR1 merges would hide the original changes, so future full reviews must compare the preserved base to the snapshot instead.

When the owner chooses to resume paid reviews, use a separate review-only PR from the snapshot to the preserved base, or supply the equivalent Git diff to the batch reviewer. Do not create or trigger that review until requested. Do not merge into the preserved base. Validate findings against current main, implement still-applicable fixes on a new branch from current main, and publish those fixes as a separate PR. Track resolved, obsolete and rejected findings against their source review. A clear later review describes that reviewed revision and scope; it cannot guarantee that future reviews will never identify another issue.

PR1's current test-only release work may make further test-driven repairs after the snapshot. Its release commit remains separately identifiable by the merge commit and release tag; the preserved snapshot must not move to include those changes.

## PR2 gallery release review waiver

On September 12, 2026, the owner authorized the gallery PR2 release to use
`skip_reviews`, with `skip_tests` absent. This waives hosted Codex and PR Agent
reviews for the gallery branch, including its release metadata and test-driven
repairs. It does not waive local review or any required test suite.

Merge and publication still require the complete passing CI pipeline. Preserve
existing assertions, fixture isolation, retries, and performance limits. Record
the waiver as waived review coverage; do not claim paid review coverage, a
successfully reviewed-head baseline, or zero findings from skipped reviewers.

The PR1 snapshot and comparison-base branches above remain unchanged. This PR2
waiver neither moves those snapshots nor starts the deferred paid-review work.
