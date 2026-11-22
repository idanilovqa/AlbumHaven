"""MusicBrainz data corrections and the Edits Queue (Delivery 2, S4), without a database."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.musicbrainz_corrections import (
    MusicBrainzCorrectionService,
    label_rows,
    next_auto_submit_at,
)

NOW = datetime(2026, 11, 16, 10, 20, tzinfo=timezone.utc)


def test_rows_are_labelled_by_tag_and_name_their_disc_only_when_there_are_several():
    one_disc = label_rows([{"field": "album", "disc_number": 0, "track_number": 0},
                           {"field": "title", "disc_number": 1, "track_number": 3}])
    two_discs = label_rows([{"field": "artist", "disc_number": 1, "track_number": 1},
                            {"field": "title", "disc_number": 2, "track_number": 4}])

    assert [row["label"] for row in one_disc] == ["Album title", "Track 3 title"]
    assert [row["label"] for row in two_discs] == ["Disc 1, track 1 artist", "Disc 2, track 4 title"]


def test_auto_submit_is_due_hourly_from_when_it_was_switched_on_and_never_while_off():
    on = {"auto_submit_bulks": True, "changed_at": NOW}

    assert next_auto_submit_at(on, NOW) == NOW + timedelta(hours=1)
    assert next_auto_submit_at(on, NOW + timedelta(minutes=61)) == NOW + timedelta(hours=2)
    assert next_auto_submit_at({"auto_submit_bulks": False, "changed_at": NOW}, NOW) is None
    assert next_auto_submit_at({"auto_submit_bulks": True, "changed_at": None}, NOW) is None


class Repository:
    def __init__(self):
        self.decisions = []

    def settings(self):
        return {"auto_submit_bulks": True, "changed_at": NOW - timedelta(minutes=30)}

    def kinds(self, *, section):
        return [{"kind": "case", "albums": 1, "rows": 2}]

    def decide(self, **kwargs):
        self.decisions.append(kwargs)
        return 1


def test_album_decisions_record_what_they_change_and_from_which_state():
    repository = Repository()
    service = MusicBrainzCorrectionService(repository, now=lambda: NOW)

    service.undo_album(album_key="a", actor_account_id=7)
    service.approve_album(album_key="b", actor_account_id=7)
    service.skip_album(album_key="c", actor_account_id=7)
    service.approve_kind(kind="edition_suffix", actor_account_id=7)

    assert [(item["decision"], item["from_state"], item["album_key"], item["kind"]) for item in repository.decisions] == [
        ("undone", "applied", "a", None), ("approved", "pending", "b", None), ("skipped", "pending", "c", None),
        ("approved", "pending", None, "edition_suffix")]


@pytest.mark.parametrize("kind", ["track_artist_renamed", "track_artist_joined", "album_artist_renamed",
                                  "album_artist_joined", "case", "whole_album"])
def test_artist_and_automatic_kinds_are_never_approved_as_a_kind(kind):
    repository = Repository()

    with pytest.raises(ValueError):
        MusicBrainzCorrectionService(repository).approve_kind(kind=kind, actor_account_id=7)
    assert repository.decisions == []


def test_the_edits_queue_names_its_next_run_and_the_hourly_run_writes_nothing_yet():
    service = MusicBrainzCorrectionService(Repository(), now=lambda: NOW)

    assert service.edits_queue(section="applied") == {"section": "applied", "kinds": [
        {"kind": "case", "albums": 1, "rows": 2}], "settings": {"auto_submit_bulks": True,
                                                              "next_run_at": NOW + timedelta(minutes=30)}}
    with pytest.raises(ValueError):
        service.edits_queue(section="everything")
    assert service.submit_due_bulk_corrections() == 0


def test_problematic_files_invalidation_refreshes_stored_corrections_in_the_background(monkeypatch):
    from music_app.services import library_browse_postgres, musicbrainz_corrections_postgres as store

    scheduled = []
    monkeypatch.setattr(store, "schedule_correction_refresh", scheduled.append)

    library_browse_postgres.invalidate_postgres_utility_projection_cache(database_url="postgresql://s4", kinds=("rules",))
    library_browse_postgres.invalidate_postgres_utility_projection_cache(
        database_url="postgresql://s4", kinds=("problematic-files",))

    assert scheduled == ["postgresql://s4"]


def test_background_refreshes_run_only_where_enabled_and_fold_requests_into_one_more_run(monkeypatch):
    import threading

    from music_app.services import musicbrainz_corrections_postgres as store

    started, release, runs = threading.Event(), threading.Event(), []

    class Repository:
        def __init__(self, config):
            self.url = config["ALBUM_HAVEN_APP_DATABASE_URL"]

        def refresh(self):
            runs.append(self.url)
            started.set()
            release.wait(5)

    monkeypatch.setattr(store, "MusicBrainzCorrectionsPostgresRepository", Repository)
    monkeypatch.setattr(store, "_REFRESH_ENABLED", set())
    monkeypatch.setattr(store, "_REFRESH_RUNNING", {})

    store.schedule_correction_refresh("postgresql://other")
    store.enable_background_correction_refresh("postgresql://s4")
    assert started.wait(5)
    store.schedule_correction_refresh("postgresql://s4")
    store.schedule_correction_refresh("postgresql://s4")
    release.set()
    for _ in range(100):
        if not store._REFRESH_RUNNING:
            break
        threading.Event().wait(0.05)

    assert runs == ["postgresql://s4", "postgresql://s4"]


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _Connection:
    def __init__(self, rows):
        self.rows, self.queries = rows, []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params):
        self.queries.append(params)
        return _Cursor(self.rows)


def test_cards_get_display_fields_only_where_the_corrected_value_differs():
    from music_app.services.musicbrainz_correction_display import project_correction_display

    connection = _Connection([{"album_key": "a", "corrected_title": "Harvesting", "corrected_album_artist": None},
                              {"album_key": "b", "corrected_title": "Same", "corrected_album_artist": "Band"}])
    payload = {"groups": [{"albums": [{"key": "a", "name": "Harvsting", "album_artist": "Band"},
                                      {"key": "b", "name": "Same", "album_artist": "band"},
                                      {"key": "c", "name": "Other", "album_artist": "Band"}]}]}

    project_correction_display({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://x"}, payload,
                               connect=lambda _url: connection)

    a, b, c = payload["groups"][0]["albums"]
    assert (a["name"], a["display_title"]) == ("Harvsting", "Harvesting") and "display_artist" not in a
    assert "display_title" not in b and b["display_artist"] == "Band"
    assert set(c) == {"key", "name", "album_artist"}, "an untouched album carries no extra bytes"
    assert connection.queries == [{"album_keys": ["a", "b", "c"]}], "one read per response"


def test_search_matches_the_corrected_values_through_their_own_prefiltered_indexes():
    from music_app.services.library_browse_postgres import _search_preview_sql

    sql = " ".join(_search_preview_sql(use_utf8_prefilter=True).split()).lower()
    migration = (__import__("pathlib").Path(__file__).resolve().parents[2]
                 / "migrations" / "postgres" / "0198_add_musicbrainz_correction_rows_and_decisions.sql").read_text(
        encoding="utf-8").lower()

    for column in ("library.local_albums.corrected_title", "library.local_albums.corrected_album_artist",
                   "library.local_tracks.corrected_title", "library.local_tracks.corrected_artist"):
        assert f"lower(btrim(coalesce({column}, ''))) like lower(%(query_like)s)" in sql
    for column in ("corrected_title", "corrected_artist"):
        assert (f"library.search_utf8_hex( lower(btrim(coalesce(library.local_tracks.{column}, ''))))"
                not in sql)
        assert f"library.search_utf8_hex(lower(btrim(coalesce(library.local_tracks.{column}, ''))))" in sql
        assert f"library.search_utf8_hex(lower(btrim(coalesce({column}, '')))) %i.gin_trgm_ops" in migration
    # Album arms name their column non-null so the planner can use 0254's partial indexes.
    album_migration = " ".join((__import__("pathlib").Path(__file__).resolve().parents[2] / "migrations" / "postgres"
                                / "0254_add_musicbrainz_corrected_album_search_indexes.sql").read_text(encoding="utf-8").lower().split())
    for column in ("corrected_title", "corrected_album_artist"):
        assert f"(library.local_albums.{column} is not null and lower(btrim(coalesce(library.local_albums.{column}" in sql
        assert f"( (lower(btrim(coalesce({column}, '')))) %i.gin_trgm_ops ) where {column} is not null" in album_migration


class _DataError(Exception):
    sqlstate = "21000"


def _marked_store(monkeypatch, fails):
    from music_app.services import musicbrainz_corrections_postgres as store

    marks = {number: number for number in range(1, 6)}

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def execute(self, sql, params=None):
            rows = []
            if sql is store._MARKS_SQL:
                after = (params or {}).get("after", 0)
                rows = [{"id": key, "album_id": value} for key, value in sorted(marks.items())
                        if key > after][:params["limit"]]
            elif sql is store._CLEAR_MARKS_SQL:
                for key in params["mark_ids"]:
                    marks.pop(key, None)
            return type("Result", (), {"fetchall": lambda _self: rows})()

    repository = store.MusicBrainzCorrectionsPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://s4"}, connect=lambda _url: Connection())

    def refresh_albums(_connection, album_ids, _now):
        for album_id in album_ids:
            fails(album_id)
        return len(album_ids), ()

    monkeypatch.setattr(repository, "_refresh_albums", refresh_albums)
    return repository, marks


def test_one_album_that_cannot_be_stored_never_stops_the_others_refresh(monkeypatch, caplog):
    def fails(album_id):
        if album_id == 3:
            raise _DataError("more than one row returned by a subquery used as an expression")

    repository, marks = _marked_store(monkeypatch, fails)

    with caplog.at_level("WARNING"):
        assert repository.refresh() == 4

    assert marks == {3: 3}, "only the failed album waits for the next refresh"
    assert "album 3" in caplog.text and "_DataError" in caplog.text and "21000" in caplog.text


def test_a_database_outage_is_not_retried_album_by_album(monkeypatch):
    attempts = []

    def fails(album_id):
        attempts.append(album_id)
        raise ConnectionError("down")

    repository, marks = _marked_store(monkeypatch, fails)

    with pytest.raises(ConnectionError):
        repository.refresh()
    assert attempts == [1] and len(marks) == 5


def test_a_failed_background_refresh_logs_its_cause(monkeypatch, caplog):
    from music_app.services import musicbrainz_corrections_postgres as store

    class Repository:
        def __init__(self, _config):
            pass

        def refresh(self):
            raise _DataError("more than one row returned by a subquery used as an expression")

    monkeypatch.setattr(store, "MusicBrainzCorrectionsPostgresRepository", Repository)
    monkeypatch.setattr(store, "_REFRESH_RUNNING", {"postgresql://s4": False})

    with caplog.at_level("WARNING"):
        store._refresh_until_settled("postgresql://s4")

    assert "_DataError" in caplog.text and "21000" in caplog.text


# The correct album artist is the release's credited name, not the artist's main name, except for
# spelling-only differences. Every name below is invented.
def _album_artist_rows(tag, *credit):
    from music_app.services.musicbrainz_corrections_postgres import compare_stored_album

    rows = compare_stored_album({
        "title": "Album", "release_title": "Album", "artist_name": tag, "media": [], "tracks": [],
        "artist_credit": [{"name": name, "artist_name": main, "join_phrase": join} for name, main, join in credit],
    })["rows"]
    return [(row["current_value"], row["proposed_value"]) for row in rows if row["field"] == "album_artist"]


@pytest.mark.parametrize("credited,main", [
    ("Fixture Duo", "Fixture Folk Band"), ("Fixture", "Fixture Folk Band"), ("Example", "Example of Testing"),
    ("試験楽団", "Shiken Gakudan"),
])
def test_a_correctly_credited_album_is_never_offered_the_artists_main_name(credited, main):
    assert _album_artist_rows(credited, (credited, main, "")) == []


def test_an_album_tagged_with_the_main_name_is_offered_the_credited_one():
    assert _album_artist_rows("Fixture Folk Band", ("Fixture Duo", "Fixture Folk Band", "")) == [
        ("Fixture Folk Band", "Fixture Duo")]


@pytest.mark.parametrize("credited,main", [("EX-AM", "EX/AM"), ("Example Oster Choir", "Example Öster Choir"),
                                           ("Tests N Samples", "Tests N' Samples")])
def test_a_spelling_only_credit_takes_the_artists_main_name(credited, main):
    assert _album_artist_rows(main, (credited, main, "")) == [], "the main name is never respelled as the credit"
    assert _album_artist_rows(credited, (credited, main, "")) == [(credited, main)]


def test_a_joint_credit_keeps_its_names_as_written():
    credit = (("Fixture Duo", "Fixture Folk Band", " & "), ("EX-AM", "EX/AM", ""))

    assert _album_artist_rows("Fixture Duo & EX-AM", *credit) == []


def test_a_credit_without_a_credited_name_proposes_no_album_artist():
    assert _album_artist_rows("Fixture Duo", ("", "Fixture Folk Band", "")) == [], "the main name never stands in for it"


def test_a_correction_row_stored_before_the_rule_is_compared_again_and_dropped():
    from music_app.services import musicbrainz_corrections_postgres as store

    stored_rows = [{"field": "album_artist", "current_value": "Fixture Duo", "proposed_value": "Fixture Folk Band"}]
    # The signature covers the tags and release, which did not change, and the rules that compared them.
    rules = f"'rules-{store.COMPARE_RULES_VERSION}'"
    assert rules in store._SIGNATURES_SQL

    class Connection:
        def execute(self, sql, params=None):
            rows = []
            if sql is store._ALBUM_KEYS_SQL:
                rows = [{"album_key": "fixture-album"}]
            elif sql is store._SIGNATURES_SQL:
                rows = [{"album_id": 1, "library_id": 1, "album_key": "fixture-album", "release_mbid": "r",
                         "signature": "current rules", "stored_signature": "older rules"}]
            elif sql is store._COMPARE_SQL:
                rows = [{"album_id": 1, "title": "Fixture Album", "release_title": "Fixture Album",
                         "artist_name": "Fixture Duo", "media": [], "tracks": [],
                         "artist_credit": [{"name": "Fixture Duo", "artist_name": "Fixture Folk Band",
                                            "join_phrase": ""}]}]
            elif sql is store._STORE_SQL:
                stored_rows.clear()  # the statement deletes the album's rows before storing its summary
            elif sql is store._STORE_ROWS_SQL:
                stored_rows.extend(params["rows"])
            return type("Result", (), {"fetchall": lambda _self: rows})()

    repository = store.MusicBrainzCorrectionsPostgresRepository({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://s4"})

    assert repository._refresh_albums(Connection(), [1], NOW)[0] == 1
    assert stored_rows == []
