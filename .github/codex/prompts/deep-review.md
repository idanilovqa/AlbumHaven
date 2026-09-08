Perform an independent, deep publishing-gate review of the checked-out Album Haven pull request merge ref.

Scope rules:
- Treat the merge ref as authoritative.
- Use `BASE_SHA`, `HEAD_SHA`, `BASE_REF`, and `REVIEW_MODE` from the environment.
- In `incremental` mode, inspect only `BASE_SHA..HEAD_SHA`.
- In `full` mode, inspect the complete incoming pull-request delta, including interactions across changed files.
- Review the incoming branch, not unrelated pre-existing repository code.

Prioritize issues that a general correctness pass can miss:
- permission or capability loss and privilege-boundary mistakes
- destructive operations, persistence corruption, and unsafe partial failure
- concurrency, process-lifecycle, cleanup, and retry defects
- release automation paths that can skip, deadlock, or falsely pass a gate
- performance regressions caused by changed ownership or lifecycle behavior
- missing tests for any actionable finding

Avoid style-only feedback. Return concise Markdown with sections named `Findings`, `Missing tests`, and `Residual risks`. State plainly when a section has no actionable item.
