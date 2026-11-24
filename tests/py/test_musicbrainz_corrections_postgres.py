"""MusicBrainz data corrections and the Edits Queue on real isolated PostgreSQL (Delivery 2, S4).

Each test owns a freshly migrated isolated database. Nothing calls MusicBrainz: releases and
decisions are stored as a recorded release lookup would store them.
"""
from __future__ import annotations

import json

import pytest

from music_app.services.musicbrainz_correction_display import apply_correction_display
from music_app.services.musicbrainz_corrections import MusicBrainzCorrectionService
from music_app.services.musicbrainz_corrections_postgres import MusicBrainzCorrectionsPostgresRepository
from music_app.services.musicbrainz_lookup_queue_postgres import MusicBrainzLookupQueuePostgresRepository
from tests.e2e.support import isolatedPostgres
from tests.py.test_musicbrainz_release_identity_postgres import GROUP, NOW, RELEASE, _seed

BOX = "00000000-0000-4000-8000-0000000000c2"


def _credit(*names):
    return [{"name": name, "artist_name": name, "join_phrase": " & " if index < len(names) - 1 else ""}
            for index, name in enumerate(names)]


def _medium(position, *tracks):
    return {"position": position, "tracks": [
        {"position": index, "title": title, "artist_credit": _credit(*artists)}
        for index, (title, *artists) in enumerate(tracks, start=1)]}


def _store_release(connection, mbid, title, credit, media):
    connection.execute(
        "insert into integration.musicbrainz_releases (mbid, release_group_mbid, title, artist_credit, media,"
        " refreshed_at) values (%s, %s, %s, %s, %s, %s)",
        (mbid, GROUP, title, json.dumps(credit), json.dumps(media), NOW))


def _decide(connection, album_key, *, state="release", release=RELEASE, disc_position=None):
    connection.execute(
        "insert into library.local_album_musicbrainz_releases (library_id, album_key, state, release_group_mbid,"
        " release_mbid, disc_position, matcher_version, observed_at, match_quality)"
        " select library_id, album_key, %s, %s, %s, %s, 4, %s, %s from library.local_albums where album_key = %s",
        (state, GROUP, release if state == "release" else None, disc_position, NOW,
         "order_exact" if state == "release" else None, album_key))


def _corrections(monkeypatch):
    setup_url, _repository, ids, _albums = _seed(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "insert into integration.musicbrainz_release_groups (mbid, title, refreshed_at) values (%s, 'Amber Cedar', %s)",
            (GROUP, NOW))
        # The first track differs by a typographic apostrophe (no difference) and by case (applied
        # automatically); the second track's artist credit waits for the owner.
        connection.execute("update library.local_tracks set title = 'don''t wander' where track_key = 'rel-cedar-1'")
        _store_release(connection, RELEASE, "Amber Cedar", _credit("Amberline"),
                       [_medium(1, ("Don’t Wander", "Amberline"), ("Song 2", "Amberline", "Guest Singer"))])
        _decide(connection, "rel-cedar")
        # One disc of a box set: local disc 1 is the release's second medium.
        _store_release(connection, BOX, "Harbor Field Box", _credit("Amberline"),
                       [_medium(1, ("Wrong", "Amberline")), _medium(2, ("Song 1", "Amberline"), ("Song 2", "Amberline"))])
        _decide(connection, "rel-harbor", release=BOX, disc_position=2)
        # A release group alone proposes nothing.
        _decide(connection, "rel-else", state="release_group")
    repository = MusicBrainzCorrectionsPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))
    return setup_url, repository, ids


def _rows(repository, album_key):
    return [(row["field"], row["current_value"], row["proposed_value"], row["kind"], row["mode"], row["state"])
            for row in repository.album_rows(album_key=album_key)]


def test_refresh_stores_each_difference_with_its_kind_and_mode(monkeypatch):
    _setup_url, repository, _ids = _corrections(monkeypatch)

    assert repository.refresh(observed_at=NOW) == 2

    assert _rows(repository, "rel-cedar") == [
        ("title", "don't wander", "Don’t Wander", "case", "auto", "applied"),
        ("artist", "Amberline", "Amberline & Guest Singer", "track_artist_joined", "review", "pending")]
    assert _rows(repository, "rel-harbor") == [("album", "Harbor Field", "Harbor Field Box", "album_title", "review", "pending")]
    summaries = {row["album_key"]: row for row in repository.list_summaries()["items"]}
    assert (summaries["rel-cedar"]["auto_count"], summaries["rel-cedar"]["review_count"]) == (1, 1)
    assert repository.refresh(observed_at=NOW) == 0, "nothing changed: nothing is compared again"


def test_undo_is_remembered_and_a_refresh_never_reapplies_it(monkeypatch):
    setup_url, repository, _ids = _corrections(monkeypatch)
    service = MusicBrainzCorrectionService(repository, now=lambda: NOW)
    repository.refresh(observed_at=NOW)

    assert service.undo_album(album_key="rel-cedar", actor_account_id=None) == 1
    with isolatedPostgres._connect(setup_url) as connection:
        # A tag edit elsewhere on the album makes the refresh compare it again.
        connection.execute("update library.local_tracks set title = 'song 2' where track_key = 'rel-cedar-2'")
    assert repository.refresh(observed_at=NOW) == 1

    assert _rows(repository, "rel-cedar")[0][-1] == "undone"
    with isolatedPostgres._connect(setup_url) as connection:
        tracks = connection.execute("select title from library.local_tracks where track_key = 'rel-cedar-1'").fetchall()
    assert [row["title"] for row in tracks] == ["don't wander"], "nothing writes tags"


def test_skip_is_remembered_approval_applies_and_artist_kinds_are_never_approved_as_a_kind(monkeypatch):
    _setup_url, repository, _ids = _corrections(monkeypatch)
    service = MusicBrainzCorrectionService(repository, now=lambda: NOW)
    repository.refresh(observed_at=NOW)

    with pytest.raises(ValueError):
        service.approve_kind(kind="track_artist_joined", actor_account_id=None)
    assert service.approve_kind(kind="album_title", actor_account_id=None) == 1
    assert service.skip_album(album_key="rel-cedar", actor_account_id=None) == 1
    repository.refresh(observed_at=NOW)

    assert {row[3]: row[-1] for row in _rows(repository, "rel-cedar")} == {"case": "applied", "track_artist_joined": "skipped"}
    assert _rows(repository, "rel-harbor")[0][-1] == "applied"
    assert "track_artist_joined" not in {group["kind"] for group in service.edits_queue(section="review")["kinds"]}


def test_the_guard_sends_an_album_to_review_whole_and_ambiguous_pairing_compares_no_tracks(monkeypatch):
    setup_url, repository, _ids = _corrections(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        # Half the titles change substantially.
        connection.execute("update library.local_tracks set title = 'The Window' where track_key = 'rel-harbor-1'")
        connection.execute("update library.local_albums set title = 'amber cedar' where album_key = 'rel-cedar'")
        connection.execute("update library.local_album_musicbrainz_releases set match_quality = 'ambiguous',"
                           " track_order_differs = true where album_key = 'rel-cedar'")
    service = MusicBrainzCorrectionService(repository, now=lambda: NOW)
    repository.refresh(observed_at=NOW)

    summaries = {row["album_key"]: row for row in repository.list_summaries()["items"]}
    assert summaries["rel-harbor"]["review_whole"] is True and summaries["rel-harbor"]["auto_count"] == 0
    assert {row[4] for row in _rows(repository, "rel-harbor")} == {"review"}
    assert summaries["rel-cedar"]["review_whole"] is True
    assert _rows(repository, "rel-cedar") == [("album", "amber cedar", "Amber Cedar", "case", "review", "pending")]
    assert "whole_album" in {group["kind"] for group in service.edits_queue(section="review")["kinds"]}


def test_without_substantial_title_changes_the_guard_stays_off_and_trivial_rows_apply(monkeypatch):
    _setup_url, repository, _ids = _corrections(monkeypatch)
    repository.refresh(observed_at=NOW)

    summaries = {row["album_key"]: row for row in repository.list_summaries()["items"]}
    assert summaries["rel-cedar"]["review_whole"] is False
    assert _rows(repository, "rel-cedar")[0][4:] == ("auto", "applied")


def test_album_details_show_applied_values_beside_the_unchanged_tags(monkeypatch):
    setup_url, repository, _ids = _corrections(monkeypatch)
    repository.refresh(observed_at=NOW)
    album = {"name": "Amber Cedar", "album_artist": "Amberline",
             "tracks": [{"disc_number": 1, "track_number": 1, "title": "don't wander", "artist": "Amberline"},
                        {"disc_number": 1, "track_number": 2, "title": "Song 2", "artist": "Amberline"}]}
    with isolatedPostgres._connect(setup_url) as connection:
        album_id = connection.execute("select id from library.local_albums where album_key = 'rel-cedar'").fetchone()["id"]
        apply_correction_display(connection, album, album_id=album_id)

    first, second = album["tracks"]
    assert (first["title"], first["display_title"]) == ("don't wander", "Don’t Wander")
    assert "display_title" not in second and "display_artist" not in second, "waiting changes are not shown"
    assert "display_title" not in album and "display_artist" not in album, "no field when nothing differs"


def test_stored_counts_follow_tag_changes_and_an_album_that_loses_its_match(monkeypatch):
    setup_url, repository, _ids = _corrections(monkeypatch)
    repository.refresh(observed_at=NOW)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update library.local_tracks set title = 'Don''t Wander' where track_key = 'rel-cedar-1'")
        connection.execute("update library.local_album_musicbrainz_releases set state = 'release_group',"
                           " release_mbid = null, match_quality = null, track_order_differs = false"
                           " where album_key = 'rel-harbor'")

    repository.refresh(observed_at=NOW)

    assert {row["album_key"]: row["correction_count"] for row in repository.list_summaries()["items"]} == {"rel-cedar": 1}
    assert _rows(repository, "rel-harbor") == []


def test_only_albums_with_a_change_waiting_for_approval_need_a_correction(monkeypatch):
    setup_url, repository, _ids = _corrections(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        # The artist credit is already in the tags: only the automatic case change is left.
        connection.execute("update library.local_tracks set artist = 'Amberline & Guest Singer'"
                           " where track_key = 'rel-cedar-2'")
    service = MusicBrainzCorrectionService(repository, now=lambda: NOW)
    repository.refresh(observed_at=NOW)

    assert _rows(repository, "rel-cedar") == [("title", "don't wander", "Don’t Wander", "case", "auto", "applied")]
    summaries = repository.list_summaries()
    assert [row["album_key"] for row in summaries["items"]] == ["rel-harbor"]
    assert summaries["total"] == 1
    assert repository.list_summaries(album_keys=["rel-cedar", "rel-harbor"])["items"][0]["album_key"] == "rel-harbor"
    assert len(repository.list_summaries(album_keys=["rel-cedar", "rel-harbor"])["items"]) == 1
    # Still listed as applied automatically, with Undo.
    assert "case" in {group["kind"] for group in service.edits_queue(section="applied")["kinds"]}


def test_opening_the_problematic_files_list_never_runs_the_comparison(monkeypatch):
    from types import SimpleNamespace

    from music_app.routes.musicbrainz_corrections_asgi import project_correction_problems_into_problematic_files

    setup_url, repository, _ids = _corrections(monkeypatch)
    repository.refresh(observed_at=NOW)
    statements = []

    class Recording:
        def __init__(self, connection):
            self._connection = connection

        def __enter__(self):
            self._inner = self._connection.__enter__()
            return self

        def __exit__(self, *args):
            return self._connection.__exit__(*args)

        def execute(self, sql, *args, **kwargs):
            statements.append(str(sql))
            return self._inner.execute(sql, *args, **kwargs)

    recording = MusicBrainzCorrectionsPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
        connect=lambda _url: Recording(isolatedPostgres._connect(setup_url)))
    actor = SimpleNamespace(account_id=1, current_library_id=1,
                            library_relationships=(SimpleNamespace(library_id=1, is_primary_owner=True),))
    request = SimpleNamespace(state=SimpleNamespace(current_actor=actor), app=SimpleNamespace(state=SimpleNamespace(
        musicbrainz_correction_service=MusicBrainzCorrectionService(recording), config={})))
    payload = {"items": [{"key": "rel-cedar", "name": "Amber Cedar", "problem_reasons": []},
                         {"key": "rel-none", "name": "Nothing", "problem_reasons": []}], "count": 2}

    project_correction_problems_into_problematic_files(request, payload)

    assert [item["problem_reasons"] for item in payload["items"]] == [["Data Correction Needed"], []]
    assert (payload["count"], payload["musicbrainz_correction_album_count"]) == (2, 2)
    assert len(statements) == 2, "the listed albums' stored counts and the total; no comparison"
    assert not any("media" in sql for sql in statements)


def test_only_a_waiting_lookup_can_be_removed(monkeypatch):
    setup_url, _repository, ids = _corrections(monkeypatch)
    lookups = MusicBrainzLookupQueuePostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))
    waiting = lookups.request(target_kind="album", mode="queue", album_key="rel-cedar", actor_account_id=None,
                              observed_at=NOW)
    running = lookups.request(target_kind="artist", mode="search", local_artist_id=ids["other"],
                              actor_account_id=None, observed_at=NOW)

    assert lookups.remove_queued(request_id=running["request_id"]) is False
    assert lookups.remove_queued(request_id=waiting["request_id"]) is True
    assert lookups.list_lookups()["queued"] == []


def _search(setup_url, query):
    from music_app.services.library_browse_postgres import _search_preview_sql

    params = {"query_like": f"%{query}%", "query_latin_like": None, "category_count": 0, "visible_categories": [],
              "include_missing": True, "search_artist_keys": []}
    with isolatedPostgres._connect(setup_url) as connection:
        return {row["album_key"] for row in connection.execute(_search_preview_sql(), params).fetchall()}


def test_search_finds_an_applied_correction_and_after_undo_only_the_tag(monkeypatch):
    setup_url, repository, _ids = _corrections(monkeypatch)
    changed = []
    repository._on_change = changed.append
    with isolatedPostgres._connect(setup_url) as connection:
        # Search lists only albums with files on disk.
        connection.execute("insert into library.local_track_files (track_id, private_path, metadata)"
                           " select id, 'C:/Music/' || track_key || '.flac', '{}'::jsonb from library.local_tracks")
        # A small edit (a typo) applies automatically.
        connection.execute("update library.local_tracks set title = 'Harvsting' where track_key = 'rel-cedar-1'")
        connection.execute("update integration.musicbrainz_releases set media = %s where mbid = %s", (json.dumps(
            [_medium(1, ("Harvesting", "Amberline"), ("Song 2", "Amberline"))]), RELEASE))
    service = MusicBrainzCorrectionService(repository, now=lambda: NOW)
    repository.refresh(observed_at=NOW)

    with isolatedPostgres._connect(setup_url) as connection:
        stored = connection.execute("select title, corrected_title from library.local_tracks"
                                    " where track_key = 'rel-cedar-1'").fetchone()
    assert (stored["title"], stored["corrected_title"]) == ("Harvsting", "Harvesting"), "the tag value stays"
    assert "rel-cedar" in _search(setup_url, "Harvesting") and "rel-cedar" in _search(setup_url, "Harvsting")
    assert changed and "rel-cedar" in changed[-1], "search, gallery and Problematic Files caches are invalidated"

    service.undo_album(album_key="rel-cedar", actor_account_id=None)

    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute("select corrected_title from library.local_tracks"
                                  " where track_key = 'rel-cedar-1'").fetchone()["corrected_title"] is None
    assert "rel-cedar" not in _search(setup_url, "Harvesting")
    assert "rel-cedar" in _search(setup_url, "Harvsting")
    assert "rel-cedar" in changed[-1]


def test_copies_of_a_song_at_one_position_never_fail_the_refresh_or_a_decision(monkeypatch):
    # One such album used to fail the whole refresh, which then stored nothing.
    setup_url, repository, _ids = _corrections(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        for key, title in (("same", "don't wander"), ("other-case", "DON'T WANDER")):
            connection.execute(
                "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, disc_number,"
                " track_number, metadata) select library_id, album_id, artist_id, %s, %s, 1, 1, '{}'::jsonb"
                " from library.local_tracks where track_key = 'rel-cedar-1'", (f"rel-cedar-1-{key}", title))
    service = MusicBrainzCorrectionService(repository, now=lambda: NOW)

    assert repository.refresh(observed_at=NOW) == 2
    with isolatedPostgres._connect(setup_url) as connection:
        shown = connection.execute("select corrected_title from library.local_tracks"
                                   " where track_key like 'rel-cedar-1%%'", ()).fetchall()
    assert [row["corrected_title"] for row in shown] == ["Don’t Wander"] * 3
    assert service.undo_album(album_key="rel-cedar", actor_account_id=None) == 2, "one row per distinct tag value"


def test_a_main_name_row_stored_before_the_credited_name_rule_is_dropped_on_the_next_refresh(monkeypatch):
    # An album keeps its credited name, although its artist's main name is another. Invented names.
    from music_app.services import musicbrainz_corrections_postgres as store

    setup_url, repository, _ids = _corrections(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update library.local_artists set name = 'Fixture Duo' where artist_key = 'rel-amber'")
        connection.execute("update integration.musicbrainz_releases set artist_credit = %s", (json.dumps(
            [{"name": "Fixture Duo", "artist_name": "Fixture Folk Band", "join_phrase": ""}]),))
    repository.refresh(observed_at=NOW)
    with isolatedPostgres._connect(setup_url) as connection:
        album_id = connection.execute("select id from library.local_albums where album_key = 'rel-cedar'").fetchone()["id"]
        # As code from before the rule stored it: the same tags and release, so the same signature without the rules.
        before_rule = connection.execute(
            store._SIGNATURES_SQL.replace(f"'rules-{store.COMPARE_RULES_VERSION}', ", ""),
            {"album_ids": [album_id]}).fetchone()["signature"]
        connection.execute(
            "insert into library.local_album_musicbrainz_correction_rows (library_id, album_key, field, current_value,"
            " proposed_value, kind, mode) select library_id, album_key, 'album_artist', 'Fixture Duo', 'Fixture Folk Band',"
            " 'album_artist_renamed', 'review' from library.local_albums where id = %s", (album_id,))
        connection.execute("update library.local_album_musicbrainz_corrections set signature = %s"
                           " where album_key = 'rel-cedar'", (before_rule,))
        connection.execute("insert into library.musicbrainz_correction_refresh_marks (album_id) values (%s)", (album_id,))

    repository.refresh(observed_at=NOW)

    assert "album_artist" not in {row[0] for row in _rows(repository, "rel-cedar")}
