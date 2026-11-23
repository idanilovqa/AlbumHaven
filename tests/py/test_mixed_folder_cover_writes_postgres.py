"""An automatic job writes no cover into a folder that holds more than one album; each album still searches and gets
its suggestion, and the cover the folder already has stays shown for all of them.

Real planner, run_cover_jobs and guard; generated images and a throwaway database only.
"""
import hashlib
import io
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image, ImageDraw

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401


class _Logger:
    handlers = ()
    propagate = False

    def __getattr__(self, _name):
        return lambda *_args, **_kwargs: None


class _Case(SimpleNamespace):
    def __repr__(self):  # pytest prints the arguments of failed tests; the database URLs carry passwords
        return "<generated albums>"


def _jpeg(shape, edge):
    image = Image.new("RGB", (edge, edge), "white")
    draw = ImageDraw.Draw(image)
    if shape == "folder":
        draw.rectangle((0, 0, edge // 2, edge), fill="navy")
    else:
        draw.ellipse((edge // 8, edge // 8, edge * 7 // 8, edge * 7 // 8), fill="red")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=92)
    return buffer.getvalue()


def _case(fixture, tracks, *, covered):
    """Automatic albums from (relative path, album, disc) rows, each showing its folder's image when there is one."""
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    entries, covers = [], {}
    for relative, album, disc in tracks:
        entry = {**fixture.entry(relative, album=album), "disc_number": disc}
        if covered:
            cover = Path(entry["path"]).parent / "cover.jpg"
            covers[cover] = _jpeg("folder", 300)  # small, so the automatic repair wants to replace it
            cover.write_bytes(covers[cover])
            entry.update(cover_path=str(cover), cover_revision=hashlib.sha256(covers[cover]).hexdigest(),
                         cover_selection_origin="automatic")
        entries.append(entry)
    fixture.seed(*entries)
    config = {**fixture.config, "IMAGE_EXTENSIONS": {".jpg"}}
    stored = PostgresLibraryBrowseRepository(config).build_track_file_entries_by_paths(
        {entry["path"] for entry in entries}
    )
    return _Case(setup_url=fixture.setup_url, config=config, stored=stored, covers=covers,
                 folders={Path(entry["path"]).parent for entry in entries})


def _albums(case):
    with isolatedPostgres._connect(case.setup_url) as connection:
        rows = connection.execute(
            """select albums.title, albums.cover_path, albums.metadata ->> 'cover_revision' as revision,
                      albums.metadata ->> 'cover_selection_origin' as origin,
                      snapshots.automatic_improvement_revision as suggested
               from library.local_albums albums
               left join library.local_album_cover_candidate_snapshots snapshots on snapshots.album_id = albums.id"""
        ).fetchall()
    return {row["title"]: dict(row) for row in rows}


def _run(case, monkeypatch, *, workers=1, only=None):
    """Plan from the stored entries (all of them, or one album's, as a watcher or single fetch does) and run."""
    from music_app.services import cover_refresh_execution as execution
    from music_app.services import state
    from music_app.services.cover_provider_candidates import CoverCandidate
    from music_app.services.cover_refresh_planning import build_cover_refresh_jobs
    from music_app.services.cover_refresh_runtime import cover_pass_file_cache_snapshot

    offered, searched = _jpeg("offered", 1400), []

    def search(**_kwargs):
        searched.append(True)
        return CoverCandidate(source="itunes", url="https://img.example.test/cover.jpg", score=1.0,
                              width=1400, height=1400, raw_bytes=offered), []

    monkeypatch.setattr(execution.cover_refresh_provider, "search_primary_remote_cover", search)
    entries = cover_pass_file_cache_snapshot(
        {path: entry for path, entry in case.stored.items() if only in (None, entry.get("album"))}, case.config,
    )
    library_state = {"file_cache": entries, "cover_generation": 0, "scan_generation": 0}
    cache = SimpleNamespace(get=lambda _key: None, set=lambda *_args: None, save=lambda: None)
    jobs = build_cover_refresh_jobs(entries, cover_cache=cache)
    result = execution.run_cover_jobs(
        get_state=lambda: library_state, config=case.config, logger=_Logger(), cache_lock=state._CACHE_LOCK,
        jobs=jobs, file_cache=entries, separate_release_keys=set(), image_extensions={".jpg"},
        user_agent="AlbumHavenTests/1.0", cover_cache=cache, job_workers=workers,
    )
    return jobs, result, len(searched)


@pytest.mark.parametrize("workers", [1, 2], ids=["serial", "parallel"])
@pytest.mark.parametrize("covered", [True, False], ids=["folder_has_a_cover", "folder_has_no_cover"])
@pytest.mark.parametrize("planned", ["whole_folder", "one_album"])
def test_live_an_automatic_job_writes_nothing_into_a_folder_of_two_albums(
    watcher_repair_inventory, monkeypatch, planned, covered, workers,
):
    case = _case(watcher_repair_inventory, [
        ("Owner/Shared/01.flac", "First Album", 1), ("Owner/Shared/09.flac", "Second Album", 1),
    ], covered=covered)
    before = _albums(case)
    targeted = {"First Album", "Second Album"} if planned == "whole_folder" else {"Second Album"}

    jobs, result, searches = _run(case, monkeypatch, workers=workers, only=None if len(targeted) == 2 else "Second Album")

    assert {job["album"] for job in jobs} == targeted
    assert result["downloaded"] == 0, "an automatic job wrote into a folder of two albums"
    assert searches == len(jobs), "every album keeps its own search"
    assert result["failed"] == 0, "a refusal is not a failed job"
    for detail in result["job_results"]:
        assert "mixed_album_folder" in (detail.get("reason"), detail.get("search_reason")), "another rule refused"
    folder = next(iter(case.folders))
    if covered:
        assert (folder / "cover.jpg").read_bytes() == next(iter(case.covers.values()))
    else:
        assert not (folder / "cover.jpg").exists()
    after = _albums(case)
    for title, album in after.items():
        shown = ("cover_path", "revision", "origin")
        assert [album[key] for key in shown] == [before[title][key] for key in shown], f"{title} changed"
        if covered:
            assert album["cover_path"] == str(folder / "cover.jpg"), "the folder's cover stays shown for both albums"
        if title in targeted:
            assert album["suggested"] == 1, f"{title} got no suggestion"


@pytest.mark.parametrize("stored_album", [True, False], ids=["track_of_an_album", "track_without_an_album"])
@pytest.mark.parametrize("covered", [True, False], ids=["folder_has_a_cover", "folder_has_no_cover"])
def test_live_an_ambiguous_entry_without_an_id_is_refused_for_its_folder(
    watcher_repair_inventory, monkeypatch, covered, stored_album,
):
    case = _case(watcher_repair_inventory, [
        ("Owner/Shared/01.flac", "First Album", 1), ("Owner/Shared/09.flac", "Second Album", 1),
        ("Owner/Shared/10.flac", "Second Album", 1),
    ], covered=covered)
    ambiguous = max(case.stored)
    # The same tags as both identified albums, and no id: it belongs to neither of them.
    case.stored = {path: {**entry, "album": "Same Tags", **({"album_id": None} if path == ambiguous else {})}
                   for path, entry in case.stored.items()}
    if not stored_album:
        with isolatedPostgres._connect(case.setup_url) as connection:
            connection.execute(
                """update library.local_tracks set album_id = null
                   where id in (select track_id from library.local_track_files where private_path = %s)""",
                (ambiguous,),
            )

    jobs, result, _searches = _run(case, monkeypatch)

    assert [job["track_paths"] for job in jobs if not job["album_id"]] == [[ambiguous]], "it joined one of the albums"
    assert result["downloaded"] == 0, "an automatic job wrote into a folder of two albums"
    folder = next(iter(case.folders))
    if covered:
        assert (folder / "cover.jpg").read_bytes() == next(iter(case.covers.values()))
    else:
        assert not (folder / "cover.jpg").exists()
    assert result["failed"] == 0, "a refusal is not a failed job"
    for detail in result["job_results"]:
        assert "mixed_album_folder" in (detail.get("reason"), detail.get("search_reason")), "another rule refused"


@pytest.mark.parametrize("covered", [True, False], ids=["folder_has_a_cover", "folder_has_no_cover"])
def test_live_one_album_across_cd_subfolders_is_still_written(watcher_repair_inventory, monkeypatch, covered):
    case = _case(watcher_repair_inventory, [
        ("Owner/Album/CD1/01.flac", "One Album", 1), ("Owner/Album/CD2/01.flac", "One Album", 2),
    ], covered=covered)

    _jobs, result, _searches = _run(case, monkeypatch)

    assert result["failed"] == 0
    assert result["downloaded"] >= 1
    written = [folder / "cover.jpg" for folder in case.folders if (folder / "cover.jpg").exists()
               and (folder / "cover.jpg").read_bytes() != case.covers.get(folder / "cover.jpg")]
    assert written, "a single album's automatic write must still happen"
    album = _albums(case)["One Album"]
    assert album["cover_path"] in {str(path) for path in written}
    assert album["revision"] == hashlib.sha256(Path(album["cover_path"]).read_bytes()).hexdigest()
