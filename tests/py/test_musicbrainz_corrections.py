"""MusicBrainz data corrections and the Edits Queue (Delivery 2, S4), without a database."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from music_app.services.musicbrainz_corrections import (
    MusicBrainzCorrectionService,
    group_corrections,
    next_auto_submit_at,
)

NOW = datetime(2026, 11, 16, 10, 20, tzinfo=timezone.utc)
RELEASE = "6f3c2a1e-0000-4000-8000-0000000c0de1"


def _row(field, current, proposed, *, disc=None, track=None, album_key="wurdah", title="Wurdah Ïtah"):
    return {"album_key": album_key, "album_title": title, "artist_name": "Christian Vander", "year": 1974,
            "cover_path": None, "track_count": 12, "release_mbid": RELEASE, "queued_at": None,
            "field": field, "disc_number": disc, "track_number": track,
            "current_value": current, "proposed_value": proposed}


def test_track_artists_changing_the_same_way_are_one_row_beside_the_album_artist():
    rows = [_row("album_artist", "Christian Vander", "Magma")]
    rows += [_row("artist", "Christian Vander", "Magma", disc=1, track=number) for number in range(1, 13)]

    (album,) = group_corrections(rows)

    assert [(item["label"], item["current"], item["proposed"]) for item in album["corrections"]] == [
        ("Album artist", "Christian Vander", "Magma"), ("Artist (12 tracks)", "Christian Vander", "Magma")]
    assert album["corrections"][1]["tracks"][0] == {"disc_number": 1, "track_number": 1}
    assert (album["album_key"], album["release_mbid"], album["year"]) == ("wurdah", RELEASE, 1974)


def test_each_track_title_is_its_own_row_and_names_its_disc_only_when_there_are_several():
    one_disc = group_corrections([_row("title", "Malawelekaahm", "Malawêlekaahm", disc=1, track=1)])
    two_discs = group_corrections([_row("title", "A", "B", disc=1, track=3), _row("title", "C", "D", disc=2, track=1),
                                   _row("artist", "X", "Y", disc=2, track=2)])

    assert one_disc[0]["corrections"][0]["label"] == "Track 1 title"
    assert [item["label"] for item in two_discs[0]["corrections"]] == [
        "Disc 1, track 3 title", "Disc 2, track 1 title", "Artist (1 track)"]


def test_different_track_artist_changes_stay_apart_and_albums_keep_their_order():
    rows = [_row("artist", "Klaus", "Magma", disc=1, track=1), _row("artist", "Christian", "Magma", disc=1, track=2),
            _row("artist", "Klaus", "Magma", disc=1, track=3),
            _row("album", "Secret", "The Secret", album_key="secret", title="Secret")]

    first, second = group_corrections(rows)

    assert [(item["current"], len(item["tracks"])) for item in first["corrections"]] == [("Klaus", 2), ("Christian", 1)]
    assert (second["album_key"], second["corrections"][0]["label"]) == ("secret", "Album title")


def test_auto_submit_is_due_hourly_from_when_it_was_switched_on_and_never_while_off():
    on = {"auto_submit_bulks": True, "changed_at": NOW}

    assert next_auto_submit_at(on, NOW) == NOW + timedelta(hours=1)
    assert next_auto_submit_at(on, NOW + timedelta(minutes=61)) == NOW + timedelta(hours=2)
    assert next_auto_submit_at({"auto_submit_bulks": False, "changed_at": NOW}, NOW) is None
    assert next_auto_submit_at({"auto_submit_bulks": True, "changed_at": None}, NOW) is None


class Repository:
    def __init__(self, rows=()):
        self.rows = list(rows)
        self.queued = []

    def list_differences(self, *, album_key=None):
        return [row for row in self.rows if album_key is None or row["album_key"] == album_key]

    def queue(self, **kwargs):
        self.queued.append(kwargs)
        return {"id": 4, "queued_at": kwargs["observed_at"]}

    def settings(self):
        return {"auto_submit_bulks": True, "changed_at": NOW - timedelta(minutes=30)}

    def list_queue(self):
        return []


def test_queueing_stores_the_correction_as_the_server_computes_it_now():
    repository = Repository([_row("album_artist", "Christian Vander", "Magma")])
    service = MusicBrainzCorrectionService(repository, now=lambda: NOW)

    assert service.queue_correction(album_key="wurdah", actor_account_id=7) == {"entry_id": 4, "queued_at": NOW}
    (stored,) = repository.queued
    assert (stored["album_key"], stored["release_mbid"], stored["actor_account_id"]) == ("wurdah", RELEASE, 7)
    assert stored["corrections"][0]["proposed"] == "Magma"
    # An album whose tags already agree has nothing to queue.
    assert service.queue_correction(album_key="other", actor_account_id=7) is None
    assert len(repository.queued) == 1


def test_the_queue_names_its_next_run_and_the_hourly_run_writes_nothing_yet():
    service = MusicBrainzCorrectionService(Repository(), now=lambda: NOW)

    assert service.list_queue() == {"items": [], "settings": {
        "auto_submit_bulks": True, "next_run_at": NOW + timedelta(minutes=30)}}
    assert service.submit_due_bulk_corrections() == 0

