# Case-Tagged Focused CI Design

**Status:** Owner-approved September 8, 2026.

## Goal

Replace shard-sized focused E2E feedback with an automated three-stage repair ladder:

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

## PR Control Surface

The existing `ci:focused-e2e` label remains the opt-in repair-mode switch. A hidden, machine-owned marker in the pull-request body supplies the selection without creating one repository label per case:

```html
<!-- album-haven-focused-e2e:{"exactCases":["FTC-UTIL-PROBLEMS-007"],"areas":["problematic-files"]} -->
```

The marker accepts one or more stable FTC ID prefixes and one or more supported area names. It is parsed as untrusted input, size-bounded, normalized, and validated against the checked-in functional contract before any test command is constructed. A second label, `ci:focused-related`, is workflow-owned and identifies stage 2. Humans and agents set only the marker plus `ci:focused-e2e`; CI owns stage transitions.

## Pipeline State Machine

When `ci:focused-e2e` is present and `ci:focused-related` is absent, review scope emits `focused_stage=exact`, the owning functional shards only, and exact case selectors. The shard runner passes only those exact titles to Playwright. Every unselected suite, reviewer, performance job, Phase 7 job, and foundation job skips.

After an exact-stage success, the focused gate retains `ci:focused-e2e`, adds `ci:focused-related`, and leaves the PR marker intact. That label event starts a new run. Review scope emits `focused_stage=related`, resolves all cases carrying any selected area tag across every owning shard, and runs only those cases.

After a related-stage success, the focused gate removes both focused labels, removes the hidden marker, applies `ci:full-review`, and thereby starts the complete review-first pipeline. Any focused failure leaves the marker and stage labels unchanged so the next repair push reruns the failed stage. Exact or related success remains non-authoritative.

## Review And Release Invariants

- Full-mode review runs before tests.
- E2E still runs after review even if review fails, and the final inventory combines review and test findings.
- Diff-only review is permitted only below 250 functional changed lines; 250 or more uses full review.
- Documentation-only changes skip review.
- Focused stages skip review and unrelated suites.
- No merge or release may rely on focused evidence.
- The final full pipeline runs every required suite and full review from the committed PR head.

## Security And Failure Handling

The selector parser never evaluates PR-body content and never interpolates raw selectors into a shell command. It emits JSON files or JSON workflow outputs consumed as argument arrays. Fixture secrets remain confined to same-repository pull requests, and trusted fixture download code is checked out from the base revision before pull-request code executes. Invalid markers, ambiguous FTC prefixes, unsupported areas, empty selections, unexpected executed jobs, or failed selected jobs make the focused gate fail without promotion.

## Verification

Unit tests cover marker parsing, size limits, exact and area resolution, multi-shard area selection, invalid and ambiguous selectors, stage classification, gate transitions, and full-pipeline promotion. Workflow contract tests prove only selected cases are passed to the shard runner and that review/foundation/Phase 7/performance jobs skip in focused mode. The current repair proves the ladder with `FTC-UTIL-PROBLEMS-007`: exact local E2E first, exact hosted E2E second, tagged related cases third, then the complete review-first pipeline.
