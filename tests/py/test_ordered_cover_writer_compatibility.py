"""Legacy writer guard contracts; recording connections do not execute Postgres SQL."""
from itertools import product
from pathlib import Path
import re

import pytest

from music_app.services import ordered_cover_references
from music_app.services import scan_cache_persistence as persistence


VARIANTS = [
    pytest.param({}, id="local"),
    pytest.param({"selected_cover_path": None, "remote_cover_url": "https://covers.example/front.jpg"}, id="remote"),
    pytest.param({"selected_cover_path": None, "clear_selection": True}, id="clear"),
    pytest.param({"cover_selection_origin": "automatic", "reject_if_user_controlled": True}, id="automatic"),
    pytest.param({"cover_selection_origin": "user", "explicit_selection": True}, id="explicit"),
    pytest.param({"expected_cover_state": (None, None)}, id="nullable-cas"),
    pytest.param({"expected_cover_selection_origin": "user", "expected_cover_revision": "old"}, id="legacy-cas"),
    pytest.param({"expected_cover_state": ("automatic", "old"), "reject_if_explicit_selection": True}, id="reject-explicit"),
    pytest.param({"local_cover_width": 600, "local_cover_height": 600}, id="local-dimensions"),
]


def result_row(**changes):
    return {"input_path_count": 2, "resolved_path_count": 2, "selected_album_count": 1,
            "album_track_file_count": 3, "album_rows_updated": 1,
            "track_file_rows_updated": 3, "blocked_by_ordered_selection": False,
            "blocked_by_user_selection": False, "blocked_by_expected_cover_state": False,
            **changes}


class RecordingConnection:
    def __init__(self, result, metadata=None):
        self.result = result
        self.metadata = metadata or {}
        self.operations = []
        self.commits = 0
        self.exit_error = None
        self.row = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.exit_error = exc_type

    def execute(self, sql, params=None):
        self.operations.append((sql, params))
        if "as bootstrap_context_ready" in sql:
            self.row = {"bootstrap_context_ready": 1}
        elif "for no key update of albums" in sql:
            self.row = {"album_id": 72, "cover_path": None, "metadata": self.metadata}
        elif params is not None and "track_paths" in params:
            self.row = self.result
        else:
            self.row = None
        return self

    def fetchone(self):
        return self.row

    def commit(self):
        self.commits += 1


def adapter_for(result, *, metadata=None):
    if result.get("blocked_by_ordered_selection"):
        metadata = {"selected_covers": None}
    connection = RecordingConnection(result, metadata)
    adapter = persistence.PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/writer_contract"},
        connect=lambda _: connection,
    )
    return adapter, connection


def write(adapter, **changes):
    return adapter.persist_cover_selection(**{
        "track_paths": {"/unavailable/album/02.flac", "/unavailable/album/01.flac"},
        "selected_cover_path": Path("/unavailable/album/front.jpg"),
        "cover_revision": "new", **changes,
    })


@pytest.mark.parametrize("variant", VARIANTS)
@pytest.mark.parametrize("other_block", [None, "blocked_by_user_selection", "blocked_by_expected_cover_state"])
def test_ordered_conflict_raises_before_revision_or_commit_even_if_other_guards_block(variant, other_block):
    adapter, connection = adapter_for(result_row(
        blocked_by_ordered_selection=True, album_rows_updated=0, track_file_rows_updated=0,
        **({other_block: True} if other_block else {}),
    ))
    guard_calls = []
    # Resolve at test time so absent implementation yields focused failures, not collection failure.
    conflict = getattr(ordered_cover_references, "OrderedCoverSelectionConflict", None)
    assert conflict is not None, "Expose a distinct conflict for legacy writes to ordered selections"
    with pytest.raises(conflict):
        write(adapter, commit_guard=lambda commit: guard_calls.append(commit), **variant)
    assert connection.exit_error is conflict
    assert connection.commits == 0
    assert guard_calls == []
    assert not any("cover_mutation_revision" in sql for sql, _ in connection.operations)
    assert connection.operations[0][0] == persistence._inventory_publication_advisory_lock_sql(shared=True)


@pytest.mark.parametrize("variant", VARIANTS)
def test_legacy_success_retains_counts_and_bumps_revision_once_after_guard_result(variant):
    expected = variant.get("expected_cover_state", (
        variant.get("expected_cover_selection_origin"), variant.get("expected_cover_revision")))
    adapter, connection = adapter_for(result_row(), metadata={
        "cover_selection_origin": expected[0], "cover_revision": expected[1],
    })
    guard_calls = []

    def commit_guard(commit):
        guard_calls.append(True)
        commit()

    assert write(adapter, commit_guard=commit_guard, **variant) == {
        "album_rows_updated": 1, "track_file_rows_updated": 3,
    }
    assert guard_calls == [True]
    assert connection.commits == 1
    revision_indices = [i for i, (sql, _) in enumerate(connection.operations) if "cover_mutation_revision" in sql]
    write_indices = [i for i, (_, params) in enumerate(connection.operations) if params and "selected_cover_path" in params]
    assert len(revision_indices) == len(write_indices) == 1
    assert write_indices[0] < revision_indices[0]
    assert connection.operations[0][0] == persistence._inventory_publication_advisory_lock_sql(shared=True)
    assert connection.operations[write_indices[0]][1]["track_paths"] == [
        "/unavailable/album/01.flac", "/unavailable/album/02.flac",
    ]


@pytest.mark.parametrize("changes", [
    {"resolved_path_count": 1}, {"selected_album_count": 2}, {"selected_album_count": 0},
    {"album_rows_updated": 0}, {"album_track_file_count": 4}, {"track_file_rows_updated": 2},
])
def test_incomplete_or_cross_album_selection_still_fails_closed(changes):
    adapter, connection = adapter_for(result_row(**changes))
    guard_calls = []
    with pytest.raises(RuntimeError, match="complete selected album inventory"):
        write(adapter, commit_guard=lambda commit: guard_calls.append(commit))
    assert connection.commits == 0
    assert guard_calls == []


FLAGS = (
    "include_origin", "include_linked_remote", "include_expected_cover_state",
    "include_clear_selection", "include_explicit_selection",
    "include_reject_explicit_selection", "include_local_dimensions",
)


@pytest.mark.parametrize("values", list(product((False, True), repeat=len(FLAGS))))
def test_every_sql_variant_has_unconditional_object_key_guard_and_scoped_updates(values):
    sql = " ".join(persistence._persist_local_cover_selection_sql(**dict(zip(FLAGS, values))).lower().split())
    assert "as blocked_by_ordered_selection" in sql
    # Key presence, not the value's truthiness or validity, owns the conflict.
    assert re.search(r"(?:\w+\.)*metadata\s*\?\s*'selected_covers'", sql)
    assert re.search(r"jsonb_typeof\((?:\w+\.)*metadata\)\s*=\s*'object'", sql)
    album_update = sql.split("updated_albums as (", 1)[1].split("returning library.local_albums.id", 1)[0]
    assert re.search(r"and not coalesce\s*\(", album_update)
    assert re.search(r"jsonb_typeof\((?:\w+\.)*metadata\)\s*=\s*'object'", album_update)
    assert re.search(r"(?:\w+\.)*metadata\s*\?\s*'selected_covers'", album_update)
    assert re.search(r",\s*false\s*\)", album_update), "Null metadata must not be blocked"
    assert "jsonb_array_length" not in sql
    assert "selected_covers_revision" not in sql
    assert "selection_scope.input_path_count = selection_scope.resolved_path_count" in sql
    assert "selection_scope.selected_album_count = 1" in sql
    assert "library.local_tracks.library_id = bootstrap_context.library_id" in sql
    assert "library.local_albums.library_id = bootstrap_context.library_id" in sql
    assert "library.local_albums.id = (select album_id from target_album)" in sql
    assert "and exists (select 1 from updated_albums)" in sql
    assert "app.bootstrap_owners.owner_key = 'local-bootstrap-owner'" in sql
    assert "library.libraries.library_kind = 'local'" in sql
    assert "__" not in sql
