"""Explicit Top-native MusicBrainz acquisition under existing authority.

Search previews and exact provider reads run outside database transactions. This
owner cannot add a member, retain a Top admission, create a catalog identity, read
Goals, publish, or grant authority through an acquisition UUID. The private Top
transport supplies the existing public MusicBrainz user agent.
"""
from contextlib import contextmanager
from datetime import timedelta, timezone
from time import monotonic

from music_app.services.album_top_remote_sources import (
    evidence_from_row, normalize_remote_acquisition, normalize_remote_destination,
    normalize_pending_remote_selector, project_remote_summary, remote_context_ref,
    PreparedRemoteTopAcquisitionCommand,
)
from music_app.services.owned_album_tops import AlbumTopError, BROWSE, CREATE, ITEMS
from music_app.services.remote_album_evidence import RemoteAlbumEvidenceError, validate_release_group_evidence
from music_app.services.remote_album_provider import fetch_release_group_evidence
from music_app.services.remote_album_search import (
    SEARCH_LIMIT, normalize_album_search, search_release_group_candidates,
)

_MAX_ACTOR_ROWS = 10000
_MAX_ACTOR_BYTES = 32 * 1024 * 1024
_MAX_ACTOR_LIVE = 1000
_MAX_DESTINATION_ROWS = 2000
_MAX_DESTINATION_BYTES = 8 * 1024 * 1024
_MAX_DESTINATION_LIVE = 100


def _cancel(should_cancel):
    if should_cancel is not None:
        if not callable(should_cancel):
            raise AlbumTopError('invalid_command')
        if should_cancel():
            raise AlbumTopError('provider_cancelled', 503)


def remote_storage_error(error):
    if getattr(error, 'sqlstate', None) != '55000':
        return None
    constraint = getattr(getattr(error, 'diag', None), 'constraint_name', '') or ''
    codes = {
        'top_remote_revision': ('revision_conflict', 409),
        'top_remote_version_required': ('remote_acquisition_version_required', 409),
        'top_remote_preparation_unavailable': ('remote_preparation_unavailable', 409),
        'top_remote_v2_membership_unavailable': ('remote_membership_unavailable', 409),
        'top_remote_budget': ('remote_acquisition_limit', 429),
        'top_remote_request_conflict': ('request_key_conflict', 409),
        'top_remote_expired': ('remote_evidence_unavailable', 409),
        'top_remote_scope': ('remote_evidence_unavailable', 409),
    }
    return AlbumTopError(*codes[constraint]) if constraint in codes else None


def _binding(row, live, destination, owner_account_id, context_ref):
    expected = (live.library_id, live.actor.account_id, live.actor.session_id, context_ref,
        destination.kind, destination.ref, owner_account_id,
        int(destination.revision) if destination.revision is not None else None)
    actual = (row['library_id'], row['actor_account_id'], row['original_session_id'], row['context_ref'],
        row['destination_kind'], str(row['destination_ref']), row['destination_owner_account_id'],
        row['destination_revision'])
    return actual == expected


def load_pending_remote_source(connection, *, selector, live, destination, owner_account_id, context_ref,
                               prelocked_source=None):
    """Database-only source check for a later existing membership transaction.

    The caller must already hold current account/session/library and destination
    Top locks and have checked Browse/Items or Browse/Create. For v2 it must also
    hold the complete batch's budget/parent/attempt/fact UPDATE locks through the
    structural batch owner, and pass that owner's exact descriptor. No lock is
    acquired here: a per-item late parent lookup must not invert the batch order.
    This returns facts,
    never consumes evidence, maps catalog identity or grants membership itself.
    Create callers must retain destination.ref as draft_ref in their normalized command.
    """
    selector = normalize_pending_remote_selector(selector)
    destination = normalize_remote_destination(destination.payload())
    context_ref = remote_context_ref(context_ref)
    row = connection.execute('''select *,clock_timestamp() as checked_at
        from app.album_top_remote_acquisitions where ref=%s and actor_account_id=%s''',
        (selector['acquisition_ref'], live.actor.account_id)).fetchone()
    if row is not None and row.get('preparation_ref') is not None:
        expected = {'acquisition_ref': str(row['ref']), 'evidence_version': row['evidence_version'],
                    'preparation_ref': str(row['preparation_ref']), 'attempt_ref': str(row['attempt_ref']),
                    'request_key': str(row['request_key'])}
        if type(prelocked_source) is not dict or prelocked_source != expected:
            raise AlbumTopError('remote_membership_unavailable', 409)
        parent = connection.execute('''select * from app.album_top_remote_preparations
            where ref=%s and actor_account_id=%s''',
            (row['preparation_ref'], live.actor.account_id)).fetchone()
        attempt = connection.execute('''select * from app.album_top_remote_attempts
            where ref=%s and preparation_ref=%s and actor_account_id=%s''',
            (row['attempt_ref'], row['preparation_ref'], live.actor.account_id)).fetchone()
        checked = connection.execute('select clock_timestamp() as checked_at').fetchone()['checked_at']
        if (parent is None or attempt is None or not _binding(parent, live, destination, owner_account_id, context_ref)
                or parent['closed_at'] is not None or parent['fully_expires_at'] <= checked
                or attempt['state'] != 'pending' or attempt['acquisition_ref'] != row['ref']
                or attempt['request_key'] != row['request_key'] or attempt['command_digest'] != row['command_digest']
                or attempt['external_id'] != row['external_id'] or attempt['evidence_version'] != row['evidence_version']
                or not parent['created_at'] <= attempt['created_at'] <= row['created_at'] < parent['accepts_until']
                or row['created_at'] >= attempt['lease_until']
                or row['expires_at'] - row['created_at'] != timedelta(minutes=30)
                or row['expires_at'] > parent['fully_expires_at']):
            raise AlbumTopError('remote_evidence_unavailable', 409)
        row = dict(row, checked_at=checked)
    if (row is None or not _binding(row, live, destination, owner_account_id, context_ref)
            or row['retired_at'] is not None or row['expires_at'] <= row['checked_at']
            or row['evidence_version'] != selector['evidence_version']):
        raise AlbumTopError('remote_evidence_unavailable', 409)
    return dict(row), evidence_from_row(row)


class TopRemoteAcquisitionService:
    """Private preparation only; the membership owner never fetches provider facts."""
    def __init__(self, owner, *, provider=None, searcher=None, user_agent=None, monotonic_clock=None):
        self.owner = owner
        self.provider = provider or fetch_release_group_evidence
        self.searcher = searcher or search_release_group_candidates
        self.user_agent = user_agent
        self.monotonic_clock = monotonic if monotonic_clock is None else monotonic_clock

    def _destination(self, connection, live, destination, constraints, *, write=False, check_revision=True):
        top = self.owner._top(connection, live, destination.ref, write=write) if destination.kind == 'top' else None
        self.owner._require(live, (BROWSE, ITEMS) if top else (BROWSE, CREATE), constraints, top)
        if check_revision and top is not None and str(top['revision']) != destination.revision:
            raise AlbumTopError('revision_conflict', 409)
        return top

    def _discover_owner(self, context, destination, constraints, should_cancel):
        _cancel(should_cancel)
        if destination.kind == 'create':
            return None
        self.owner._require(context, (BROWSE,), constraints)
        # Exact, unlocked discovery supplies only a lock-order hint. The same
        # owner is pinned across provider I/O and checked against the locked Top.
        with self.owner._connect(self.owner._url) as lookup:
            row = lookup.execute('''select owner_account_id from app.album_lists
                where ref=%s and library_id=%s''', (destination.ref, context.library_id)).fetchone()
        _cancel(should_cancel)
        if row is None:
            raise AlbumTopError('top_unavailable', 404)
        return row['owner_account_id']

    @contextmanager
    def _authorized(self, context, destination, constraints, should_cancel, *, write=False,
                    discovered_owner=None, budget_lock=False, check_revision=True,
                    artist_search_witness=None, acquired_artist_preview=None):
        _cancel(should_cancel)
        if destination.kind == 'top' and discovered_owner is None:
            # Preserve the direct database-only helper seam. Public search and
            # acquire callers pass their single pre-provider discovery instead.
            discovered_owner = self._discover_owner(context, destination, constraints, should_cancel)
        try:
            with self.owner._authorized(context, constraints,
                    target_account_id=discovered_owner) as (connection, live, now):
                if budget_lock:
                    connection.execute('select app.lock_top_remote_pending_actor(%s)',
                                       (live.actor.account_id,)).fetchone()
                top = self._destination(connection, live, destination, constraints,
                                        write=write, check_revision=check_revision)
                if top is not None and top['owner_account_id'] != discovered_owner:
                    raise AlbumTopError('concurrent_change', 409)
                _cancel(should_cancel)
                yield connection, live, top
                _cancel(should_cancel)
                # A cancellation observer may itself update current policy
                # constraints. Do not let that callback follow the last check.
                self.owner._require(live, (BROWSE, ITEMS) if top else (BROWSE, CREATE), constraints, top)
                if artist_search_witness is not None:
                    from music_app.services.album_top_remote_artist_scope import finish_search
                    finish_search(connection, live, artist_search_witness, constraints)
                if acquired_artist_preview is not None:
                    acquired_artist_preview.finish(connection, live, top, self.owner, constraints, should_cancel)
                # The actual owner's context exit checks the current live session
                # again after all work, rolling back writes on expiry/revocation.
        except AlbumTopError:
            raise
        except Exception as error:
            translated = remote_storage_error(error)
            if translated is not None:
                raise translated from None
            raise

    @staticmethod
    def _owner(live, top):
        return top['owner_account_id'] if top else live.actor.account_id

    @contextmanager
    def _authorized_prepared_attempt(self, context, command, context_ref, constraints, should_cancel, *,
                                     discovered_owner, acquired_artist_preview=None):
        """Fixed reserve/replay owner; no caller deadline or arbitrary callback.

        Normal search/v1/direct _authorized semantics stay unchanged. This
        owner obtains the actual reserve snapshot under the same lock prefix,
        then fences consumed replies and the fixed private Artist display record
        after its final cancellation/policy calls.
        """
        from music_app.services.album_top_remote_preparations import _sql, _timestamp, _require_snapshot
        if not isinstance(command, PreparedRemoteTopAcquisitionCommand):
            raise AlbumTopError('invalid_command')
        context_ref = remote_context_ref(context_ref)
        destination = command.destination
        _require_snapshot(destination.kind != 'top' or type(discovered_owner) is int and discovered_owner > 0)
        _cancel(should_cancel)
        try:
            with self.owner._authorized(context, constraints,
                    target_account_id=discovered_owner) as (connection, live, _):
                connection.execute('select app.lock_top_remote_pending_actor(%s)',
                                   (live.actor.account_id,)).fetchone()
                top = self._destination(connection, live, destination, constraints,
                                        write=True, check_revision=False)
                if top is not None and top['owner_account_id'] != discovered_owner:
                    raise AlbumTopError('concurrent_change', 409)
                _cancel(should_cancel)
                args = (command.preparation_ref, live.library_id, live.actor.account_id, live.actor.session_id,
                    context_ref, destination.kind, destination.ref, self._owner(live, top),
                    int(destination.revision) if destination.revision is not None else None,
                    command.request_key, command.digest, command.release_group_id)
                snapshot = _sql(connection, 'reserve_top_remote_attempt', args)
                consumed = snapshot.get('state') == 'consumed'
                original_deadline = _timestamp(snapshot.get('fully_expires_at')) if consumed else None
                observed_at = _timestamp(snapshot.get('sql_now')) if consumed else None
                yield connection, live, top, args, snapshot
                _cancel(should_cancel)
                self.owner._require(live, (BROWSE, ITEMS) if top else (BROWSE, CREATE), constraints, top)
                if acquired_artist_preview is not None:
                    acquired_artist_preview.finish(connection, live, top, self.owner, constraints, should_cancel)
                if consumed:
                    final = connection.execute('select clock_timestamp()::text as checked_at').fetchone()
                    _require_snapshot(final is not None)
                    checked = _timestamp(final.get('checked_at'))
                    _require_snapshot(checked >= observed_at)
                    if checked >= original_deadline:
                        raise AlbumTopError('remote_preparation_unavailable', 409)
                # Only the already-held same-session exit/commit remains. A
                # reserved dispatch is usable only after that commit succeeds.
        except AlbumTopError:
            raise
        except Exception as error:
            translated = remote_storage_error(error)
            if translated is not None:
                raise translated from None
            raise

    def _prior(self, connection, live, top, command, context_ref):
        row = connection.execute('''select *,clock_timestamp() as checked_at
            from app.album_top_remote_acquisitions where actor_account_id=%s and request_key=%s and preparation_ref is null''',
            (live.actor.account_id, command.request_key)).fetchone()
        if row is None:
            return None
        if row['original_session_id'] != live.actor.session_id:
            raise AlbumTopError('remote_evidence_unavailable', 409)
        if (not _binding(row, live, command.destination, self._owner(live, top), context_ref)
                or row['command_digest'] != command.digest or row['external_id'] != command.release_group_id):
            raise AlbumTopError('request_key_conflict', 409)
        if row['retired_at'] is not None or row['expires_at'] <= row['checked_at']:
            raise AlbumTopError('remote_evidence_unavailable', 409)
        evidence_from_row(row)
        return dict(row)

    @staticmethod
    def _capacity(connection, live, destination):
        # The actual current-library transaction already holds the initiating
        # account UPDATE lock. Expired/retired rows still consume retained quota.
        row = connection.execute('''select count(*) as retained,coalesce(sum(facts_bytes),0) as bytes,
            count(*) filter(where retired_at is null and expires_at>clock_timestamp()) as live
            from app.album_top_remote_acquisitions where actor_account_id=%s''',
            (live.actor.account_id,)).fetchone()
        bucket = connection.execute('''select count(*) as retained,coalesce(sum(facts_bytes),0) as bytes,
            count(*) filter(where retired_at is null and expires_at>clock_timestamp()) as live
            from app.album_top_remote_acquisitions where actor_account_id=%s and library_id=%s
              and destination_kind=%s and destination_ref=%s''',
            (live.actor.account_id, live.library_id, destination.kind, destination.ref)).fetchone()
        if (row['retained'] >= _MAX_ACTOR_ROWS or row['bytes'] >= _MAX_ACTOR_BYTES
                or row['live'] >= _MAX_ACTOR_LIVE or bucket['retained'] >= _MAX_DESTINATION_ROWS
                or bucket['bytes'] >= _MAX_DESTINATION_BYTES or bucket['live'] >= _MAX_DESTINATION_LIVE):
            raise AlbumTopError('remote_acquisition_limit', 429)

    def _receipt(self, connection, live, top, command, context_ref, row, constraints, should_cancel):
        # Current policy/cancellation precede the final SQL-clock expiry check.
        _cancel(should_cancel)
        self.owner._require(live, (BROWSE, ITEMS) if top else (BROWSE, CREATE), constraints, top)
        checked, facts = load_pending_remote_source(connection,
            selector={'kind': 'remote_acquisition', 'acquisition_ref': str(row['ref']),
                      'evidence_version': row['evidence_version']}, live=live,
            destination=command.destination, owner_account_id=self._owner(live, top), context_ref=context_ref)
        return {'context_ref': context_ref, 'request_key': command.request_key,
            'destination': command.destination.payload(), 'acquisition_ref': str(checked['ref']),
            'evidence_version': checked['evidence_version'],
            'expires_at': checked['expires_at'].astimezone(timezone.utc).isoformat(),
            'album': project_remote_summary(facts)}

    def search_candidates(self, context, *, destination, title, artist='', context_ref,
                          constraints=None, should_cancel=None, artist_scope=None):
        from music_app.services.album_top_artist_scope import (
            artist_scope as saved_artist_scope, normalize_artist_scope,
        )
        from music_app.services import album_top_remote_artist_scope as scoped_search
        destination = normalize_remote_destination(destination)
        if artist_scope is not None:
            if destination.kind != 'create':
                raise AlbumTopError('invalid_command')
            artist_scope = normalize_artist_scope(artist_scope)
        context_ref = remote_context_ref(context_ref)
        try:
            title, artist = normalize_album_search(title, artist)
        except RemoteAlbumEvidenceError as error:
            raise AlbumTopError(error.code) from None
        discovered_owner = self._discover_owner(context, destination, constraints, should_cancel)
        with self._authorized(context, destination, constraints, should_cancel,
                discovered_owner=discovered_owner) as (connection, live, top):
            scope = saved_artist_scope(top) if top is not None else artist_scope
            witness = scoped_search.capture_search(connection, live, scope, constraints)
        failure = None
        try:
            candidates = self.searcher(title, artist, user_agent=self.user_agent, should_cancel=should_cancel)
            if type(candidates) is not tuple or len(candidates) > SEARCH_LIMIT:
                raise RemoteAlbumEvidenceError('invalid_provider_metadata')
            candidates = tuple(validate_release_group_evidence(value) for value in candidates)
            if len({value.release_group_id for value in candidates}) != len(candidates):
                raise RemoteAlbumEvidenceError('invalid_provider_metadata')
        except RemoteAlbumEvidenceError as error:
            failure = error
        with self._authorized(context, destination, constraints, should_cancel,
                discovered_owner=discovered_owner,
                artist_search_witness=witness) as (connection, live, top):
            current_scope = saved_artist_scope(top) if top is not None else artist_scope
            try:
                current = scoped_search.capture_search(connection, live, current_scope, constraints)
            except AlbumTopError:
                if witness is not None:
                    raise AlbumTopError('artist_scope_changed', 409) from None
                raise
            if current != witness:
                raise AlbumTopError('artist_scope_changed', 409)
            if failure is not None:
                raise AlbumTopError(failure.code, 503) from None
            if witness is not None:
                candidates = tuple(value for value in candidates
                    if scoped_search.matches_credits(witness.identities, value))
            # Deliberately no acquisition selector or digest in candidate DTOs.
            return {'context_ref': context_ref, 'destination': destination.payload(), 'limit': SEARCH_LIMIT,
                    'candidates': [project_remote_summary(value) for value in candidates]}

    def acquire(self, context, *, payload, context_ref, constraints=None, should_cancel=None, artist_scope=None):
        command = normalize_remote_acquisition(payload)
        context_ref = remote_context_ref(context_ref)
        if isinstance(command, PreparedRemoteTopAcquisitionCommand):
            from music_app.services.album_top_remote_preparations import RemoteTopPreparationService
            return RemoteTopPreparationService(self).acquire(context, command=command,
                context_ref=context_ref, constraints=constraints, should_cancel=should_cancel, artist_scope=artist_scope)
        if artist_scope is not None:
            raise AlbumTopError('invalid_command')
        discovered_owner = self._discover_owner(context, command.destination, constraints, should_cancel)
        with self._authorized(context, command.destination, constraints, should_cancel,
                discovered_owner=discovered_owner) as (connection, live, top):
            prior = self._prior(connection, live, top, command, context_ref)
            if prior is not None:
                return self._receipt(connection, live, top, command, context_ref, prior, constraints, should_cancel)
            # The SQL writer independently enforces the same permanent cutoff.
            # A reclaimed legacy key must never become a fresh provider lookup.
            raise AlbumTopError('remote_acquisition_version_required', 409)

    def begin_preparation(self, context, **options):
        from music_app.services.album_top_remote_preparations import RemoteTopPreparationService
        return RemoteTopPreparationService(self).begin(context, **options)

    def preparation_status(self, context, **options):
        from music_app.services.album_top_remote_preparations import RemoteTopPreparationService
        return RemoteTopPreparationService(self).status(context, **options)

    def close_preparation(self, context, **options):
        from music_app.services.album_top_remote_preparations import RemoteTopPreparationService
        return RemoteTopPreparationService(self).close(context, **options)

    def maintain_preparations(self, context, **options):
        from music_app.services.album_top_remote_preparations import RemoteTopPreparationService
        return RemoteTopPreparationService(self).maintain(context, **options)
