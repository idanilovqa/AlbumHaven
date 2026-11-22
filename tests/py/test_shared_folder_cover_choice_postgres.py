"""An automatic job never writes a file that is another album's user choice (main cover or local second artbox),
whether the art differs or is the same and whoever owns the job's album. It suggests instead.
A file only the job's own album selected keeps the same-art, legacy and backup rules, in a folder of that album alone.
A folder of two albums refuses every automatic write first (mixed_album_folder), so each refusal names its rule.

An automatic cover job of album B shares a file with album A, whose user selects it before the job, during the job
before its publication lock, or between that lock and its commit (option C: the user's bytes win).
Generated images and a throwaway database only.
"""
import asyncio
import hashlib
import io
import json
import threading
from pathlib import Path
from time import perf_counter
from types import SimpleNamespace

import pytest
from PIL import Image, ImageDraw

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import _finish_live_startup, watcher_repair_inventory  # noqa: F401

JOIN_SECONDS = 30
REFUSED_BY = {
    "same_folder": "mixed_album_folder",
    "cd_subfolder": "mixed_album_folder",
    "one_album_folder": "automatic_write_blocked_by_user_selection",
}


class _Logger:
    handlers = ()
    propagate = False

    def __getattr__(self, _name):
        return lambda *_args, **_kwargs: None


def _jpeg(art, edge):
    image = Image.new("RGB", (edge, edge), "white")
    draw = ImageDraw.Draw(image)
    if art == "newer":
        draw.polygon(((0, edge), (edge // 2, 0), (edge, edge)), fill="green")
    elif art == "chosen":
        draw.rectangle((0, 0, edge // 2, edge), fill="navy")
        draw.ellipse((edge // 2, edge // 4, edge, edge * 3 // 4), fill="red")
    else:
        for index in range(0, 8):
            top = index * edge // 8
            draw.rectangle((0, top, edge, top + edge // 16), fill="black")
        draw.rectangle((edge // 3, 0, edge * 2 // 3, edge), fill="yellow")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=92)
    return buffer.getvalue()


def _sha(data):
    return hashlib.sha256(data).hexdigest()


class _Shared(SimpleNamespace):
    def __repr__(self):  # pytest prints arguments of failed asserts; the database URLs carry passwords
        return "<shared albums>"


@pytest.fixture
def shared(watcher_repair_inventory, request):
    """Album A (the user's) and album B (the job's) around one image file."""
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    fixture = watcher_repair_inventory
    layout = request.param
    if layout == "same_folder":
        theirs = [fixture.entry("Owner/Shared/01.flac", album="Chosen Album")]
        other = fixture.entry("Owner/Shared/09.flac", album="Other Album")
    elif layout == "one_album_folder":  # B's folder holds B alone, inside A's album root
        theirs = [
            fixture.entry("Owner/Shared/CD1/01.flac", album="Chosen Album"),
            {**fixture.entry("Owner/Shared/CD2/02.flac", album="Chosen Album"), "disc_number": 2},
        ]
        other = fixture.entry("Owner/Shared/Bonus/09.flac", album="Other Album")
    else:
        theirs = [
            fixture.entry("Owner/Shared/CD1/01.flac", album="Chosen Album"),
            {**fixture.entry("Owner/Shared/CD2/02.flac", album="Chosen Album"), "disc_number": 2},
        ]
        other = fixture.entry("Owner/Shared/CD1/09.flac", album="Other Album")
    target = Path(other["path"]).parent / "cover.jpg"
    chosen_bytes = _jpeg("chosen", 300)  # small, so the automatic repair wants to replace it
    target.write_bytes(chosen_bytes)
    fixture.seed(*theirs, other)
    config = {**fixture.config, "IMAGE_EXTENSIONS": {".jpg"}}
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        albums = {
            row["title"]: row
            for row in connection.execute(
                "select id, title, album_key from library.local_albums where title in ('Chosen Album', 'Other Album')"
            ).fetchall()
        }
    paths_a, paths_b = {entry["path"] for entry in theirs}, {other["path"]}
    entries = PostgresLibraryBrowseRepository(config).build_track_file_entries_by_paths(paths_a | paths_b)
    from music_app.services.library import build_albums_from_file_cache

    return _Shared(
        refused_by=REFUSED_BY[layout], setup_url=fixture.setup_url, config=config, target=target, chosen_bytes=chosen_bytes,
        a=albums["Chosen Album"], b=albums["Other Album"], paths_a=paths_a, paths_b=paths_b,
        state={"file_cache": entries, "albums": build_albums_from_file_cache(entries, set()),
               "cover_generation": 0, "scan_generation": 0},
    )


def _album_row(shared, album):
    with isolatedPostgres._connect(shared.setup_url) as connection:
        return connection.execute(
            """select cover_path, metadata ->> 'cover_revision' as revision,
                      metadata ->> 'cover_selection_origin' as origin,
                      metadata ->> 'selected_local_cover_source_path' as source
               from library.local_albums where id = %s""",
            (album["id"],),
        ).fetchone()


def _artbox_row(shared, *, who="a"):
    album = shared.a if who == "a" else shared.b
    with isolatedPostgres._connect(shared.setup_url) as connection:
        return connection.execute(
            "select source_kind, cover_path from library.local_album_additional_artworks where album_id = %s",
            (album["id"],),
        ).fetchone()


def _select_main(shared, _monkeypatch, *, who="a", source=None):
    """The real local-select response, as the route's thread runs it."""
    from music_app.routes import api_wave_d_asgi_routes as routes
    from music_app.services.cover_workflow import CoverAlbumContext, resolve_album_root_from_track_paths

    album, paths = (shared.a, shared.paths_a) if who == "a" else (shared.b, shared.paths_b)
    root = resolve_album_root_from_track_paths(shared.config, paths)
    context = CoverAlbumContext(album_root=root, track_paths=set(paths))
    inventory = asyncio.run(routes._selected_cover_inventory_state(shared.config, shared.state, paths))
    response = routes._utilities_cover_lookup_local_select_response(
        inventory, context, {"key": album["album_key"]}, shared.config, str(source or shared.target),
        _Logger(), shared.state, None, perf_counter(),
    )
    return response.status_code, json.loads(response.body)


def _select_artbox(shared, monkeypatch, *, who="a"):
    """The real second-artbox route; only request parsing and album resolution are supplied."""
    from music_app.routes import api_wave_d_asgi_routes as routes
    from music_app.services.cover_workflow import CoverAlbumContext, resolve_album_root_from_track_paths

    album, paths = (shared.a, shared.paths_a) if who == "a" else (shared.b, shared.paths_b)
    root = resolve_album_root_from_track_paths(shared.config, paths)
    context = CoverAlbumContext(album_root=root, track_paths=set(paths))

    async def payload(_request):
        return {"slot": 1, "source_kind": "local", "source_path": str(shared.target)}

    async def album_context(_request, _payload):
        return {"key": album["album_key"]}, context, album["id"], None

    monkeypatch.setattr(routes, "_json_payload", payload)
    monkeypatch.setattr(routes, "_app_config", lambda _request: shared.config)
    monkeypatch.setattr(routes, "_additional_artwork_album_context", album_context)
    monkeypatch.setattr(routes, "_library_state", lambda _request: shared.state)
    monkeypatch.setattr(routes, "_app_logger", lambda _request: _Logger())
    response = asyncio.run(
        routes.utilities_cover_lookup_additional_artwork(SimpleNamespace(state=SimpleNamespace(current_actor=None)))
    )
    return response.status_code, json.loads(response.body)


def _run_job(shared, monkeypatch, *, art="different", at_guard=None, under_lock=None, merged=False, unidentified=False,
             before_publish=lambda: None):
    """The real planner, run and guard for album B. Returns only after proving a job reached the write guard."""
    from music_app.services import cover_refresh_execution as execution
    from music_app.services import state
    from music_app.services.cover_provider_candidates import CoverCandidate
    from music_app.services.cover_refresh_planning import build_cover_refresh_jobs
    from music_app.services.cover_refresh_runtime import cover_pass_file_cache_snapshot

    offered = _jpeg("chosen" if art == "same" else "different", 1400)
    searched, guarded = [], []

    def search(**_kwargs):
        searched.append(True)
        return CoverCandidate(source="itunes", url="https://img.example.test/cover.jpg", score=1.0,
                              width=1400, height=1400, raw_bytes=offered), []

    build_guard = execution._build_automatic_cover_write_guard

    def observed_guard(**kwargs):
        guard = build_guard(**kwargs)

        def enter(write_action, **options):
            guarded.append(True)
            if at_guard:
                at_guard()  # after the provider's checks, before any lock
            return guard(write_action, **options)

        return enter

    persist = execution.persist_cover_selection_in_shared_transaction

    def observed_persist(*args, **options):
        commit_guard = options.get("commit_guard")
        if commit_guard and under_lock:
            def holding_the_lock(commit):
                under_lock()  # the publication lock is held and nothing is committed
                return commit_guard(commit)

            options["commit_guard"] = holding_the_lock
        return persist(*args, **options)

    monkeypatch.setattr(execution.cover_refresh_provider, "search_primary_remote_cover", search)
    monkeypatch.setattr(execution, "_build_automatic_cover_write_guard", observed_guard)
    monkeypatch.setattr(execution, "persist_cover_selection_in_shared_transaction", observed_persist)
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    # Plan as a library run does, from both albums' entries as they are stored now.
    everything = shared.paths_a | shared.paths_b
    entries = PostgresLibraryBrowseRepository(shared.config).build_track_file_entries_by_paths(everything)
    if merged:  # entries without album ids whose tags agree: the only shape this planner puts into one job
        tags = {field: entries[next(iter(shared.paths_b))].get(field)
                for field in ("album", "album_artist", "artist", "edition", "year")}
        entries = {path: {**entry, **tags, "album_id": None} for path, entry in entries.items()}
    if unidentified:  # B's entries as a cache holds them before it knows their album
        entries = {path: {**entry, "album_id": None} if path in shared.paths_b else entry
                   for path, entry in entries.items()}
    # As every cover pass does before planning: the stored selection (path, origin, provenance) joins the entries.
    shared.state["file_cache"].update(cover_pass_file_cache_snapshot(entries, shared.config))
    # The run saves its cache after every job and before it publishes to the runtime.
    cache = SimpleNamespace(get=lambda _key: None, set=lambda *_args: None, save=before_publish)
    planned = build_cover_refresh_jobs(shared.state["file_cache"], cover_cache=cache)
    jobs = [job for job in planned if set(job["track_paths"]) & shared.paths_b]
    assert len(jobs) == 1, "album B's job was not planned, so this proves nothing"
    if merged:
        assert set(jobs[0]["track_paths"]) >= shared.paths_b | {min(shared.paths_a)}, "the entries did not merge"
    else:
        assert set(jobs[0]["track_paths"]) == shared.paths_b, "one job holds both albums' tracks"
        assert jobs[0]["album_id"] == (None if unidentified else shared.b["id"])
    result = execution.run_cover_jobs(
        get_state=lambda: shared.state, config=shared.config, logger=_Logger(), cache_lock=state._CACHE_LOCK,
        jobs=jobs, separate_release_keys=set(),
        file_cache={path: dict(entry) for path, entry in shared.state["file_cache"].items()},  # a pass's snapshot
        image_extensions={".jpg"}, user_agent="AlbumHavenTests/1.0", cover_cache=cache,
    )
    assert searched and guarded, "the job never reached its write guard, so this proves nothing"
    assert result["processed"] == 1
    return result


CHOICES = {"main": _select_main, "second_artbox": _select_artbox}
EVERY_WINDOW = [(layout, choice) for choice in CHOICES for layout in REFUSED_BY]
# A folder of two albums refuses before the commit, so only a one-album folder has a lock-to-commit window.
COMMIT_WINDOW = [("one_album_folder", choice) for choice in CHOICES]


def _improvements(shared):
    with isolatedPostgres._connect(shared.setup_url) as connection:
        row = connection.execute(
            "select automatic_improvement_revision as revision, status"
            " from library.local_album_cover_candidate_snapshots where album_id = %s",
            (shared.b["id"],),
        ).fetchone()
    return dict(row) if row else None


def _assert_refused_and_suggested(shared, result):
    detail = result["job_results"][0]
    assert result["downloaded"] == 0
    assert result["failed"] == 0, "a refusal is not a failed job"
    assert shared.refused_by in (detail.get("reason"), detail.get("search_reason")), "another rule refused"
    assert _improvements(shared) == {"revision": 1, "status": "completed"}, "the improvement was not suggested"


def _assert_choice_kept(shared, choice):
    assert shared.target.read_bytes() == shared.chosen_bytes, "the job replaced another album's choice"
    if choice == "main":
        row = _album_row(shared, shared.a)
        assert row["origin"] == "user"
        assert row["revision"] == _sha(shared.chosen_bytes), "other bytes were recorded as the user's choice"
        assert Path(row["cover_path"]).read_bytes() == shared.chosen_bytes
    else:
        assert dict(_artbox_row(shared)) == {"source_kind": "local", "cover_path": str(shared.target.resolve())}


@pytest.mark.parametrize(("shared", "choice"), EVERY_WINDOW, indirect=["shared"])
def test_live_a_choice_made_before_the_job_is_never_overwritten(shared, choice, monkeypatch):
    assert CHOICES[choice](shared, monkeypatch)[0] == 200
    album, artbox, other = _album_row(shared, shared.a), _artbox_row(shared), _album_row(shared, shared.b)

    result = _run_job(shared, monkeypatch)

    _assert_choice_kept(shared, choice)
    _assert_refused_and_suggested(shared, result)
    assert (_album_row(shared, shared.a), _artbox_row(shared)) == (album, artbox), "the block or its recovery changed A"
    assert _album_row(shared, shared.b)["origin"] != "user" and other["origin"] != "user"


@pytest.mark.parametrize(("shared", "choice"), EVERY_WINDOW, indirect=["shared"])
def test_live_a_choice_made_after_the_guard_and_before_the_lock_wins(shared, choice, monkeypatch):
    saved = []

    result = _run_job(shared, monkeypatch, at_guard=lambda: saved.append(CHOICES[choice](shared, monkeypatch)))

    assert [status for status, _body in saved] == [200]
    _assert_choice_kept(shared, choice)
    _assert_refused_and_suggested(shared, result)


@pytest.mark.parametrize(("shared", "choice"), COMMIT_WINDOW, indirect=["shared"])
def test_live_a_choice_made_between_the_lock_and_the_commit_wins(shared, choice, monkeypatch):
    saved = []
    user = threading.Thread(target=lambda: saved.append(CHOICES[choice](shared, monkeypatch)), daemon=True)

    def select_while_the_job_holds_the_lock():
        user.start()
        user.join(2)  # long enough to read the chosen bytes and then wait, or to finish if nothing makes it wait

    _run_job(shared, monkeypatch, under_lock=select_while_the_job_holds_the_lock)
    user.join(JOIN_SECONDS)

    assert not user.is_alive(), "the user's save and the job deadlocked"
    assert [status for status, _body in saved] == [200]
    _assert_choice_kept(shared, choice)
    other = _album_row(shared, shared.b)
    assert other["revision"] in (None, _sha(shared.chosen_bytes)), "B still records bytes that are no longer in the file"


@pytest.mark.parametrize("shared", ["one_album_folder"], indirect=True)
def test_live_without_a_user_choice_the_automatic_write_still_happens(shared, monkeypatch):
    assert _run_job(shared, monkeypatch)["downloaded"] == 1
    assert shared.target.read_bytes() != shared.chosen_bytes
    assert _album_row(shared, shared.b)["revision"] == _sha(shared.target.read_bytes())


def _forget_provenance(shared):
    """B's selection as a legacy one: user-owned, without proof of an in-app choice."""
    with isolatedPostgres._connect(shared.setup_url) as connection:
        connection.execute(
            "update library.local_albums set metadata = metadata - 'cover_selection_provenance' where id = %s",
            (shared.b["id"],),
        )
        connection.execute(
            """update library.local_track_files files
               set metadata = files.metadata #- '{scan_cache,file_entry,cover_selection_provenance}'
               from library.local_tracks tracks where tracks.id = files.track_id and tracks.album_id = %s""",
            (shared.b["id"],),
        )
        connection.commit()


@pytest.mark.parametrize("job_album", ["automatic", "user_owned", "legacy_user_owned"])
@pytest.mark.parametrize(("shared", "choice"), EVERY_WINDOW, indirect=["shared"])
def test_live_same_art_never_replaces_another_albums_choice(shared, choice, job_album, monkeypatch):
    if job_album != "automatic":
        assert _select_main(shared, monkeypatch, who="b")[0] == 200
        if job_album == "legacy_user_owned":
            _forget_provenance(shared)
    assert CHOICES[choice](shared, monkeypatch)[0] == 200
    album, artbox = _album_row(shared, shared.a), _artbox_row(shared)

    result = _run_job(shared, monkeypatch, art="same")

    _assert_choice_kept(shared, choice)
    _assert_refused_and_suggested(shared, result)
    assert (_album_row(shared, shared.a), _artbox_row(shared)) == (album, artbox)


@pytest.mark.parametrize("shared", ["one_album_folder"], indirect=True)
def test_live_an_albums_own_same_art_upgrade_is_still_written(shared, monkeypatch):
    assert _select_main(shared, monkeypatch, who="b")[0] == 200  # nobody else chose this file
    result = _run_job(shared, monkeypatch, art="same")
    detail = result["job_results"][0]
    assert result["downloaded"] == 1, {
        key: detail.get(key) for key in ("reason", "search_reason", "error", "error_type", "recovery_conflict")
    }
    assert shared.target.read_bytes() != shared.chosen_bytes
    assert _album_row(shared, shared.b)["revision"] == _sha(shared.target.read_bytes())
    assert _album_row(shared, shared.b)["origin"] == "user"


@pytest.mark.parametrize("shared", ["one_album_folder"], indirect=True)
def test_live_different_art_never_replaces_the_jobs_own_second_artbox(shared, monkeypatch):
    assert _select_artbox(shared, monkeypatch, who="b")[0] == 200  # nobody else chose this file
    chosen = _artbox_row(shared, who="b")

    result = _run_job(shared, monkeypatch, art="different")

    assert shared.target.read_bytes() == shared.chosen_bytes, "the job replaced its own album's second artbox"
    _assert_refused_and_suggested(shared, result)
    assert _artbox_row(shared, who="b") == chosen


@pytest.mark.parametrize("shared", ["one_album_folder"], indirect=True)
def test_live_same_art_still_upgrades_the_jobs_own_second_artbox(shared, monkeypatch):
    assert _select_artbox(shared, monkeypatch, who="b")[0] == 200  # nobody else chose this file
    chosen = _artbox_row(shared, who="b")

    assert _run_job(shared, monkeypatch, art="same")["downloaded"] == 1

    assert shared.target.read_bytes() != shared.chosen_bytes
    assert _album_row(shared, shared.b)["revision"] == _sha(shared.target.read_bytes())
    assert _artbox_row(shared, who="b") == chosen


@pytest.mark.parametrize("shared", list(REFUSED_BY), indirect=True)
def test_live_a_repeated_refusal_suggests_once(shared, monkeypatch):
    assert _select_main(shared, monkeypatch)[0] == 200
    for _ in range(2):
        with monkeypatch.context() as patches:
            result = _run_job(shared, patches)
        _assert_choice_kept(shared, "main")
        _assert_refused_and_suggested(shared, result)  # still revision 1: no new alert on each run


@pytest.mark.parametrize("shared", ["same_folder"], indirect=True)
def test_live_one_job_over_two_albums_never_writes_a_choice(shared, monkeypatch):
    assert _select_main(shared, monkeypatch)[0] == 200
    album = _album_row(shared, shared.a)
    result = _run_job(shared, monkeypatch, art="same", merged=True)
    _assert_choice_kept(shared, "main")
    assert _album_row(shared, shared.a) == album
    detail = result["job_results"][0]
    assert shared.refused_by in (detail.get("reason"), detail.get("search_reason")), (
        "nothing written is not proof: the job must refuse, for its folder's rule")


@pytest.mark.parametrize(("shared", "choice"), COMMIT_WINDOW, indirect=["shared"])
def test_live_a_job_without_an_album_id_never_writes_another_albums_choice(shared, choice, monkeypatch):
    assert CHOICES[choice](shared, monkeypatch)[0] == 200

    result = _run_job(shared, monkeypatch, art="same", unidentified=True)

    _assert_choice_kept(shared, choice)
    assert result["downloaded"] == 0
    detail = result["job_results"][0]
    assert shared.refused_by in (detail.get("reason"), detail.get("search_reason")), "another rule refused"


@pytest.mark.parametrize(("shared", "choice"), COMMIT_WINDOW, indirect=["shared"])
def test_live_a_write_back_survives_the_runs_runtime_publication(shared, choice, monkeypatch):
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    # B already shows the file automatically, so written back it looks just as it did when the run started.
    PostgresScanCacheAdapter(shared.config).persist_cover_selection(
        track_paths=shared.paths_b, selected_cover_path=shared.target, cover_revision=_sha(shared.chosen_bytes),
        cover_selection_origin="automatic", local_cover_width=300, local_cover_height=300,
    )
    saved = []
    user = threading.Thread(target=lambda: saved.append(CHOICES[choice](shared, monkeypatch)), daemon=True)

    def select_while_the_job_holds_the_lock():
        user.start()
        user.join(2)

    _run_job(shared, monkeypatch, under_lock=select_while_the_job_holds_the_lock,
             before_publish=lambda: user.join(JOIN_SECONDS))

    assert [status for status, _body in saved] == [200]
    assert shared.target.read_bytes() == shared.chosen_bytes
    assert _album_row(shared, shared.b)["revision"] == _sha(shared.chosen_bytes)
    for path in shared.paths_b:
        entry = shared.state["file_cache"][path]
        assert entry["cover_revision"] == _sha(shared.chosen_bytes), "the runtime shows the replaced revision"
        assert entry["local_cover_width"] == 300, "the runtime shows the replaced size"
    shown = [album for album in shared.state["albums"]
             if shared.paths_b & {str(track.path) for track in album.tracks}]
    assert shown and all(album.cover_revision == _sha(shared.chosen_bytes) for album in shown), (
        "the runtime's album shows the replaced revision")


@pytest.mark.parametrize("shared", ["one_album_folder"], indirect=True)
def test_live_a_write_back_over_the_saving_albums_own_automatic_write_stays_the_users(shared, monkeypatch):
    saved = []
    user = threading.Thread(target=lambda: saved.append(_select_main(shared, monkeypatch, who="b")), daemon=True)

    def select_while_the_job_holds_the_lock():
        user.start()
        user.join(2)

    _run_job(shared, monkeypatch, under_lock=select_while_the_job_holds_the_lock,
             before_publish=lambda: user.join(JOIN_SECONDS))

    assert [status for status, _body in saved] == [200]
    assert shared.target.read_bytes() == shared.chosen_bytes
    row = _album_row(shared, shared.b)
    assert (row["origin"], row["revision"]) == ("user", _sha(shared.chosen_bytes))
    for path in shared.paths_b:
        entry = shared.state["file_cache"][path]
        assert entry.get("cover_selection_origin") == "user", "the runtime calls the user's choice automatic"
        assert entry["cover_revision"] == _sha(shared.chosen_bytes)
    shown = [album for album in shared.state["albums"]
             if shared.paths_b & {str(track.path) for track in album.tracks}]
    assert shown and all(album.cover_selection_origin == "user" for album in shown), (
        "the runtime's album calls the user's choice automatic")


@pytest.mark.parametrize(("shared", "choice"), COMMIT_WINDOW, indirect=["shared"])
def test_live_a_write_back_that_cannot_complete_fails_the_save_readably(shared, choice, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as routes
    from music_app.services import cover_workflow

    album, artbox = _album_row(shared, shared.a), _artbox_row(shared)
    replace = cover_workflow._atomic_replace_file_bytes

    def refuse_the_clicked_bytes(path, raw_bytes, **options):
        if Path(path).resolve() == shared.target.resolve() and raw_bytes == shared.chosen_bytes:
            raise PermissionError("the clicked image's file is read-only")
        return replace(path, raw_bytes, **options)

    monkeypatch.setattr(cover_workflow, "_atomic_replace_file_bytes", refuse_the_clicked_bytes)
    monkeypatch.setattr(routes, "_atomic_replace_file_bytes", refuse_the_clicked_bytes, raising=False)
    saved = []
    user = threading.Thread(target=lambda: saved.append(CHOICES[choice](shared, monkeypatch)), daemon=True)

    def select_while_the_job_holds_the_lock():
        user.start()
        user.join(2)

    _run_job(shared, monkeypatch, under_lock=select_while_the_job_holds_the_lock)
    user.join(JOIN_SECONDS)

    assert not user.is_alive(), "the save never finished"
    assert len(saved) == 1, "the save gave no response"
    status, body = saved[0]
    assert status >= 400 and body["ok"] is False, "the save reported success without its bytes"
    assert "could not be" in body["error"], "the failure is not readable"
    assert (_album_row(shared, shared.a), _artbox_row(shared)) == (album, artbox), "the failed save was recorded"
    written = shared.target.read_bytes()
    assert written != shared.chosen_bytes
    assert _album_row(shared, shared.b)["revision"] == _sha(written), "the database records bytes the file lacks"


def _assert_failed_readably_and_wrote_nothing(shared, saved, album, artbox, newer, root_cover):
    assert shared.target.read_bytes() == newer, "the waiting save overwrote newer bytes"
    assert len(saved) == 1, "the waiting save gave no response"
    status, body = saved[0]
    assert status == 409 and body["ok"] is False, "the waiting save reported success"
    assert "that image changed, choose again" in body["error"].casefold(), "the failure is not readable"
    assert (_album_row(shared, shared.a), _artbox_row(shared)) == (album, artbox), "the failed save was recorded"
    assert not root_cover.exists(), "the failed save left a promoted file"


@pytest.mark.parametrize(("shared", "choice"), COMMIT_WINDOW, indirect=["shared"])
def test_live_an_edit_outside_the_app_while_the_save_waits_fails_it_readably(shared, choice, monkeypatch):
    from music_app.services.relation_projection_postgres import inventory_publication_advisory_lock_sql

    album, artbox = _album_row(shared, shared.a), _artbox_row(shared)
    root_cover, newer, saved = shared.target.parent.parent / "cover.jpg", _jpeg("newer", 600), []
    user = threading.Thread(target=lambda: saved.append(CHOICES[choice](shared, monkeypatch)), daemon=True)
    with isolatedPostgres._connect(shared.setup_url) as holder:
        holder.execute(inventory_publication_advisory_lock_sql())
        user.start()
        user.join(2)  # it has read the chosen bytes and waits for the publication lock
        shared.target.write_bytes(newer)
        holder.rollback()
    user.join(JOIN_SECONDS)

    assert not user.is_alive(), "the waiting save never finished"
    _assert_failed_readably_and_wrote_nothing(shared, saved, album, artbox, newer, root_cover)


@pytest.mark.parametrize(("shared", "choice"), COMMIT_WINDOW, indirect=["shared"])
def test_live_another_albums_user_save_while_the_save_waits_fails_it_readably(shared, choice, monkeypatch):
    from music_app.services import cover_workflow

    album, artbox = _album_row(shared, shared.a), _artbox_row(shared)
    root_cover, newer = shared.target.parent.parent / "cover.jpg", _jpeg("newer", 600)
    source = shared.target.parent / "newer.jpg"
    source.write_bytes(newer)
    holds_the_folder, may_write = threading.Event(), threading.Event()
    reserve = cover_workflow.reserve_existing_cover_variant

    def before_the_write(folder, *args, **options):
        if folder == shared.target.parent:
            holds_the_folder.set()  # B's save holds the folder's lock and has written nothing
            assert may_write.wait(JOIN_SECONDS)
        return reserve(folder, *args, **options)

    monkeypatch.setattr(cover_workflow, "reserve_existing_cover_variant", before_the_write)
    others, saved = [], []
    other = threading.Thread(
        target=lambda: others.append(_select_main(shared, monkeypatch, who="b", source=source)), daemon=True,
    )
    user = threading.Thread(target=lambda: saved.append(CHOICES[choice](shared, monkeypatch)), daemon=True)
    other.start()
    reached = holds_the_folder.wait(JOIN_SECONDS)
    user.start()
    user.join(2)  # it has read the chosen bytes and waits for the folder
    may_write.set()
    other.join(JOIN_SECONDS)
    user.join(JOIN_SECONDS)

    assert reached and not other.is_alive() and not user.is_alive(), "the saves never finished"
    assert [status for status, _body in others] == [200], "the other album's save must win"
    _assert_failed_readably_and_wrote_nothing(shared, saved, album, artbox, newer, root_cover)
    row = _album_row(shared, shared.b)
    assert (row["origin"], row["revision"]) == ("user", _sha(newer))


@pytest.mark.parametrize(("shared", "choice"), EVERY_WINDOW, indirect=["shared"])
def test_live_both_writers_finish_when_they_queue_on_the_publication_lock(shared, choice, monkeypatch):
    from music_app.services.relation_projection_postgres import inventory_publication_advisory_lock_sql

    saved, failures = [], []

    def job():
        try:
            _run_job(shared, monkeypatch)
        except BaseException as error:  # reported on the test's thread
            failures.append(error)

    job_thread = threading.Thread(target=job, daemon=True)
    user = threading.Thread(target=lambda: saved.append(CHOICES[choice](shared, monkeypatch)), daemon=True)
    with isolatedPostgres._connect(shared.setup_url) as holder:
        holder.execute(inventory_publication_advisory_lock_sql())
        job_thread.start()
        job_thread.join(1.5)
        user.start()
        user.join(1.5)
        holder.rollback()
    job_thread.join(JOIN_SECONDS)
    user.join(JOIN_SECONDS)

    assert not job_thread.is_alive() and not user.is_alive(), "lock-order deadlock"
    assert failures == []
    assert [status for status, _body in saved] == [200]
    _assert_choice_kept(shared, choice)
