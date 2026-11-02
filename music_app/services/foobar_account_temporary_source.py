"""Bounded cleanup of retired optional raw copies, never imported facts.

There is no save, status or materialization API. New uploads use only the
existing bounded importer staging. This owner does not touch worker files,
imported history, jobs, receipts, backups or the user's original local file.
"""

# Keep schema-independent tooling importable when optional DB drivers are absent.
_TIMEOUT_ERRORS = (TimeoutError,)
_UNAVAILABLE_ERRORS = (OSError,)
try:
    from psycopg import OperationalError
    from psycopg_pool import PoolTimeout
except ImportError:
    pass
else:
    _TIMEOUT_ERRORS += (PoolTimeout,)
    _UNAVAILABLE_ERRORS += (OperationalError,)


class CleanupInterrupted(Exception):
    """The worker is no longer idle/current; roll back this maintenance pass."""


class CleanupFailure(Exception):
    """Fixed internal category only; never carries raw database error text."""


def cleanup_failure_category(error):
    if isinstance(error,CleanupFailure):
        return str(error) if str(error) in ('partial','guard') else 'failed'
    code=getattr(error,'sqlstate',None)
    if isinstance(error,PermissionError) or code=='42501':
        return 'denied'
    if isinstance(error,_TIMEOUT_ERRORS) or code in ('55P03','57014'):
        return 'timeout'
    if code=='42P01':
        return 'partial'
    if isinstance(error,_UNAVAILABLE_ERRORS):
        return 'unavailable'
    return 'failed'


def _current(should_continue):
    if should_continue is not None and should_continue() is not True:
        raise CleanupInterrupted()


def _rows(connection,sql):
    cursor=connection.execute(sql)
    try:
        return cursor.fetchmany(2)
    finally:
        cursor.close()


def expire_temporary_sources(database_url,*,should_continue=None):
    """Retire at most one legacy raw parent in the existing pool/transaction.

    Optional-schema absence is a no-op, not cached deployment authority. SQL
    and acquisition budgets are separate, not an end-to-end wall-clock promise.
    State loss after a statement raises inside the transaction to roll it back.
    """
    from .postgres_connections import pooled_connection
    _current(should_continue)
    with pooled_connection(database_url,timeout=0.25) as connection:
        _current(should_continue)
        connection.execute("set local lock_timeout = '250ms'").close()
        connection.execute("set local statement_timeout = '1000ms'").close()
        _current(should_continue)
        rows=_rows(connection,"""select
            to_regclass('integration.foobar_temporary_sources_v1') as sources,
            to_regclass('integration.foobar_temporary_source_chunks_v1') as chunks,
            to_regclass('integration.foobar_temporary_source_guard_v1') as guard""")
        _current(should_continue)
        if (type(rows) is not list or len(rows)!=1 or type(rows[0]) is not dict
                or set(rows[0])!={'sources','chunks','guard'}):
            raise CleanupFailure('partial')
        present=[value is not None for value in rows[0].values()]
        if not any(present):
            return 'absent'
        if not all(present):
            raise CleanupFailure('partial')
        rows=_rows(connection,
            'select id from integration.foobar_temporary_source_guard_v1 where id=1 for update')
        _current(should_continue)
        if rows!=[{'id':1}]:
            raise CleanupFailure('guard')
        # The feature is retired: unexpired copies are eligible too. The
        # existing parent->chunks cascade never deletes its referenced stream.
        connection.execute("""delete from integration.foobar_temporary_sources_v1
            where account_id in (select account_id from integration.foobar_temporary_sources_v1
                order by expires_at,account_id limit 1)""").close()
        _current(should_continue)
    return 'cleaned'
