"""Live duplicate SQL proof, restricted to an explicitly owned verification DB."""
from pathlib import Path
import os
import uuid

import pytest
from psycopg.types.json import Jsonb

from tests.e2e.support import isolatedPostgres
from tests.py.problematic_projection_support import publish_problematic_fixture
from tests.py.test_library_source_appearance_live import database
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository, invalidate_postgres_utility_projection_cache


@pytest.fixture
def inventory(database):
    setup, runtime = database
    prefix = "duplicate-verify-" + uuid.uuid4().hex
    account_id = None
    created_library_id = None
    track_ids = []
    album_ids = []
    artist_id = None
    release_keys = []
    root_ids = {}
    repository = None
    try:
        with isolatedPostgres._connect(setup) as connection:
            owner = connection.execute("select account_id from app.bootstrap_owners where owner_key = 'local-bootstrap-owner'").fetchone()
            if owner is None:
                account_id = connection.execute(
                    "insert into app.accounts(display_name,username_display,username_normalized,contact_email,contact_email_normalized) values(%s,%s,%s,%s,%s) returning id",
                    (prefix, prefix, prefix, prefix + "@example.test", prefix + "@example.test"),
                ).fetchone()["id"]
                connection.execute("insert into app.bootstrap_owners(account_id,owner_key) values(%s,'local-bootstrap-owner')", (account_id,))
                owner_id = account_id
            else:
                owner_id = owner["account_id"]
            library = connection.execute("select id from library.libraries where owner_account_id=%s and name='Local Library' and library_kind='local'", (owner_id,)).fetchone()
            if library is None:
                created_library_id = connection.execute("insert into library.libraries(owner_account_id,name,library_kind) values(%s,'Local Library','local') returning id", (owner_id,)).fetchone()["id"]
                library_id = created_library_id
            else:
                library_id = library["id"]
            for root_kind in ("main_library_roots", "hoarding_library_roots", "new_arrivals_roots"):
                root_ids[root_kind] = connection.execute(
                    "insert into library.library_roots(library_id, root_path, root_kind, is_active) values(%s,%s,%s,true) returning id",
                    (library_id, f"C:/multi-root-verification/{prefix}/{root_kind}", root_kind),
                ).fetchone()["id"]
            artist_name = prefix + " Artist"
            title = prefix + " Album"
            artist_id = connection.execute("insert into library.local_artists(library_id,artist_key,name) values(%s,%s,%s) returning id", (library_id, prefix, artist_name)).fetchone()["id"]
            keys = {}
            paths = {}
            for label, year, count, category in [("main", 2001, 1, "main_library_roots"), ("deluxe", 2001, 2, "hoarding_library_roots"), ("reissue", 2002, 1, "new_arrivals_roots"), ("unknown", None, 1, "hoarding_library_roots")]:
                key = artist_name.lower() + "::" + title.lower() + "::" + label
                keys[label] = key
                metadata = {"album_artist": artist_name, "artists": [artist_name], "edition": label, "local_cover_width": 1000, "local_cover_height": 1000}
                album_id = connection.execute("insert into library.local_albums(library_id,artist_id,album_key,title,release_year,cover_path,metadata) values(%s,%s,%s,%s,%s,%s,%s) returning id", (library_id, artist_id, key, title, year, prefix + "/cover.jpg", Jsonb(metadata))).fetchone()["id"]
                album_ids.append(album_id)
                paths[label] = []
                for number in range(1, count + 1):
                    path = str(Path("C:/multi-root-verification") / prefix / label / f"{number}.flac")
                    paths[label].append(path)
                    track_id = connection.execute("insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,disc_number,track_number,duration_seconds) values(%s,%s,%s,%s,%s,1,%s,%s) returning id", (library_id, album_id, artist_id, key + f"::{number}", f"Track {number}", number, 100 + number)).fetchone()["id"]
                    track_ids.append(track_id)
                    entry = {"path": path, "title": f"Track {number}", "album": title, "album_artist": artist_name, "artist": artist_name, "year": year, "edition": label, "disc_number": 1, "track_number": number, "duration_seconds": 100 + number, "library_root_category": category}
                    connection.execute("insert into library.local_track_files(track_id,library_root_id,private_path,metadata) values(%s,%s,%s,%s)", (track_id, root_ids[category], path, Jsonb({"library_root_category": category, "scan_cache": {"file_entry": entry}})))
        def add_track(label, relative_path, *, year=2002, scan_tags=True, category="new_arrivals_roots"):
            path = str(Path(paths["main"][0]).parent / relative_path)
            with isolatedPostgres._connect(setup) as connection:
                album_id = connection.execute("select id from library.local_albums where library_id=%s and album_key=%s", (library_id, keys[label])).fetchone()["id"]
                track_id = connection.execute("insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,disc_number,track_number,duration_seconds) values(%s,%s,%s,%s,'Extra',2,2,120) returning id", (library_id, album_id, artist_id, prefix + "::extra::" + uuid.uuid4().hex)).fetchone()["id"]
                track_ids.append(track_id)
                entry = {"path": path, "title": "Extra", "album": title, "album_artist": artist_name, "artist": artist_name, "year": year, "disc_number": 2, "track_number": 2, "library_root_category": category}
                connection.execute("insert into library.local_track_files(track_id,library_root_id,private_path,metadata) values(%s,%s,%s,%s)", (track_id, root_ids[category], path, Jsonb({"library_root_category": category, "scan_cache": {"file_entry": entry}} if scan_tags else {})))
            return path

        def separate(label):
            with isolatedPostgres._connect(setup) as connection:
                connection.execute("insert into library.separate_releases(library_id,release_key) values(%s,%s)", (library_id, keys[label]))
            release_keys.append(keys[label])

        # Direct fixture SQL does not emit the application's inventory invalidation.
        invalidate_postgres_utility_projection_cache(database_url=runtime)
        repository = PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": runtime})
        yield repository, keys, paths, add_track, separate
    finally:
        invalidate_postgres_utility_projection_cache(database_url=runtime)
        with isolatedPostgres._connect(setup) as connection:
            connection.execute("delete from library.separate_releases where release_key = any(%s)", (release_keys,))
            connection.execute("delete from library.local_tracks where id = any(%s)", (track_ids,))
            connection.execute("delete from library.local_albums where id = any(%s)", (album_ids,))
            if artist_id is not None:
                connection.execute("delete from library.local_artists where id=%s", (artist_id,))
            connection.execute("delete from library.library_roots where id = any(%s)", (list(root_ids.values()),))
            connection.execute(
                "delete from ops.jobs where id = any(%s) and kind='problematic_files_projection'",
                (list(getattr(repository, "_fixture_problematic_job_ids", ())),),
            )
            # Canonical bootstrap account/library remain isolated-database infrastructure.
            # The provisioner's database teardown owns their removal.


@pytest.mark.parametrize("page_limit", [1, 32])
def test_live_projection_confirms_exhaustion_after_all_source_groups(inventory, monkeypatch, page_limit):
    from music_app.jobs import problematic_projection_handlers as handlers
    from music_app.services.problematic_projection_postgres import PostgresProblematicProjectionRepository

    repository, *_ = inventory
    pages = []
    populated_groups = set()
    load_page = PostgresProblematicProjectionRepository.load_claimed_source_page

    def capture_page(self, **kwargs):
        page = load_page(self, **kwargs)
        populated_groups.update(chunk.group_key for chunk in page.chunks if chunk.rows)
        pages.append((tuple((chunk.group_key, chunk.cursor, chunk.complete)
                            for chunk in page.chunks), page.complete))
        return page

    monkeypatch.setattr(handlers, "PROBLEMATIC_PROJECTION_SOURCE_PAGE_LIMIT", page_limit)
    monkeypatch.setattr(PostgresProblematicProjectionRepository, "load_claimed_source_page", capture_page)
    publish_problematic_fixture(repository)
    assert len({group for chunks, _ in pages for group, _, _ in chunks}) >= 2, pages
    assert populated_groups == {group for chunks, _ in pages for group, _, _ in chunks}, pages
    assert all(not complete for chunks, complete in pages if chunks), pages
    assert pages[-1] == ((), True), pages


def test_live_projection_resumes_after_completed_group(inventory, database, monkeypatch):
    from datetime import datetime, timedelta, timezone
    from music_app.jobs.problematic_projection_handlers import build_problematic_projection_handler
    from music_app.services.jobs.authorization import AuthorizationDecision
    from music_app.services.jobs.models import JobState, JobTransitionResult
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_files_projection import project_problematic_files
    from music_app.services.problematic_projection_postgres import PostgresProblematicProjectionRepository

    repository, keys, *_ = inventory
    setup_url, _runtime_url = database
    completed = {}
    complete = PostgresProblematicProjectionRepository.complete_claimed_source_group

    class Interrupted(Exception):
        pass

    def interrupt_after_completion(self, **kwargs):
        complete(self, **kwargs)
        completed.update(kwargs)
        completed["repository"] = self
        raise Interrupted

    with monkeypatch.context() as patch:
        patch.setattr(PostgresProblematicProjectionRepository, "complete_claimed_source_group",
                      interrupt_after_completion)
        with pytest.raises(Interrupted):
            publish_problematic_fixture(repository)

    now = datetime.now(timezone.utc)
    jobs = PostgresJobRepository(database_url=os.environ["ALBUM_HAVEN_WORKER_DATABASE_URL"])
    claim = completed["claim"]
    assert jobs.finish(claim, JobTransitionResult(
        JobState.RETRY_WAIT, "test_interrupted_after_group", scheduled_at=now,
    ), now=now)
    resumed = jobs.claim(worker_id="test-resumed-group", now=now + timedelta(seconds=1),
                         lease_seconds=120, kinds=("problematic_files_projection",))
    assert resumed is not None and resumed.job_id == claim.job_id
    assert resumed.attempt == claim.attempt + 1
    worker = completed["repository"]
    build = worker.prepare_claimed_build(claim=resumed, now=now + timedelta(seconds=1))
    assert build.revision == completed["build"].revision
    assert build.source_group_key is None and build.source_cursor is None
    page = worker.load_claimed_source_page(claim=resumed, build=build, limit=1,
                                          child_limit=1, now=now + timedelta(seconds=1))
    empty_scan_watermarks = set()
    while not page.complete and not page.chunks:
        with isolatedPostgres._connect(setup_url) as connection:
            watermark = connection.execute(
                "select scan_kind, scan_identity from ops.problematic_projection_state "
                "where library_id = %s", (build.library_id,),
            ).fetchone()
        watermark = (watermark["scan_kind"], int(watermark["scan_identity"]))
        assert watermark not in empty_scan_watermarks
        if empty_scan_watermarks:
            assert watermark > max(empty_scan_watermarks)
        empty_scan_watermarks.add(watermark)
        assert len(empty_scan_watermarks) <= len(keys)
        page = worker.load_claimed_source_page(
            claim=resumed, build=build, limit=1, child_limit=1,
            now=now + timedelta(seconds=1),
        )
    assert page.chunks and page.chunks[0].rows
    assert page.chunks[0].group_key != completed["group_key"]
    assert page.chunks[0].cursor[2] == "file"

    class Context:
        cancel_requested = False
        lease_active = True

        @staticmethod
        def reauthorize():
            return AuthorizationDecision(True, "problematic_projection_scope_current")

    result = build_problematic_projection_handler(
        repository=worker, project_group=project_problematic_files,
    )(resumed, Context())
    assert result.next_state is JobState.SUCCEEDED
    assert jobs.finish(resumed, result, now=datetime.now(timezone.utc))
    summaries = {item["key"]: item for item in repository.build_problematic_files_page(limit=200)["items"]}
    for label in ("main", "deluxe"):
        assert "Duplicate files" in summaries[keys[label]]["problem_reasons"]


def test_live_duplicate_candidates_details_and_problematic_projection_agree(inventory, monkeypatch):
    from music_app.services import library_browse_postgres as browse

    def reject_global_duplicate_work(*args, **kwargs):
        raise AssertionError("Problematic Files detail must use targeted duplicate lookup")

    repository, keys, paths, _add_track, _separate = inventory
    summaries = {item["key"]: item for item in publish_problematic_fixture(repository)["items"]}
    for label in ("main", "deluxe"):
        assert "Duplicate files" in summaries[keys[label]]["problem_reasons"]
        detail = repository.build_album_detail_payload(keys[label])
        assert detail["has_duplicate_files"] is True
        assert sorted(source["track_count"] for source in detail["duplicate_sources"]) == [1, 2]
        assert {track["path"] for track in detail["tracks"]} == set(paths[label])
        with monkeypatch.context() as guard:
            guard.setattr(browse, "_duplicate_inventory_fingerprint", reject_global_duplicate_work)
            guard.setattr(browse, "_load_duplicate_candidate_album_ids", reject_global_duplicate_work)
            problem = repository.build_problematic_file_detail_payload(keys[label])
            opaque_problem = repository.build_problematic_file_detail_payload(
                projection_id=summaries[keys[label]]["projection_id"],
            )
        assert "Duplicate files" in problem["problem_reasons"]
        assert len(problem["duplicate_sources"]) == 2
        assert "Duplicate files" in opaque_problem["problem_reasons"]
        assert len(opaque_problem["duplicate_sources"]) == 2
    for label in ("reissue", "unknown"):
        detail = repository.build_album_detail_payload(keys[label])
        assert detail["has_duplicate_files"] is False
        assert "Duplicate files" not in summaries.get(keys[label], {}).get("problem_reasons", [])


@pytest.mark.parametrize("scan_tags", [False, True])
def test_candidate_container_includes_unknown_or_conflicting_multidisc_row(inventory, scan_tags):
    repository, keys, _paths, add_track, _separate = inventory
    add_track("reissue", "Disc 2/conflict.flac", year=2002, scan_tags=scan_tags)
    for label in ("main", "deluxe"):
        assert repository.build_album_detail_payload(keys[label])["has_duplicate_files"] is False
    summaries = {item["key"]: item for item in publish_problematic_fixture(repository)["items"]}
    for label in ("main", "deluxe"):
        assert "Duplicate files" not in summaries.get(keys[label], {}).get("problem_reasons", [])


def test_separated_release_lookup_scopes_duplicate_sources_to_displayed_year(inventory):
    repository, keys, _paths, add_track, separate = inventory
    new_paths = {
        add_track("main", "../release-2002-a/one.flac", year=2002),
        add_track("main", "../release-2002-b/one.flac", year=2002),
    }
    separate("main")
    detail = repository.build_album_detail_payload(keys["main"] + "::year::2002")
    assert detail is not None
    assert detail["has_duplicate_files"] is True
    assert len(detail["duplicate_sources"]) == 3  # Includes the existing 2002 reissue.
    assert all(track["year"] == 2002 for source in detail["duplicate_sources"] for track in source["tracks"])
    assert {track["path"] for track in detail["tracks"]} <= new_paths
    problem = repository.build_problematic_file_detail_payload(keys["main"] + "::year::2002")
    assert "Duplicate files" in problem["problem_reasons"]
    assert all(track["year"] == 2002 for source in problem["duplicate_sources"] for track in source["tracks"])


def test_separated_release_provenance_uses_only_displayed_year(inventory):
    repository, keys, _paths, add_track, separate = inventory
    add_track("main", "../release-2002-copy/one.flac", year=2002, category="new_arrivals_roots")
    add_track("main", "../release-2003-only/one.flac", year=2003, category="hoarding_library_roots")
    separate("main")
    old = repository.build_album_detail_payload(keys["main"] + "::year::2001")
    new = repository.build_album_detail_payload(keys["main"] + "::year::2002")
    assert set(old["root_provenance"]["categories"]) == {"main_library", "hoard"}
    assert set(new["root_provenance"]["categories"]) == {"new_arrivals"}
    solo = repository.build_album_detail_payload(keys["main"] + "::year::2003")
    assert solo["has_duplicate_files"] is False
    assert set(solo["root_provenance"]["categories"]) == {"hoard"}
    problem = repository.build_problematic_file_detail_payload(keys["main"] + "::year::2001")
    assert set(problem["root_provenance"]["categories"]) == {"main_library", "hoard"}


def test_candidate_year_matching_is_symmetric_across_catalogue_years(inventory):
    repository, keys, paths, add_track, _separate = inventory
    path = add_track("reissue", "../reissue-2001-copy/one.flac", year=2001)
    for label in ("main", "reissue"):
        detail = repository.build_album_detail_payload(keys[label])
        found = {track["path"] for source in detail["duplicate_sources"] for track in source["tracks"]}
        assert set(paths["main"]) | set(paths["deluxe"]) | {path} <= found
    problems = {item["key"]: item for item in publish_problematic_fixture(repository)["items"]}
    assert all("Duplicate files" in problems[keys[label]]["problem_reasons"] for label in ("main", "reissue"))
