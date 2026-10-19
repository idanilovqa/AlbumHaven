"""Live SQL retention, Reset ordering and actual source/account isolation."""
from datetime import timedelta
from uuid import uuid4
import pytest
from tests.py.test_owned_playlist_postgres_integration import db, urls
from music_app.services.owned_playlists import PlaylistError
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.playlist_filter_preferences import DEFAULT_FILTERS, PlaylistFilterPreferences, filter_command


def setup(db):
    ref = db.create(refs=[])[0]["playlist_id"]
    now = [db.now]
    with db.connect() as con:
        con.execute("update app.account_sessions set idle_expires_at=%s,absolute_expires_at=%s where id=%s",
            (db.now + timedelta(days=30), db.now + timedelta(days=30), db.owner.session_id))
    owner = PostgresOwnedPlaylistsService({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url}, clock=lambda: now[0])
    return PlaylistFilterPreferences(owner), ref, now


def command(ref, revision="1", filters=None, key=None):
    return filter_command(ref, dict(revision=revision, request_key=key or str(uuid4()), filters=filters))


def test_seven_days_from_explicit_change_reads_noops_and_replay_do_not_renew(db):
    service, ref, now = setup(db)
    state = {**DEFAULT_FILTERS, "query": "Track"}
    change = command(ref, filters=state)
    ack = service.execute(db.context(), change)
    first = service.read(db.context(), ref)
    assert first["filters"] == state and first["revision"] == "2"
    now[0] += timedelta(days=6)
    assert service.read(db.context(), ref) == {**first, "server_time": now[0].isoformat()}
    assert service.execute(db.context(), change) == ack
    noop = service.execute(db.context(), command(ref, "2", state))
    assert noop["changed"] is False and noop["revision"] == "2"
    assert service.read(db.context(), ref) == {**first, "server_time": now[0].isoformat()}
    now[0] += timedelta(days=1)
    expired = service.read(db.context(), ref)
    assert expired == {"playlist_ref": ref, "revision": "2", "filters": None, "expires_at": None,
        "server_time": now[0].isoformat()}
    assert service.execute(db.context(), change) == ack
    assert service.read(db.context(), ref) == expired
    renewed = service.execute(db.context(), command(ref, "2", state))
    assert renewed["revision"] == "3"
    assert service.read(db.context(), ref)["filters"] == state


def test_reset_tombstone_blocks_old_writes_even_for_previously_empty_state(db):
    service, ref, _ = setup(db)
    old = command(ref, filters={**DEFAULT_FILTERS, "query": "stale"})
    reset = command(ref)
    ack = service.execute(db.context(), reset)
    assert ack["revision"] == "2" and ack["changed"] is True
    assert service.execute(db.context(), reset) == ack
    with pytest.raises(PlaylistError, match="revision_conflict"):
        service.execute(db.context(), old)
    state = service.read(db.context(), ref)
    assert state["filters"] is None and state["expires_at"] is None


def test_explicit_change_reanchors_and_reset_clears_physical_values(db):
    service, ref, now = setup(db)
    service.execute(db.context(), command(ref, filters={**DEFAULT_FILTERS, "query": "first"}))
    now[0] += timedelta(days=6)
    service.execute(db.context(), command(ref, "2", {**DEFAULT_FILTERS, "query": "second"}))
    now[0] += timedelta(days=2)
    assert service.read(db.context(), ref)["filters"]["query"] == "second"
    service.execute(db.context(), command(ref, "3"))
    with db.connect() as con:
        row = con.execute("select filters,expires_at,revision from app.user_playlist_filter_preferences where account_id=%s and playlist_ref=%s",
            (db.owner.account_id, ref)).fetchone()
    assert row == {"filters": None, "expires_at": None, "revision": 4}


def test_account_and_playlist_isolation_and_revoked_source_replay(db):
    service, ref, _ = setup(db)
    other_ref = db.create(refs=[])[0]["playlist_id"]
    change = command(ref, filters={**DEFAULT_FILTERS, "style": "Rock"})
    service.execute(db.context(), change)
    assert service.read(db.context(), other_ref)["filters"] is None
    with db.connect() as con:
        other = db.member(con, db.actor(con))
        con.execute("update app.playlists set visibility='server_shared' where ref=%s", (ref,))
    assert service.read(db.context(other), ref)["filters"] is None
    peer_change = command(ref, filters={**DEFAULT_FILTERS, "query": "peer"})
    service.execute(db.context(other), peer_change)
    assert service.read(db.context(), ref)["filters"]["style"] == "Rock"
    with db.connect() as con:
        con.execute("update app.playlists set visibility='private' where ref=%s", (ref,))
    for action in (lambda: service.read(db.context(other), ref),
                   lambda: service.execute(db.context(other), peer_change)):
        with pytest.raises(PlaylistError, match="playlist_unavailable"):
            action()


def test_expired_session_and_request_key_reuse_fail_closed(db):
    service, ref, _ = setup(db)
    change = command(ref, filters={**DEFAULT_FILTERS, "query": "first"})
    service.execute(db.context(), change)
    with pytest.raises(PlaylistError, match="idempotency_key_reused"):
        service.execute(db.context(), command(ref, filters=None, key=change.request_key))
    with db.connect() as con:
        con.execute("update app.account_sessions set revoked_at=now() where id=%s", (db.owner.session_id,))
    with pytest.raises(PlaylistError, match="forbidden"):
        service.read(db.context(), ref)
    with pytest.raises(PlaylistError, match="forbidden"):
        service.execute(db.context(), change)


def test_expiry_crossed_during_final_authorization_never_discloses_values(db, monkeypatch):
    service, ref, now = setup(db)
    service.execute(db.context(), command(ref, filters={**DEFAULT_FILTERS, "query": "private"}))
    now[0] += timedelta(days=7) - timedelta(seconds=1)
    original = service._require
    calls = [0]
    def require(context, action, constraints):
        original(context, action, constraints)
        calls[0] += 1
        if calls[0] == 3:  # Entry, read fence, then context exit fence.
            now[0] += timedelta(seconds=1)
    monkeypatch.setattr(service, "_require", require)
    result = service.read(db.context(), ref)
    assert calls[0] == 3
    assert result["filters"] is None and result["expires_at"] is None


def test_preference_receipts_never_retain_filter_values(db):
    service, ref, _ = setup(db)
    change = command(ref, filters={**DEFAULT_FILTERS, "query": "private query"})
    ack = service.execute(db.context(), change)
    assert "filters" not in ack and "expires_at" not in ack
    with db.connect() as con:
        receipt = con.execute("select receipt from app.playlist_preference_operations where account_id=%s and request_key=%s",
            (db.owner.account_id, change.request_key)).fetchone()["receipt"]
    assert receipt == ack and "private query" not in str(receipt)
