# Change-Aware PR Reviews Design

## Goal

Run hosted PR reviewers only after the trusted CI and E2E gates pass. Skip repeated review work for documentation-only pushes, limit supported reviewers to the latest small push, and add AI Code Review // VERY POWERFULL as the third whole-PR reviewer.

## Current behavior

`.github/workflows/pr-gates.yml` declares the functional and performance E2E jobs as dependencies of PR Agent Review and Codex PR Review. The jobs' `if` expressions do not require either E2E result to equal `success`, so GitHub may start both reviewers after an E2E failure or skip.

Both reviewers run for each configured non-draft, same-repository PR event. Codex receives the PR base and head SHAs. The workflow does not classify the latest event range or distinguish documentation-only changes.

## Review scope policy

The workflow will classify one event range before the review jobs start:

- `synchronize`: `github.event.before` through `github.event.pull_request.head.sha`
- `opened`, `reopened`, and `ready_for_review`: `github.event.pull_request.base.sha` through `github.event.pull_request.head.sha`

The classifier will normalize paths and treat Markdown files and files under `docs/` as documentation. Any changed file outside that set makes the range functional. A range with documentation and functional files counts as functional.

The classifier will count additions plus deletions for functional files from Git numstat output. A binary functional change has no stable line count and forces whole-PR mode.

The classifier will emit these review modes:

| Mode | Condition | PR Agent | Codex | AI Code Review // VERY POWERFULL |
| --- | --- | --- | --- | --- |
| `none` | Event range has no functional changes | skipped | skipped | skipped |
| `incremental` | `synchronize` event has 250 or fewer changed functional lines and no binary functional file | latest event range | latest event range | skipped |
| `full` | Initial/non-push event, more than 250 changed functional lines, or a binary functional change | whole PR | whole PR | whole PR |

The 250-line boundary includes 250. The first eligible review of a PR uses whole-PR mode because the workflow has no preceding push range for that PR event.

## Pipeline structure

Add a small scope-classification job that checks out full history, runs a repository-owned classifier, and publishes the mode, base SHA, head SHA, functional line count, and functional-change flag as job outputs.

Each reviewer will depend on the classifier and the existing foundation, production-parity, functional E2E, and performance E2E jobs. A reviewer may run only when all of those jobs report `success`, the PR is non-draft, and the PR branch belongs to the repository.

PR Agent and Codex will run in `incremental` and `full` modes. Their configuration or prompt inputs will use the classifier's SHAs in incremental mode and the PR base/head SHAs in full mode. The implementation must verify that the pinned PR Agent revision can enforce the incremental boundary. If it cannot, the job must not claim an incremental review; implementation will stop for owner direction instead of silently reviewing the whole PR.

AI Code Review // VERY POWERFULL v1.3.0 does not accept a commit-range input and fetches all files in the PR through GitHub's API. It will run only in `full` mode. The workflow will pin the action to commit `e4c07fe82e4c70a3cf152773423f608a88e9497d`, require `OPENAI_API_KEY`, disable its linter execution, and give the job read access to contents plus write access to PR feedback.

## Final gate behavior

The Cloud Verification Gate will receive the classifier outputs and all three review results.

For trusted same-repository PRs:

- Foundation and E2E jobs must report `success` in every mode.
- `none` requires all three review jobs to report `skipped`.
- `incremental` requires PR Agent and Codex to report `success` and the third reviewer to report `skipped`.
- `full` requires all three review jobs to report `success`.

Fork behavior remains non-authoritative. Portable checks must pass, and trusted Windows, E2E, classifier-dependent review, and secret-bearing review jobs must keep their documented skipped behavior.

The gate will reject an unknown mode or any review result that does not match the mode. This prevents an accidental job-condition change from turning a missing review into a green gate.

## Security and credentials

All review jobs will stay restricted to same-repository PRs so forked code cannot receive repository secrets. Each reviewer will get the existing `OPENAI_API_KEY` only in its credential check and action step. Checkout and repository-controlled publication steps will not inherit the key.

The third action is an uncertified third-party action. The immutable commit pin prevents a tag owner from changing the code used by the workflow. Disabling its linter feature prevents redundant repository command execution after CI has already run the project checks.

## Repository changes

The implementation will update or add:

- `.github/workflows/pr-gates.yml`
- a repository-owned PR review scope classifier under `scripts/ci/`
- focused JavaScript tests for classification and final-gate policy
- the private `coderabbit-workflow.md` and review guardrails sections that own the hosted review contract

The classifier will expose pure functions for path classification, numstat parsing, line counting, and mode selection. Its CLI wrapper will handle Git and GitHub Actions output formatting. This split keeps policy tests independent from GitHub-hosted runners.

## Verification

Focused tests will cover:

- documentation-only, mixed, and functional ranges
- 249, 250, and 251 changed functional lines
- binary functional files
- initial and synchronize events
- trusted final-gate results for `none`, `incremental`, and `full`
- rejection of skipped, failed, or missing reviewers in each mode
- fork expectations after the third job and classifier dependency are added

Workflow checks will parse the YAML and assert that each review job requires successful functional and performance E2E results. Tests will also assert the immutable third-action pin and its `full`-mode condition.
