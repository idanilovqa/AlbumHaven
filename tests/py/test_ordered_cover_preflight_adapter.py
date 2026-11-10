"""Read-only ordered-cover preflight contracts; recording connections do not execute SQL."""
import pytest

from music_app.services.ordered_cover_references import OrderedCoverSelectionConflict


class ReadConnection:
    def __init__(self, row):
        self.row = row
        self.operations = []
        self.commits = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def execute(self, sql, params=None):
        self.operations.append((sql, params))
        return self

    def fetchone(self):
        return self.row

    def commit(self):
        self.commits += 1


def adapter_for_metadata(metadata, *, cover_path=None, row_missing=False):
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    connection = ReadConnection(None if row_missing else {
        "album_id": 72, "cover_path": cover_path, "metadata": metadata,
    })
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/preflight"},
        connect=lambda _: connection,
    )
    return adapter, connection


@pytest.mark.parametrize("value", [None, [], {}, "invalid", 4, [{"kind": "remote", "url": "https://example.test/cover.jpg"}]])
def test_adapter_rejects_every_present_ordered_key_without_writes(value):
    adapter, connection = adapter_for_metadata({"selected_covers": value})
    with pytest.raises(OrderedCoverSelectionConflict):
        adapter.assert_legacy_cover_mutation_allowed(track_paths={"/fixture/child/track.flac"})
    assert connection.commits == 0
    assert connection.operations
    assert all(not any(word in sql.lower().split() for word in ("insert", "update", "delete"))
               for sql, _ in connection.operations)


@pytest.mark.parametrize("metadata", [None, {}, [], "legacy", {"cover_selection_origin": "user"}])
def test_adapter_allows_legacy_without_inventing_ordered_ownership(metadata):
    adapter, connection = adapter_for_metadata(metadata)
    adapter.assert_legacy_cover_mutation_allowed(track_paths={"/fixture/child/track.flac"})
    assert connection.commits == 0


def selection(primary, secondary):
    return {"selected_covers_revision": 2, "selected_covers": [
        {"selection_id": "primary", "kind": "local", "path": str(primary)},
        {"selection_id": "secondary", "kind": "local", "path": str(secondary)},
    ]}


@pytest.mark.parametrize("target", ["primary", "secondary", "projection"])
def test_deletion_protects_each_selected_source_and_primary_fallback(tmp_path, target):
    primary, secondary, projection = (tmp_path / name for name in ("front.jpg", "rear.jpg", "cover.jpg"))
    adapter, _ = adapter_for_metadata(selection(primary, secondary), cover_path=str(projection))
    with pytest.raises(OrderedCoverSelectionConflict):
        adapter.assert_legacy_cover_mutation_allowed(
            track_paths={str(tmp_path / "track.flac")},
            deleting_source_path={"primary": primary, "secondary": secondary, "projection": projection}[target],
        )


def test_deletion_allows_unrelated_source_with_valid_ordered_set(tmp_path):
    adapter, connection = adapter_for_metadata(selection(tmp_path / "front.jpg", tmp_path / "rear.jpg"))
    adapter.assert_legacy_cover_mutation_allowed(
        track_paths={str(tmp_path / "track.flac")}, deleting_source_path=tmp_path / "unselected.jpg",
    )
    assert connection.commits == 0


@pytest.mark.parametrize("metadata", [{"selected_covers": None}, {"selected_covers": []},
    {"selected_covers_revision": 0, "selected_covers": [{"selection_id": "x", "kind": "local", "path": "relative.jpg"}]}])
def test_deletion_fails_closed_for_malformed_ordered_metadata(tmp_path, metadata):
    adapter, _ = adapter_for_metadata(metadata)
    with pytest.raises(OrderedCoverSelectionConflict):
        adapter.assert_legacy_cover_mutation_allowed(
            track_paths={str(tmp_path / "track.flac")}, deleting_source_path=tmp_path / "other.jpg",
        )


def test_preflight_requires_exact_scoped_album_resolution():
    adapter, connection = adapter_for_metadata({}, row_missing=True)
    with pytest.raises(ValueError):
        adapter.assert_legacy_cover_mutation_allowed(track_paths={"/fixture/child/track.flac"})
    assert connection.commits == 0


def test_preflight_query_scopes_complete_paths_to_one_concrete_library_album():
    adapter, connection = adapter_for_metadata({})
    paths = {"/fixture/child/02.flac", "/fixture/child/01.flac"}
    adapter.assert_legacy_cover_mutation_allowed(track_paths=paths)
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    sql = " ".join(sql.lower().split())
    assert params["track_paths"] == sorted(paths)
    assert "app.bootstrap_owners" in sql
    assert "library.local_tracks.library_id = bootstrap_context.library_id" in sql
    assert "join library.local_albums as albums" in sql
    assert "albums.library_id = bootstrap_context.library_id" in sql
    assert "selection_scope.input_path_count = selection_scope.resolved_path_count" in sql
    assert "selection_scope.selected_album_count = 1" in sql
    assert "manual_version" not in sql
    assert "cover_mutation_revision" not in sql
    assert connection.commits == 0


def test_preflight_rejects_empty_paths_without_reading_database():
    adapter, connection = adapter_for_metadata({})
    with pytest.raises(ValueError):
        adapter.assert_legacy_cover_mutation_allowed(track_paths=set())
    assert connection.operations == []
