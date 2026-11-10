"""Bounded server-authorized retention of an album's persisted primary.

Production repository and ASGI paths use synthetic transports only. These do
not replace real PostgreSQL locking, constraint, or migration verification.
"""
from copy import deepcopy
import json
import shutil
from uuid import uuid4

import pytest

from music_app.services import covers
from music_app.services.ordered_cover_references import OrderedCoverSelectionConflict
from tests.py.cover_unit_safety import cover_unit_transports  # noqa: F401
from tests.py.test_ordered_cover_save import saved as base_saved  # noqa: F401
from tests.py.test_ordered_cover_save_asgi import api, actor, BODY, reader  # noqa: F401
from tests.py.test_ordered_cover_save_review_regressions import integrated_api  # noqa: F401


RETAIN = {"retain_current": True, "expected_primary": "a" * 64}
REMOTE_URL = "https://images.example.test/legacy-front.jpg"
MALFORMED = [
    [{**RETAIN, "retain_current": value}] for value in (False, None, 0, 1, "true", [], {})
] + [
    [{"retain_current": True}],
    *[[{**RETAIN, "expected_primary": value}] for value in (None, 1, "", "A" * 64, "g" * 64, "a" * 63)],
    [{**RETAIN, "selection_id": "front"}],
    [{**RETAIN, "kind": "local", "path": "/private/forged.jpg"}],
    [{**RETAIN, "url": "https://arbitrary.invalid/front.jpg"}],
    [{**RETAIN, "candidate_id": "other"}],
    [{**RETAIN, "extra": True}],
    [RETAIN, RETAIN],
    [RETAIN, {"selection_id": "a"}, {"selection_id": "b"}, {"selection_id": "c"}],
]


@pytest.fixture
def saved(base_saved):
    base_saved.connection.saved["library_id"] = 23
    return base_saved


def selector(saved):
    from music_app.services.ordered_cover_selection import current_cover_token
    row = saved.connection.saved
    row["library_id"] = 23
    return {"retain_current": True, "expected_primary": current_cover_token(
        album_id=row["album_id"], library_id=23,
        cover_path=row["cover_path"], metadata=row["metadata"])}


def legacy(saved, kind):
    """Only persisted server state supplies this reference; no client source."""
    row = saved.connection.saved
    row["metadata"] = {"unrelated": {"preserve": True}, "cover_selection_origin": "automatic"}
    if kind == "remote":
        row["cover_path"] = None
        row["metadata"].update(remote_cover_url=REMOTE_URL, remote_cover_source="legacy")
    else:
        row["cover_path"] = str(saved.first)
        saved.first.unlink()
    return row


@pytest.mark.parametrize("references", MALFORMED)
def test_retain_current_shape_is_exact_and_unique_before_connect(saved, references):
    with pytest.raises(ValueError):
        saved.save(references=references)
    assert saved.connects == []


@pytest.mark.parametrize("references", MALFORMED)
def test_http_rejects_malformed_retain_without_repository(api, references):
    status, _ = api.request({**BODY, "references": references})
    assert status == 422
    assert not any(name in {"save", "commit", "invalidate"} for name, _ in api.calls)


@pytest.mark.parametrize("kind", ["local", "remote"])
def test_explicit_retain_legacy_primary_is_reference_only_and_manual(saved, monkeypatch, kind):
    legacy(saved, kind)
    def forbid(*args, **kwargs):
        pytest.fail("Retaining the persisted primary must not inspect or copy image bytes")
    monkeypatch.setattr(covers, "image_dimensions", forbid)
    monkeypatch.setattr(shutil, "copyfile", forbid)
    monkeypatch.setattr(shutil, "copy2", forbid)
    result = saved.save(expected_revision=0, references=[selector(saved)], album_root=None)
    item = result["selected_covers"][0]
    assert item["kind"] == kind and item["selection_id"]
    assert item["path" if kind == "local" else "url"] == (str(saved.first) if kind == "local" else REMOTE_URL)
    assert result["changed"] is True and result["selected_covers_revision"] == 1
    persisted = saved.connection.saved["metadata"]
    assert persisted["cover_selection_origin"] == "user"
    assert persisted["cover_selection_provenance"] == "explicit"
    assert persisted["unrelated"] == {"preserve": True}
    assert "retain_current" not in json.dumps(persisted)
    assert "snapshot" not in saved.connection.events and "roots" not in saved.connection.events
    assert saved.connection.events.index("album-lock") < saved.connection.events.index("persist")
    assert saved.connection.file_projection == saved.connection.saved
    assert saved.first.exists() is (kind == "remote")


@pytest.mark.parametrize("kind", ["local", "remote"])
def test_retain_legacy_add_then_reorder_and_replay(saved, kind):
    legacy(saved, kind)
    references = [{"kind": "local", "path": str(saved.second)}, selector(saved)]
    first = saved.save(expected_revision=0, references=references)
    assert first["selected_covers"][0]["path"] == str(saved.second)
    retained = first["selected_covers"][1]
    assert retained["kind"] == kind
    # The request itself changed the primary: replay must not resolve RETAIN
    # again and accidentally replace the saved secondary with the new primary.
    replay = saved.save(expected_revision=0, references=references)
    assert replay["replayed"] is True and replay["selected_covers"] == first["selected_covers"]
    reordered = saved.save(expected_revision=1, mutation_id=str(uuid4()), references=[
        {"selection_id": retained["selection_id"]},
        {"selection_id": first["selected_covers"][0]["selection_id"]}])
    assert reordered["selected_covers"][0] == retained
    assert reordered["selected_covers_revision"] == 2
    assert saved.connection.events.count("revision") == 2


def test_existing_primary_retain_preserves_id_and_noop_revision(saved):
    result = saved.save(references=[selector(saved), {"selection_id": "back"}])
    assert [item["selection_id"] for item in result["selected_covers"]] == ["front", "back"]
    assert result["changed"] is False and result["selected_covers_revision"] == 3
    assert "revision" not in saved.connection.events
    replay = saved.save(references=[selector(saved), {"selection_id": "back"}])
    assert replay["replayed"] is True and replay["selected_covers"] == result["selected_covers"]


@pytest.mark.parametrize("override", [{"expected_revision": 2}, {"expected_album_id": 73}])
def test_retain_never_bypasses_concrete_version_or_revision(saved, override):
    before = deepcopy(saved.connection.saved)
    with pytest.raises(OrderedCoverSelectionConflict):
        saved.save(references=[selector(saved)], **override)
    assert saved.connection.saved == before and saved.connection.commits == 0


def test_retain_respects_revision_cas(saved):
    before = deepcopy(saved.connection.saved)
    saved.connection.reject_cas = True
    retained = selector(saved)
    with pytest.raises(OrderedCoverSelectionConflict):
        saved.save(references=[retained])
    assert saved.connection.saved == before and saved.connection.commits == 0


def test_absent_persisted_primary_cannot_be_fabricated(saved):
    saved.connection.saved.update(cover_path=None, metadata={})
    before = deepcopy(saved.connection.saved)
    with pytest.raises((ValueError, OrderedCoverSelectionConflict)):
        saved.save(expected_revision=0, references=[RETAIN])
    assert saved.connection.saved == before and saved.connection.commits == 0


def test_retain_token_rejects_changed_legacy_primary_before_save(saved):
    legacy(saved, "local")
    retained = selector(saved)
    saved.connection.saved["cover_path"] = str(saved.second)
    before = deepcopy(saved.connection.saved)
    with pytest.raises(OrderedCoverSelectionConflict):
        saved.save(expected_revision=0, references=[retained])
    assert saved.connection.saved == before and saved.connection.commits == 0


def test_retain_token_binds_library_album_and_source(saved):
    from music_app.services.ordered_cover_selection import current_cover_token
    legacy(saved, "local")
    row = saved.connection.saved
    fields = dict(album_id=72, library_id=23, cover_path=row["cover_path"], metadata=row["metadata"])
    token = current_cover_token(**fields)
    assert len(token) == 64 and set(token) <= set("0123456789abcdef")
    for override in ({"album_id": 73}, {"library_id": 24}, {"cover_path": str(saved.second)}):
        assert current_cover_token(**{**fields, **override}) != token


@pytest.mark.parametrize("field,value", [("album_id", 73), ("library_id", 24)])
def test_retain_token_from_other_scope_cannot_authorize_save(saved, field, value):
    from music_app.services.ordered_cover_selection import current_cover_token
    retained = selector(saved)
    fields = dict(album_id=72, library_id=23, cover_path=str(saved.first), metadata=saved.connection.saved["metadata"])
    retained["expected_primary"] = current_cover_token(**{**fields, field: value})
    before = deepcopy(saved.connection.saved)
    with pytest.raises(OrderedCoverSelectionConflict):
        saved.save(references=[retained])
    assert saved.connection.saved == before and saved.connection.commits == 0


@pytest.mark.parametrize("kind", ["local", "remote"])
def test_http_legacy_retain_requires_write_but_not_remote_read(integrated_api, kind):
    api, saved, _ = integrated_api
    legacy(saved, kind)
    status, body = api.request({**BODY, "expected_revision": 0, "references": [selector(saved)]})
    assert status == 200 and body["changed"] is True
    assert body["selected_covers"][0]["kind"] == kind
    assert "url" not in body["selected_covers"][0] and "path" not in body["selected_covers"][0]
    assert saved.connection.saved["metadata"]["cover_selection_provenance"] == "explicit"


def test_http_retain_cannot_bypass_cover_write(api):
    api.resolver.user = actor("library.covers.remote.read")
    status, _ = api.request({**BODY, "references": [RETAIN]})
    assert status == 403
    assert not any(name == "save" for name, _ in api.calls)


def test_http_retain_cannot_cross_library(api):
    api.context["library_id"] = 99
    status, _ = api.request({**BODY, "references": [RETAIN]})
    assert status == 404
    assert not any(name == "save" for name, _ in api.calls)


def test_http_retain_does_not_authorize_new_remote_candidate(api):
    status, _ = api.request({**BODY, "references": [RETAIN, {
        "kind": "remote", "candidate_id": "candidate",
        "candidate_generation": "e2f769fb-83d5-4f29-8a1a-fb319023e3cd"}]})
    assert status == 403
    assert not any(name == "save" for name, _ in api.calls)


def test_http_retain_and_same_saved_source_are_duplicate(integrated_api):
    api, saved, _ = integrated_api
    retained = selector(saved)
    before = deepcopy(saved.connection.saved)
    status, _ = api.request({**BODY, "references": [retained, {"selection_id": "front"}]})
    assert status == 422
    assert saved.connection.saved == before and saved.connection.commits == 0


@pytest.mark.parametrize("kind", ["local", "remote"])
def test_get_never_infers_manual_selection_from_legacy_primary(reader, kind):
    api, metadata = reader
    metadata.clear()
    metadata.update(cover_selection_origin="automatic")
    metadata["selected_cover_path" if kind == "local" else "remote_cover_url"] = (
        "/private/legacy.jpg" if kind == "local" else REMOTE_URL)
    before = deepcopy(metadata)
    status, body = api.request(method="GET")
    assert status == 200 and body["selected_covers"] == []
    assert body["selected_covers_revision"] == 0
    from music_app.services.ordered_cover_selection import current_cover_token
    assert body["current_cover_token"] == current_cover_token(
        album_id=72, library_id=23, cover_path=metadata.get("selected_cover_path"), metadata=metadata)
    assert REMOTE_URL not in json.dumps(body) and "/private/legacy.jpg" not in json.dumps(body)
    assert metadata == before
    assert not any(name in {"save", "commit", "invalidate"} for name, _ in api.calls)


def test_legacy_primary_changed_while_waiting_source_lock_conflicts(saved):
    legacy(saved, "local")
    retained = selector(saved)
    before = deepcopy(saved.connection.saved)
    def change_locked_primary():
        saved.connection.pending["cover_path"] = str(saved.second)
    saved.connection.after_source_lock = change_locked_primary
    with pytest.raises(OrderedCoverSelectionConflict):
        saved.save(expected_revision=0, references=[retained])
    assert saved.connection.after_source_lock is None
    assert saved.connection.saved == before and saved.connection.commits == 0
    assert "persist" not in saved.connection.events


def test_legacy_remote_retains_optional_metadata_without_candidate_lookup(saved):
    row = legacy(saved, "remote")
    fields = {"url": REMOTE_URL, "thumbnail_url": "https://images.example.test/thumb.jpg",
              "source": "legacy", "source_label": "Original source",
              "album_url": "https://images.example.test/album", "width": 640, "height": 800}
    row["metadata"].update({"remote_cover_" + key: value for key, value in fields.items()})
    result = saved.save(expected_revision=0, references=[selector(saved)], album_root=None)
    selected = result["selected_covers"][0]
    assert {key: selected[key] for key in fields} == fields
    assert {key: value for key, value in selected.items() if key != "selection_id"} == {"kind": "remote", **fields}
    assert "snapshot" not in saved.connection.events
    assert saved.connection.saved["metadata"]["cover_selection_provenance"] == "explicit"


def test_missing_legacy_local_primary_never_falls_back_to_linked_remote(saved):
    row = legacy(saved, "local")
    row["metadata"].update(remote_cover_url=REMOTE_URL, remote_cover_source="legacy")
    result = saved.save(expected_revision=0, references=[selector(saved)], album_root=None)
    assert result["selected_covers"][0]["kind"] == "local"
    assert result["selected_covers"][0]["path"] == str(saved.first)
    assert "url" not in result["selected_covers"][0]
    assert saved.connection.saved["cover_path"] == str(saved.first)
    assert not saved.first.exists() and "snapshot" not in saved.connection.events


@pytest.mark.parametrize("field,value", [
    ("width", True), ("height", -1), ("source", {"bad": "object"}),
    ("source_label", "bad\nlabel"), ("thumbnail_url", "file:///private/image.jpg"),
    ("album_url", "https://user:secret@images.example.test/album"),
])
def test_malformed_legacy_remote_metadata_fails_closed(saved, field, value):
    row = legacy(saved, "remote")
    row["metadata"]["remote_cover_" + field] = value
    retained = selector(saved)
    before = deepcopy(row)
    with pytest.raises(ValueError):
        saved.save(expected_revision=0, references=[retained], album_root=None)
    assert saved.connection.saved == before and saved.connection.commits == 0
    assert "persist" not in saved.connection.events


def test_http_retain_rechecks_revoked_write_before_commit(integrated_api):
    api, saved, _ = integrated_api
    legacy(saved, "local")
    retained = selector(saved)
    before = deepcopy(saved.connection.saved)
    runtime_before = deepcopy(api.app.state.library_state)
    def revoke_write():
        api.resolver.user = actor("library.covers.remote.read")
    saved.connection.after_source_lock = revoke_write
    status, _ = api.request({**BODY, "expected_revision": 0, "references": [retained]})
    assert saved.connection.after_source_lock is None
    assert status == 403
    assert saved.connection.saved == before and saved.connection.commits == 0
    assert api.app.state.library_state == runtime_before
    assert not any(name == "invalidate" for name, _ in api.calls)


def test_http_retain_and_new_local_same_legacy_source_are_duplicate(integrated_api):
    api, saved, _ = integrated_api
    # Use the existing readable source, since a new local selector must pass
    # normal source validation before duplicate identity rejection.
    saved.connection.saved["metadata"] = {"cover_selection_origin": "automatic"}
    retained = selector(saved)
    before = deepcopy(saved.connection.saved)
    status, _ = api.request({**BODY, "expected_revision": 0, "references": [
        retained, {"kind": "local", "path": str(saved.first)}]})
    assert status == 422
    assert saved.connection.saved == before and saved.connection.commits == 0
    assert not any(name == "invalidate" for name, _ in api.calls)


def test_get_empty_legacy_primary_omits_current_cover_token(reader):
    api, metadata = reader
    metadata.clear()
    status, body = api.request(method="GET")
    assert status == 200
    assert body == {"ok": True, "album_ref": "72", "selected_covers_revision": 0, "selected_covers": []}
    assert metadata == {}
    assert not any(name in {"save", "commit", "invalidate"} for name, _ in api.calls)


def test_current_token_normalizes_equivalent_windows_paths():
    from music_app.services.ordered_cover_selection import current_cover_token
    def token(path):
        return current_cover_token(album_id=72, library_id=23, cover_path=path, metadata={})
    assert token(r"C:\Music\Album\Front.JPG") == token("c:/music/album/front.jpg")
    assert token(r"C:\Music\Album\Front.JPG") != token(r"C:\Music\Other\Front.JPG")


@pytest.mark.parametrize("scheme,port", [("http", 80), ("https", 443)])
def test_current_token_normalizes_remote_host_port_but_preserves_path_query_case(scheme, port):
    from music_app.services.ordered_cover_selection import current_cover_token
    def token(url):
        return current_cover_token(album_id=72, library_id=23, cover_path=None,
                                   metadata={"remote_cover_url": url})
    canonical = token(f"{scheme}://images.example.test/Front.jpg?edition=A")
    assert canonical == token(f"{scheme}://IMAGES.EXAMPLE.TEST:{port}/Front.jpg?edition=A")
    assert canonical != token(f"{scheme}://images.example.test/front.jpg?edition=A")
    assert canonical != token(f"{scheme}://images.example.test/Front.jpg?edition=a")
