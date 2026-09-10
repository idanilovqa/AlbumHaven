# Case-Tagged Focused CI Design

**Status:** Owner-approved September 8, 2026.

## Goal

Reproduce and verify failures with exact local tests, then push directly to the complete review-first CI pipeline. Hosted focused execution is an exception for failures that are unusually difficult to diagnose locally or depend on CI infrastructure. State the reason before using it, and return to full CI when the focused failure is fixed.

For that exception, replace shard-sized feedback with an operator-orchestrated repair ladder:

1. run only the exact failing or changed case;
2. run every E2E case carrying a selected functional-area tag, regardless of shard placement;
3. run the complete authoritative review-first pipeline.

The full pipeline remains the only release authority. Focused stages never publish reviewed-head evidence and never replace the complete CI failure inventory.

## Selection Contract

Functional Playwright cases use stable FTC IDs in their titles and native Playwright tags in the form `@area:<name>`. The initial supported taxonomy is:

- `@area:gallery-search`
- `@area:album-details`
- `@area:cover-providers`
- `@area:tag-edit`
- `@area:problematic-files`
- `@area:utility-rules`
- `@area:playback`
- `@area:loops`
- `@area:responsive-visual`

A case may carry more than one tag. Tags describe product behavior, not runner or fixture placement. The functional-shard validator must discover tags from Playwright's test listing, prove every owned functional case has at least one supported area tag, and resolve an area to the exact case titles and owning shards. Unknown IDs, unknown tags, missing tags, and selectors that resolve to no cases fail closed.

Phase 7 cases also use stable FTC IDs in their titles. A selected
`ci:e2e:phase7-auth` or `ci:e2e:phase7-admin` target may use `exactCases`
without a functional-area selector: exact stage passes an escaped FTC-ID grep
argument to that suite, while related stage expands to the complete selected
Phase 7 suite. This supports the exceptional exact → related → full ladder for Phase 7
without pretending its authentication fixtures belong to functional shards.

## PR Control Surface

The existing `ci:focused-e2e` label remains the opt-in repair-mode switch. A hidden, machine-owned marker in the pull-request body supplies the selection without creating one repository label per case:

```html
<!-- album-haven-focused-e2e:{"exactCases":["FTC-UTIL-PROBLEMS-007"],"areas":["problematic-files"]} -->
```

For functional selection, the marker accepts one or more stable FTC ID prefixes
and one or more supported area names. For a labeled Phase 7 target, it accepts
exact FTC IDs without `areas`. It is parsed as untrusted input, size-bounded,
normalized, and validated before any test command is constructed. Promotion
adds a validated `{stage, headSha}` object to bind the next stage to one exact
commit. A second label, `ci:focused-related`, identifies stage 2. The
authenticated release operator owns stage transitions after validating the
completed run against the current PR head.

## Pipeline State Machine

When `ci:focused-e2e` is present and `ci:focused-related` is absent, review scope
emits `focused_stage=exact`, the selected owning jobs, and exact case selectors.
Functional shard runners pass only resolved exact titles to Playwright. A
selected Phase 7 job passes only the escaped FTC IDs to Playwright. Every
unselected suite, reviewer, performance job, Phase 7 job, and foundation job
skips.

After an exact-stage success, the release operator verifies that the successful
run's head SHA is still current, writes `promotion.stage=related` plus that SHA
into the marker, retains `ci:focused-e2e`, then clears and reapplies
`ci:focused-related`. Clearing first guarantees a real authenticated label event
even when an older related label survived a new push. Review scope selects
related only when the promotion SHA matches the event head; otherwise it selects
exact. Functional related selection resolves all cases carrying any selected
area tag across every owning shard. Phase 7 related selection runs the complete
selected Phase 7 suite.

After a related-stage success, the release operator performs the same head check and creates a local empty promotion commit, whose tree is identical to the verified related-stage head. Before pushing it, the operator writes `promotion.stage=full` plus the promotion commit SHA into the marker, removes both focused labels, and applies `ci:full-review`. Label events against the old remote head fail safe to exact selection because their head does not match. Pushing the prepared commit then emits the native `synchronize` payload required by every reviewer and starts the complete review-first pipeline. CI deliberately does not self-dispatch or mutate these labels: `GITHUB_TOKEN` mutations do not trigger a new workflow, while dispatch events lack the pull-request payload required by the review actions. Any focused failure leaves the marker and stage labels unchanged. Promotion evidence that does not match the event head always falls back to exact selection. Exact or related success remains non-authoritative.

## Review And Release Invariants

- Full-mode review runs before tests.
- Every applicable reviewer must succeed before tests start. A failed, cancelled, missing, or unexpectedly skipped review holds tests.
- Collect every applicable review result before fixing findings. A validated finding requiring a new commit supersedes that head: preserve the evidence and stop its run before expensive tests start, verifying that its jobs have stopped. A terminal failed review already holds tests.
- Once reviews pass, let every required test suite finish and collect the complete test failure inventory before fixing it. Verify fixes locally and push a replacement head to the complete review-first pipeline.
- Diff-only review is permitted only below 250 functional changed lines; 250 or more uses full review.
- Documentation-only changes skip review.
- Focused stages skip review and unrelated suites.
- No merge or release may rely on focused evidence.
- The final full pipeline runs every required suite and full review from the committed PR head.

## Security And Failure Handling

The selector parser never evaluates PR-body content and never interpolates raw selectors into a shell command. It emits JSON files or JSON workflow outputs consumed as argument arrays. Fixture secrets remain confined to same-repository pull requests, and trusted fixture download code is checked out from the base revision before pull-request code executes. Invalid markers, ambiguous FTC prefixes, unsupported areas, empty selections, unexpected executed jobs, or failed selected jobs make the focused gate fail without promotion.

## Verification

Unit tests cover marker parsing, size limits, functional and Phase 7 exact
selection, area resolution, multi-shard area selection, invalid and ambiguous
selectors, stage classification, new-head reset behavior, and gate validation.
Workflow contract tests prove only selected cases are passed to the owning job,
unrelated review/foundation/E2E jobs skip in focused mode, and focused CI cannot
mutate or dispatch the next stage. The earlier Phase 7 hosted diagnosis exercised the exceptional ladder
with `FTC-PERMISSIONS-009`: two exact local cases, the same two hosted cases, the
complete eight-case related Admin suite, then the complete review-first
pipeline.
