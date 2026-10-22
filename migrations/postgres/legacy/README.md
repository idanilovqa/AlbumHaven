# Historical migration inventory

Files in this directory are immutable evidence for recognized deployed histories.
Migration runners execute only the active SQL files in the parent directory.
Never apply, rename, renumber, or manufacture a ledger entry for an archived file.

The Home development lineage supplied `0081_scope_track_preferences_by_library.sql`
with SHA-256 `90e9ebdc18257df4f85df8da2a6e312fdda81b844dfed6f856792d345eed1d23`.
Main used the same ordinal for a different migration. Its canonical sequence is
preserved. Forward migration `0087_reconcile_track_preferences_library_scope.sql`
accepts the exact recognized Home history without replaying it, or performs the
transactional index transition for a main-only or new database.

The migration ledger retains the original full filename, checksum and timestamp.
An unknown filename, changed checksum, invalid index, partial index transition,
or conflicting unique index stops the upgrade. Resolve the inconsistency using
verified deployment evidence before retrying; do not edit the ledger to suppress
the error.
