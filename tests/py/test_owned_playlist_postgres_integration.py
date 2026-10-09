"""Real SQL atomicity/evidence contracts using uniquely owned synthetic data."""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import re
from urllib.parse import urlparse
from uuid import uuid4

import pytest

from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.owned_playlists import BROWSE, CREATE, MANAGE, ITEMS, PlaylistError, normalize_playlist_command
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.policy import PolicyContext, RequestOrigin


@pytest.fixture(scope="module")
def urls():
    app = os.environ.get("ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL", "")
    setup = os.environ.get("DATABASE_MIGRATOR_URL", "")
    if not app:
        pytest.skip("Requires admitted synthetic PostgreSQL; live SQL was not exercised")
    a, s = urlparse(app), urlparse(setup)
    assert a.scheme in {"postgres", "postgresql"} and s.scheme in {"postgres", "postgresql"}
    assert a.hostname in {"127.0.0.1", "localhost", "::1"}
    assert (a.hostname, a.port, a.path) == (s.hostname, s.port, s.path)
    assert re.fullmatch(r"(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*", a.path.lstrip("/"))
    assert not a.query and not s.query
    return app, setup


class Database:
    def __init__(self, urls):
        self.app_url, self.setup_url = urls
        self.now = datetime.now(timezone.utc)
        self.token = uuid4().hex
        self.service = PostgresOwnedPlaylistsService({"ALBUM_HAVEN_APP_DATABASE_URL": self.app_url})
        self.account_ids = []
        self.library = None

    def connect(self):
        import psycopg
        from psycopg.rows import dict_row
        return psycopg.connect(self.setup_url, row_factory=dict_row)

    def actor(self, connection):
        name = "playlist-" + uuid4().hex
        account = connection.execute("""insert into app.accounts(display_name,account_kind,
          username_display,username_normalized,contact_email,contact_email_normalized)
          values(%s,'managed_user',%s,%s,%s,%s) returning id""",
          (name,name,name,name+"@example.test",name+"@example.test")).fetchone()["id"]
        self.account_ids.append(account)
        session = connection.execute("""insert into app.account_sessions(account_id,session_token_hash,
          created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
          values(%s,%s,%s,%s,%s,%s,%s) returning id""", (account,hashlib.sha256(uuid4().bytes).digest(),
          self.now,self.now,self.now,self.now+timedelta(hours=1),self.now+timedelta(days=1))).fetchone()["id"]
        return CurrentActor(state=ActorState.ACTIVE,account_id=account,session_id=session,
            authenticated_at=self.now)

    def member(self, connection, actor):
        connection.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'member')", (actor.account_id,self.library))
        for action in (BROWSE,CREATE,MANAGE,ITEMS):
            connection.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)", (actor.account_id,action,self.library))
        return replace(actor,current_library_id=self.library,
            library_relationships=(LibraryRelationship(self.library,"member",False),),
            capability_grants=tuple(CapabilityGrant(action,"library",self.library) for action in (BROWSE,CREATE,MANAGE,ITEMS)))

    def context(self, actor=None):
        return PolicyContext.build(actor=actor or self.owner,action=BROWSE,library_id=self.library,
            deployment_mode="self_hosted",request_origin=RequestOrigin("network","synthetic:test"),
            client_surface_class="private_web")

    def source(self):
        ctx = self.context()
        source = self.service.begin_source(ctx)["data"]["source"]
        page = self.service.read_source_page(ctx,source_ref=source["ref"],source_revision=source["revision"])["data"]
        return source, page

    def create(self, *, source=None, refs=None, key=None, service=None):
        if source is None:
            source, page = self.source()
            if refs is None:
                refs = [entry["entry_ref"] for entry in page["entries"]]
        command = normalize_playlist_command("create",{"request_key":key or str(uuid4()),
            "mode":"ordinary","source_protocol":"library_selection_v1","source":source,
            "title":"Synthetic saved playlist","description":"","entry_refs":refs or []})
        return (service or self.service).execute(self.context(),command), command

    def count(self, table):
        assert table in {"playlists","playlist_operations"}
        with self.connect() as con:
            return con.execute(f"select count(*) as n from app.{table} where library_id=%s",(self.library,)).fetchone()["n"]

    def close(self):
        with self.connect() as con:
            if self.library:
                con.execute("delete from app.playlist_operations where library_id=%s",(self.library,))
                con.execute("delete from app.playlists where library_id=%s",(self.library,))
                con.execute("delete from library.libraries where id=%s",(self.library,))
            for account in self.account_ids:
                con.execute("delete from app.accounts where id=%s",(account,))


@pytest.fixture
def db(urls):
    db = Database(urls)
    try:
        with db.connect() as con:
            owner = db.actor(con)
            db.library = con.execute("insert into library.libraries(owner_account_id,name) values(%s,%s) returning id",(owner.account_id,"Playlist "+db.token)).fetchone()["id"]
            db.owner = db.member(con,owner)
            root = con.execute("insert into library.library_roots(library_id,root_path) values(%s,%s) returning id",(db.library,"/synthetic-playlists/"+db.token)).fetchone()["id"]
            artist = con.execute("insert into library.local_artists(library_id,artist_key,name) values(%s,%s,'Artist') returning id",(db.library,db.token)).fetchone()["id"]
            album = con.execute("insert into library.local_albums(library_id,artist_id,album_key,title,release_year) values(%s,%s,%s,'Album',2000) returning id",(db.library,artist,db.token)).fetchone()["id"]
            db.tracks=[]
            for index in range(3):
                track = con.execute("insert into library.local_tracks(library_id,artist_id,album_id,track_key,title,track_number,duration_seconds) values(%s,%s,%s,%s,%s,%s,180) returning id",(db.library,artist,album,f"{db.token}:{index}",f"Track {index}",index+1)).fetchone()["id"]
                con.execute("insert into library.local_track_files(track_id,library_root_id,private_path,content_signature) values(%s,%s,%s,'original')",(track,root,f"/synthetic-playlists/{db.token}/{index}.flac"))
                db.tracks.append(track)
        yield db
    finally:
        db.close()


def test_create_persists_authored_order_and_idempotent_receipt(db):
    source, page = db.source()
    assert page["entries_complete"] is False
    assert "synthetic-playlists" not in json.dumps(page)
    refs=[row["entry_ref"] for row in reversed(page["entries"])]
    receipt, command = db.create(source=source,refs=refs)
    assert db.service.execute(db.context(),command)==receipt
    assert db.count("playlists")==1 and db.count("playlist_operations")==1
    detail=db.service.read(db.context(),playlist_ref=receipt["playlist_id"])["playlist_detail"]
    assert [row["title"] for row in detail["track_rows"]]==["Track 2","Track 1","Track 0"]
    assert detail["revision"]=="1"


@pytest.mark.parametrize("change",["title","file_identity","file_signature","availability"])
def test_changed_selected_evidence_rejects_atomic_create(db,change):
    source,page=db.source()
    with db.connect() as con:
        if change=="title":
            con.execute("update library.local_tracks set title='Changed' where id=%s",(db.tracks[0],))
        elif change=="file_identity":
            con.execute("update library.local_track_files set private_path=private_path||'.new' where track_id=%s",(db.tracks[0],))
        elif change=="file_signature":
            con.execute("update library.local_track_files set content_signature='replacement' where track_id=%s",(db.tracks[0],))
        else:
            con.execute("update library.library_roots set is_active=false where library_id=%s",(db.library,))
    with pytest.raises(PlaylistError,match="source_changed"):
        db.create(source=source,refs=[row["entry_ref"] for row in page["entries"]])
    assert db.count("playlists")==db.count("playlist_operations")==0


def test_committed_retry_survives_source_expiry_but_new_operation_does_not(db):
    source,page=db.source()
    receipt,command=db.create(source=source,refs=[page["entries"][0]["entry_ref"]])
    with db.connect() as con:
        con.execute("update app.playlist_creation_sources set expires_at=now()-interval '1 second' where ref=%s",(source["ref"],))
    assert db.service.execute(db.context(),command)==receipt
    with pytest.raises(PlaylistError,match="source_expired"):
        db.create(source=source,refs=[])
    assert db.count("playlists")==1


def test_foreign_member_cannot_read_or_replay_owned_playlist(db):
    receipt,command=db.create()
    with db.connect() as con:
        other=db.member(con,db.actor(con))
    with pytest.raises(PlaylistError,match="playlist_unavailable"):
        db.service.read(db.context(other),playlist_ref=receipt["playlist_id"])
    assert db.service.read_operation(db.context(other),command.request_key)=={"status":"unknown"}


def test_same_account_new_session_cannot_reuse_or_read_operation_key(db):
    receipt,command=db.create()
    with db.connect() as con:
        session=con.execute("""insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,now(),now(),now(),now()+interval '1 hour',now()+interval '1 day') returning id""",
            (db.owner.account_id,hashlib.sha256(uuid4().bytes).digest())).fetchone()["id"]
    ctx=db.context(replace(db.owner,session_id=session))
    assert db.service.read_operation(ctx,command.request_key)=={"status":"unknown"}
    with pytest.raises(PlaylistError,match="operation_unavailable"):
        db.service.execute(ctx,command)
    assert db.count("playlists")==1


def test_inventory_delete_preserves_saved_original_and_item_identity(db):
    receipt,_=db.create()
    before=db.service.read(db.context(),playlist_ref=receipt["playlist_id"])["playlist_detail"]["track_rows"]
    with db.connect() as con:
        con.execute("delete from library.local_tracks where id=%s",(db.tracks[0],))
    after=db.service.read(db.context(),playlist_ref=receipt["playlist_id"])["playlist_detail"]["track_rows"]
    assert len(after)==3 and after[0]["playlist_item_id"]==before[0]["playlist_item_id"]
    assert after[0]["title"]=="Track 0" and after[0]["availability"]=="unresolved"
    assert after[0]["inventory_track_ref"] is None


def test_metadata_and_complete_reorder_are_one_revision_then_remove_compacts(db):
    receipt,_=db.create()
    ref=receipt["playlist_id"]
    rows=db.service.read(db.context(),playlist_ref=ref)["playlist_detail"]["track_rows"]
    order=[row["playlist_item_id"] for row in reversed(rows)]
    command=normalize_playlist_command("save",{"request_key":str(uuid4()),"revision":"1","title":"Renamed","item_order":order},playlist_ref=ref)
    saved=db.service.execute(db.context(),command)
    assert saved["revision"]=="2" and saved["changed"]
    noop=normalize_playlist_command("save",{"request_key":str(uuid4()),"revision":"2","title":"Renamed","item_order":order},playlist_ref=ref)
    assert db.service.execute(db.context(),noop)["changed"] is False
    removed=normalize_playlist_command("remove",{"request_key":str(uuid4()),"revision":"2","item_refs":[order[1]]},playlist_ref=ref)
    assert db.service.execute(db.context(),removed)["revision"]=="3"
    after=db.service.read(db.context(),playlist_ref=ref)["playlist_detail"]["track_rows"]
    assert [row["playlist_item_id"] for row in after]==[order[0],order[2]]
    assert [row["playlist_position"] for row in after]==[1,2]


@pytest.mark.parametrize("fault",["insert into app.playlist_items","insert into app.playlist_operations"])
def test_real_transaction_rolls_back_failure_after_collection_insert(db,fault):
    import psycopg
    from psycopg.rows import dict_row
    class Connection:
        def __init__(self,real): self.real=real
        def execute(self,sql,params=None):
            if fault in " ".join(sql.split()).lower(): raise RuntimeError("injected owned fault")
            return self.real.execute(sql,params)
    @contextmanager
    def connect(url):
        with psycopg.connect(url,row_factory=dict_row) as real:
            yield Connection(real)
    service=PostgresOwnedPlaylistsService({"ALBUM_HAVEN_APP_DATABASE_URL":db.app_url},connect=connect)
    with pytest.raises(RuntimeError,match="injected owned fault"):
        db.create(service=service)
    assert db.count("playlists")==db.count("playlist_operations")==0


def test_live_membership_revocation_rejects_stale_context_and_receipt(db):
    receipt,command=db.create()
    with db.connect() as con:
        con.execute("delete from library.library_memberships where account_id=%s and library_id=%s",(db.owner.account_id,db.library))
    with pytest.raises(PlaylistError,match="forbidden"):
        db.service.execute(db.context(),command)
    with pytest.raises(PlaylistError,match="forbidden"):
        db.service.read_operation(db.context(),command.request_key)
    assert db.count("playlists")==1


@pytest.mark.parametrize("same_key",[True,False])
def test_concurrent_creates_commit_once_per_operation_key(db,same_key):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    source,page=db.source()
    key=str(uuid4())
    commands=[normalize_playlist_command("create",{"request_key":key if same_key else str(uuid4()),
        "mode":"ordinary","source_protocol":"library_selection_v1","source":source,
        "title":"Concurrent","entry_refs":[page["entries"][0]["entry_ref"]]}) for _ in range(2)]
    start=Barrier(2)
    def execute(command):
        start.wait(timeout=5)
        return db.service.execute(db.context(),command)
    with ThreadPoolExecutor(max_workers=2) as pool:
        receipts=list(pool.map(execute,commands))
    assert db.count("playlists")==db.count("playlist_operations")== (1 if same_key else 2)
    assert (receipts[0]["playlist_id"]==receipts[1]["playlist_id"]) is same_key


def test_session_revoked_while_writer_waits_rejects_without_receipt(db):
    import psycopg
    from psycopg.rows import dict_row
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    reached=Event()
    source,page=db.source()
    command=normalize_playlist_command("create",{"request_key":str(uuid4()),"mode":"ordinary",
        "source_protocol":"library_selection_v1","source":source,"title":"Revoked", "entry_refs":[]})
    class Connection:
        def __init__(self,real): self.real=real
        def execute(self,sql,params=None):
            if "from app.account_sessions" in sql:
                reached.set()
            return self.real.execute(sql,params)
    @contextmanager
    def connect(url):
        with psycopg.connect(url,row_factory=dict_row) as real:
            yield Connection(real)
    service=PostgresOwnedPlaylistsService({"ALBUM_HAVEN_APP_DATABASE_URL":db.app_url},connect=connect)
    with db.connect() as blocker:
        blocker.execute("select id from app.account_sessions where id=%s for update",(db.owner.session_id,))
        with ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(service.execute,db.context(),command)
            try:
                assert reached.wait(timeout=5), "Writer did not reach the owned session lock"
                blocker.execute("update app.account_sessions set revoked_at=now() where id=%s",(db.owner.session_id,))
                blocker.commit()
                with pytest.raises(PlaylistError,match="forbidden"):
                    future.result(timeout=10)
            finally:
                blocker.rollback()
    assert db.count("playlists")==db.count("playlist_operations")==0


def test_playlist_tables_have_explicit_private_minimum_runtime_privileges(db):
    expected={
        "app.playlists":{"SELECT","INSERT","UPDATE"},
        "app.playlist_items":{"SELECT","INSERT","UPDATE","DELETE"},
        "app.playlist_creation_sources":{"SELECT","INSERT","UPDATE","DELETE"},
        "app.playlist_creation_entries":{"SELECT","INSERT"},
        "app.playlist_operations":{"SELECT","INSERT","UPDATE"},
    }
    with db.connect() as con:
        for table,grants in expected.items():
            for privilege in ("SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"):
                actual=con.execute("select has_table_privilege('album_haven_app',%s,%s) as app,has_table_privilege('album_haven_readonly',%s,%s) as readonly",
                    (table,privilege,table,privilege)).fetchone()
                assert actual=={"app":privilege in grants,"readonly":False},(table,privilege,actual)
            public=con.execute("select count(*) as n from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) p where c.oid=%s::regclass and p.grantee=0",(table,)).fetchone()["n"]
            assert public==0
