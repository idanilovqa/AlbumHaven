# Change-Aware PR Reviews Design

## Goal

Run hosted PR reviewers only after the trusted CI and E2E gates pass. Skip repeated review work for documentation-only pushes, limit supported reviewers to changes since the last successful review, and add AI Code Review // VERY POWERFULL as the third whole-PR reviewer.

## Current behavior

`.github/workflows/pr-gates.yml` declares the functional and performance E2E jobs as dependencies of PR Agent Review and Codex PR Review. The jobs' `if` expressions do not require either E2E result to equal `success`, so GitHub may start both reviewers after an E2E failure or skip.

Both reviewers run for each configured non-draft, same-repository PR event. Codex receives the PR base and head SHAs. The workflow does not classify the latest event range or distinguish documentation-only changes.

## Review scope policy

The workflow will classify one successful-review range before the review jobs start:

- `synchronize` with a usable successful-review marker: the recorded reviewed head through `github.event.pull_request.head.sha`
- `synchronize` without a usable marker: `github.event.pull_request.base.sha` through `github.event.pull_request.head.sha`
- `opened`, `reopened`, and `ready_for_review`: `github.event.pull_request.base.sha` through `github.event.pull_request.head.sha`

The Cloud Verification Gate will create or update a bot-authored hidden marker only after the selected review matrix succeeds. Scope lookup authenticates that marker against a completed successful PR Gates run for the same PR, head SHA, and marker-update time window, so model-authored review text cannot forge coverage. A failed, blocked, or cancelled run therefore cannot advance review coverage. If the marker is absent, unauthenticated, unavailable, or no longer an ancestor after a force-push, the classifier conservatively selects whole-PR mode.

The classifier will normalize paths and treat root-level Markdown files and files under `docs/` as documentation. Markdown files in functional control paths, such as `.github/codex/prompts/`, count as functional. A range with documentation and functional files counts as functional.

The classifier will count additions plus deletions for functional files from Git numstat output. A binary functional change has no stable line count and forces whole-PR mode.

The classifier will emit these review modes:

| Mode | Condition | PR Agent | Codex | AI Code Review // VERY POWERFULL |
| --- | --- | --- | --- | --- |
| `none` | Successful-baseline range has no functional changes | skipped | skipped | skipped |
| `incremental` | Successful-baseline range has 250 or fewer changed functional lines and no binary functional file | latest supported range | successful-baseline range | skipped |
| `full` | Missing/unavailable successful baseline, initial/non-push event, more than 250 changed functional lines, or a binary functional change | whole PR | whole PR | whole PR |

The 250-line boundary includes 250. The first eligible review of a PR uses whole-PR mode because no successful review baseline exists yet.

## Pipeline structure

Add a small scope-classification job that reads the bot-authored successful-review marker, checks out full history, runs a repository-owned classifier, and publishes the mode, base SHA, head SHA, functional line count, and functional-change flag as job outputs.

Each reviewer will depend on the classifier and the existing foundation, production-parity, functional E2E, and performance E2E jobs. A reviewer may run only when all of those jobs report `success`, the PR is non-draft, and the PR branch belongs to the repository.

PR Agent and Codex will run in `incremental` and `full` modes. Codex will use the classifier's SHAs in incremental mode and the PR base/head SHAs in full mode. The pinned PR Agent revision supports `/review -i`, which derives its range from the last published PR Agent review and falls back to a full review if that marker is unavailable.

AI Code Review // VERY POWERFULL v1.3.0 does not accept a commit-range input and fetches all files in the PR through GitHub's API. It will run only in `full` mode. The workflow will pin the action to commit `e4c07fe82e4c70a3cf152773423f608a88e9497d`, require `OPENAI_API_KEY`, disable its linter execution, and give the job read access to contents plus write access to PR feedback.

## Final gate behavior

The Cloud Verification Gate will receive the classifier outputs and all three review results.

For trusted same-repository PRs:

- Foundation and E2E jobs must report `success` in every mode.
- `none` requires all three review jobs to report `skipped`.
- `incremental` requires PR Agent and Codex to report `success` and the third reviewer to report `skipped`.
- `full` requires all three review jobs to report `success`.

Fork behavior remains non-authoritative. Portable checks must pass, and trusted Windows, E2E, classifier-dependent review, and secret-bearing review jobs must keep their documented skipped behavior.

The gate will reject an unknown mode or any review result that does not match the mode, then record the covered head SHA. This prevents an accidental job-condition change or failed earlier run from turning a missing review into a green gate.

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
- missing successful baselines and accumulated changes after failed runs
- trusted final-gate results for `none`, `incremental`, and `full`
- rejection of skipped, failed, or missing reviewers in each mode
- fork expectations after the third job and classifier dependency are added

Workflow checks will parse the YAML and assert that each review job requires successful functional and performance E2E results. Tests will also assert the immutable third-action pin and its `full`-mode condition.
