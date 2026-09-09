# Complete PR Review Batches Implementation Plan

> **For agentic workers:** Use executing-plans with explicit implementation,
> independent verification, review and commit handoffs. The owner approved the
> linked design and implementation on September 8, 2026; no further execution
> choice or design approval is needed for this scope.

**Goal:** Supply every changed file/section to a bounded Codex review, reject
incomplete results, collect cross-subsystem findings and retain private usage.

**Architecture:** Generate a deterministic Git-backed plan tied to the event
head and merge tree. Run its bounded matrix, then retain `codex_review` as the
aggregate/integration gate before the existing test matrix. Keep PR Agent as
the supplementary reviewer and extend encrypted usage attribution per unit.

**Tech Stack:** Node22 built-ins, Git, GitHub Actions, pinned Codex Action/CLI,
existing RSA/AES usage envelope and Node test runner.

## Global constraints

- Approved spec: `docs/superpowers/specs/2026-09-08-complete-pr-review-batches.md`.
- At most30 review items and200,000 diff characters per batch, up to4 jobs in
  parallel, existing20-minute reviewer timeout, no automatic paid retry loop.
- Use at most64 batches; overflow is a visible preflight error, never omission.
  This is a technical bound, not a spending cap. Actual manifest size is reported.
- Preserve every changed text line, generated runtime diff and image assignment.
  PNG bytes are model image inputs; unsupported binary input blocks coverage.
- Preserve native pull-request events, trust/same-repository checks, read-only
  model permissions, privilege reduction and all existing E2E contracts.
- No raw model transcripts, plaintext usage, costs or private keys in public
  artifacts/logs. Public coverage metadata contains no usage/cost values.
- Full suites run only in CI. Focused local Node/Python commands are serialized
  through the root's exclusive test slot; no parallel pytest processes.
- Linux watcher scope is a separate pending decision, not part of this approval.

## Interfaces

`scripts/ci/plan-codex-review.cjs` exports `createReviewPlan(options)` and runs a
CLI using `--output-dir`. Inputs: `BASE_SHA`, `HEAD_SHA`, `REVIEW_MODE`,
`GITHUB_SHA`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`,
`REVIEW_PR_NUMBER`, and pinned version metadata. Local tests may pass explicit
options/repository paths. It writes under the output directory:

```text
manifest.json
usage-units.json
batch-001.prompt.md
batch-001.schema.json
images/<Git-blob-id>.png
...
```

Manifest version1 identifies repository, PR, run/attempt, reviewed base/head,
checked-out merge commit/tree, planner version, exact diff file identities and
the complete batch/item assignment. Its SHA256 digest covers canonical manifest
content excluding the digest field. IDs are stable safe filenames: `batch-NNN`,
`item-NNNN` and optional section suffixes. Every item records source path, kind,
old/new blobs and the full assigned patch or image identity. Diff section ranges
and hashes make missing/overlapping changed-line coverage detectable.

The CLI emits `matrix_json={"include":[{"id":"batch-001","codex_args":"[]"}]}`
and `manifest_digest=<sha256>` to `GITHUB_OUTPUT`. Image arguments use a JSON argv
array with `--image` and paths under the generated image directory; no shell
interpolation. Matrix size is nonzero when review is required.

Each model result is strict structured JSON:

```json
{
  "schemaVersion": 1,
  "reviewUnitId": "batch-001",
  "manifestDigest": "<64 lowercase hex>",
  "headSha": "<40 lowercase hex>",
  "items": [{"id": "item-0001", "status": "reviewed", "notes": "Inspection summary"}],
  "findings": [{"priority": "P1", "kind": "bug", "file": "path", "line": 1,
    "side": "right", "title": "Problem", "body": "Trigger and consequence"}],
  "integrationRisks": ["Boundary requiring integration inspection"]
}
```

`status` is `reviewed` or `omitted`; `kind` is `bug` or `missing_test`;
priority is P0–P3. Empty findings is valid. A nonempty findings list blocks tests.
Integration uses the same schema with `reviewUnitId=integration` and each batch
ID as an assigned item. Model text is data and never becomes shell code.

`scripts/ci/validate-codex-review-batches.cjs` exports reusable validators and
 provides result-validation CLI modes:

```sh
node scripts/ci/validate-codex-review-batches.cjs batch --plan-dir .tmp/codex-review --unit batch-001 --input .tmp/codex-result.json
node scripts/ci/validate-codex-review-batches.cjs prepare --plan-dir .tmp/codex-review --results-dir .tmp/codex-results --output-dir .tmp/codex-integration
node scripts/ci/validate-codex-review-batches.cjs final --plan-dir .tmp/codex-review --results-dir .tmp/codex-results --integration .tmp/codex-integration/result.json --output .tmp/codex-review-final.md
```

Before either paid action, `preflight --plan-dir .tmp/codex-review --unit <batch-id-or-integration> --manifest-digest <planner-job-digest>`
reconstructs the expected Git/event plan and verifies the downloaded prompts,
schemas and image bytes. The plan job also compares the generated runtime bundle
with its source modules using the existing pure builder, without writing files.

Batch mode validates completeness/identity, not the absence of findings. Prepare
requires all expected valid batch results and produces `prompt.md`, `schema.json`
and a public preliminary findings report even when batches found issues. Final
rechecks all identities, merges/deduplicates findings and writes Markdown ending
in the existing exact pass/block verdict. It exits nonzero on any finding or
incomplete result. Public output explicitly states supplied/attested coverage and
does not claim absence of bugs. All modes verify the plan against current event
metadata and checked-out Git identities, rejecting stale results.

Review output artifacts: `codex-review-result-<run>-<attempt>-<unit>`, containing
one `<unit>.json`. Plan artifact: `codex-review-plan-<run>-<attempt>`.
Private expected-unit artifact: `private-review-usage-units-<run>-<attempt>`,
containing `usage-units.json` with repository/run/attempt/head/manifestDigest and
`units[]` entries `{reviewer, reviewUnitId, artifactName}`. Every Codex batch and
integration entry has a unit ID. PR Agent retains its legacy artifact name and
may omit reviewUnitId for backward compatibility.

Encrypted Codex artifact names append `-<unit>` to the existing run/attempt name.
Seal metadata adds optional `reviewUnitId` and `manifestDigest` from
`REVIEW_USAGE_UNIT_ID` and `REVIEW_USAGE_MANIFEST_DIGEST`. Legacy reports remain
readable. Missing unit telemetry is unknown, never zero; duplicate response IDs
cannot be charged twice in aggregation.

## Task 1: Git-backed planner and strict coverage gate

Files: create the two scripts above and
`tests/js/codex-review-batches.test.js`. Planner/validator implementation and
independent test authoring use separate agents with the frozen interfaces above.

- [x] Write focused temporary-Git-repository cases for every-file coverage,
  oversized patches, deletions/renames, PNG inputs, unsupported binaries and
  deterministic repeated planning. Test omitted/duplicate/foreign/stale item,
  tampered digest, missing/malformed results and findings that block tests.
- [x] Run the focused test file under the exclusive slot and retain its RED.
- [x] Implement actual Git diff/blob extraction and line-preserving sections;
  put actual bounded content in prompts, not only filenames. Preserve explicit
  generated-file coverage and ensure each binary belongs to a visual input.
- [x] Implement structured schemas, set-equality validation and integration
  preparation/final rendering; do not trust a freeform verdict or skip results
  after an earlier finding. Bound integration summaries; an unrepresentable
  integration input blocks visibly rather than silently truncating it.
- [ ] Run the focused file to GREEN, inspect the real PR's manifest, independently
  compare it to Git and record exact batch/file/section counts before paid use.

## Task 2: Private usage for every review unit

Files: `scripts/ci/seal-review-usage.cjs`,
`scripts/ci/private-review-usage.cjs`, `scripts/report-pr-review-usage.cjs`,
their existing focused tests and `docs/private-pr-review-usage.md`.

- [x] Extend allowlisted encrypted context with unit ID and manifest digest;
  keep the native Codex collector, fresh per-unit homes and old report support.
- [x] Download/verify expected units before encrypted reports. Reject mismatched
  contexts, duplicate units/artifacts and unexplained new-format artifacts.
  Represent each missing expected report as unavailable. Do not accept a partial
  download as a complete all-unit cost total.
- [x] Aggregate all units with response-ID deduplication, private per-unit detail
  and reviewer totals; retain unknown counters and provider/catalog distinctions.
- [x] Run focused fixture-based crypto/report tests, including multi-unit,
  tampered/stale/missing/duplicate and legacy-run cases. No paid calls needed.

## Task 3: Workflow and documentation integration

Files: `.github/workflows/pr-gates.yml`, `.github/codex/prompts/review.md`,
`tests/js/private-review-workflow.test.js` and the owning CI gate tests.

- [x] Add a planning job after scope classification; upload plan and expected
  usage units before the paid matrix. Checkout the event merge SHA and verify
  its parent/head binding. Pin the verified action and stable compatible CLI.
- [x] Add `codex_review_batches` with fail-fast=false/max-parallel4. Each job
  uses its actual prompt/schema/image argv, unique Codex home, validated result
  artifact and existing encrypted usage capture. Continue collecting other
  batches when one fails or finds issues; no automatic paid retries.
- [x] Keep `codex_review` as final aggregate/integration. Require complete batch
  artifacts first; run integration with complete batch findings even when they
  are nonempty; publish the combined report and enforce its derived verdict.
- [x] Preserve `review_prerequisites`, existing test/E2E selectors and cloud
  gate dependencies. No test starts after a failed/omitted required review.
- [x] Extend workflow tests for those dependencies, unique paths, privacy,
  preserved trust restrictions and integration despite complete batch findings.
- [x] Update public docs with actual supplied/attested coverage limits and
  private per-unit report behavior. Keep prices in the private report only.

The official action prints transcripts and token totals by default. A checked
out copy at the pinned action commit is therefore verified as pristine and its
exact YAML hash checked by `prepare-private-codex-action.cjs`. The helper changes
only the final execution step's stdout/stderr routing to a mode-0600 temporary
file. Upstream action inputs, safety steps, command arguments and exit status
remain intact. Raw output is not uploaded. Offline fixture tests preserve the
original public action and its license, test both success and failure, and prove
that unavailable private capture prevents the child from starting.

Focused implementation evidence: 13 engine cases, 35 private-usage cases,
67 workflow/owning gate cases and 6 private-action cases passed. The 13 engine
cases were verified in an initial 12-case run plus the exact integration
preflight follow-up. The public workflow also passed Actionlint. Complete
current-head review and release suites remain the hosted publication gate.

## Task 4: Verification, review, commit and release continuation

- [ ] Independently review planner, gate, workflow and telemetry interfaces.
  Fix the combined findings, run only their owning focused local checks and
  verify the actual PR manifest with no missing files/sections.
- [ ] Commit the approved design, implementation and tests through the commit
  handoff; verify a clean index/worktree and current remote head before push.
- [ ] Resolve the separate Linux native-watch release decision before claiming
  that repair complete. Preserve the user's existing merge/release authorization.
- [ ] Launch the native PR review-first pipeline. Privately collect per-unit
  usage, collect all reviewer findings, hold tests for repairs, and require every
  complete current-head suite to pass before normal merge and publication.
