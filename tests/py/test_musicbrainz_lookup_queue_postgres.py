"""The owner's manual MusicBrainz lookups on real isolated PostgreSQL (Delivery 2, S5).

Each test owns a freshly migrated isolated database. Nothing calls MusicBrainz: the album
resolver is replaced by a recorded outcome, and artist jobs are finished in the database.
"""
from __future__ import annotations

from datetime import timedelta

import pytest

from music_app.services.musicbrainz_enrichment_worker import MusicBrainzEnrichmentChain
from music_app.services.musicbrainz_lookup_queue_postgres import (
    ARTIST_NOT_FOUND_LABEL,
    MANUAL_LOOKUP_PRIORITY,
    RELEASE_NOT_FOUND_LABEL,
    MusicBrainzLookupQueuePostgresRepository,
)
from music_app.services.musicbrainz_release_identity import MusicBrainzAlbumReleaseProcessor
from tests.e2e.support import isolatedPostgres
from tests.py.test_musicbrainz_release_identity_postgres import (
    ANGRA,
    GROUP,
    NOW,
    RELEASE,
    FakeResolverClient,
    _outcome,
    _seed,
)


def _lookups(monkeypatch):
    setup_url, releases, ids, albums = _seed(monkeypatch)
    lookups = MusicBrainzLookupQueuePostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))
    return setup_url, lookups, releases, ids


def _jobs(setup_url):
    with isolatedPostgres._connect(setup_url) as connection:
        return connection.execute(
            "select id, local_artist_id, job_kind, state, priority, next_attempt_at"
            " from ops.metadata_enrichment_jobs order by id").fetchall()


def _finish_jobs(setup_url, state="succeeded"):
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update ops.metadata_enrichment_jobs set state = %s, completed_at = now()"
            " where state in ('queued', 'retry_wait')", (state,))


def test_queued_lookups_wait_an_hour_then_start_together_at_manual_priority(monkeypatch):
    setup_url, lookups, _releases, ids = _lookups(monkeypatch)

    album = lookups.request(target_kind="album", mode="queue", album_key="rel-holy", actor_account_id=None,
                            observed_at=NOW)
    artist = lookups.request(target_kind="artist", mode="queue", album_key="rel-none", actor_account_id=None,
                             observed_at=NOW + timedelta(minutes=10))
    again = lookups.request(target_kind="album", mode="queue", album_key="rel-holy", actor_account_id=None,
                            observed_at=NOW + timedelta(minutes=20))

    assert album["state"] == artist["state"] == "queued" and again["request_id"] == album["request_id"]
    listed = lookups.list_lookups()
    assert [(row["target_kind"], row["artist_name"], row["album_title"]) for row in listed["queued"]] == [
        ("album", "Angra", "Holy Land"), ("artist", "Nobody", None)]
    assert listed["queue_starts_at"] == NOW + timedelta(hours=1)

    lookups.advance(observed_at=NOW + timedelta(minutes=59))
    assert _jobs(setup_url) == [] and lookups.list_lookups()["batches"] == []

    lookups.advance(observed_at=NOW + timedelta(hours=1))
    jobs = {(row["local_artist_id"], row["job_kind"]): row for row in _jobs(setup_url)}
    assert set(jobs) == {(ids["angra"], "musicbrainz_album_releases"),
                         (ids["unmatched"], "musicbrainz_artist_enrichment")}
    assert {row["priority"] for row in jobs.values()} == {MANUAL_LOOKUP_PRIORITY}
    (batch,) = lookups.list_lookups()["batches"]
    assert (batch["total"], batch["albums"], batch["artists"], batch["finished_at"]) == (2, 1, 1, None)
    assert lookups.list_lookups()["queued"] == []


def test_sync_starts_the_queue_at_once_and_raises_an_automatic_job_already_waiting(monkeypatch):
    setup_url, lookups, releases, ids = _lookups(monkeypatch)
    later = NOW + timedelta(days=1)
    with isolatedPostgres._connect(setup_url) as connection:
        library_id = connection.execute("select library_id from library.local_artists where id = %s",
                                        (ids["unmatched"],)).fetchone()["library_id"]
        connection.execute(
            "insert into ops.metadata_enrichment_jobs (library_id, local_artist_id, target_kind, job_kind, reason,"
            " state, next_attempt_at) values (%s, %s, 'artist', 'musicbrainz_artist_enrichment', 'periodic_scan',"
            " 'queued', %s)", (library_id, ids["unmatched"], later))
    lookups.request(target_kind="artist", mode="queue", local_artist_id=ids["unmatched"], actor_account_id=None,
                    observed_at=NOW)

    assert lookups.start_queued(observed_at=NOW + timedelta(minutes=1), due_only=False)
    (job,) = _jobs(setup_url)
    assert (job["priority"], job["next_attempt_at"]) == (MANUAL_LOOKUP_PRIORITY, NOW + timedelta(minutes=1))
    # A second start finds nothing waiting.
    assert lookups.start_queued(observed_at=NOW + timedelta(minutes=2), due_only=False) is None


def test_a_search_starts_alone_and_a_search_for_a_queued_lookup_starts_that_one(monkeypatch):
    setup_url, lookups, _releases, ids = _lookups(monkeypatch)
    queued = lookups.request(target_kind="album", mode="queue", album_key="rel-cry", actor_account_id=None,
                             observed_at=NOW)
    other = lookups.request(target_kind="artist", mode="queue", local_artist_id=ids["other"],
                            actor_account_id=None, observed_at=NOW)

    searched = lookups.request(target_kind="album", mode="search", album_key="rel-cry", actor_account_id=None,
                               observed_at=NOW + timedelta(minutes=1))

    assert searched["request_id"] == queued["request_id"] and searched["state"] == "running"
    batch = lookups.get_batch(batch_id=searched["batch_id"])
    assert [item["request_id"] for item in batch["items"]] == [queued["request_id"]]
    # The rest of the queue still waits for its hour.
    assert [row["request_id"] for row in lookups.list_lookups()["queued"]] == [other["request_id"]]
    assert lookups.request(target_kind="album", mode="search", album_key="nope", actor_account_id=None,
                           observed_at=NOW) is None


def test_an_album_lookup_runs_before_the_artist_backlog_and_settles_with_its_release(monkeypatch):
    setup_url, lookups, releases, ids = _lookups(monkeypatch)
    from music_app.services import musicbrainz_release_identity as module
    monkeypatch.setattr(module, "resolve_album_releases", lambda context, client: _outcome(context))
    albums = MusicBrainzAlbumReleaseProcessor(repository=releases, client=FakeResolverClient(), now=lambda: NOW)

    class Backlog:
        def process_next(self, *, worker_id):
            raise AssertionError("the manual album lookup must run first")

    chain = MusicBrainzEnrichmentChain(Backlog(), albums, lookups=lookups, now=lambda: NOW)
    cry = lookups.request(target_kind="album", mode="search", album_key="rel-cry", actor_account_id=None,
                          observed_at=NOW)
    holy = lookups.request(target_kind="album", mode="search", album_key="rel-holy", actor_account_id=None,
                           observed_at=NOW)

    assert chain.process_next(worker_id="w")["state"] == "succeeded"
    lookups.advance(observed_at=NOW)

    (found,) = lookups.get_batch(batch_id=cry["batch_id"])["items"]
    assert (found["outcome"], found["result_mbid"], found["problem_label"]) == ("matched", RELEASE, None)
    (missing,) = lookups.get_batch(batch_id=holy["batch_id"])["items"]
    assert (missing["outcome"], missing["result_mbid"], missing["problem_label"]) == (
        "not_matched", None, RELEASE_NOT_FOUND_LABEL)
    batches = {row["batch_id"]: row for row in lookups.list_lookups()["batches"]}
    assert batches[cry["batch_id"]]["finished_at"] == NOW
    assert (batches[cry["batch_id"]]["single_title"], batches[cry["batch_id"]]["single_outcome"]) == (
        "Angels Cry", "matched")
    assert GROUP  # the recorded release belongs to this group


def test_artist_lookups_settle_with_the_accepted_mbid_or_the_problematic_files_label(monkeypatch):
    setup_url, lookups, _releases, ids = _lookups(monkeypatch)
    matched = lookups.request(target_kind="artist", mode="search", local_artist_id=ids["angra"],
                              actor_account_id=None, observed_at=NOW)
    missing = lookups.request(target_kind="artist", mode="search", local_artist_id=ids["unmatched"],
                              actor_account_id=None, observed_at=NOW)

    lookups.advance(observed_at=NOW)
    assert lookups.get_batch(batch_id=matched["batch_id"])["items"][0]["state"] == "running"
    assert lookups.dismiss_batch(batch_id=matched["batch_id"], observed_at=NOW) is False

    _finish_jobs(setup_url)
    lookups.advance(observed_at=NOW + timedelta(minutes=1))

    (angra,) = lookups.get_batch(batch_id=matched["batch_id"])["items"]
    assert (angra["outcome"], angra["result_mbid"]) == ("matched", ANGRA)
    (nobody,) = lookups.get_batch(batch_id=missing["batch_id"])["items"]
    assert (nobody["outcome"], nobody["problem_label"]) == ("not_matched", ARTIST_NOT_FOUND_LABEL)
    assert lookups.dismiss_batch(batch_id=matched["batch_id"], observed_at=NOW) is True
    assert [row["batch_id"] for row in lookups.list_lookups()["batches"]] == [missing["batch_id"]]
    # A finished lookup can be asked for again.
    assert lookups.request(target_kind="artist", mode="queue", local_artist_id=ids["angra"],
                           actor_account_id=None, observed_at=NOW)["state"] == "queued"


def test_the_album_menu_learns_whether_the_album_and_its_artist_have_an_mbid(monkeypatch):
    _setup_url, lookups, _releases, _ids = _lookups(monkeypatch)

    angra = lookups.target_status(album_key="rel-cry")
    nobody = lookups.target_status(album_key="rel-none")

    assert (angra["artist_name"], angra["artist_has_mbid"], angra["album_has_mbid"]) == ("Angra", True, False)
    assert (nobody["artist_has_mbid"], nobody["album_has_mbid"]) == (False, False)
    assert lookups.target_status(album_key="nope") is None


@pytest.mark.parametrize("kwargs", [
    {"target_kind": "album", "mode": "queue", "local_artist_id": 1},
    {"target_kind": "artist", "mode": "queue"},
    {"target_kind": "artist", "mode": "queue", "local_artist_id": 1, "album_key": "k"},
    {"target_kind": "release", "mode": "queue", "album_key": "k"},
])
def test_invalid_requests_never_reach_the_database(kwargs):
    lookups = MusicBrainzLookupQueuePostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: (_ for _ in ()).throw(AssertionError("no database")))
    with pytest.raises(ValueError):
        lookups.request(actor_account_id=None, observed_at=NOW, **kwargs)
