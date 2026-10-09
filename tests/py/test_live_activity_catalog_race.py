"""Proposed deterministic real-Postgres regression; not yet executed."""
from contextlib import contextmanager
from tests.py.test_live_activity_postgres import presence, update
from tests.py.test_activity_native_targets_postgres import native_activity
from tests.py.test_friend_home_activity import social_ledger
from tests.py.test_home_activity_postgres_integration import database_urls, mutable_ledger


def test_catalog_invalidation_after_presence_read_cannot_return_retired_observation(presence):
    state, ctx, service, _, _, _ = presence
    update(presence)
    fired = []

    class Intercept:
        def __init__(self, connection):
            self.connection = connection

        def execute(self, sql, *args, **kwargs):
            if not fired and 'select album_id,artist_id from library.local_tracks' in str(sql):
                fired.append(True)
                # Presence has been observed as playing; the catalog row has
                # not yet been locked. This mutation commits on another connection.
                with state['db'].connect() as writer:
                    writer.execute("set local lock_timeout='2s'")
                    writer.execute('''update library.local_tracks
                        set track_key=track_key || ':presence-review-retagged'
                        where id=%s''', (state['data']['tracks'][0]['id'],))
                    status = writer.execute('''select state from app.current_playback_presence
                        where account_id=%s and library_id=%s''',
                        (ctx.actor.account_id, ctx.library_id)).fetchone()['state']
                    assert status == 'invalidated'
            return self.connection.execute(sql, *args, **kwargs)

        def __getattr__(self, name):
            return getattr(self.connection, name)

    @contextmanager
    def connect(_url):
        with state['db'].connect() as connection:
            yield Intercept(connection)

    service.connect = connect
    assert service.read(ctx) is None
    assert fired
