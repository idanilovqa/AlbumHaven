"""Bounded, advisory own-account job discovery; never resume or authority proof."""
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from uuid import UUID

from . import foobar_account_prepare_gate as gate
from .foobar_account_authority import current_foobar_account_transaction
from .foobar_account_source_postgres import SourceUnavailable, _query
from .foobar_account_import_jobs_readiness import require_foobar_job_schema_on_connection
from .foobar_account_job_discovery_readiness import require_foobar_job_discovery_on_connection

DISCOVERY_PHASE_BYTES = 65536
MAX_FRAME_BYTES = 512
PAGE_SIZE = 20


class FoobarJobListInvalid(gate.PrepareInvalid):
    """Invalid selector/cursor syntax, not a database readiness failure."""


@dataclass(frozen=True, slots=True)
class FoobarJobListCursor:
    updated_at: str
    source_ref: str
    job_ref: str


@dataclass(frozen=True, slots=True)
class FoobarJobListItem:
    source_ref: str
    job_ref: str
    created_at: str
    updated_at: str
    confirmed_rows: int
    total_rows: int
    cancel_requested: bool


@dataclass(frozen=True, slots=True)
class FoobarJobListPage:
    unfinished: bool
    items: tuple[FoobarJobListItem, ...]
    next_cursor: FoobarJobListCursor | None


_FRAME_SQL = """with f as materialized(select convert_from(%b::bytea,'UTF8')::jsonb j),
x as materialized(select (j->>'account_id')::bigint account_id,
(j->>'updated_at')::timestamptz updated_at,(j->>'source_ref')::uuid source_ref,
(j->>'job_ref')::uuid job_ref from f)
"""
_SELECT_SQL = """select j.source_ref::text source_ref,j.job_ref::text job_ref,
j.created_at,j.updated_at,j.confirmed_through as confirmed_rows,j.total_rows,
j.cancel_requested from integration.foobar_import_jobs_v1 j
where j.account_id=(select account_id from x)"""
_KEYSET_SQL = """ and (j.updated_at,j.source_ref,j.job_ref)<((select updated_at from x),
(select source_ref from x),(select job_ref from x))"""
_ORDER_SQL = """ order by j.updated_at desc,j.source_ref desc,j.job_ref desc limit 21"""
# Fixed booleans select fixed SQL; no request-controlled identifiers, order, or limit.
_LIST_SQL = {
    (False, False): _FRAME_SQL + _SELECT_SQL + _ORDER_SQL,
    (False, True): _FRAME_SQL + _SELECT_SQL + _KEYSET_SQL + _ORDER_SQL,
    (True, False): _FRAME_SQL + _SELECT_SQL + ' and j.confirmed_through<j.total_rows' + _ORDER_SQL,
    (True, True): _FRAME_SQL + _SELECT_SQL + ' and j.confirmed_through<j.total_rows' + _KEYSET_SQL + _ORDER_SQL,
}


def _uuid(value):
    if type(value) is not str or len(value) != 36:
        return False
    try:
        return str(UUID(value)) == value
    except ValueError:
        return False


def _utc(value):
    if (type(value) is not datetime or value.tzinfo is None
            or value.utcoffset() is None):
        raise SourceUnavailable()
    try:
        return value.astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')
    except (ValueError, OverflowError):
        raise SourceUnavailable() from None


def validate_foobar_job_list_cursor(cursor):
    """Strict canonical UTC microsecond cursor. It carries position, not authority."""
    if cursor is None:
        return
    if (type(cursor) is not FoobarJobListCursor or type(cursor.updated_at) is not str
            or len(cursor.updated_at) != 27 or not cursor.updated_at.isascii()
            or not _uuid(cursor.source_ref) or not _uuid(cursor.job_ref)):
        raise FoobarJobListInvalid()
    try:
        parsed = datetime.strptime(cursor.updated_at, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)
        if _utc(parsed) != cursor.updated_at:
            raise FoobarJobListInvalid()
    except (ValueError, OverflowError):
        raise FoobarJobListInvalid() from None


def _item(row, unfinished):
    keys = {'source_ref','job_ref','created_at','updated_at','confirmed_rows','total_rows','cancel_requested'}
    if (type(row) is not dict or set(row) != keys
            or not _uuid(row['source_ref']) or not _uuid(row['job_ref'])
            or type(row['total_rows']) is not int or not 1 <= row['total_rows'] <= 100000
            or type(row['confirmed_rows']) is not int or not 0 <= row['confirmed_rows'] <= row['total_rows']
            or type(row['cancel_requested']) is not bool
            or unfinished and row['confirmed_rows'] == row['total_rows']):
        raise SourceUnavailable()
    created, updated = _utc(row['created_at']), _utc(row['updated_at'])
    if updated < created:
        raise SourceUnavailable()
    return FoobarJobListItem(row['source_ref'],row['job_ref'],created,updated,
                             row['confirmed_rows'],row['total_rows'],row['cancel_requested'])


def _key(value):
    return value.updated_at, value.source_ref, value.job_ref


def list_foobar_import_jobs(database_url, context, *, unfinished: bool,
                            cursor: FoobarJobListCursor | None = None, constraints=None) -> FoobarJobListPage:
    """Read <=21 scalar rows under genuine current account/session authority.

    No source lock or source/library grant is inferred. Selection must separately
    call the genuine status path, which revalidates source/job lifecycle. Updates
    can reorder jobs across requests: this is not frozen or exhaustive history.
    """
    validate_discovery_request(unfinished=unfinished, cursor=cursor)
    with current_foobar_account_transaction(database_url, context, constraints=constraints) as (connection, live, now):
        require_foobar_job_schema_on_connection(connection)
        require_foobar_job_discovery_on_connection(connection)
        fields = dict(account_id=live.actor.account_id, updated_at=None, source_ref=None, job_ref=None)
        if cursor is not None:
            fields.update(updated_at=cursor.updated_at,source_ref=cursor.source_ref,job_ref=cursor.job_ref)
        frame = json.dumps(fields,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
        if len(frame) > MAX_FRAME_BYTES:
            raise SourceUnavailable()
        rows = _query(connection,_LIST_SQL[(unfinished,cursor is not None)],frame,maximum=21)
        items = tuple(_item(row,unfinished) for row in rows)
        previous = _key(cursor) if cursor is not None else None
        for item in items:
            key = _key(item)
            if previous is not None and key >= previous:
                raise SourceUnavailable()
            previous = key
        visible = items[:PAGE_SIZE]
        next_cursor = (FoobarJobListCursor(*_key(visible[-1])) if len(items) > PAGE_SIZE else None)
        result = FoobarJobListPage(unfinished,visible,next_cursor)
    # Return only after the transaction owner rechecks current session/authority.
    return result


def validate_discovery_request(*, unfinished, cursor):
    """Validate before any service busy/idle branch or database work."""
    if type(unfinished) is not bool:
        raise FoobarJobListInvalid()
    validate_foobar_job_list_cursor(cursor)
