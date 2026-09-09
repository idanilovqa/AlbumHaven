# Private PR review usage

The two reviewers, Codex and PR Agent, retain encrypted usage artifacts for each
GitHub Actions run and attempt. The readable report stays on the owner's machine.
CI receives the public encryption key only. It does not receive a private
decryption key or an OpenAI billing/admin key, and does not publish a cost table.

## Read one run

From the app checkout, with GitHub CLI authenticated:

```powershell
node scripts/report-pr-review-usage.cjs --run <GITHUB_RUN_ID>
```

The command selects the latest attempt. Add `--attempt 1` for an earlier attempt.
It downloads only that run's two encrypted artifacts and checks their repository,
head commit, reviewer, and attempt before combining them. It prints the paths of
the local Markdown and JSON reports. On Windows their default folder is
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

For a large PR, record an explicit inventory of changed subsystems, review each
bounded group with its callers and tests, and collect the findings before the
next paid run. Automated batching would need to record coverage for every
batch, reject missing batches, and reconcile findings across subsystem
boundaries. Increasing the context budget alone does not establish coverage.

## Privacy and operation

Only allowlisted usage and run metadata enter the report. Prompts, code, response
text, credentials, and exception messages are excluded. Temporary runner records
are encrypted using AES-256-GCM with a random data key, wrapped for the committed
RSA public key using OAEP-SHA256. Only the encrypted `.enc.json` files are
uploaded. Telemetry failures do not change the reviewers' verdicts or release
gate; the local report shows a gap.

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
