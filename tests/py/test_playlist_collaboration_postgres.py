"""Real PostgreSQL collaboration checks, sharing the synthetic owned fixture."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from threading import Event
from uuid import uuid4

import pytest

from tests.py.test_owned_playlist_postgres_integration import db, urls
from music_app.services.current_actor import CapabilityGrant
from music_app.services.owned_playlists import ACCESS, PlaylistError, normalize_playlist_command
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.policy_evaluator import PolicyEvaluationConstraints


@pytest.fixture
def sharing(db):
    with db.connect() as con:
        con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",
                    (db.owner.account_id,ACCESS,db.library))
    db.owner=replace(db.owner,capability_grants=(*db.owner.capability_grants,CapabilityGrant(ACCESS,"library",db.library)))
    return db


def write(db, action, receipt, *, actor=None, key=None, **data):
    command=normalize_playlist_command(action,{"revision":receipt["revision"],"request_key":key or str(uuid4()),**data},
                                       playlist_ref=receipt["playlist_id"])
    return db.service.execute(db.context(actor),command),command


def member(db):
    with db.connect() as con:
        return db.member(con,db.actor(con))


def test_private_editor_and_server_shared_viewer_have_distinct_authority(sharing):
    db=sharing
    original,_=db.create()
    viewer=member(db)
    assert db.service.read(db.context(viewer))["playlist_index"]["playlists"]==[]
    shared,_=write(db,"visibility",original,visibility="server_shared")
    detail=db.service.read(db.context(viewer),playlist_ref=original["playlist_id"])["playlist_detail"]
    assert detail["visibility"]=="server_shared"
    assert detail["allowed_actions"]["can_read"] is True
    assert all(detail["allowed_actions"][key] is False for key in ("can_edit","can_add","can_share","can_delete","can_play"))
    granted,_=write(db,"grant_editor",shared,account_id=viewer.account_id,role="editor")
    private,_=write(db,"visibility",granted,visibility="private")
    detail=db.service.read(db.context(viewer),playlist_ref=original["playlist_id"])["playlist_detail"]
    assert detail["allowed_actions"]["can_edit"] is True
    assert detail["allowed_actions"]["can_add"] is True
    assert detail["allowed_actions"]["can_share"] is False
    edited,_=write(db,"save",private,actor=viewer,title="Editor metadata")
    assert edited["changed"] is True
    assert db.service.read(db.context(),playlist_ref=original["playlist_id"])["playlist_detail"]["title"]=="Editor metadata"


def test_editor_contents_are_atomic_and_owner_lifecycle_stays_denied(sharing):
    db=sharing
    original,_=db.create(refs=[])
    editor=member(db)
    granted,_=write(db,"grant_editor",original,account_id=editor.account_id,role="editor")
    added,_=write(db,"add",granted,actor=editor,track_refs=[f"inventory-track:{db.library}:{t}" for t in db.tracks])
    detail=db.service.read(db.context(editor),playlist_ref=original["playlist_id"])["playlist_detail"]
    refs=[row["playlist_item_id"] for row in detail["track_rows"]]
    reordered,_=write(db,"reorder",added,actor=editor,item_order=list(reversed(refs)))
    removed,_=write(db,"remove",reordered,actor=editor,item_refs=[refs[1]])
    assert removed["removed_count"]==1
    for action,data in (("delete",{}),("visibility",{"visibility":"server_shared"}),
                        ("grant_editor",{"account_id":db.owner.account_id,"role":"editor"}),
                        ("revoke_editor",{"grant_ref":granted["grant_ref"]})):
        with pytest.raises(PlaylistError,match="forbidden"):
            write(db,action,removed,actor=editor,**data)
    with pytest.raises(PlaylistError,match="forbidden"):
        db.service.read_access(db.context(editor),original["playlist_id"])
    final=db.service.read(db.context(),playlist_ref=original["playlist_id"])["playlist_detail"]
    assert [row["playlist_item_id"] for row in final["track_rows"]]==[refs[2],refs[0]]
    assert final["revision"]==removed["revision"]


def test_revoke_removes_private_read_and_operation_reconciliation(sharing):
    db=sharing
    original,_=db.create()
    editor=member(db)
    granted,_=write(db,"grant_editor",original,account_id=editor.account_id,role="editor")
    edited,command=write(db,"save",granted,actor=editor,title="Editor change")
    revoked,_=write(db,"revoke_editor",edited,grant_ref=granted["grant_ref"])
    assert revoked["changed"] is True
    for call in (lambda:db.service.read(db.context(editor),playlist_ref=original["playlist_id"]),
                 lambda:db.service.read_operation(db.context(editor),command.request_key),
                 lambda:db.service.execute(db.context(editor),command)):
        with pytest.raises(PlaylistError,match="playlist_unavailable"):
            call()
    assert db.service.read(db.context(editor))["playlist_index"]["playlists"]==[]


def test_duplicate_grant_and_same_visibility_are_revision_noops(sharing):
    db=sharing
    original,_=db.create()
    editor=member(db)
    first,_=write(db,"grant_editor",original,account_id=editor.account_id,role="editor")
    duplicate,_=write(db,"grant_editor",first,account_id=editor.account_id,role="editor")
    unchanged,_=write(db,"visibility",duplicate,visibility="private")
    assert duplicate["grant_ref"]==first["grant_ref"]
    assert duplicate["changed"] is unchanged["changed"] is False
    assert first["revision"]==duplicate["revision"]==unchanged["revision"]
    access=db.service.read_access(db.context(),original["playlist_id"])
    with db.connect() as con:
        identity=con.execute("""select p.account_ref::text,a.display_name,a.username_display
            from app.accounts a join app.social_profiles p on p.account_id=a.id where a.id=%s""",
            (editor.account_id,)).fetchone()
    assert access["grants"]==[{"grant_ref":first["grant_ref"],"account_id":editor.account_id,
                              "role":"editor","is_active":True,**identity}]


@pytest.mark.parametrize("state",["inactive","nonmember","owner"])
def test_grant_target_must_be_active_other_member(sharing,state):
    db=sharing
    original,_=db.create()
    with db.connect() as con:
        if state=="owner":
            target=db.owner
        else:
            target=db.actor(con)
            if state=="inactive":
                target=db.member(con,target)
                con.execute("update app.accounts set is_active=false,disabled_at=now() where id=%s",(target.account_id,))
    with pytest.raises(PlaylistError,match="invalid_editor" if state=="owner" else "grant_target_unavailable"):
        write(db,"grant_editor",original,account_id=target.account_id,role="editor")
    assert db.service.read_access(db.context(),original["playlist_id"])["grants"]==[]
    assert db.count("playlist_operations")==1


def test_soft_delete_preserves_rows_and_original_owner_receipts(sharing):
    db=sharing
    original,create_command=db.create()
    editor=member(db)
    granted,_=write(db,"grant_editor",original,account_id=editor.account_id,role="editor")
    deleted,delete_command=write(db,"delete",granted)
    assert deleted["deleted"] is True
    assert db.service.execute(db.context(),delete_command)==deleted
    assert db.service.execute(db.context(),create_command)==original
    assert db.service.read_operation(db.context(),delete_command.request_key)=={"status":"committed","receipt":deleted}
    for actor in (db.owner,editor):
        assert db.service.read(db.context(actor))["playlist_index"]["playlists"]==[]
        with pytest.raises(PlaylistError,match="playlist_unavailable"):
            db.service.read(db.context(actor),playlist_ref=original["playlist_id"])
    with pytest.raises(PlaylistError,match="playlist_unavailable"):
        write(db,"delete",deleted)
    with db.connect() as con:
        row=con.execute("select deleted_at,revision from app.playlists where ref=%s",(original["playlist_id"],)).fetchone()
        assert row["deleted_at"] is not None
        assert str(row["revision"])==deleted["revision"]
        assert con.execute("select count(*) as n from app.playlist_items where playlist_ref=%s",(original["playlist_id"],)).fetchone()["n"]==3
        assert con.execute("select count(*) as n from app.playlist_access_grants where playlist_ref=%s",(original["playlist_id"],)).fetchone()["n"]==1


def test_member_removal_cascades_grant_and_rejoin_does_not_restore_it(sharing):
    db=sharing
    original,_=db.create()
    editor=member(db)
    write(db,"grant_editor",original,account_id=editor.account_id,role="editor")
    with db.connect() as con:
        con.execute("delete from library.library_memberships where library_id=%s and account_id=%s",(db.library,editor.account_id))
        con.execute("insert into library.library_memberships(library_id,account_id,membership_role) values(%s,%s,'member')",(db.library,editor.account_id))
    assert db.service.read_access(db.context(),original["playlist_id"])["grants"]==[]
    with pytest.raises(PlaylistError,match="playlist_unavailable"):
        db.service.read(db.context(editor),playlist_ref=original["playlist_id"])


def test_concurrent_editors_cannot_overwrite_one_revision(sharing):
    db=sharing
    original,_=db.create()
    first,second=member(db),member(db)
    granted,_=write(db,"grant_editor",original,account_id=first.account_id,role="editor")
    granted,_=write(db,"grant_editor",granted,account_id=second.account_id,role="editor")
    def edit(actor):
        try:
            return write(db,"save",granted,actor=actor,title=f"Editor {actor.account_id}")[0]
        except PlaylistError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(edit,(first,second)))
    assert sum(isinstance(result,dict) for result in results)==1
    assert results.count("revision_conflict")==1
    assert db.service.read(db.context(),playlist_ref=original["playlist_id"])["playlist_detail"]["revision"]==str(int(granted["revision"])+1)


def test_grant_revoked_during_parent_wait_is_rechecked(sharing):
    db=sharing
    original,_=db.create()
    editor=member(db)
    granted,_=write(db,"grant_editor",original,account_id=editor.account_id,role="editor")
    attempting=Event()
    from music_app.services.postgres_connections import pooled_connection
    class ObservedConnection:
        def __init__(self,connection):
            self.connection=connection
        def execute(self,sql,params=()):
            if "select * from app.playlists" in sql:
                attempting.set()
            return self.connection.execute(sql,params)
    @contextmanager
    def connect(url):
        with pooled_connection(url) as connection:
            yield ObservedConnection(connection)
    service=PostgresOwnedPlaylistsService({"ALBUM_HAVEN_APP_DATABASE_URL":db.app_url},connect=connect)
    command=normalize_playlist_command("save",{"revision":granted["revision"],"request_key":str(uuid4()),"title":"Must not commit"},playlist_ref=original["playlist_id"])
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.connect() as blocker:
            blocker.execute("select ref from app.playlists where ref=%s for update",(original["playlist_id"],))
            future=pool.submit(service.execute,db.context(editor),command)
            assert attempting.wait(5), "Editor did not reach the parent-lock checkpoint"
            blocker.execute("delete from app.playlist_access_grants where ref=%s",(granted["grant_ref"],))
        with pytest.raises(PlaylistError,match="playlist_unavailable"):
            future.result(timeout=5)
    assert db.service.read(db.context(),playlist_ref=original["playlist_id"])["playlist_detail"]["title"]=="Synthetic saved playlist"


def test_track_constraints_filter_sources_reject_writes_and_redact_current_links(sharing):
    db=sharing
    def deny_track(context):
        return PolicyEvaluationConstraints(deployment_allowed=not (
            context.resource is not None and context.resource.resource_kind=="track"
            and context.resource.resource_ref==str(db.tracks[0])))
    source,page=db.source()
    filtered=db.service.read_source_page(db.context(),source_ref=source["ref"],source_revision=source["revision"],constraints=deny_track)["data"]
    assert len(filtered["entries"])==2
    refs=[row["entry_ref"] for row in page["entries"]]
    create=normalize_playlist_command("create",{"mode":"ordinary","source_protocol":"library_selection_v1", "source":source,"title":"Denied","entry_refs":refs,"request_key":str(uuid4())})
    with pytest.raises(PlaylistError,match="item_unavailable"):
        db.service.execute(db.context(),create,constraints=deny_track)
    original,_=db.create(source=source,refs=refs)
    detail=db.service.read(db.context(),playlist_ref=original["playlist_id"],constraints=deny_track)["playlist_detail"]
    first=detail["track_rows"][0]
    assert first["title"]=="Track 0"
    assert first["inventory_track_ref"] is None and first["availability"]=="unresolved"
    empty,_=db.create(refs=[])
    add=normalize_playlist_command("add",{"revision":"1","track_refs":[f"inventory-track:{db.library}:{db.tracks[0]}"],"request_key":str(uuid4())},playlist_ref=empty["playlist_id"])
    with pytest.raises(PlaylistError,match="item_unavailable"):
        db.service.execute(db.context(),add,constraints=deny_track)


def test_private_grant_table_and_tombstones_keep_minimum_database_privileges(sharing):
    db=sharing
    with db.connect() as con:
        for role in ("album_haven_readonly","album_haven_app"):
            exists=con.execute("select 1 from pg_roles where rolname=%s",(role,)).fetchone()
            assert exists is not None
        assert con.execute("select has_table_privilege('album_haven_readonly','app.playlist_access_grants','SELECT') as allowed").fetchone()["allowed"] is False
        for privilege in ("SELECT","INSERT","DELETE"):
            assert con.execute("select has_table_privilege('album_haven_app','app.playlist_access_grants',%s) as allowed",(privilege,)).fetchone()["allowed"] is True
        assert con.execute("select has_table_privilege('album_haven_app','app.playlist_access_grants','UPDATE') as allowed").fetchone()["allowed"] is False
        assert con.execute("select has_table_privilege('album_haven_app','app.playlists','DELETE') as allowed").fetchone()["allowed"] is False


def test_owner_access_projection_retains_disabled_editor_for_revocation(sharing):
    db=sharing
    original,_=db.create()
    editor=member(db)
    granted,_=write(db,"grant_editor",original,account_id=editor.account_id,role="editor")
    before=db.service.read_access(db.context(),original["playlist_id"])["grants"]
    with db.connect() as con:
        con.execute("update app.accounts set is_active=false,disabled_at=now() where id=%s",(editor.account_id,))
    assert db.service.read_access(db.context(),original["playlist_id"])["grants"]==[{**before[0],"is_active":False}]
    write(db,"revoke_editor",granted,grant_ref=granted["grant_ref"])
    assert db.service.read_access(db.context(),original["playlist_id"])["grants"]==[]


def test_opaque_cursor_hides_denied_sort_facts_and_advances_to_readable_rows(sharing):
    db=sharing
    source,_=db.source()
    def deny_first(context):
        return PolicyEvaluationConstraints(deployment_allowed=not (
            context.resource is not None and context.resource.resource_kind=="track"
            and context.resource.resource_ref==str(db.tracks[0])))
    page=db.service.read_source_page(db.context(),source_ref=source["ref"],source_revision=source["revision"],limit=1,constraints=deny_first)["data"]
    from uuid import UUID
    assert page["entries"]==[] and page["has_more"] is True
    assert str(UUID(page["next_cursor"]))==page["next_cursor"]
    next_page=db.service.read_source_page(db.context(),source_ref=source["ref"],source_revision=source["revision"],limit=1,
        cursor=page["next_cursor"],constraints=deny_first)["data"]
    assert next_page["entries"][0]["title"]=="Track 1"
    assert next_page["search_revision"]==page["search_revision"]
    another,_=db.source()
    with pytest.raises(PlaylistError,match="invalid_cursor"):
        db.service.read_source_page(db.context(),source_ref=another["ref"],source_revision=another["revision"],cursor=page["next_cursor"])
    with pytest.raises(PlaylistError,match="invalid_cursor"):
        db.service.read_source_page(db.context(),source_ref=source["ref"],source_revision=source["revision"],query="different",cursor=page["next_cursor"])
    with db.connect() as con:
        con.execute("delete from app.playlist_creation_sources where ref=%s",(source["ref"],))
        assert con.execute("select count(*) as n from app.playlist_source_cursors where source_ref=%s",(source["ref"],)).fetchone()["n"]==0
