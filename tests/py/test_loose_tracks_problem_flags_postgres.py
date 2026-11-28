"""Loose Tracks marks a track with the Problematic Files "!" only when Problematic Files lists it, with that
entry's reasons, read per track from the persisted index; and it reports the one-time store build's progress."""
from __future__ import annotations

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)
from tests.py.test_problematic_albums import _indexed_problematic_items, _ready_problematic_index


@pytest.fixture
def flagged_library(watcher_repair_inventory, monkeypatch):
    from music_app.services import library_browse_postgres as browse, loose_track_store, problematic_index

    fixture = watcher_repair_inventory
    # Listed: a loose file with no artist tag is a "Missing artist" loose group in Problematic Files.
    stray = fixture.entry("Owner/Strays/01.flac", artist="")
    stray["album_artist"] = ""
    # Not listed: an untagged-album file its owner marked a non-album rarity (the Folkstone case).
    rarity = {**fixture.entry("Owner/Rarities/Goose.flac", exception="Non-album rarity"), "album": ""}
    fixture.seed(*(fixture.entry(f"Owner/Album/{track}.flac") for track in ("01", "02")), stray, rarity)
    fixture.database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    _ready_problematic_index(fixture.database_url)
    problematic_index.wait_for_background_work()
    monkeypatch.setattr(problematic_index, "queue_maintenance", lambda _repository: None)
    # The persisted index serves only through the shared pool, as in the app.
    fixture.repository = browse.PostgresLibraryBrowseRepository(
        {**fixture.config, "ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED": "1"})
    loose_track_store.prepare(fixture.repository._inventory_repository, fixture.repository._owned_connection_context)
    fixture.stray, fixture.rarity = stray, rarity
    return fixture


def _loose_by_path(repository):
    payload = repository.build_library_loose_tracks_payload(query_params={})
    return {track["path"]: track for track in payload["library_non_album_tracks"]}


def _listed_entry(fixture, path):
    return next((item for item in _indexed_problematic_items(fixture.database_url, limit=50)
                 if path in (item.get("track_paths") or [])), None)


def test_live_a_listed_loose_track_carries_its_problematic_files_reasons(flagged_library):
    fixture = flagged_library
    entry = _listed_entry(fixture, fixture.stray["path"])
    assert entry is not None and entry["problem_reasons"], "precondition: Problematic Files lists the stray"

    track = _loose_by_path(fixture.repository)[fixture.stray["path"]]

    assert track["is_problematic"] is True
    assert track["problem_reasons"] == entry["problem_reasons"], "the hover names the listed entry's reasons"


def test_live_a_loose_track_problematic_files_does_not_list_shows_no_problem(flagged_library):
    fixture = flagged_library
    assert _listed_entry(fixture, fixture.rarity["path"]) is None, "precondition: the rarity is not listed"

    track = _loose_by_path(fixture.repository)[fixture.rarity["path"]]

    assert track["is_problematic"] is False, "no \"!\" leads to a track Problematic Files does not list"
    assert not track.get("problem_reasons")


def test_live_the_flags_are_a_keyed_read_never_the_whole_problematic_files_list(flagged_library, monkeypatch):
    from music_app.services import problematic_index

    fixture = flagged_library

    def whole_list(*_args, **_kwargs):
        raise AssertionError("Loose Tracks read the whole Problematic Files list")

    for name in ("read_page", "read_first_page", "_read"):
        monkeypatch.setattr(problematic_index, name, whole_list)
    monkeypatch.setattr(type(fixture.repository), "build_problematic_files_payload", whole_list, raising=False)

    assert _loose_by_path(fixture.repository)[fixture.stray["path"]]["is_problematic"] is True


def test_live_a_listed_loose_track_opens_its_problematic_files_entry_by_path(flagged_library):
    fixture = flagged_library
    entry = _listed_entry(fixture, fixture.stray["path"])

    detail = fixture.repository.build_problematic_file_detail_payload_for_track_path(fixture.stray["path"])

    assert detail is not None, "the track's \"!\" opens an entry instead of saying it is not listed"
    assert detail["key"] == entry["key"] and detail["detail_loaded"] is True
    assert fixture.stray["path"] in detail["track_paths"]
    assert fixture.repository.build_problematic_file_detail_payload_for_track_path(fixture.rarity["path"]) is None


def test_live_the_one_time_store_build_reports_its_progress_until_ready(watcher_repair_inventory, monkeypatch):
    from music_app.services import library_browse_postgres as browse, loose_track_store

    fixture = watcher_repair_inventory
    fixture.seed(*(fixture.entry(f"Owner/Loose/{track:02d}.flac", album="") for track in range(5)))
    monkeypatch.setattr(loose_track_store, "BUILD_BATCH", 2)
    repository = browse.PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    assert repository.loose_tracks_preparation() == {"percent": 0}, "a missing store is being prepared"

    seen = []

    def report(stage, **values):
        if stage == "batch":
            seen.append((values["done"], values["total"], repository.loose_tracks_preparation()))

    loose_track_store.build(repository._inventory_repository, repository._owned_connection_context, progress=report)

    assert [entry[2] for entry in seen] == [
        {"percent": done * 100 // total} for done, total, _ in seen], "each committed batch moves the percent"
    assert [entry[2]["percent"] for entry in seen] == sorted(entry[2]["percent"] for entry in seen)
    assert seen[-1][2] == {"percent": 100}
    assert repository.loose_tracks_preparation() is None, "a ready store shows no note"


def test_live_a_builder_change_reports_preparing_until_its_build_starts(watcher_repair_inventory, monkeypatch):
    from music_app.services import library_browse_postgres as browse, loose_track_store

    fixture = watcher_repair_inventory
    fixture.seed(fixture.entry("Owner/Loose/01.flac", album=""))
    repository = browse.PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    loose_track_store.build(repository._inventory_repository, repository._owned_connection_context)
    assert repository.loose_tracks_preparation() is None

    monkeypatch.setattr(loose_track_store, "BUILDER_VERSION", loose_track_store.BUILDER_VERSION + 1)

    assert repository.loose_tracks_preparation() == {"percent": 0}, "an update that changes the stored format"
