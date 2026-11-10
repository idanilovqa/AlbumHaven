"""Recording contracts for coordinated media effects, not live PostgreSQL tests."""
from pathlib import Path

import pytest

from tests.py.cover_unit_safety import cover_unit_transports  # noqa: F401
from music_app.services import cover_mutation as mutation
from music_app.services import cover_workflow, scan_cache_persistence as persistence
from music_app.services.ordered_cover_references import OrderedCoverSelectionConflict


def ordered(path):
    return {"selected_covers_revision": 3, "selected_covers": [
        {"selection_id": "front", "kind": "local", "path": str(path)},
    ]}


class Connection:
    """Strict SQL recording: an unrecognized repository operation fails the test."""
    def __init__(self, events, scope):
        self.events, self.scope = events, scope
        self.owners = []
        self.rows = []
        self.operations = []
        self.failure = None
        self.source_wait = None
        self.revision = 9
        self.committed = False
        from types import SimpleNamespace
        self.info = SimpleNamespace(transaction_status=2)
        self.open = False

    def __enter__(self):
        self.open = True
        self.events.append("enter")
        return self

    def __exit__(self, *args):
        self.events.append("exit")
        self.open = False

    def execute(self, sql, params=None):
        assert self.open
        self.operations.append((sql, params))
        lower = " ".join(sql.lower().split())
        self.rows = []
        if "pg_advisory_xact_lock_shared" in lower:
            event = "inventory-shared"
        elif params and "source_key" in params:
            event = "source"
            if self.source_wait:
                callback, self.source_wait = self.source_wait, None
                callback()
        elif "as bootstrap_context_ready" in lower:
            event = "bootstrap"
            self.rows = [{"bootstrap_context_ready": 1}]
        elif "for no key update of albums" in lower:
            event = "album"
            self.rows = [self.scope] if self.scope is not None else []
        elif "updated_albums as" in lower:
            event = "persist"
            self.rows = [{"input_path_count": len(params["track_paths"]), "resolved_path_count": len(params["track_paths"]),
                          "selected_album_count": 1, "album_track_file_count": 2,
                          "album_rows_updated": 1, "track_file_rows_updated": 2}]
        elif sql == persistence._increment_cover_mutation_revision_sql():
            event = "revision"
        elif sql == persistence._load_inventory_mutation_revision_sql():
            event = "inventory-revision"
            self.rows = [{"inventory_mutation_revision": self.revision}]
        elif sql == persistence._load_ordered_cover_source_owners_sql():
            event = "owners"
            self.rows = self.owners
        else:
            pytest.fail(f"Unexpected SQL in cover transaction: {lower[:180]}")
        self.events.append(event)
        if self.failure == event:
            raise RuntimeError(f"injected {event} failure")
        return self

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows

    def commit(self):
        self.events.append("commit")
        if self.failure == "commit":
            raise RuntimeError("injected commit failure")
        self.committed = True


@pytest.fixture
def boundary(monkeypatch, tmp_path):
    events = []
    source, target = tmp_path / "front.jpg", tmp_path / "cover.jpg"
    source.write_bytes(b"original source")
    target.write_bytes(b"old cover")
    connection = Connection(events, {"album_id": 72, "cover_path": str(target), "metadata": {}})
    connections = []

    def connect(_):
        connections.append(connection)
        return connection

    def folder(root, action):
        assert connection.open and events[-1] in {"album", "inventory-revision"}
        events.append("folder-enter")
        try:
            return action()
        finally:
            events.append("folder-exit")

    monkeypatch.setattr(cover_workflow, "run_serialized_cover_selection", folder)
    adapter = persistence.PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/recording"}, connect=connect)

    def effect(scope):
        assert scope == connection.scope
        events.append("media")
        target.write_bytes(b"new cover")
        def rollback():
            events.append("rollback")
            assert connection.open and "folder-exit" not in events
            target.write_bytes(b"old cover")
        def complete():
            events.append("complete")
            assert connection.committed and "folder-exit" not in events
        return mutation.CoverMutationEffect(
            selection={"selected_cover_path": target, "cover_revision": "exact-new",
                       "local_cover_width": 600, "local_cover_height": 601},
            value="saved", rollback=rollback, complete=complete)

    def run(**overrides):
        return adapter.run_cover_mutation(**{
            "track_paths": {str(tmp_path / "track.flac")}, "album_root": tmp_path,
            "source_paths": (source, target), "affected_paths": (target,),
            "mutate": effect, **overrides})

    from types import SimpleNamespace
    return SimpleNamespace(events=events, source=source, target=target, root=tmp_path,
                           connection=connection, connections=connections,
                           adapter=adapter, run=run, effect=effect)


def test_media_and_exact_projection_share_one_transaction_with_late_revision(boundary):
    b = boundary
    def guard(commit, effect):
        b.events.append("runtime-lock")
        assert effect.value == "saved"
        commit()
        b.events.append("publish")
    result = b.run(commit_guard=guard)
    assert len(b.connections) == 1
    assert result["album_rows_updated"] == 1 and result["track_file_rows_updated"] == 2
    assert result["value"] == "saved"
    stages = [event for event in b.events if event not in {"source", "bootstrap"}]
    assert stages == ["enter", "inventory-shared", "album", "folder-enter", "owners", "media",
                      "persist", "revision", "runtime-lock", "commit", "publish", "complete", "folder-exit", "exit"]
    keys = [params["source_key"] for _, params in b.connection.operations if params and "source_key" in params]
    assert keys == sorted(set(keys))
    assert b.events.index("inventory-shared") < b.events.index("source") < b.events.index("album")
    writes = [params for _, params in b.connection.operations if params and "selected_cover_path" in params]
    assert len(writes) == 1
    assert writes[0]["cover_revision"] == "exact-new"
    assert writes[0]["local_cover_width"] == 600 and writes[0]["local_cover_height"] == 601


@pytest.mark.parametrize("stage", ["persist", "revision", "commit"])
def test_precommit_failures_restore_media_while_protection_is_held(boundary, stage):
    b = boundary
    b.connection.failure = stage
    with pytest.raises(RuntimeError, match=f"injected {stage} failure"):
        b.run()
    assert b.target.read_bytes() == b"old cover"
    assert not b.connection.committed
    assert b.events.count("rollback") == 1 and "complete" not in b.events
    assert b.events.index("rollback") < b.events.index("folder-exit") < b.events.index("exit")


@pytest.mark.parametrize("stage", ["publish", "complete"])
def test_postcommit_failures_never_restore_committed_media(boundary, stage):
    b = boundary
    def fail():
        raise RuntimeError("finalization failed")
    def effect(scope):
        result = b.effect(scope)
        if stage == "complete":
            result.complete = fail
        return result
    def guard(commit, effect):
        commit()
        if stage == "publish":
            fail()
    with pytest.raises(mutation.CoverMutationFinalizationError) as caught:
        b.run(mutate=effect, commit_guard=guard)
    assert caught.value.persisted is True
    assert caught.value.effect.value == "saved"
    assert b.connection.committed and b.target.read_bytes() == b"new cover"
    assert "rollback" not in b.events


@pytest.mark.parametrize("state", ["missing", "retargeted", "ordered", "malformed", "inventory"])
def test_stale_or_owned_scope_rejects_before_folder_and_media(boundary, state):
    b = boundary
    kwargs = {}
    if state == "missing":
        b.connection.scope = None
    elif state == "retargeted":
        kwargs["expected_album_id"] = 71
    elif state == "ordered":
        b.connection.scope["metadata"] = ordered(b.source)
    elif state == "malformed":
        b.connection.scope["metadata"] = {"selected_covers": []}
    else:
        kwargs["expected_inventory_mutation_revision"] = 8
    with pytest.raises((OrderedCoverSelectionConflict, persistence.ScanCachePublicationSuperseded)):
        b.run(**kwargs)
    assert "folder-enter" not in b.events and "media" not in b.events
    assert b.target.read_bytes() == b"old cover" and not b.connection.committed


@pytest.mark.parametrize("options", [
    {"cover_selection_origin": "bogus"},
    {"cover_selection_origin": "automatic", "explicit_selection": True},
    {"expected_cover_state": ("user",)},
    {"expected_cover_state": (None, None), "expected_cover_revision": "old"},
])
def test_invalid_request_options_do_not_open_connection_or_touch_media(boundary, options):
    with pytest.raises(ValueError):
        boundary.run(selection_options=options)
    assert boundary.connections == [] and boundary.events == []


@pytest.mark.parametrize("kind", ["symlink", "hardlink", "same-path", "primary-projection"])
def test_another_concrete_album_protects_shared_source_before_any_media(boundary, kind):
    b = boundary
    alias = b.root / "alias.jpg"
    if kind == "symlink":
        alias.symlink_to(b.target)
    elif kind == "hardlink":
        alias.hardlink_to(b.target)
    else:
        alias = b.target
    owner = {"album_id": 99, "library_id": "other-library", "metadata": ordered(alias),
             "cover_path": None, "track_paths": [str(b.root / "other-version.flac")]}
    if kind == "primary-projection":
        owner.update(metadata=ordered(b.source), cover_path=str(b.target))
    b.connection.owners = [owner]
    with pytest.raises(OrderedCoverSelectionConflict):
        b.run()
    assert "owners" in b.events and "media" not in b.events
    assert b.target.read_bytes() == b"old cover" and not b.connection.committed


@pytest.mark.parametrize("malformed", [None, [], {}, "broken"])
def test_malformed_other_owner_in_overlapping_folder_fails_closed(boundary, malformed):
    b = boundary
    b.connection.owners = [{"album_id": 99, "metadata": {"selected_covers": malformed},
                            "track_paths": [str(b.root / "disc2" / "other.flac")]}]
    with pytest.raises(OrderedCoverSelectionConflict):
        b.run()
    assert "media" not in b.events


def test_unselected_deletion_keeps_ordered_list_and_has_no_primary_update(boundary):
    b = boundary
    b.connection.scope["metadata"] = ordered(b.source)
    b.connection.scope["cover_path"] = str(b.source)
    b.connection.owners = [b.connection.scope]
    def delete(scope):
        b.events.append("media")
        b.target.unlink()
        return mutation.CoverMutationEffect(value="deleted")
    result = b.run(mutate=delete, allow_ordered_selection=True)
    assert result["value"] == "deleted"
    assert not b.target.exists() and b.source.read_bytes() == b"original source"
    assert "persist" not in b.events
    assert b.events.count("revision") == 1 and b.events.count("commit") == 1
    assert b.connection.scope["metadata"] == ordered(b.source)


def test_source_alias_changed_during_advisory_wait_is_not_relocked_out_of_order(boundary):
    b = boundary
    alias = b.root / "current.jpg"
    alias.symlink_to(b.source)
    def replace_alias():
        alias.unlink()
        alias.symlink_to(b.target)
    b.connection.source_wait = replace_alias
    with pytest.raises(OrderedCoverSelectionConflict, match="source changed"):
        b.run(source_paths=(alias,), affected_paths=())
    assert "album" not in b.events and "media" not in b.events
    keys = [params["source_key"] for _, params in b.connection.operations if params and "source_key" in params]
    assert keys == sorted(set(keys))


def test_missing_reference_and_existing_alias_keep_shared_source_identity(tmp_path):
    missing = tmp_path / "missing.jpg"
    assert "path:" + str(missing) in mutation.cover_source_keys(missing)
    source = tmp_path / "source.jpg"
    source.write_bytes(b"fixture")
    alias = tmp_path / "alias.jpg"
    alias.symlink_to(source)
    assert mutation.cover_source_keys(source) & mutation.cover_source_keys(alias)
    assert "path:" + str(alias) in mutation.cover_source_keys(alias)


@pytest.mark.parametrize("metadata,options,flag", [
    ({"cover_selection_origin": "user"}, {"cover_selection_origin": "automatic", "reject_if_user_controlled": True}, "blocked_by_user_selection"),
    ({"cover_selection_origin": "automatic", "cover_revision": "newer"}, {"expected_cover_state": ("automatic", "old")}, "blocked_by_expected_cover_state"),
    ({"cover_selection_origin": "user", "cover_revision": "old", "cover_selection_provenance": "explicit"}, {"expected_cover_state": ("user", "old"), "reject_if_explicit_selection": True}, "blocked_by_expected_cover_state"),
])
def test_fresh_database_guards_block_before_media_not_only_at_commit(boundary, metadata, options, flag):
    b = boundary
    b.connection.scope["metadata"] = metadata
    result = b.run(selection_options=options)
    assert result[flag] is True
    assert "media" not in b.events and "persist" not in b.events and "revision" not in b.events
    assert b.target.read_bytes() == b"old cover"


def test_rejected_runtime_generation_compensates_before_commit(boundary):
    b = boundary
    def reject(commit, effect):
        raise RuntimeError("generation changed")
    with pytest.raises(RuntimeError, match="generation changed"):
        b.run(commit_guard=reject)
    assert "rollback" in b.events and "commit" not in b.events
    assert b.target.read_bytes() == b"old cover"


def test_effect_exception_does_not_persist_or_commit(boundary):
    b = boundary
    def fail(scope):
        raise RuntimeError("promotion failed before returning an effect")
    with pytest.raises(RuntimeError, match="promotion failed"):
        b.run(mutate=fail)
    assert "persist" not in b.events and "commit" not in b.events
    assert b.target.read_bytes() == b"old cover"


def test_unrelated_malformed_owner_does_not_block_independent_folder(boundary):
    b = boundary
    b.connection.owners = [{"metadata": {"selected_covers": None},
                            "track_paths": [str(b.root / "separate" / "track.flac")]}]
    # A sibling folder outside the mutation folder has no shared source ownership.
    b.connection.owners[0]["track_paths"] = [str(b.root.parent / "independent-album" / "track.flac")]
    assert b.run()["value"] == "saved"
    assert b.connection.committed


def test_lost_commit_acknowledgement_preserves_media_until_reconciled(boundary):
    b = boundary
    b.connection.failure = "commit"
    b.connection.info.transaction_status = 4
    with pytest.raises(mutation.CoverMutationCommitUncertainError) as caught:
        b.run()
    assert caught.value.persisted is None
    assert b.target.read_bytes() == b"new cover"
    assert "rollback" not in b.events and "complete" not in b.events


@pytest.mark.parametrize("commit_count", [0, 2])
def test_runtime_guard_cannot_skip_or_repeat_commit(boundary, commit_count):
    b = boundary
    def guard(commit, effect):
        for _ in range(commit_count):
            commit()
    error = mutation.CoverMutationFinalizationError if commit_count else RuntimeError
    with pytest.raises(error):
        b.run(commit_guard=guard)
    assert b.events.count("commit") == min(commit_count, 1)
    assert ("rollback" in b.events) is (commit_count == 0)
    assert b.target.read_bytes() == (b"new cover" if commit_count else b"old cover")


def test_identity_rechecked_after_waiting_for_folder_before_media(boundary, monkeypatch):
    b = boundary
    alias = b.root / "current.jpg"
    alias.symlink_to(b.source)
    def folder(root, action):
        b.events.append("folder-enter")
        alias.unlink()
        alias.symlink_to(b.target)
        return action()
    monkeypatch.setattr(cover_workflow, "run_serialized_cover_selection", folder)
    with pytest.raises(OrderedCoverSelectionConflict, match="source changed"):
        b.run(source_paths=(alias,), affected_paths=())
    assert "album" in b.events and "folder-enter" in b.events
    assert "media" not in b.events and "persist" not in b.events


def test_owner_query_crosses_library_boundaries_but_tracks_remain_owner_scoped():
    sql = " ".join(persistence._load_ordered_cover_source_owners_sql().lower().split())
    assert "bootstrap" not in sql
    assert "track.album_id = album.id" in sql
    assert "track.library_id = album.library_id" in sql
    assert "album.metadata ? 'selected_covers'" in sql
    assert "for update" not in sql, "Other owners use source locks, not a reversed album-row lock order"


def test_declared_aliases_produce_the_same_physical_lock_without_library_namespace(boundary):
    b = boundary
    alias = b.root / "alias.jpg"
    alias.hardlink_to(b.source)
    b.run(source_paths=(b.source, alias, b.target))
    keys = [params["source_key"] for _, params in b.connection.operations if params and "source_key" in params]
    source_stat = b.source.stat()
    physical = f"inode:{source_stat.st_dev}:{source_stat.st_ino}"
    assert sum(key.endswith(physical) for key in keys) == 1
    assert all(key.startswith("album-haven:cover-source:") for key in keys)
    assert len(keys) == len(set(keys))


def test_local_preparation_rejects_bytes_changed_during_dimension_decode(tmp_path):
    path = tmp_path / "front.jpg"
    path.write_bytes(b"old")
    def dimensions(source):
        source.write_bytes(b"new")
        return 600, 600
    with pytest.raises(OrderedCoverSelectionConflict, match="being prepared"):
        cover_workflow.prepare_local_cover_image(path, dimensions)


def test_album_cover_lock_allows_foreign_key_checks_without_releasing_writer_serialization():
    sql = " ".join(persistence._load_legacy_cover_mutation_scope_sql(lock=True).lower().split())
    assert sql.endswith("for no key update of albums")
    assert "selection_scope.input_path_count = selection_scope.resolved_path_count" in sql
    assert "selection_scope.selected_album_count = 1" in sql


def test_reserved_backup_destination_is_locked_and_protected_even_when_reference_is_missing(boundary):
    b = boundary
    backup = b.root / "cover-existing-1.jpg"
    b.connection.owners = [{"album_id": 99, "metadata": ordered(backup), "cover_path": None}]
    with pytest.raises(OrderedCoverSelectionConflict):
        b.run(reserve_variant_bytes=b"incoming cover")
    keys = [params["source_key"] for _, params in b.connection.operations if params and "source_key" in params]
    assert "album-haven:cover-source:path:" + str(backup) in keys
    assert "media" not in b.events and not backup.exists()
    assert b.target.read_bytes() == b"old cover"


def test_backup_collision_during_source_lock_wait_never_advances_to_an_unlocked_name(boundary):
    b = boundary
    backup = b.root / "cover-existing-1.jpg"
    b.connection.source_wait = lambda: backup.write_bytes(b"another owner's image")
    with pytest.raises(OrderedCoverSelectionConflict):
        b.run(reserve_variant_bytes=b"incoming cover")
    assert backup.read_bytes() == b"another owner's image"
    assert not (b.root / "cover-existing-2.jpg").exists()
    assert "media" not in b.events and "persist" not in b.events


def test_reserve_primitive_refuses_a_changed_destination_without_creating_a_second_file(tmp_path):
    from music_app.services.covers import plan_existing_cover_variant, reserve_existing_cover_variant
    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"old cover")
    planned = plan_existing_cover_variant(tmp_path, b"incoming cover")
    planned.write_bytes(b"concurrent image")
    with pytest.raises(OrderedCoverSelectionConflict):
        reserve_existing_cover_variant(tmp_path, b"incoming cover", reserved_path=planned)
    assert planned.read_bytes() == b"concurrent image"
    assert cover.read_bytes() == b"old cover"
    assert not (tmp_path / "cover-existing-2.jpg").exists()


def test_distinct_album_folder_sections_can_overlap_in_one_process(tmp_path):
    from threading import Event, Thread
    first_entered, second_entered, release_first = Event(), Event(), Event()
    errors = []
    def first():
        def action():
            first_entered.set()
            if not release_first.wait(5):
                errors.append("first section was not released")
        cover_workflow.run_serialized_cover_selection(tmp_path / "first", action)
    def second():
        if not first_entered.wait(5):
            errors.append("first section never entered")
            return
        cover_workflow.run_serialized_cover_selection(tmp_path / "second", second_entered.set)
    threads = [Thread(target=first), Thread(target=second)]
    try:
        for thread in threads:
            thread.start()
        assert second_entered.wait(5), "An independent album was blocked by another folder's critical section"
    finally:
        release_first.set()
        for thread in threads:
            thread.join(5)
    assert not any(thread.is_alive() for thread in threads)
    assert errors == []
