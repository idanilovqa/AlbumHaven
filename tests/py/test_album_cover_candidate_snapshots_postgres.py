from __future__ import annotations

from contextlib import nullcontext

import pytest

from music_app.services.album_cover_candidate_snapshots_postgres import (
    AlbumCoverCandidateSnapshotRepository,
)


DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"
GENERATION = "1d17c70f-dfa1-41e5-a335-c7c835b0d0ad"
SEARCH_STARTED_AT = "2026-08-03T12:00:00+00:00"


class FakeCursor:
    def __init__(self, *, row=None):
        self._row = row

    def fetchone(self):
        return self._row


class FakeConnection:
    def __init__(self, cursors):
        self.cursors = list(cursors)
        self.calls = []
        self.raw_calls = []

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        return False

    def execute(self, sql, params):
        raw_params = dict(params)
        self.raw_calls.append((sql, raw_params))
        self.calls.append(
            (
                sql,
                {
                    key: getattr(value, "obj", value)
                    for key, value in raw_params.items()
                },
            )
        )
        return self.cursors.pop(0)


def repository_for(connection):
    return AlbumCoverCandidateSnapshotRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=lambda database_url: (
            nullcontext(connection)
            if database_url == DATABASE_URL
            else pytest.fail(f"unexpected database URL: {database_url}")
        ),
    )


def candidate(candidate_id="candidate-1"):
    return {
        "id": candidate_id,
        "source": "musicbrainz",
        "source_label": "MusicBrainz",
        "lookup_group": "musicbrainz",
        "url": f"https://covers.example/{candidate_id}.jpg",
        "thumbnail_url": f"https://covers.example/{candidate_id}-thumb.jpg",
        "width": 1200,
        "height": 1200,
        "score": 0.9,
        "artist": "Artist",
        "album": "Album",
        "year": 2026,
        "art_kind": "cover",
        "art_label": "Front cover",
    }


def snapshot_row(*, candidates=None, **overrides):
    row = {
        "album_id": 41,
        "search_generation": GENERATION,
        "search_kind": "manual",
        "status": "running",
        "revision": 1,
        "candidates": [candidate()],
        "best_candidate_id": "candidate-1",
        "automatic_improvement_revision": 0,
        "seen_automatic_improvement_revision": 0,
        "started_at": "2026-08-03T12:00:00+00:00",
        "updated_at": "2026-08-03T12:00:01+00:00",
        "finished_at": None,
    }
    if candidates is not None:
        row["candidates"] = candidates
    row.update(overrides)
    return row


def test_get_for_album_context_returns_none_when_active_library_has_no_snapshot():
    connection = FakeConnection([FakeCursor(row=None)])

    result = repository_for(connection).get_for_album_context(album_id=41)

    assert result is None
    assert len(connection.calls) == 1


def test_get_for_album_context_scopes_album_through_bootstrap_local_library():
    connection = FakeConnection([FakeCursor(row=snapshot_row())])

    result = repository_for(connection).get_for_album_context(album_id=41)

    assert result["album_id"] == 41
    sql, params = connection.calls[0]
    normalized_sql = " ".join(sql.lower().split())
    assert params == {"album_id": 41}
    assert "from app.bootstrap_owners" in normalized_sql
    assert "join library.libraries" in normalized_sql
    assert "join library.local_albums" in normalized_sql
    assert "local_album_cover_candidate_snapshots" in normalized_sql
    assert "library.local_albums.library_id" in normalized_sql
    assert "%(album_id)s" in sql


def test_resolve_album_id_for_track_paths_uses_complete_active_library_inventory():
    connection = FakeConnection([FakeCursor(row={"album_id": 41})])

    album_id = repository_for(connection).resolve_album_id_for_track_paths(
        track_paths={"C:/Music/A/one.flac", "C:/Music/A/two.flac"}
    )

    assert album_id == 41
    sql, params = connection.calls[0]
    normalized_sql = " ".join(sql.lower().split())
    assert params == {
        "track_paths": ["C:/Music/A/one.flac", "C:/Music/A/two.flac"]
    }
    assert "from app.bootstrap_owners" in normalized_sql
    assert "join library.libraries" in normalized_sql
    assert "unnest(%(track_paths)s::text[])" in normalized_sql
    assert "count(distinct resolved_tracks.album_id) = 1" in normalized_sql
    assert "count(distinct resolved_tracks.private_path)" in normalized_sql
    assert "cardinality(%(track_paths)s::text[])" in normalized_sql


def test_snapshot_read_qualifies_every_returned_column():
    connection = FakeConnection([FakeCursor(row=snapshot_row())])

    repository_for(connection).get_for_album_context(album_id=41)

    normalized_sql = " ".join(connection.calls[0][0].lower().split())
    for column in (
        "album_id",
        "search_generation",
        "search_kind",
        "status",
        "revision",
        "candidates",
        "best_candidate_id",
        "automatic_improvement_revision",
        "seen_automatic_improvement_revision",
        "started_at",
        "updated_at",
        "finished_at",
    ):
        assert f"library.local_album_cover_candidate_snapshots.{column}" in normalized_sql


def test_publish_generation_rejects_empty_candidates_without_opening_postgres():
    repository = AlbumCoverCandidateSnapshotRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=lambda _database_url: pytest.fail("empty publication opened Postgres"),
    )

    assert repository.publish_generation(
        album_id=41,
        search_generation=GENERATION,
        search_kind="manual",
        search_started_at=SEARCH_STARTED_AT,
        candidates=[],
        best_candidate_id=None,
        automatic_improvement=False,
    ) is False


def test_publish_generation_accepts_current_generation_and_progressive_payload():
    candidates = [candidate(), candidate("candidate-2")]
    connection = FakeConnection([FakeCursor(row={"accepted": True})])

    accepted = repository_for(connection).publish_generation(
        album_id=41,
        search_generation=GENERATION,
        search_kind="manual",
        search_started_at=SEARCH_STARTED_AT,
        candidates=candidates,
        best_candidate_id="candidate-2",
        automatic_improvement=False,
    )

    assert accepted is True
    sql, params = connection.calls[0]
    normalized_sql = " ".join(sql.lower().split())
    assert params["album_id"] == 41
    assert params["search_generation"] == GENERATION
    assert params["search_kind"] == "manual"
    assert params["search_started_at"] == SEARCH_STARTED_AT
    assert params["candidates"] == candidates
    assert params["best_candidate_id"] == "candidate-2"
    assert "on conflict (album_id) do update" in normalized_sql
    assert "search_generation" in normalized_sql
    assert "status = 'running'" in normalized_sql
    assert "returning true as accepted" in normalized_sql

    raw_candidates = connection.raw_calls[0][1]["candidates"]
    assert not isinstance(raw_candidates, list)
    assert getattr(raw_candidates, "obj", None) == candidates


def test_publish_generation_rejects_a_stale_generation():
    connection = FakeConnection([FakeCursor(row=None)])

    accepted = repository_for(connection).publish_generation(
        album_id=41,
        search_generation="2c8f52ce-8b2e-4875-a95e-80914d5147b7",
        search_kind="automatic",
        search_started_at=SEARCH_STARTED_AT,
        candidates=[candidate()],
        best_candidate_id="candidate-1",
        automatic_improvement=False,
    )

    assert accepted is False


def test_publish_sql_rejects_older_terminal_replacement_and_terminal_reopen():
    connection = FakeConnection([FakeCursor(row=None)])

    repository_for(connection).publish_generation(
        album_id=41,
        search_generation=GENERATION,
        search_kind="manual",
        search_started_at=SEARCH_STARTED_AT,
        candidates=[candidate()],
        best_candidate_id="candidate-1",
        automatic_improvement=False,
    )

    normalized_sql = " ".join(connection.calls[0][0].lower().split())
    assert "excluded.started_at > library.local_album_cover_candidate_snapshots.started_at" in normalized_sql
    assert (
        "library.local_album_cover_candidate_snapshots.search_generation = excluded.search_generation"
        in normalized_sql
    )
    assert "library.local_album_cover_candidate_snapshots.status = 'running'" in normalized_sql


def test_publish_sql_increments_revisions_only_for_meaningful_new_payloads():
    connection = FakeConnection([FakeCursor(row={"accepted": True})])

    repository_for(connection).publish_generation(
        album_id=41,
        search_generation=GENERATION,
        search_kind="automatic",
        search_started_at=SEARCH_STARTED_AT,
        candidates=[candidate()],
        best_candidate_id="candidate-1",
        automatic_improvement=True,
    )

    normalized_sql = " ".join(connection.calls[0][0].lower().split())
    payload_changed = (
        "library.local_album_cover_candidate_snapshots.candidates is distinct from excluded.candidates"
    )
    best_changed = (
        "library.local_album_cover_candidate_snapshots.best_candidate_id is distinct from excluded.best_candidate_id"
    )
    assert payload_changed in normalized_sql
    assert best_changed in normalized_sql
    revision_assignment = normalized_sql.split("revision =", 1)[1].split(",", 1)[0]
    assert "case" in revision_assignment
    assert payload_changed in revision_assignment or "candidates is distinct from excluded.candidates" in revision_assignment
    improvement_assignment = normalized_sql.split(
        "automatic_improvement_revision =", 1
    )[1].split(",", 1)[0]
    assert "%(automatic_improvement)s" in improvement_assignment
    assert "is distinct from" in improvement_assignment


@pytest.mark.parametrize("status", ["completed", "failed"])
def test_finish_generation_only_finishes_the_matching_generation(status):
    connection = FakeConnection([FakeCursor(row={"accepted": True})])

    accepted = repository_for(connection).finish_generation(
        album_id=41,
        search_generation=GENERATION,
        status=status,
    )

    assert accepted is True
    sql, params = connection.calls[0]
    normalized_sql = " ".join(sql.lower().split())
    assert params == {
        "album_id": 41,
        "search_generation": GENERATION,
        "status": status,
    }
    assert "where" in normalized_sql
    assert "search_generation = %(search_generation)s" in normalized_sql
    assert "finished_at" in normalized_sql
    assert "returning true as accepted" in normalized_sql


def test_mark_seen_advances_seen_revision_without_changing_improvement_revision():
    connection = FakeConnection(
        [
            FakeCursor(
                row=snapshot_row(
                    automatic_improvement_revision=3,
                    seen_automatic_improvement_revision=3,
                )
            )
        ]
    )

    result = repository_for(connection).mark_seen(album_id=41)

    assert result["seen_automatic_improvement_revision"] == 3
    sql, params = connection.calls[0]
    normalized_sql = " ".join(sql.lower().split())
    assert params == {"album_id": 41}
    assert "seen_automatic_improvement_revision" in normalized_sql
    assert "automatic_improvement_revision" in normalized_sql
    assert "join library.local_albums" in normalized_sql
    assert "library.local_albums.library_id" in normalized_sql
    assert "set automatic_improvement_revision" not in normalized_sql


def test_mark_automatic_improvement_alerts_only_for_a_distinct_candidate():
    connection = FakeConnection([FakeCursor(row={"accepted": True})])

    accepted = repository_for(connection).mark_automatic_improvement(
        album_id=41,
        search_generation=GENERATION,
        candidate_id="candidate-1",
    )

    assert accepted is True
    normalized_sql = " ".join(connection.calls[0][0].lower().split())
    assert "automatic_improvement_candidate_id = %(candidate_id)s" in normalized_sql
    assert "automatic_improvement_candidate_id is distinct from %(candidate_id)s" in normalized_sql


def test_get_for_album_context_fails_closed_for_malformed_candidate_payload():
    connection = FakeConnection(
        [FakeCursor(row=snapshot_row(candidates={"unexpected": "object"}))]
    )

    result = repository_for(connection).get_for_album_context(album_id=41)

    assert result["candidates"] == []
    assert result["diagnostic"] == "malformed_candidate_snapshot"


@pytest.mark.parametrize(
    "candidates",
    [
        [{"id": "private", "url": "file:///C:/Music/cover.jpg"}],
        [{**candidate(), "debug": {"token": "secret"}}],
    ],
)
def test_get_for_album_context_fails_closed_for_invalid_candidate_items(candidates):
    connection = FakeConnection([FakeCursor(row=snapshot_row(candidates=candidates))])

    result = repository_for(connection).get_for_album_context(album_id=41)

    assert result["candidates"] == []
    assert result["diagnostic"] == "malformed_candidate_snapshot"
