import pytest
from music_app.services.live_activity_postgres import parse_presence_source, parse_presence_update, PresenceError


def test_presence_commands_have_closed_owner_scoped_schema():
    player='12345678-1234-4234-8234-123456789012'
    assert parse_presence_source({'track_ref':'inventory-track:29:31','player_ref':player,'sequence':1})['sequence']==1
    assert parse_presence_update({'presence_ref':'A'*43,'sequence':2,'state':'paused'})['state']=='paused'


@pytest.mark.parametrize('patch',[{'sequence':True},{'sequence':0},{'sequence':2**53},{'account_id':12},{'player_ref':'bad'},{'track_ref':''}])
def test_source_rejects_invalid_and_cross_account_fields(patch):
    with pytest.raises(PresenceError):
        parse_presence_source({'track_ref':'inventory-track:29:31','player_ref':'12345678-1234-4234-8234-123456789012','sequence':1,**patch})


@pytest.mark.parametrize('patch',[{'state':'unknown'},{'state':'playing','path':'private'},{'sequence':False},{'presence_ref':'raw-path'}])
def test_update_never_accepts_raw_identity_or_unknown_state(patch):
    with pytest.raises(PresenceError):
        parse_presence_update({'presence_ref':'A'*43,'sequence':2,'state':'playing',**patch})


def test_presence_migration_revokes_generic_readonly_default():
    from pathlib import Path
    sql=(Path(__file__).parents[2]/'migrations/postgres/0096_create_current_playback_presence.sql').read_text()
    assert 'revoke all on app.current_playback_presence from public' in sql
    assert 'revoke all on app.current_playback_presence from album_haven_readonly' in sql


@pytest.mark.parametrize('reference',['/private/music.flac','C:\\Music\\Track.flac','track-key-alias',
    'inventory-track:0:1','inventory-track:1:0','inventory-track:01:2',
    'inventory-track:1:9999999999999999999','inventory-track:1:2\n'])
def test_source_requires_exact_path_free_inventory_reference(reference):
    with pytest.raises(PresenceError):
        parse_presence_source({'track_ref':reference,'player_ref':'12345678-1234-4234-8234-123456789012','sequence':1})
