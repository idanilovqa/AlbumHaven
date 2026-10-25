"""Regression contracts for physical-file problems, independent of album tags."""

import pytest

from music_app.services import library_browse_postgres as browse


def _row(*, compact=False):
    path = r"D:\Music\Artist\Album\01 - Track.flac"
    entry = {
        "path": path, "album": "Album", "album_artist": "Artist",
        "artist": "Artist", "title": "Track", "year": "2001",
        "track_number": 1, "disc_number": 1, "size": 1024,
    }
    row = {
        "album_id": 101, "album_key": "artist::album", "album_title": "Album",
        "album_release_year": 2001, "album_cover_path": r"D:\Music\Artist\Album\cover.jpg",
        "album_metadata": {"album_artist": "Artist", "artists": ["Artist"],
                           "local_cover_width": 1000, "local_cover_height": 1000},
        "artist_name": "Artist", "track_id": 501, "track_key": "track-1",
        "track_title": "Track", "disc_number": 1, "track_number": 1,
        "duration_seconds": 180, "file_private_path": path, "file_entry": entry,
        "file_library_root_id": 9, "file_size": 1024, "ignored_repair_keys": [],
        "separate_release_keys": [], "duplicate_file_count": 1,
    }
    if compact:
        row.pop("file_entry")
        row.update(file_entry_is_object=True, file_size=1024)
        row.update({f"file_{key}": entry[key] for key in
                    ("album", "album_artist", "artist", "title", "year", "track_number")})
    return row


def _payloads(row):
    album = browse._problematic_album_projection_payloads([row])[0]
    return (browse._problematic_album_summary_payload(album),
            browse._problematic_album_detail_payload(album))


@pytest.mark.parametrize("compact", [False, True])
@pytest.mark.parametrize("size,expected", [
    (0, True), (None, False), (1024, False),
    ("invalid", False), ("", False), (False, False), (-1, False),
])
def test_empty_audio_requires_known_zero_size_in_summary_and_detail(compact, size, expected):
    row = _row(compact=compact)
    row["file_size"] = size
    if not compact:
        row["file_entry"]["size"] = size
    summary, detail = _payloads(row)
    assert ("Empty audio file" in (summary or {}).get("problem_reasons", [])) is expected
    assert ("Empty audio file" in (detail or {}).get("problem_reasons", [])) is expected
    affected = [item for item in (detail or {}).get("track_problem_rows", [])
                if "Empty audio file" in item["reasons"]]
    assert bool(affected) is expected
    if expected:
        assert [item["path"] for item in affected] == [row["file_private_path"]]


@pytest.mark.parametrize("compact", [False, True])
def test_missing_size_is_not_an_empty_audio_file(compact):
    row = _row(compact=compact)
    row.pop("file_size")
    if not compact:
        row["file_entry"].pop("size")
    for payload in _payloads(row):
        assert payload is None


@pytest.mark.parametrize("compact", [False, True])
def test_mixed_folder_survives_projection_of_only_one_album(compact):
    # The SQL context saw another persisted album in this physical folder;
    # the selected album's own tags are completely consistent.
    row = _row(compact=compact)
    row["file_mixed_album_folder"] = True
    summary, detail = _payloads(row)
    assert "Mixed album metadata in one folder" in summary["problem_reasons"]
    assert "Mixed album metadata in one folder" in detail["problem_reasons"]
    assert any("Mixed album metadata in one folder" in item["reasons"]
               for item in detail["track_problem_rows"])
    assert "Duplicate files" not in summary["problem_reasons"]


def test_compilation_artist_variation_does_not_create_mixed_folder_problem():
    row = _row()
    row["album_metadata"]["is_compilation"] = True
    row["file_entry"]["artist"] = "Guest Artist"
    row["file_mixed_album_folder"] = False
    for payload in _payloads(row):
        assert payload is None


@pytest.mark.parametrize("reason,code", [
    ("Empty audio file", "empty-audio-file"),
    ("Mixed album metadata in one folder", "mixed-album-folder"),
])
def test_physical_problem_reasons_have_stable_exclusion_identities(reason, code):
    assert browse._PROBLEM_REASON_IDENTITY_CODES[reason] == code


@pytest.mark.parametrize("candidate_summary", [False, True])
def test_problem_projection_selects_cross_album_folder_context(candidate_summary):
    sql = browse._problematic_files_sql(candidate_summary=candidate_summary)
    assert "file_mixed_album_folder" in sql
    if candidate_summary:
        assert "file_size" in sql


@pytest.mark.parametrize("modes", [
    {}, {"candidate_summary": True, "selected_album_ids": True},
    {"targeted_problem_owners": True}, {"duplicate_candidates": True},
])
def test_targeted_physical_context_uses_normalized_folder_index_equality(modes):
    sql = " ".join(browse._problematic_files_sql(**modes).split()).lower()
    assert "physical_seed_folders as materialized" in sql
    assert "physical_folder_prefixes as" not in sql
    assert "= physical_seed_folders.physical_parent" in sql
    assert "library.local_path_key(private_path)" in sql
    assert "from selected_albums" in sql.split("physical_seed_folders as materialized", 1)[1]
    assert "physical_seed_folders.library_root_id" in sql
    assert "physical_seed_folders.library_id" in sql


@pytest.mark.parametrize("reason", ["Empty audio file", "Mixed album metadata in one folder"])
def test_physical_reason_exclusion_round_trips_and_hides_only_exact_file(reason):
    row = _row()
    row["file_size"] = 0
    row["file_entry"]["size"] = 0
    row["file_mixed_album_folder"] = True
    path = row["file_private_path"]
    key = browse._problem_identity_row_key(path, reason, scope="file")
    rule = browse._utility_problem_ignore_payload({
        "ignored_repair_key": key, "file_private_path": path,
        "file_entry": row["file_entry"], "alias_to_canonical": {},
    })
    assert rule["row_key"] == key
    assert rule["problem_reason"] == reason
    assert rule["scope"] == "file"
    assert rule["path"] == path
    row["ignored_repair_keys"] = [key]
    _, detail = _payloads(row)
    assert all(reason not in item["reasons"] for item in detail["track_problem_rows"])
    other_reason = ({"Empty audio file", "Mixed album metadata in one folder"} - {reason}).pop()
    assert any(other_reason in item["reasons"] for item in detail["track_problem_rows"])
    assert not browse._problem_reason_is_ignored({key}, path + ".other", reason, scope="file")


@pytest.mark.parametrize("reason", ["Empty audio file", "Mixed album metadata in one folder"])
def test_physical_reason_album_exclusion_preserves_summary_detail_parity(reason):
    row = _row()
    row["file_size"] = 0
    row["file_entry"]["size"] = 0
    row["file_mixed_album_folder"] = True
    album = browse._problematic_album_projection_payloads([row])[0]
    identity = str(album.get("album_ref") or album["key"])
    row["ignored_repair_keys"] = [browse._problem_identity_row_key(identity, reason, scope="album")]
    for payload in _payloads(row):
        assert reason not in payload["problem_reasons"]


@pytest.mark.parametrize("canonical,cached,expected", [(0, 1024, True), (1024, 0, False), (None, 0, False)])
def test_canonical_file_size_controls_empty_detection(canonical, cached, expected):
    row = _row()
    row["file_size"] = canonical
    row["file_entry"]["size"] = cached
    for payload in _payloads(row):
        assert ("Empty audio file" in (payload or {}).get("problem_reasons", [])) is expected


def test_repository_count_and_cached_items_follow_physical_reason_exclusion(monkeypatch):
    from uuid import uuid4

    class SnapshotConnection:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, sql, params=None):
            assert str(sql) in {
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
                "SET LOCAL work_mem = '16MB'", "SET LOCAL jit = off",
            }

    url = "postgresql://isolated-physical-count/" + uuid4().hex
    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": url}, connect=lambda *_args, **_kwargs: SnapshotConnection())
    row = _row()
    row["file_size"] = 0
    row["file_entry"]["size"] = 0
    monkeypatch.setattr(repository, "_load_problematic_file_rows", lambda **_kwargs: [row])
    monkeypatch.setattr(repository, "_load_missing_album_rows", lambda **_kwargs: [])
    monkeypatch.setattr(repository, "_load_relation_alias_maps", lambda **_kwargs: {})
    try:
        first = repository.build_problematic_files_payload()
        assert first["count"] == 1
        assert first["items"][0]["problem_reasons"] == ["Empty audio file"]
        assert first["initial_detail"]["problem_reasons"] == ["Empty audio file"]
        cached = repository.build_problematic_files_payload()
        assert cached["projection_cache_status"] == "hit"
        assert cached["count"] == 1
        row["ignored_repair_keys"] = [browse._problem_identity_row_key(
            row["file_private_path"], "Empty audio file", scope="file")]
        browse.invalidate_postgres_utility_projection_cache(database_url=url, kinds=["problematic-files"])
        excluded = repository.build_problematic_files_payload()
        assert excluded["count"] == 0
        assert excluded["items"] == []
        assert excluded["initial_detail"] is None
    finally:
        browse.invalidate_postgres_utility_projection_cache(database_url=url)
