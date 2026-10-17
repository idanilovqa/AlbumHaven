"""Listener Search adapter over the existing authorized Home track receipt.

HTTP admission is deliberately separate. Initial all-time capture inherits
Home's full-history work and coverage; only subsequent pages have a 100-row
page bound. Custom resource constraints retain Home's full receipt recheck.
"""
from dataclasses import replace
from datetime import datetime, timezone
import re

from music_app.services.allowed_actions import AllowedActions
from music_app.services.home_activity import ActivityQuery, HomeActivityError, PAGE_SIZE, read_home_activity
from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
from music_app.services.policy import PolicyContext, ResourceScope
from music_app.services.private_library_authority import require_private_action, PrivateLibraryAuthorityError
from music_app.services.private_listener_search_cursor import encode_listener_cursor, decode_listener_cursor
from music_app.services.private_search_contract import PrivateSearchError, normalize_listener_history_query
from music_app.services.private_search_subject import (
    BROWSE, HISTORY, ListenerHistoryExpectation, PostgresListenerSearchSubjects,
)
from music_app.services.social_cursors import _cipher

CONTRACT_VERSION = 'listener-history-v1'
_CONTEXT = re.compile(r'[a-f0-9]{64}', re.ASCII)


def _restart():
    return PrivateSearchError('search_cursor_restart_required', 409)


class PostgresListenerSearch:
    def __init__(self, config, *, connect=None, clock=None):
        self.config, self.connect = config, connect
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.subjects = PostgresListenerSearchSubjects(config, connect=connect, clock=clock)

    def read(self, context, *, query, context_ref, cursor_secret, cursor=None, constraints=None):
        """Only the normalized handle selects a subject; no client ID override."""
        criteria = normalize_listener_history_query(query)
        if (not isinstance(context, PolicyContext) or not isinstance(context_ref, str)
                or not _CONTEXT.fullmatch(context_ref)):
            raise PrivateSearchError()
        # Check configuration before materializing a receipt, even for page 1.
        try:
            _cipher(cursor_secret)
        except (RuntimeError, UnicodeError):
            raise PrivateSearchError('private_search_unavailable', 503) from None
        try:
            continuation = decode_listener_cursor(cursor, secret=cursor_secret)
        except ValueError:
            raise PrivateSearchError() from None
        actor = context.actor
        request_scope = {
            'actor_account_id': actor.account_id, 'actor_session_id': actor.session_id,
            'library_id': context.library_id, 'context_ref': context_ref, 'username': criteria.username,
        }
        if continuation and any(continuation['scope'][key] != value
                for key, value in request_scope.items()):
            raise _restart()
        # This connection closes before Home acquires any capture/session lock.
        # Its identity is a hint, revalidated inside the Home subject guard.
        target = self.subjects.lookup_hint(context, criteria=criteria, constraints=constraints)
        own = target == actor.account_id
        audience, action = ('own', BROWSE) if own else ('friend', HISTORY)
        if continuation and continuation['scope']['audience'] != audience:
            raise _restart()
        scoped = replace(context, target_account_id=None if own else target)

        def allowed(kind, reference):
            try:
                require_private_action(scoped, action,
                    resource=ResourceScope(kind, str(reference)), constraints=constraints)
            except PrivateLibraryAuthorityError:
                return AllowedActions(())
            return AllowedActions((action,))

        allowed.scope_wide = not callable(constraints)
        expected = continuation['scope'] if continuation else None
        listener = ListenerHistoryExpectation(criteria.username,
            expected['account_ref'] if expected else None,
            expected['relationship_revision'] if expected else None)
        activity_query = ActivityQuery(kind='tracks', period='all',
            snapshot_ref=continuation['snapshot_ref'] if continuation else None,
            page=continuation['page'] if continuation else None)
        try:
            result = read_home_activity(self.config, actor=actor, query=activity_query,
                subject_account_id=None if own else target, allowed_actions_for_resource=allowed,
                now=self.clock(), listener=listener,
                repository=HomeActivityPostgresRepository(self.config, connect=self.connect))
        except HomeActivityError as error:
            if error.status_code in {401, 403}:
                raise PrivateSearchError('private_search_forbidden', 403) from None
            if error.status_code == 410:
                raise _restart() from None
            if error.status_code == 503:
                raise PrivateSearchError('private_search_unavailable', 503) from None
            raise PrivateSearchError() from None
        data, current_listener = result['data'], result['listener']
        page = data['pagination']['page']
        total = data['pagination']['total_rows']
        has_more = page * PAGE_SIZE < total
        scope = {**request_scope, 'account_ref': current_listener['account_ref'], 'audience': audience,
                 'relationship_revision': result['listener_relationship_revision']}
        next_cursor = encode_listener_cursor(data['snapshot_ref'], page + 1,
            secret=cursor_secret, scope=scope) if has_more else None
        # Origin is a receipt coordinate, never media, taste or write authority.
        # Native consumers must independently reauthorize through their owner.
        origin = {'audience': audience, 'subject_ref': None if own else current_listener['account_ref'],
                  'kind': 'tracks', 'period': 'all', 'snapshot_ref': data['snapshot_ref']}
        return {
            'status': result['status'], 'private_search': True, 'contract_version': CONTRACT_VERSION,
            'context_ref': context_ref, 'query': query.strip(), 'criteria': criteria.as_payload(),
            'presentation': 'tracks', 'listener': current_listener, 'tracks': data['rows'],
            'page': {'limit': PAGE_SIZE, 'number': page, 'returned_count': len(data['rows']),
                     'total_rows': total, 'has_more': has_more, 'next_cursor': next_cursor},
            'history': {key: data[key] for key in ('snapshot_ref', 'expires_at', 'total_listens',
                        'period_label', 'range_label', 'coverage')},
            'native_origin': origin,
        }
