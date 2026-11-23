"""Index-only plans for keyed statements on tables that may have no statistics yet."""
from __future__ import annotations

from contextlib import contextmanager

_SETTINGS = ("enable_seqscan", "enable_hashjoin", "enable_mergejoin")


@contextmanager
def keyed_plan(connection):
    """Run the enclosed keyed statements (a save's or a drain's reads, by album, track or file keys) with
    index lookups and nested loops only, then restore the session's settings.

    Right after a bulk change, production tables can have no statistics (case 55). The planner then
    misjudges their size and scans every row for a lookup that has an index. The keys already bound the work,
    so turning the alternatives off is exact, not a guess. The settings are transaction-local (set_config
    with is_local), restored to their previous values on exit, and never leak to other statements.
    """
    row = connection.execute(
        "select current_setting('enable_seqscan') as seqscan, current_setting('enable_hashjoin') as hashjoin,"
        " current_setting('enable_mergejoin') as mergejoin").fetchone()
    if isinstance(row, dict) and {"seqscan", "hashjoin", "mergejoin"} <= set(row):
        previous = {name: row[name] for name in ("seqscan", "hashjoin", "mergejoin")}
    elif isinstance(row, (tuple, list)) and len(row) == 3:
        previous = dict(zip(("seqscan", "hashjoin", "mergejoin"), row))
    else:
        # A test double with no settings to read: nothing to restore.
        previous = None
    connection.execute(
        "select set_config('enable_seqscan', 'off', true), set_config('enable_hashjoin', 'off', true),"
        " set_config('enable_mergejoin', 'off', true)")
    yield
    # On an error the enclosing transaction or savepoint rolls back, which undoes these local settings too,
    # so they are restored only here (a statement on an aborted transaction would hide the error).
    if previous is not None:
        connection.execute(
            "select set_config('enable_seqscan', %(seqscan)s, true), "
            "set_config('enable_hashjoin', %(hashjoin)s, true), "
            "set_config('enable_mergejoin', %(mergejoin)s, true)", previous)
