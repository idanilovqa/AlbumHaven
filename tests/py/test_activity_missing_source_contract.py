"""Activity Inspect preserves receipt membership and strict inventory evidence."""
from uuid import uuid4
import pytest
from music_app.services import playlist_activity_sources as activity
from music_app.services import playlist_creation_sources_postgres as sources
from music_app.services import playlist_local_matches as matches
from music_app.services.owned_playlists import PlaylistError, normalize_playlist_command
from tests.py.owned_playlist_testing import context, REQUEST
from tests.py.test_playlist_activity_source_contract import exported, inventory


def test_activity_missing_protocol_has_its_own_source_tuple():
    descriptor={'kind':'activity','ref':str(uuid4()),'revision':str(uuid4())}
    command=normalize_playlist_command('create',{'mode':'missing','source_protocol':'missing_activity_selection_v1',
        'source':descriptor,'title':'Activity missing','entry_refs':[str(uuid4())],'request_key':REQUEST})
    assert command.data['source']==descriptor
    with pytest.raises(PlaylistError):
        normalize_playlist_command('create',{**command.data,'mode':'ordinary','request_key':REQUEST})
    with pytest.raises(PlaylistError):
        normalize_playlist_command('create',{**command.data,'source':{**descriptor,'kind':'playlist'},'request_key':REQUEST})


def test_activity_missing_match_requires_capture_uuid_revision():
    payload={'source':{'kind':'activity','ref':str(uuid4()),'revision':str(uuid4())},'entry_ref':str(uuid4())}
    assert matches.normalize_request(payload)==payload
    with pytest.raises(PlaylistError):matches.normalize_request({**payload,'source':{**payload['source'],'revision':'1'}})


def test_missing_activity_preserves_repeated_occurrences_without_changing_ordinary_capture(monkeypatch):
    monkeypatch.setattr(sources,'inventory_rows',lambda *args,**kwargs:{11:inventory(availability='missing')})
    rows=[exported(11),exported(11,suffix='2')]
    captured=activity._rows(object(),context(),rows,config={},constraints=None,preserve_occurrences=True)
    assert [row['source_row_ref'] for row in captured]==[row['row_ref'] for row in rows]
    assert len(captured)==2 and all(row['availability']=='missing' for row in captured)
    with pytest.raises(PlaylistError,match='duplicate_identity'):
        activity._rows(object(),context(),rows,config={},constraints=None)


def test_missing_activity_filters_only_current_confirmed_missing(monkeypatch):
    from music_app.services import playlist_activity_missing as activity_missing
    monkeypatch.setattr(sources,'inventory_rows',lambda *args,**kwargs:{
        11:inventory(availability='missing'),12:inventory(12,availability='local'),13:inventory(13,availability='unresolved')})
    rows=[exported(12),exported(suffix='2'),exported(11,suffix='3'),exported(13,suffix='4'),exported(11,suffix='5')]
    result=activity_missing.missing_rows(object(),context(),rows,config={},constraints=None)
    assert [row['source_row_ref'] for row in result]==[rows[2]['row_ref'],rows[4]['row_ref']]
    assert all(row['original_local_track_id']==11 for row in result)
    assert all('private_path' not in row for row in result)


def test_missing_activity_never_recovers_a_lost_inventory_identity(monkeypatch):
    from music_app.services import playlist_activity_missing as activity_missing
    monkeypatch.setattr(sources,'inventory_rows',lambda *args,**kwargs:{})
    with pytest.raises(PlaylistError,match='source_changed'):
        activity_missing.missing_rows(object(),context(),[exported(11)],config={},constraints=None)


def test_missing_occurrence_evidence_is_distinct_and_reproducible(monkeypatch):
    from music_app.services import playlist_activity_missing as activity_missing
    monkeypatch.setattr(sources,'inventory_rows',lambda *args,**kwargs:{11:inventory(availability='missing')})
    entries=[exported(11),exported(11,suffix='2')]
    first=activity_missing.missing_rows(object(),context(),entries,config={},constraints=None)
    again=activity_missing.missing_rows(object(),context(),entries,config={},constraints=None)
    assert first[0]['evidence_digest']!=first[1]['evidence_digest']
    assert [row['evidence_digest'] for row in first]==[row['evidence_digest'] for row in again]
