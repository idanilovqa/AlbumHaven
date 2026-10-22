"""Optional response-local Artist display evidence in the acquisition owner."""
from music_app.services.album_top_artist_scope import artist_scope
from music_app.services.album_top_remote_artist_scope import _identities, known_artist_ids, matches_credits
from music_app.services.artist_family_postgres import ArtistFamilyIdentityUnavailable, load_artist_family_identity_scope
from music_app.services.album_top_remote_sources import evidence_from_row
from music_app.services.owned_album_tops import AlbumTopError, BROWSE, CREATE, ITEMS
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import require_private_action


class _PreviewUnavailable(Exception):
    pass


class AcquiredArtistPreview:
    """Fixed private staging record. Never accepted from a transport payload."""
    def __init__(self, scope):
        self.scope = scope
        self.pending = None
        self.fresh_deadlines = None

    def stage(self, top, value, reply):
        scope = artist_scope(top) if top is not None else self.scope
        if scope is None or reply.get('state') != 'pending':
            return
        # _public_attempt has already checked the entire acquired row binding.
        facts = evidence_from_row(value['facts'])
        self.pending = (dict(scope), value, reply, facts)
        reply['artist_scope_preview'] = None

    def finish(self, connection, live, top, owner, constraints, should_cancel):
        if self.pending is None:
            return
        from music_app.services.album_top_remote_acquisition import _cancel
        from music_app.services.album_top_remote_preparations import _timestamp, _require_snapshot
        scope, value, reply, facts = self.pending
        evaluated = {}
        mandatory_checked = False
        proposed = None

        def readable(identity):
            require_private_action(live, BROWSE,
                resource=ResourceScope('artist', str(identity)), constraints=constraints)
            evaluated[identity] = True
            return True

        def fixed_readable(identity):
            if identity not in evaluated:
                raise _PreviewUnavailable()
            return evaluated[identity]

        def members(callback):
            result = load_artist_family_identity_scope(connection, library_id=live.library_id,
                root_artist_id=int(scope['root_artist_id']), scope_mode=scope['mode'],
                is_artist_readable=callback)
            if result is None or not 0 < len(result) <= 5000:
                raise _PreviewUnavailable()
            return result

        def identities(basis, *, lock=False):
            try:
                return _identities(connection, live, basis, lock=lock)
            except AlbumTopError as error:
                # This helper does only a bounded exact SQL identity read. Its
                # missing/changed row signals do not include authorization.
                if error.code in {'artist_scope_unavailable', 'artist_scope_changed'} and error.status_code == 409:
                    raise _PreviewUnavailable() from None
                raise
            except Exception as error:
                if lock and getattr(error, 'sqlstate', None) == '55P03':
                    raise _PreviewUnavailable() from None
                raise

        def mandatory():
            nonlocal mandatory_checked
            _cancel(should_cancel)
            owner._require(live, (BROWSE, ITEMS) if top else (BROWSE, CREATE), constraints, top)
            for identity in tuple(evaluated):
                readable(identity)
            mandatory_checked = True

        try:
            # Completion/reservation writes precede this savepoint. Releasing
            # success keeps locks; optional rollback releases only inner locks.
            with connection.transaction():
                basis = members(readable)
                captured = identities(basis)
                locked = identities(basis, lock=True)
                mandatory()
                # No policy/cancellation callback after this exact comparison.
                final_basis = members(fixed_readable)
                final_identities = identities(basis)
                if basis != final_basis or captured != locked or captured != final_identities:
                    raise _PreviewUnavailable()
                if matches_credits(captured, facts):
                    roles = dict(basis)
                    primary = tuple(row for row in captured
                        if roles[row[0]] == 'primary_credit')
                    known = known_artist_ids(primary)
                    main = True if matches_credits(primary, facts) else None if None in known else False
                    proposed = {'artist_scope': dict(scope), 'evidence_version': facts.digest,
                                'main_artist_match': main}
        except (_PreviewUnavailable, ArtistFamilyIdentityUnavailable):
            proposed = None
        if not mandatory_checked:
            mandatory()
        final = connection.execute('select clock_timestamp()::text as checked_at').fetchone()
        _require_snapshot(final is not None)
        checked = _timestamp(final.get('checked_at'))
        _require_snapshot(checked >= _timestamp(value.get('sql_now')))
        deadlines = [_timestamp(value['facts'].get('expires_at')),
                     _timestamp(value.get('fully_expires_at'))]
        if self.fresh_deadlines is not None:
            lease, accepts = self.fresh_deadlines
            _require_snapshot(_timestamp(value.get('lease_until')) == lease
                and _timestamp(value.get('accepts_until')) == accepts)
            deadlines.extend((lease, accepts))
        if checked >= min(deadlines):
            raise AlbumTopError('remote_preparation_unavailable', 409)
        reply['artist_scope_preview'] = proposed
