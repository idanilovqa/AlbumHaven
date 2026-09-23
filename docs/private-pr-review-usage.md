# Private PR review usage

Codex execution output is captured in a runner-private temporary file. The
workflow verifies the pinned official action before applying private output routing
and selecting JSONL output with `--json`; every other review argument is preserved.
Public review artifacts contain validated findings and coverage. Separate private
usage and diagnostic artifacts contain ciphertext only; plaintext transcripts
and usage are not uploaded.

Failed executions print only a fixed diagnostic category: `provider_quota_reported`,
`authentication_failed`, `rate_limited`, `context_limit`, `transport_failure`, or
`unknown`. The local classifier reads native top-level JSONL error events and
ignores agent/tool message content and the action's console preamble or footer.
Unrecognized, conflicting, malformed, or oversized captures remain `unknown`;
the maximum classified capture is 16 MiB, without truncation. Categories report
what the error indicates, not an independently verified billing or account state.
Classifier failure preserves the original review exit code. The raw console stays
in a runner-private file and is encrypted separately for the existing owner key.
It never enters the usage envelope or the public console.

## Read encrypted execution diagnostics

Each attempted Codex batch or integration action registers its capture before
argument normalization. A runner-private 0600 sidecar binds the capture to the
repository, PR, run, attempt, head, unit, and manifest. Completion records the
original exit code; interrupted capture has an unknown exit and is marked
incomplete. Diagnostic capture and upload failures do not turn a failed review
into a success. A cancelled runner may terminate before it can upload anything.

The separate artifact is named
`private-review-diagnostic-codex-RUN-ATTEMPT-UNIT` and retains only
`codex.enc.json` for seven days. It uses the same AES-256-GCM/RSA-OAEP-SHA256
envelope and recipient key as usage, with a mandatory diagnostic payload type.
The plaintext cap is 16 MiB: larger, changing, missing, or invalid captures fail
explicitly without truncation or an artifact. These encrypted logs can contain
prompts, source excerpts, provider errors, paths, and response content. Only the
existing local private key can decrypt them.

Download that exact artifact into the existing owner-private directory. Set the
following environment variables from the verified run and review manifest before
opening it: `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`,
`REVIEW_USAGE_HEAD_SHA`, `REVIEW_USAGE_PR_NUMBER`, `REVIEW_USAGE_UNIT_ID`, and
`REVIEW_USAGE_MANIFEST_DIGEST`. Then run:

```powershell
node scripts/ci/private-codex-diagnostic.cjs open --input <CIPHERTEXT_PATH> --private-key <EXISTING_PRIVATE_KEY_PATH> --output <NEW_OWNER_PRIVATE_JSON_PATH>
```

Opening rejects a mismatched context or key, tampering, symbolic-link or junction
parents, and an existing output file. The output parent must already exist and be
owner-private. Files are created with mode 0600 on POSIX; Windows relies on the
existing directory's restricted inherited ACL. The command prints no plaintext.
The local JSON contains exact console bytes in `consoleBase64`, alongside the
execution status and context; decode or inspect them only in that private folder.

Codex review batches, the integration review, and PR Agent retain encrypted
usage artifacts for each GitHub Actions run and attempt. The readable report
stays on the owner's machine.
CI receives the public encryption key only. It does not receive a private
decryption key or an OpenAI billing/admin key, and does not publish a cost table.

## Read one run

From the app checkout, with GitHub CLI authenticated:

```powershell
node scripts/report-pr-review-usage.cjs --run <GITHUB_RUN_ID>
```

The command selects the latest attempt. Add `--attempt 1` for an earlier attempt.
For batched runs, it first reads the expected-unit manifest and checks the exact
repository, run, attempt, and head commit. It downloads every declared encrypted
artifact and verifies Codex unit IDs and manifest digests before combining them.
Unexpected units or a missing manifest alongside batch artifacts stop the report.
Legacy runs retain their two-reviewer artifact format. The command prints the
paths of the local Markdown and JSON reports. On Windows their default folder is
`%LOCALAPPDATA%\Album Haven\Review Usage`; on other systems it is
`~/.local/share/Album Haven/Review Usage`.

The private key is `private-key.pem` in that folder. An alternate location can be
supplied with `--private-key` or `ALBUM_HAVEN_REVIEW_USAGE_PRIVATE_KEY`. Optional
`--repo owner/repo` and `--output-prefix PATH` select a repository or report path.
The output directory must already exist. Private report suffixes and
`private-key.pem` are ignored by Git in this checkout.

## What the report means

Each reviewer/model row contains observed responses, failures, input tokens,
cached input, cache writes, output tokens, reasoning tokens, an estimated USD
amount when calculable, and the source of that estimate. Cached tokens are part
of input; reasoning tokens are part of output. They are not added twice.
Batched reports also include per-unit detail and reviewer totals. Repeated
response IDs across units are counted once, attributed to the first unit in
manifest order; excluded copies are identified in the unit detail. A missing
unit makes the reviewer total unknown while preserving its known subtotal.

Codex uses its native per-response records, including child-agent sessions.
PR Agent uses a scoped LiteLLM callback. Repeated notifications with the same
response ID are deduplicated. Cumulative session counters are not summed.
Failed actions retain any available records but mark coverage partial. Missing
artifacts, unsupported data, absent counters, and interrupted calls remain
unknown; they do not prove zero spend. A fully cancelled job may never upload an
artifact. Old runs without these artifacts cannot be reconstructed by this tool.

Prices are estimates for observed calls, not the OpenAI invoice. The report
labels SDK estimates separately from its dated standard-rate catalog, records
pricing assumptions and sources, and does not claim billing completeness.
Codex's requested model may differ from the billed model. Unknown models or
unsupported service tiers can prevent a catalog estimate.

This measures API usage, not review coverage: it does not prove every file or
line of a PR was examined. PR Agent can clip a large diff even when full review
was requested.

The current PR Agent `/review` path makes one prediction from a diff that fits
its token budget. Its coverage footer lists omitted files; it does not schedule
another prediction for those files. Repeating the same oversized review does
not ensure the omitted files are examined. Codex also reports actual inspection
limits separately from the requested scope. The successfully reviewed-head
marker records passing review and CI results, not exhaustive file coverage.

The batched Codex review assigns the full Git diff to bounded jobs and checks
each unit's inspection attestations before an integration review. Missing,
stale, duplicate, or malformed results block coverage. This establishes supplied
content and completed attestations, not the quality of attention or the absence
of bugs. The integration review reports its own limits.

## Privacy and operation

Only allowlisted usage and run metadata enter the report. Prompts, code, response
text, credentials, and exception messages are excluded. Temporary runner records
are encrypted using AES-256-GCM with a random data key, wrapped for the committed
RSA public key using OAEP-SHA256. Only the encrypted `.enc.json` files are
uploaded as usage records. The separate public expected-unit manifest contains
only run and coverage identities, never tokens or costs. Telemetry failures do
not change the reviewers' verdicts or release gate; the local report shows a gap.

Keep a private backup of the decryption key. Losing it makes existing artifacts
unreadable. To provision another recipient, generate a new key pair into new,
nonexistent paths and commit only the public key:

```powershell
node scripts/ci/private-review-usage.cjs keygen --private-key <PRIVATE_PATH> --public-key <PUBLIC_PATH>
```

Keep old private keys when rotating the committed public key. Artifacts use the
repository's normal retention period, so download reports before they expire.
PR Agent's pinned action currently references a mutable Docker image, and Codex's
action selects its CLI version. Upstream usage-schema changes can produce gaps;
the first funded run must confirm both collectors against the hosted runtimes.

## Compare with OpenAI billing

Open [OpenAI Usage](https://platform.openai.com/usage), select the organization,
project and date range, then inspect Responses and Chat Completions activity.
Export activity grouped by model/API key for tokens and export cost data for
charges. Dashboard timestamps use UTC. A shared key and model cannot reliably
separate historical reviewers; use the private per-run report for that attribution
on future runs. See the [Usage Dashboard guide](https://help.openai.com/en/articles/10478918-api-usage-dashboard).

For independent billing attribution in the future, assign each reviewer its own
project or API key. This implementation does not change credentials or issue
extra inference requests.
