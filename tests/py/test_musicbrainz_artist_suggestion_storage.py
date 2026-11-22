"""Where "MusicBrainz: artist undecided" keeps its suggestions (migration 0259)."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from music_app.services import empty_local_album_retirement
from music_app.services.musicbrainz_enrichment import MusicBrainzArtistEnrichmentProcessor
from music_app.services.musicbrainz_enrichment_postgres import MusicBrainzEnrichmentPostgresRepository
from tests.py.test_musicbrainz_enrichment import Repository, Resolver

NOW = datetime(2026, 11, 22, 12, 0, tzinfo=timezone.utc)
GERMAN = "00000000-0000-4000-8000-000000000021"
TRANCE = "00000000-0000-4000-8000-000000000022"
TABLE = "library.local_album_artist_suggestions"
MIGRATION = Path(__file__).resolve().parents[2] / "migrations" / "postgres" / "0259_create_album_artist_suggestions.sql"
SUGGESTION = {"local_album_id": 3, "favoured_mbid": GERMAN, "artists": [
    {"artist_mbid": GERMAN, "found": 2, "sampled": 3, "folder_album": None},
    {"artist_mbid": TRANCE, "found": 0, "sampled": 3, "folder_album": "Zebrine Cartography"},
]}


class _Cursor:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row

    def fetchall(self):
        return []


class _Connection:
    def __init__(self, protected=False):
        self.protected, self.calls = protected, []

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        return None

    def transaction(self):
        from contextlib import nullcontext
        return nullcontext()

    def execute(self, sql, params=None):
        self.calls.append((" ".join(sql.lower().split()), params))
        return _Cursor({"protected": self.protected, "candidate_count": 0})

    def suggestion_writes(self):
        return [(sql, params) for sql, params in self.calls
                if f"delete from {TABLE}" in sql or f"insert into {TABLE}" in sql]


def _repository(connection):
    return MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/album_haven_test"},
        connect=lambda _url: connection)


def _record(connection, **values):
    _repository(connection).record_automatic_outcome(
        local_artist_id=41, state="per_album", artist=None, confidence=1, evidence_summary="Two artists.",
        observed_at=NOW, album_identities=[], identity_artists=[], **values)


def test_a_recheck_replaces_the_artist_s_suggestions_and_keeps_those_of_unchecked_albums():
    connection = _Connection()

    _record(connection, album_suggestions=[SUGGESTION], album_suggestions_unchecked=[9])

    (removed, remove_params), (stored, store_params) = connection.suggestion_writes()
    assert remove_params["unchecked_album_ids"] == [9]
    assert "albums.artist_id = %(local_artist_id)s" in removed and "unchecked_album_ids" in removed
    assert "albums.artist_id = %(local_artist_id)s" in stored, "only the job's own artist's albums"
    assert "not exists" in stored and "local_album_artist_identities" in stored, "never beside a decision"
    assert json.loads(store_params["album_suggestions"]) == [
        {"local_album_id": 3, "artist_mbid": GERMAN, "found_count": 2, "sampled_count": 3,
         "folder_album": None, "favoured": True},
        {"local_album_id": 3, "artist_mbid": TRANCE, "found_count": 0, "sampled_count": 3,
         "folder_album": "Zebrine Cartography", "favoured": False},
    ]


def test_a_suggestion_never_writes_an_album_identity():
    connection = _Connection()

    _record(connection, album_suggestions=[SUGGESTION])

    identity_writes = [params for sql, params in connection.calls
                       if "insert into library.local_album_artist_identities" in sql]
    assert [json.loads(params["album_identities"]) for params in identity_writes] == [[]]


def test_a_protected_manual_match_keeps_its_rows_untouched():
    connection = _Connection(protected=True)
    _record(connection, album_suggestions=[SUGGESTION])
    assert connection.suggestion_writes() == []


def test_a_candidate_outcome_clears_the_artist_s_suggestions():
    connection = _Connection()
    _repository(connection).replace_candidates(
        local_artist_id=41, candidates=[], match_state="ambiguous", evidence_summary="Review.", observed_at=NOW)

    (_removed, params), = connection.suggestion_writes()
    assert params["unchecked_album_ids"] == []


def test_the_worker_hands_the_suggestions_to_the_repository():
    repository = Repository()
    repository.claims.append({"id": 19, "local_artist_id": 42, "attempt_count": 0})
    repository.contexts[19] = {"local_artist_id": 42, "local_name": "Fixture Band", "manual_decision": False, "albums": []}
    processor = MusicBrainzArtistEnrichmentProcessor(
        repository=repository, client=object(), now=lambda: NOW,
        resolve_artist=Resolver({"classification": "per_album", "confidence": 1, "album_identities": [], "artists": [],
                                 "album_suggestions": [SUGGESTION], "album_suggestions_unchecked": [9],
                                 "evidence_summary": "Two artists."}))

    processor.process_next(worker_id="worker-a")

    stored = repository.automatic_outcomes[0]
    assert (stored["album_suggestions"], stored["album_suggestions_unchecked"]) == ([SUGGESTION], [9])


def test_the_migration_stores_suggestions_only_and_follows_the_album():
    sql = " ".join(MIGRATION.read_text(encoding="utf-8").lower().split())

    assert sql.startswith("-- depends on: 0258_invalidate_gallery_on_split_labels.sql")
    assert f"create table if not exists {TABLE}" in sql
    assert "primary key (library_id, album_key, artist_mbid)" in sql
    assert "on update cascade on delete cascade" in sql
    assert "where favoured" in sql, "at most one favoured artist per album"
    assert "insert into" not in sql.replace("grant select, insert", ""), "no backfill"
    assert "create trigger" not in sql, "a suggestion invalidates no gallery"
    assert f"revoke all on table {TABLE} from public" in sql


def test_a_vacated_album_takes_its_suggestions_with_it():
    assert TABLE in empty_local_album_retirement.SCAN_OWNED_ALBUM_CHILD_TABLES
