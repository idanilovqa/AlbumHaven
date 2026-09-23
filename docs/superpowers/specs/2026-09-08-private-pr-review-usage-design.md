# Private PR reviewer usage reporting

Owner request (2026-09-08): provide a per-PR-run usage rundown and keep token/cost reports private. Only PR Agent and Codex remain reviewers. Funding was blocked during offline implementation; the owner subsequently restored credits and explicitly authorized hosted reviews, repair before E2E, and merge/release after full CI passes.

## Design

Capture allowlisted per-response token metadata through Codex native session usage records and a LiteLLM CustomLogger callback registered only inside the PR Agent action through its scoped PYTHONPATH. Preserve reviewer API requests, prompts, capabilities, models, verdicts, and failure behavior. Do not use a custom API proxy, organization billing credential, or public cost/comment switches.

Native records include observed responses, not every HTTP retry or a guaranteed bill-complete ledger. Distinguish records with usage, failed client calls with unknown usage, and unavailable telemetry. Codex model attribution comes from durable requested model context, not a billing-model guarantee. Missing data never becomes zero.

The normalized private JSONL record interface is schemaVersion=1, reviewer (`codex` or `pr-agent`), responseId (nullable), callId (nullable), status (`success` or `failure`), model (nullable), modelAttribution (`requested` or `response`), serviceTier (nullable), usage (nullable object containing inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens, totalTokens as nonnegative integers or null). Optional providerEstimatedCostUsd is a nonnegative number or null. Retain no prompts, response content, credentials, errors, local paths, user identity, or arbitrary payload fields.

A Node helper seals the metadata and run/attempt/head/reviewer context with AES-256-GCM and wraps the random data key using RSA-OAEP-SHA256. GitHub receives only encrypted artifacts. The private key stays outside version control on the owner's machine; the public recipient key can be committed. Plaintext runtime capture is confined to runner-local temporary storage and never uploaded. Failure/cancellation capture is best effort; missing reports remain explicit gaps.

A local helper downloads encrypted artifacts for an exact GitHub run and attempt, decrypts them locally, and writes private JSON/Markdown summaries grouped by reviewer and model. Report observed token categories and response counts; calculate clearly labeled standard-rate estimates from a dated pricing table where attribution and counters permit, retaining missing or unsupported costs as unknown. Reasoning tokens are already included in output; cached input is already included in input. Do not add either twice. Display documented pricing assumptions and incomplete coverage. No balances, actual invoices, or exact historical charges are inferred.

## Verification and rollout

Use offline fixture records and local throwaway crypto keys for tests: repeated cumulative Codex events, child records, response deduplication, missing usage, failures, malformed records, negative counters, sensitive-field stripping, multiple models, missing artifacts, wrong keys, tampered ciphertext, request-size pricing boundary, and no double counting. Exercise callback registration and scalar capture without contacting a model. Validate workflow dependencies and continued review-success gating. Keep public reporting disabled and verify artifacts contain no plaintext usage.

The initial rollout plan deferred paid CI. After the owner restored credits, commit
and push through the native PR pipeline for authoritative hosted verification.
Review findings must hold the test jobs until repaired. No merge is authorized by
telemetry checks alone; the complete current-head pipeline must pass.

## Implementation checkpoint

Implemented the two collectors, encryption and local report commands, encrypted-only
artifact steps, public recipient key, and owner documentation. Focused offline
verification passed: 16 Python callback cases, 9 Codex collector cases, 18 encryption
and summary cases, and 24 integration/workflow/release-gate cases (67 total).
Independent YAML validation confirmed the 15-job dependency graph and preserved
review prerequisites and verdicts. Independent review findings were repaired and
verified. Local test suites ran sequentially; no inference requests were made.

The local GitHub reporting command was also exercised against existing run
34280919801, attempt 1. It resolved the expected head and produced a private report
with both historical usage artifacts unavailable and costs unknown. At that
checkpoint, hosted capture still awaited funding. The implementation guide is
[private-pr-review-usage.md](../../private-pr-review-usage.md).

The funded-run intake also repaired PR Agent's existing output gate: valid JSON
containing findings previously passed. The guard now requires the documented flat
review schema, an empty key-issues list, and an explicit clear security verdict
when present. Four focused checks passed after three reproduced failures; the
metadata score and review effort do not block a clear review. Both reviewer jobs
now hold downstream tests when they report findings.

Hosted capture was verified on run 34288372612 at commit f644300: both encrypted
reviewer artifacts were uploaded and the local command decrypted and summarized
them successfully. Readable usage and cost details remain in the owner's private
report. Both reviewers reported product findings, and all downstream test jobs
were held; this run does not authorize release.
