"""One fixed full-vector phase driver for saved and typed private artwork.

No route, connection factory, semaphore or external adapter registration lives
here. Probe/capture work occurs only between successful authority exits.
"""
from uuid import uuid4
from psycopg.types.json import Jsonb
from music_app.services import album_top_artwork_draft as artwork_draft
from music_app.services import _top_artwork_saved as saved
from music_app.services import _top_artwork_draft_proof as draft_proof
from music_app.services import artwork_proof_codec as proof_codec
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.public_top_artwork_acquisition import ArtworkAcquisitionUnavailable, MAX_OUTPUT_BYTES

_BATCH = 4


def _load(service, connection, live, top, identity, kind, constraints, *, mode):
    try:
        if kind == 'saved':
            return saved.load_snapshot(service, connection, live, top, identity, constraints, mode)
        if kind == 'draft':
            return service._draft_snapshot(connection, live, top, identity['preparation_ref'],
                identity['context_ref'], identity['draft_ref'], identity['draft_revision'], constraints)
        raise AlbumTopError('invalid_command')
    except proof_codec.InvalidArtworkProof:
        raise AlbumTopError('artwork_source_changed', 409) from None


def _status(service, connection, snapshot, kind, *, after=0, limit=100):
    if kind == 'saved':
        return service._status(connection, snapshot['header'], after=after, limit=limit)
    return artwork_draft.status(connection, snapshot, after=after, limit=limit)


def _claim(service, connection, live, identity, kind, revision, key, lease):
    if kind == 'saved':
        return saved.claim(connection, live, identity, revision, key, lease)
    return service._draft_claim(connection, live, identity['preparation_ref'], revision, key,
        lease, identity['context_ref'], identity['draft_ref'], identity['draft_revision'])


def _complete(connection, live, identity, kind, revision, key, lease, results, pngs):
    if kind == 'saved':
        return saved.complete(connection, live, identity, revision, key, lease, results, pngs)
    connection.execute('''select app.complete_top_artwork_draft_batch
        (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
        (identity['preparation_ref'], live.actor.account_id, live.actor.session_id,
         identity['context_ref'], int(revision), key, lease, identity['draft_ref'],
         int(identity['draft_revision']), Jsonb(results, dumps=artwork_draft.result_json), pngs)).fetchone()


def _saved_lease(service, snapshot, revision, key, lease, chosen):
    service._draft_lease(snapshot, revision, key, lease, chosen)
    header = snapshot['header']
    if (header['lease_expires_at'] is None
            or header['checked_at'] >= header['lease_expires_at']):
        raise AlbumTopError('artwork_preparation_unavailable', 409)


def _source_base(kind, library_id, observed, root, prepared):
    if kind == 'saved':
        return draft_proof.saved_source_base(library_id, observed, root)
    return draft_proof.source_base(library_id, observed, root, prepared)


def _captured_pair(kind, result, base):
    if kind == 'saved':
        source, acquisition = draft_proof.saved_captured_pair(result, base)
        return source, acquisition, None
    return draft_proof.captured_pair(result, base)


def _ready_binding(kind, source, acquisition, prepared, *, library_id, local_album_id, stored_cover_path):
    if kind == 'saved':
        return draft_proof.saved_ready_binding(source, acquisition, library_id=library_id,
            local_album_id=local_album_id, stored_cover_path=stored_cover_path)
    return draft_proof.ready_binding(source, acquisition, prepared,
        library_id=library_id, local_album_id=local_album_id)


def _saved_root_ids(kind, observations):
    # Only server-validated observations supply these IDs. No authority result,
    # descriptor, or image is retained across capture with this bounded set.
    if kind != 'saved':
        return ()
    ids = tuple(sorted({observed.root_id for observed, _ in observations.values()}))
    if len(ids) > 1024:
        raise AlbumTopError('artwork_validation_limit', 409)
    return ids


def read(service, identity, *, kind, after=0, limit=100, constraints=None):
    context, ref, revision = identity['context'], identity['top_ref'], identity['top_revision']
    prepared = None
    try:
        with service._authorized(context, constraints) as (connection, live, _):
            top = service._top(connection, live, ref, revision, constraints)
            snapshot, prepared = _load(service, connection, live, top, identity, kind, constraints, mode='read')
            if not snapshot['observe_count']:
                response = _status(service, connection, snapshot, kind, after=after, limit=limit)
                service._draft_finish(connection, live, top, snapshot, {}, constraints)
                return response
            service._draft_finish(connection, live, top, snapshot, {}, constraints)
            prepared = None
        observations = service._draft_probe(snapshot)
        observed_root_ids = _saved_root_ids(kind, observations)
        with service._authorized(context, constraints) as (connection, live, _):
            top = service._top(connection, live, ref, revision, constraints)
            if kind == 'saved':
                saved.require_observed_roots(live, observed_root_ids, constraints)
            current, prepared = _load(service, connection, live, top, identity, kind, constraints, mode='read')
            artwork_draft.compare(snapshot, current)
            response = _status(service, connection, current, kind, after=after, limit=limit)
            service._draft_finish(connection, live, top, current, observations, constraints)
            return response
    finally:
        prepared = None



def advance(service, identity, *, kind, preparation_revision, request_key, constraints=None):
    # The service owns the sole process gate; no independent per-kind capacity.
    from music_app.services.album_top_artwork_preparation import _DECODE_REQUESTS
    gate = _DECODE_REQUESTS
    context, ref, revision = identity['context'], identity['top_ref'], identity['top_revision']
    prep_revision, key = preparation_revision, request_key
    owned, prepared, result = False, None, None
    captured, pairs, bases, sources, results, pngs = {}, {}, {}, {}, [], []
    lease = str(uuid4())
    try:
        # A1 UPDATE for branch discovery; no preparation mutation for an
        # image branch and no waiting for the gate while authority is held.
        with service._authorized(context, constraints) as (connection, live, _):
            top = service._top(connection, live, ref, revision, constraints, write=True)
            snapshot, prepared = _load(service, connection, live, top, identity, kind, constraints, mode='advance')
            artwork_draft.require_revision(snapshot['header'], prep_revision, key)
            if not snapshot['included_count']:
                chosen = _claim(service, connection, live, identity, kind, prep_revision, key, lease)
                if chosen:
                    raise AlbumTopError('artwork_preparation_unavailable', 409)
                service._draft_refresh_header(connection, snapshot)
                response = _status(service, connection, snapshot, kind)
                service._draft_finish(connection, live, top, snapshot, {}, constraints)
                return response
            if not gate.acquire(blocking=False):
                raise AlbumTopError('artwork_busy', 409)
            owned = True
            service._draft_finish(connection, live, top, snapshot, {}, constraints)
            prepared = None
        observations = service._draft_probe(snapshot)
        observed_root_ids = _saved_root_ids(kind, observations)
        # A2 fresh complete fence, then lease creation and successful exit
        # before the synchronous image loop can read/sanitize anything.
        with service._authorized(context, constraints) as (connection, live, _):
            top = service._top(connection, live, ref, revision, constraints, write=True)
            if kind == 'saved':
                saved.require_observed_roots(live, observed_root_ids, constraints)
            current, prepared = _load(service, connection, live, top, identity, kind, constraints, mode='advance')
            artwork_draft.compare(snapshot, current)
            chosen = [str(value) for value in _claim(service, connection, live, identity, kind, prep_revision, key, lease)]
            service._draft_refresh_header(connection, current)
            if not chosen:
                response = _status(service, connection, current, kind)
                service._draft_finish(connection, live, top, current, observations, constraints)
                return response
            selected = [row for row in current['rows'] if row['row_ref'] in chosen]
            if (not 1 <= len(chosen) <= _BATCH or len(set(chosen)) != len(chosen)
                    or [row['row_ref'] for row in selected] != chosen
                    or any(not row['included'] or row['status'] not in ('pending', 'failed') for row in selected)):
                raise AlbumTopError('artwork_preparation_unavailable', 409)
            service._draft_lease(current, prep_revision, key, lease, chosen)
            for row in selected:
                observed, root = observations[row['row_ref']]
                source, base = _source_base(kind, live.library_id, observed, root, prepared)
                sources[row['row_ref']], bases[row['row_ref']] = source, base
            service._draft_finish(connection, live, top, current, observations, constraints, lease=lease)
            # Retain only the complete vector digest and exact post-claim
            # header, including ORIGINAL preparation and lease deadlines.
            claim_binding = {'digest': current['digest'], 'header': dict(current['header'])}
            prepared = None
        snapshot, current, observations = None, None, None
        captured = service._capture_rows(selected, sources, kind=kind)
        for row in selected:
            row_ref, result = row['row_ref'], captured[row['row_ref']]
            if result is not None:
                pairs[row_ref] = _captured_pair(kind, result, bases[row_ref])
            result = None
        # A3 fresh DB binding and codec context precede full P2. Capture
        # proofs bind to that CURRENT inventory but retain their old exact
        # descriptor; no new descriptor can be substituted for old pixels.
        with service._authorized(context, constraints) as (connection, live, _):
            top = service._top(connection, live, ref, revision, constraints)
            if kind == 'saved':
                saved.require_observed_roots(live, observed_root_ids, constraints)
            snapshot, prepared = _load(service, connection, live, top, identity, kind, constraints, mode='advance')
            if kind == 'saved':
                _saved_lease(service, snapshot, prep_revision, key, lease, chosen)
            artwork_draft.compare(claim_binding, snapshot)
            service._draft_lease(snapshot, prep_revision, key, lease, chosen)
            for row in snapshot['rows']:
                if row['row_ref'] in pairs:
                    source, acquisition, _ = pairs[row['row_ref']]
                    expected, _, _ = _ready_binding(kind, source, acquisition, prepared,
                        library_id=live.library_id, local_album_id=row['selected_local_album_id'],
                        stored_cover_path=row['cover_path'])
                    if source['stored_cover_path'] != row['cover_path']:
                        draft_proof.unavailable()
                    row['expected'] = expected
            service._draft_finish(connection, live, top, snapshot, {}, constraints, lease=lease)
            prepared = None
        observations = service._draft_probe(snapshot)
        observed_root_ids = _saved_root_ids(kind, observations)
        # A4 never calls a resolver/describe/capture. All observations came
        # from P2 outside authority and are accepted only against this fence.
        with service._authorized(context, constraints) as (connection, live, _):
            top = service._top(connection, live, ref, revision, constraints, write=True)
            if kind == 'saved':
                saved.require_observed_roots(live, observed_root_ids, constraints)
            current, prepared = _load(service, connection, live, top, identity, kind, constraints, mode='advance')
            if kind == 'saved':
                _saved_lease(service, current, prep_revision, key, lease, chosen)
            artwork_draft.compare(snapshot, current)
            service._draft_lease(current, prep_revision, key, lease, chosen)
            for row in selected:
                row_ref, result = row['row_ref'], captured[row['row_ref']]
                if result is None:
                    results.append({('row_ref' if kind == 'draft' else 'item_ref'): row_ref, 'status': 'failed', 'error_code': 'artwork_unavailable'})
                    pngs.append(None)
                else:
                    observed, root = observations[row_ref]
                    source, base = _source_base(kind, live.library_id, observed, root, prepared)
                    if source != result.source or base != bases[row_ref]:
                        draft_proof.unavailable()
                    source_stamp, acquisition_stamp, source_bytes = pairs[row_ref]
                    results.append({('row_ref' if kind == 'draft' else 'item_ref'): row_ref, 'status': 'ready', 'asset_ref': str(uuid4()),
                        'content_digest': result.content_digest, 'width': result.width, 'height': result.height,
                        'source_stamp': source_stamp, 'acquisition_stamp': acquisition_stamp,
                        **({'source_bytes': source_bytes} if kind == 'draft' else {})})
                    pngs.append(result.png)
                result = None
            # Fixed <=4 proof pairs are individually codec-bounded. This
            # incremental encoder rejects aggregate overflow before Jsonb
            # can allocate its serialized function argument.
            artwork_draft.result_json(results)
            if len(pngs) > _BATCH or sum(len(value) for value in pngs if value is not None) > _BATCH * MAX_OUTPUT_BYTES:
                raise AlbumTopError('artwork_limit', 409)
            _complete(connection, live, identity, kind, prep_revision, key, lease, results, pngs)
            # Completion clears the lease; preserve its original deadline
            # for the final after-response service fence too.
            original_lease_expiry = current['header']['lease_expires_at']
            service._draft_refresh_header(connection, current)
            current['header']['lease_expires_at'] = original_lease_expiry
            response = _status(service, connection, current, kind)
            service._draft_finish(connection, live, top, current, observations, constraints, lease=lease)
            return response
    except BaseException as error:
        # A failed proof/SQL collaborator's traceback can retain its input
        # capture object even after our dictionaries are cleared. Drop that
        # private traceback chain before releasing this request's image slot.
        error.__traceback__ = None
        error.__context__ = None
        error.__cause__ = None
        if isinstance(error, (proof_codec.InvalidArtworkProof, ArtworkAcquisitionUnavailable)):
            raise AlbumTopError('artwork_source_changed', 409) from None
        raise error.with_traceback(None)
    finally:
        prepared = None
        result = None
        pngs.clear()
        results.clear()
        captured.clear()
        pairs.clear()
        bases.clear()
        sources.clear()
        if owned:
            gate.release()


def finish_start(service, identity, initial_snapshot, *, constraints=None):
    """Continuation only after the saved admission transaction committed."""
    if initial_snapshot.get('kind') != 'saved' or initial_snapshot.get('mode') != 'start_ack':
        raise AlbumTopError('artwork_preparation_unavailable', 409)
    prepared = None
    try:
        observations = service._draft_probe(initial_snapshot)
        observed_root_ids = _saved_root_ids('saved', observations)
        with service._authorized(identity['context'], constraints) as (connection, live, _):
            top = service._top(connection, live, identity['top_ref'], identity['top_revision'], constraints)
            saved.require_observed_roots(live, observed_root_ids, constraints)
            current, prepared = _load(service, connection, live, top, identity, 'saved', constraints, mode='read')
            artwork_draft.compare(initial_snapshot, current)
            response = service._status(connection, current['header'])
            service._draft_finish(connection, live, top, current, observations, constraints)
            return response
    finally:
        prepared = None
