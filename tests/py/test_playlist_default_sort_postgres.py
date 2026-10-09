"""Real SQL saved-sort metadata, permissions, constraints and authored order."""
from dataclasses import replace
import pytest
from tests.py.test_playlist_collaboration_postgres import sharing,write,member
from tests.py.test_owned_playlist_postgres_integration import db,urls
from music_app.services.current_actor import CapabilityGrant
from music_app.services.owned_playlists import SETTINGS,PlaylistError


def enable_settings(db,actor):
    with db.connect() as con:
        con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",
                    (actor.account_id,SETTINGS,db.library))
    return replace(actor,capability_grants=(*actor.capability_grants,CapabilityGrant(SETTINGS,"library",db.library)))


def test_saved_default_sort_roundtrips_without_reordering_and_null_resets(sharing):
    db=sharing
    db.owner=enable_settings(db,db.owner)
    original,_=db.create()
    before=db.service.read(db.context(),playlist_ref=original["playlist_id"])["playlist_detail"]
    desired={"key":"duration","direction":"desc"}
    saved,command=write(db,"default_sort",original,sort=desired)
    assert saved["saved_default_sort"]==desired and saved["changed"] is True
    assert db.service.execute(db.context(),command)==saved
    after=db.service.read(db.context(),playlist_ref=original["playlist_id"])["playlist_detail"]
    assert after["saved_default_sort"]==desired
    assert after["allowed_actions"]["can_save_default_sort"] is True
    assert after["active_sort"]=={"key":"playlist_position","direction":"asc"}
    assert [row["playlist_item_id"] for row in after["track_rows"]]==[row["playlist_item_id"] for row in before["track_rows"]]
    duplicate,_=write(db,"default_sort",saved,sort=desired)
    assert duplicate["changed"] is False and duplicate["revision"]==saved["revision"]
    reset,_=write(db,"default_sort",duplicate,sort=None)
    assert reset["changed"] is True and reset["saved_default_sort"] is None
    assert db.service.read(db.context(),playlist_ref=original["playlist_id"])["playlist_detail"]["saved_default_sort"] is None


def test_editor_needs_settings_capability_and_shared_reader_cannot_save(sharing):
    db=sharing
    original,_=db.create()
    editor=member(db)
    granted,_=write(db,"grant_editor",original,account_id=editor.account_id,role="editor")
    desired={"key":"love_tier","direction":"asc"}
    with pytest.raises(PlaylistError,match="forbidden"):
        write(db,"default_sort",granted,actor=editor,sort=desired)
    editor=enable_settings(db,editor)
    edited,_=write(db,"default_sort",granted,actor=editor,sort=desired)
    viewer=enable_settings(db,member(db))
    shared,_=write(db,"visibility",edited,visibility="server_shared")
    with pytest.raises(PlaylistError,match="forbidden"):
        write(db,"default_sort",shared,actor=viewer,sort=desired)


@pytest.mark.parametrize("invalid",['{"key":null,"direction":"asc"}','{"key":"duration","direction":null}',
    '{"key":"title","direction":"asc"}','{"key":"duration","direction":"asc","extra":1}','[]','null'])
def test_database_sort_constraint_rejects_invalid_non_sql_null(sharing,invalid):
    db=sharing
    original,_=db.create()
    import psycopg
    with pytest.raises(psycopg.errors.CheckViolation):
        with db.connect() as con:
            con.execute("update app.playlists set default_sort=%s::jsonb where ref=%s",(invalid,original["playlist_id"]))
    assert db.service.read(db.context(),playlist_ref=original["playlist_id"])["playlist_detail"]["saved_default_sort"] is None
