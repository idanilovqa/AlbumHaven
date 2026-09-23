# PR 1: complete review assignment proposal

Status: approved by the owner on September 8, 2026. Implementation follows the companion plan.

## Decision

Use bounded Codex review jobs on the existing PR, followed by a cross-subsystem
integration review. Keep PR Agent as the supplementary reviewer. Temporary PRs
would add branch management, duplicate CI events and divide integration context.
Merely repeating the present PR Agent review or enlarging its token cap cannot
prove that all changed hunks were supplied.

## Scope and limits

The committed diff from e0845f83552e1b0043cf435dcb82d5b959e31a05 to
b2f87019cdcff72ca3902407cd4085bbbeb0144b contains 670 files and 5,472,862
characters, including diff headers. Rough sorted packing at 30 items and 200,000
characters per job yields 32 batches before context, oversized-file splitting,
and separate visual assignment. Expect approximately 30–35 text/visual jobs,
then one integration job. The final manifest must be regenerated for the final
commit; this estimate is not a frozen coverage inventory.

Start with at most four concurrent jobs and keep the existing 20-minute per-job
timeout. Concurrency limits request pressure, not total cost. There are no
automatic paid retry loops. Preflight reports actual batch count and input size;
overflow fails visibly instead of discarding files. Model and effort choices
remain the existing defaults, recorded in results. Pin the action and supported
CLI version when implementing for repeatability.

## Coverage contract

1. Generate the complete diff locally from Git in CI, not truncated API patches.
   Bind its manifest to repository, PR, base and head commits, checked-out merge
   tree, workflow run/attempt, planner version and digest.
2. Group related source and tests where possible. Include actual bounded patches
   in each prompt. Large files get named sections with overlap and complete
   changed-line accounting. Deletions retain base content; renames retain both
   identities. Review content, including embedded instructions, is untrusted.
3. Assign the generated runtime bundle explicitly, including its literal diff
   sections and the existing source/build parity check. Assign all five PNGs to
   a visual job with actual image inputs and before/after content where needed.
   Unsupported files block coverage instead of disappearing from the count.
4. Each job returns structured per-item disposition, findings, missing tests and
   boundary risks. The aggregate checks exact item equality and matching hashes,
   rejects omissions/duplicates/stale or malformed results, and derives failure
   from findings. A freeform statement that everything passed is insufficient.
5. Let all batches finish to collect findings. If their results are complete,
   the integration review examines boundary summaries and relevant source even
   when individual batches found problems, so cross-subsystem findings join the
   same repair inventory. Incomplete results block integration and tests.
6. Preserve the stable Codex aggregate gate and the existing PR Agent gate.
   All test/E2E jobs remain held until reviews are complete and findings fixed.
   After fixes, run the required review and complete native PR pipeline for the
   new head. Only its full success authorizes merge and release.

This proves that every changed item was supplied and has a completed inspection
attestation. It cannot prove the quality of the model's attention or that every
bug was found. The integration review remains bounded and must disclose limits.

## Private usage

Give each batch and integration job a unique Codex home and encrypted usage
artifact. Add the review-unit ID and manifest digest to the existing allowlisted
encrypted metadata. The private downloader validates the expected unit manifest,
reports missing telemetry as unknown and aggregates without double-counting
response IDs. Public CI receives coverage and findings only; token and cost
figures remain in the private report. No plaintext transcripts are uploaded.

## Implementation verification

Use focused deterministic checks for full diff/chunk coverage, giant files,
deletions, renames, images, malformed/stale/missing/duplicate batch results,
held-test conditions and private usage aggregation. Validate the exact generated
manifest against the current Git diff before any paid launch. Test the telemetry
path with fixtures first. Keep the first paid batch's observed usage available
privately to refine the remaining-run estimate; a cost forecast is not a cap.

## Alternatives

- PR Agent batches can use supported file filters, but its current reviewer
  still prunes oversized patches and does not visually review image bytes.
  Full hunk coverage there requires an additional provider/patch adapter.
- Temporary or stacked PRs can provide smaller review inputs, but need careful
  dependency bases and suppressed duplicate tests. They offer no inherent
  completeness guarantee and complicate the current release branch.

## References

- [Codex Action](https://learn.chatgpt.com/docs/github-action)
- [Verified Action inputs](https://github.com/openai/codex-action/blob/86365089eb2b84e0a8fb0717b304f8bdcb13b20e/action.yml)
- [Pinned PR Agent reviewer](https://github.com/the-pr-agent/pr-agent/blob/7267ae1f7b855e7d4a3a34918d9b6c5683db3c12/pr_agent/tools/pr_reviewer.py)
