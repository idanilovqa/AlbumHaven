"""Complete local-edition selections; not rendered extents or listening credit.

The actual queue supplies locked, pre-playable-filter rows. Persistence and first
capture association share their callers' existing authority transactions/budgets.
No process registry, credential, decoder, schema installer or alternate history.
"""
from dataclasses import dataclass
import hashlib
from uuid import UUID, uuid4

from music_app.services.playback_capture import (
    CaptureError, POSITION_PROTOCOL, BODY_LIMIT, _normalize_capture_envelope, canonical_json,
)
from music_app.services.policy import ResourceScope
from music_app.services.private_native_targets import allows

MAX_MEMBERS = 512
MAX_BODY_BYTES = 262144
MAX_SCALAR_BYTES = 196608
SELECTION_OVERHEAD = 2048
ASSOCIATION_BYTES = 512
_I64 = 9223372036854775807
_DOMAIN = b'albumhaven-local-edition-membership-v1\n'
_RELATIONS = ('integration.playback_edition_selection',
              'integration.playback_edition_capture',
              'integration.playback_capture_history_revision',
              'integration.playback_capture_budget')


def _id(value):
    return type(value) is int and 1 <= value <= _I64


def _key(value):
    try:
        return type(value) is str and bool(value) and len(value.encode('utf-8')) <= 1024
    except UnicodeEncodeError:
        return False


def _uuid(value):
    try:
        parsed = UUID(value) if type(value) is str else None
    except (ValueError, AttributeError):
        parsed = None
    if parsed is None or not parsed.int or str(parsed) != value:
        raise CaptureError('capture_selection_unavailable', 409)
    return value


def _allowed(live, kind, identity, constraints):
    return all(allows(live, action, ResourceScope(kind, str(identity)), constraints)
               for action in ('library.browse.read', 'library.media.read'))


def _order(row):
    return tuple((0, row[key]) if type(row[key]) is int and row[key] > 0 else (1, 0)
                 for key in ('disc_number', 'track_number')) + (row['id'],)


@dataclass(frozen=True)
class EditionSelection:
    album_id: int
    track_ids: tuple
    membership_revision: str
    canonical_membership: str


def prepare_edition_selection(live, album, complete_rows, *, constraints=None):
    """None means the WHOLE edition is unqualified; never trim bad members.

    Null keys are preserved, so missing identity cannot disappear from the
    denominator. Unsupported numbering is recorded, not guessed/re-numbered.
    """
    if (not _id(live.library_id) or not _id(album.get('id'))
            or not _key(album.get('album_key'))
            or not 1 <= len(complete_rows) <= MAX_MEMBERS
            or not _allowed(live, 'album', album['id'], constraints)):
        return None
    seen, scalar_bytes, members = set(), len(album['album_key'].encode('utf-8')), []
    for row in complete_rows:
        identity, key = row.get('id'), row.get('track_key')
        if (not _id(identity) or identity in seen or row.get('album_id') != album['id']
                or key is not None and key != '' and not _key(key)
                or any(row.get(k) is not None and
                       (type(row[k]) is not int or not -2147483648 <= row[k] <= 2147483647)
                       for k in ('disc_number', 'track_number'))
                or not _allowed(live, 'track', identity, constraints)):
            return None
        scalar_bytes += len((key or '').encode('utf-8'))
        if scalar_bytes > MAX_SCALAR_BYTES:
            return None
        seen.add(identity)
    ordered = sorted(complete_rows, key=_order)
    pairs = [(r['disc_number'], r['track_number']) for r in ordered]
    supported = all(type(d) is int and d > 0 and type(t) is int and t > 0 for d, t in pairs)
    if supported:
        discs = sorted({d for d, _ in pairs})
        supported = discs == list(range(1, len(discs) + 1)) and len(set(pairs)) == len(pairs)
        supported = supported and all([t for d, t in pairs if d == disc] ==
            list(range(1, sum(d == disc for d, _ in pairs) + 1)) for disc in discs)
    for row in ordered:
        members.append(dict(track_id=str(row['id']), track_key=row['track_key'] or None,
                            disc_number=row['disc_number'], track_number=row['track_number']))
    value = dict(version='selected-local-edition-v1', library_id=str(live.library_id),
                 selected_album_id=str(album['id']), album_key=album['album_key'],
                 order_status='supported' if supported else 'unsupported',
                 canonical_release_completeness='unknown', members=members)
    body = canonical_json(value)
    encoded = body.encode('utf-8')
    if len(encoded) > MAX_BODY_BYTES:
        return None
    return EditionSelection(album['id'], tuple(int(r['track_id']) for r in members),
                            hashlib.sha256(_DOMAIN + encoded).hexdigest(), body)


def selection_schema_ready(connection):
    """One bounded metadata query; structural readiness, not DB qualification.

    Actual constraint definitions, privileges, cascades and plans still require
    reviewed installation and PostgreSQL tests. No schema is created here.
    """
    row = connection.execute('''select
        array(select name from unnest(%s::text[]) required(name)
              where to_regclass(name) is not null) as relations,
        array(select attname from pg_attribute
              where attrelid=to_regclass('integration.playback_edition_selection')
                and attnum>0 and not attisdropped) as selection_columns,
        array(select attname from pg_attribute
              where attrelid=to_regclass('integration.playback_edition_capture')
                and attnum>0 and not attisdropped) as capture_columns,
        array(select conname from pg_constraint
              where conrelid=any(array[to_regclass('integration.playback_edition_selection'),
                  to_regclass('integration.playback_edition_capture')]) and convalidated) as constraints,
        array(select tgname from pg_trigger
              where tgrelid=any(array[to_regclass('integration.playback_edition_selection'),
                  to_regclass('integration.playback_edition_capture')])
                and tgenabled in ('O','A')) as triggers''', (list(_RELATIONS),)).fetchone()
    return row is not None and set(row['relations']) == set(_RELATIONS) and set(row['selection_columns']) == {
        'account_id','selection_ref','originating_session_id','original_library_id',
        'original_album_id','membership_revision','canonical_membership','provenance',
        'created_at','reservation_bytes','account_budget_id'} and set(row['capture_columns']) == {
        'account_id','original_capture_session_id','live_capture_session_id','selection_ref',
        'original_track_id','reservation_bytes','account_budget_id'} and {
        'playback_edition_selection_pkey','playback_edition_selection_body',
        'playback_edition_capture_pkey','playback_edition_capture_selection'} <= set(row['constraints']) and {
        'playback_edition_selection_guard','playback_edition_capture_guard',
        'playback_edition_capture_unlink','playback_edition_selection_release',
        'playback_edition_capture_release'} <= set(row['triggers'])


def persist_top_selections(connection, live, prepared, *, top_ref, revision, now, constraints=None):
    """One aggregate budget debit and savepoint for this optional queue slice.

    Actual database failures propagate. Known unavailable/quota/rate failures
    roll back this savepoint and omit proof, without breaking normal playback.
    """
    if not prepared or not selection_schema_ready(connection):
        return {}
    from music_app.services.playback_capture_postgres import _budgets, _reserve
    from music_app.services.playback_capture_history_revision import (
        _prepare_history_revision, _insert_reserved_history_revision, _advance_history_proof,
    )
    try:
        with connection.transaction():
            account, global_budget = _budgets(connection, live.actor.account_id, now)
            history, history_charge = _prepare_history_revision(connection, account)
            entries = []
            for item, catalog, selection in prepared:
                provenance = canonical_json(dict(kind='ordinary-album') if top_ref is None else
                    dict(kind='album-top', top_ref=top_ref, top_revision=revision, item_ref=item, catalog_ref=catalog))
                charge = SELECTION_OVERHEAD + len(selection.canonical_membership.encode('utf-8')) + len(provenance.encode('utf-8'))
                entries.append((item, selection, str(uuid4()), provenance, charge))
            _reserve(connection, account, global_budget, sum(e[4] for e in entries) + history_charge)
            if history is None:
                _insert_reserved_history_revision(connection, account)
            result = {}
            for item, selection, ref, provenance, charge in entries:
                connection.execute('''insert into integration.playback_edition_selection
                    (account_id,selection_ref,originating_session_id,original_library_id,
                     original_album_id,membership_revision,canonical_membership,provenance,
                     created_at,reservation_bytes,account_budget_id)
                    values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                    (live.actor.account_id,ref,live.actor.session_id,live.library_id,
                     selection.album_id,selection.membership_revision,selection.canonical_membership,
                     provenance,now,charge,account['id']))
                result[item] = dict(version='local-edition-selection-v1', selection_ref=ref,
                                    membership_revision=selection.membership_revision)
            if not all(_allowed(live, 'album', selection.album_id, constraints)
                       and all(_allowed(live, 'track', identity, constraints) for identity in selection.track_ids)
                       for _, selection, _, _, _ in entries):
                raise CaptureError('capture_selection_unavailable', 409)
            _advance_history_proof(connection, live.actor.account_id)
            return result
    except CaptureError as error:
        if error.code not in {'capture_unavailable','capture_quota','capture_rate_limited','capture_selection_unavailable'}:
            raise
        return {}


def normalize_selected_position_envelope(value):
    """Private v2 extension only; public v1 parser/keys remain untouched."""
    if type(value) is not dict or value.get('protocol') != POSITION_PROTOCOL:
        raise CaptureError('unsupported_capture_version')
    raw = dict(value)
    ref = raw.pop('edition_selection_ref', None)
    if 'edition_selection_ref' in value:
        ref = _uuid(ref)
    observations = {}
    if type(raw.get('evidence')) is dict and type(raw['evidence'].get('runs')) is list:
        if len(raw['evidence']['runs']) > 256:raise CaptureError()
        raw['evidence'] = dict(raw['evidence'])
        runs = []
        for index, original in enumerate(raw['evidence']['runs']):
            run = dict(original) if type(original) is dict else original
            if type(run) is dict and 'source_observation_ref' in run:
                observations[index] = _uuid(run.pop('source_observation_ref'))
            runs.append(run)
        raw['evidence']['runs'] = runs
    normalized = _normalize_capture_envelope(raw)
    for index, observation in observations.items():
        normalized['evidence']['runs'][index]['source_observation_ref'] = observation
    if ref is not None:
        normalized['edition_selection_ref'] = ref
    if len(canonical_json(normalized).encode('utf-8')) > BODY_LIMIT:
        raise CaptureError('capture_too_large', 413)
    return normalized


def admit_capture_selection(connection, live, envelope, parent, source, *, constraints=None, verify_current=False, schema_ready=None):
    """Resolve exact account-owned selection, never accept a client manifest.

    All batches repeat the same optional ref; duplicates cannot relabel an old
    parent. A formerly unselected parent cannot acquire a later selection.
    """
    ref = envelope.get('edition_selection_ref')
    if parent is None and ref is None:
        return None
    if schema_ready is None:
        schema_ready = selection_schema_ready(connection)
    if schema_ready is not True:
        if ref is not None:
            raise CaptureError('capture_selection_unavailable', 409)
        if parent is not None:
            # Only a genuinely absent optional extension permits legacy replay.
            # Partial installation cannot hide a retained immutable association.
            state = connection.execute('''select
                to_regclass('integration.playback_edition_selection') is not null
                or to_regclass('integration.playback_edition_capture') is not null as present''').fetchone()
            if state is None or state['present']:
                raise CaptureError('capture_selection_unavailable', 409)
        return None
    if parent is not None:
        link = connection.execute('''select selection_ref,original_track_id,live_capture_session_id from integration.playback_edition_capture
            where account_id=%s and original_capture_session_id=%s''',
            (live.actor.account_id, parent['id'])).fetchone()
        if (str(link['selection_ref']) if link else None) != ref:
            raise CaptureError('capture_conflict', 409)
        if link is None:
            return None
        if link['original_track_id'] != parent['original_track_id'] or link['live_capture_session_id'] != parent['id']:
            raise CaptureError('capture_conflict', 409)
    row = connection.execute('''select selection_ref,originating_session_id,original_library_id,
            original_album_id,membership_revision,canonical_membership
        from integration.playback_edition_selection where account_id=%s and selection_ref=%s
        for share''', (live.actor.account_id, ref)).fetchone()
    if (row is None or row['originating_session_id'] != live.actor.session_id
            or row['original_library_id'] != live.library_id):
        raise CaptureError('capture_selection_unavailable', 409)
    album_id = source['album_id'] if source is not None else parent['original_album_id']
    track_id = source['track_id'] if source is not None else parent['original_track_id']
    if (album_id != row['original_album_id'] or not _allowed(live, 'album', album_id, constraints)
            or not _allowed(live, 'track', track_id, constraints)):
        raise CaptureError('capture_selection_unavailable', 409)
    if parent is not None and not verify_current:
        return dict(selection_ref=ref, track_id=track_id, is_new=False, selection=None)
    album = connection.execute('''select id,album_key from library.local_albums
        where library_id=%s and id=%s for share''', (live.library_id, album_id)).fetchone()
    rows = connection.execute('''select id,album_id,track_key,disc_number,track_number
        from library.local_tracks where library_id=%s and album_id=%s
        order by id limit 513 for share''', (live.library_id, album_id)).fetchall()
    current = prepare_edition_selection(live, album or {}, rows, constraints=constraints)
    if (current is None or track_id not in current.track_ids
            or current.membership_revision != row['membership_revision']
            or current.canonical_membership != row['canonical_membership']):
        raise CaptureError('capture_selection_unavailable', 409)
    return dict(selection_ref=ref, track_id=track_id, is_new=parent is None,
                selection=current)


def insert_capture_selection(connection, live, parent, selected, account):
    """Called only after the enclosing checkpoint's aggregate reservation."""
    if selected is None or not selected['is_new']:
        return
    connection.execute('''insert into integration.playback_edition_capture
        (account_id,original_capture_session_id,live_capture_session_id,selection_ref,
         original_track_id,reservation_bytes,account_budget_id)
        values(%s,%s,%s,%s,%s,512,%s)''',
        (live.actor.account_id,parent['id'],parent['id'],selected['selection_ref'],
         selected['track_id'],account['id']))
    from music_app.services.playback_capture_history_revision import _advance_history_proof
    _advance_history_proof(connection, live.actor.account_id)


def record_album_selection(database_url, context, album_key, *, enabled=False, constraints=None, connect=None, clock=None):
    """Explicit ordinary play intent only; never called by Album Details GET.

    The key selects an actual local edition, not caller-provided membership.
    Optional missing schema/unsupported proof returns unavailable, not a denial
    of otherwise authorized ordinary media playback.
    """
    if not _key(album_key):
        raise CaptureError('invalid_album_selection', 422)
    if enabled is not True:
        return dict(ok=True, listening_selection=None)
    from music_app.services.private_library_authority import current_library_transaction, require_private_action
    from music_app.services.playback_capture_postgres import _selector
    with current_library_transaction(database_url, context, constraints=constraints,
            connect=connect, clock=clock, inventory_publication_first=True) as (connection, live, now):
        _selector(connection, live)
        require_private_action(live, 'library.media.read', constraints=constraints)
        album = connection.execute('''select id,album_key from library.local_albums
            where library_id=%s and album_key=%s order by id limit 2 for share''',
            (live.library_id, album_key)).fetchall()
        if len(album) != 1 or not _allowed(live, 'album', album[0]['id'], constraints):
            return dict(ok=True, listening_selection=None)
        rows = connection.execute('''select id,album_id,track_key,disc_number,track_number
            from library.local_tracks where library_id=%s and album_id=%s
            order by id limit 513 for share''', (live.library_id, album[0]['id'])).fetchall()
        selected = prepare_edition_selection(live, album[0], rows, constraints=constraints)
        if selected is None:
            return dict(ok=True, listening_selection=None)
        # Publication lock and row locks cover membership. Re-read before the
        # optional write so a same-transaction source hook cannot change it.
        final_rows = connection.execute('''select id,album_id,track_key,disc_number,track_number
            from library.local_tracks where library_id=%s and album_id=%s
            order by id limit 513 for share''', (live.library_id, album[0]['id'])).fetchall()
        final = prepare_edition_selection(live, album[0], final_rows, constraints=constraints)
        if final != selected:
            return dict(ok=True, listening_selection=None)
        saved = persist_top_selections(connection, live, [('album', None, selected)],
            top_ref=None, revision=None, now=now, constraints=constraints)
        return dict(ok=True, listening_selection=saved.get('album'))
