"""Scan compatibility contracts; recording SQL is not live Postgres evidence."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest

from cover_unit_safety import cover_unit_transports  # noqa: F401
from music_app.services import scan_cache_persistence as persistence


ORDERED_KEYS = ("selected_covers", "selected_covers_revision", "selected_covers_last_request")
PRIMARY_FIELDS = (
    "cover_revision", "cover_selection_origin", "cover_selection_provenance",
    "local_cover_width", "local_cover_height", "remote_cover_url",
    "remote_cover_thumbnail_url", "remote_cover_source", "remote_cover_source_label",
    "remote_cover_album_url", "remote_cover_width", "remote_cover_height",
)


def selected_metadata(*, remote=False, value=None, malformed=False):
    item = ({"selection_id": "front", "kind": "remote", "url": "https://example.invalid/Front.JPG?Key=A"}
            if remote else {"selection_id": "front", "kind": "local", "path": "/missing/child/Front.jpg"})
    result = {
        "selected_covers": value if malformed else [item, {"selection_id": "rear", "kind": "local", "path": "/missing/child/Rear.jpg"}],
        "selected_covers_revision": 7,
        "selected_covers_last_request": {"mutation_id": "2cfe2385-c225-4501-9a71-3d7fc286b3d1", "request_hash": "a1" * 32},
        "cover_selection_origin": "user", "cover_selection_provenance": "explicit",
        "cover_revision": "current-content-revision",
    }
    if remote:
        result.update(remote_cover_url=item["url"], remote_cover_thumbnail_url="https://example.invalid/thumb.jpg",
                      remote_cover_source="fixture", remote_cover_source_label="Fixture Provider",
                      remote_cover_album_url="https://example.invalid/Release", remote_cover_width=800, remote_cover_height=900)
    else:
        result.update(local_cover_width=600, local_cover_height=650)
    return result


def file_entry(path="/missing/child/01.flac"):
    return {"path": path, "mtime": 1.0, "size": 12, "album": "Child", "album_artist": "Fixture",
            "artist": "Fixture", "title": "One", "track_number": 1, "disc_number": 1,
            "duration_seconds": 10, "cover_path": "/stale/cover.jpg", "cover_revision": "stale",
            "remote_cover_url": "https://stale.invalid/Old.jpg", "local_cover_width": 99}


def album_row(metadata, *, path="/missing/child/01.flac", album_id=72, remote=False):
    return {"private_path": path, "album_id": album_id, "album_key": f"fixture::child::{album_id}",
            "album_metadata": deepcopy(metadata), "file_entry": file_entry(path),
            "cover_path": None if remote else "/missing/child/Front.jpg",
            "cover_selection_origin": "user", "cover_selection_provenance": "explicit"}


def normalized(sql):
    return " ".join(sql.lower().split())


@pytest.mark.parametrize("remote", [False, True])
@pytest.mark.parametrize("malformed,value", [(False, None), (True, None), (True, []), (True, "broken")])
def test_hydration_preserves_authoritative_primary_without_resolving_sources(monkeypatch, remote, malformed, value):
    metadata = selected_metadata(remote=remote, malformed=malformed, value=value)
    row = album_row(metadata, remote=remote)
    original = deepcopy(row)
    entry = file_entry()

    def forbidden(*args, **kwargs):
        raise AssertionError("Scan cover hydration must not probe a selected source")

    with monkeypatch.context() as patch:
        patch.setattr(Path, "stat", forbidden)
        patch.setattr(Path, "is_file", forbidden)
        changed = persistence._hydrate_ordered_album_cover(entry, row)
    assert changed is True
    assert entry["cover_path"] == row["cover_path"]
    for field in PRIMARY_FIELDS:
        assert entry.get(field) == metadata.get(field)
    assert not set(ORDERED_KEYS).intersection(entry)
    assert row == original


@pytest.mark.parametrize("metadata", [None, [], "legacy", 0, True, {},
    {"cover_selection_origin": "user", "cover_selection_provenance": "explicit"},
    {"selected_covers_revision": 7}])
def test_hydration_does_not_infer_ordered_selection_for_legacy(metadata):
    entry = file_entry()
    before = deepcopy(entry)
    assert persistence._hydrate_ordered_album_cover(entry, album_row(metadata)) is False
    assert entry == before


@pytest.mark.parametrize("remote", [False, True])
@pytest.mark.parametrize("value", ["valid", None, [], "broken"])
def test_targeted_survivor_keeps_missing_or_remote_ordered_primary(monkeypatch, remote, value):
    metadata = selected_metadata(remote=remote, malformed=value != "valid", value=value)
    row = album_row(metadata, remote=remote)
    before = deepcopy(row)

    def forbidden(*args, **kwargs):
        raise AssertionError("Ordered artwork is not inferred from a surviving track folder")

    monkeypatch.setattr(persistence, "inferred_local_cover_belongs_to_track", forbidden)
    result = persistence._targeted_surviving_file_entry(row)
    assert result["cover_path"] == row["cover_path"]
    for field in PRIMARY_FIELDS:
        assert result.get(field) == metadata.get(field)
    assert row == before
    assert not set(ORDERED_KEYS).intersection(result)


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return deepcopy(self.rows[0]) if self.rows else None

    def fetchall(self):
        return deepcopy(self.rows)


class ScanConnection:
    def __init__(self, rows=()):
        self.rows = list(rows)
        self.operations = []
        self.exited = False
        self.commits = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.exited = True

    def execute(self, sql, params=None):
        self.operations.append((sql, params))
        if "bootstrap_context_ready" in sql:
            return Cursor([{"bootstrap_context_ready": 1}])
        if "as cover_mutation_revision" in sql:
            return Cursor([{"cover_mutation_revision": 0}])
        if "as inventory_mutation_revision" in sql:
            return Cursor([{"inventory_mutation_revision": 0}])
        if "as scan_cache" in sql:
            return Cursor([{"scan_cache": {"library_root_identity": "fixture-root", "last_scan": 12.0}}])
        if "blocked_by_ordered_selection" in sql:
            return Cursor([{"blocked_by_ordered_selection": False}])
        if "library.local_track_files.private_path" in sql and "as album_metadata" in sql:
            return Cursor(self.rows)
        # The old load lacks album_metadata; return the same synthetic DB row so
        # the failure proves missing hydration rather than fake query parsing.
        if "library.local_track_files.private_path" in sql and "as album_is_compilation" in sql:
            return Cursor(self.rows)
        return Cursor([])

    def commit(self):
        self.commits += 1


def adapter(connection, **kwargs):
    return persistence.PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/scan_unit"},
        connect=lambda _: connection, **kwargs)


def test_snapshot_hydrates_each_concrete_album_primary_and_keeps_list_private():
    first = selected_metadata()
    second = selected_metadata(remote=True)
    second["selected_covers_revision"] = 19
    connection = ScanConnection([album_row(first), album_row(second, path="/missing/version/01.flac", album_id=91, remote=True)])
    result, last_scan, _, _, error = adapter(connection).load_snapshot_strict(Path("unused"), "fixture-root")
    assert error is None and last_scan == 12.0
    for row in connection.rows:
        entry = result[row["private_path"]]
        assert entry["album_id"] == row["album_id"]
        assert entry["cover_path"] == row["cover_path"]
        for field in PRIMARY_FIELDS:
            assert entry.get(field) == row["album_metadata"].get(field)
        assert not set(ORDERED_KEYS).intersection(entry)
    assert connection.exited and connection.commits == 0


@pytest.mark.parametrize("targeted", [False, True])
def test_scan_load_fetches_album_metadata_in_same_scoped_read(targeted):
    sql = normalized(persistence._load_file_entries_sql(targeted_albums=targeted))
    assert "library.local_albums.metadata as album_metadata" in sql
    assert "bootstrap_context.library_id = library.local_tracks.library_id" in sql
    assert "library.local_albums.id = library.local_tracks.album_id" in sql
    assert "manual_version" not in sql


@pytest.mark.parametrize("preserve", [False, True])
def test_full_and_targeted_upsert_cannot_replace_ordered_primary_or_metadata(preserve):
    sql = normalized(persistence._upsert_local_album_sql(preserve_existing_cover_authority=preserve))
    update = sql.split("on conflict (library_id, album_key) do update", 1)[1]
    assert "jsonb_typeof(library.local_albums.metadata) = 'object'" in update
    assert "library.local_albums.metadata ? 'selected_covers'" in update
    assert "then library.local_albums.cover_path" in update
    for field in (*ORDERED_KEYS, *PRIMARY_FIELDS):
        assert repr(field) in sql
    # Scanner input can neither create a selection nor replace its revision/receipt.
    insert = sql.split("on conflict (library_id, album_key) do update", 1)[0]
    for field in ORDERED_KEYS:
        assert repr(field) in insert
    assert "%(metadata)s::jsonb -" in insert or "(%(metadata)s::jsonb) -" in insert


def test_targeted_aggregate_guards_ordered_primary_independently_of_origin():
    sql = normalized(persistence._update_targeted_album_aggregate_sql())
    assert "jsonb_typeof(album.metadata) = 'object'" in sql
    assert "album.metadata ? 'selected_covers'" in sql
    assert "then album.cover_path" in sql
    for field in ORDERED_KEYS:
        assert repr(field) in sql
    assert "album.library_id = owned_library.id" in sql
    assert "album.album_key = %(album_key)s" in sql


def test_inherited_repair_cannot_erase_even_malformed_ordered_authority():
    sql = normalized(persistence._inherited_cover_repair_guard_sql("current_album", "incoming_metadata"))
    assert "jsonb_typeof(current_album.metadata) = 'object'" in sql
    assert "current_album.metadata ? 'selected_covers'" in sql
    assert "not" in sql


@pytest.mark.parametrize("by_ids", [False, True])
def test_primary_sync_filters_ordered_albums_without_copying_reference_payload(by_ids):
    sql = normalized(persistence._synchronize_album_cover_file_entries_sql(by_album_ids=by_ids, ordered_only=True))
    assert "jsonb_typeof(album.metadata) = 'object'" in sql
    assert "album.metadata ? 'selected_covers'" in sql
    assert "album.library_id = tracks.library_id" in sql
    assert "files.scan_cache_stale is false" in sql
    for field in ORDERED_KEYS:
        assert f"'{field}', album.metadata" not in sql


def test_full_scan_synchronizes_existing_ordered_primary_before_publication(monkeypatch):
    connection = ScanConnection()
    album = SimpleNamespace(key="fixture::child")
    monkeypatch.setattr(persistence, "_inventory_rows_from_albums", lambda *args: ([], [{"album_key": album.key}], [], [], []))
    monkeypatch.setattr(persistence, "_execute_pipeline_batches", lambda *args: None)
    monkeypatch.setattr(persistence, "_execute_set_based_batches", lambda *args: None)
    monkeypatch.setattr(persistence, "_execute_semantic_local_album_key_adoptions", lambda *args: None)
    adapter(connection, build_albums=lambda *args: [album]).save_snapshot(
        Path("unused"), {}, "fixture-root", 13.0, separate_release_keys=set(),
        expected_cover_mutation_revision=0, expected_inventory_mutation_revision=0)
    syncs = [(index, params) for index, (sql, params) in enumerate(connection.operations)
             if "update library.local_track_files files" in sql and "selected_covers" in sql]
    assert len(syncs) == 1
    index, params = syncs[0]
    assert params["album_keys"] == [album.key]
    publication = next(i for i, (sql, _) in enumerate(connection.operations) if "update library.libraries" in sql)
    assert index < publication


class MembershipConnection(ScanConnection):
    def __init__(self, blocked=False, *, missing_result=False):
        super().__init__()
        self.blocked = blocked
        self.missing_result = missing_result

    def execute(self, sql, params=None):
        self.operations.append((sql, params))
        return Cursor([] if self.missing_result else [{"blocked_by_ordered_selection": self.blocked}])


def membership_rows():
    return ([{"track_key": "track-1", "album_key": "fixture::child"}],
            [{"track_key": "track-1", "private_path": "/missing/child/01.flac"}])


@pytest.mark.parametrize("blocked", [False, True])
def test_membership_guard_uses_concrete_track_mapping_and_rejects_reassignment(blocked):
    from music_app.services.ordered_cover_references import OrderedCoverSelectionConflict

    connection = MembershipConnection(blocked)
    tracks, files = membership_rows()
    if blocked:
        with pytest.raises(OrderedCoverSelectionConflict):
            persistence._assert_ordered_cover_album_membership_preserved(connection, tracks, files)
    else:
        persistence._assert_ordered_cover_album_membership_preserved(connection, tracks, files)
    assert len(connection.operations) == 1
    _, params = connection.operations[0]
    assert persistence._jsonb_compatible(params["incoming_memberships"]) == [
        {"track_key": "track-1", "private_path": "/missing/child/01.flac", "album_key": "fixture::child"}]
    assert connection.commits == 0


def test_membership_guard_fails_closed_when_database_result_is_missing():
    connection = MembershipConnection(missing_result=True)
    with pytest.raises((ValueError, RuntimeError)):
        persistence._assert_ordered_cover_album_membership_preserved(connection, *membership_rows())


@pytest.mark.parametrize("tracks", [[], [{"track_key": "other", "album_key": "fixture::child"}],
    [{"track_key": "track-1", "album_key": ""}]])
def test_membership_guard_rejects_unmapped_input_before_query(tracks):
    connection = MembershipConnection()
    with pytest.raises((ValueError, RuntimeError)):
        persistence._assert_ordered_cover_album_membership_preserved(connection, tracks, membership_rows()[1])
    assert connection.operations == []


def test_membership_guard_does_not_treat_stale_removal_as_reassignment():
    connection = MembershipConnection()
    persistence._assert_ordered_cover_album_membership_preserved(connection, [], [])
    assert connection.operations == []


def test_membership_query_preserves_same_album_identity_in_bootstrap_scope():
    sql = normalized(persistence._ordered_cover_album_membership_conflict_sql())
    assert "jsonb_typeof(album.metadata) = 'object'" in sql
    assert "album.metadata ? 'selected_covers'" in sql
    assert "is distinct from" in sql
    assert "incoming.album_key" in sql
    assert "incoming.private_path" in sql
    assert "app.bootstrap_owners" in sql
    assert "library_id" in sql
    assert "manual_version" not in sql
    assert "delete " not in sql and "update " not in sql and "insert " not in sql


@pytest.mark.parametrize("targeted", [False, True])
def test_scan_checks_membership_after_adoption_before_track_upserts(monkeypatch, targeted):
    from music_app.services.ordered_cover_references import OrderedCoverSelectionConflict

    connection = ScanConnection()
    events = []
    tracks, files = membership_rows()
    album = SimpleNamespace(key="fixture::child")
    monkeypatch.setattr(persistence, "_inventory_rows_from_albums", lambda *args, **kwargs:
                        ([], [{"album_key": album.key}], [], tracks, files))
    monkeypatch.setattr(persistence, "_remap_targeted_album_identity_rows", lambda **kwargs: None)
    monkeypatch.setattr(persistence, "_execute_pipeline_batches", lambda *args: None)
    monkeypatch.setattr(persistence, "_execute_set_based_batches", lambda *args: events.append("track-upsert"))
    monkeypatch.setattr(persistence, "_execute_semantic_local_album_key_adoptions", lambda *args: events.append("adopt"))

    def reject_reassignment(actual_connection, actual_tracks, actual_files):
        assert actual_connection is connection
        assert actual_tracks == tracks and actual_files == files
        events.append("guard")
        raise OrderedCoverSelectionConflict("Concrete album reassignment blocked")

    monkeypatch.setattr(persistence, "_assert_ordered_cover_album_membership_preserved", reject_reassignment, raising=False)
    subject = adapter(connection, build_albums=lambda *args: [album])
    with pytest.raises(OrderedCoverSelectionConflict):
        if targeted:
            subject.persist_targeted_inventory_mutation(root_id="fixture-root", active_file_entries={})
        else:
            subject.save_snapshot(Path("unused"), {}, "fixture-root", 13.0, separate_release_keys=set(),
                                  expected_cover_mutation_revision=0, expected_inventory_mutation_revision=0)
    assert events == ["adopt", "guard"]
    assert connection.commits == 0 and connection.exited


@pytest.mark.parametrize("origin", [None, "automatic", "unknown"])
def test_ordered_hydration_does_not_depend_on_legacy_origin(origin):
    metadata = selected_metadata()
    metadata["cover_selection_origin"] = origin
    metadata.pop("cover_selection_provenance")
    entry = file_entry()
    row = album_row(metadata)
    row["cover_path"] = None
    assert persistence._hydrate_ordered_album_cover(entry, row) is True
    assert entry["cover_path"] is None
    assert entry.get("cover_selection_origin") == origin
    assert entry.get("cover_selection_provenance") is None
    assert entry.get("remote_cover_url") is None


@pytest.mark.parametrize("duplicate_kind", ["track_key", "private_path"])
def test_membership_guard_rejects_ambiguous_incoming_mapping(duplicate_kind):
    tracks, files = membership_rows()
    if duplicate_kind == "track_key":
        tracks.append({"track_key": "track-1", "album_key": "fixture::other"})
    else:
        tracks.append({"track_key": "track-2", "album_key": "fixture::other"})
        files.append({"track_key": "track-2", "private_path": files[0]["private_path"]})
    connection = MembershipConnection()
    with pytest.raises(ValueError):
        persistence._assert_ordered_cover_album_membership_preserved(connection, tracks, files)
    assert connection.operations == []


def test_targeted_scan_synchronizes_ordered_primary_before_commit(monkeypatch):
    connection = ScanConnection()
    album = SimpleNamespace(key="fixture::child")
    tracks, files = membership_rows()
    monkeypatch.setattr(persistence, "_inventory_rows_from_albums", lambda *args, **kwargs:
                        ([], [{"album_key": album.key}], [], tracks, files))
    monkeypatch.setattr(persistence, "_remap_targeted_album_identity_rows", lambda **kwargs: None)
    monkeypatch.setattr(persistence, "_execute_pipeline_batches", lambda *args: None)
    monkeypatch.setattr(persistence, "_execute_set_based_batches", lambda *args: None)
    monkeypatch.setattr(persistence, "_execute_semantic_local_album_key_adoptions", lambda *args: None)
    monkeypatch.setattr(persistence, "_commit_structural_relation_projection", lambda *args, **kwargs: None)
    adapter(connection, build_albums=lambda *args: [album]).persist_targeted_inventory_mutation(
        root_id="fixture-root", active_file_entries={files[0]["private_path"]: file_entry()})
    syncs = [(index, params) for index, (sql, params) in enumerate(connection.operations)
             if "update library.local_track_files files" in sql and "selected_covers" in sql]
    assert len(syncs) == 1
    index, params = syncs[0]
    assert params["album_keys"] == [album.key]
    assert connection.commits == 1 and connection.exited
    assert not any("manual_version" in sql for sql, _ in connection.operations)


@pytest.mark.parametrize("blocked", [False, True])
def test_explicit_non_album_destination_is_checked_not_discarded(blocked):
    from music_app.services.ordered_cover_references import OrderedCoverSelectionConflict

    tracks, files = membership_rows()
    tracks[0]["album_key"] = None
    connection = MembershipConnection(blocked)
    if blocked:
        with pytest.raises(OrderedCoverSelectionConflict):
            persistence._assert_ordered_cover_album_membership_preserved(connection, tracks, files)
    else:
        persistence._assert_ordered_cover_album_membership_preserved(connection, tracks, files)
    assert persistence._jsonb_compatible(connection.operations[0][1]["incoming_memberships"]) == [
        {"track_key": "track-1", "private_path": files[0]["private_path"], "album_key": None}]


@pytest.mark.parametrize("by_ids", [False, True])
@pytest.mark.parametrize("ordered_only", [False, True])
def test_sync_is_restricted_to_exact_bootstrap_library(by_ids, ordered_only):
    sql = normalized(persistence._synchronize_album_cover_file_entries_sql(
        by_album_ids=by_ids, ordered_only=ordered_only))
    scope = sql.split("update library.local_track_files files", 1)[0]
    assert "owner.owner_key = 'local-bootstrap-owner'" in scope
    assert "lib.id = album.library_id" in scope
    assert "owner.account_id = lib.owner_account_id" in scope
    assert "lib.library_kind = 'local'" in scope
    assert "lib.name = 'local library'" in scope


@pytest.mark.parametrize("preserve", [False, True])
def test_ordered_upsert_rejects_nonobject_incoming_metadata_without_changing_legacy_semantics(preserve):
    """SQL contract only: no recording cursor executes JSONB concatenation."""
    sql = normalized(persistence._upsert_local_album_sql(preserve_existing_cover_authority=preserve))
    update = sql.split("metadata =", 1)[1]
    guard = normalized(persistence._has_ordered_cover_selection_sql("library.local_albums.metadata"))
    # Ordered authority needs its own branch. Combining it with the legacy
    # branch would either retain the JSONB type hazard or alter old behavior.
    assert f"when {guard} then" in update
    assert "jsonb_typeof(excluded.metadata) = 'object'" in update
    assert "else '{}'::jsonb end" in update
    assert "else excluded.metadata" in update
    legacy_fields = ", ".join(repr(field) for field in persistence._ALBUM_COVER_METADATA_FIELDS)
    if preserve:
        assert f"then excluded.metadata - array[{legacy_fields}]::text[]" in update
    else:
        assert f"then excluded.metadata - array[{legacy_fields}]::text[]" not in update


def test_ordered_targeted_aggregate_does_not_concat_nonobject_incoming_metadata():
    sql = normalized(persistence._update_targeted_album_aggregate_sql())
    update = sql.split("metadata =", 1)[1].split("from library.libraries", 1)[0]
    guard = normalized(persistence._has_ordered_cover_selection_sql("album.metadata"))
    assert f"when {guard} then" in update
    assert "jsonb_typeof(%(metadata)s::jsonb) = 'object'" in update
    assert "else '{}'::jsonb end" in update
    # Cover metadata is excluded for ordered rows regardless of its incoming
    # JSON type. Legacy nonobject handling remains on its original fallback.
    assert f"when {guard}" in update
    assert "then '{}'::jsonb" in update
    assert "else %(metadata)s::jsonb end" in update
    assert "else %(cover_metadata)s::jsonb end" in update


@pytest.mark.parametrize("private_path", ["/music/a.flac", "/music//a.flac"])
def test_membership_guard_preserves_actual_track_upsert_key_separately_from_file_path(private_path):
    connection = MembershipConnection()
    tracks = [{"track_key": "/music/a.flac", "album_key": "fixture::different"}]
    files = [{"track_key": "/music/a.flac", "private_path": private_path}]
    persistence._assert_ordered_cover_album_membership_preserved(connection, tracks, files)
    incoming = persistence._jsonb_compatible(connection.operations[0][1]["incoming_memberships"])
    assert incoming == [{"track_key": "/music/a.flac", "private_path": private_path,
                         "album_key": "fixture::different"}]


def test_membership_query_checks_track_upsert_identity_in_addition_to_file_identity():
    """Inspect the two lookup contracts, not simulated execution of PostgreSQL."""
    sql = normalized(persistence._ordered_cover_album_membership_conflict_sql())
    assert "track_key text" in sql
    assert "tracks.track_key = incoming.track_key" in sql
    assert "files.private_path = incoming.private_path" in sql
    assert "union" in sql or sql.count("exists (") >= 2
    assert "on tracks.track_key = incoming.track_key or" not in sql
    assert "on files.private_path = incoming.private_path or" not in sql


def test_membership_track_key_lookup_uses_the_same_bootstrap_library_as_upsert():
    sql = normalized(persistence._ordered_cover_album_membership_conflict_sql())
    assert "bootstrap_context" in sql
    assert "library.libraries.name = 'local library'" in sql
    assert "library.libraries.library_kind = 'local'" in sql
    assert "app.bootstrap_owners.owner_key = 'local-bootstrap-owner'" in sql
    # Both indexed lookups must reject a track belonging to another library.
    assert sql.count("tracks.library_id = bootstrap_context.library_id") >= 2


@pytest.mark.parametrize("unpaired_kind", ["all", "extra"])
def test_membership_guard_rejects_track_upserts_without_checked_file_memberships(unpaired_kind):
    tracks, files = membership_rows()
    if unpaired_kind == "all":
        files = []
    else:
        tracks.append({"track_key": "unpaired-track", "album_key": "fixture::different"})
    connection = MembershipConnection()
    with pytest.raises(ValueError):
        persistence._assert_ordered_cover_album_membership_preserved(connection, tracks, files)
    assert connection.operations == []
