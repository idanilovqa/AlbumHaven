## Changes

Refactor gallery controls and shared triggered panels, preserve panel text selection, refine Appearance and player interactions, and extend end-to-end coverage. Fix scan refresh publication and two locally reviewed regressions: failed waveform loading and delete/recreate file-event coalescing.

This branch includes earlier unmerged work relative to main, so the PR diff is broader than the final gallery corrections.

## Local review and validation

- Local review plus independent production and CI/test reviews completed with selective coverage; details in docs/gallery-local-review.md.
- Both confirmed P2 findings fixed with failing-then-passing regression tests.
- Focused waveform tests: 43 passed; coordinator/reconciliation tests: 25 passed; production parity passed.
- Earlier exact browser runs passed Edit Tags, responsive gallery, and player views.
- Appearance and Loops still have documented legacy test-contract failures. Full release regression is not green; this PR is not merge-ready.

Run the normal PR Gates pipeline and its gated hosted review jobs. No test or review gate is bypassed.
