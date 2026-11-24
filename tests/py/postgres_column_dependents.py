"""Schema surgery inside a rolled-back test transaction that keeps later migrations' triggers."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from contextlib import contextmanager


@contextmanager
def triggers_depending_on_columns_set_aside(connection, table: str, columns: Iterable[str]) -> Iterator[list[str]]:
    """Drops the triggers on ``table`` that depend on any of ``columns`` (for example a WHEN clause a
    later migration added) and recreates them unchanged afterwards, so a test can drop and rebuild
    those columns as an older schema had them. Yields the names of the triggers set aside."""
    from psycopg.rows import tuple_row

    with connection.cursor(row_factory=tuple_row) as cursor:
        triggers = cursor.execute(
            """
            select distinct trigger.tgname, pg_get_triggerdef(trigger.oid)
            from pg_trigger as trigger
            join pg_depend as dependency
              on dependency.classid = 'pg_trigger'::regclass and dependency.objid = trigger.oid
            join pg_attribute as attribute
              on attribute.attrelid = dependency.refobjid and attribute.attnum = dependency.refobjsubid
            where trigger.tgrelid = %s::regclass
              and not trigger.tgisinternal
              and attribute.attname = any(%s)
            order by trigger.tgname
            """,
            (table, list(columns)),
        ).fetchall()
        for name, _definition in triggers:
            cursor.execute(f'drop trigger "{name}" on {table}')
        yield [name for name, _definition in triggers]
        for _name, definition in triggers:
            cursor.execute(definition)
