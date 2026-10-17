"""Library Mix security, receipts and recomputation on real PostgreSQL.

These are repository integration tests, not replacements for functional E2E.
Each test owns one generated library and account set. Missing prerequisites fail.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
from threading import Event
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
import pytest

from library_mix_postgres_support import ACTIONS, MEDIA, mix_db, mix_urls
from music_app.services import library_mix_postgres as mixes
from music_app.services.current_actor import CapabilityGrant
from music_app.services.listen_history_postgres import read_scoped_track_play_counts
from music_app.services.owned_playlists import PlaylistError, normalize_playlist_command
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.policy_evaluator import PolicyEvaluationConstraints


def ids(source):
    return [int(row["inventory_track_ref"].rsplit(":", 1)[1]) for row in source["entries"]]


def item_ids(items):
    return [row["local_track_id"] for row in items]


def read_source(db, source, *, actor=None, constraints=None):
    return mixes.read_capture(db.service, db.context(actor), source["source"]["ref"],
        source["source"]["revision"], constraints=constraints)["data"]


def grant_media(db):
    with db.connect() as con:
        con.execute("""insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
            values(%s,%s,'library',%s)""", (db.owner.account_id, MEDIA, db.library))
    db.owner = replace(db.owner, capability_grants=(
        *db.owner.capability_grants, CapabilityGrant(MEDIA, "library", db.library)))


def test_capture_reads_whole_library_without_search_and_saves_exact_snapshot(mix_db):
    db = mix_db
    source = db.capture(auto=False)
    assert source["source_protocol"] == "library_mix_selection_v1"
    assert source["source"]["kind"] == "library" and source["entries_complete"] is True
    assert source["popularity_refresh_status"] == "idle"
    assert source["popularity_refresh_error"] == "not_configured"
    assert ids(source) == [db.tracks[i] for i in (0, 1, 3, 4)]
    assert [row["popularity_count"] for row in source["entries"]] == [300, 200, 90, 80]
    assert all(row["play_count"] == 0 for row in source["entries"])
    assert source["library_mix"] == {
        "version": 1, "source": "whole_library", "provider": "lastfm",
        "metric": "overall_scrobbles", "selection_basis": "per_album",
        "songs_per_group": 2, "auto_update": False, "playback_order": "regular"}
    assert source["coverage"] == {"selected_count": 4, "excluded_count": 0,
                                  "reasons": {}, "diagnostics_truncated": False}
    # A refreshed global cache must not reinterpret the captured receipt.
    with db.connect() as con:
        db.observe(con, db.tracks[2], 999)
    reread = read_source(db, source)
    assert reread["entries"] == source["entries"]
    receipt, _, _ = db.save(source)
    playlist, items, recipe = db.state(receipt["playlist_id"])
    assert item_ids(items) == ids(source)
    assert [str(row["source_entry_ref"]) for row in items] == [row["entry_ref"] for row in source["entries"]]
    assert all(row["source_protocol"] == "library_mix_selection_v1" for row in items)
    assert playlist["revision"] == 1 and recipe["auto_update"] is False
    assert db.total("playlist_operations") == db.total("playlist_library_mixes") == 1


@pytest.mark.parametrize("tamper", ["subset", "reverse", "foreign", "protocol", "revision"])
def test_save_rejects_incomplete_reordered_mixed_or_reinterpreted_receipts(mix_db, tamper):
    db = mix_db
    source = db.capture()
    other = db.capture()
    command = db.create_command(source)
    if tamper == "subset":
        command.data["entry_refs"].pop()
    elif tamper == "reverse":
        command.data["entry_refs"].reverse()
    elif tamper == "foreign":
        command.data["entry_refs"][0] = other["entries"][0]["entry_ref"]
    elif tamper == "protocol":
        command.data["source_protocol"] = "complete_inventory_selection_v1"
    else:
        command.data["source"]["revision"] = str(uuid4())
    with pytest.raises(PlaylistError, match="source_changed"):
        db.service.execute(db.context(), command)
    assert db.total("playlists") == db.total("playlist_operations") == db.total("playlist_library_mixes") == 0


@pytest.mark.parametrize("action", ["read", "save", "native"])
def test_source_is_bound_to_actor_and_session(mix_db, action):
    db = mix_db
    source = db.capture()
    with db.connect() as con:
        other = db.member(con, actions=(*ACTIONS, MEDIA))
    calls = {
        "read": lambda: read_source(db, source, actor=other),
        "save": lambda: db.service.execute(db.context(other), db.create_command(source)),
        "native": lambda: db.queue(source, actor=other),
    }
    with pytest.raises(PlaylistError, match="source_unavailable"):
        calls[action]()
    assert db.total("playlists") == db.total("playlist_operations") == 0


def test_same_account_new_session_cannot_reuse_source_or_operation_receipt(mix_db):
    import hashlib
    db = mix_db
    receipt, command, source = db.save()
    with db.connect() as con:
        session = con.execute("""insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,%s,%s,%s,%s,%s) returning id""", (
                db.owner.account_id, hashlib.sha256(uuid4().bytes).digest(), db.now, db.now, db.now,
                db.now + timedelta(hours=1), db.now + timedelta(days=1))).fetchone()["id"]
    actor = replace(db.owner, session_id=session)
    for call in (lambda: read_source(db, source, actor=actor),
                 lambda: db.service.execute(db.context(actor), db.create_command(source)),
                 lambda: db.queue(source, actor=actor)):
        with pytest.raises(PlaylistError, match="source_unavailable"):
            call()
    with pytest.raises(PlaylistError, match="operation_unavailable"):
        db.service.execute(db.context(actor), command)
    assert db.service.read_operation(db.context(actor), command.request_key) == {"status": "unknown"}
    assert db.total("playlists") == 1 and db.state(receipt["playlist_id"])[0]["revision"] == 1


@pytest.mark.parametrize("change", ["expired", "deleted", "inventory", "file", "session", "membership", "account", "browse_grant"])
def test_read_and_new_save_recheck_source_and_current_authority(mix_db, change):
    db = mix_db
    source = db.capture()
    with db.connect() as con:
        if change == "expired":
            con.execute("update app.playlist_creation_sources set expires_at=%s where ref=%s",
                        (db.clock_time, source["source"]["ref"]))
        elif change == "deleted":
            con.execute("delete from app.playlist_creation_sources where ref=%s", (source["source"]["ref"],))
        elif change == "inventory":
            con.execute("delete from library.local_tracks where id=%s", (db.tracks[0],))
        elif change == "file":
            con.execute("update library.local_track_files set content_signature='replaced' where track_id=%s", (db.tracks[0],))
        elif change == "session":
            con.execute("update app.account_sessions set revoked_at=now() where id=%s", (db.owner.session_id,))
        elif change == "membership":
            con.execute("delete from library.library_memberships where account_id=%s and library_id=%s",
                        (db.owner.account_id, db.library))
        elif change == "account":
            con.execute("update app.accounts set is_active=false,disabled_at=now() where id=%s", (db.owner.account_id,))
        else:
            con.execute("""update app.capabilities set revoked_at=now()
                where account_id=%s and capability_key='library.browse.read'""", (db.owner.account_id,))
    code = {"expired": "source_expired", "deleted": "source_unavailable",
            "inventory": "source_changed", "file": "source_changed"}.get(change, "forbidden")
    for call in (lambda: read_source(db, source), lambda: db.service.execute(db.context(), db.create_command(source))):
        with pytest.raises(PlaylistError, match=code):
            call()
    assert db.total("playlists") == db.total("playlist_operations") == 0


@pytest.mark.parametrize("retirement", ["expired", "deleted"])
def test_committed_receipt_replays_after_source_retirement_but_cannot_change_playback(mix_db, retirement):
    db = mix_db
    receipt, command, source = db.save(mix_playback_order="unplayed_first")
    with db.connect() as con:
        if retirement == "expired":
            con.execute("update app.playlist_creation_sources set expires_at=%s where ref=%s",
                        (db.clock_time, source["source"]["ref"]))
        else:
            con.execute("delete from app.playlist_creation_sources where ref=%s", (source["source"]["ref"],))
    assert db.service.execute(db.context(), command) == receipt
    assert db.service.read_operation(db.context(), command.request_key) == {"status": "committed", "receipt": receipt}
    changed = deepcopy(command)
    changed.data["mix_playback_order"] = "shuffle"
    with pytest.raises(PlaylistError, match="idempotency_key_reused"):
        db.service.execute(db.context(), changed)
    with pytest.raises(PlaylistError, match="source_expired" if retirement == "expired" else "source_unavailable"):
        db.service.execute(db.context(), db.create_command(source))
    assert db.state(receipt["playlist_id"])[2]["playback_order"] == "unplayed_first"
    assert db.total("playlists") == db.total("playlist_library_mixes") == db.total("playlist_operations") == 1


def test_parallel_same_request_key_commits_one_recipe_and_one_item_set(mix_db):
    db = mix_db
    source = db.capture()
    command = db.create_command(source)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: db.service.execute(db.context(), command), range(2)))
    assert results[0] == results[1]
    assert db.total("playlists") == db.total("playlist_library_mixes") == db.total("playlist_operations") == 1
    assert db.total("playlist_items") == 4


def test_failed_recipe_constraint_rolls_back_new_playlist_items_and_receipt(mix_db):
    db = mix_db
    source = db.capture()
    with db.connect() as con:
        # A corrupt durable source tests the real database constraint failure
        # after parent/items inserts, rather than a fake commit acknowledgement.
        con.execute("""update app.playlist_creation_sources
            set origin_descriptor=jsonb_set(origin_descriptor,'{coverage}','[]') where ref=%s""",
            (source["source"]["ref"],))
    with pytest.raises(psycopg.errors.CheckViolation):
        db.service.execute(db.context(), db.create_command(source))
    for table in ("playlists", "playlist_items", "playlist_library_mixes", "playlist_operations"):
        assert db.total(table) == 0


def test_refresh_failure_after_real_membership_writes_rolls_back_all_changes(mix_db):
    db = mix_db
    receipt, _, _ = db.save()
    before = db.state(receipt["playlist_id"])
    with db.connect() as con:
        db.observe(con, db.tracks[2], 999)
    class FailAfterRevision:
        def __init__(self, real):
            self.real = real
        def __getattr__(self, name):
            return getattr(self.real, name)
        def execute(self, sql, params=None):
            result = self.real.execute(sql, params)
            if "update app.playlists set revision=revision+1" in sql:
                # The failure is raised by PostgreSQL itself after DELETE,
                # INSERT, reorder and parent UPDATE ran on the same connection.
                self.real.execute("select 1/0")
            return result
    @contextmanager
    def connect(url):
        with psycopg.connect(url, row_factory=dict_row) as con:
            yield FailAfterRevision(con)
    service = PostgresOwnedPlaylistsService(db.config, connect=connect, clock=lambda: db.clock_time)
    with pytest.raises(psycopg.errors.DivisionByZero):
        mixes.refresh_owned(service, db.context(), receipt["playlist_id"])
    assert db.state(receipt["playlist_id"]) == before
    assert db.total("playlist_operations") == 1


def test_saved_dynamic_recipe_refreshes_after_its_creation_source_is_deleted(mix_db):
    db = mix_db
    receipt, _, source = db.save()
    with db.connect() as con:
        con.execute("delete from app.playlist_creation_sources where ref=%s", (source["source"]["ref"],))
        db.observe(con, db.tracks[2], 900)
    detail = db.service.read(db.context(), playlist_ref=receipt["playlist_id"])["playlist_detail"]
    assert detail["library_mix"]["refresh_status"] == "current"
    assert item_ids(db.state(receipt["playlist_id"])[1]) == [db.tracks[i] for i in (2, 0, 3, 4)]


def test_dynamic_refresh_replaces_top_n_reorders_and_preserves_retained_ids(mix_db):
    db = mix_db
    receipt, _, _ = db.save()
    before = db.state(receipt["playlist_id"])
    old_ids = {row["local_track_id"]: row["ref"] for row in before[1]}
    with db.connect() as con:
        db.observe(con, db.tracks[2], 500)
        db.observe(con, db.tracks[4], 450)
    detail = db.service.read(db.context(), playlist_ref=receipt["playlist_id"])["playlist_detail"]
    after = db.state(receipt["playlist_id"])
    expected = [db.tracks[i] for i in (2, 4, 0, 3)]
    assert item_ids(after[1]) == expected
    assert len(after[1]) == 4 and db.tracks[1] not in item_ids(after[1])
    assert [row["position"] for row in after[1]] == [1, 2, 3, 4]
    for row in after[1]:
        if row["local_track_id"] in old_ids:
            assert row["ref"] == old_ids[row["local_track_id"]]
    assert after[0]["revision"] == before[0]["revision"] + 1
    assert detail["revision"] == "2"
    assert detail["library_mix"]["refresh_status"] == "current"
    assert detail["library_mix"]["coverage"]["selected_count"] == 4
    assert db.total("playlist_operations") == 1
    # A cache refresh and an owner reread with identical membership are no-ops.
    with db.connect() as con:
        db.observe(con, db.tracks[2], 501)
    db.clock_time += timedelta(seconds=1)
    db.service.read(db.context(), playlist_ref=receipt["playlist_id"])
    no_op = db.state(receipt["playlist_id"])
    assert no_op[0]["revision"] == after[0]["revision"]
    assert no_op[0]["updated_at"] == after[0]["updated_at"]
    assert no_op[1] == after[1]
    assert no_op[2]["last_evaluated_at"] > after[2]["last_evaluated_at"]


def test_owner_refresh_removes_deleted_inventory_then_recomputes_quota(mix_db):
    db = mix_db
    receipt, _, _ = db.save()
    with db.connect() as con:
        con.execute("delete from library.local_tracks where id=%s", (db.tracks[0],))
    before = db.state(receipt["playlist_id"])
    retained = {row["local_track_id"]: row["ref"] for row in before[1] if row["local_track_id"] is not None}
    db.service.read(db.context(), playlist_ref=receipt["playlist_id"])
    after = db.state(receipt["playlist_id"])
    assert item_ids(after[1]) == [db.tracks[i] for i in (1, 2, 3, 4)]
    assert len(after[1]) == 4 and all(row["local_track_id"] is not None for row in after[1])
    assert all(row["ref"] == retained[row["local_track_id"]] for row in after[1]
               if row["local_track_id"] in retained)
    assert after[0]["revision"] == 2


@pytest.mark.parametrize("state", ["private", "shared", "editor"])
def test_only_owner_detail_refreshes_membership_and_directory_never_refreshes(mix_db, state):
    db = mix_db
    receipt, _, _ = db.save()
    with db.connect() as con:
        other = db.member(con)
    if state == "shared":
        receipt = db.mutate(receipt, "visibility", visibility="server_shared")
    elif state == "editor":
        receipt = db.mutate(receipt, "grant_editor", account_id=other.account_id, role="editor")
    before = db.state(receipt["playlist_id"])
    with db.connect() as con:
        db.observe(con, db.tracks[2], 900)
    db.service.read(db.context())
    assert db.state(receipt["playlist_id"])[1] == before[1]
    if state == "private":
        with pytest.raises(PlaylistError, match="playlist_unavailable"):
            db.service.read(db.context(other), playlist_ref=receipt["playlist_id"])
    else:
        detail = db.service.read(db.context(other), playlist_ref=receipt["playlist_id"])["playlist_detail"]
        assert detail["library_mix"]["refresh_status"] == "owner_refresh_required"
        assert detail["allowed_actions"]["can_reorder"] is False
        assert detail["allowed_actions"]["can_add"] is False
        assert detail["allowed_actions"]["can_remove"] is False
    assert db.state(receipt["playlist_id"]) == before
    db.service.read(db.context(), playlist_ref=receipt["playlist_id"])
    assert item_ids(db.state(receipt["playlist_id"])[1]) == [db.tracks[i] for i in (2, 0, 3, 4)]


@pytest.mark.parametrize("action", ["add", "remove", "reorder", "save_order"])
def test_auto_update_locks_every_membership_entry_point_including_noop_order(mix_db, action):
    db = mix_db
    receipt, _, _ = db.save()
    before = db.state(receipt["playlist_id"])
    refs = [str(row["ref"]) for row in before[1]]
    data = {
        "add": {"track_refs": [f"inventory-track:{db.library}:{db.tracks[2]}"]},
        "remove": {"item_refs": [refs[0]]},
        "reorder": {"item_order": list(reversed(refs))},
        "save_order": {"title": "Not committed", "item_order": refs},
    }[action]
    with pytest.raises(PlaylistError, match="library_mix_membership_locked"):
        db.mutate(receipt, "save" if action == "save_order" else action, **data)
    assert db.state(receipt["playlist_id"]) == before
    assert db.total("playlist_operations") == 1


def test_auto_metadata_sharing_sort_and_delete_keep_existing_revision_contract(mix_db):
    db = mix_db
    receipt, _, _ = db.save()
    original = db.state(receipt["playlist_id"])
    receipt = db.mutate(receipt, "save", title="Renamed Mix", description="Metadata only")
    assert receipt["revision"] == "2"
    noop = db.mutate(receipt, "save", title="Renamed Mix")
    assert noop["changed"] is False and noop["revision"] == "2"
    receipt = db.mutate(noop, "default_sort", sort={"key": "play_count", "direction": "asc"})
    receipt = db.mutate(receipt, "visibility", visibility="server_shared")
    assert db.state(receipt["playlist_id"])[1] == original[1]
    deleted = db.mutate(receipt, "delete")
    assert deleted["deleted"] is True
    with pytest.raises(PlaylistError, match="playlist_unavailable"):
        db.service.read(db.context(), playlist_ref=receipt["playlist_id"])
    assert db.state(receipt["playlist_id"])[2] is not None


def test_static_mix_membership_remains_editable_and_copy_does_not_keep_recipe(mix_db):
    db = mix_db
    receipt, _, _ = db.save(auto=False)
    before = db.state(receipt["playlist_id"])
    order = [str(row["ref"]) for row in reversed(before[1])]
    receipt = db.mutate(receipt, "reorder", item_order=order)
    assert [str(row["ref"]) for row in db.state(receipt["playlist_id"])[1]] == order
    copied = db.mutate(receipt, "copy", title="Static copy")
    assert copied["playlist_id"] != receipt["playlist_id"]
    assert db.state(copied["playlist_id"])[2] is None
    assert item_ids(db.state(copied["playlist_id"])[1]) == item_ids(db.state(receipt["playlist_id"])[1])


def test_nonplayable_member_can_capture_and_save_but_cannot_obtain_native_target(mix_db):
    db = mix_db
    source = db.capture()
    assert source["allowed_actions"]["can_use_for_playlist"] is True
    assert source["allowed_actions"]["can_play"] is False
    assert all(entry["allowed_actions"]["can_play"] is False for entry in source["entries"])
    db.save(source)
    with pytest.raises(PlaylistError, match="item_unavailable"):
        db.queue(source)
    assert db.total("playlists") == db.total("playlist_library_mixes") == 1


def test_temporary_native_queue_uses_current_media_grants_and_full_receipt_set(mix_db):
    db = mix_db
    source = db.capture()
    grant_media(db)
    refs = [row["entry_ref"] for row in reversed(source["entries"])]
    result = db.queue(source, refs=refs)
    assert result["starting_item_ref"] == refs[0]
    assert [row["playlist_item_id"] for row in result["tracks"]] == refs
    assert all(row["play_count"] == 0 for row in result["tracks"])
    assert all(row["native_target"]["playlist_item_id"] == row["playlist_item_id"] for row in result["tracks"])
    assert result["unavailable_item_refs"] == []
    assert db.total("playlists") == db.total("playlist_operations") == 0
    for invalid in (refs[:-1], refs + [refs[0]], [str(uuid4()), *refs[1:]]):
        with pytest.raises(PlaylistError):
            db.queue(source, refs=invalid)
    # Deliberately retain the stale input CurrentActor grant. SQL must reload it.
    with db.connect() as con:
        con.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s",
                    (db.owner.account_id, MEDIA))
    with pytest.raises(PlaylistError, match="item_unavailable"):
        db.queue(source, refs=refs)


def test_current_track_media_denial_omits_only_nonstarting_native_items(mix_db):
    db = mix_db
    grant_media(db)
    source = db.capture()
    denied = ids(source)[1]
    def constraints(context):
        blocked = context.action == MEDIA and context.resource is not None and context.resource.resource_ref == str(denied)
        return PolicyEvaluationConstraints(deployment_allowed=not blocked)
    result = db.queue(source, constraints=constraints)
    denied_ref = source["entries"][1]["entry_ref"]
    assert result["unavailable_item_refs"] == [denied_ref]
    assert [row["playlist_item_id"] for row in result["tracks"]] == [
        row["entry_ref"] for row in source["entries"] if row["entry_ref"] != denied_ref]
    starting_denied = [denied_ref, *[row["entry_ref"] for row in source["entries"] if row["entry_ref"] != denied_ref]]
    with pytest.raises(PlaylistError, match="item_unavailable"):
        db.queue(source, refs=starting_denied, constraints=constraints)


def test_current_browse_denial_retires_source_use_without_partial_save(mix_db):
    db = mix_db
    source = db.capture()
    def constraints(context):
        blocked = context.action == "library.browse.read" and context.resource is not None and context.resource.resource_ref == str(db.tracks[0])
        return PolicyEvaluationConstraints(client_surface_allowed=not blocked)
    for call in (lambda: read_source(db, source, constraints=constraints),
                 lambda: db.service.execute(db.context(), db.create_command(source), constraints=constraints),
                 lambda: db.queue(source, constraints=constraints)):
        with pytest.raises(PlaylistError, match="source_unavailable"):
            call()
    assert db.total("playlists") == db.total("playlist_operations") == 0


def test_missing_mapping_and_unknown_global_count_are_explicit_coverage(mix_db):
    db = mix_db
    with db.connect() as con:
        con.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s", (db.tracks[0],))
        db.observe(con, db.tracks[1], None, state="missing")
    source = db.capture(per=3)
    assert ids(source) == [db.tracks[i] for i in (2, 3, 4, 5)]
    assert source["coverage"]["selected_count"] == 4
    assert source["coverage"]["excluded_count"] == 2
    assert source["coverage"]["diagnostics_truncated"] is False
    assert {row["reason"] for row in source["diagnostics"]} == {"missing_provider_mapping", "missing_global_metric"}
    assert sum(source["coverage"]["reasons"].values()) == 2
    assert len({row["inventory_track_ref"] for row in source["diagnostics"]}) == 2
    receipt, _, _ = db.save(source)
    assert db.state(receipt["playlist_id"])[2]["coverage"] == source["coverage"]


def test_reader_and_selector_exclusions_are_disjoint_and_count_distinct_tracks(mix_db):
    db = mix_db
    with db.connect() as con:
        con.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s", (db.tracks[0],))
        db.observe(con, db.tracks[1], None, state="missing")
        # Remove the asserted primary album-artist group for album 2, retaining
        # recording mappings by updating their complete identity fingerprints.
        con.execute("""update library.local_track_files
            set metadata=metadata #- '{scan_cache,file_entry,musicbrainz_album_artist_ids}'
            where track_id=any(%s)""", (db.tracks[3:],))
        db.rebind_mappings(con, db.tracks[3:])
    source = db.capture(basis="per_artist", per=3)
    assert ids(source) == [db.tracks[2]]
    assert source["coverage"]["excluded_count"] == 5
    assert source["coverage"]["reasons"] == {
        "missing_provider_mapping": 1, "missing_global_metric": 1, "missing_group_identity": 3}
    assert len(source["diagnostics"]) == len({item["inventory_track_ref"] for item in source["diagnostics"]}) == 5


def test_denied_album_credit_does_not_change_admitted_artist_group_membership(mix_db):
    from psycopg.types.json import Jsonb
    db = mix_db
    denied = db.tracks[2]
    with db.connect() as con:
        con.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
            '{scan_cache,file_entry,musicbrainz_album_artist_ids}',%s) where track_id=%s""",
            (Jsonb([db.artist_mbids[1]]), denied))
        db.rebind_mappings(con, [denied])
    def constraints(context):
        blocked = context.action == "library.browse.read" and context.resource is not None and context.resource.resource_ref == str(denied)
        return PolicyEvaluationConstraints(deployment_allowed=not blocked)
    source = db.capture(basis="per_artist", constraints=constraints)
    assert ids(source) == [db.tracks[i] for i in (0, 1, 3, 4)]
    assert source["diagnostics"] == []
    assert source["coverage"]["excluded_count"] == 0


def test_mapping_history_slots_jobs_and_lease_have_explicit_minimum_role_rights(mix_db):
    db = mix_db
    tables = {
        "library.track_popularity_mapping_versions": ({"SELECT", "INSERT"}, ()),
        "library.track_popularity_mapping_slots": ({"SELECT", "INSERT"}, (
            "current_revision", "checked_inventory_revision", "last_attempt_at", "retry_after", "last_result")),
        "library.popularity_refresh_jobs": ({"SELECT", "INSERT"}, (
            "run_ref", "status", "upper_track_id", "last_track_id", "started_at", "updated_at",
            "next_batch_at", "examined_tracks", "provider_requests")),
        "catalog.popularity_api_refresh_state": ({"SELECT"}, ("lease_token", "lease_until", "next_attempt_at")),
    }
    with db.connect() as con:
        for table, (table_rights, update_columns) in tables.items():
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
                actual = con.execute("""select has_table_privilege('album_haven_app',%s,%s) as app,
                    has_table_privilege('album_haven_readonly',%s,%s) as readonly""",
                    (table, privilege, table, privilege)).fetchone()
                assert actual == {"app": privilege in table_rights, "readonly": False}, (table, privilege)
            columns = con.execute("""select attname from pg_attribute
                where attrelid=%s::regclass and attnum>0 and not attisdropped""", (table,)).fetchall()
            for row in columns:
                allowed = con.execute("select has_column_privilege('album_haven_app',%s,%s,'UPDATE') as allowed",
                    (table, row["attname"])).fetchone()["allowed"]
                assert allowed is (row["attname"] in update_columns), (table, row["attname"])
            public = con.execute("""select count(*) as n from pg_class c
                cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) p
                where c.oid=%s::regclass and p.grantee=0""", (table,)).fetchone()["n"]
            assert public == 0


def test_personal_zero_unknown_and_other_account_counts_are_distinct(mix_db):
    db = mix_db
    with db.connect() as con:
        other = db.member(con)
        # An alias collision makes exact personal attribution unknown, even
        # though global popularity selection can still use the recording map.
        key = con.execute("select track_key from library.local_tracks where id=%s", (db.tracks[0],)).fetchone()["track_key"]
        con.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,content_signature)
            values(%s,%s,%s,'alias-collision')""", (db.tracks[2], db.root_id, key))
        con.execute("""insert into integration.listen_history
            (account_id,library_id,track_id,track_key,played_at,source_family,source_entry_id,scrobble_status)
            values(%s,%s,%s,%s,%s,'runtime_listen_history_adapter',%s,'scrobbled')""",
            (other.account_id, db.library, db.tracks[1], f"{db.token}:1", db.now, uuid4().hex))
        counts = read_scoped_track_play_counts(con, account_id=db.owner.account_id,
            library_id=db.library, track_ids=db.tracks)
        assert db.tracks[0] not in counts
        assert counts[db.tracks[1]] == 0
        personal_other = read_scoped_track_play_counts(con, account_id=other.account_id,
            library_id=db.library, track_ids=[db.tracks[1]])
        assert personal_other == {db.tracks[1]: 1}
    source = db.capture()
    assert source["entries"][0]["inventory_track_ref"] == f"inventory-track:{db.library}:{db.tracks[0]}"
    assert source["entries"][0]["play_count"] is None
    assert source["entries"][1]["play_count"] == 0
    grant_media(db)
    queue = db.queue(source)
    assert queue["tracks"][0]["play_count"] is None
    assert queue["tracks"][1]["play_count"] == 0


def test_source_expiry_after_inventory_lock_wait_prevents_commit(mix_db):
    db = mix_db
    source = db.capture()
    command = db.create_command(source)
    reached = Event()
    class ObservedConnection:
        def __init__(self, real):
            self.real = real
        def __getattr__(self, name):
            return getattr(self.real, name)
        def execute(self, sql, params=None):
            if "select id from library.local_tracks" in sql and "for update" in sql:
                reached.set()
            return self.real.execute(sql, params)
    @contextmanager
    def connect(url):
        with psycopg.connect(url, row_factory=dict_row) as con:
            yield ObservedConnection(con)
    service = PostgresOwnedPlaylistsService(db.config, connect=connect, clock=lambda: db.clock_time)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.connect() as blocker:
            blocker.execute("select id from library.local_tracks where id=%s for update", (db.tracks[0],))
            future = pool.submit(service.execute, db.context(), command)
            try:
                assert reached.wait(10), "Writer never reached the actual inventory row lock"
                db.clock_time += timedelta(minutes=31)
            finally:
                blocker.commit()
        with pytest.raises(PlaylistError, match="source_expired"):
            future.result(timeout=10)
    assert db.total("playlists") == db.total("playlist_operations") == db.total("playlist_library_mixes") == 0


def test_refresh_and_concurrent_metadata_save_share_one_revision_lock(mix_db):
    db = mix_db
    receipt, _, _ = db.save()
    with db.connect() as con:
        db.observe(con, db.tracks[2], 700)
    command = normalize_playlist_command("save", {"revision": receipt["revision"],
        "request_key": str(uuid4()), "title": "Concurrent title"}, playlist_ref=receipt["playlist_id"])
    reached = Event()
    class ObserveRefresh:
        def __init__(self, real):
            self.real = real
        def __getattr__(self, name):
            return getattr(self.real, name)
        def execute(self, sql, params=None):
            if "select id from library.local_tracks" in sql and "for update" in sql:
                reached.set()
            return self.real.execute(sql, params)
    @contextmanager
    def connect(url):
        with psycopg.connect(url, row_factory=dict_row) as con:
            yield ObserveRefresh(con)
    service = PostgresOwnedPlaylistsService(db.config, connect=connect, clock=lambda: db.clock_time)
    with ThreadPoolExecutor(max_workers=2) as pool:
        with db.connect() as blocker:
            blocker.execute("select id from library.local_tracks where id=%s for update", (db.tracks[0],))
            refresh_future = pool.submit(mixes.refresh_owned, service, db.context(), receipt["playlist_id"])
            try:
                assert reached.wait(10), "Refresh did not reach the actual inventory lock"
                rename_future = pool.submit(db.service.execute, db.context(), command)
            finally:
                blocker.commit()
        assert refresh_future.result(timeout=10)["refresh_status"] == "current"
        with pytest.raises(PlaylistError, match="revision_conflict"):
            rename_future.result(timeout=10)
    state = db.state(receipt["playlist_id"])
    assert item_ids(state[1]) == [db.tracks[i] for i in (2, 0, 3, 4)]
    assert state[0]["revision"] == 2 and state[0]["title"] == "Saved Library Mix"
    assert db.total("playlist_operations") == 1
