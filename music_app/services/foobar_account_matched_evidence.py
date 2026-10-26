"""Bounded own-account matched evidence for genuine selected-library consumers.

This same-connection reader grants no playback, returns no path/metadata and
never adds source counts across providers. The caller owns the actual native
transaction; every supplied track needs current genuine browse authority.
"""
from dataclasses import dataclass
import json
from datetime import datetime, timezone

from . import foobar_account_history_native as native
from .foobar_account_history_evidence import decode_current_projection, has_positive_local_evidence, EXTRA_KEYS, snapshots
from .foobar_account_authority import require_account_foobar_read, account_foobar_read_context
from .foobar_account_history_readiness import require_foobar_history_on_connection
from .foobar_account_match_readiness import require_foobar_match_schema_on_connection
from .foobar_account_source_postgres import SourceUnavailable, _query
from .private_library_authority import require_private_action, PrivateLibraryAuthorityError
from .policy import ResourceScope, PolicyContext
from .track_preferences_postgres import _foobar_taste_connection

MAX_TRACKS = 100
MAX_ASSOCIATIONS = 32
MAX_TARGETS_PER_QUERY = 3
MAX_PHASE_BYTES = 4_194_304
# Three targets per query: <=99 bounded8192-byte projection rows plus fixed
# binding/scalar fields, three driver/container views and singleton decode.
# No all-target payload accumulation or per-observation SQL round trips.
CONTROL_BYTES = 65536
PROJECTION_PHASE_BYTES = 262144


@dataclass(frozen=True, slots=True)
class MatchedFoobarEvidence:
    positive_track_ids: tuple[int, ...]
    incomplete_track_ids: tuple[int, ...]
    count_family: str
    provenance: str = 'own_account_foobar_reported_evidence'
    availability: str = 'available'


_FRAME = """with f as materialized(select convert_from(%b::bytea,'UTF8')::jsonb j),
x as materialized(select (j->>0)::bigint account_id,(j->>1)::bigint library_id,
j->2 track_ids from f),
targets as materialized(select value::bigint track_id from x,
 jsonb_array_elements_text(x.track_ids))
"""
_CANDIDATES = _FRAME + """, chosen as materialized (
 select q.track_id requested_track_id,m.* from targets q
 cross join lateral (
 select m.account_id,m.source_ref,m.observation_ref,m.library_id,m.track_key,
 m.decision_ref,m.match_version from integration.foobar_import_local_matches_v2 m
 where m.account_id=(select account_id from x) and m.library_id=(select library_id from x)
 and m.track_key=(select t.track_key from library.local_tracks t
  where t.library_id=(select library_id from x) and t.id=q.track_id)
 limit 33) m)
select c.requested_track_id,c.source_ref::text source_ref,c.observation_ref::text observation_ref,
p.source_revision,case when octet_length(p.projection_bytes) between 1 and 8192
 then p.projection_bytes end projection_bytes,
encode(p.projection_sha256,'hex') projection_sha256,
encode(p.effective_evidence_sha256,'hex') effective_evidence_sha256,
encode(p.display_sha256,'hex') display_sha256,
p.standard_first,p.standard_last,p.enhanced_first,p.enhanced_last,
p.standard_last_present,p.enhanced_last_present,o.current_revision,
encode(r.evidence_sha256,'hex') current_effective_sha256,
encode(r.display_sha256,'hex') current_display_sha256,
case when p.evidence_kind in ('tsv_snapshot','enhanced_store') then p.evidence_kind end evidence_kind,
p.local_entry_count,case when octet_length(p.local_vector_sha256)=32
 then encode(p.local_vector_sha256,'hex') end local_vector_sha256,
c.decision_ref::text binding_decision,c.match_version binding_version,t.id binding_track_id,
d.decision_ref::text saved_decision,d.match_version saved_version,case when d.action in ('match','rematch','detach') then d.action end saved_action,
d.original_track_id saved_track_id,h.decision_ref::text head_decision,
h.match_version head_version,case when h.action in ('match','rematch','detach') then h.action end head_action,h.original_track_id head_track_id
from chosen c
left join library.local_tracks t on (t.library_id,t.track_key)=(c.library_id,c.track_key)
left join integration.foobar_import_observations_v2 o
 on (o.account_id,o.source_ref,o.observation_ref)=(c.account_id,c.source_ref,c.observation_ref)
left join integration.foobar_import_revisions_v2 r
 on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)=
 (o.account_id,o.source_ref,o.observation_ref,o.current_revision)
left join integration.foobar_import_history_projection_v1 p
 on (p.account_id,p.source_ref,p.observation_ref)=(c.account_id,c.source_ref,c.observation_ref)
left join integration.foobar_import_match_decisions_v2 d
 on (d.account_id,d.source_ref,d.observation_ref,d.decision_ref,d.original_library_id,d.match_version)=
 (c.account_id,c.source_ref,c.observation_ref,c.decision_ref,c.library_id,c.match_version)
left join lateral(select z.decision_ref,z.match_version,z.action,z.original_track_id
 from integration.foobar_import_match_decisions_v2 z
 where (z.account_id,z.source_ref,z.observation_ref,z.original_library_id)=
 (c.account_id,c.source_ref,c.observation_ref,c.library_id)
 order by z.match_version desc limit 1) h on true"""


def _frame(account, library, tracks):
    value = json.dumps((account, library, tracks), separators=(',', ':')).encode('ascii')
    if len(value) > 128:
        raise SourceUnavailable()
    return value


def _validate_request(connection, live_context, track_ids, count_family):
    _foobar_taste_connection(connection)
    if (type(live_context) is not PolicyContext
            or type(track_ids) is not tuple or not 1 <= len(track_ids) <= MAX_TRACKS
            or any(type(track) is not int or not 1 <= track <= 9223372036854775807 for track in track_ids)
            or tuple(sorted(set(track_ids))) != track_ids
            or count_family not in ('standard', 'enhanced')
            or type(live_context.library_id) is not int or live_context.library_id <= 0):
        raise SourceUnavailable()
    if CONTROL_BYTES + 3 * MAX_TARGETS_PER_QUERY * (MAX_ASSOCIATIONS + 1) * (8192 + 2048) + PROJECTION_PHASE_BYTES > MAX_PHASE_BYTES:
        raise SourceUnavailable()


def read_matched_foobar_evidence_on_connection(connection, live_context, *,
        track_ids, count_family, constraints=None):
    """Only complete eligible scans may establish absence of positive evidence.

    Positive evidence is an existential boolean union across sources. An
    overflow with a proved positive remains positive; without a proved positive
    it is explicitly incomplete. No arbitrary first32 subset becomes a negative.
    """
    _validate_request(connection, live_context, track_ids, count_family)
    require_account_foobar_read(live_context, constraints)
    require_foobar_history_on_connection(connection)
    require_foobar_match_schema_on_connection(connection)
    account, library = live_context.actor.account_id, live_context.library_id
    native.lock_current_actor_session(connection, actor_account_id=account,
        actor_session_id=live_context.actor.session_id, clock=lambda: datetime.now(timezone.utc))
    positive, incomplete = set(), set()
    projection_keys = snapshots._BINDING_KEYS | EXTRA_KEYS
    all_keys = projection_keys | native._BINDING_KEYS | {'requested_track_id', 'source_ref', 'observation_ref'}
    for offset in range(0, len(track_ids), MAX_TARGETS_PER_QUERY):
        batch = track_ids[offset:offset + MAX_TARGETS_PER_QUERY]
        for track in batch:
            require_private_action(live_context, 'library.browse.read',
                resource=ResourceScope('track', str(track)), constraints=constraints)
        rows = _query(connection, _CANDIDATES, _frame(account, library, batch),
            maximum=len(batch) * (MAX_ASSOCIATIONS + 1))
        grouped = {track: [] for track in batch}
        seen = set()
        for row in rows:
            if (type(row) is not dict or set(row) != all_keys
                    or type(row['requested_track_id']) is not int
                    or row['requested_track_id'] not in grouped
                    or not native._uuid(row['source_ref']) or not native._uuid(row['observation_ref'])
                    or (row['requested_track_id'], row['source_ref'], row['observation_ref']) in seen):
                raise SourceUnavailable()
            seen.add((row['requested_track_id'], row['source_ref'], row['observation_ref']))
            grouped[row['requested_track_id']].append(row)
        for track, candidates in grouped.items():
            if len(candidates) > MAX_ASSOCIATIONS + 1:
                raise SourceUnavailable()
            if len(candidates) > MAX_ASSOCIATIONS:
                incomplete.add(track)
            for row in candidates[:MAX_ASSOCIATIONS]:
                bound = native._binding([{key: row[key] for key in native._BINDING_KEYS}])
                if bound != track:
                    incomplete.add(track)
                    continue
                kind, projection = decode_current_projection({key: row[key] for key in projection_keys})
                verdict = has_positive_local_evidence(kind, projection, count_family=count_family)
                if verdict is True:
                    positive.add(track)
                elif verdict is None:
                    incomplete.add(track)
                del projection
        # Release all payload-bearing views before allocating the next batch.
        del rows, grouped, candidates
        if seen:
            del row
    native.lock_current_actor_session(connection, actor_account_id=account,
        actor_session_id=live_context.actor.session_id, clock=lambda: datetime.now(timezone.utc))
    require_account_foobar_read(live_context, constraints)
    for track in track_ids:
        require_private_action(live_context, 'library.browse.read',
            resource=ResourceScope('track', str(track)), constraints=constraints)
    return MatchedFoobarEvidence(tuple(sorted(positive)),
        tuple(sorted(incomplete - positive)), count_family)


def optional_matched_foobar_evidence_on_connection(connection, live_context, *,
        track_ids, count_family, constraints=None):
    """Optional projection under a real nested transaction/savepoint.

    Invalid actor/session/library authority is never downgraded. Missing schema,
    count proof or own-account Foobar-read permission can make only this optional
    evidence unavailable. The caller still owns and revalidates its native scope.
    """
    _validate_request(connection, live_context, track_ids, count_family)
    account_foobar_read_context(live_context)  # Reject malformed/stale actor scope.
    account = live_context.actor.account_id
    def session():
        native.lock_current_actor_session(connection, actor_account_id=account,
            actor_session_id=live_context.actor.session_id, clock=lambda: datetime.now(timezone.utc))
    session()
    try:
        with connection.transaction():
            result = read_matched_foobar_evidence_on_connection(connection, live_context,
                track_ids=track_ids, count_family=count_family, constraints=constraints)
    except PrivateLibraryAuthorityError:
        raise
    except Exception:
        # Nested context has already rolled back. If rollback failed or this is a
        # genuinely invalid current session, the fresh read fails overall below.
        result = MatchedFoobarEvidence((), track_ids, count_family,
            availability='unavailable')
    session()
    for track in track_ids:
        require_private_action(live_context, 'library.browse.read',
            resource=ResourceScope('track', str(track)), constraints=constraints)
    return result
