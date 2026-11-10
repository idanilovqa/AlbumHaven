"""Structural cover contracts with recording connections, not live PostgreSQL."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from cover_unit_safety import cover_unit_transports  # noqa: F401
from music_app.services import scan_cache_persistence as persistence


PATH = "/synthetic/ordered-structural/01.flac"
ORDERED_FIELDS = ("selected_covers", "selected_covers_revision", "selected_covers_last_request")
PRIMARY_METADATA_FIELDS = (
    "cover_revision", "cover_selection_repair_previous", "cover_selection_origin",
    "cover_selection_provenance", "local_cover_width", "local_cover_height",
    "remote_cover_url", "remote_cover_thumbnail_url", "remote_cover_source",
    "remote_cover_source_label", "remote_cover_album_url", "remote_cover_width", "remote_cover_height",
)


def normalized(sql):
    return " ".join(sql.lower().split())


class Cursor:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return deepcopy(self.row)

    def fetchall(self):
        return [deepcopy(self.row)] if self.row else []


class RecordingConnection:
    """Inject DB verdicts, recording transaction boundaries and attempted SQL."""
    def __init__(self, *, blocked=False, count=2):
        self.blocked = blocked
        self.operations = []
        self.commits = 0
        self.rollbacks = 0
        self.count = count

    def __enter__(self):
        return self

    def __exit__(self, kind, value, traceback):
        if kind:
            self.rollbacks += 1

    def commit(self):
        self.commits += 1

    def execute(self, sql, params=None):
        self.operations.append((sql, params))
        if "bootstrap_context_ready" in sql:
            return Cursor({"bootstrap_context_ready": 1})
        if "separate_release_keys" in sql and "changed_paths" not in sql:
            return Cursor({"separate_release_keys": []})
        if "resolved_entries" in sql:
            previous = getattr(self, "previous_entries", None) or {}
            return Cursor({
                "blocked_by_ordered_selection": False if isinstance(self.blocked, bool) else self.blocked,
                "resolved_entries": [
                    {"private_path": path, "album_id": 72,
                     "previous_entry": deepcopy(previous.get(path, {
                         "album": "Original", "album_artist": "Fixture", "artist": "Fixture",
                         "year": 2001, "edition": "", "exception_type": "",
                     }))} for path in params["changed_paths"]
                ],
                "ordered_albums": [{"id": 72, "title": "Original", "edition": ""}]
                    if self.blocked is True else [],
            })
        return Cursor({
            "blocked_by_ordered_selection": self.blocked,
            "input_path_count": 1, "resolved_path_count": 1,
            "source_album_count": 1, "source_album_track_file_count": self.count,
            "destination_conflict_count": 0, "destination_album_count": 1,
            "album_rows_updated": 1, "track_rows_updated": 1,
            "track_file_rows_updated": 1, "inventory_mutation_revision": 1,
            "source_album_id": 72, "destination_album_id": 72,
        })


def subject(connection):
    album = SimpleNamespace(key="fixture::renamed", name="Renamed", album_artist="Fixture", year=2001, edition=None)
    return persistence.PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/structural_unit"},
        connect=lambda _: connection, build_albums=lambda *args: [album])


def edit(kind="split"):
    before = {"path": PATH, "album": "Original", "album_artist": "Fixture", "artist": "Fixture", "title": "One", "year": 2001}
    after = dict(before)
    field = "album"
    if kind == "detach":
        after["album"] = ""
    elif kind == "exception":
        field = "exception_type"
        after[field] = "single"
    elif kind == "title":
        field = "title"
        after[field] = "New title"
    else:
        after["album"] = "Renamed"
    return dict(changed_paths={PATH}, previous_file_entries={PATH: before}, updated_file_entries={PATH: after}, changed_field_names={field})


@pytest.mark.parametrize("kind", ["split", "detach", "exception"])
def test_prevalidation_rejects_database_ordered_conflict_before_caller_media_step(kind):
    connection = RecordingConnection(blocked=True)
    media = []
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        subject(connection).validate_structural_tag_edit(**edit(kind))
        media.append("would write tags")
    assert media == []
    assert connection.commits == 0
    assert not any("update library." in normalized(sql) or "delete from library." in normalized(sql)
                   for sql, _ in connection.operations)


@pytest.mark.parametrize("kind", ["split", "detach", "exception"])
def test_persistence_rechecks_and_rolls_back_before_projection_or_commit(kind):
    connection = RecordingConnection(blocked=True)
    callbacks = []
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        subject(connection).persist_structural_tag_edit(
            **edit(kind), before_commit=lambda _: callbacks.append("projection"),
            commit_guard=lambda commit: (callbacks.append("commit"), commit()))
    assert callbacks == []
    assert connection.commits == 0 and connection.rollbacks == 1
    assert not any("update library." in normalized(sql) or "delete from library." in normalized(sql)
                   for sql, _ in connection.operations)


@pytest.mark.parametrize("target_ids", [None, (72,)])
def test_semantic_reconciliation_rejects_database_ordered_owner_drop_before_mutation(target_ids):
    connection = RecordingConnection(blocked=True)
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        persistence._execute_semantic_local_album_reconciliation(connection, target_album_ids=target_ids)
    assert not any("update library." in normalized(sql) or "delete from library." in normalized(sql)
                   for sql, _ in connection.operations)


@pytest.mark.parametrize("kind", ["split", "detach", "title"])
def test_legacy_or_unrelated_prevalidation_is_not_blanket_blocked(kind):
    connection = RecordingConnection(blocked=False)
    subject(connection).validate_structural_tag_edit(**edit(kind))
    assert connection.commits == 0


def test_nonidentity_prevalidation_never_consults_ordered_selection():
    connection = RecordingConnection(blocked=True)
    subject(connection).validate_structural_tag_edit(**edit("title"))
    assert connection.operations == []


@pytest.mark.parametrize("updates_year", [False, True])
def test_same_row_rekey_sql_keeps_metadata_instead_of_rebuilding_cover_selection(updates_year):
    sql = normalized(persistence._persist_structural_album_tag_edit_sql(updates_release_year=updates_year))
    rename = sql.split("renamed_source_album as", 1)[1].split("inserted_destination_album as", 1)[0]
    assert "update library.local_albums" in rename
    assert "library.local_albums.metadata" in rename
    assert "cover_path =" not in rename
    assert "- 'selected_covers'" not in rename
    assert "selected_covers_revision'," not in rename
    assert "selected_covers_last_request'," not in rename


@pytest.mark.parametrize("metadata_alias", ["source.metadata", "destination.metadata"])
def test_ordered_classification_requires_object_and_key_presence_not_valid_value(metadata_alias):
    sql = normalized(persistence._has_ordered_cover_selection_sql(metadata_alias))
    assert f"jsonb_typeof({metadata_alias}) = 'object'" in sql
    assert f"{metadata_alias} ? 'selected_covers'" in sql
    assert "-> 'selected_covers'" not in sql
    assert "jsonb_array_length" not in sql
    assert "coalesce(" in sql and "false)" in sql


def test_late_ordered_selection_conflict_rechecks_after_successful_prevalidation():
    connection = RecordingConnection(blocked=False)
    operation = edit("detach")
    subject(connection).validate_structural_tag_edit(**operation)
    connection.operations.clear()
    connection.blocked = True
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        subject(connection).persist_structural_tag_edit(**operation)
    assert connection.rollbacks == 1 and connection.commits == 0
    assert not any("update library." in normalized(sql) for sql, _ in connection.operations)


@pytest.mark.parametrize("verdict", [None, 0, 1, "false", {}, []])
def test_structural_guard_fails_closed_on_missing_or_nonboolean_db_verdict(verdict):
    connection = RecordingConnection(blocked=verdict)
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        persistence._assert_ordered_cover_structural_identity_preserved(connection, changed_paths=[PATH])
    assert len(connection.operations) == 1


def test_structural_guard_binds_exact_changed_paths_and_destination_identity():
    connection = RecordingConnection()
    album = SimpleNamespace(key="fixture::renamed::deluxe", album_artist="Fixture", name="Renamed", year=2001, edition="Deluxe")
    persistence._assert_ordered_cover_structural_identity_preserved(
        connection, changed_paths=[PATH], destination_album=album, updates_release_year=True)
    sql, params = connection.operations[0]
    assert params == {"changed_paths": [PATH], "destination_album_key": album.key,
                      "destination_artist_key": "fixture", "destination_album_title": "Renamed",
                      "destination_edition": "Deluxe", "destination_release_year": 2001,
                      "retain_album_membership": False, "updates_release_year": True,
                      "destination_is_explicit_separate": False}
    sql = normalized(sql)
    for fragment in (
        "owner.owner_key = 'local-bootstrap-owner'", "lib.name = 'local library'", "lib.library_kind = 'local'",
        "tracks.library_id = scope.library_id", "files.track_id = tracks.id",
        "files.private_path = any(%(changed_paths)s::text[])", "files.scan_cache_stale is false",
        "scope.library_id = album.library_id", "tracks.album_id = album.id",
        "tracks.library_id = album.library_id", "order by album.id for update of album",
        "jsonb_typeof(album.metadata) = 'object'", "album.metadata ? 'selected_covers'",
    ):
        assert fragment in sql


def test_structural_guard_allows_retained_id_but_rejects_detach_split_and_foreign_destination_sql():
    sql = normalized(persistence._ordered_cover_structural_identity_conflict_sql())
    for fragment in (
        "not %(retain_album_membership)s::boolean", "source.id is null",
        "%(destination_album_key)s = ''", "destination.id <> source.id",
        "source.selected_count <> source.active_count",
        "source.album_key <> %(destination_album_key)s or %(updates_release_year)s::boolean",
    ):
        assert fragment in sql
    # The absence of a distinct destination and a complete membership leave
    # same-row rename legal. This is a SQL contract, not simulated DB execution.
    assert "source.selected_count <> source.active_count" in sql


@pytest.mark.parametrize("targets", [None, (72,)])
def test_semantic_guard_checks_redundant_owner_not_canonical_and_precedes_all_durable_mutations(targets):
    statements = list(persistence._reconcile_semantic_local_albums_sql(target_album_ids=targets))
    index = next(i for i, sql in enumerate(statements) if "as blocked_by_ordered_selection" in sql)
    guard = normalized(statements[index])
    assert "album.id = candidate.redundant_album_id" in guard
    assert "album.library_id = candidate.library_id" in guard
    assert "jsonb_typeof(album.metadata) = 'object'" in guard
    assert "album.metadata ? 'selected_covers'" in guard
    assert "candidate.canonical_album_id" not in guard
    assert any("for update" in sql.lower() for sql in statements[:index])
    assert not any("update library." in normalized(sql) or "delete from library." in normalized(sql)
                   or "insert into app." in normalized(sql) for sql in statements[:index])


def test_canonical_ordered_merge_keeps_opaque_list_and_exact_nullable_primary_sql():
    statements = persistence._reconcile_semantic_local_albums_sql()
    merge = normalized(next(sql for sql in statements if "merged_album_projection as" in sql))
    assert "then library.local_albums.cover_path else merged_album_projection.cover_path end" in merge
    assert "coalesce(library.local_albums.cover_path" not in merge
    protected = (*ORDERED_FIELDS, *PRIMARY_METADATA_FIELDS)
    expression = "array[" + ", ".join(repr(field) for field in protected) + "]::text[]"
    assert "- " + expression in merge
    assert "from jsonb_each(library.local_albums.metadata) where key = any(" + expression in merge
    assert "jsonb_array_elements" not in merge
    assert "jsonb_array_length" not in merge


def test_legacy_or_canonical_only_ordered_semantic_merge_can_proceed_from_negative_guard():
    connection = RecordingConnection(blocked=False)
    persistence._execute_semantic_local_album_reconciliation(connection, target_album_ids=(72,))
    assert any("update library.local_albums" in normalized(sql) for sql, _ in connection.operations)
    assert any("delete from library.local_albums" in normalized(sql) for sql, _ in connection.operations)


def test_native_tag_workflow_returns_ordered_conflict_before_intent_media_and_task():
    from music_app.services.edit_workflows import handle_edit_tags_request

    connection = RecordingConnection(blocked=True)
    state = {"file_cache": edit()["previous_file_entries"], "separate_release_keys": set()}
    original = deepcopy(state)
    side_effects = []

    def forbidden(*args, **kwargs):
        side_effects.append((args, kwargs))
        pytest.fail("Ordered structural conflict must precede intent, media, task and projection work")

    payload, status = handle_edit_tags_request(
        album={"name": "Original", "album_artist": "Fixture", "tracks": [{"path": PATH}]},
        updates={PATH: {"album": "Renamed"}}, requested_track_paths={PATH},
        config={}, logger=SimpleNamespace(), get_state=lambda: state,
        create_save_task=forbidden, queue_finalize_save_task=forbidden,
        apply_repairs_worker=forbidden, prepare_tag_edit_intent=forbidden,
        mark_tag_edit_files_verified=forbidden,
        update_cache_entry_after_repairs=lambda path, entry, repairs: {**entry, **repairs},
        build_affected_album_dicts=forbidden, load_separate_release_keys=lambda _: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda *args, **kwargs: None,
        log_app_event=lambda *args, **kwargs: None,
        structural_edit_fields={"album"}, edit_write_workers=1,
        save_track_exception_override=forbidden,
        prevalidate_structural_tag_edit=subject(connection).validate_structural_tag_edit,
    )
    assert status == 409
    assert payload["ok"] is False
    assert "ordered cover" in payload["error"].lower()
    assert side_effects == []
    assert state == original
    assert connection.commits == 0


@pytest.mark.parametrize("value", [None, [], "malformed", [{"kind": "local", "path": "/synthetic/foreign.jpg"}]])
def test_structural_entry_delta_cannot_manufacture_or_replace_ordered_authority(value):
    protected = set(ORDERED_FIELDS) | set(PRIMARY_METADATA_FIELDS) | {"cover_path"}
    before = {"title": "Before", **{key: "persisted" for key in protected}}
    after = {"title": "After", **{key: value for key in protected}}
    assert persistence._structural_file_entry_delta(before, after) == {"title": "After"}
    assert persistence._structural_file_entry_delta({"title": "Before"}, after) == {"title": "After"}


@pytest.mark.parametrize("old_exception,new_exception", [("", "Non-album rarity"), ("Non-album rarity", "")])
def test_native_exception_workflow_preflights_prospective_state_before_intent_and_task(old_exception, new_exception):
    from music_app.services.edit_workflows import handle_edit_tags_request

    connection = RecordingConnection(blocked=True)
    state = {"file_cache": edit()["previous_file_entries"], "separate_release_keys": set()}
    state["file_cache"][PATH]["exception_type"] = old_exception
    original = deepcopy(state)
    preflights = []

    def preflight(**options):
        preflights.append(options)
        assert options["changed_paths"] == {PATH}
        assert options["changed_field_names"] == {"exception_type"}
        assert options["previous_file_entries"][PATH]["exception_type"] == old_exception
        assert options["updated_file_entries"][PATH]["exception_type"] == new_exception
        raise persistence.OrderedCoverSelectionConflict("Saved ordered cover ownership conflict")
    side_effects = []

    def forbidden(*args, **kwargs):
        side_effects.append((args, kwargs))
        pytest.fail("Ordered structural conflict must precede intent, media, task and projection work")

    payload, status = handle_edit_tags_request(
        album={"name": "Original", "album_artist": "Fixture", "tracks": [{"path": PATH}]},
        updates={PATH: {"exception_type": new_exception}}, requested_track_paths={PATH},
        config={}, logger=SimpleNamespace(), get_state=lambda: state,
        create_save_task=forbidden, queue_finalize_save_task=forbidden,
        apply_repairs_worker=forbidden, prepare_tag_edit_intent=forbidden,
        mark_tag_edit_files_verified=forbidden,
        update_cache_entry_after_repairs=lambda path, entry, repairs: {**entry, **repairs},
        build_affected_album_dicts=forbidden, load_separate_release_keys=lambda _: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda *args, **kwargs: None,
        log_app_event=lambda *args, **kwargs: None,
        structural_edit_fields={"album"}, edit_write_workers=1,
        save_track_exception_override=forbidden,
        prevalidate_structural_tag_edit=preflight,
    )
    assert len(preflights) == 1
    assert status == 409
    assert payload["ok"] is False
    assert "ordered cover" in payload["error"].lower()
    assert side_effects == []
    assert state == original
    assert connection.commits == 0



def test_nullable_artist_destination_guard_matches_writer_null_safe_owner_contract():
    # SQL shape only: nullable identities need real PostgreSQL fixtures for proof.
    import re
    guard = normalized(persistence._ordered_cover_structural_identity_conflict_sql())
    writer = normalized(persistence._persist_structural_album_tag_edit_sql())
    assert re.search(r"artist_id is not distinct from", writer)
    destination = guard.split("destination_albums as", 1)[1].split("locked_albums as", 1)[0]
    assert re.search(r"artist_id is not distinct from", destination)
    assert not re.search(r"artist_id in \(select artist_id", destination)
    # Both the ordered source and ordered destination must be examined.
    assert "select id from source_albums union select id from destination_albums" in guard
    assert "source.id is null" in guard
    assert "destination.id <> source.id" in guard


@pytest.mark.parametrize("blocked", [False, True])
def test_explicit_separate_decision_reaches_guard_without_disabling_transfer_verdict(blocked):
    connection = RecordingConnection(blocked=blocked)
    kwargs = dict(changed_paths=[PATH], destination_album=SimpleNamespace(
        key="fixture::original::year::2002", name="Original", album_artist="Fixture", year=2002, edition=None),
        updates_release_year=True, destination_is_explicit_separate=True)
    if blocked:
        with pytest.raises(persistence.OrderedCoverSelectionConflict):
            persistence._assert_ordered_cover_structural_identity_preserved(connection, **kwargs)
    else:
        persistence._assert_ordered_cover_structural_identity_preserved(connection, **kwargs)
    sql, params = connection.operations[0]
    assert params["destination_is_explicit_separate"] is True
    assert params["updates_release_year"] is True
    assert params["retain_album_membership"] is False
    assert "%(destination_is_explicit_separate)s::boolean" in normalized(sql)


@pytest.mark.parametrize("exception_only", [True, False])
def test_native_route_callback_configuration_includes_exception_only_requests(exception_only):
    # Evaluate the actual handler-options expression, not a copied approximation.
    # This is route configuration coverage, not an HTTP integration test.
    import ast
    from pathlib import Path
    route_path = Path(__file__).parents[2] / "music_app/routes/api_wave_a_asgi_routes.py"
    tree = ast.parse(route_path.read_text())
    values = [value for node in ast.walk(tree) if isinstance(node, ast.Dict)
              for key, value in zip(node.keys, node.values)
              if isinstance(key, ast.Constant) and key.value == "prevalidate_structural_tag_edit"]
    assert len(values) == 1
    calls = []
    config = {"unit": "isolated"}
    namespace = dict(postgres_targeted_structural_edit=False, postgres_exception_only=exception_only,
                     updates={}, config=config, validate_structural_tag_edit_for_config=lambda *args, **kwargs: calls.append((args, kwargs)))
    callback = eval(compile(ast.Expression(values[0]), str(route_path), "eval"), namespace)
    if exception_only:
        assert callable(callback)
        callback(changed_paths={PATH})
        assert calls == [((config,), {"allow_targeted_identity": True, "changed_paths": {PATH}})]
    else:
        assert callback is None


@pytest.mark.parametrize("phase", ["validate_structural_tag_edit", "persist_structural_tag_edit"])
def test_native_adapter_year_guard_uses_persisted_explicit_separate_decision(phase):
    class SeparateConnection(RecordingConnection):
        def execute(self, sql, params=None):
            if "select library.separate_releases.release_key" in sql:
                self.operations.append((sql, params))
                return Cursor({"release_key": "fixture::original"})
            return super().execute(sql, params)

    connection = SeparateConnection(blocked=True, count=1)
    adapter = persistence.PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/structural_unit"},
        connect=lambda _: connection)
    operation = edit()
    operation["updated_file_entries"][PATH] = {
        **operation["previous_file_entries"][PATH], "year": 2002}
    operation["changed_field_names"] = {"year"}
    with pytest.raises(persistence.OrderedCoverSelectionConflict):
        getattr(adapter, phase)(**operation)
    guard_calls = [(sql, params) for sql, params in connection.operations
                   if "as blocked_by_ordered_selection" in sql]
    assert len(guard_calls) == 1
    assert guard_calls[0][1]["destination_is_explicit_separate"] is True
    assert guard_calls[0][1]["destination_release_year"] == 2002
    assert connection.commits == 0


def test_explicit_separate_exclusion_requires_full_membership_in_guard_and_writer():
    # Guard and writer must both exclude another destination only for a complete
    # explicitly separate owner. This asserts SQL, not actual row selection.
    guard = normalized(persistence._ordered_cover_structural_identity_conflict_sql())
    writer = normalized(persistence._persist_structural_album_tag_edit_sql(updates_release_year=True))
    destination = guard.split("destination_albums as", 1)[1].split("locked_albums as", 1)[0]
    assert "not ( %(destination_is_explicit_separate)s::boolean and source.selected_count = source.active_count )" in destination
    existing = writer.split("existing_destination_album as", 1)[1].split("renamed_source_album as", 1)[0]
    assert "%(destination_is_explicit_separate)s::boolean" in existing
    assert "(select input_path_count from selection_scope) = (select count(*) from source_album_track_files)" in existing
    assert "source.selected_count <> source.active_count" in guard
    assert "destination.id <> source.id" in guard


class DetachedDestinationConnection(RecordingConnection):
    """Match the projected destination, not SQL execution or real DB ownership."""
    def __init__(self, *, path_count, separate_keys=()):
        super().__init__(count=path_count)
        self.path_count = path_count
        self.expected_key = "fixture::original" if path_count == 1 else "fixture::original::year::unresolved"
        self.separate_keys = set(separate_keys)
        self.guard_destinations = []

    def execute(self, sql, params=None):
        if "select library.separate_releases.release_key" in sql:
            self.operations.append((sql, params))
            assert len(self.separate_keys) <= 1
            return Cursor({"release_key": next(iter(self.separate_keys))} if self.separate_keys else None)
        if "as blocked_by_ordered_selection" in sql:
            self.operations.append((sql, params))
            self.guard_destinations.append(deepcopy(params))
            # Only the actual Fixture/Original restore owner has an ordered list.
            # Multiple input years use the real projector's unresolved-year owner.
            # A Various Artists owner or explicit separate-year key must not trigger it.
            blocked = (params["destination_album_key"] == self.expected_key
                       and params["destination_artist_key"] == "fixture"
                       and params["destination_album_title"] == "Original"
                       and params["destination_edition"] == "")
            return Cursor({"blocked_by_ordered_selection": blocked})
        result = super().execute(sql, params)
        if result.row and "input_path_count" in result.row:
            result.row.update(input_path_count=self.path_count, resolved_path_count=self.path_count,
                              source_album_count=0, source_album_track_file_count=0)
        return result


def detached_restore_operation(*, various=False, years=(2001,), collection=False):
    before = {}
    for index, year in enumerate(years):
        path = PATH if index == 0 else PATH.replace("01.flac", f"{index + 1:02}.flac")
        before[path] = {"path": path, "album": "Original", "album_artist": "Various Artists" if various else "Fixture",
                        "artist": "Fixture", "title": f"Track {index + 1}", "year": year,
                        "mtime": 1.0, "size": 100, "track_number": index + 1,
                        "disc_number": 1, "duration_seconds": 60,
                        "exception_type": "Non-album rarity", "custom_collection_name": "Rarities"}
    after = {path: {**entry, "exception_type": ""} for path, entry in before.items()}
    fields = {"exception_type"}
    if collection:
        fields.add("custom_collection_name")
        for entry in after.values():
            entry["custom_collection_name"] = ""
    return dict(changed_paths=set(before), previous_file_entries=before,
                updated_file_entries=after, changed_field_names=fields)


def native_restore_adapter(connection):
    # Deliberately keep the production album builder default.
    return persistence.PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/structural_unit"},
        connect=lambda _: connection)


@pytest.mark.parametrize("collection", [False, True])
@pytest.mark.parametrize("various,years,separate_keys", [
    (True, (2001,), ()),
    (False, (2001,), ("fixture::original",)),
    (False, (2001, 2002), ("fixture::original",)),
])
def test_detached_restore_real_projection_prevalidation_matches_writer(various, years, separate_keys, collection):
    operation = detached_restore_operation(various=various, years=years, collection=collection)
    destinations = []
    # Exercise native writer dispatch first: this is the policy preflight must match.
    for phase in ("persist_structural_tag_edit", "validate_structural_tag_edit"):
        connection = DetachedDestinationConnection(path_count=len(years), separate_keys=separate_keys)
        with pytest.raises(persistence.OrderedCoverSelectionConflict):
            getattr(native_restore_adapter(connection), phase)(**operation)
        assert len(connection.guard_destinations) == 1
        destinations.append(connection.guard_destinations[0])
        assert connection.commits == 0
        assert not any("update library." in normalized(sql) or "delete from library." in normalized(sql)
                       or "insert into library." in normalized(sql) for sql, _ in connection.operations)
    assert destinations[0] == destinations[1]
    assert destinations[0]["destination_album_key"] == connection.expected_key
    assert destinations[0]["destination_artist_key"] == "fixture"


def test_native_detached_various_artist_restore_rejects_before_intent_and_task():
    from music_app.services.edit_workflows import handle_edit_tags_request

    operation = detached_restore_operation(various=True)
    state = {"file_cache": operation["previous_file_entries"], "separate_release_keys": set()}
    original = deepcopy(state)
    connection = DetachedDestinationConnection(path_count=1)
    effects = []

    def forbidden(*args, **kwargs):
        effects.append((args, kwargs))
        pytest.fail("Actual detached-restore destination conflict must precede intent and save work")

    payload, status = handle_edit_tags_request(
        album={"name": "Original", "album_artist": "Various Artists", "tracks": [{"path": PATH}]},
        updates={PATH: {"exception_type": ""}}, requested_track_paths={PATH},
        config={}, logger=SimpleNamespace(), get_state=lambda: state,
        create_save_task=forbidden, queue_finalize_save_task=forbidden,
        apply_repairs_worker=forbidden, prepare_tag_edit_intent=forbidden,
        mark_tag_edit_files_verified=forbidden,
        update_cache_entry_after_repairs=lambda path, entry, repairs: {**entry, **repairs},
        build_affected_album_dicts=forbidden, load_separate_release_keys=lambda _: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda *args, **kwargs: None,
        log_app_event=lambda *args, **kwargs: None,
        structural_edit_fields={"album"}, edit_write_workers=1,
        save_track_exception_override=forbidden,
        prevalidate_structural_tag_edit=native_restore_adapter(connection).validate_structural_tag_edit,
    )
    assert status == 409 and payload["ok"] is False
    assert "ordered cover" in payload["error"].lower()
    assert effects == [] and state == original
    assert connection.commits == 0
    assert len(connection.guard_destinations) == 1
    assert connection.guard_destinations[0]["destination_artist_key"] == "fixture"


class ExceptionBatchConnection(RecordingConnection):
    """Controlled conflict verdict and source counts; does not evaluate SQL."""
    def __init__(self, *, blocked=False, source_count=1, previous_entries=None):
        super().__init__(blocked=blocked, count=2)
        self.source_count = source_count
        self.previous_entries = previous_entries

    def execute(self, sql, params=None):
        result = super().execute(sql, params)
        if result.row and "input_path_count" in result.row:
            result.row.update(input_path_count=2, resolved_path_count=2,
                              source_album_count=self.source_count)
        return result


def exception_batch_operation(kind):
    operation = detached_restore_operation(years=(2001, 2001))
    paths = sorted(operation["changed_paths"])
    before, after = operation["previous_file_entries"], operation["updated_file_entries"]
    for path in paths:
        before[path]["custom_collection_name"] = ""
        after[path]["custom_collection_name"] = ""
    if kind == "mixed":
        before[paths[1]]["exception_type"] = ""
        after[paths[1]]["exception_type"] = "Non-album rarity"
    elif kind == "multiple_sources":
        for index, path in enumerate(paths):
            before[path].update(exception_type="", album=f"Source {index}")
            after[path].update(exception_type="Non-album rarity", album=f"Source {index}")
    elif kind == "label":
        for path in paths:
            after[path]["exception_type"] = "Custom Collection"
            after[path]["custom_collection_name"] = "Rarities"
        operation["changed_field_names"].add("custom_collection_name")
    elif kind == "collection":
        for path in paths:
            before[path].update(exception_type="Custom Collection", custom_collection_name="Before")
            after[path].update(exception_type="Custom Collection", custom_collection_name="After")
        operation["changed_field_names"] = {"custom_collection_name"}
    else:
        raise AssertionError(kind)
    return operation


def native_exception_bridge(state, effects, intent_connection):
    # Execute the actual production bridge AST with only its external seams
    # injected. This avoids importing HTTP startup and is not an HTTP/DB test.
    import ast
    import inspect
    from collections.abc import Mapping
    from pathlib import Path
    from typing import Any
    from music_app.services.tag_edit_intents_postgres import PostgresTagEditIntentRepository

    route_path = Path(__file__).parents[2] / "music_app/routes/api_wave_a_asgi_routes.py"
    tree = ast.parse(route_path.read_text())
    bridge = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                  and node.name == "_bridge_queue_finalize_save_task")
    repo = PostgresTagEditIntentRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/structural_unit"},
        connect=lambda _: intent_connection)

    def queue(**options):
        effects.append("queue")
        assert options["scoped_postgres_exception_only"] is True
        # This is the callback the existing scoped finalizer actually invokes.
        options["complete_scoped_persistence"]()

    def no_targeted_writer(*args, **kwargs):
        pytest.fail("Non-all-clear exceptions must use per-path intent completion")

    namespace = dict(
        Any=Any, Mapping=Mapping, inspect=inspect,
        append_log_history=lambda *a, **k: None, log_app_event=lambda *a, **k: None,
        _STRUCTURAL_EDIT_FIELDS={"album"}, _RELATION_PROJECTION_EDIT_FIELDS=set(),
        PostgresTagEditIntentRepository=lambda config: repo,
        normalize_exception_value=lambda value: str(value or "").strip(),
        persist_structural_tag_edit_for_config=no_targeted_writer,
        queue_finalize_save_task=queue,
        run_runtime_state_mutation_for_state=lambda *a, **k: None,
    )
    exec(compile(ast.Module(body=[bridge], type_ignores=[]), str(route_path), "exec"), namespace)
    return lambda **options: namespace[bridge.name](
        **options, get_state=lambda: state, scoped_postgres_exception_only=True,
        find_albums_by_track_paths=lambda paths: [],
        find_problematic_album_by_track_paths=lambda paths: None)


@pytest.mark.parametrize("kind,blocked", [
    ("mixed", False), ("mixed", True),
    ("multiple_sources", False), ("multiple_sources", True),
    ("label", True), ("collection", True),
])
def test_native_exception_batch_preserves_dispatch_and_legacy_compatibility(kind, blocked, monkeypatch):
    from music_app.services.edit_workflows import handle_edit_tags_request

    guarded_payloads = []
    actual_guard = persistence.assert_ordered_cover_edit_updates_allowed

    def record_guard(connection, updates):
        guarded_payloads.append(deepcopy(updates))
        return actual_guard(connection, updates)

    monkeypatch.setattr(persistence, "assert_ordered_cover_edit_updates_allowed", record_guard)
    operation = exception_batch_operation(kind)
    state = {"file_cache": operation["previous_file_entries"], "separate_release_keys": set()}
    original = deepcopy(state)
    connection = ExceptionBatchConnection(
        blocked=blocked, source_count=2 if kind == "multiple_sources" else 1,
        previous_entries=operation["previous_file_entries"])
    intent_connection = RecordingConnection()
    effects = []
    prepared = []
    updates = {path: {field: entry[field] for field in operation["changed_field_names"]}
               for path, entry in operation["updated_file_entries"].items()}

    def prepare(**options):
        effects.append("intent")
        prepared.extend(options["changes"])
        return "synthetic-exception-intent"

    def forbidden(*args, **kwargs):
        pytest.fail("Exception-only workflow must not perform media writes or independent override saves")

    def create_task(kind):
        effects.append("task")
        return "synthetic-exception-task"

    result = handle_edit_tags_request(
        album={"name": "Original", "album_artist": "Fixture",
               "tracks": [{"path": path} for path in sorted(operation["changed_paths"])]},
        updates=updates, requested_track_paths=operation["changed_paths"],
        config={}, logger=SimpleNamespace(), get_state=lambda: state,
        create_save_task=create_task,
        queue_finalize_save_task=native_exception_bridge(state, effects, intent_connection),
        apply_repairs_worker=forbidden, prepare_tag_edit_intent=prepare,
        mark_tag_edit_files_verified=lambda _: effects.append("verified"),
        update_cache_entry_after_repairs=lambda path, entry, repairs: {**entry, **repairs},
        build_affected_album_dicts=lambda *args: [], load_separate_release_keys=lambda _: set(),
        normalize_exception_value=lambda value: str(value or "").strip(),
        append_log_history=lambda *args, **kwargs: None,
        log_app_event=lambda *args, **kwargs: None,
        structural_edit_fields={"album"}, edit_write_workers=1,
        save_track_exception_override=forbidden,
        prevalidate_structural_tag_edit=native_restore_adapter(connection).validate_structural_tag_edit,
    )
    should_conflict = blocked and kind in {"mixed", "multiple_sources"}
    if should_conflict:
        payload, status = result
        assert status == 409 and payload["ok"] is False
        assert "ordered cover" in payload["error"].lower()
        assert effects == [] and prepared == [] and intent_connection.operations == []
    else:
        assert isinstance(result, dict), result
        assert result["ok"] is True and result["changed_count"] == 2
        assert effects == ["intent", "verified", "task", "queue"]
        assert {row["path"] for row in prepared} == operation["changed_paths"]
        overrides = [params for sql, params in intent_connection.operations
                     if "track_key" in (params or {})]
        assert [params["track_key"] for params in overrides] == sorted(operation["changed_paths"])
        for params in overrides:
            expected = operation["updated_file_entries"][params["track_key"]]
            assert params["override_payload"].obj == {
                "exception_type": expected["exception_type"],
                **({"custom_collection_name": expected["custom_collection_name"]}
                   if kind in {"label", "collection"} else {}),
            }
        assert any(params and params.get("status") == "completed"
                   for _, params in intent_connection.operations)
    guards = [params for sql, params in connection.operations
              if "as blocked_by_ordered_selection" in sql]
    assert len(guards) == 1
    assert set(guards[0]["changed_paths"]) == operation["changed_paths"]
    expected_memberships = {
        path: {"exception_type": entry["exception_type"]}
        for path, entry in operation["updated_file_entries"].items()
    }
    assert guarded_payloads[0] == expected_memberships
    assert not any("update library." in normalized(sql) or "delete from library." in normalized(sql)
                   or "insert into library." in normalized(sql) for sql, _ in connection.operations)
    assert state == original
    assert connection.commits == 0
