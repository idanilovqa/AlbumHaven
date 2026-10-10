"""Activity receipt expiry remains an action-boundary invariant after file I/O."""
from uuid import uuid4
import pytest
from music_app.services import playlist_activity_missing as activity_missing
from music_app.services import playlist_activity_sources as activity
from music_app.services import playlist_missing_sources as missing
from music_app.services import playlist_local_matches as matches
from music_app.services.owned_playlists import PlaylistError
from tests.py.owned_playlist_testing import Connection, context
from tests.py.test_playlist_activity_source_contract import MissingOwner, exported


@pytest.mark.parametrize('probe', [False, True])
def test_capture_and_probe_reject_activity_expiry_during_inventory(monkeypatch, probe):
    connection = Connection()
    expired = False
    origin = {'audience': 'own', 'subject_ref': None, 'kind': 'tracks', 'period': 'week', 'snapshot_ref': 's' * 43}
    def export(*args, **kwargs):
        if expired:
            raise PlaylistError('source_expired', 410)
        return [exported(11)]
    def rows(*args, **kwargs):
        nonlocal expired
        expired = True
        return [{'source_row_ref': exported(11)['row_ref']}]
    monkeypatch.setattr(activity, 'lock_target', lambda *a, **k: None)
    monkeypatch.setattr(activity, '_export', export)
    monkeypatch.setattr(activity_missing, 'missing_rows', rows)
    monkeypatch.setattr(activity_missing, '_header', lambda *a, **k: pytest.fail('Expired source allocated receipt'))
    with pytest.raises(PlaylistError, match='source_expired'):
        activity_missing.inspect(MissingOwner(connection), context(), origin, probe=probe)
    assert not connection.operations


def test_retained_selection_rejects_activity_expiry_during_choice_proof(monkeypatch):
    connection = Connection()
    source = {'source_kind': 'activity', 'ref': str(uuid4()), 'origin_descriptor': {}}
    expired = False
    def proof(*args, **kwargs):
        nonlocal expired
        expired = True
        return []
    def authority(*args, **kwargs):
        if expired:
            raise PlaylistError('source_expired', 410)
        return []
    monkeypatch.setattr(missing, 'validated_selection', lambda *a, **k: ([], {}, {}))
    monkeypatch.setattr(matches, 'apply_choices', proof)
    monkeypatch.setattr(missing, 'require_origin', authority)
    with pytest.raises(PlaylistError, match='source_expired'):
        missing.selected(MissingOwner(connection), connection, context(), source, [], constraints=None)
    assert not connection.operations


def test_match_action_boundary_rechecks_activity_after_candidate_proof(monkeypatch):
    connection = Connection()
    source = {'source_kind': 'activity', 'ref': str(uuid4())}
    constraints = object()
    def expired(owner, con, ctx, supplied, *, constraints):
        assert con is connection and supplied is source
        assert constraints is marker
        raise PlaylistError('source_expired', 410)
    marker = constraints
    monkeypatch.setattr(missing, 'require_origin', expired)
    monkeypatch.setattr(matches, 'lock_current_actor_session', lambda *a, **k: pytest.fail('Expired activity reached later action boundary'))
    with pytest.raises(PlaylistError, match='source_expired'):
        matches._fresh_now(MissingOwner(connection), connection, context(), source, constraints=constraints)
    assert not connection.operations
