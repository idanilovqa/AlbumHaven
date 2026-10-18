"""Same-subject Love predicates inside an already guarded history receipt."""
import hashlib
import hmac
import json

from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import require_private_action, PrivateLibraryAuthorityError
from music_app.services.private_search_contract import ListenerSearchCriteria, PrivateSearchError
from music_app.services.track_preferences_postgres import load_track_preferences_on_connection


class ListenerLovePredicate:
    def __init__(self, connection, *, live_context, subject, criteria, constraints, cursor_secret, receipt):
        if type(criteria) is not ListenerSearchCriteria or not criteria.filtered or not isinstance(cursor_secret, str):
            raise PrivateSearchError('private_search_unavailable', 503)
        self.connection, self.context, self.subject = connection, live_context, subject
        self.criteria, self.constraints, self.receipt = criteria, constraints, receipt
        self.action = ('library.browse.read' if subject.account_id == live_context.actor.account_id
                       else 'library.social.taste.read')
        self.key = hashlib.sha256(('listener-search-policy-v1:' + cursor_secret).encode()).digest()

    def _require(self, kind, identity):
        try:
            require_private_action(self.context, self.action,
                resource=ResourceScope(kind, str(identity)), constraints=self.constraints)
        except PrivateLibraryAuthorityError:
            raise PrivateSearchError('private_search_forbidden', 403) from None

    def _allowed_track(self, resource):
        if resource is None:
            return False
        if (type(resource) is not dict or resource.get('kind') != 'track'
                or type(resource.get('id')) is not int or resource['id'] <= 0):
            raise PrivateSearchError('private_search_unavailable', 503)
        try:
            self._require('track', resource['id'])
        except PrivateSearchError as error:
            if error.status_code == 403:
                return False
            raise
        return True

    def authorize(self):
        # The receipt owner retains the inventory and subject revision locks.
        self.receipt.summary
        self._require('account', self.subject.account_id)
        row = self.connection.execute("""select love_revision from app.activity_source_revisions
            where library_id=%s and account_id=%s""",
            (self.context.library_id, self.subject.account_id)).fetchone()
        revision = row['love_revision'] if row else None
        if type(revision) is not int or not 0 <= revision <= 9223372036854775807:
            raise PrivateSearchError('private_search_unavailable', 503)
        digest = hmac.new(self.key, digestmod=hashlib.sha256)
        domain = [self.context.actor.account_id, self.context.actor.session_id,
                  self.context.library_id, self.subject.account_ref, self.action, self.criteria.as_payload()]
        digest.update(json.dumps(domain, separators=(',', ':'), sort_keys=True).encode())
        if callable(self.constraints):
            for chunk in self.receipt.iter_canonical_track_refs():
                for entry in chunk:
                    resource = entry['canonical_resource']
                    decision = [entry['row_ref'], resource['id'] if resource else None,
                                self._allowed_track(resource)]
                    digest.update(b'\n' + json.dumps(decision, separators=(',', ':')).encode())
        else:
            digest.update(b'\nscope-wide')
        return {'love_revision': revision, 'taste_policy_digest': digest.hexdigest()}

    def matches(self, entries):
        self.receipt.summary
        self._require('account', self.subject.account_id)
        admitted = {entry['row_ref']: entry['canonical_resource']['id']
                    for entry in entries if self._allowed_track(entry['canonical_resource'])}
        result = {entry['row_ref']: False for entry in entries}
        if not admitted:
            return result
        keys = {row['id']: row['track_key'] for row in self.connection.execute(
            'select id,track_key from library.local_tracks where library_id=%s and id=any(%s)',
            (self.context.library_id, sorted(set(admitted.values())))).fetchall()}
        preferences = load_track_preferences_on_connection(self.connection,
            [key for key in keys.values() if key], account_id=self.subject.account_id,
            library_id=self.context.library_id)
        tiers = self.criteria.tiers()
        for ref, identity in admitted.items():
            selected = preferences.get(keys.get(identity))
            result[ref] = bool(selected and selected['track_id'] == identity and selected['love_tier'] in tiers)
        return result

    def assert_unchanged(self, expected):
        # Recompute callable decisions, including previously excluded rows.
        if self.authorize() != expected:
            raise PrivateSearchError('search_cursor_restart_required', 409)
