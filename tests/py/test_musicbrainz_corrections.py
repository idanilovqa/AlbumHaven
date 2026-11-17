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

    connection = _Connection([{"album_key": "a", "corrected_title": "Hostilities", "corrected_album_artist": None},
                              {"album_key": "b", "corrected_title": "Same", "corrected_album_artist": "Band"}])
    payload = {"groups": [{"albums": [{"key": "a", "name": "Hostlities", "album_artist": "Band"},
                                      {"key": "b", "name": "Same", "album_artist": "band"},
                                      {"key": "c", "name": "Other", "album_artist": "Band"}]}]}

    project_correction_display({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://x"}, payload,
                               connect=lambda _url: connection)

    a, b, c = payload["groups"][0]["albums"]
    assert (a["name"], a["display_title"]) == ("Hostlities", "Hostilities") and "display_artist" not in a
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
