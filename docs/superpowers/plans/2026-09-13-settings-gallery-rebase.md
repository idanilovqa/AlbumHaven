# Settings rebase onto merged Gallery

The owner requested a local rebase and paused the remote push.

- Base: `origin/main` at `38f740a` (Gallery PR #2).
- Recovery branch: `codex/settings-before-gallery-rebase-b4e753f`.
- Replay boundary: the four Settings commits after `8111f2e`. Earlier Gallery commits already exist on main under different IDs.
- Preserve Gallery's asynchronous settings write lock, warning acknowledgements, duration summaries, native player provenance, focus/scroll restoration, and review-scoped CI matrix alongside Settings changes.
- Settings migrations moved from 0063–0067 to 0068–0072. No database migration was applied during this rebase. Local databases with the former Settings migration names need reconciliation before migration execution; do not silently rewrite their migration ledger.
- No paid review, merge, release, or push was performed.

Verification:

- Search, Settings events, appearance preview, response state, focused navigation, and lifecycle: 185 JavaScript tests passed.
- Appearance persistence, loop-style permissions, and migration inventory: 224 Python tests passed, 8 skipped.
- CI inventory/shard tests: 49 passed initially; the remaining shared-reader count changed from 21 to 26 for the five Settings cases, and its exact rerun passed.
- Additional component/source assertions: 208 passed, 4 failed. Remaining failures concern the item-interaction outline assertion, the saved-loop Play border assertion, and two tests referencing the removed `buildLibraryWatchHealthProblemRow` helper. These are retained for follow-up rather than silently dropping assertions. Full regression and browser visual validation remain outstanding.
- All conflicted JavaScript files and changed Python files passed syntax checks.

This is a local integration checkpoint, not release acceptance. Runtime logs and scratch artifacts remain untracked.
