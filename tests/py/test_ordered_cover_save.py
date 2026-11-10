"""Reference-only Save contracts with strict synthetic database boundaries.

These run the production repository but do not execute PostgreSQL. Real database
rollback, constraints and multiprocess locking remain a separate required gate.
"""
from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

from PIL import Image

import pytest

from music_app.services import scan_cache_persistence as persistence
from music_app.services.ordered_cover_references import OrderedCoverSelectionConflict
from tests.py.cover_unit_safety import cover_unit_transports  # noqa: F401


MUTATION = "9a7263b5-d83b-4892-8684-9b475f7ded41"


def local(path, selection_id="front"):
    return {"selection_id": selection_id, "kind": "local", "path": str(path)}


def metadata(*references, revision=3):
    return {"selected_covers": list(references), "selected_covers_revision": revision,
            "unrelated": {"preserve": True}}


class Connection:
    """Transactional state double; unknown SQL fails instead of hitting a DB."""
    def __init__(self, row):
        self.saved = deepcopy(row)
        self.pending = None
        self.rows = []
        self.operations = []
        self.events = []
        self.failure = None
        self.after_source_lock = None
        self.info = SimpleNamespace(transaction_status=2)
        self.commits = 0
        self.transaction_revision_changed = False
        self.reject_cas = False
        self.revision = 0
        self.snapshot = None
        self.root_settings = None
        self.file_projection = None
        self.pending_projection = None

    def __enter__(self):
        self.pending = deepcopy(self.saved)
        self.pending_projection = deepcopy(self.file_projection)
        self.transaction_revision_changed = False
        self.events.append("enter")
        return self

    def __exit__(self, typ, value, tb):
        self.events.append("rollback" if typ else "exit")
        self.pending = None

    def execute(self, sql, params=None):
        self.operations.append((sql, params))
        normalized = " ".join(sql.lower().split())
        self.rows = []
        if "pg_advisory_xact_lock_shared" in normalized:
            self.events.append("inventory-lock")
        elif params and "source_key" in params:
            self.events.append("source-lock")
            if self.after_source_lock:
                callback, self.after_source_lock = self.after_source_lock, None
                callback()
        elif "as bootstrap_context_ready" in normalized:
            self.rows = [{"bootstrap_context_ready": 1}]
        elif "from target_album" in normalized and "albums.metadata" in normalized:
            self.events.append("album-lock" if "for no key update" in normalized else "scope-read")
            self.rows = [deepcopy(self.pending)] if self.pending else []
        elif sql == persistence._load_cover_selections_sql():
            self.rows = [{**deepcopy(self.saved), "selected_cover_metadata": deepcopy(self.saved["metadata"])}] if self.saved else []
        elif "from library.local_album_cover_candidate_snapshots" in normalized:
            assert params["album_id"] == self.pending["album_id"]
            assert "album-lock" in self.events
            self.events.append("snapshot")
            self.rows = [deepcopy(self.snapshot)] if self.snapshot else []
        elif hasattr(persistence, "_persist_ordered_cover_selection_sql") and sql == persistence._persist_ordered_cover_selection_sql():
            self.events.append("persist")
            assert params["album_id"] == self.pending["album_id"]
            if self.failure == "persist":
                raise RuntimeError("injected persist failure")
            if self.reject_cas or self.pending["metadata"].get("selected_covers_revision", 0) != params["expected_revision"]:
                return self
            patch = params["metadata"]
            patch = patch.obj if hasattr(patch, "obj") else patch
            self.pending["metadata"].update(deepcopy(patch))
            self.pending["cover_path"] = params["cover_path"]
            self.rows = [{"album_id": self.pending["album_id"]}]
        elif sql == persistence._synchronize_album_cover_file_entries_sql(by_album_ids=True):
            self.events.append("projection")
            assert params["album_ids"] == [self.pending["album_id"]]
            assert params["active_paths"] == []
            self.pending_projection = deepcopy(self.pending)
            if self.failure == "projection":
                raise RuntimeError("injected projection failure")
        elif "select library.library_root_settings.settings_payload" in normalized:
            assert self.pending is not None and "album-lock" in self.events
            assert "bootstrap_context.library_id = library.library_root_settings.library_id" in normalized
            self.events.append("roots")
            self.rows = [{"settings_payload": deepcopy(self.root_settings)}] if self.root_settings else []
        elif sql == persistence._load_inventory_mutation_revision_sql():
            self.rows = [{"inventory_mutation_revision": self.revision}]
        elif sql == persistence._increment_cover_mutation_revision_sql():
            self.events.append("revision")
            self.transaction_revision_changed = True
            if self.failure == "revision":
                raise RuntimeError("injected revision failure")
        else:
            pytest.fail(f"Unrecognized synthetic repository SQL: {normalized[:220]}")
        return self

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return deepcopy(self.rows)

    def commit(self):
        self.events.append("commit")
        if self.failure == "commit":
            raise RuntimeError("injected commit failure")
        self.commits += 1
        self.saved = deepcopy(self.pending)
        self.file_projection = deepcopy(self.pending_projection)
        if self.transaction_revision_changed:
            self.revision += 1
        if self.failure == "lost-response":
            self.info.transaction_status = 0
            raise RuntimeError("commit response lost")


@pytest.fixture
def saved(monkeypatch, tmp_path):
    root = tmp_path / "album"
    root.mkdir()
    first, second = root / "front.jpg", root / "back.jpg"
    Image.new("RGB", (20, 20), "red").save(first)
    Image.new("RGB", (20, 20), "blue").save(second)
    row = {"album_id": 72, "cover_path": str(first),
           "metadata": metadata(local(first), local(second, "back"))}
    connection = Connection(row)
    connects = []
    def connect(_):
        connects.append(True)
        return connection
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/ordered_save",
              "_library_root_paths_snapshot": (root,), "IMAGE_EXTENSIONS": {".jpg", ".png"}}
    connection.root_settings = {"main_library_roots": [{"path": str(root)}]}
    adapter = persistence.PostgresScanCacheAdapter(config, connect=connect)
    def save(**overrides):
        return adapter.persist_ordered_cover_selection(**{
            "track_paths": {str(root / "track.flac")}, "album_root": root,
            "expected_album_id": 72, "expected_revision": 3, "mutation_id": MUTATION,
            "references": [{"selection_id": "back"}, {"selection_id": "front"}], **overrides})
    return SimpleNamespace(adapter=adapter, connection=connection, connects=connects,
                           root=root, first=first, second=second, save=save)


@pytest.mark.parametrize("references", [None, [], {}, "front", [None],
    [{"selection_id": "front"}] * 4,
    [{"kind": "remote", "url": "https://arbitrary.invalid/a.jpg"}],
    [{"kind": "local", "path": "/somewhere/front.jpg", "selection_id": "forged"}],
    [{"selection_id": "front", "extra": "field"}],
])
def test_invalid_selector_shape_fails_before_connect(saved, references):
    with pytest.raises(ValueError):
        saved.save(references=references)
    assert saved.connects == []


@pytest.mark.parametrize("field,value", [
    ("expected_revision", -1), ("expected_revision", True), ("expected_revision", "3"),
    ("mutation_id", "not-a-uuid"), ("mutation_id", None),
    ("expected_album_id", True), ("expected_album_id", 0),
])
def test_invalid_request_identity_fails_before_connect(saved, field, value):
    with pytest.raises(ValueError):
        saved.save(**{field: value})
    assert saved.connects == []


@pytest.mark.parametrize("override", [{"expected_revision": 2}, {"expected_album_id": 73}])
def test_stale_concrete_version_or_revision_never_changes_state(saved, override):
    before = deepcopy(saved.connection.saved)
    with pytest.raises(OrderedCoverSelectionConflict):
        saved.save(**override)
    assert saved.connection.saved == before
    assert saved.connection.commits == 0
    assert "revision" not in saved.connection.events


def test_unknown_retained_id_is_not_resolved_from_another_album(saved):
    before = deepcopy(saved.connection.saved)
    with pytest.raises((ValueError, OrderedCoverSelectionConflict)):
        saved.save(references=[{"selection_id": "another-album-cover"}])
    assert saved.connection.saved == before
    assert saved.connection.commits == 0


def test_save_reorders_existing_references_without_rewriting_source_bytes(saved):
    before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in (saved.first, saved.second)}
    result = saved.save()
    assert result["changed"] is True and result["replayed"] is False
    assert result["selected_covers_revision"] == 4
    assert [item["selection_id"] for item in result["selected_covers"]] == ["back", "front"]
    assert saved.connection.saved["cover_path"] == str(saved.second)
    assert saved.connection.saved["metadata"]["unrelated"] == {"preserve": True}
    assert saved.connection.saved["metadata"]["cover_selection_origin"] == "user"
    assert saved.connection.saved["metadata"]["cover_selection_provenance"] == "explicit"
    assert saved.connection.file_projection == saved.connection.saved
    assert before == {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in before}
    events = saved.connection.events
    assert events.index("inventory-lock") < events.index("source-lock") < events.index("album-lock")
    assert events.index("persist") < events.index("projection") < events.index("revision") < events.index("commit")


@pytest.mark.parametrize("count", [1, 2, 3])
def test_new_local_choices_have_stable_ids_and_support_exact_bounded_order(saved, count):
    third = saved.root / "inside.png"
    Image.new("RGB", (20, 20), "green").save(third)
    paths = [saved.second, third, saved.first][:count]
    result = saved.save(references=[{"kind": "local", "path": str(path)} for path in paths])
    assert [item["path"] for item in result["selected_covers"]] == list(map(str, paths))
    ids = {item["path"]: item["selection_id"] for item in result["selected_covers"]}
    assert ids[str(saved.second)] == "back"
    assert len(set(ids.values())) == count
    result2 = saved.save(expected_revision=4, mutation_id=str(uuid4()),
                         references=[{"selection_id": item["selection_id"]} for item in result["selected_covers"]])
    assert result2["selected_covers"] == result["selected_covers"]
    assert result2["changed"] is False and result2["selected_covers_revision"] == 4


def test_missing_existing_source_can_remain_primary_and_reorder(saved):
    saved.second.unlink()
    result = saved.save()
    assert result["selected_covers"][0] == local(saved.second, "back")
    assert saved.connection.saved["cover_path"] == str(saved.second)
    assert not saved.second.exists()


def test_latest_request_replay_ignores_stale_revision_without_second_write(saved):
    first = saved.save()
    before = deepcopy(saved.connection.saved)
    writes = sum(event == "persist" for event in saved.connection.events)
    replay = saved.save()
    assert replay["selected_covers"] == first["selected_covers"]
    assert replay["selected_covers_revision"] == first["selected_covers_revision"]
    assert replay["changed"] is False and replay["replayed"] is True
    assert saved.connection.saved == before
    assert sum(event == "persist" for event in saved.connection.events) == writes


def test_same_request_uuid_cannot_be_reused_with_another_body(saved):
    saved.save()
    before = deepcopy(saved.connection.saved)
    with pytest.raises(OrderedCoverSelectionConflict):
        saved.save(references=[{"selection_id": "front"}])
    assert saved.connection.saved == before


def test_competing_drafts_from_same_revision_cannot_silently_overwrite(saved):
    saved.save()
    before = deepcopy(saved.connection.saved)
    with pytest.raises(OrderedCoverSelectionConflict):
        saved.save(mutation_id=str(uuid4()), references=[{"selection_id": "front"}])
    assert saved.connection.saved == before


@pytest.mark.parametrize("stage", ["persist", "projection", "revision", "commit"])
def test_repository_failure_rolls_back_reference_primary_and_projection_together(saved, stage):
    before = deepcopy(saved.connection.saved)
    saved.connection.failure = stage
    with pytest.raises(RuntimeError, match=f"injected {stage} failure"):
        saved.save()
    assert saved.connection.saved == before
    assert saved.connection.file_projection is None
    assert saved.connection.commits == 0
    assert saved.connection.events[-1] == "rollback"


def test_guard_rejection_rolls_back_without_publishing_success(saved):
    before = deepcopy(saved.connection.saved)
    def reject(commit):
        raise RuntimeError("stale runtime generation")
    with pytest.raises(RuntimeError, match="stale runtime generation"):
        saved.save(commit_guard=reject)
    assert saved.connection.saved == before and saved.connection.commits == 0


@pytest.mark.parametrize("kind", ["outside", "symlink", "not-image", "missing"])
def test_new_local_source_requires_authorized_existing_album_image(saved, kind, tmp_path):
    path = tmp_path / "outside.jpg"
    Image.new("RGB", (20, 20)).save(path)
    if kind == "symlink":
        alias = saved.root / "alias.jpg"
        alias.symlink_to(path)
        path = alias
    elif kind == "not-image":
        path = saved.root / "notes.jpg"
        path.write_bytes(b"not an image")
    elif kind == "missing":
        path = saved.root / "missing.jpg"
    before = deepcopy(saved.connection.saved)
    with pytest.raises((ValueError, FileNotFoundError, OrderedCoverSelectionConflict)):
        saved.save(references=[{"kind": "local", "path": str(path)}])
    assert saved.connection.saved == before and saved.connection.commits == 0


def test_source_changed_during_lock_wait_rejects_before_persist(saved):
    replacement = saved.root / "replacement.jpg"
    replacement.write_bytes(b"replacement")
    def replace():
        replacement.replace(saved.second)
    saved.connection.after_source_lock = replace
    before = deepcopy(saved.connection.saved)
    with pytest.raises(OrderedCoverSelectionConflict):
        saved.save()
    assert saved.connection.saved == before and "persist" not in saved.connection.events


def test_remote_candidate_is_resolved_from_locked_album_snapshot_and_survives_replacement(saved):
    generation = "e2f769fb-83d5-4f29-8a1a-fb319023e3cd"
    saved.connection.snapshot = {"search_generation": generation, "candidates": [
        {"id": "remote-A", "url": "https://images.example.test/Front.jpg?edition=A", "source": "spotify",
         "width": 600, "height": 700, "art_kind": "cover"}]}
    result = saved.save(references=[{"kind": "remote", "candidate_id": "remote-A", "candidate_generation": generation}])
    selected = result["selected_covers"][0]
    assert selected["url"] == "https://images.example.test/Front.jpg?edition=A"
    assert selected["candidate_id"] == "remote-A"
    assert saved.connection.saved["cover_path"] is None
    assert saved.connection.saved["metadata"]["remote_cover_url"] == selected["url"]
    saved.connection.snapshot = {"search_generation": "new-generation", "candidates": []}
    retained = saved.save(expected_revision=4, mutation_id=str(uuid4()), references=[{"selection_id": selected["selection_id"]}])
    assert retained["selected_covers"] == result["selected_covers"]
    assert retained["changed"] is False


@pytest.mark.parametrize("snapshot", [None,
    {"search_generation": "080c928d-1686-426e-9f9e-76a9d2fb4549", "candidates": [{"id": "wanted", "url": "https://example.test/a.jpg", "art_kind": "cover"}]},
    {"search_generation": "e2f769fb-83d5-4f29-8a1a-fb319023e3cd", "candidates": [{"id": "other", "url": "https://example.test/a.jpg", "art_kind": "cover"}]},
])
def test_new_remote_selector_requires_matching_album_snapshot_candidate_and_generation(saved, snapshot):
    saved.connection.snapshot = snapshot
    before = deepcopy(saved.connection.saved)
    with pytest.raises((ValueError, OrderedCoverSelectionConflict)):
        saved.save(references=[{"kind": "remote", "candidate_id": "wanted", "candidate_generation": "e2f769fb-83d5-4f29-8a1a-fb319023e3cd"}])
    assert "snapshot" in saved.connection.events
    assert "persist" not in saved.connection.events
    assert saved.connection.saved == before and saved.connection.commits == 0


def test_unchanged_save_records_latest_request_without_primary_projection_or_revision_change(saved):
    before = deepcopy(saved.connection.saved)
    result = saved.save(references=[{"selection_id": "front"}, {"selection_id": "back"}])
    assert result["changed"] is False and result["replayed"] is False
    assert result["selected_covers_revision"] == 3
    assert saved.connection.saved["cover_path"] == before["cover_path"]
    assert "cover_selection_provenance" not in saved.connection.saved["metadata"]
    assert saved.connection.saved["metadata"]["selected_covers_last_request"]["mutation_id"] == MUTATION
    assert "projection" not in saved.connection.events and "revision" not in saved.connection.events
    assert saved.connection.revision == 0


def test_precise_global_revision_only_changes_for_changed_selection(saved):
    first = saved.save()
    assert saved.connection.revision == 1
    saved.save()
    assert saved.connection.revision == 1
    saved.save(expected_revision=4, mutation_id=str(uuid4()),
               references=[{"selection_id": item["selection_id"]} for item in first["selected_covers"]])
    assert saved.connection.revision == 1


def test_database_cas_zero_rows_is_conflict_and_does_not_publish(saved):
    saved.connection.reject_cas = True
    before = deepcopy(saved.connection.saved)
    with pytest.raises(OrderedCoverSelectionConflict):
        saved.save()
    assert saved.connection.saved == before and saved.connection.commits == 0
    assert "projection" not in saved.connection.events and "revision" not in saved.connection.events


def test_changed_album_metadata_after_preload_is_rechecked_under_album_lock(saved):
    def competing_writer():
        saved.connection.pending["metadata"]["selected_covers_revision"] = 4
    saved.connection.after_source_lock = competing_writer
    with pytest.raises(OrderedCoverSelectionConflict):
        saved.save()
    assert "persist" not in saved.connection.events and saved.connection.commits == 0


def test_missing_or_foreign_scoped_album_is_rejected_without_mutation(saved):
    saved.connection.saved = None
    with pytest.raises((ValueError, OrderedCoverSelectionConflict)):
        saved.save()
    assert saved.connection.commits == 0 and "persist" not in saved.connection.events


def test_lost_commit_response_can_replay_without_duplicate_write(saved):
    from music_app.services.cover_mutation import CoverMutationCommitUncertainError
    saved.connection.failure = "lost-response"
    with pytest.raises(CoverMutationCommitUncertainError) as error:
        saved.save()
    assert error.value.persisted is None
    assert saved.connection.saved["metadata"]["selected_covers_revision"] == 4
    assert saved.connection.commits == 1
    saved.connection.failure = None
    result = saved.save()
    assert result["replayed"] is True and result["changed"] is False
    assert saved.connection.events.count("persist") == 1
    assert saved.connection.revision == 1


def test_late_publication_failure_reports_persisted_and_replay_recovers(saved):
    from music_app.services.cover_mutation import CoverMutationFinalizationError
    def broken_publish(commit):
        commit()
        raise RuntimeError("publish failed")
    with pytest.raises(CoverMutationFinalizationError) as error:
        saved.save(commit_guard=broken_publish)
    assert error.value.persisted is True
    assert saved.connection.saved["metadata"]["selected_covers_revision"] == 4
    assert saved.save()["replayed"] is True
    assert saved.connection.events.count("persist") == 1


def test_sql_write_and_projection_are_concrete_album_library_scoped_with_cas():
    sql = " ".join(persistence._persist_ordered_cover_selection_sql().lower().split())
    assert "album.id = %(album_id)s" in sql
    assert "album.library_id = lib.id" in sql
    assert "owner.owner_key = 'local-bootstrap-owner'" in sql
    assert "selected_covers_revision" in sql and "= %(expected_revision)s" in sql
    assert "returning album.id as album_id" in sql
    projection = " ".join(persistence._synchronize_album_cover_file_entries_sql(by_album_ids=True).lower().split())
    assert "%(album_ids)s" in projection


@pytest.mark.parametrize("references", [[{"selection_id": "front"}, {"selection_id": "front"}],
    [{"kind": "local", "path": "FRONT"}, {"selection_id": "front"}]])
def test_duplicate_resolved_source_cannot_occupy_multiple_slots(saved, references):
    references = [{**item, "path": str(saved.first)} if "path" in item else item for item in references]
    before = deepcopy(saved.connection.saved)
    with pytest.raises(ValueError):
        saved.save(references=references)
    assert saved.connection.saved == before and saved.connection.commits == 0


@pytest.mark.parametrize("roots", [None, {"main_library_roots": [{"path": "/another-library/root"}]}])
def test_removed_or_foreign_authoritative_root_denies_new_local_source(saved, roots):
    saved.connection.root_settings = roots
    before = deepcopy(saved.connection.saved)
    with pytest.raises(ValueError):
        saved.save(references=[{"kind": "local", "path": str(saved.first)}])
    assert "roots" in saved.connection.events
    assert saved.connection.saved == before and saved.connection.commits == 0


def test_root_lookup_is_same_transaction_and_saved_missing_refs_need_no_root_lookup(saved):
    saved.save(references=[{"kind": "local", "path": str(saved.second)}])
    assert saved.connection.events.count("roots") == 1
    # Exactly one preload and one locked mutation connection; the real root
    # store executes against the latter rather than opening a third connection.
    assert len(saved.connects) == 2
    saved.connection.root_settings = None
    saved.second.unlink()
    result = saved.save(expected_revision=4, mutation_id=str(uuid4()), references=[{"selection_id": "back"}])
    assert result["selected_covers"][0]["path"] == str(saved.second)
    assert saved.connection.events.count("roots") == 1


def test_switching_primary_from_remote_to_local_clears_legacy_remote_projection(saved):
    saved.connection.saved["metadata"].update(remote_cover_url="https://images.example.test/old.jpg", remote_cover_source="spotify")
    saved.save()
    assert saved.connection.saved["cover_path"] == str(saved.second)
    assert saved.connection.saved["metadata"]["remote_cover_url"] is None
    assert saved.connection.saved["metadata"]["remote_cover_source"] is None
    assert saved.connection.file_projection["metadata"]["remote_cover_url"] is None


@pytest.mark.parametrize("url", ["file:///private/a.jpg", "https://user:password@images.example.test/a.jpg", "http://127.0.0.1/a.jpg"])
def test_invalid_server_snapshot_url_cannot_be_persisted_as_selected_reference(saved, url):
    saved.connection.snapshot = {"search_generation": "e2f769fb-83d5-4f29-8a1a-fb319023e3cd", "candidates": [
        {"id": "candidate", "url": url, "art_kind": "cover"}]}
    before = deepcopy(saved.connection.saved)
    with pytest.raises(ValueError):
        saved.save(references=[{"kind": "remote", "candidate_id": "candidate", "candidate_generation": "e2f769fb-83d5-4f29-8a1a-fb319023e3cd"}])
    assert "snapshot" in saved.connection.events
    assert "persist" not in saved.connection.events
    assert saved.connection.saved == before and saved.connection.commits == 0


def test_lost_response_replay_survives_now_unavailable_new_local_source(saved):
    references = [{"kind": "local", "path": str(saved.second)}]
    result = saved.save(references=references)
    saved.second.unlink()
    saved.connection.root_settings = None
    replay = saved.save(references=references)
    assert replay["replayed"] is True
    assert replay["selected_covers"] == result["selected_covers"]
    assert saved.connection.events.count("persist") == 1
