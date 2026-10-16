"""Guard a listener identity for a future Search history consumer.

The preliminary username lookup is a hint, never authorization. It closes
before the existing ordered actor/subject transaction begins. The actual
mapping, current account/library authority and accepted friendship are held
through consumer work. No route is registered and no history is read here.
"""
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timezone

from music_app.services.admin_member_mutation_postgres import (
    lock_current_actor_session, RecentAuthenticationRequired,
)
from music_app.services.friends_postgres import authorized_friend_read, FriendScopeError
from music_app.services.policy import PolicyContext, ResourceScope
from music_app.services.postgres_connections import pooled_connection
from music_app.services.private_library_authority import (
    current_library_transaction, require_private_action, PrivateLibraryAuthorityError,
)
from music_app.services.private_search_contract import ListenerHistoryCriteria, PrivateSearchError

BROWSE = 'library.browse.read'
HISTORY = 'library.social.history.read'


@dataclass(frozen=True)
class ListenerSearchSubject:
    """Internal server-derived identity; only listener_payload is a UI DTO."""
    account_id: int
    account_ref: str
    username: str
    display_name: str
    history_action: str
    relationship_revision: int | None

    def listener_payload(self):
        return {'account_ref': self.account_ref, 'username': self.username,
                'display_name': self.display_name}


def _denied():
    return PrivateSearchError('private_search_forbidden', 403)


class PostgresListenerSearchSubjects:
    def __init__(self, config, *, connect=None, clock=None):
        self._url = str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        self._connect = connect or pooled_connection
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def _lookup_hint(self, username, library_id):
        # Only a positive account identity crosses this closed lookup. Neither
        # profile metadata nor history is returned from the unguarded hint.
        with self._connect(self._url) as connection:
            row = connection.execute('''select a.id as account_id from app.accounts a
                join library.library_memberships m on m.account_id=a.id and m.library_id=%s
                where a.username_normalized=%s and a.is_active and a.disabled_at is null''',
                (library_id, username)).fetchone()
        if row is None or type(row['account_id']) is not int or row['account_id'] < 1:
            raise _denied()
        return row['account_id']

    @staticmethod
    def _current_profile(connection, *, account_id, username, library_id):
        row = connection.execute('''select a.id as account_id,a.username_display,a.display_name,
                p.account_ref::text from app.accounts a
            join library.library_memberships m on m.account_id=a.id and m.library_id=%s
            join app.social_profiles p on p.account_id=a.id
            where a.id=%s and a.username_normalized=%s and a.is_active and a.disabled_at is null
            for share of a,m,p''', (library_id, account_id, username)).fetchone()
        if row is None or row['account_id'] != account_id:
            raise _denied()
        return row

    @contextmanager
    def authorized(self, context, *, criteria, constraints=None):
        if type(criteria) is not ListenerHistoryCriteria or not isinstance(context, PolicyContext):
            raise PrivateSearchError()
        actor = context.actor
        if (context.target_account_id is not None or not actor.is_authenticated
                or any(type(value) is not int or value < 1 for value in
                    (actor.account_id, actor.session_id, actor.current_library_id, context.library_id))
                or actor.current_library_id != context.library_id):
            raise _denied()
        if not self._url:
            raise PrivateSearchError('private_search_unavailable', 503)
        try:
            require_private_action(context, BROWSE, constraints=constraints)
            target = self._lookup_hint(criteria.username, context.library_id)
            # The hint connection has ended. The one shared transaction owner
            # now locks the actor and target in its existing canonical order.
            with current_library_transaction(self._url, context, constraints=constraints,
                    connect=self._connect, clock=self._clock, target_account_id=target,
                    read_only=True) as (connection, live, _):
                profile = self._current_profile(connection, account_id=target,
                    username=criteria.username, library_id=live.library_id)
                own = target == live.actor.account_id
                scoped = replace(live, target_account_id=None if own else target)
                action = BROWSE if own else HISTORY

                @contextmanager
                def subject_guard():
                    if own:
                        yield None
                    else:
                        with authorized_friend_read(connection, account_id=live.actor.account_id,
                                library_id=live.library_id, target_account_id=target) as friend:
                            yield friend['relationship_revision']

                with subject_guard() as revision:
                    require_private_action(scoped, action,
                        resource=ResourceScope('account', str(target)), constraints=constraints)
                    subject = ListenerSearchSubject(target, profile['account_ref'],
                        profile['username_display'], profile['display_name'], action, revision)
                    # The reader must independently require subject.history_action
                    # for each event and each resolved track/album/artist.
                    yield connection, scoped, subject
                    self._current_profile(connection, account_id=target,
                        username=criteria.username, library_id=live.library_id)
                    lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                        actor_session_id=live.actor.session_id, clock=self._clock)
                    require_private_action(scoped, action,
                        resource=ResourceScope('account', str(target)), constraints=constraints)
        except (PrivateLibraryAuthorityError, FriendScopeError, RecentAuthenticationRequired):
            raise _denied() from None
