"""Dormant owner-private artwork preparation; no route or publication authority.

The existing Top owner supplies current account/session/library/ACL transactions.
Only explicit start/advance writes staging. Decoding is outside transactions;
read/status never completes a batch. Ready means captured, not approved/published.
No bytes can be served by the public reader from these tables alone.
"""
from contextlib import contextmanager
from dataclasses import asdict
import hashlib
from pathlib import Path
import re
from threading import BoundedSemaphore
from uuid import uuid4

from psycopg.types.json import Jsonb

from music_app.services import album_top_publication as publication
from music_app.services import album_top_publication_evidence as evidence
from music_app.services import album_top_artwork_draft as artwork_draft
from music_app.services.album_top_publication_authority import require_source_browse
from music_app.services.library_roots import resolve_configured_media_path
from music_app.services.owned_album_tops import (
    AlbumTopError, BROWSE, MANAGE, ITEMS, ACCESS, normalize_top_publication_preview,
    top_uuid, top_revision,
)
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import require_private_action
from music_app.services.public_top_artwork_acquisition import (
    ArtworkAcquisitionUnavailable, ArtworkSourceDescriptor, CapturedArtwork,
    describe_artwork_source, capture_artwork, MAX_INPUT_BYTES, MAX_INPUT_PIXELS,
    MAX_OUTPUT_BYTES, MAX_EDGE,
)

_ACTIONS = (BROWSE, MANAGE, ITEMS, ACCESS)
_ARTWORK = 'library.artwork.read'
_CONTEXT = re.compile(r'[0-9a-f]{64}\Z', re.ASCII)
_DECODE_REQUESTS = BoundedSemaphore(2)
_BATCH = 4
_MAX_ROOTS = 1024


def _context(value):
    if type(value) is not str or _CONTEXT.fullmatch(value) is None:
        raise AlbumTopError('invalid_command')
    return value


def _normalize_start(payload):
    if type(payload) is not dict or set(payload) != {'revision', 'items', 'request_key', 'request_generation'}:
        raise AlbumTopError('invalid_command')
    generation = payload['request_generation']
    if type(generation) is not int or not 1 <= generation <= 253402300799:
        raise AlbumTopError('invalid_command')
    rows = payload['items']
    if type(rows) is not list or len(rows) > 5000:
        raise AlbumTopError('invalid_command')
    plain, choices = [], []
    for row in rows:
        if type(row) is not dict or type(row.get('include_artwork')) is not bool:
            raise AlbumTopError('invalid_command')
        plain.append({key: value for key, value in row.items() if key != 'include_artwork'})
        choices.append(row['include_artwork'])
    normalized = normalize_top_publication_preview({'revision': payload['revision'], 'items': plain})
    if any(item['item_ref'] is None for item in normalized['items']):
        raise AlbumTopError('invalid_command')
    return normalized, choices, top_uuid(payload['request_key']), generation


def _source_item(row):
    return {'item_ref': str(row['item_ref']), 'album_ref': str(row['catalog_ref']),
            'selected_local_album_id': row['selected_local_album_id'],
            'selected_source_ref': str(row['selected_source_ref'])}


def _stamp(source):
    value = asdict(source)
    value['relative_parts'] = list(source.relative_parts)
    return value


def _capture_valid(result, source):
    # Acquisition is an internal collaborator, never browser input. Still reject
    # malformed collaborator results before SQL or counters can accept them.
    if (type(result) is not CapturedArtwork or result.source != source
            or result.sanitizer_contract != 1 or result.mime_type != 'image/png'
            or type(result.png) is not bytes or not 0 < len(result.png) <= MAX_OUTPUT_BYTES
            or not result.png.startswith(b'\x89PNG\r\n\x1a\n')
            or any(type(value) is not int for value in
                   (result.width, result.height, result.input_bytes, result.input_pixels))
            or not 1 <= result.width <= MAX_EDGE or not 1 <= result.height <= MAX_EDGE
            or not 1 <= result.input_bytes <= MAX_INPUT_BYTES
            or not 1 <= result.input_pixels <= MAX_INPUT_PIXELS
            or result.content_digest != hashlib.sha256(result.png).hexdigest()):
        raise AlbumTopError('artwork_preparation_unavailable', 409)


class TopArtworkPreparationService:
    """Explicitly constructed only; existing app composition does not register it."""
    def __init__(self, owner, *, capture=None, describe=None, resolver=None):
        self.owner = owner
        self.capture = capture or capture_artwork
        self.describe = describe or describe_artwork_source
        self.resolver = resolver or resolve_configured_media_path

    @contextmanager
    def _authorized(self, context, constraints):
        try:
            with self.owner._authorized(context, constraints) as transaction:
                yield transaction
        except AlbumTopError:
            raise
        except Exception as error:
            code = getattr(error, 'sqlstate', None)
            constraint = getattr(getattr(error, 'diag', None), 'constraint_name', '') or ''
            if code == '55P03' and constraint == 'top_artwork_busy':
                raise AlbumTopError('artwork_busy', 409) from None
            if code in {'23514', '55000', '22003'}:
                if constraint == 'top_artwork_request_conflict':
                    raise AlbumTopError('request_key_conflict', 409) from None
                if constraint == 'top_artwork_request_expired':
                    raise AlbumTopError('artwork_request_expired', 409) from None
                if constraint == 'top_artwork_retention_limit':
                    raise AlbumTopError('artwork_retention_limit', 409) from None
                if constraint == 'top_artwork_publication_budget' or constraint.startswith('album_top_artwork_budgets_'):
                    raise AlbumTopError('artwork_limit', 409) from None
                raise AlbumTopError('artwork_preparation_unavailable', 409) from None
            raise

    def _top(self, connection, live, ref, revision, constraints, *, write=False):
        top = self.owner._top(connection, live, ref, write=write)
        self.owner._require(live, _ACTIONS, constraints, top, owner_only=True)
        if str(top['revision']) != str(revision):
            raise AlbumTopError('revision_conflict', 409)
        return top

    @staticmethod
    def _lock_covers(connection, live, album_ids):
        # cover_path is deliberately absent from the existing metadata clock.
        # Retain selected album rows before taking that clock: metadata writers
        # acquire their row before their AFTER-trigger clock update as well.
        # The existing private artwork owner uses this same row-lock privilege.
        connection.execute('''select id from library.local_albums
            where library_id=%s and id=any(%s::bigint[]) order by id for share''',
            (live.library_id, sorted(set(album_ids)))).fetchall()

    def _load(self, connection, live, top, ref, context_ref):
        # The existing parent Top SHARE/UPDATE lock protects this read. Every
        # admitted SQL mutator takes that same Top UPDATE lock before the prep
        # row; runtime intentionally has SELECT only on private staging tables.
        row = connection.execute('''select *,clock_timestamp() as checked_at from app.album_top_artwork_preparations
            where ref=%s and top_ref=%s and library_id=%s and owner_account_id=%s
              and original_session_id=%s and context_ref=%s''',
            (ref, top['ref'], live.library_id, live.actor.account_id, live.actor.session_id, context_ref)).fetchone()
        if (row is None or row['preparation_kind'] != 'saved'
                or row['state'] == 'cancelled' or row['expires_at'] <= row['checked_at']
                or row['top_revision'] != top['revision']):
            raise AlbumTopError('artwork_preparation_unavailable', 409)
        # Exact full saved membership, checked without loading image blobs or
        # unbounded private path stamps. No new/removed/reordered item is hidden.
        check = connection.execute('''select count(*) as total,
            count(*) filter(where i.ref is not null and i.catalog_ref=p.catalog_ref
                and i.curator_position=p.position and i.library_id=p.library_id) as matching
            from app.album_top_artwork_preparation_items p left join app.album_list_items i
              on i.ref=p.item_ref and i.top_ref=p.top_ref where p.preparation_ref=%s''', (ref,)).fetchone()
        current = connection.execute('select count(*) as total from app.album_list_items where top_ref=%s',
                                     (top['ref'],)).fetchone()
        if check['total'] != row['item_count'] or check['matching'] != row['item_count'] or current['total'] != row['item_count']:
            raise AlbumTopError('items_changed', 409)
        selected = connection.execute('''select selected_local_album_id
            from app.album_top_artwork_preparation_items where preparation_ref=%s and included''', (ref,)).fetchall()
        self._lock_covers(connection, live, [item['selected_local_album_id'] for item in selected])
        return dict(row)

    def _metadata(self, connection, live, item, constraints):
        source, scope = evidence.selection_source(connection, live, _source_item(item), constraints)
        if (source['title_origin'] != 'tag_metadata' or source['artist_origin'] != 'tag_metadata'
                or source['library_root_id'] != item['selected_library_root_id']):
            raise AlbumTopError('evidence_unavailable', 409)
        return scope

    def _artwork(self, connection, live, item, constraints):
        require_private_action(live, _ARTWORK,
            resource=ResourceScope('album', str(item['selected_local_album_id'])), constraints=constraints)
        row = connection.execute('''select case when octet_length(cover_path)<=16384 then cover_path end as cover_path
            from library.local_albums where library_id=%s and id=%s''',
            (live.library_id, item['selected_local_album_id'])).fetchone()
        roots = connection.execute('''select id,case when octet_length(root_path)<=8192 then root_path end as root_path
            from library.library_roots where library_id=%s and is_active is true order by id limit %s''',
            (live.library_id, _MAX_ROOTS + 1)).fetchall()
        if row is None or not row['cover_path'] or not roots or len(roots) > _MAX_ROOTS or any(r['root_path'] is None for r in roots):
            raise ArtworkAcquisitionUnavailable('artwork_unavailable')
        # Explicit current-library roots avoid the resolver's global settings
        # loader/nested DB path. The descriptor supplies the open-time guarantee.
        paths = tuple(Path(root['root_path']) for root in roots)
        path = self.resolver(self.owner._config, row['cover_path'], configured_root_paths=paths,
                             require_file=False, require_exists=False)
        if path is None:
            raise ArtworkAcquisitionUnavailable('artwork_unavailable')
        matches = [root for root in roots if path.is_relative_to(Path(root['root_path']))]
        if not matches:
            raise ArtworkAcquisitionUnavailable('artwork_unavailable')
        # The most-specific active root owns an overlap. A deny on that root
        # cannot be bypassed by selecting a broader permitted ancestor.
        actual = max(matches, key=lambda root: (len(Path(root['root_path']).parts), -root['id']))
        require_private_action(live, BROWSE, resource=ResourceScope('library_root', str(actual['id'])), constraints=constraints)
        return self.describe(library_id=live.library_id, local_album_id=item['selected_local_album_id'],
            artwork_root_id=actual['id'], artwork_root_path=Path(actual['root_path']),
            stored_cover_path=row['cover_path'], resolved_cover_path=path)

    def _final(self, live, top, scopes, sources, constraints):
        # Mutable resolvers may change during later rows/SQL waits. Recheck all
        # scopes used in this operation, then existing _authorized rechecks the
        # actual session after the final statement before transaction commit.
        for scope in scopes:
            require_source_browse(live, scope, constraints)
        for source in sources:
            require_private_action(live, _ARTWORK,
                resource=ResourceScope('album', str(source.local_album_id)), constraints=constraints)
            require_private_action(live, BROWSE,
                resource=ResourceScope('library_root', str(source.artwork_root_id)), constraints=constraints)
        self.owner._require(live, _ACTIONS, constraints, top, owner_only=True)

    def _status(self, connection, preparation, *, after=0, limit=100):
        counts = connection.execute('''select count(*) filter(where status='ready') as ready,
            count(*) filter(where included) as included,count(*) filter(where status='failed') as failed,
            coalesce(sum(a.byte_length),0) as byte_length from app.album_top_artwork_preparation_items i
            left join app.album_top_artwork_assets a on a.ref=i.asset_ref where preparation_ref=%s''',
            (preparation['ref'],)).fetchone()
        rows = connection.execute('''select i.item_ref,i.catalog_ref,i.position,i.included,i.status,i.error_code,
            i.asset_ref,a.content_digest,a.width,a.height,a.byte_length
            from app.album_top_artwork_preparation_items i left join app.album_top_artwork_assets a on a.ref=i.asset_ref
            where i.preparation_ref=%s and i.position>%s order by i.position limit %s''',
            (preparation['ref'], after, limit + 1)).fetchall()
        return {'preparation_ref': str(preparation['ref']), 'preparation_revision': str(preparation['revision']),
            'top_revision': str(preparation['top_revision']), 'state': preparation['state'],
            'expires_at': preparation['expires_at'].isoformat(), 'item_count': preparation['item_count'],
            'included_count': counts['included'], 'ready_count': counts['ready'], 'failed_count': counts['failed'],
            'byte_length': counts['byte_length'], 'items': [{
                'item_ref': str(row['item_ref']), 'album_ref': str(row['catalog_ref']), 'position': row['position'],
                'included': row['included'], 'status': row['status'], 'error_code': row['error_code'],
                'asset_ref': str(row['asset_ref']) if row['asset_ref'] else None,
                'content_digest': row['content_digest'], 'width': row['width'], 'height': row['height'],
                'byte_length': row['byte_length']} for row in rows[:limit]],
            'next_position': rows[limit - 1]['position'] if len(rows) > limit else None}

    def start(self, context, *, top_ref, payload, context_ref, constraints=None):
        ref, context_ref = top_uuid(top_ref), _context(context_ref)
        draft, choices, key, generation = _normalize_start(payload)
        with self._authorized(context, constraints) as (connection, live, _):
            top = self._top(connection, live, ref, draft['revision'], constraints, write=True)
            current = publication.working_items(connection, top)
            if [(str(row['ref']), str(row['catalog_ref'])) for row in current] != [
                    (item['item_ref'], item['album_ref']) for item in draft['items']]:
                raise AlbumTopError('items_changed', 409)
            self._lock_covers(connection, live, [item['selected_local_album_id']
                for item, included in zip(draft['items'], choices) if included])
            evidence.source_barrier(connection, live.library_id)
            manifest, scopes = [], []
            for position, (item, included) in enumerate(zip(draft['items'], choices), 1):
                source, scope = evidence.selection_source(connection, live, item, constraints)
                if source['title_origin'] != 'tag_metadata' or source['artist_origin'] != 'tag_metadata':
                    raise AlbumTopError('evidence_unavailable', 409)
                if included:
                    require_private_action(live, _ARTWORK,
                        resource=ResourceScope('album', str(item['selected_local_album_id'])), constraints=constraints)
                scopes.append(scope)
                manifest.append({'item_ref': item['item_ref'], 'catalog_ref': item['album_ref'], 'position': position,
                    **scope, 'included': included})
            digest = evidence.digest(['private-top-artwork-preparation-v2', ref, live.library_id,
                live.actor.account_id, live.actor.session_id, context_ref, draft['revision'], generation, manifest])
            created = connection.execute('''select app.start_top_artwork_preparation
                (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) as ref''',
                (str(uuid4()), ref, live.library_id, live.actor.account_id, live.actor.session_id, context_ref,
                 int(draft['revision']), key, digest, Jsonb(manifest), generation)).fetchone()['ref']
            preparation = self._load(connection, live, top, str(created), context_ref)
            result = self._checked_status(connection, live, top, preparation, constraints)
            for item, included in zip(draft['items'], choices):
                if included:
                    require_private_action(live, _ARTWORK,
                        resource=ResourceScope('album', str(item['selected_local_album_id'])), constraints=constraints)
            self._final(live, top, scopes, [], constraints)
            return result

    def start_draft(self, context, *, top_ref, payload, context_ref, constraints=None):
        """Admit immutable typed local selections, without creating saved items.

        This B2.1 entry cannot capture, review or publish a draft. Remote baseline
        facts bind identity only; removing/replacing them needs no new remote
        source admission. Every proposed local source is authorized afresh.
        """
        ref, context_ref = top_uuid(top_ref), _context(context_ref)
        command = artwork_draft.normalize(payload)
        draft = command['draft']
        with self._authorized(context, constraints) as (connection, live, _):
            top = self._top(connection, live, ref, draft['revision'], constraints, write=True)
            current = publication.working_items(connection, top)
            publication.validate_draft_membership(draft['items'], current)
            # Every selected album, including excluded rows, is locked before
            # the metadata barrier. Do not discover alternate catalog links:
            # selection_source below proves the exact selected catalog/source
            # and applies current album/source/root Browse authority.
            selected_ids = sorted({item['selected_local_album_id'] for item in draft['items']})
            for offset in range(0, len(selected_ids), 100):
                self._lock_covers(connection, live, selected_ids[offset:offset + 100])
            evidence.source_barrier(connection, live.library_id)
            manifest, scopes = [], []
            for position, (row_ref, item, included) in enumerate(zip(
                    command['row_refs'], draft['items'], command['choices']), 1):
                source, scope = evidence.selection_source(connection, live, item, constraints)
                if source['title_origin'] != 'tag_metadata' or source['artist_origin'] != 'tag_metadata':
                    raise AlbumTopError('evidence_unavailable', 409)
                if included:
                    require_private_action(live, _ARTWORK,
                        resource=ResourceScope('album', str(item['selected_local_album_id'])), constraints=constraints)
                scopes.append(scope)
                manifest.append(artwork_draft.manifest_row(row_ref, item, position, included, scope))
            baseline = connection.execute('''select app.top_artwork_draft_baseline(%s,%s,%s,%s) as digest''',
                (ref, live.library_id, live.actor.account_id, int(draft['revision']))).fetchone()['digest']
            created = connection.execute('''select app.start_top_artwork_draft_preparation
                (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) as ref''',
                (str(uuid4()), ref, live.library_id, live.actor.account_id, live.actor.session_id,
                 context_ref, int(draft['revision']), command['request_key'], command['request_generation'],
                 command['draft_ref'], int(command['draft_revision']), baseline, Jsonb(manifest))).fetchone()['ref']
            row = connection.execute('''select ref,revision,draft_ref,draft_revision,top_revision,
                state,item_count,expires_at from app.album_top_artwork_preparations where ref=%s''',
                (created,)).fetchone()
            for item, included in zip(draft['items'], command['choices']):
                if included:
                    require_private_action(live, _ARTWORK,
                        resource=ResourceScope('album', str(item['selected_local_album_id'])), constraints=constraints)
            self._final(live, top, scopes, [], constraints)
            if connection.execute('select clock_timestamp()>=%s as expired',
                    (row['expires_at'],)).fetchone()['expired']:
                raise AlbumTopError('artwork_request_expired', 409)
            return {'preparation_kind': 'draft', 'preparation_ref': str(row['ref']),
                    'preparation_revision': str(row['revision']), 'draft_ref': str(row['draft_ref']),
                    'draft_revision': str(row['draft_revision']), 'saved_top_revision': str(row['top_revision']),
                    'state': row['state'], 'item_count': row['item_count'],
                    'included_count': sum(command['choices']), 'expires_at': row['expires_at'].isoformat()}

    def cleanup(self, context, *, top_ref, top_revision_value, context_ref, constraints=None):
        """Explicit bounded owner-private reclamation; never called by reads.

        No pixels, source paths or resolver work is needed to discard expired or
        cancelled staging. A normal start also performs one bounded SQL pass
        after its replay check. An admission failure rolls that entire pass back;
        this separate operation lets authorized callers make durable progress.
        """
        ref, revision = top_uuid(top_ref), top_revision(top_revision_value)
        _context(context_ref)
        with self._authorized(context, constraints) as (connection, live, _):
            # Deleted parents still own retained quota. Only this reclamation
            # operation admits them; ordinary read/start/advance stay closed.
            top = self.owner._top(connection, live, ref, write=True, allow_deleted=True)
            self.owner._require(live, _ACTIONS, constraints, top, owner_only=True)
            if str(top['revision']) != str(revision):
                raise AlbumTopError('revision_conflict', 409)
            result = connection.execute('''select app.cleanup_top_artwork_preparations
                (%s,%s,%s,%s) as result''',
                (ref, live.library_id, live.actor.account_id, int(revision))).fetchone()['result']
            self._final(live, top, [], [], constraints)
            return result

    def advance(self, context, *, top_ref, preparation_ref, top_revision_value,
                preparation_revision, request_key, context_ref, constraints=None):
        ref, preparation_ref = top_uuid(top_ref), top_uuid(preparation_ref)
        revision, prep_revision = top_revision(top_revision_value), top_revision(preparation_revision)
        key, context_ref = top_uuid(request_key), _context(context_ref)
        # No queue and no DB claim while busy. The one process gate is shared by
        # all service instances and retained until commit/drop of temporary bytes.
        if not _DECODE_REQUESTS.acquire(blocking=False):
            raise AlbumTopError('artwork_busy', 409)
        try:
            lease, sources, rows = str(uuid4()), {}, []
            with self._authorized(context, constraints) as (connection, live, _):
                top = self._top(connection, live, ref, revision, constraints, write=True)
                preparation = self._load(connection, live, top, preparation_ref, context_ref)
                evidence.source_barrier(connection, live.library_id)
                chosen = connection.execute('''select app.claim_top_artwork_batch(%s,%s,%s,%s,%s,%s,%s) as items''',
                    (preparation_ref, live.actor.account_id, live.actor.session_id, context_ref,
                     int(prep_revision), key, lease)).fetchone()['items']
                if not chosen:
                    return self._checked_status(connection, live, top, preparation, constraints)
                rows = connection.execute('''select * from app.album_top_artwork_preparation_items
                    where preparation_ref=%s and item_ref=any(%s::uuid[]) order by position''',
                    (preparation_ref, chosen)).fetchall()
                if not 1 <= len(rows) <= _BATCH or len(rows) != len(chosen):
                    raise AlbumTopError('artwork_preparation_unavailable', 409)
                scopes = []
                for item in rows:
                    scopes.append(self._metadata(connection, live, item, constraints))
                    try:
                        sources[str(item['item_ref'])] = self._artwork(connection, live, item, constraints)
                    except ArtworkAcquisitionUnavailable:
                        sources[str(item['item_ref'])] = None
                self._final(live, top, scopes, [value for value in sources.values() if value is not None], constraints)
            # No connection, account/Top/source lock or provider fetch here.
            captured, total_bytes, total_pixels = {}, 0, 0
            for item in rows:
                item_ref = str(item['item_ref'])
                source = sources[item_ref]
                if source is None:
                    captured[item_ref] = None
                    continue
                try:
                    result = self.capture(source)
                except ArtworkAcquisitionUnavailable:
                    captured[item_ref] = None
                    continue
                _capture_valid(result, source)
                total_bytes += result.input_bytes
                total_pixels += result.input_pixels
                if total_bytes > _BATCH * MAX_INPUT_BYTES or total_pixels > _BATCH * MAX_INPUT_PIXELS:
                    raise AlbumTopError('artwork_limit', 409)
                captured[item_ref] = result
            with self._authorized(context, constraints) as (connection, live, _):
                top = self._top(connection, live, ref, revision, constraints, write=True)
                self._load(connection, live, top, preparation_ref, context_ref)
                evidence.source_barrier(connection, live.library_id)
                scopes, current_sources, results, pngs = [], [], [], []
                for item in rows:
                    item_ref, result = str(item['item_ref']), captured[str(item['item_ref'])]
                    scopes.append(self._metadata(connection, live, item, constraints))
                    try:
                        current = self._artwork(connection, live, item, constraints)
                    except ArtworkAcquisitionUnavailable:
                        current = None
                    if current is not None:
                        current_sources.append(current)
                    if result is None:
                        results.append({'item_ref': item_ref, 'status': 'failed', 'error_code': 'artwork_unavailable'})
                        pngs.append(None)
                    elif current != result.source:
                        raise AlbumTopError('artwork_source_changed', 409)
                    else:
                        results.append({'item_ref': item_ref, 'status': 'ready', 'asset_ref': str(uuid4()),
                            'content_digest': result.content_digest, 'width': result.width, 'height': result.height,
                            'source_stamp': _stamp(result.source), 'acquisition_stamp': {
                                'file': asdict(result.file_observation), 'input_bytes': result.input_bytes,
                                'input_pixels': result.input_pixels}})
                        pngs.append(result.png)
                connection.execute('''select app.complete_top_artwork_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                    (preparation_ref, live.actor.account_id, live.actor.session_id, context_ref,
                     int(prep_revision), key, lease, Jsonb(results), pngs)).fetchone()
                preparation = self._load(connection, live, top, preparation_ref, context_ref)
                response = self._checked_status(connection, live, top, preparation, constraints)
                self._final(live, top, scopes, current_sources, constraints)
                return response
        finally:
            _DECODE_REQUESTS.release()

    def read(self, context, *, top_ref, preparation_ref, top_revision_value,
             context_ref, after=0, limit=100, constraints=None):
        ref, prep = top_uuid(top_ref), top_uuid(preparation_ref)
        revision, context_ref = top_revision(top_revision_value), _context(context_ref)
        if type(after) is not int or not 0 <= after <= 5000 or type(limit) is not int or not 1 <= limit <= 100:
            raise AlbumTopError('invalid_query')
        with self._authorized(context, constraints) as (connection, live, _):
            top = self._top(connection, live, ref, revision, constraints)
            preparation = self._load(connection, live, top, prep, context_ref)
            return self._checked_status(connection, live, top, preparation, constraints, after=after, limit=limit)

    def _checked_status(self, connection, live, top, preparation, constraints, *, after=0, limit=100):
        rows = connection.execute('''select * from app.album_top_artwork_preparation_items
            where preparation_ref=%s and position>%s order by position limit %s''', (preparation['ref'], after, limit)).fetchall()
        evidence.source_barrier(connection, live.library_id)
        scopes, sources = [], []
        for item in rows:
            scopes.append(self._metadata(connection, live, item, constraints))
            if item['included']:
                require_private_action(live, _ARTWORK,
                    resource=ResourceScope('album', str(item['selected_local_album_id'])), constraints=constraints)
            if item['status'] == 'ready':
                try:
                    source = self._artwork(connection, live, item, constraints)
                except ArtworkAcquisitionUnavailable:
                    raise AlbumTopError('artwork_source_changed', 409) from None
                if _stamp(source) != item['source_stamp']:
                    raise AlbumTopError('artwork_source_changed', 409)
                sources.append(source)
        response = self._status(connection, preparation, after=after, limit=limit)
        for item in rows:
            if item['included']:
                require_private_action(live, _ARTWORK,
                    resource=ResourceScope('album', str(item['selected_local_album_id'])), constraints=constraints)
        self._final(live, top, scopes, sources, constraints)
        # The database owns preparation/lease time. Recheck after source/status
        # work as well; a slow read must not release an expired private handle.
        if connection.execute('select clock_timestamp() as now').fetchone()['now'] >= preparation['expires_at']:
            raise AlbumTopError('artwork_preparation_unavailable', 409)
        return response
