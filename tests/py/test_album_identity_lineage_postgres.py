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
        self.sql = None

    def execute(self, sql, params):
        assert "album_identity_lineage_resolution_v1" in str(sql)
        self.sql = str(sql)
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


def _candidate(
    album_id,
    key,
    *,
    depth=1,
    matched_paths=0,
    requested_paths=0,
    track_count=None,
    matched_by_id=True,
    matched_by_key=True,
):
    candidate = {
        "album_id": album_id,
        "album_key": key,
        "title": f"Album {album_id}",
        "album_artist": "Artist",
        "release_year": 2026,
        "depth": depth,
        "cycle_detected": False,
        "matched_path_count": matched_paths,
        "requested_path_count": requested_paths,
        "matched_by_id": matched_by_id,
        "matched_by_key": matched_by_key,
    }
    if track_count is not None:
        candidate["track_count"] = track_count
    return candidate


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


def test_resolution_sql_tracks_album_id_and_key_as_independent_evidence():
    repository, connection = _repository([_candidate(9, "artist::current", depth=0)])

    result = repository.resolve(album_id=4, album_key="artist::current")

    assert result["status"] == "current"
    compact_sql = " ".join(connection.sql.split())
    assert (
        "where (%(album_id)s::bigint is not null and "
        "transitions.predecessor_album_id = %(album_id)s::bigint) or "
        "(%(album_key)s::text is not null and "
        "transitions.predecessor_album_key = %(album_key)s::text)"
    ) in compact_sql
    assert (
        "where (%(album_id)s::bigint is not null and albums.id = %(album_id)s::bigint) "
        "or (%(album_key)s::text is not null and albums.album_key = %(album_key)s::text)"
    ) in compact_sql
    assert "as matched_by_id" in compact_sql
    assert "as matched_by_key" in compact_sql


def test_resolve_prefers_the_candidate_supported_by_both_identity_inputs():
    repository, _connection = _repository(
        [
            _candidate(
                9,
                "artist::agreed",
                depth=2,
                matched_by_id=True,
                matched_by_key=True,
            ),
            _candidate(
                10,
                "artist::key-only",
                depth=1,
                matched_by_id=False,
                matched_by_key=True,
            ),
        ]
    )

    result = repository.resolve(album_id=4, album_key="artist::old")

    assert result["status"] == "resolved"
    assert result["album"]["album_id"] == 9
    assert result["choices"] == []


def test_resolve_rejects_two_live_identity_inputs_that_do_not_agree():
    repository, _connection = _repository(
        [
            _candidate(9, "artist::id-only", matched_by_id=True, matched_by_key=False),
            _candidate(10, "artist::key-only", matched_by_id=False, matched_by_key=True),
        ]
    )

    assert repository.resolve(album_id=4, album_key="artist::current") == {
        "status": "unresolved",
        "album": None,
        "choices": [],
    }


def test_resolve_uses_exact_paths_to_settle_disagreeing_identity_inputs():
    repository, _connection = _repository(
        [
            _candidate(
                9,
                "artist::id-only",
                matched_paths=2,
                requested_paths=2,
                matched_by_id=True,
                matched_by_key=False,
            ),
            _candidate(
                10,
                "artist::key-only",
                requested_paths=2,
                matched_by_id=False,
                matched_by_key=True,
            ),
        ]
    )

    result = repository.resolve(
        album_id=4,
        album_key="artist::current",
        track_paths={"C:/Music/a.mp3", "C:/Music/b.mp3"},
    )

    assert result["album"]["album_id"] == 9
    assert result["choices"] == []


def test_resolve_returns_split_choices_without_guessing():
    repository, _connection = _repository(
        [
            _candidate(10, "artist::disc-a", track_count=4),
            _candidate(11, "artist::disc-b", track_count=5),
        ]
    )

    result = repository.resolve(album_id=4, album_key="artist::old")

    assert result["status"] == "split"
    assert result["album"] is None
    assert [choice["album_id"] for choice in result["choices"]] == [10, 11]
    assert [choice["track_count"] for choice in result["choices"]] == [4, 5]


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


def test_resolve_rejects_synthetic_unknown_successors():
    unknown = {
        **_candidate(417655, "unknown artist::"),
        "title": "Unknown Album",
        "album_artist": "Unknown Artist",
    }
    repository, _connection = _repository([unknown])

    assert repository.resolve(album_id=4, album_key="artist::old") == {
        "status": "unresolved",
        "album": None,
        "choices": [],
    }


def test_resolve_keeps_named_various_artist_and_known_artist_loose_track_albums():
    named_various_artist = {
        **_candidate(12, "various artists::soundtrack", depth=0),
        "title": "Soundtrack",
        "album_artist": "",
    }
    known_artist_loose_tracks = {
        **_candidate(13, "ddt::", depth=0),
        "title": "Unknown Album",
        "album_artist": "DDT",
    }

    for candidate in (named_various_artist, known_artist_loose_tracks):
        repository, _connection = _repository([candidate])
        assert repository.resolve(album_id=candidate["album_id"])["status"] == "current"

