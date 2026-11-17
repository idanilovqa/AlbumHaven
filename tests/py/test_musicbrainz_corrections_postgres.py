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

BOX = "050e7238-9751-4521-91b6-89c672eac591"


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
            "insert into integration.musicbrainz_release_groups (mbid, title, refreshed_at) values (%s, 'Angels Cry', %s)",
            (GROUP, NOW))
        # The first track differs by a typographic apostrophe (no difference) and by case (applied
        # automatically); the second track's artist credit waits for the owner.
        connection.execute("update library.local_tracks set title = 'don''t despair' where track_key = 'rel-cry-1'")
        _store_release(connection, RELEASE, "Angels Cry", _credit("Angra"),
                       [_medium(1, ("Don’t Despair", "Angra"), ("Song 2", "Angra", "Andre Matos"))])
        _decide(connection, "rel-cry")
        # One disc of a box set: local disc 1 is the release's second medium.
        _store_release(connection, BOX, "Holy Land Box", _credit("Angra"),
                       [_medium(1, ("Wrong", "Angra")), _medium(2, ("Song 1", "Angra"), ("Song 2", "Angra"))])
        _decide(connection, "rel-holy", release=BOX, disc_position=2)
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

    assert _rows(repository, "rel-cry") == [
        ("title", "don't despair", "Don’t Despair", "case", "auto", "applied"),
        ("artist", "Angra", "Angra & Andre Matos", "track_artist_joined", "review", "pending")]
    assert _rows(repository, "rel-holy") == [("album", "Holy Land", "Holy Land Box", "album_title", "review", "pending")]
    summaries = {row["album_key"]: row for row in repository.list_summaries()["items"]}
    assert (summaries["rel-cry"]["auto_count"], summaries["rel-cry"]["review_count"]) == (1, 1)
    assert repository.refresh(observed_at=NOW) == 0, "nothing changed: nothing is compared again"


def test_undo_is_remembered_and_a_refresh_never_reapplies_it(monkeypatch):
    setup_url, repository, _ids = _corrections(monkeypatch)
    service = MusicBrainzCorrectionService(repository, now=lambda: NOW)
    repository.refresh(observed_at=NOW)

    assert service.undo_album(album_key="rel-cry", actor_account_id=None) == 1
    with isolatedPostgres._connect(setup_url) as connection:
        # A tag edit elsewhere on the album makes the refresh compare it again.
        connection.execute("update library.local_tracks set title = 'song 2' where track_key = 'rel-cry-2'")
    assert repository.refresh(observed_at=NOW) == 1

    assert _rows(repository, "rel-cry")[0][-1] == "undone"
    with isolatedPostgres._connect(setup_url) as connection:
        tracks = connection.execute("select title from library.local_tracks where track_key = 'rel-cry-1'").fetchall()
    assert [row["title"] for row in tracks] == ["don't despair"], "nothing writes tags"


def test_skip_is_remembered_approval_applies_and_artist_kinds_are_never_approved_as_a_kind(monkeypatch):
    _setup_url, repository, _ids = _corrections(monkeypatch)
    service = MusicBrainzCorrectionService(repository, now=lambda: NOW)
    repository.refresh(observed_at=NOW)

    with pytest.raises(ValueError):
        service.approve_kind(kind="track_artist_joined", actor_account_id=None)
    assert service.approve_kind(kind="album_title", actor_account_id=None) == 1
    assert service.skip_album(album_key="rel-cry", actor_account_id=None) == 1
    repository.refresh(observed_at=NOW)

    assert {row[3]: row[-1] for row in _rows(repository, "rel-cry")} == {"case": "applied", "track_artist_joined": "skipped"}
    assert _rows(repository, "rel-holy")[0][-1] == "applied"
    assert "track_artist_joined" not in {group["kind"] for group in service.edits_queue(section="review")["kinds"]}


def test_the_guard_sends_an_album_to_review_whole_and_ambiguous_pairing_compares_no_tracks(monkeypatch):
    setup_url, repository, _ids = _corrections(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        # Dream Evil's shape: half the titles change substantially.
        connection.execute("update library.local_tracks set title = 'The Mirror' where track_key = 'rel-holy-1'")
        connection.execute("update library.local_albums set title = 'angels cry' where album_key = 'rel-cry'")
        connection.execute("update library.local_album_musicbrainz_releases set match_quality = 'ambiguous',"
                           " track_order_differs = true where album_key = 'rel-cry'")
    service = MusicBrainzCorrectionService(repository, now=lambda: NOW)
    repository.refresh(observed_at=NOW)

    summaries = {row["album_key"]: row for row in repository.list_summaries()["items"]}
    assert summaries["rel-holy"]["review_whole"] is True and summaries["rel-holy"]["auto_count"] == 0
    assert {row[4] for row in _rows(repository, "rel-holy")} == {"review"}
    assert summaries["rel-cry"]["review_whole"] is True
    assert _rows(repository, "rel-cry") == [("album", "angels cry", "Angels Cry", "case", "review", "pending")]
    assert "whole_album" in {group["kind"] for group in service.edits_queue(section="review")["kinds"]}


def test_without_substantial_title_changes_the_guard_stays_off_and_trivial_rows_apply(monkeypatch):
    _setup_url, repository, _ids = _corrections(monkeypatch)
    repository.refresh(observed_at=NOW)

    summaries = {row["album_key"]: row for row in repository.list_summaries()["items"]}
    assert summaries["rel-cry"]["review_whole"] is False
    assert _rows(repository, "rel-cry")[0][4:] == ("auto", "applied")


def test_album_details_show_applied_values_beside_the_unchanged_tags(monkeypatch):
    setup_url, repository, _ids = _corrections(monkeypatch)
    repository.refresh(observed_at=NOW)
    album = {"name": "Angels Cry", "album_artist": "Angra",
             "tracks": [{"disc_number": 1, "track_number": 1, "title": "don't despair", "artist": "Angra"},
                        {"disc_number": 1, "track_number": 2, "title": "Song 2", "artist": "Angra"}]}
    with isolatedPostgres._connect(setup_url) as connection:
        album_id = connection.execute("select id from library.local_albums where album_key = 'rel-cry'").fetchone()["id"]
        apply_correction_display(connection, album, album_id=album_id)

    first, second = album["tracks"]
    assert (first["title"], first["display_title"]) == ("don't despair", "Don’t Despair")
    assert "display_title" not in second and "display_artist" not in second, "waiting changes are not shown"
    assert "display_title" not in album and "display_artist" not in album, "no field when nothing differs"


def test_stored_counts_follow_tag_changes_and_an_album_that_loses_its_match(monkeypatch):
    setup_url, repository, _ids = _corrections(monkeypatch)
    repository.refresh(observed_at=NOW)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update library.local_tracks set title = 'Don''t Despair' where track_key = 'rel-cry-1'")
        connection.execute("update library.local_album_musicbrainz_releases set state = 'release_group',"
                           " release_mbid = null, match_quality = null, track_order_differs = false"
                           " where album_key = 'rel-holy'")

    repository.refresh(observed_at=NOW)

    assert {row["album_key"]: row["correction_count"] for row in repository.list_summaries()["items"]} == {"rel-cry": 1}
    assert _rows(repository, "rel-holy") == []


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
    payload = {"items": [{"key": "rel-cry", "name": "Angels Cry", "problem_reasons": []},
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
    waiting = lookups.request(target_kind="album", mode="queue", album_key="rel-cry", actor_account_id=None,
                              observed_at=NOW)
    running = lookups.request(target_kind="artist", mode="search", local_artist_id=ids["other"],
                              actor_account_id=None, observed_at=NOW)

    assert lookups.remove_queued(request_id=running["request_id"]) is False
    assert lookups.remove_queued(request_id=waiting["request_id"]) is True
    assert lookups.list_lookups()["queued"] == []
