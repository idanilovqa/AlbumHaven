"""Dormant explicit Top-native MusicBrainz acquisition under existing authority.

Search previews and exact provider reads run outside database transactions. This
owner cannot add a member, retain a Top admission, create a catalog identity, read
Goals, publish, or grant authority through an acquisition UUID. No route registers
it. Deployment composition supplies the existing public MusicBrainz user agent.
"""
from contextlib import contextmanager
from datetime import timezone
from uuid import uuid4

from music_app.services.album_top_remote_sources import (
    evidence_from_row, normalize_remote_acquisition, normalize_remote_destination,
    normalize_pending_remote_selector, project_remote_summary, remote_context_ref,
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


def _binding(row, live, destination, owner_account_id, context_ref):
    expected = (live.library_id, live.actor.account_id, live.actor.session_id, context_ref,
        destination.kind, destination.ref, owner_account_id,
        int(destination.revision) if destination.revision is not None else None)
    actual = (row['library_id'], row['actor_account_id'], row['original_session_id'], row['context_ref'],
        row['destination_kind'], str(row['destination_ref']), row['destination_owner_account_id'],
        row['destination_revision'])
    return actual == expected


def load_pending_remote_source(connection, *, selector, live, destination, owner_account_id, context_ref):
    """Database-only source check for a later existing membership transaction.

    The caller must already hold current account/session/library and destination
    Top locks and have checked Browse/Items or Browse/Create. This returns facts,
    never consumes evidence, maps catalog identity or grants membership itself.
    Create callers must retain destination.ref as draft_ref in their normalized command.
    """
    selector = normalize_pending_remote_selector(selector)
    destination = normalize_remote_destination(destination.payload())
    context_ref = remote_context_ref(context_ref)
    row = connection.execute('''select *,clock_timestamp() as checked_at
        from app.album_top_remote_acquisitions where ref=%s and actor_account_id=%s''',
        (selector['acquisition_ref'], live.actor.account_id)).fetchone()
    if (row is None or not _binding(row, live, destination, owner_account_id, context_ref)
            or row['retired_at'] is not None or row['expires_at'] <= row['checked_at']
            or row['evidence_version'] != selector['evidence_version']):
        raise AlbumTopError('remote_evidence_unavailable', 409)
    return dict(row), evidence_from_row(row)


class TopRemoteAcquisitionService:
    """Explicit construction only. No existing app/membership owner invokes it."""
    def __init__(self, owner, *, provider=None, searcher=None, user_agent=None):
        self.owner = owner
        self.provider = provider or fetch_release_group_evidence
        self.searcher = searcher or search_release_group_candidates
        self.user_agent = user_agent

    def _destination(self, connection, live, destination, constraints, *, write=False):
        top = self.owner._top(connection, live, destination.ref, write=write) if destination.kind == 'top' else None
        self.owner._require(live, (BROWSE, ITEMS) if top else (BROWSE, CREATE), constraints, top)
        if top is not None and str(top['revision']) != destination.revision:
            raise AlbumTopError('revision_conflict', 409)
        return top

    @contextmanager
    def _authorized(self, context, destination, constraints, should_cancel, *, write=False):
        _cancel(should_cancel)
        try:
            with self.owner._authorized(context, constraints) as (connection, live, now):
                top = self._destination(connection, live, destination, constraints, write=write)
                _cancel(should_cancel)
                yield connection, live, top
                _cancel(should_cancel)
                # A cancellation observer may itself update current policy
                # constraints. Do not let that callback follow the last check.
                self.owner._require(live, (BROWSE, ITEMS) if top else (BROWSE, CREATE), constraints, top)
                # The actual owner's context exit checks the current live session
                # again after all work, rolling back writes on expiry/revocation.
        except AlbumTopError:
            raise
        except Exception as error:
            constraint = getattr(getattr(error, 'diag', None), 'constraint_name', '') or ''
            if getattr(error, 'sqlstate', None) == '55000':
                if constraint == 'top_remote_budget':
                    raise AlbumTopError('remote_acquisition_limit', 429) from None
                if constraint == 'top_remote_request_conflict':
                    raise AlbumTopError('request_key_conflict', 409) from None
                if constraint in {'top_remote_expired', 'top_remote_scope'}:
                    raise AlbumTopError('remote_evidence_unavailable', 409) from None
            raise

    @staticmethod
    def _owner(live, top):
        return top['owner_account_id'] if top else live.actor.account_id

    def _prior(self, connection, live, top, command, context_ref):
        row = connection.execute('''select *,clock_timestamp() as checked_at
            from app.album_top_remote_acquisitions where actor_account_id=%s and request_key=%s''',
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
                          constraints=None, should_cancel=None):
        destination = normalize_remote_destination(destination)
        context_ref = remote_context_ref(context_ref)
        try:
            title, artist = normalize_album_search(title, artist)
        except RemoteAlbumEvidenceError as error:
            raise AlbumTopError(error.code) from None
        with self._authorized(context, destination, constraints, should_cancel):
            pass
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
        with self._authorized(context, destination, constraints, should_cancel):
            if failure is not None:
                raise AlbumTopError(failure.code, 503) from None
            # Deliberately no acquisition selector or digest in candidate DTOs.
            return {'context_ref': context_ref, 'destination': destination.payload(), 'limit': SEARCH_LIMIT,
                    'candidates': [project_remote_summary(value) for value in candidates]}

    def acquire(self, context, *, payload, context_ref, constraints=None, should_cancel=None):
        command = normalize_remote_acquisition(payload)
        context_ref = remote_context_ref(context_ref)
        with self._authorized(context, command.destination, constraints, should_cancel) as (connection, live, top):
            prior = self._prior(connection, live, top, command, context_ref)
            if prior is not None:
                return self._receipt(connection, live, top, command, context_ref, prior, constraints, should_cancel)
            self._capacity(connection, live, command.destination)
        # No DB context remains open across the sole exact provider lookup.
        failure = None
        try:
            facts = validate_release_group_evidence(self.provider(command.release_group_id,
                user_agent=self.user_agent, should_cancel=should_cancel))
            if facts.release_group_id != command.release_group_id:
                raise RemoteAlbumEvidenceError('provider_identity_changed')
        except RemoteAlbumEvidenceError as error:
            failure = error
        with self._authorized(context, command.destination, constraints, should_cancel, write=True) as (connection, live, top):
            if failure is not None:
                # A cancellation or denial is terminal, even if a concurrent
                # identical request happened to commit while this lookup failed.
                raise AlbumTopError(failure.code, 503) from None
            prior = self._prior(connection, live, top, command, context_ref)
            if prior is None:
                connection.execute('''select app.store_top_remote_acquisition(
                    %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                    (str(uuid4()), live.library_id, live.actor.account_id, live.actor.session_id, context_ref,
                     command.destination.kind, command.destination.ref, self._owner(live, top),
                     int(command.destination.revision) if command.destination.revision is not None else None,
                     command.request_key, command.digest, facts.release_group_id, facts.digest,
                     facts.title, facts.artist_display, facts.first_release_date, facts.primary_type)).fetchone()
                prior = self._prior(connection, live, top, command, context_ref)
                if prior is None:
                    raise AlbumTopError('remote_evidence_unavailable', 409)
            return self._receipt(connection, live, top, command, context_ref, prior, constraints, should_cancel)
