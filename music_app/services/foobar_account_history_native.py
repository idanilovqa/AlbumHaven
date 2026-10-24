"""Read-only Foobar history -> freshly authorized current-library Play.

No native identity is accepted from a request. No history row is enriched with
paths, inventory metadata, or activity provenance. Inactive source preparation.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
from pathlib import Path

from .foobar_account_authority import require_account_foobar_read
from .foobar_account_history_postgres import FoobarHistoryInvalid, FoobarHistoryStale, _uuid, _integer
from .foobar_account_history_evidence import decode_current_projection
from .foobar_account_history_readiness import require_foobar_history_on_connection
from .foobar_account_match_readiness import require_foobar_match_schema_on_connection
from .foobar_account_source_postgres import SourceUnavailable, SourceStale, _query
from .private_library_authority import (current_library_transaction, require_private_action,
    PrivateLibraryAuthorityError)
from .private_native_targets import PrivateNativeTargets, NativeTargetError
from .library_roots import resolve_configured_media_path
from .library_roots_postgres import PostgresLibraryRootSettingsStore
from .admin_member_mutation_postgres import lock_current_actor_session
from .policy import ResourceScope

MAX_OBSERVATIONS = 20
MAX_FRAME_BYTES = 4096
MAX_SQL_BYTES = 8192
MAX_NATIVE_FILES = 32
MAX_NATIVE_TEXT_BYTES = 4096
MAX_NATIVE_METADATA_BYTES = 8192
# Serial native/projection owner, no batch of native dictionaries retained.
# This reserve is for the known pinned source closure, NOT a process RSS bound.
HISTORY_NATIVE_PHASE_BYTES = 33554432
MAX_ELIGIBILITY_RESPONSE_BYTES = 4096
MAX_PRIVATE_TARGET_BYTES = 32768


@dataclass(frozen=True, slots=True)
class FoobarHistoryObservation:
    observation_ref: str
    original_revision: int


@dataclass(frozen=True, slots=True)
class FoobarHistoryNativeRequest:
    source_ref: str
    expected_source_revision: int
    observations: tuple[FoobarHistoryObservation, ...]


@dataclass(frozen=True, slots=True)
class FoobarHistoryEligibility:
    observation_ref: str
    can_attempt_play: bool


@dataclass(frozen=True, slots=True, repr=False)
class FoobarHistoryPrivatePlayTarget:
    """Private handoff only. Never serialize into a history/eligibility response."""
    track_ref: str
    path: str
    title: str | None
    artist: str | None
    album_title: str | None
    duration_seconds: int | float | None
    inventory_track_ref: str


def validate_foobar_history_native_request(request, *, play=False):
    if (type(request) is not FoobarHistoryNativeRequest or not _uuid(request.source_ref)
            or not _integer(request.expected_source_revision)
            or type(request.observations) is not tuple
            or not 1 <= len(request.observations) <= (1 if play else MAX_OBSERVATIONS)):
        raise FoobarHistoryInvalid()
    refs = set()
    for item in request.observations:
        if (type(item) is not FoobarHistoryObservation or not _uuid(item.observation_ref)
                or not _integer(item.original_revision, 1)
                or item.original_revision > request.expected_source_revision
                or item.observation_ref in refs):
            raise FoobarHistoryInvalid()
        refs.add(item.observation_ref)


_F = """with f as materialized(select convert_from(%b::bytea,'UTF8')::jsonb j),
x as materialized(select (j->>0)::bigint account_id,(j->>1)::uuid source_ref,
(j->>2)::bigint library_id,(j->>3)::uuid observation_ref from f)
"""
_LOCK_SOURCE = _F + """select s.revision from integration.foobar_import_streams_v2 s cross join x
where (s.account_id,s.source_ref)=(x.account_id,x.source_ref) for share of s"""
_PROJECTION = _F + """select p.source_revision,p.projection_bytes,
case when p.evidence_kind in ('tsv_snapshot','enhanced_store') then p.evidence_kind end evidence_kind,
p.local_entry_count,case when octet_length(p.local_vector_sha256)=32
 then encode(p.local_vector_sha256,'hex') end local_vector_sha256,
encode(p.projection_sha256,'hex') projection_sha256,
encode(p.effective_evidence_sha256,'hex') effective_evidence_sha256,
encode(p.display_sha256,'hex') display_sha256,
p.standard_first,p.standard_last,p.enhanced_first,p.enhanced_last,
p.standard_last_present,p.enhanced_last_present,o.current_revision,
encode(r.evidence_sha256,'hex') current_effective_sha256,
encode(r.display_sha256,'hex') current_display_sha256
from x join integration.foobar_import_observations_v2 o
on (o.account_id,o.source_ref,o.observation_ref)=(x.account_id,x.source_ref,x.observation_ref)
join integration.foobar_import_history_projection_v1 p
on (p.account_id,p.source_ref,p.observation_ref)=(o.account_id,o.source_ref,o.observation_ref)
join integration.foobar_import_revisions_v2 r
on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)=
(o.account_id,o.source_ref,o.observation_ref,o.current_revision)
where octet_length(p.projection_bytes) between 1 and 8192
for share of o,p,r"""
# Both the exact immutable decision referenced by m AND latest decision h must
# match. The old track_key cannot silently authorize a replacement with a new ID.
_BINDING = _F + """select m.decision_ref::text binding_decision,m.match_version binding_version,
t.id binding_track_id,d.decision_ref::text saved_decision,d.match_version saved_version,
d.action saved_action,d.original_track_id saved_track_id,
h.decision_ref::text head_decision,h.match_version head_version,
h.action head_action,h.original_track_id head_track_id
from x join integration.foobar_import_local_matches_v2 m
on (m.account_id,m.source_ref,m.observation_ref,m.library_id)=
(x.account_id,x.source_ref,x.observation_ref,x.library_id)
join library.local_tracks t on (t.library_id,t.track_key)=(m.library_id,m.track_key)
join integration.foobar_import_match_decisions_v2 d
on (d.account_id,d.source_ref,d.observation_ref,d.decision_ref,d.original_library_id,d.match_version)=
(m.account_id,m.source_ref,m.observation_ref,m.decision_ref,m.library_id,m.match_version)
join lateral(select z.decision_ref,z.match_version,z.action,z.original_track_id
from integration.foobar_import_match_decisions_v2 z
where (z.account_id,z.source_ref,z.observation_ref,z.original_library_id)=
(x.account_id,x.source_ref,x.observation_ref,x.library_id)
order by z.match_version desc limit 1) h on true
for share of m,d,t"""
_BINDING_KEYS = frozenset(('binding_decision','binding_version','binding_track_id',
    'saved_decision','saved_version','saved_action','saved_track_id','head_decision',
    'head_version','head_action','head_track_id'))


def _frame(account, request, library, item=None):
    frame = json.dumps((account, request.source_ref, library,
        item.observation_ref if item else None), separators=(',',':'), allow_nan=False).encode('ascii')
    if len(frame)>MAX_FRAME_BYTES:
        raise SourceUnavailable()
    return frame


def _rows(connection, sql, frame, maximum=1):
    if not sql.isascii() or len(sql)>MAX_SQL_BYTES:
        raise SourceUnavailable()
    return _query(connection, sql, frame, maximum=maximum)


def _binding(rows):
    if not rows:
        return None
    if len(rows)!=1 or type(rows[0]) is not dict or set(rows[0])!=_BINDING_KEYS:
        raise SourceUnavailable()
    row = rows[0]
    if (any(not _uuid(row[k]) for k in ('binding_decision','saved_decision','head_decision'))
            or any(not _integer(row[k],1) for k in ('binding_version','saved_version',
                'head_version','binding_track_id','saved_track_id','head_track_id'))
            or row['saved_action'] not in ('match','rematch')
            or row['head_action'] not in ('match','rematch')
            or not row['binding_decision']==row['saved_decision']==row['head_decision']
            or not row['binding_version']==row['saved_version']==row['head_version']
            or not row['binding_track_id']==row['saved_track_id']==row['head_track_id']
            or row['saved_action']!=row['head_action']):
        return None
    return row['binding_track_id']


# Native singleton resolve includes legacy fetchall and jsonb_agg. Admit their
# complete input cardinality and variable widths first under matching native
# locks, NOT via COUNT/JSON aggregates. LIMIT33 is only an overflow sentinel.
_NATIVE_TRACK_LOCK = """select t.id from library.local_tracks t
where t.library_id=%s and t.id=%s for update of t"""
_NATIVE_PARENT_LOCK = """select a.id from library.local_albums a
join library.local_tracks t on t.album_id=a.id and t.library_id=a.library_id
where t.library_id=%s and t.id=%s for share of a"""
_NATIVE_ARTIST_LOCK = """select a.id from library.local_artists a
join library.local_tracks t on t.artist_id=a.id and t.library_id=a.library_id
where t.library_id=%s and t.id=%s for share of a"""
_NATIVE_FILES_LOCK = """select f.id from library.local_track_files f
where f.track_id=%s order by f.id limit 33 for share of f"""
_NATIVE_ROOTS_LOCK = """select r.id from library.library_roots r
where r.id in (select f.library_root_id from library.local_track_files f where f.track_id=%s)
order by r.id limit 33 for share of r"""
_NATIVE_TRACK_SIZE = """select octet_length(t.track_key) track_key,
octet_length(t.title) title,octet_length(a.title) album_title,octet_length(ar.name) artist
from library.local_tracks t
left join library.local_albums a on a.id=t.album_id and a.library_id=t.library_id
left join library.local_artists ar on ar.id=t.artist_id and ar.library_id=t.library_id
where t.library_id=%s and t.id=%s"""
_NATIVE_FILES_SIZE = """select f.id,octet_length(f.private_path) private_path,
octet_length(f.content_signature) content_signature,octet_length(r.root_path) root_path,
octet_length(r.metadata::text) root_metadata,octet_length(f.metadata::text) file_metadata
from library.local_track_files f left join library.library_roots r on r.id=f.library_root_id
where f.track_id=%s order by f.id limit 33"""


def _native_rows(connection, sql, args, maximum):
    cursor = connection.execute(sql, args)
    try:
        rows = cursor.fetchmany(maximum+1)
        if type(rows) is not list or len(rows)>maximum or any(type(r) is not dict for r in rows):
            raise SourceUnavailable()
        return rows
    finally:
        cursor.close()


def _admit_native(connection, library, track):
    rows = _native_rows(connection,_NATIVE_TRACK_LOCK,(library,track),1)
    if rows != [{'id':track}] or type(rows[0]['id']) is not int:
        return False
    for sql in (_NATIVE_PARENT_LOCK,_NATIVE_ARTIST_LOCK):
        _native_rows(connection,sql,(library,track),1)
    files = _native_rows(connection,_NATIVE_FILES_LOCK,(track,),MAX_NATIVE_FILES)
    _native_rows(connection,_NATIVE_ROOTS_LOCK,(track,),MAX_NATIVE_FILES)
    rows = _native_rows(connection,_NATIVE_TRACK_SIZE,(library,track),1)
    if len(rows)!=1 or set(rows[0])!={'track_key','title','album_title','artist'}:
        raise SourceUnavailable()
    if not _integer(rows[0]['track_key'],1,MAX_NATIVE_TEXT_BYTES):
        return False
    if any(v is not None and not _integer(v,0,MAX_NATIVE_TEXT_BYTES) for v in rows[0].values()):
        return False
    sizes = _native_rows(connection,_NATIVE_FILES_SIZE,(track,),MAX_NATIVE_FILES)
    if len(sizes)!=len(files):
        raise SourceUnavailable()
    for locked, row in zip(files,sizes):
        if (set(locked)!={'id'} or set(row)!={'id','private_path','content_signature',
                'root_path','root_metadata','file_metadata'} or row['id']!=locked['id']):
            raise SourceUnavailable()
        for key,value in row.items():
            if key=='id':
                continue
            bound = MAX_NATIVE_METADATA_BYTES if key.endswith('metadata') else MAX_NATIVE_TEXT_BYTES
            if value is not None and not _integer(value,0,bound):
                return False
    return True


def _private_target(value):
    keys = ('track_ref','path','title','artist','album_title','duration_seconds','inventory_track_ref')
    if type(value) is not dict or set(value)!=set(keys):
        raise SourceUnavailable()
    total = 0
    for key in keys:
        if key=='duration_seconds':
            number=value[key]
            if number is not None and (type(number) not in (int,float)
                    or not math.isfinite(number) or not 0<=number<=9223372036854775807):
                raise SourceUnavailable()
            continue
        text=value[key]
        if text is None and key in ('title','artist','album_title'):
            continue
        if type(text) is not str or len(text)>MAX_NATIVE_TEXT_BYTES:
            raise SourceUnavailable()
        width=len(text.encode('utf-8'))
        if width>MAX_NATIVE_TEXT_BYTES:
            raise SourceUnavailable()
        total += width
    if total>MAX_PRIVATE_TARGET_BYTES or value['path']!=value['track_ref']:
        raise SourceUnavailable()
    return FoobarHistoryPrivatePlayTarget(*(value[key] for key in keys))


_ROOT_SELECTOR_LOCK = """select l.id library_id from app.bootstrap_owners b
join library.libraries l on l.owner_account_id=b.account_id
and l.name='Local Library' and l.library_kind='local'
where b.owner_key='local-bootstrap-owner' limit 2 for share of b,l"""
_ROOT_SETTINGS_ADMISSION = """select s.library_id,octet_length(s.settings_payload::text) payload_bytes,
case when jsonb_typeof(s.settings_payload->'main_library_roots')='array'
then jsonb_array_length(s.settings_payload->'main_library_roots') else -1 end main_count,
case when jsonb_typeof(s.settings_payload->'hoarding_library_roots')='array'
then jsonb_array_length(s.settings_payload->'hoarding_library_roots') else -1 end hoard_count,
case when jsonb_typeof(s.settings_payload->'new_arrivals_roots')='array'
then jsonb_array_length(s.settings_payload->'new_arrivals_roots') else -1 end arrivals_count
from library.library_root_settings s where s.library_id=%s for share of s"""

_ROOT_PATH_ADMISSION = """select octet_length(case when jsonb_typeof(v)='string'
then v#>>'{}' else v->>'path' end) path_bytes
from library.library_root_settings s
cross join lateral (select value v from jsonb_array_elements(s.settings_payload->'main_library_roots')
union all select value from jsonb_array_elements(s.settings_payload->'hoarding_library_roots')
union all select value from jsonb_array_elements(s.settings_payload->'new_arrivals_roots')) roots
where s.library_id=%s limit 33"""


def _configured_roots(connection, config):
    # Exact bootstrap selector used by the genuine native store, not a selected
    # library fallback or process-cache authority. Locks freeze settings/source
    # identities before the actual loader's bounded JSON projection on SAME DB.
    if type(config) is not dict:
        raise SourceUnavailable()
    selector=_native_rows(connection,_ROOT_SELECTOR_LOCK,(),1)
    if (len(selector)!=1 or set(selector[0])!={'library_id'}
            or not _integer(selector[0]['library_id'],1)):
        raise SourceUnavailable()
    rows=_native_rows(connection,_ROOT_SETTINGS_ADMISSION,(selector[0]['library_id'],),1)
    if (len(rows)!=1 or set(rows[0])!={'library_id','payload_bytes','main_count',
            'hoard_count','arrivals_count'} or not _integer(rows[0]['library_id'],1)
            or rows[0]['library_id']!=selector[0]['library_id']
            or not _integer(rows[0]['payload_bytes'],1,65536)
            or not _integer(rows[0]['main_count'],1,MAX_NATIVE_FILES)
            or any(not _integer(rows[0][key],0,MAX_NATIVE_FILES)
                for key in ('hoard_count','arrivals_count'))
            or sum(rows[0][key] for key in ('main_count','hoard_count','arrivals_count'))>MAX_NATIVE_FILES):
        raise SourceUnavailable()
    path_sizes=_native_rows(connection,_ROOT_PATH_ADMISSION,(rows[0]['library_id'],),MAX_NATIVE_FILES)
    expected_count=sum(rows[0][key] for key in ('main_count','hoard_count','arrivals_count'))
    if (len(path_sizes)!=expected_count or any(set(row)!={'path_bytes'}
            or not _integer(row['path_bytes'],1,MAX_NATIVE_TEXT_BYTES) for row in path_sizes)):
        raise SourceUnavailable()
    settings=PostgresLibraryRootSettingsStore(config).load_settings(connection=connection)
    # Derive from this fresh return, NEVER reread the mutable process cache.
    roots=[]
    for key in ('main_library_roots','hoarding_library_roots','new_arrivals_roots'):
        entries=settings.get(key)
        if type(entries) is not list or len(entries)>MAX_NATIVE_FILES:
            raise SourceUnavailable()
        for entry in entries:
            path=entry.get('path') if type(entry) is dict else None
            if (type(path) is not str or not path or len(path)>MAX_NATIVE_TEXT_BYTES
                    or len(path.encode('utf-8'))>MAX_NATIVE_TEXT_BYTES):
                raise SourceUnavailable()
            root=Path(path)
            if not root.is_absolute():
                raise SourceUnavailable()
            roots.append(root)
    if not 1<=len(roots)<=MAX_NATIVE_FILES:
        raise SourceUnavailable()
    return tuple(roots)


def _native_owner(config, roots):
    def media_resolver(actual_config, raw_path, **options):
        if actual_config is not config:
            raise SourceUnavailable()
        # Native's second scoped call retains its exact explicit root. The first
        # call uses the freshly locked native settings, not caller data or ambient DB I/O.
        if 'configured_root_paths' not in options:
            options['configured_root_paths']=roots
        return resolve_configured_media_path(actual_config,raw_path,**options)
    return PrivateNativeTargets(config,media_resolver=media_resolver)


def _final_authority(connection, live, tracks, constraints):
    lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
        actor_session_id=live.actor.session_id,clock=lambda:datetime.now(timezone.utc))
    require_account_foobar_read(live,constraints)
    require_private_action(live,'library.browse.read',constraints=constraints)
    for track in tracks:
        for action in ('library.browse.read','library.media.read'):
            require_private_action(live,action,resource=ResourceScope('track',str(track)),constraints=constraints)


def _resolve(database_url, context, request, *, config, constraints, play):
    validate_foobar_history_native_request(request,play=play)
    try:
        with current_library_transaction(database_url,context,constraints=constraints,
                read_only=True,inventory_publication_first=True) as (connection,live,now):
            require_account_foobar_read(live,constraints)
            require_foobar_history_on_connection(connection)
            require_foobar_match_schema_on_connection(connection)
            locked = _rows(connection,_LOCK_SOURCE,_frame(live.actor.account_id,request,live.library_id))
            if not locked:
                raise FoobarHistoryStale()
            if (len(locked)!=1 or type(locked[0]) is not dict or set(locked[0])!={'revision'}
                    or not _integer(locked[0]['revision'])):
                raise SourceUnavailable()
            if locked[0]['revision']!=request.expected_source_revision:
                raise FoobarHistoryStale()
            native = None
            eligible, authorized_tracks = [], []
            result = None
            for item in request.observations:
                frame = _frame(live.actor.account_id,request,live.library_id,item)
                rows = _rows(connection,_PROJECTION,frame)
                if len(rows)!=1:
                    raise FoobarHistoryStale()
                if rows[0].get('current_revision')!=item.original_revision:
                    raise FoobarHistoryStale()
                projection=decode_current_projection(rows[0],expected_revision=item.original_revision)
                del projection, rows
                track = _binding(_rows(connection,_BINDING,frame))
                can_attempt_play = False
                permitted = False
                if track is not None:
                    try:
                        for action in ('library.browse.read','library.media.read'):
                            require_private_action(live,action,resource=ResourceScope('track',str(track)),
                                constraints=constraints)
                    except PrivateLibraryAuthorityError:
                        pass
                    else:
                        permitted=True
                if permitted and not play:
                    can_attempt_play=True
                    authorized_tracks.append(track)
                if permitted and play and _admit_native(connection,live.library_id,track):
                    roots = _configured_roots(connection,config)
                    native = _native_owner(config,roots)
                    try:
                        target = native.resolve(connection,live,track,intent='play',constraints=constraints)
                    except NativeTargetError as error:
                        if error.code not in ('forbidden','item_unavailable'):
                            raise
                    else:
                        private = _private_target(target)
                        if private.inventory_track_ref!=f'inventory-track:{live.library_id}:{track}':
                            raise SourceUnavailable()
                        can_attempt_play=True
                        authorized_tracks.append(track)
                        if play:
                            result=private
                        del private,target
                eligible.append(FoobarHistoryEligibility(item.observation_ref,can_attempt_play))
            _final_authority(connection,live,authorized_tracks,constraints)
            if play and result is None:
                raise NativeTargetError()
            if not play:
                result=tuple(eligible)
                # Exact public wire projection, with a separately fixed bound.
                response=json.dumps([{'observation_ref':i.observation_ref,'can_attempt_play':i.can_attempt_play}
                    for i in result],separators=(',',':')).encode('ascii')
                if len(response)>MAX_ELIGIBILITY_RESPONSE_BYTES:
                    raise SourceUnavailable()
                del response
        # No success escapes before the real owner exits its transaction.
        return result
    except (FoobarHistoryInvalid,SourceStale,SourceUnavailable,NativeTargetError):
        raise
    except Exception:
        raise SourceUnavailable() from None


def read_foobar_history_eligibility(database_url,context,request,*,config,constraints=None):
    """Return <=20 permission/association hints, without filesystem probes.

    can_attempt_play is NOT playable availability and grants no native target.
    """
    return _resolve(database_url,context,request,config=config,constraints=constraints,play=False)


def resolve_foobar_history_play(database_url,context,request,*,config,constraints=None):
    """Return one private native target freshly reauthorized on this request."""
    return _resolve(database_url,context,request,config=config,constraints=constraints,play=True)
