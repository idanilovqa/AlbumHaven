from __future__ import annotations

from contextlib import contextmanager

from music_app.services.album_identity_lineage_postgres import (
    AlbumIdentityLineageRepository,
)


class _Result:
    def __init__(self, rows):
        self._rows = list(rows)

    def fetchall(self):
        return list(self._rows)


class _Connection:
    def __init__(self, rows):
        self.rows = list(rows)
        self.params = None

    def execute(self, sql, params):
        assert "album_identity_lineage_resolution_v1" in str(sql)
        self.params = dict(params)
        return _Result(self.rows)


def _repository(rows):
    connection = _Connection(rows)

    @contextmanager
    def connect(_database_url):
        yield connection

    return AlbumIdentityLineageRepository(
        {"APP_DATABASE_URL": "postgresql://example"},
        connect=connect,
    ), connection


def _candidate(album_id, key, *, depth=1, matched_paths=0, requested_paths=0):
    return {
        "album_id": album_id,
        "album_key": key,
        "title": f"Album {album_id}",
        "album_artist": "Artist",
        "release_year": 2026,
        "depth": depth,
        "cycle_detected": False,
        "matched_path_count": matched_paths,
        "requested_path_count": requested_paths,
    }


def test_resolve_returns_the_current_album_without_calling_it_a_transition():
    repository, _connection = _repository([_candidate(7, "artist::album", depth=0)])

    result = repository.resolve(album_id=7, album_key="artist::album")

    assert result == {
        "status": "current",
        "album": {
            "album_id": 7,
            "album_key": "artist::album",
            "name": "Album 7",
            "album_artist": "Artist",
            "year": 2026,
        },
        "choices": [],
    }


def test_resolve_follows_a_merge_to_one_current_album():
    repository, _connection = _repository([_candidate(9, "artist::merged", depth=2)])

    result = repository.resolve(album_id=4, album_key="artist::old")

    assert result["status"] == "resolved"
    assert result["album"]["album_id"] == 9
    assert result["choices"] == []


def test_resolve_returns_split_choices_without_guessing():
    repository, _connection = _repository(
        [_candidate(10, "artist::disc-a"), _candidate(11, "artist::disc-b")]
    )

    result = repository.resolve(album_id=4, album_key="artist::old")

    assert result["status"] == "split"
    assert result["album"] is None
    assert [choice["album_id"] for choice in result["choices"]] == [10, 11]


def test_resolve_uses_complete_track_path_evidence_to_disambiguate_a_split():
    repository, connection = _repository(
        [
            _candidate(10, "artist::disc-a", matched_paths=2, requested_paths=2),
            _candidate(11, "artist::disc-b", matched_paths=0, requested_paths=2),
        ]
    )

    result = repository.resolve(
        album_id=4,
        album_key="artist::old",
        track_paths={"C:/Music/a.mp3", "C:/Music/b.mp3"},
    )

    assert result["status"] == "resolved"
    assert result["album"]["album_id"] == 10
    assert connection.params["track_paths"] == ["C:/Music/a.mp3", "C:/Music/b.mp3"]


def test_resolve_fails_closed_for_cycles_and_missing_or_cross_library_targets():
    cycle_repository, _connection = _repository(
        [{**_candidate(None, "", depth=16), "cycle_detected": True}]
    )
    missing_repository, _connection = _repository([])

    assert cycle_repository.resolve(album_id=4)["status"] == "invalid"
    assert missing_repository.resolve(album_id=4)["status"] == "unresolved"

