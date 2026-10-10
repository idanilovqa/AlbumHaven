"""History-derived Playlist provenance is typed, receipt-bound, and private."""
from copy import deepcopy
from contextlib import nullcontext
from datetime import timedelta
import json
from uuid import uuid4

import pytest

from music_app.services.auth_tokens import issue_opaque_token
from music_app.services.owned_playlists import PlaylistError, normalize_playlist_command
from music_app.services import playlist_activity_sources as activity
from music_app.services import playlist_creation_sources_postgres as sources
from tests.py.owned_playlist_testing import Connection, Step, context, NOW, PLAYLIST, item_row, playlist_row


@pytest.fixture
def origin():
    return {"audience": "own", "subject_ref": None, "kind": "tracks", "period": "week",
            "snapshot_ref": issue_opaque_token().raw}


def exported(identity=None, *, suffix="1", **facts):
    return {"row_ref": "activity_" + suffix * 64,
            "canonical_resource": {"kind": "track", "id": identity} if identity is not None else None,
            "facts": {"title": "Captured title", "artist": "Captured artist", "album_title": "Captured album",
                      "duration_seconds": 123, "availability": "missing", "source_label": "History", **facts},
            "lineage": {"snapshot_id": 1, "viewer_account_id": 41, "subject_account_id": 42,
                        "library_id": 73, "audience": "friend", "kind": "tracks", "period": "week",
                        "row_key": "track:11" if identity is not None else "listen:event:" + suffix,
                        "relationship_revision": 7}}


def inventory(identity=11, **changes):
    return {"original_local_track_id": identity, "original_album_id": 22, "availability": "local",
            "inventory_evidence": "synthetic-private-evidence", "title": "New inventory title",
            "release_year": 2001, "disc_number": 1, "track_number": 2, **changes}


@pytest.mark.parametrize("patch", [
    {"audience": "comparison"}, {"audience": []}, {"kind": "albums"}, {"kind": []},
    {"subject_ref": str(uuid4())}, {"snapshot_ref": None}, {"snapshot_ref": "/private/file"},
    {"period": "tomorrow"}, {"rows": []}, {"account_id": 42},
])
def test_activity_origin_cannot_supply_rows_scope_or_nontrack_kind(origin, patch):
    with pytest.raises(PlaylistError, match="invalid_command"):
        activity.normalize_activity_origin({**origin, **patch})


def test_activity_origin_requires_exact_authenticated_descriptor(origin):
    assert activity.normalize_activity_origin(origin) == origin
    friend = {**origin, "audience": "friend", "subject_ref": str(uuid4())}
    assert activity.normalize_activity_origin(friend) == friend
    for invalid in (None, [], {key: value for key, value in origin.items() if key != "period"},
                    {**friend, "subject_ref": "Friend name"}):
        with pytest.raises(PlaylistError):
            activity.normalize_activity_origin(invalid)


def test_unresolved_history_occurrences_remain_separate_without_fake_inventory(monkeypatch):
    calls = []
    monkeypatch.setattr(sources, "inventory_rows", lambda *args, **kwargs: calls.append((args, kwargs)) or {})
    entries = [exported(suffix="1"), exported(suffix="2")]
    result = activity._rows(object(), context(), entries, config={}, constraints=None)
    assert len(result) == 2
    assert [row["source_row_ref"] for row in result] == [row["row_ref"] for row in entries]
    assert all(row["original_local_track_id"] is None and row["availability"] == "unresolved" for row in result)
    assert calls[0][0][2] == [] and calls[0][1]["lock"] is True


def test_known_duplicate_identity_rejects_before_inventory_lookup(monkeypatch):
    monkeypatch.setattr(sources, "inventory_rows", lambda *args, **kwargs: pytest.fail("Duplicate reached inventory"))
    with pytest.raises(PlaylistError, match="duplicate_identity"):
        activity._rows(object(), context(), [exported(11), exported(11, suffix="2")], config={}, constraints=None)


def test_history_cannot_manufacture_missing_or_expose_private_source_fields(monkeypatch):
    monkeypatch.setattr(sources, "inventory_rows", lambda *args, **kwargs: {11: inventory()})
    entry = exported(11, private_path="/private/music.flac", listen_count=987, rating=5, love_tier="obsessed")
    row = activity._rows(object(), context(), [entry], config={}, constraints=None)[0]
    assert row["availability"] == "local"
    assert row["title"] == "Captured title"
    assert not {"private_path", "listen_count", "rating", "love_tier"}.intersection(row)
    projected = sources.project_entry({"library_id": 73, "source_kind": "activity"},
                                     {**row, "ref": str(uuid4()), "selection_ref": str(uuid4())})
    assert projected["source_row_ref"] == entry["row_ref"]
    assert not {"source_lineage", "inventory_evidence", "evidence_digest",
                "private_path", "listen_count", "rating", "love_tier"}.intersection(projected)
    assert projected["canonical_track_ref"] is None
    assert projected["inventory_track_ref"] == "inventory-track:73:11"


def test_lost_known_inventory_identity_rejects_the_entire_capture(monkeypatch):
    monkeypatch.setattr(sources, "inventory_rows", lambda *args, **kwargs: {})
    with pytest.raises(PlaylistError, match="source_changed"):
        activity._rows(object(), context(), [exported(), exported(11, suffix="2")], config={}, constraints=None)


def test_capture_persists_safe_originals_and_distinct_unresolved_receipts(monkeypatch, origin):
    entries = [exported(suffix="1", private_path="/private/music.flac", listen_count=321), exported(suffix="2")]
    monkeypatch.setattr(activity, "_export", lambda *args, **kwargs: entries)
    monkeypatch.setattr(sources, "inventory_rows", lambda *args, **kwargs: {})
    connection = Connection([Step("insert into app.playlist_creation_entries")])
    source = {"ref": str(uuid4())}
    captured = activity.capture(connection, context(), source, origin,
                                [row["row_ref"] for row in entries], config={}, constraints=None)
    assert len({row["selection_ref"] for row in captured}) == 2
    assert len({row["ref"] for row in captured}) == 2
    payload = json.loads(connection.operations[0][1][0])
    assert all(row["original_local_track_id"] is None and row["availability"] == "unresolved" for row in payload)
    assert all(not {"inventory_evidence", "private_path", "listen_count", "rating", "love_tier"}.intersection(row) for row in payload)
    assert "/private/music.flac" not in json.dumps(payload)
    connection.done()


def selected_setup(monkeypatch, origin):
    entry = exported(11)
    monkeypatch.setattr(sources, "inventory_rows", lambda *args, **kwargs: {11: inventory()})
    row = activity._rows(object(), context(), [entry], config={}, constraints=None)[0]
    row["ref"] = str(uuid4())
    source = {"ref": str(uuid4()), "origin_descriptor": {"activity": origin, "entry_order": [row["ref"]]}}
    connection = Connection([Step("from app.playlist_creation_entries", [row])])
    return entry, row, source, connection


@pytest.mark.parametrize("change", ["facts", "lineage", "inventory"])
def test_save_revalidates_history_facts_lineage_and_current_inventory(monkeypatch, origin, change):
    entry, row, source, connection = selected_setup(monkeypatch, origin)
    changed = deepcopy(entry)
    if change == "facts":
        changed["facts"]["title"] = "Changed title"
    elif change == "lineage":
        changed["lineage"]["relationship_revision"] += 1
    else:
        monkeypatch.setattr(sources, "inventory_rows", lambda *args, **kwargs: {11: inventory(availability="unresolved")})
    monkeypatch.setattr(activity, "_export", lambda *args, **kwargs: [changed])
    with pytest.raises(PlaylistError, match="source_changed"):
        activity.selected(connection, context(), source, [row["ref"]], config={}, constraints=None)
    assert not connection.writes
    connection.done()


def test_empty_create_still_rechecks_history_authority_without_materializing_rows(monkeypatch, origin):
    entry, _row, source, connection = selected_setup(monkeypatch, origin)
    calls = []

    def revalidate(*args, **kwargs):
        calls.append(args[3])
        return [entry]

    monkeypatch.setattr(activity, "_export", revalidate)
    assert activity.selected(connection, context(), source, [], config={}, constraints=None) == []
    assert calls == [[entry["row_ref"]]]
    connection.done()


def test_revoked_activity_authority_aborts_before_receipt_insert(monkeypatch, origin):
    def denied(*args, **kwargs):
        raise PlaylistError("source_unavailable", 403)

    monkeypatch.setattr(activity, "_export", denied)
    connection = Connection()
    with pytest.raises(PlaylistError, match="source_unavailable"):
        activity.capture(connection, context(), {"ref": str(uuid4())}, origin,
                         [exported()["row_ref"]], config={}, constraints=None)
    assert not connection.operations


def test_friend_history_permission_cannot_disclose_browse_denied_inventory(monkeypatch, origin):
    from music_app.services import playlist_complete_sources as complete
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    connection = Connection()
    owner = MissingOwner(connection, denied_tracks=(11,))
    friend_origin = {**origin, "audience": "friend", "subject_ref": str(uuid4())}
    entry = exported(11)
    lookup = Connection([Step("from app.social_profiles p", [{"account_id": 42}],
        (73, 8, 41, friend_origin["subject_ref"]), clauses=(
            "target.library_id=%s", "session.revoked_at is null", "session.idle_expires_at>clock_timestamp()",
            "session.absolute_expires_at>clock_timestamp()"))])
    owner._url = "synthetic:scoped-lock-key"
    owner._connect = lambda url: lookup if url == owner._url else pytest.fail("Unexpected database")
    monkeypatch.setattr(activity, "_export", lambda *args, **kwargs: [entry])
    monkeypatch.setattr(complete, "_header", lambda *args, **kwargs: {"ref": str(uuid4())})
    monkeypatch.setattr(sources, "inventory_rows", lambda *args, **kwargs: pytest.fail("Browse-denied inventory was read"))

    def constraints(ctx):
        denied = (ctx.action == "library.browse.read" and ctx.resource is not None
                  and ctx.resource.resource_kind == "track" and ctx.resource.resource_ref == "11")
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)

    with pytest.raises(PlaylistError, match="source_unavailable"):
        complete.CompletePlaylistSources(playlists=owner).from_activity(
            context(), friend_origin, [entry["row_ref"]], constraints=constraints)
    assert not connection.operations
    assert not lookup.writes
    lookup.done()


class MissingOwner:
    _config = {"synthetic": True}
    _clock = staticmethod(lambda: NOW)

    def __init__(self, connection, *, denied_tracks=(), denied_albums=()):
        self.connection = connection
        self.denied_tracks = set(denied_tracks)
        self.denied_albums = set(denied_albums)

    def _authorized(self, ctx, constraints, *, target_account_id=None):
        assert target_account_id in (None, 42)
        return nullcontext((self.connection, ctx, NOW))

    def _playlist(self, connection, ctx, ref):
        assert connection is self.connection and ref == PLAYLIST
        return playlist_row()

    def _require(self, *args):
        pass

    def _resource_allowed(self, ctx, action, resource, constraints):
        denied = self.denied_tracks if resource.resource_kind == "track" else self.denied_albums
        return int(resource.resource_ref) not in denied

    def _scope(self, ctx):
        return {"account_id": ctx.actor.account_id, "library_id": ctx.library_id}


def missing_command(*, refs=None, **changes):
    return normalize_playlist_command("create", {
        "mode": "missing", "source_protocol": "missing_playlist_selection_v1",
        "source": {"kind": "playlist", "ref": PLAYLIST, "revision": "7"},
        "title": "Missing copy", "entry_refs": refs if refs is not None else [str(uuid4())],
        "request_key": str(uuid4()), **changes,
    })


@pytest.mark.parametrize("changes", [
    {"mode": "ordinary"}, {"entry_refs": []},
    {"source": {"kind": "playlist", "ref": PLAYLIST, "revision": str(uuid4())}},
    {"source": {"kind": "playlist", "ref": PLAYLIST, "revision": 7}},
    {"source": {"kind": "playlist", "ref": PLAYLIST, "revision": "07"}},
    {"source": {"kind": "activity", "ref": PLAYLIST, "revision": "7"}},
])
def test_missing_save_requires_explicit_missing_protocol_and_decimal_source_revision(changes):
    with pytest.raises(PlaylistError, match="invalid_command"):
        missing_command(**changes)


def test_missing_rows_exclude_unresolved_local_denied_and_deleted_tracks(monkeypatch):
    from music_app.services import playlist_missing_sources as missing
    items = [item_row(ref=str(uuid4()), track_id=identity, position=position)
             for position, identity in enumerate((11, 12, 13, 14, None), 1)]
    connection = Connection([Step("from app.playlist_items", items)])
    owner = MissingOwner(connection, denied_tracks=(14,))
    calls = []

    def current(_connection, library, ids, **kwargs):
        calls.append((library, ids, kwargs))
        return {11: inventory(11, original_album_id=501, availability="missing"),
                12: inventory(12, availability="unresolved"), 13: inventory(13, availability="local")}

    monkeypatch.setattr(sources, "inventory_rows", current)
    result = missing._missing_rows(owner, connection, context(), playlist_row(), constraints=None)
    assert calls == [(73, [11, 12, 13], {"lock": True, "config": owner._config})]
    assert len(result) == 1 and result[0]["original_local_track_id"] == 11
    assert result[0]["title"] == "Original title"
    assert result[0]["source_row_ref"] == str(items[0]["ref"])
    assert result[0]["original_album_id"] == 501
    assert not connection.writes
    connection.done()


def test_changed_parent_identity_is_not_claimed_from_old_originals(monkeypatch):
    from music_app.services import playlist_missing_sources as missing
    connection = Connection([Step("from app.playlist_items", [item_row(track_id=11)])])
    monkeypatch.setattr(sources, "inventory_rows", lambda *args, **kwargs: {
        11: inventory(11, original_album_id=999, availability="missing")})
    rows = missing._missing_rows(MissingOwner(connection), connection, context(), playlist_row(), constraints=None)
    assert rows[0]["original_album_id"] is None
    assert rows[0]["album_title"] == "Original album"
    connection.done()


def test_inspect_creates_only_temporary_receipts_with_readable_retained_parents(monkeypatch):
    from music_app.services import playlist_missing_sources as missing
    from music_app.services import playlist_complete_sources as complete
    connection = Connection([Step("insert into app.playlist_creation_entries"),
                             Step("update app.playlist_creation_sources")])
    owner = MissingOwner(connection, denied_albums=(23,))
    rows = [
        {**inventory(11, availability="missing"), "source_row_ref": str(uuid4()), "source_lineage": {}, "evidence_digest": "one"},
        {**inventory(12, original_album_id=23, availability="missing"), "source_row_ref": str(uuid4()), "source_lineage": {}, "evidence_digest": "two"},
        {**inventory(13, original_album_id=None, availability="missing"), "source_row_ref": str(uuid4()), "source_lineage": {}, "evidence_digest": "three"},
    ]
    header = {"ref": str(uuid4()), "revision": str(uuid4()), "library_id": 73,
              "protocol": missing.MISSING_PROTOCOL, "source_kind": "playlist", "expires_at": NOW + timedelta(minutes=30),
              "origin_descriptor":{"playlist_ref":PLAYLIST,"playlist_revision":"7"}}
    monkeypatch.setattr(missing, "_missing_rows", lambda *args, **kwargs: rows)
    monkeypatch.setattr(missing, "lock_current_actor_session", lambda *args, **kwargs: NOW)
    monkeypatch.setattr(complete, "_header", lambda *args, **kwargs: header)
    data = missing.inspect(owner, context(), PLAYLIST, "7")["data"]
    assert data["mode"] == "missing" and data["entries_complete"] is True
    assert data["source"] == {"kind": "playlist", "ref": PLAYLIST, "revision": "7"}
    assert data["capture_ref"] == header["ref"]
    assert [row["inventory_track_ref"] for row in data["entries"]] == [
        "inventory-track:73:11", "inventory-track:73:12", "inventory-track:73:13"]
    assert len(data["retained_parent_albums"]) == 1
    parent = data["retained_parent_albums"][0]
    assert parent["album_ref"] == "inventory-album:73:22" and parent["completeness"] == "incomplete"
    assert parent["entry_refs"] == [data["entries"][0]["entry_ref"]]
    assert all("source_lineage" not in row and "inventory_evidence" not in row for row in data["entries"])
    assert not any(sql.startswith(("insert into app.playlists ", "insert into app.playlist_items ",
                                   "update app.playlists ", "update app.playlist_items ")) for sql, _ in connection.writes)
    connection.done()


def test_inspect_without_confirmed_missing_rows_creates_no_receipt(monkeypatch):
    from music_app.services import playlist_missing_sources as missing
    connection = Connection()
    monkeypatch.setattr(missing, "_missing_rows", lambda *args, **kwargs: [])
    with pytest.raises(PlaylistError, match="no_confirmed_missing_tracks"):
        missing.inspect(MissingOwner(connection), context(), PLAYLIST, "7")
    assert not connection.operations


@pytest.mark.parametrize("change, error", [
    ({"playlist_ref": str(uuid4())}, "source_changed"),
    ({"playlist_revision": "8"}, "source_changed"),
    ({"expired": True}, "source_expired"),
])
def test_missing_save_rejects_changed_or_expired_origin(change, error):
    from music_app.services import playlist_missing_sources as missing
    command = missing_command()
    origin = {"playlist_ref": PLAYLIST, "playlist_revision": "7", **{k: v for k, v in change.items() if k != "expired"}}
    row = {"ref": str(uuid4()), "origin_descriptor": origin,
           "expires_at": NOW if change.get("expired") else NOW + timedelta(minutes=30)}
    connection = Connection([Step("from app.playlist_creation_sources s", [row],
        (command.data["entry_refs"][0], 41, 8, 73), clauses=(
            "s.actor_account_id=%s and s.session_id=%s and s.library_id=%s",
            "s.protocol='missing_playlist_selection_v1' and s.source_kind='playlist'", "for share of s",
        ))])
    with pytest.raises(PlaylistError, match=error):
        missing.source_for_command(connection, context(), command, NOW)
    assert not connection.writes
    connection.done()


def test_missing_save_cannot_mix_receipts_from_different_captures():
    from music_app.services import playlist_missing_sources as missing
    saved = {"ref": str(uuid4()), "source_row_ref": str(uuid4())}
    source = {"ref": str(uuid4()), "origin_descriptor": {"playlist_ref": PLAYLIST, "playlist_revision": "7"}}
    refs = [saved["ref"], str(uuid4())]
    connection = Connection([Step("from app.playlist_creation_entries", [saved], (source["ref"], refs))])
    with pytest.raises(PlaylistError, match="source_unavailable"):
        missing.selected(MissingOwner(connection), connection, context(), source, refs, constraints=None)
    assert not connection.writes
    connection.done()


@pytest.mark.parametrize("changed", ["present", "lineage", "evidence"])
def test_missing_save_rechecks_selected_current_missing_evidence(monkeypatch, changed):
    from music_app.services import playlist_missing_sources as missing
    saved = {"ref": str(uuid4()), "source_row_ref": str(uuid4()),
             "evidence_digest": "original", "source_lineage": {"playlist_revision": "7"}}
    source = {"ref": str(uuid4()), "origin_descriptor": {"playlist_ref": PLAYLIST, "playlist_revision": "7"}}
    current = deepcopy(saved)
    if changed == "lineage":
        current["source_lineage"]["playlist_revision"] = "8"
    if changed == "evidence":
        current["evidence_digest"] = "changed"
    connection = Connection([Step("from app.playlist_creation_entries", [saved]),
                             Step("from app.playlist_local_match_receipts", [])])
    monkeypatch.setattr(missing, "_missing_rows", lambda *args, **kwargs: [] if changed == "present" else [current])
    with pytest.raises(PlaylistError, match="source_changed"):
        missing.selected(MissingOwner(connection), connection, context(), source, [saved["ref"]], constraints=None)
    assert not connection.writes
    connection.done()
