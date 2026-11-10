"""Read-only ordered cover references, independent of source availability."""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import urllib.request

import pytest

from music_app.services.ordered_cover_references import project_selected_cover_metadata
from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter


REQUEST = {
    "mutation_id": "2cfe2385-c225-4501-9a71-3d7fc286b3d1",
    "request_hash": "a1" * 32,
}


def local(selection_id="local-1", path="/unavailable/album/Front.jpg"):
    return {"selection_id": selection_id, "kind": "local", "path": path}


def remote(selection_id="remote-1", url="https://covers.example/Front.jpg?Key=A"):
    return {"selection_id": selection_id, "kind": "remote", "url": url}


def metadata(*covers, revision=0):
    return {"selected_covers": list(covers), "selected_covers_revision": revision}


@pytest.mark.parametrize("legacy", [
    {},
    {"selected_cover_path": "/old/front.jpg", "cover_selection_origin": "user"},
    {"remote_cover_url": "https://covers.example/old.jpg", "cover_selection_provenance": "explicit"},
    {"selected_covers_revision": 3, "selected_covers_last_request": REQUEST},
])
def test_missing_ordered_set_never_promotes_legacy_selection(legacy):
    assert project_selected_cover_metadata(legacy) == {}


@pytest.mark.parametrize("value", [None, [], "{}", 0, True])
def test_legacy_nonobject_metadata_has_no_ordered_set(value):
    assert project_selected_cover_metadata(value) == {}


@pytest.mark.parametrize("count", [1, 2, 3])
def test_preserves_order_and_reference_values_without_accessing_sources(monkeypatch, count):
    covers = [
        remote(url="HTTPS://Covers.Example:443/Front.JPG?Key=AbC&x=%2F"),
        local(),
        local("windows", r"Z:\Unavailable\Album\Back.jpg"),
    ][:count]
    original = metadata(*covers, revision=17)
    original["selected_covers_last_request"] = deepcopy(REQUEST)
    original["unrelated_metadata"] = {"do_not_project": True}
    before = deepcopy(original)

    def forbidden(*args, **kwargs):
        raise AssertionError("Projecting references must not access files or the network")

    with monkeypatch.context() as patch:
        patch.setattr("builtins.open", forbidden)
        patch.setattr(Path, "stat", forbidden)
        patch.setattr(Path, "open", forbidden)
        patch.setattr(urllib.request, "urlopen", forbidden)
        projected = project_selected_cover_metadata(original)

    assert projected == {key: before[key] for key in (
        "selected_covers", "selected_covers_revision", "selected_covers_last_request"
    )}
    assert original == before
    projected["selected_covers"][0]["selection_id"] = "edited-copy"
    projected["selected_covers"].append(local("extra"))
    projected["selected_covers_last_request"]["request_hash"] = "b" * 64
    assert original == before


def test_remote_optional_metadata_round_trips_without_coercion():
    cover = remote()
    cover.update(thumbnail_url="", source="provider-name", source_label=" Exact Label ",
                 album_url="https://albums.example/Release?ID=AbC", width=0, height=800,
                 art_kind="other", art_label="Booklet", candidate_id="opaque-id",
                 candidate_generation=0)
    original = metadata(cover)
    assert project_selected_cover_metadata(original) == original


@pytest.mark.parametrize("bad_set", [None, {}, "image", (), [], [local()] * 4,
    [None], ["path"], [local(), remote("local-1")]])
def test_rejects_invalid_set_shape_size_or_duplicate_selection_id(bad_set):
    with pytest.raises(ValueError):
        project_selected_cover_metadata({"selected_covers": bad_set, "selected_covers_revision": 0})


@pytest.mark.parametrize("bad_id", [None, "", "   ", 1, True, [], {}])
def test_rejects_invalid_selection_id(bad_id):
    with pytest.raises(ValueError):
        project_selected_cover_metadata(metadata(local(bad_id)))


@pytest.mark.parametrize("revision", [None, True, False, -1, 1.0, "1", [], {}])
def test_rejects_invalid_revision(revision):
    with pytest.raises(ValueError):
        project_selected_cover_metadata(metadata(local(), revision=revision))


def test_requires_revision_for_present_set():
    with pytest.raises(ValueError):
        project_selected_cover_metadata({"selected_covers": [local()]})


@pytest.mark.parametrize("path", ["", "relative.jpg", "../front.jpg", "/album/../front.jpg",
    "https://covers.example/front.jpg", "data:image/png;base64,AAAA", "blob:opaque",
    "file:///album/front.jpg", "C:front.jpg", r"C:\album\..\front.jpg",
    "/album/front\x00.jpg", "/album/front\n.jpg", None, 1])
def test_rejects_invalid_local_source(path):
    with pytest.raises(ValueError):
        project_selected_cover_metadata(metadata(local(path=path)))


@pytest.mark.parametrize("url", ["", "front.jpg", "//covers.example/front.jpg",
    "file:///front.jpg", "data:image/png;base64,AAAA", "blob:opaque", "ftp://covers.example/a",
    "https:///front.jpg", "https://user:secret@covers.example/a", "https://user@covers.example/a",
    "https://covers.example/a#fragment", "https://covers.example/\na.jpg",
    "https://covers.example/\x00a.jpg", None, 1])
def test_rejects_invalid_remote_source(url):
    with pytest.raises(ValueError):
        project_selected_cover_metadata(metadata(remote(url=url)))


@pytest.mark.parametrize("cover", [
    {"selection_id": "one", "kind": "unknown", "path": "/a.jpg"},
    {"selection_id": "one", "path": "/a.jpg"},
    {"kind": "local", "path": "/a.jpg"},
    {"selection_id": "one", "kind": "local"},
    {"selection_id": "one", "kind": "remote"},
    {**local(), "url": "https://covers.example/a"},
    {**remote(), "path": "/a.jpg"},
    {**remote(), "image_bytes": "not-reference-data"},
    {**local(), "width": 200},
])
def test_rejects_unknown_or_mixed_reference_fields(cover):
    with pytest.raises(ValueError):
        project_selected_cover_metadata(metadata(cover))


@pytest.mark.parametrize("field", ["source", "source_label", "art_label", "candidate_id"])
@pytest.mark.parametrize("value", [None, 1, True, {}, []])
def test_optional_remote_text_requires_strings(field, value):
    with pytest.raises(ValueError):
        project_selected_cover_metadata(metadata({**remote(), field: value}))


@pytest.mark.parametrize("field", ["width", "height", "candidate_generation"])
@pytest.mark.parametrize("value", [-1, True, 1.5, "100", None])
def test_optional_remote_numbers_require_nonnegative_exact_integers(field, value):
    with pytest.raises(ValueError):
        project_selected_cover_metadata(metadata({**remote(), field: value}))


@pytest.mark.parametrize("art_kind", ["", "front", "OTHER", None, 1])
def test_rejects_unknown_art_kind(art_kind):
    with pytest.raises(ValueError):
        project_selected_cover_metadata(metadata({**remote(), "art_kind": art_kind}))


@pytest.mark.parametrize("field", ["thumbnail_url", "album_url"])
@pytest.mark.parametrize("value", ["file:///a", "https://u:p@covers.example/a", "https://covers.example/a#f", None, 1])
def test_optional_remote_urls_receive_same_validation(field, value):
    with pytest.raises(ValueError):
        project_selected_cover_metadata(metadata({**remote(), field: value}))


@pytest.mark.parametrize("saved_request", [None, [], {},
    {**REQUEST, "extra": "field"}, {"mutation_id": REQUEST["mutation_id"]},
    {**REQUEST, "mutation_id": "not-a-uuid"}, {**REQUEST, "mutation_id": 1},
    {**REQUEST, "request_hash": "A" * 64}, {**REQUEST, "request_hash": "a" * 63},
    {**REQUEST, "request_hash": "g" * 64}, {**REQUEST, "request_hash": None},
])
def test_rejects_invalid_last_request(saved_request):
    with pytest.raises(ValueError):
        project_selected_cover_metadata({**metadata(local()), "selected_covers_last_request": saved_request})


@pytest.mark.parametrize("first,second", [
    (remote("a", "HTTPS://Covers.Example/a?Key=X"), remote("b", "https://covers.example:443/a?Key=X")),
    (remote("a", "http://covers.example/a"), remote("b", "HTTP://COVERS.EXAMPLE:80/a")),
    (local("a", r"C:\Album\Front.jpg"), local("b", "c:/album/front.JPG")),
    (local("a", "/album/./front.jpg"), local("b", "/album/front.jpg")),
])
def test_rejects_duplicate_lexically_normalized_sources(first, second):
    with pytest.raises(ValueError):
        project_selected_cover_metadata(metadata(first, second))


@pytest.mark.parametrize("first,second", [
    (remote("a", "https://covers.example/Front.jpg"), remote("b", "https://covers.example/front.jpg")),
    (remote("a", "https://covers.example/a?Key=A"), remote("b", "https://covers.example/a?Key=a")),
    (local("a", "/album/Front.jpg"), local("b", "/album/front.jpg")),
])
def test_distinct_case_sensitive_sources_are_not_deduplicated(first, second):
    original = metadata(first, second)
    assert project_selected_cover_metadata(original) == original


class RecordingConnection:
    def __init__(self, rows):
        self.rows = rows
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def execute(self, sql, params):
        self.operations.append((sql, params))
        assert sql.lstrip().lower().startswith("select "), "Cover reads must never write"
        return self

    def fetchall(self):
        return deepcopy(self.rows)

    def commit(self):
        raise AssertionError("Cover reads must not commit")


def adapter_for(rows):
    connection = RecordingConnection(rows)
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/reference_test"},
        connect=lambda _: connection,
    )
    return adapter, connection


def test_adapter_loads_ordered_sets_independently_and_preserves_singular_fields():
    first = metadata(local(), remote(), revision=4)
    second = metadata(remote("other", "https://other.example/back.jpg"), revision=8)
    first["selected_covers_last_request"] = deepcopy(REQUEST)
    adapter, connection = adapter_for([
        {"album_id": 9, "cover_path": " /legacy/first.jpg ", "cover_selection_origin": "user",
         "cover_selection_provenance": "explicit", "cover_revision": "legacy-rev",
         "remote_cover_url": "https://legacy.example/a", "remote_cover_width": 120,
         "remote_cover_height": 130, "selected_cover_metadata": first},
        {"album_id": 12, "selected_cover_metadata": second},
    ])
    result = adapter.load_cover_selections({12, 9})
    assert result == {
        9: {"selected_cover_path": "/legacy/first.jpg", "cover_selection_origin": "user",
            "cover_selection_provenance": "explicit", "cover_revision": "legacy-rev",
            "remote_cover_url": "https://legacy.example/a", "remote_cover_width": 120,
            "remote_cover_height": 130, **first},
        12: {"selected_cover_path": None, "cover_selection_origin": None, **second},
    }
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    assert params == {"album_ids": [9, 12], "source": "runtime_scan_cache"}
    normalized = " ".join(sql.lower().split())
    for required in (
        "album.metadata as selected_cover_metadata", "album.id = any(%(album_ids)s::bigint[])",
        "lib.id = album.library_id", "owner.account_id = lib.owner_account_id",
        "owner.owner_key = 'local-bootstrap-owner'", "lib.library_kind = 'local'",
        "track.library_id = album.library_id", "root.library_id = album.library_id",
        "root.is_active is true", "file.scan_cache_stale is false",
    ):
        assert required in normalized


@pytest.mark.parametrize("legacy_metadata", [
    {"cover_selection_origin": "inherited"}, None, [], "legacy", 0, True,
])
def test_adapter_legacy_row_does_not_manufacture_ordered_set_or_provenance(legacy_metadata):
    adapter, _ = adapter_for([{"album_id": 1, "cover_path": "/legacy/a.jpg",
        "selected_cover_metadata": legacy_metadata}])
    assert adapter.load_cover_selections({1}) == {
        1: {"selected_cover_path": "/legacy/a.jpg", "cover_selection_origin": None}
    }


def test_adapter_rejects_corrupt_saved_set_instead_of_silently_discarding_it():
    adapter, connection = adapter_for([
        {"album_id": 1, "selected_cover_metadata": metadata(local())},
        {"album_id": 2, "selected_cover_metadata": metadata(local(), {"kind": "local"})},
    ])
    with pytest.raises(ValueError):
        adapter.load_cover_selections({1, 2})
    assert len(connection.operations) == 1


def test_adapter_empty_album_ids_does_not_open_database():
    def forbidden_connect(*args):
        raise AssertionError("No database access is needed for an empty selection")

    adapter = PostgresScanCacheAdapter({}, connect=forbidden_connect)
    assert adapter.load_cover_selections(set()) == {}
