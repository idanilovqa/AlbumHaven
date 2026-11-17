"""MusicBrainz data corrections and the Edits Queue on real isolated PostgreSQL (Delivery 2, S4).

Each test owns a freshly migrated isolated database. Nothing calls MusicBrainz: releases and
decisions are stored as a recorded release lookup would store them.
"""
from __future__ import annotations

import json
from datetime import timedelta

import pytest

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
        " release_mbid, disc_position, matcher_version, observed_at)"
        " select library_id, album_key, %s, %s, %s, %s, 2, %s from library.local_albums where album_key = %s",
        (state, GROUP, release if state == "release" else None, disc_position, NOW, album_key))


def _corrections(monkeypatch):
    setup_url, _repository, ids, _albums = _seed(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "insert into integration.musicbrainz_release_groups (mbid, title, refreshed_at) values (%s, 'Angels Cry', %s)",
            (GROUP, NOW))
        # Only a typographic apostrophe differs on the first track, so it agrees; the second
        # track's title and artist differ.
        connection.execute("update library.local_tracks set title = 'Don''t Despair' where track_key = 'rel-cry-1'")
        _store_release(connection, RELEASE, "Angels Cry", _credit("Angra"),
                       [_medium(1, ("Don’t Despair", "Angra"), ("Carry On", "Angra", "Andre Matos"))])
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


def test_corrections_name_each_real_difference_from_the_certain_release_and_nothing_else(monkeypatch):
    _setup_url, repository, _ids = _corrections(monkeypatch)
    service = MusicBrainzCorrectionService(repository, now=lambda: NOW)

    albums = {key: service.get_correction(album_key=key) for key in ("rel-cry", "rel-holy")}

    assert set(albums) == {"rel-cry", "rel-holy"}
    cry = albums["rel-cry"]
    assert [(item["label"], item["current"], item["proposed"]) for item in cry["corrections"]] == [
        ("Artist (1 track)", "Angra", "Angra & Andre Matos"), ("Track 2 title", "Song 2", "Carry On")]
    assert (cry["track_count"], cry["year"], cry["release_mbid"], cry["queued_at"]) == (2, 1993, RELEASE, None)
    holy = albums["rel-holy"]
    assert [(item["label"], item["current"], item["proposed"]) for item in holy["corrections"]] == [
        ("Album title", "Holy Land", "Holy Land Box")]
    assert service.get_correction(album_key="rel-else") is None


def test_album_artist_differences_use_the_release_credit_as_written(monkeypatch):
    setup_url, repository, _ids = _corrections(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update integration.musicbrainz_releases set artist_credit = %s where mbid = %s",
                           (json.dumps(_credit("Magma")), BOX))

    holy = MusicBrainzCorrectionService(repository).get_correction(album_key="rel-holy")

    assert [(item["field"], item["current"], item["proposed"]) for item in holy["corrections"]] == [
        ("album", "Holy Land", "Holy Land Box"), ("album_artist", "Angra", "Magma")]


def test_add_to_queue_keeps_the_snapshot_and_remove_drops_it(monkeypatch):
    setup_url, repository, _ids = _corrections(monkeypatch)
    service = MusicBrainzCorrectionService(repository, now=lambda: NOW)

    queued = service.queue_correction(album_key="rel-cry", actor_account_id=None)
    again = service.queue_correction(album_key="rel-cry", actor_account_id=None)

    assert again["entry_id"] == queued["entry_id"] and queued["queued_at"] == NOW
    (entry,) = service.list_queue()["items"]
    assert (entry["album_title"], entry["artist_name"], entry["release_mbid"]) == ("Angels Cry", "Angra", RELEASE)
    assert [item["label"] for item in entry["corrections"]] == ["Artist (1 track)", "Track 2 title"]
    repository.refresh(observed_at=NOW)
    assert {row["album_key"]: row["queued_at"]
            for row in service.list_correction_summaries()["items"]}["rel-cry"] == NOW
    assert service.queue_correction(album_key="rel-else", actor_account_id=None) is None
    with isolatedPostgres._connect(setup_url) as connection:
        tracks = connection.execute("select title from library.local_tracks where track_key like 'rel-cry-%%'"
                                    " order by track_key").fetchall()
    assert [row["title"] for row in tracks] == ["Don't Despair", "Song 2"], "queueing never changes tags"

    assert service.remove_queued(entry_id=queued["entry_id"]) is True
    assert service.remove_queued(entry_id=queued["entry_id"]) is False
    assert service.list_queue()["items"] == []


def test_auto_submit_bulks_is_off_until_switched_on_and_counts_from_the_switch(monkeypatch):
    _setup_url, repository, _ids = _corrections(monkeypatch)
    clock = [NOW]
    service = MusicBrainzCorrectionService(repository, now=lambda: clock[0])

    assert service.list_queue()["settings"] == {"auto_submit_bulks": False, "next_run_at": None}
    assert service.save_settings(auto_submit_bulks=True, actor_account_id=None) == {
        "auto_submit_bulks": True, "next_run_at": NOW + timedelta(hours=1)}
    clock[0] = NOW + timedelta(minutes=90)
    # Saving the same value again keeps the hour the queue counts from.
    assert service.save_settings(auto_submit_bulks=True, actor_account_id=None)["next_run_at"] == NOW + timedelta(hours=2)
    assert service.save_settings(auto_submit_bulks=False, actor_account_id=None)["next_run_at"] is None


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


# Owner 2026-11-16: case, spacing, accents, typos and edition suffixes are corrections;
# curly against straight punctuation is not, for now.
@pytest.mark.parametrize("local,remote,proposed", [
    ("Carry on", "Carry On", True),
    ("Carry  On", "Carry On", True),
    ("Carry On ", "Carry On", True),
    (" Carry On", "Carry On", True),
    ("Carry On", "Cárry On", True),
    ("Cary On", "Carry On", True),
    ("Carry On (Live)", "Carry On", True),
    ("Carry On", "Carry On", False),
    ("Don't Despair", "Don’t Despair", False),
    ('The "Crazy" Ones', "The “Crazy” Ones", False),
    ("Track - One", "Track – One", False),
])
def test_each_correction_rule(monkeypatch, local, remote, proposed):
    setup_url, repository, _ids = _corrections(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update library.local_tracks set title = %s where track_key = 'rel-cry-2'", (local,))
        connection.execute("update integration.musicbrainz_releases set media = %s where mbid = %s", (json.dumps(
            [_medium(1, ("Don’t Despair", "Angra"), (remote, "Angra"))]), RELEASE))

    album = MusicBrainzCorrectionService(repository).get_correction(album_key="rel-cry")

    rows = [(item["current"], item["proposed"]) for item in (album or {}).get("corrections", [])]
    assert rows == ([(local, remote)] if proposed else [])


def test_stored_counts_follow_decisions_and_tag_changes_and_only_changed_albums_are_compared(monkeypatch):
    setup_url, repository, _ids = _corrections(monkeypatch)

    assert repository.refresh(observed_at=NOW) == 2
    assert {row["album_key"]: row["correction_count"] for row in repository.list_summaries()["items"]} == {
        "rel-cry": 2, "rel-holy": 1}
    page = repository.list_summaries(offset=1, limit=1)
    assert ([row["album_key"] for row in page["items"]], page["total"]) == (["rel-holy"], 2)
    # Nothing changed: nothing is compared again.
    assert repository.refresh(observed_at=NOW) == 0

    with isolatedPostgres._connect(setup_url) as connection:
        # The owner fixed the second track's title by hand; the album title of the box set too.
        connection.execute("update library.local_tracks set title = 'Carry On' where track_key = 'rel-cry-2'")
        connection.execute("update library.local_albums set title = 'Holy Land Box' where album_key = 'rel-holy'")
    assert repository.refresh(observed_at=NOW) == 2
    assert {row["album_key"]: row["correction_count"] for row in repository.list_summaries()["items"]} == {"rel-cry": 1}

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update library.local_album_musicbrainz_releases set state = 'release_group',"
                           " release_mbid = null where album_key = 'rel-cry'")
    repository.refresh(observed_at=NOW)
    with isolatedPostgres._connect(setup_url) as connection:
        stored = connection.execute("select album_key from library.local_album_musicbrainz_corrections").fetchall()
    assert [row["album_key"] for row in stored] == ["rel-holy"]


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
    # Two reads of stored rows (the listed albums' counts, the total); no comparison.
    assert len(statements) == 2
    assert not any("remote_tracks" in sql or "jsonb_array_elements" in sql for sql in statements)
