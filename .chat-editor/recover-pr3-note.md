### Verified PR 3 recovery batch — September 19, 2026

The owner explicitly requested review and application of the saved run-202 repair,
validation follow-up and cleanup-lifecycle patches to the actual PR branch. This
continues the approved current-stack contract reconciliation above; it does not
authorize a merge, release, snapshot refresh, or a change to test timing budgets.
The baseline is `ff81ffd4e846fa6606054b9d3b30dadffa4a6e18`.

All jobs of PR Gates #202 attempt 2 (`35419743702`) completed before this batch.
The complete, checksum-verified logs contain nine failed cases: one concurrent
pytest-root cleanup case; two AlbumTrackTable duration cases and one retained
Problems selection-metadata case; two disabled Tag Editor Apply cases; and three
playback/Utilities cases covering exclusion reload, saved-loop card insets and
the retained regular-mode waveform canvas. The saved repairs cover that complete
inventory. Older published repair batches are not applied a second time.

The validation follow-up additionally retains unknown file selections with a
missing path for server validation. The cleanup repair retains ownership and
physical-directory identity checks on every attempt, and registers the generated
root's final cleanup before later resources so they close first. Explicit
basetemp directories are neither claimed nor removed. No cleanup retry count or
delay, existing E2E timeout, fixture population, permission or audio-engine
contract changes.

Fresh local verification reproduced redundant exclusion persistence (20 rules
instead of the two independent rules), then passed all 20 exclusion tests after
the fix. The late-resource cleanup regression failed before implementation;
after implementation, 15 harness tests passed with the two existing Windows-only
cases left for native Windows. All 168 related runtime checks passed with the
genuine pinned icon assets restored to the source-only verification snapshot.
Runtime regeneration and production-parity checks passed. Linux results are not
represented as native Windows or browser acceptance.

The publication executor checks the exact PR head, every edited source blob,
each saved patch digest and every resulting file hash; it stages only this
reviewed repair inventory and uses a non-force push. Native Windows focused
Python, Node and pinned-Chrome component checks must succeed before publication.
The actual PR branch then requires a new complete native PR Gates run. No Task 9
checkbox or final manual-acceptance status is advanced by this checkpoint.

