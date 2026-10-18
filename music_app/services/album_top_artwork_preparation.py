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
from music_app.services import _top_artwork_saved as saved_artwork
from music_app.services import _top_artwork_preparation_phases as preparation_phases
from music_app.services import _top_artwork_draft_proof as draft_proof
from music_app.services import artwork_proof_codec as proof_codec
from music_app.services import album_top_artwork_review as review_owner
from music_app.services.album_top_publication_authority import require_source_browse
from music_app.services.library_roots import resolve_configured_media_path
from music_app.services.library_roots import resolve_typed_artwork_observations
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


def _review_identity(context, *, kind, top_ref, top_revision_value, preparation_ref,
                     preparation_revision, context_ref, draft_ref=None, draft_revision=None):
    # Fixed private entrypoints, never a caller-selected source/proof adapter.
    if kind not in ('saved', 'draft'):
        raise AlbumTopError('invalid_command')
    identity = {'context': context, 'top_ref': artwork_draft._identity(top_ref),
                'top_revision': top_revision(top_revision_value),
                'preparation_ref': artwork_draft._identity(preparation_ref),
                'context_ref': _context(context_ref)}
    revision = top_revision(preparation_revision)
    if kind == 'draft':
        identity.update(draft_ref=artwork_draft._identity(draft_ref),
                        draft_revision=top_revision(draft_revision))
    return identity, revision


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
                if constraint == 'top_artwork_preparation_consumed':
                    raise AlbumTopError('artwork_preparation_consumed', 409) from None
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

    def _start_top(self, connection, live, ref, revision, key, constraints):
        # Current scope/owner non-disclosure precedes consumed-key recovery;
        # old revision and source/preparation discovery deliberately follow it.
        top = self.owner._top(connection, live, ref, write=True)
        self.owner._require(live, _ACTIONS, constraints, top, owner_only=True)
        consumed = connection.execute('select app.top_artwork_start_consumed(%s,%s,%s,%s) as consumed',
            (ref, live.library_id, live.actor.account_id, key)).fetchone()['consumed']
        if consumed:
            raise AlbumTopError('artwork_preparation_consumed', 409)
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
        return saved_artwork.start(self, context, ref, draft, choices, key, generation,
                                   context_ref, constraints)

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
            top = self._start_top(connection, live, ref, draft['revision'], command['request_key'], constraints)
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
        identity = {'context': context, 'top_ref': ref, 'preparation_ref': preparation_ref,
                    'top_revision': revision, 'context_ref': context_ref}
        return preparation_phases.advance(self, identity, kind='saved',
            preparation_revision=prep_revision, request_key=key, constraints=constraints)

    def _capture_rows(self, rows, sources, *, kind):
        """One synchronous sequential image loop for both fixed row kinds."""
        if kind not in ('saved', 'draft') or not 1 <= len(rows) <= _BATCH:
            raise AlbumTopError('artwork_preparation_unavailable', 409)
        field = 'item_ref' if kind == 'saved' else 'row_ref'
        captured, total_bytes, total_pixels, result = {}, 0, 0, None
        try:
            for item in rows:
                row_ref = str(item[field])
                source = sources[row_ref]
                if source is None:
                    captured[row_ref] = None
                    continue
                try:
                    result = self.capture(source)
                except ArtworkAcquisitionUnavailable:
                    captured[row_ref] = None
                    result = None
                    continue
                _capture_valid(result, source)
                total_bytes += result.input_bytes
                total_pixels += result.input_pixels
                if total_bytes > _BATCH * MAX_INPUT_BYTES or total_pixels > _BATCH * MAX_INPUT_PIXELS:
                    raise AlbumTopError('artwork_limit', 409)
                captured[row_ref] = result
                result = None
            return captured
        except BaseException as error:
            captured.clear()
            result = None
            error.__context__ = None
            error.__cause__ = None
            raise error.with_traceback(None)

    def read(self, context, *, top_ref, preparation_ref, top_revision_value,
             context_ref, after=0, limit=100, constraints=None):
        ref, prep = top_uuid(top_ref), top_uuid(preparation_ref)
        revision, context_ref = top_revision(top_revision_value), _context(context_ref)
        if type(after) is not int or not 0 <= after <= 5000 or type(limit) is not int or not 1 <= limit <= 100:
            raise AlbumTopError('invalid_query')
        identity = {'context': context, 'top_ref': ref, 'preparation_ref': prep,
                    'top_revision': revision, 'context_ref': context_ref}
        return preparation_phases.read(self, identity, kind='saved', after=after, limit=limit,
                                       constraints=constraints)

    def _draft_snapshot(self, connection, live, top, ref, context_ref, draft_ref,
                        draft_revision, constraints):
        try:
            return artwork_draft.load_snapshot(self, connection, live, top, ref, context_ref,
                                                draft_ref, draft_revision, constraints)
        except proof_codec.InvalidArtworkProof:
            raise AlbumTopError('artwork_source_changed', 409) from None

    def _draft_finish(self, connection, live, top, snapshot, observations, constraints, *, lease=None):
        # Response/mutation queries precede policy. The clock follows all policy
        # callbacks so their cost cannot outlive the original claim deadlines.
        for scope in snapshot['scopes']:
            require_source_browse(live, scope, constraints)
        for row in snapshot['rows']:
            if row['included']:
                require_private_action(live, _ARTWORK,
                    resource=ResourceScope('album', str(row['selected_local_album_id'])), constraints=constraints)
        for observed, _ in observations.values():
            require_private_action(live, BROWSE,
                resource=ResourceScope('library_root', str(observed.root_id)), constraints=constraints)
        self.owner._require(live, _ACTIONS, constraints, top, owner_only=True)
        now = connection.execute('select clock_timestamp() as now').fetchone()['now']
        header = snapshot['header']
        if (now >= header['expires_at'] or lease is not None
                and (header['lease_expires_at'] is None or now >= header['lease_expires_at'])):
            raise AlbumTopError('artwork_preparation_unavailable', 409)
        # Only the existing authorized owner's held-session exit fence follows.

    @staticmethod
    def _draft_probe(snapshot):
        request = artwork_draft.request(snapshot)
        try:
            result = resolve_typed_artwork_observations(request)
        except artwork_draft.resolution.ResolutionInputInvalid:
            raise AlbumTopError('artwork_source_invalid', 409) from None
        observations = draft_proof.checked_observations(result, request)
        try:
            for observed, root in observations.values():
                # The resolver's primitive supports a broader descendant bound
                # than the persisted producer. Check EVERY row outside DB,
                # discarding each descriptor/proof immediately, before any claim.
                if snapshot['kind'] == 'saved':
                    draft_proof.saved_source_base(snapshot['header']['library_id'], observed, root)
                else:
                    draft_proof.observation_source(snapshot['header']['library_id'], observed, root,
                        snapshot['inventory_digest'])
        except (proof_codec.InvalidArtworkProof, ArtworkAcquisitionUnavailable):
            raise AlbumTopError('artwork_source_changed', 409) from None
        return observations

    @staticmethod
    def _draft_claim(connection, live, preparation_ref, prep_revision, key, lease,
                     context_ref, draft_ref, draft_revision):
        return connection.execute('''select app.claim_top_artwork_draft_batch
            (%s,%s,%s,%s,%s,%s,%s,%s,%s) as items''',
            (preparation_ref, live.actor.account_id, live.actor.session_id, context_ref,
             int(prep_revision), key, lease, draft_ref, int(draft_revision))).fetchone()['items']

    @staticmethod
    def _draft_refresh_header(connection, snapshot):
        header = connection.execute('''select * from app.album_top_artwork_preparations where ref=%s''',
            (snapshot['header']['ref'],)).fetchone()
        if header is None:
            raise AlbumTopError('artwork_preparation_unavailable', 409)
        snapshot['header'] = dict(header)
        snapshot['digest'] = artwork_draft.fingerprint(snapshot['header'], snapshot['source_digest'])

    @staticmethod
    def _draft_lease(snapshot, prep_revision, key, lease, chosen):
        header = snapshot['header']
        if (header['state'] != 'preparing' or header['revision'] != int(prep_revision)
                or header['batch_from_revision'] != int(prep_revision)
                or str(header['batch_request_key']) != key or str(header['lease_ref']) != lease
                or [str(value) for value in (header['batch_items'] or [])] != chosen):
            raise AlbumTopError('artwork_preparation_unavailable', 409)

    def read_draft(self, context, *, top_ref, preparation_ref, top_revision_value,
                   draft_ref, draft_revision, context_ref, after=0, limit=100, constraints=None):
        ref, prep = artwork_draft._identity(top_ref), artwork_draft._identity(preparation_ref)
        draft_ref, context_ref = artwork_draft._identity(draft_ref), _context(context_ref)
        revision, draft_revision = top_revision(top_revision_value), top_revision(draft_revision)
        if type(after) is not int or not 0 <= after <= 5000 or type(limit) is not int or not 1 <= limit <= 100:
            raise AlbumTopError('invalid_query')
        identity = {'context': context, 'top_ref': ref, 'preparation_ref': prep,
                    'top_revision': revision, 'context_ref': context_ref,
                    'draft_ref': draft_ref, 'draft_revision': draft_revision}
        return preparation_phases.read(self, identity, kind='draft', after=after, limit=limit,
                                       constraints=constraints)

    def advance_draft(self, context, *, top_ref, preparation_ref, top_revision_value,
                      draft_ref, draft_revision, preparation_revision, request_key,
                      context_ref, constraints=None):
        ref, prep = artwork_draft._identity(top_ref), artwork_draft._identity(preparation_ref)
        draft_ref, key = artwork_draft._identity(draft_ref), artwork_draft._identity(request_key)
        revision, prep_revision = top_revision(top_revision_value), top_revision(preparation_revision)
        draft_revision, context_ref = top_revision(draft_revision), _context(context_ref)
        identity = {'context': context, 'top_ref': ref, 'preparation_ref': prep,
                    'top_revision': revision, 'context_ref': context_ref,
                    'draft_ref': draft_ref, 'draft_revision': draft_revision}
        return preparation_phases.advance(self, identity, kind='draft',
            preparation_revision=prep_revision, request_key=key, constraints=constraints)


    def review_saved(self, context, *, top_ref, top_revision, preparation_ref,
                     preparation_revision, context_ref, cursor_secret, constraints=None):
        """Explicit full review only; no claim, image capture, publication or renewal."""
        identity, revision = _review_identity(context, kind='saved', top_ref=top_ref,
            top_revision_value=top_revision, preparation_ref=preparation_ref,
            preparation_revision=preparation_revision, context_ref=context_ref)
        review_owner.require_key(cursor_secret)
        return preparation_phases.review(self, identity, kind='saved',
            preparation_revision=revision, cursor_secret=cursor_secret, constraints=constraints)

    def review_draft(self, context, *, top_ref, top_revision, preparation_ref,
                     preparation_revision, draft_ref, draft_revision, context_ref,
                     cursor_secret, constraints=None):
        identity, revision = _review_identity(context, kind='draft', top_ref=top_ref,
            top_revision_value=top_revision, preparation_ref=preparation_ref,
            preparation_revision=preparation_revision, context_ref=context_ref,
            draft_ref=draft_ref, draft_revision=draft_revision)
        review_owner.require_key(cursor_secret)
        return preparation_phases.review(self, identity, kind='draft',
            preparation_revision=revision, cursor_secret=cursor_secret, constraints=constraints)

    def review_publication_saved(self, context, *, top_ref, top_revision, preparation_ref,
                                 preparation_revision, context_ref, cursor_secret,
                                 title, description, action, constraints=None):
        identity, revision = _review_identity(context, kind='saved', top_ref=top_ref,
            top_revision_value=top_revision, preparation_ref=preparation_ref,
            preparation_revision=preparation_revision, context_ref=context_ref)
        header = review_owner.publication_header(title, description)
        if type(action) is not str or action not in ('save', 'enable_external'):
            raise AlbumTopError('invalid_command')
        review_owner.require_key(cursor_secret)
        return preparation_phases.publication_review(self, identity, kind='saved',
            preparation_revision=revision, cursor_secret=cursor_secret, header=header,
            action=action, constraints=constraints)

    def review_publication_draft(self, context, *, top_ref, top_revision, preparation_ref,
                                 preparation_revision, draft_ref, draft_revision, context_ref,
                                 cursor_secret, title, description, action, constraints=None):
        identity, revision = _review_identity(context, kind='draft', top_ref=top_ref,
            top_revision_value=top_revision, preparation_ref=preparation_ref,
            preparation_revision=preparation_revision, context_ref=context_ref,
            draft_ref=draft_ref, draft_revision=draft_revision)
        header = review_owner.publication_header(title, description)
        if type(action) is not str or action not in ('save', 'enable_external'):
            raise AlbumTopError('invalid_command')
        review_owner.require_key(cursor_secret)
        return preparation_phases.publication_review(self, identity, kind='draft',
            preparation_revision=revision, cursor_secret=cursor_secret, header=header,
            action=action, constraints=constraints)

    def read_saved_png(self, context, *, top_ref, top_revision, preparation_ref,
                       preparation_revision, context_ref, cursor_secret, review_witness,
                       row_ref, asset_ref, head_only=False, constraints=None):
        """One immutable PNG after full fresh review binding and owner fences."""
        identity, revision = _review_identity(context, kind='saved', top_ref=top_ref,
            top_revision_value=top_revision, preparation_ref=preparation_ref,
            preparation_revision=preparation_revision, context_ref=context_ref)
        if type(head_only) is not bool:
            raise AlbumTopError('invalid_command')
        row_ref, asset_ref = artwork_draft._identity(row_ref), artwork_draft._identity(asset_ref)
        review_owner.require_key(cursor_secret)
        witness = review_owner.normalize_witness(review_witness)
        return preparation_phases.png(self, identity, kind='saved', preparation_revision=revision,
            cursor_secret=cursor_secret, review_witness=witness, row_ref=row_ref, asset_ref=asset_ref,
            head_only=head_only, constraints=constraints)

    def read_draft_png(self, context, *, top_ref, top_revision, preparation_ref,
                       preparation_revision, draft_ref, draft_revision, context_ref,
                       cursor_secret, review_witness, row_ref, asset_ref, head_only=False,
                       constraints=None):
        identity, revision = _review_identity(context, kind='draft', top_ref=top_ref,
            top_revision_value=top_revision, preparation_ref=preparation_ref,
            preparation_revision=preparation_revision, context_ref=context_ref,
            draft_ref=draft_ref, draft_revision=draft_revision)
        if type(head_only) is not bool:
            raise AlbumTopError('invalid_command')
        row_ref, asset_ref = artwork_draft._identity(row_ref), artwork_draft._identity(asset_ref)
        review_owner.require_key(cursor_secret)
        witness = review_owner.normalize_witness(review_witness)
        return preparation_phases.png(self, identity, kind='draft', preparation_revision=revision,
            cursor_secret=cursor_secret, review_witness=witness, row_ref=row_ref, asset_ref=asset_ref,
            head_only=head_only, constraints=constraints)
