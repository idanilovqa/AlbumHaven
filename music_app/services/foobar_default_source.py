"""One real own-library Foobar source, never an import/ready success.

No raw upload, deletion, reset, profile selector or authority grant is provided.
The outer native transaction commits before the small selection is returned.
"""
from dataclasses import dataclass
from datetime import date, datetime, timezone
import json
from uuid import NAMESPACE_URL, uuid5

from .private_library_authority import current_library_transaction, PrivateLibraryAuthorityError
from .policy_evaluator import PolicyEvaluationConstraints
from .track_preferences_postgres import _foobar_taste_connection, _foobar_taste_context
from .foobar_source_postgres import SourceUnavailable, SourceStale, _query, _authority

MAX_SOURCES = 16
MAX_FRAME_BYTES = 128
MAX_RESULT_BYTES = 1024
# Fixed scope/control owners; nine frame views; six distinct bounded result
# views (including prior/current and fetch guard); four identifier work views.
SOURCE_SELECTION_BYTES = 8192 + 9*MAX_FRAME_BYTES + 2 + 6*MAX_RESULT_BYTES + 4*256
_NAME = 'albumhaven:foobar:default-source:v1/'
_MAX = 9223372036854775807


@dataclass(frozen=True, slots=True)
class FoobarSourceSelection:
    source_ref: str
    generation: int
    source_revision: int


def _default_ref(account_id, library_id):
    if any(type(v) is not int or not 1 <= v <= _MAX for v in (account_id, library_id)):
        raise SourceUnavailable()
    # Public deterministic IDENTIFIER, never a credential or authorization.
    return str(uuid5(NAMESPACE_URL, _NAME+str(account_id)+'/'+str(library_id)))


_FRAME = '''
with frame as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j),
scope as (
 select (j->>0)::bigint account_id,(j->>1)::bigint library_id,(j->>2)::uuid source_ref
 from frame
)
'''
_FIELDS = frozenset(('source_ref','revision','current_generation','retired_through',
                     'created_at','updated_at','clock_high_water','observed_at','isolation'))
_PROJECTION = '''s.source_ref::text,s.revision,s.current_generation,s.retired_through,
s.created_at,s.updated_at,s.clock_high_water,clock_timestamp() observed_at,
current_setting('transaction_isolation') isolation'''
_READ = _FRAME + 'select '+_PROJECTION+'''
from scope x join integration.foobar_import_streams s
 on (s.account_id,s.library_id,s.source_ref)=(x.account_id,x.library_id,x.source_ref)
for update of s
'''
_COUNT = _FRAME + '''
select count(*)::integer source_count from (
 select s.source_ref from scope x join integration.foobar_import_streams s
 on (s.account_id,s.library_id)=(x.account_id,x.library_id)
 order by s.source_ref limit 17
) bounded
'''
_INSERT = _FRAME + ''', observed as materialized (select clock_timestamp() now)
insert into integration.foobar_import_streams
 (account_id,library_id,source_ref,current_generation,retired_through,
  clock_high_water,created_at,updated_at)
select x.account_id,x.library_id,x.source_ref,
 (o.now at time zone 'UTC')::date-date '1970-01-01',
 (o.now at time zone 'UTC')::date-date '1970-01-01'-1,
 o.now,o.now,o.now
from scope x cross join observed o
on conflict (account_id,library_id,source_ref) do nothing
returning source_ref::text
'''
_TOUCH = _FRAME + '''
update integration.foobar_import_streams s
set current_generation=(clock_timestamp() at time zone 'UTC')::date-date '1970-01-01',
 updated_at=clock_timestamp()
from scope x
where (s.account_id,s.library_id,s.source_ref)=(x.account_id,x.library_id,x.source_ref)
returning '''+_PROJECTION


def _instant(value):
    return type(value) is datetime and value.tzinfo is not None and value.utcoffset() is not None


def _stream(rows, source_ref, *, previous=None):
    if type(rows) is not list or len(rows) != 1 or type(rows[0]) is not dict or set(rows[0]) != _FIELDS:
        raise SourceUnavailable()
    row = rows[0]
    if (type(row['source_ref']) is not str or row['source_ref'] != source_ref
            or type(row['isolation']) is not str or row['isolation'] != 'read committed'
            or type(row['revision']) is not int or not 0 <= row['revision'] <= _MAX
            or type(row['current_generation']) is not int
            or not 1 <= row['current_generation'] <= 2147483647
            or type(row['retired_through']) is not int
            or not 0 <= row['retired_through'] < row['current_generation']
            or any(not _instant(row[k]) for k in (
                'created_at','updated_at','clock_high_water','observed_at'))):
        raise SourceUnavailable()
    if (row['created_at'] > row['updated_at']
            or row['clock_high_water'] < row['created_at']
            or row['clock_high_water'] < row['updated_at']
            or row['clock_high_water'] > row['observed_at']):
        raise SourceUnavailable()
    if previous is not None and (
            row['observed_at'] < previous['observed_at']
            or row['clock_high_water'] < previous['clock_high_water']
            or row['created_at'] != previous['created_at']
            or row['updated_at'] < previous['updated_at']
            or row['revision'] != previous['revision']
            or row['retired_through'] != previous['retired_through']
            or row['current_generation'] < previous['current_generation']):
        raise SourceUnavailable()
    return row


def _source_count(rows):
    if (type(rows) is not list or len(rows) != 1 or type(rows[0]) is not dict
            or set(rows[0]) != {'source_count'}
            or type(rows[0]['source_count']) is not int
            or not 0 <= rows[0]['source_count'] <= MAX_SOURCES+1):
        raise SourceUnavailable()
    return rows[0]['source_count']


def select_default_foobar_source(database_url, context, *, constraints=None):
    """Explicit import-start owner; database URL/context are server supplied.

    Its eventual POST route must provide real private-context and CSRF checks.
    This function must not be used by preview GET/POST or silently to rebind an
    existing Prepare/Apply command. No route is activated by this source slice.
    """
    try:
        _foobar_taste_context(context)
        if SOURCE_SELECTION_BYTES > 4194304:
            raise SourceUnavailable()
        def checked_constraints(target):
            # A resolver-thrown denial-shaped exception is operational, not an
            # actual evaluator decision. Do not let the native owner misread it.
            try:
                value = constraints(target) if callable(constraints) else constraints
                if value is not None and not isinstance(value, PolicyEvaluationConstraints):
                    raise SourceUnavailable()
                return value
            except Exception:
                raise SourceUnavailable() from None
        _authority(context, checked_constraints)
        with current_library_transaction(
            database_url, context, constraints=checked_constraints,
            target_account_ids=(context.actor.account_id,), read_only=False,
            inventory_publication_first=True,
        ) as (connection, live, sampled_now):
            _foobar_taste_connection(connection)
            _foobar_taste_context(live)
            _authority(live, checked_constraints)
            source_ref = _default_ref(live.actor.account_id, live.library_id)
            frame = json.dumps((live.actor.account_id,live.library_id,source_ref),
                               ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
            if len(frame) > MAX_FRAME_BYTES:
                raise SourceUnavailable()
            rows = _query(connection,_READ,frame,maximum=1)
            if not rows:
                # Existing default selection bypasses this insertion-only cap.
                count = _source_count(_query(connection,_COUNT,frame,maximum=1))
                if count >= MAX_SOURCES:
                    raise SourceUnavailable()
                inserted = _query(connection,_INSERT,frame,maximum=1)
                if (type(inserted) is not list or len(inserted) > 1 or any(
                        type(row) is not dict or set(row) != {'source_ref'}
                        or type(row['source_ref']) is not str or row['source_ref'] != source_ref for row in inserted)):
                    raise SourceUnavailable()
                del inserted
                rows = _query(connection,_READ,frame,maximum=1)
            previous = _stream(rows,source_ref)
            del rows
            current = _stream(_query(connection,_TOUCH,frame,maximum=1),
                              source_ref,previous=previous)
            # Trigger high water is a later independent sample, not equal-now.
            # Crossing a UTC-day boundary cannot issue a mismatched generation.
            today = (current['observed_at'].astimezone(timezone.utc).date()-date(1970,1,1)).days
            if current['current_generation'] != today:
                raise SourceUnavailable()
            _authority(live, checked_constraints)
            result = FoobarSourceSelection(source_ref,current['current_generation'],current['revision'])
            del previous,current,frame
        # Native context exit is the sole commit owner. No result escapes first.
        return result
    except SourceUnavailable:
        raise
    except PrivateLibraryAuthorityError:
        raise SourceStale() from None
    except Exception:
        raise SourceUnavailable() from None


# Separate account-owned protocol. Deliberately NOT wired to the legacy selector,
# factory, route or Prepare/Apply; their library-owned commands remain unchanged.
@dataclass(frozen=True, slots=True)
class AccountFoobarSourceSelection:
    source_ref: str
    generation: int
    source_revision: int
    ownership_protocol: str = 'foobar_account_source_v2'


class FoobarSourceChoiceRequired(SourceStale):
    code = 'foobar_source_choice_required'


_ACCOUNT_FRAME = '''
with frame as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j),
scope as (
 select (j->>0)::bigint account_id,(j->>1)::uuid source_ref from frame
)
'''
_ACCOUNT_LIST = _ACCOUNT_FRAME + '''
select s.source_ref::text,s.is_default
from scope x join integration.foobar_import_streams_v2 s on s.account_id=x.account_id
order by s.source_ref limit 17
'''
_ACCOUNT_READ = _ACCOUNT_FRAME + 'select '+_PROJECTION+'''
from scope x join integration.foobar_import_streams_v2 s
 on (s.account_id,s.source_ref)=(x.account_id,x.source_ref)
for update of s
'''
_ACCOUNT_INSERT = _ACCOUNT_FRAME + ''', observed as materialized (select clock_timestamp() now)
insert into integration.foobar_import_streams_v2
 (account_id,source_ref,is_default,current_generation,retired_through,
  clock_high_water,created_at,updated_at)
select x.account_id,x.source_ref,true,
 (o.now at time zone 'UTC')::date-date '1970-01-01',
 (o.now at time zone 'UTC')::date-date '1970-01-01'-1,o.now,o.now,o.now
from scope x cross join observed o
returning source_ref::text
'''
_ACCOUNT_TOUCH = _ACCOUNT_FRAME + '''
update integration.foobar_import_streams_v2 s
set current_generation=(clock_timestamp() at time zone 'UTC')::date-date '1970-01-01',
 updated_at=clock_timestamp()
from scope x
where (s.account_id,s.source_ref)=(x.account_id,x.source_ref)
returning '''+_PROJECTION


def _account_source_ref(value):
    from uuid import UUID
    if type(value) is not str or len(value) != 36:
        raise SourceUnavailable()
    try:
        if str(UUID(value)) != value:
            raise SourceUnavailable()
    except Exception:
        raise SourceUnavailable() from None
    return value


def _account_source_frame(account_id, source_ref):
    frame = json.dumps((account_id, source_ref), ensure_ascii=True,
                       separators=(',', ':'), allow_nan=False).encode('ascii')
    if len(frame) > MAX_FRAME_BYTES:
        raise SourceUnavailable()
    return frame


def _account_source_choices(rows):
    if type(rows) is not list or len(rows) > MAX_SOURCES:
        raise SourceUnavailable()
    seen = set()
    default = None
    for row in rows:
        if (type(row) is not dict or set(row) != {'source_ref', 'is_default'}
                or type(row['is_default']) is not bool):
            raise SourceUnavailable()
        ref = _account_source_ref(row['source_ref'])
        if ref in seen:
            raise SourceUnavailable()
        seen.add(ref)
        if row['is_default']:
            if default is not None:
                raise SourceUnavailable()
            default = ref
    return default


def select_account_foobar_source(database_url, context, *, source_ref=None, constraints=None):
    """Inactive v2 import-start caller, not a compatibility wrapper for v1.

    An explicit source must already belong to the authenticated account. With no
    selection only a persisted default is used, or a random default is atomically
    created for an empty account. Existing nondefault sources need explicit choice.
    Lost acknowledgment is recovered by selecting the persisted default again;
    this operation has no request key and never creates a second default on retry.
    """
    from uuid import uuid4
    from .foobar_account_authority import (
        current_foobar_account_transaction, require_account_foobar,
    )
    try:
        require_account_foobar(context, constraints)
        if source_ref is not None:
            _account_source_ref(source_ref)
        # Includes 17 bounded list rows, their validation set, and retained UUIDs,
        # in addition to the unchanged selection/frame/result owners.
        if SOURCE_SELECTION_BYTES + 17*1024 > 4194304:
            raise SourceUnavailable()
        with current_foobar_account_transaction(
                database_url, context, constraints=constraints) as (connection, live, sampled_now):
            _foobar_taste_connection(connection)
            if source_ref is None:
                frame = _account_source_frame(live.actor.account_id, None)
                choices = _query(connection, _ACCOUNT_LIST, frame, maximum=17)
                source_ref = _account_source_choices(choices)
                if choices and source_ref is None:
                    raise FoobarSourceChoiceRequired()
                create = not choices
                del choices
                if create:
                    source_ref = _account_source_ref(str(uuid4()))
                    frame = _account_source_frame(live.actor.account_id, source_ref)
                    inserted = _query(connection, _ACCOUNT_INSERT, frame, maximum=1)
                    if (type(inserted) is not list or len(inserted) != 1
                            or type(inserted[0]) is not dict
                            or inserted[0] != {'source_ref': source_ref}):
                        raise SourceUnavailable()
                    del inserted
            frame = _account_source_frame(live.actor.account_id, source_ref)
            rows = _query(connection, _ACCOUNT_READ, frame, maximum=1)
            if not rows:
                raise SourceStale()
            previous = _stream(rows, source_ref)
            del rows
            current = _stream(_query(connection, _ACCOUNT_TOUCH, frame, maximum=1),
                              source_ref, previous=previous)
            today = (current['observed_at'].astimezone(timezone.utc).date()-date(1970,1,1)).days
            if current['current_generation'] != today:
                raise SourceUnavailable()
            require_account_foobar(live, constraints)
            result = AccountFoobarSourceSelection(
                source_ref, current['current_generation'], current['revision'])
            del previous, current, frame
        return result
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None
