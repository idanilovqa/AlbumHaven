"""Ordered edit guards with controlled DB verdicts, not live SQL/concurrency proof."""
from copy import deepcopy
from collections.abc import Mapping
from types import SimpleNamespace

import pytest

from cover_unit_safety import cover_unit_transports  # noqa: F401
from music_app.services import scan_cache_persistence as persistence
from test_ordered_cover_structural_preservation import (
    PATH, RecordingConnection, native_restore_adapter,
)


CASES = [
    {"edition": "Deluxe"},
    {"album": "Renamed", "year": 2002},
    {"album": "Renamed", "title": "New title"},
    {"album": "Renamed", "exception_type": "Non-album rarity"},
    {"album_artist": "Other artist", "edition": "Deluxe", "year": 2002},
]


def operation(changes, heterogeneous=False):
    before = {PATH: dict(path=PATH, album="Original", album_artist="Fixture",
                        artist="Fixture", title="One", year=2001, edition="",
                        exception_type="", track_number=1, disc_number=1)}
    after = {PATH: {**before[PATH], **changes}}
    if heterogeneous:
        second = PATH.replace("01.flac", "02.flac")
        before[second] = {**before[PATH], "path": second, "title": "Two"}
        after[second] = {**before[second], "year": 2003}
    fields = set(changes) | ({"year"} if heterogeneous else set())
    return dict(changed_paths=set(before), previous_file_entries=before,
                updated_file_entries=after, changed_field_names=fields)


@pytest.mark.parametrize("changes", CASES)
@pytest.mark.parametrize("heterogeneous", [False, True])
def test_extended_identity_preflight_rejects_ordered_conflict(changes, heterogeneous):
    connection = RecordingConnection(blocked=True)
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        native_restore_adapter(connection).validate_structural_tag_edit(
            **operation(changes, heterogeneous))
    assert connection.commits == 0


@pytest.mark.parametrize("changes", CASES)
@pytest.mark.parametrize("heterogeneous", [False, True])
def test_extended_identity_preflight_preserves_legacy_compatibility(changes, heterogeneous):
    connection = RecordingConnection(blocked=False)
    native_restore_adapter(connection).validate_structural_tag_edit(
        **operation(changes, heterogeneous))
    assert connection.commits == 0


@pytest.mark.parametrize("changes", CASES)
def test_extended_identity_workflow_conflict_precedes_all_effects(changes):
    from music_app.services.edit_workflows import handle_edit_tags_request

    edit = operation(changes)
    state = {"file_cache": edit["previous_file_entries"], "separate_release_keys": set()}
    original = deepcopy(state)
    effects = []

    def forbidden(*args, **kwargs):
        effects.append((args, kwargs))
        pytest.fail("Identity preflight must run before intent, media, override or task effects")

    payload, status = handle_edit_tags_request(
        album={"name": "Original", "album_artist": "Fixture", "tracks": [{"path": PATH}]},
        updates={PATH: changes}, requested_track_paths={PATH}, config={},
        logger=SimpleNamespace(), get_state=lambda: state,
        create_save_task=forbidden, queue_finalize_save_task=forbidden,
        apply_repairs_worker=forbidden, prepare_tag_edit_intent=forbidden,
        mark_tag_edit_files_verified=forbidden, save_track_exception_override=forbidden,
        update_cache_entry_after_repairs=lambda path, entry, repairs: {**entry, **repairs},
        build_affected_album_dicts=forbidden, load_separate_release_keys=lambda _: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda *a, **k: None, log_app_event=lambda *a, **k: None,
        structural_edit_fields={"album", "album_artist", "artist", "year", "edition"},
        edit_write_workers=1,
        prevalidate_structural_tag_edit=native_restore_adapter(RecordingConnection(blocked=True)).validate_structural_tag_edit,
    )
    assert status == 409 and payload["ok"] is False
    assert "ordered cover" in payload["error"].lower()
    assert effects == [] and state == original


class TransactionConnection(RecordingConnection):
    """Staged writes model transaction rollback, without evaluating PostgreSQL SQL.

    The injected SELECT verdict controls ownership. These tests establish Python
    transaction composition only, not PostgreSQL locking or concurrency safety.
    """
    def __init__(self, *, blocked=False, fail_at=None):
        super().__init__(blocked=blocked)
        self.fail_at = fail_at
        self.durable = {"overrides": {}, "status": "files_verified", "revision": 7}
        self.staged = None
        self.events = []
        self.override_count = 0

    def transaction(self):
        from contextlib import contextmanager

        @contextmanager
        def scope():
            assert self.staged is None, "Completion must have one transaction owner"
            self.staged = deepcopy(self.durable)
            self.events.append("begin")
            try:
                yield
                self.events.append("commit_attempt")
                if self.fail_at == "commit":
                    raise RuntimeError("injected commit failure")
                self.durable = deepcopy(self.staged)
                self.commits += 1
                self.events.append("commit")
            except BaseException:
                self.rollbacks += 1
                self.events.append("rollback")
                raise
            finally:
                self.staged = None
        return scope()

    def __exit__(self, kind, value, traceback):
        # Transaction context above owns rollback, like a nested psycopg
        # transaction context; closing the connection does not commit again.
        return False

    def execute(self, sql, params=None):
        from test_ordered_cover_structural_preservation import normalized

        text = normalized(sql)
        params = params or {}
        if "pg_advisory_xact_lock" in text:
            self.events.append("barrier")
        if "blocked_by_ordered_selection" in text:
            self.events.append("owner_guard")
        if "track_key" in params:
            assert self.staged is not None
            self.override_count += 1
            self.events.append("override")
            if self.fail_at == "second_override" and self.override_count == 2:
                raise RuntimeError("injected second_override failure")
            self.staged["overrides"][params["track_key"]] = deepcopy(params["override_payload"].obj)
        if params.get("status") == "completed":
            self.events.append("terminal")
            if self.fail_at == "terminal":
                raise RuntimeError("injected terminal failure")
            self.staged["status"] = "completed"
        if "update library.libraries" in text and "inventory_mutation_revision" in text:
            self.events.append("revision")
            if self.fail_at == "revision":
                raise RuntimeError("injected revision failure")
            self.staged["revision"] += 1
        result = super().execute(sql, params)
        if result.row:
            result.row.update(input_path_count=2, resolved_path_count=2,
                              source_album_count=2, inventory_mutation_revision=8)
        return result


def completion_repo(connection):
    from music_app.services.tag_edit_intents_postgres import PostgresTagEditIntentRepository
    return PostgresTagEditIntentRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/atomic_unit"},
        connect=lambda _: connection)


def exception_updates():
    # Deliberately heterogeneous source memberships: no single-album requirement.
    return {PATH: "Non-album rarity", PATH.replace("01.flac", "02.flac"): ""}


def test_exception_completion_rechecks_late_ordered_owner_before_any_write():
    connection = TransactionConnection(blocked=False)
    # A completed preflight does not reserve ownership for later completion.
    connection.events.append("preflight_passed")
    connection.blocked = True
    before = deepcopy(connection.durable)
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        completion_repo(connection).complete("synthetic-intent", exception_updates=exception_updates())
    assert connection.durable == before
    assert connection.commits == 0 and connection.rollbacks == 1
    assert connection.events.index("barrier") < connection.events.index("owner_guard")
    assert "override" not in connection.events and "terminal" not in connection.events


def test_exception_completion_commits_overrides_status_and_revision_together():
    connection = TransactionConnection()
    completion_repo(connection).complete("synthetic-intent", exception_updates=exception_updates())
    assert connection.commits == 1 and connection.rollbacks == 0
    assert connection.durable == {
        "overrides": {path: {"exception_type": value} for path, value in exception_updates().items()},
        "status": "completed", "revision": 8,
    }
    events = connection.events
    assert events.index("begin") < events.index("barrier") < events.index("owner_guard")
    assert events.index("owner_guard") < events.index("override") < events.index("terminal")
    assert events.index("terminal") < events.index("revision") < events.index("commit")


@pytest.mark.parametrize("fail_at", ["second_override", "terminal", "revision", "commit"])
def test_exception_completion_failure_rolls_back_all_staged_state(fail_at):
    connection = TransactionConnection(fail_at=fail_at)
    before = deepcopy(connection.durable)
    with pytest.raises(RuntimeError, match="injected"):
        completion_repo(connection).complete("synthetic-intent", exception_updates=exception_updates())
    assert connection.durable == before
    assert connection.commits == 0 and connection.rollbacks == 1


def test_targeted_completion_keeps_callers_transaction_and_revision_ownership():
    connection = TransactionConnection()
    repo = completion_repo(connection)
    with connection.transaction():
        repo.complete_in_transaction(connection, "synthetic-intent", exception_updates=exception_updates())
        assert connection.commits == 0
    assert connection.commits == 1
    assert connection.durable["revision"] == 7
    assert "barrier" not in connection.events
    assert "owner_guard" not in connection.events


@pytest.mark.parametrize("changes", CASES)
def test_general_identity_route_wires_preflight_without_targeted_dispatch(changes):
    # Inspect the real handler expression independently of workflow injection.
    # This is configuration coverage, not an HTTP end-to-end test.
    import ast
    from pathlib import Path

    route_path = Path(__file__).parents[2] / "music_app/routes/api_wave_a_asgi_routes.py"
    tree = ast.parse(route_path.read_text())
    expressions = [value for node in ast.walk(tree) if isinstance(node, ast.Dict)
                   for key, value in zip(node.keys, node.values)
                   if isinstance(key, ast.Constant) and key.value == "prevalidate_structural_tag_edit"]
    assert len(expressions) == 1
    calls = []
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/atomic_unit"}
    namespace = dict(
        postgres_targeted_structural_edit=False, postgres_exception_only=False,
        config=config, updates={PATH: changes}, Mapping=Mapping,
        _STRUCTURAL_EDIT_FIELDS={"album", "album_artist", "year", "edition", "exception_type", "custom_collection_name"},
        validate_structural_tag_edit_for_config=lambda *a, **k: calls.append((a, k)),
    )
    callback = eval(compile(ast.Expression(expressions[0]), str(route_path), "eval"), namespace)
    assert callable(callback), "General identity routes must not bypass pre-media validation"
    callback(changed_paths={PATH})
    assert calls == [((config,), {"allow_targeted_identity": False, "changed_paths": {PATH}})]


@pytest.mark.parametrize("verdict", [None, 0, 1, "false", {}, []])
def test_exception_completion_invalid_verdict_rolls_back_before_overrides(verdict):
    connection = TransactionConnection(blocked=verdict)
    before = deepcopy(connection.durable)
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        completion_repo(connection).complete("synthetic-intent", exception_updates=exception_updates())
    assert connection.durable == before
    assert connection.commits == 0 and connection.rollbacks == 1
    assert "override" not in connection.events and "terminal" not in connection.events


def test_exception_completion_sends_exact_heterogeneous_updates_to_fresh_guard(monkeypatch):
    connection = TransactionConnection()
    updates = {PATH: {"exception_type": "Custom Collection", "custom_collection_name": "Rarities"},
               PATH.replace("01.flac", "02.flac"): ""}
    guarded = []
    actual_guard = persistence.assert_ordered_cover_edit_updates_allowed

    def record_guard(conn, values):
        assert conn is connection
        guarded.append(deepcopy(values))
        return actual_guard(conn, values)

    monkeypatch.setattr(persistence, "assert_ordered_cover_edit_updates_allowed", record_guard)
    completion_repo(connection).complete("synthetic-intent", exception_updates=updates)
    assert guarded == [{PATH: updates[PATH],
                        PATH.replace("01.flac", "02.flac"): {"exception_type": ""}}]


def test_fresh_guard_sql_covers_scope_current_override_and_locked_owner_snapshot():
    from test_ordered_cover_structural_preservation import normalized

    sql = normalized(persistence._ordered_cover_edit_updates_conflict_sql())
    # SQL contracts only: actual row matching/locks require isolated PostgreSQL.
    for fragment in (
        "owner.owner_key = 'local-bootstrap-owner'",
        "scope.library_id = tracks.library_id", "files.scan_cache_stale is false",
        "candidate.library_id = tracks.library_id", "candidate.track_key = files.private_path",
        "candidate.track_id = tracks.id", "left join lateral",
        "order by case when candidate.track_key = files.private_path then 0 else 1 end",
        "candidate.updated_at desc, candidate.id desc", "limit 1",
        "coalesce(overrides.override_payload, '{}'::jsonb)",
        "scope.library_id = album.library_id", "order by album.id for update of album",
        "album.metadata ? 'selected_covers'", "count(distinct private_path)",
        "cardinality(%(changed_paths)s::text[])", "as resolved_entries", "as ordered_albums",
    ):
        assert fragment in sql
    assert "source_album_count = 1" not in sql


@pytest.mark.parametrize("blocked", [False, True])
def test_heterogeneous_targeted_field_union_keeps_general_dispatch_semantics(blocked):
    first, second = PATH, PATH.replace("01.flac", "02.flac")
    edit = operation({"album": "Renamed"}, heterogeneous=True)
    edit["updated_file_entries"][second] = {
        **edit["previous_file_entries"][second], "artist": "Different artist",
    }
    edit["changed_field_names"] = {"album", "artist"}
    connection = RecordingConnection(blocked=blocked)
    if blocked:
        with pytest.raises(persistence.OrderedCoverSelectionConflict):
            native_restore_adapter(connection).validate_structural_tag_edit(**edit, allow_targeted_identity=False)
    else:
        native_restore_adapter(connection).validate_structural_tag_edit(**edit, allow_targeted_identity=False)
    assert connection.commits == 0


@pytest.mark.parametrize("changes", [{"title": "New title", "custom_collection_name": "New name"},
                                     {"album_rating": 5}, {"album_type": "Live"}])
def test_nonidentity_fields_after_route_preflight_wiring_remain_compatible(changes):
    edit = operation(changes)
    connection = RecordingConnection(blocked=True)
    native_restore_adapter(connection).validate_structural_tag_edit(**edit)
    assert connection.commits == 0


class SnapshotConnection(TransactionConnection):
    """Supply fresh scope rows; native guard owns all membership decisions."""
    def __init__(self, snapshot, **options):
        super().__init__(**options)
        self.snapshot = snapshot

    def execute(self, sql, params=None):
        result = super().execute(sql, params)
        if "resolved_entries" in sql:
            from test_ordered_cover_structural_preservation import Cursor
            return Cursor(self.snapshot)
        return result


def snapshot():
    return {
        "blocked_by_ordered_selection": False,
        "resolved_entries": [
            {"private_path": PATH, "album_id": None,
             "previous_entry": {"album": "Original", "edition": "", "year": 2001,
                                "artist": "", "album_artist": "", "exception_type": "Non-album rarity"}},
            {"private_path": PATH.replace("01.flac", "02.flac"), "album_id": 74,
             "previous_entry": {"album": "Different source", "edition": "", "year": 2003,
                                "artist": "Other", "album_artist": "Other", "exception_type": ""}},
        ],
        "ordered_albums": [],
    }


@pytest.mark.parametrize("raw_title,title,raw_edition,edition", [
    ("Original", "Original", "", ""),
    ("Insound Tour Support".encode("utf-16le").decode("utf-16be"),
     "Insound Tour Support", "Deluxe".encode("utf-16le").decode("utf-16be"), "Deluxe"),
    ("Stra\u00dfe", "STRASSE", "\u00c9dition", "\u00c9DITION"),
])
def test_mixed_clear_set_completion_rejects_normalized_ordered_destination(
    raw_title, title, raw_edition, edition,
):
    from music_app.services.library import _album_bucket_metadata

    assert _album_bucket_metadata(raw_title, raw_edition) == _album_bucket_metadata(title, edition)
    rows = snapshot()
    rows["resolved_entries"][0]["previous_entry"].update(album=raw_title, edition=raw_edition)
    # No artist/year descriptor: native candidate matching must not assume them
    # from one file when actual owner identity uses a complete album bucket.
    rows["ordered_albums"] = [{"id": 99, "title": title, "edition": edition}]
    connection = SnapshotConnection(rows)
    before = deepcopy(connection.durable)
    updates = {PATH: "", PATH.replace("01.flac", "02.flac"): "Non-album rarity"}
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        completion_repo(connection).complete("synthetic-intent", exception_updates=updates)
    assert connection.durable == before and connection.rollbacks == 1
    assert "override" not in connection.events


@pytest.mark.parametrize("bad_scope", ["missing", "foreign", "duplicate", "missing_arrays", "invalid_entry"])
def test_exception_completion_rejects_incomplete_fresh_scope_before_writes(bad_scope):
    rows = snapshot()
    if bad_scope == "missing":
        rows["resolved_entries"].pop()
    elif bad_scope == "foreign":
        rows["resolved_entries"][1]["private_path"] = "/synthetic/another-library/02.flac"
    elif bad_scope == "duplicate":
        rows["resolved_entries"][1] = deepcopy(rows["resolved_entries"][0])
    elif bad_scope == "missing_arrays":
        del rows["resolved_entries"]
    else:
        rows["resolved_entries"][0]["previous_entry"] = None
    connection = SnapshotConnection(rows)
    before = deepcopy(connection.durable)
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        completion_repo(connection).complete("synthetic-intent", exception_updates=exception_updates())
    assert connection.durable == before
    assert "override" not in connection.events and connection.rollbacks == 1


def test_collection_only_direct_completion_guards_normalized_clear_and_stripped_path():
    rows = snapshot()
    rows["resolved_entries"] = rows["resolved_entries"][:1]
    rows["ordered_albums"] = [{"id": 99, "title": "Original", "edition": ""}]
    connection = SnapshotConnection(rows)
    before = deepcopy(connection.durable)
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        completion_repo(connection).complete(
            "synthetic-intent", exception_updates={f" {PATH} ": {"custom_collection_name": "Name"}})
    assert connection.durable == before
    guard_params = [params for sql, params in connection.operations if "resolved_entries" in sql]
    assert guard_params == [{"changed_paths": [PATH]}]
    assert "override" not in connection.events


def test_collection_only_direct_completion_writes_exact_normalized_guard_payload(monkeypatch):
    rows = snapshot()
    rows["resolved_entries"] = rows["resolved_entries"][:1]
    connection = SnapshotConnection(rows)
    observed = []
    actual_guard = persistence.assert_ordered_cover_edit_updates_allowed

    def inspect_guard(conn, updates):
        observed.append(deepcopy(updates))
        actual_guard(conn, updates)

    monkeypatch.setattr(persistence, "assert_ordered_cover_edit_updates_allowed", inspect_guard)
    completion_repo(connection).complete(
        "synthetic-intent", exception_updates={f" {PATH} ": {"custom_collection_name": " Name "}})
    expected = {PATH: {"exception_type": "", "custom_collection_name": "Name"}}
    assert observed == [expected]
    assert connection.durable["overrides"] == expected
    assert connection.durable["status"] == "completed" and connection.durable["revision"] == 8
