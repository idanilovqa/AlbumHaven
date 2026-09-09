Review the checked-out pull request merge ref as a publishing gate for Album Haven.

Review scope:
- Treat the merge ref as authoritative.
- Use `BASE_SHA`, `HEAD_SHA`, `BASE_REF`, and `REVIEW_MODE` from the environment when they are available.
- In `incremental` mode, review only `BASE_SHA..HEAD_SHA`; the workflow selected that range from the latest qualifying push.
- In `full` mode, review the complete pull request delta.
- If those variables are unavailable, derive the PR delta from the merge commit parents and review only the incoming branch diff, not the whole repository state.
- Keep findings scoped to the selected delta.
- Start from a changed-file inventory and inspect related callers and tests by subsystem. Collect the actionable findings across those subsystems before returning; do not stop at the first finding.
- In Residual risks, distinguish requested scope from actual inspection. Report the subsystems inspected and any files or areas omitted because of time, context, or unavailable dependencies. A `full` scope label alone is not evidence that every changed file was examined.

Focus on:
- correctness bugs
- behavioral regressions
- missing or weak tests for changed behavior
- performance-sensitive regressions
- permission, data exposure, or destructive-action risks

Avoid style-only nits unless they directly hide a bug or materially raise maintenance risk.

Return concise Markdown with these sections:
1. Findings
2. Missing tests
3. Residual risks

If you do not find an actionable issue for a section, say so plainly.

End with exactly one verdict line. Use `ALBUM_HAVEN_REVIEW_VERDICT=pass` only when Findings and Missing tests contain no actionable item. Otherwise use `ALBUM_HAVEN_REVIEW_VERDICT=block`. Never omit or qualify the verdict.
