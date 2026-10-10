"""Real SQL account preference isolation and durable operation reconciliation."""
from dataclasses import replace
from uuid import uuid4
import pytest
from tests.py.test_owned_playlist_postgres_integration import db,urls
from music_app.services.playlist_preferences_postgres import PostgresPlaylistPreferencesService,normalize_preference_command
from music_app.services.owned_playlists import PlaylistError


def service(db):
    return PostgresPlaylistPreferencesService({"ALBUM_HAVEN_APP_DATABASE_URL":db.app_url})


def write(db,revision,**values):
    command=normalize_preference_command({"revision":revision,"request_key":str(uuid4()),**values})
    return service(db).execute(db.context(),command),command


def test_preference_memory_applies_across_collections_but_not_other_accounts(db):
    svc=service(db)
    assert svc.read(db.context())["preferences"]=={"remember_order_mode":True,"last_order_mode":"regular","effective_order_mode":"regular","revision":"1"}
    receipt,command=write(db,"1",last_order_mode="shuffle")
    assert receipt["changed"] is True and receipt["preferences"]["effective_order_mode"]=="shuffle"
    db.create(refs=[])
    assert svc.read(db.context())["preferences"]["last_order_mode"]=="shuffle"
    with db.connect() as con:
        other=db.member(con,db.actor(con))
    assert svc.read(db.context(other))["preferences"]["last_order_mode"]=="regular"
    assert svc.read_operation(db.context(other),command.request_key)=={"status":"unknown"}
    assert svc.execute(db.context(),command)==receipt
    assert svc.read_operation(db.context(),command.request_key)=={"status":"committed","receipt":receipt}


def test_disabling_memory_keeps_saved_choice_but_session_only_mode_cannot_persist(db):
    chosen,_=write(db,"1",last_order_mode="shuffle")
    disabled,_=write(db,chosen["preferences"]["revision"],remember_order_mode=False)
    current=disabled["preferences"]
    assert current["last_order_mode"]=="shuffle" and current["effective_order_mode"]=="regular"
    with pytest.raises(PlaylistError,match="order_memory_disabled"):
        write(db,current["revision"],last_order_mode="regular")
    assert service(db).read(db.context())["preferences"]==current
    enabled,_=write(db,current["revision"],remember_order_mode=True,last_order_mode="regular")
    assert enabled["preferences"]["effective_order_mode"]=="regular"


def test_preference_noop_revision_conflict_and_different_payload_key_conflict(db):
    receipt,command=write(db,"1",remember_order_mode=True)
    assert receipt["changed"] is False and receipt["preferences"]["revision"]=="1"
    write(db,"1",last_order_mode="shuffle")
    with pytest.raises(PlaylistError,match="revision_conflict"):
        write(db,"1",remember_order_mode=False)
    different=normalize_preference_command({"revision":"1","request_key":command.request_key,"last_order_mode":"shuffle"})
    with pytest.raises(PlaylistError,match="idempotency_key_reused"):
        service(db).execute(db.context(),different)


def test_preferences_need_current_account_session_but_no_library_capabilities(db):
    svc=service(db)
    with db.connect() as con:
        con.execute("delete from app.capabilities where account_id=%s",(db.owner.account_id,))
        con.execute("delete from library.library_memberships where account_id=%s and library_id=%s",(db.owner.account_id,db.library))
    actor=replace(db.owner,capability_grants=(),library_relationships=(),current_library_id=None)
    ctx=replace(db.context(actor),library_id=None)
    command=normalize_preference_command({"revision":"1","request_key":str(uuid4()),"last_order_mode":"shuffle"})
    assert svc.execute(ctx,command)["changed"] is True
    with db.connect() as con:
        con.execute("update app.account_sessions set revoked_at=now() where id=%s",(db.owner.session_id,))
    with pytest.raises(PlaylistError,match="forbidden"):
        svc.read(ctx)


def test_preference_operation_keys_do_not_reappear_in_another_session(db):
    svc=service(db)
    receipt,command=write(db,"1",last_order_mode="shuffle")
    from datetime import timedelta
    import hashlib
    with db.connect() as con:
        session=con.execute("""insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,%s,%s,%s,%s,%s) returning id""",(db.owner.account_id,hashlib.sha256(uuid4().bytes).digest(),
            db.now,db.now,db.now,db.now+timedelta(hours=1),db.now+timedelta(days=1))).fetchone()["id"]
    other=db.context(replace(db.owner,session_id=session))
    assert svc.read_operation(other,command.request_key)=={"status":"unknown"}
    with pytest.raises(PlaylistError,match="operation_unavailable"):
        svc.execute(other,command)
    assert svc.read(db.context())["preferences"]==receipt["preferences"]
