"""Targeted Problematic Files reads against uniquely owned PostgreSQL data."""

from contextlib import contextmanager
import json
import sys
from types import SimpleNamespace
from urllib.parse import urlencode
from uuid import uuid4

from fastapi import FastAPI
import pytest
from starlette.requests import Request

from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
from music_app.services.library_inventory_postgres import PostgresLibraryInventoryRepository
from music_app.services.repair_previews import find_problematic_album_by_track_paths
from tests.e2e.support import isolatedPostgres
from tests.py.problematic_projection_support import publish_problematic_fixture
from tests.py.test_library_source_appearance_live import database
from tests.py.test_multi_root_duplicates_live import inventory
from tests.py.test_problematic_projection_postgres import live_projection_database


@pytest.fixture(autouse=True)
def prepared_database(live_projection_database):
    return live_projection_database


@contextmanager
def _observe_targeted_reads():
    """Observe native calls without replacing methods or consuming selectors."""
    owners = {
        PostgresLibraryBrowseRepository._load_problematic_file_rows.__code__: "owner",
        PostgresLibraryInventoryRepository.load_non_album_candidates.__code__: "candidates",
    }
    observations = []
    previous = sys.getprofile()

    def observe(frame, event, arg):
        if event == "call" and frame.f_code in owners:
            selected = any(frame.f_locals.get(name) for name in (
                "album_key", "projection_id", "album_ids", "file_paths",
                "track_ids", "private_paths", "artist_names", "query_terms",
            ))
            observations.append((owners[frame.f_code], selected))
        if previous is not None:
            previous(frame, event, arg)

    sys.setprofile(observe)
    try:
        yield observations
    finally:
        sys.setprofile(previous)


def _assert_targeted(observations):
    assert any(kind == "owner" and selected for kind, selected in observations)
    assert all(selected for _kind, selected in observations), observations


@pytest.fixture
def loose_catalog(prepared_database):
    fixture = prepared_database
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        root_id = connection.execute(
            "insert into library.library_roots(library_id,root_path,root_kind) "
            "values (%s,'C:/targeted-followup','main_library_roots') returning id",
            (fixture.library_id,),
        ).fetchone()["id"]
        artist_id = connection.execute(
            "insert into library.local_artists(library_id,artist_key,name) "
            "values (%s,'targeted-followup','Targeted Followup') returning id",
            (fixture.library_id,),
        ).fetchone()["id"]
    return SimpleNamespace(
        database=fixture, root_id=root_id, artist_id=artist_id,
        config={"ALBUM_HAVEN_APP_DATABASE_URL": fixture.app_url},
    )


def _seed_files(catalog, count, group, *, album_title=None, membership_problem=True):
    directory = f"C:/targeted-followup/{group}/"
    with isolatedPostgres._connect(catalog.database.setup_url) as connection:
        connection.execute(
            """
            with tracks as (
              insert into library.local_tracks
                (library_id,artist_id,track_key,title,disc_number,track_number)
              select %s,%s,%s || value, %s || value,1,value
              from generate_series(1,%s) value
              returning id,title,track_number
            )
            insert into library.local_track_files
              (track_id,library_root_id,private_path,file_size_bytes,metadata)
            select tracks.id,%s,%s || lpad(track_number::text,5,'0') || '.flac',1024,
              jsonb_build_object('scan_cache',jsonb_build_object('file_entry',
                jsonb_build_object(
                  'path',%s || lpad(track_number::text,5,'0') || '.flac',
                  'album',coalesce(%s,%s || case when track_number %% 2 = 0 then ' Even' else ' Odd' end),
                  'local_album_membership_problem',case when %s then 'Mixed album metadata in one folder' end,
                  'album_artist','Targeted Followup','artist','Targeted Followup',
                  'title',tracks.title,'year',2026,'disc_number',1,
                  'track_number',track_number)))
            from tracks
            """,
            (catalog.database.library_id, catalog.artist_id, group, group, count,
             catalog.root_id, directory, directory, album_title, group, membership_problem),
        )
    return {f"{directory}{number:05}.flac" for number in range(1, count + 1)}


def test_live_mutation_followup_preserves_cross_album_duplicate_sources(inventory):
    from music_app.services.cache import persist_cover_selection_for_tracks_for_config

    repository, keys, paths, *_ = inventory
    before = repository.build_problematic_file_detail_payload(keys["main"])
    assert before is not None and len(before["duplicate_sources"]) == 2
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": repository._database_url}
    result = persist_cover_selection_for_tracks_for_config(
        config, set(paths["main"]), None, clear_selection=True,
    )
    assert result["album_rows_updated"] == 1
    after = find_problematic_album_by_track_paths(set(paths["main"]), config=config)
    assert after is not None
    assert "Duplicate files" in after["problem_reasons"]
    assert len(after["duplicate_sources"]) == 2
    assert after["root_provenance"] == before["root_provenance"]
    assert {track["path"] for track in after["tracks"]} == set(paths["main"])


@pytest.mark.parametrize("credit_state", ["present", "null", "empty", "whitespace"])
def test_live_published_split_release_legacy_ref_preserves_persisted_owner(inventory, prepared_database, credit_state, request):
    repository, keys, paths, add_track, separate = inventory
    other_year_path = add_track("main", "../split-2002/one.flac", year=2002)
    semantic_base = keys["main"]
    persisted_key = "persisted-owner::" + uuid4().hex
    with isolatedPostgres._connect(prepared_database.setup_url) as connection:
        assert connection.execute(
            "update library.local_albums set album_key=%s where library_id=%s and album_key=%s returning id",
            (persisted_key, prepared_database.library_id, keys["main"]),
        ).fetchone() is not None
        if credit_state != "present":
            credit = {"null": None, "empty": "", "whitespace": "   "}[credit_state]
            connection.execute(
                "update library.local_albums set metadata=jsonb_set(metadata,'{album_artist}',%s::jsonb) "
                "where library_id=%s and album_key=%s",
                (json.dumps(credit), prepared_database.library_id, persisted_key),
            )
        peer_artist_id = connection.execute(
            "insert into library.local_artists(library_id,artist_key,name,sort_name,metadata) "
            "select artists.library_id,%s,artists.name,artists.sort_name,artists.metadata "
            "from library.local_artists artists join library.local_albums albums "
            "on albums.artist_id=artists.id and albums.library_id=artists.library_id "
            "where albums.library_id=%s and albums.album_key=%s returning id",
            ("peer-owner::" + uuid4().hex, prepared_database.library_id, persisted_key),
        ).fetchone()["id"]
        peer_id = connection.execute(
            "insert into library.local_albums(library_id,artist_id,album_key,title,release_year,cover_path,metadata) "
            "select library_id,%s,'zzz',title,release_year,cover_path,metadata "
            "from library.local_albums where library_id=%s and album_key=%s returning id",
            (peer_artist_id, prepared_database.library_id, persisted_key),
        ).fetchone()["id"]

    def remove_peer():
        with isolatedPostgres._connect(prepared_database.setup_url) as connection:
            connection.execute("delete from library.local_tracks where album_id=%s", (peer_id,))
            connection.execute("delete from library.local_albums where id=%s", (peer_id,))
            connection.execute("delete from library.local_artists where id=%s", (peer_artist_id,))

    request.addfinalizer(remove_peer)
    keys["peer"] = "zzz"
    peer_path = add_track("peer", "../zzz-peer/one.flac", year=2001)
    with isolatedPostgres._connect(prepared_database.setup_url) as connection:
        connection.execute("update library.local_tracks set artist_id=%s where album_id=%s", (peer_artist_id, peer_id))
    keys["main"] = persisted_key
    separate("main")
    page = publish_problematic_fixture(repository)
    expected_base = "::" + semantic_base.split("::", 1)[1] if credit_state == "whitespace" else semantic_base
    selected = next(item for item in page["items"]
                    if item["album_ref"] == expected_base + "::year::2001")
    peer = next(item for item in page["items"] if item["album_ref"] == "zzz")
    assert selected["album_ref"].endswith("::year::2001")
    assert selected["album_ref"] == expected_base + "::year::2001"
    assert selected["album_ref"] != persisted_key + "::year::2001"
    opaque = repository.build_problematic_file_detail_payload(projection_id=selected["projection_id"])
    assert opaque is not None
    assert opaque["projection_id"] == selected["projection_id"]
    owner_rows = repository._load_problematic_file_rows(album_key=selected["album_ref"])
    assert peer_id in {row["album_id"] for row in owner_rows}
    assert len({row["album_id"] for row in owner_rows}) == 2
    assert all(row["separate_release"] is False for row in owner_rows if row["album_id"] == peer_id)
    assert all(row["separate_release"] is True for row in owner_rows if row["album_id"] != peer_id)
    with _observe_targeted_reads() as observations:
        legacy = repository.build_problematic_file_detail_payload(album_key=selected["album_ref"])
    _assert_targeted(observations)
    assert legacy is not None
    assert legacy["key"] == selected["key"]
    assert legacy["projection_id"] == opaque["projection_id"]
    assert legacy["problem_reasons"] == opaque["problem_reasons"]
    assert legacy["duplicate_sources"] == opaque["duplicate_sources"]
    assert legacy["root_provenance"] == opaque["root_provenance"]
    assert {track["path"] for track in legacy["tracks"]} == set(paths["main"])
    assert other_year_path not in {track["path"] for track in legacy["tracks"]}
    assert peer_path not in {track["path"] for track in opaque["tracks"]}
    assert peer_path not in {track["path"] for track in legacy["tracks"]}
    peer_detail = repository.build_problematic_file_detail_payload(projection_id=peer["projection_id"])
    assert peer_detail is not None
    assert peer_detail["key"] == "zzz"
    assert {track["path"] for track in peer_detail["tracks"]} == {peer_path}


def test_live_unassigned_followup_preserves_complete_selected_owner(loose_catalog):
    paths = _seed_files(loose_catalog, 2, "selected")
    unrelated = _seed_files(loose_catalog, 2, "unrelated")
    selected_path = min(paths)
    with isolatedPostgres._connect(loose_catalog.database.app_url) as connection:
        file_id = connection.execute(
            "select id from library.local_track_files where private_path=%s", (selected_path,),
        ).fetchone()["id"]
    with _observe_targeted_reads() as observations:
        detail = find_problematic_album_by_track_paths(
            {selected_path}, config=loose_catalog.config,
        )
    _assert_targeted(observations)
    assert detail is not None
    assert detail["key"] == f"loose-source::{file_id}"
    assert {track["path"] for track in detail["tracks"]} == {selected_path}
    assert not ({track["path"] for track in detail["tracks"]} & ((paths | unrelated) - {selected_path}))
    assert "Mixed album metadata in one folder" in detail["problem_reasons"]


def test_live_legacy_loose_detail_is_targeted_after_5001_unrelated_candidates(loose_catalog):
    _seed_files(loose_catalog, 5001, "000-unrelated", album_title="Loose Tracks", membership_problem=False)
    marked = _seed_files(loose_catalog, 2, "zzz-selected")
    paths = {min(marked)}
    repository = PostgresLibraryBrowseRepository(loose_catalog.config)
    page = publish_problematic_fixture(repository)
    assert len(page["items"]) == 2
    with isolatedPostgres._connect(loose_catalog.database.app_url) as connection:
        identities = connection.execute(
            "select fact.item_key from ops.problematic_projection_search_facts fact "
            "join ops.problematic_projection_state state on state.library_id=fact.library_id "
            "and state.committed_revision=fact.revision "
            "where fact.library_id=%s and fact.fact_kind='private_path_locator' "
            "and fact.normalized_text=%s",
            (loose_catalog.database.library_id, min(paths)),
        ).fetchall()
    assert len(identities) == 1
    selected = next(item for item in page["items"]
                    if item["projection_id"] == identities[0]["item_key"])
    with _observe_targeted_reads() as observations:
        detail = repository.build_problematic_file_detail_payload(album_key=selected["album_ref"])
    _assert_targeted(observations)
    assert detail is not None
    assert {track["path"] for track in detail["tracks"]} == paths
    assert len(detail["tracks"]) == len(paths)


@pytest.mark.parametrize("suffix", ["not-a-number", "0", "9223372036854775808", "9" * 100],
                         ids=["non-numeric", "zero", "bigint-overflow", "oversized"])
def test_live_malformed_legacy_loose_selector_never_reads_global_candidates(loose_catalog, suffix):
    repository = PostgresLibraryBrowseRepository(loose_catalog.config)
    with _observe_targeted_reads() as observations:
        detail = repository.build_problematic_file_detail_payload(album_key=f"loose-source::{suffix}")
    _assert_targeted(observations)
    assert detail is None


def test_live_loose_opaque_detail_ignores_assigned_album_with_same_display_identity(loose_catalog):
    catalog = loose_catalog
    loose_paths = _seed_files(catalog, 2, "collision")
    selected_path = min(loose_paths)
    assigned_path = "C:/targeted-followup/assigned-collision/01.flac"
    with isolatedPostgres._connect(catalog.database.setup_url) as connection:
        selected = connection.execute(
            "select id,metadata #> '{scan_cache,file_entry}' as entry "
            "from library.local_track_files where private_path=%s", (selected_path,),
        ).fetchone()
        entry = selected["entry"]
        album_id = connection.execute(
            "insert into library.local_albums(library_id,artist_id,album_key,title,release_year,metadata) "
            "values(%s,%s,'assigned-collision',%s,2026,%s::jsonb) returning id",
            (catalog.database.library_id, catalog.artist_id, entry["album"],
             json.dumps({"album_artist": entry["album_artist"]})),
        ).fetchone()["id"]
        track_id = connection.execute(
            "insert into library.local_tracks(library_id,artist_id,album_id,track_key,title,track_number) "
            "values(%s,%s,%s,'assigned-collision','Assigned Collision',1) returning id",
            (catalog.database.library_id, catalog.artist_id, album_id),
        ).fetchone()["id"]
        connection.execute(
            "insert into library.local_track_files(track_id,library_root_id,private_path,metadata) "
            "values(%s,%s,%s,%s::jsonb)",
            (track_id, catalog.root_id, assigned_path, json.dumps({"scan_cache": {"file_entry": {
                "path": assigned_path, "album": entry["album"], "album_artist": entry["album_artist"],
                "artist": entry["artist"], "title": "Assigned Collision", "year": 2026, "track_number": 1,
            }}})),
        )
    repository = PostgresLibraryBrowseRepository(catalog.config)
    page = publish_problematic_fixture(repository)
    item = next(item for item in page["items"] if item["album_ref"] == f"loose-source::{selected['id']}")
    assert item["name"] == entry["album"]
    assert item["album_artist"] == entry["album_artist"]
    detail = repository.build_problematic_file_detail_payload(projection_id=item["projection_id"])
    assert detail is not None
    assert detail["projection_id"] == item["projection_id"]
    assert detail["album_ref"] == item["album_ref"]
    assert {track["path"] for track in detail["tracks"]} == {selected_path}
    assert assigned_path not in {track["path"] for track in detail["tracks"]}
    assert not ({track["path"] for track in detail["tracks"]} & (loose_paths - {selected_path}))
    assert "Mixed album metadata in one folder" in detail["problem_reasons"]


def test_live_duplicate_enrichment_uses_renamed_canonical_library(inventory, prepared_database):
    fixture = prepared_database
    repository, keys, paths, *_ = inventory
    before = repository.build_problematic_file_detail_payload(keys["main"])
    assert before is not None and len(before["duplicate_sources"]) == 2
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("update library.libraries set name='Renamed Canonical', "
                           "metadata=metadata || '{\"scan_cache\":{\"relation_views\":{\"alias_to_canonical\":{\"selected-alias\":\"selected-canonical\"}}}}'::jsonb where id=%s",
                           (fixture.library_id,))
        token = uuid4().hex
        account_id = connection.execute(
            "insert into app.accounts(display_name,username_display,username_normalized," 
            "contact_email,contact_email_normalized) values(%s,%s,%s,%s,%s) returning id",
            (token, token, token, f"{token}@example.test", f"{token}@example.test"),
        ).fetchone()["id"]
        connection.execute(
            "insert into library.libraries(owner_account_id,name,library_kind) "
            "values(%s,'Local Library','local')", (account_id,),
        )
    with isolatedPostgres._connect(fixture.app_url) as connection:
        assert connection.execute(
            "select library_id from ops.resolve_problematic_projection_library()"
        ).fetchone()["library_id"] == fixture.library_id
    after = repository.build_problematic_file_detail_payload(keys["main"])
    assert after is not None
    assert "Duplicate files" in after["problem_reasons"]
    assert len(after["duplicate_sources"]) == 2
    assert after["root_provenance"] == before["root_provenance"]
    assert {track["path"] for track in after["tracks"]} == set(paths["main"])
    assert repository._load_persisted_problematic_aliases() == {"selected-alias": "selected-canonical"}


@pytest.mark.parametrize("selector", ["projection_id", "album_key"])
def test_live_detail_dispatch_ignores_blank_spare_track_selector(inventory, prepared_database, selector):
    from music_app.routes.api_read_asgi_routes import utilities_problematic_file_detail_query
    from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship

    fixture = prepared_database
    repository, keys, *_ = inventory
    page = publish_problematic_fixture(repository)
    selected = next(item for item in page["items"] if item["key"] == keys["main"])
    app = FastAPI()
    app.state.config = {"ALBUM_HAVEN_APP_DATABASE_URL": fixture.app_url}
    app.state.auth_policy_config = {"hmac": {"secret": "targeted-followup-policy-key-32-bytes", "key_version": 1}}
    with isolatedPostgres._connect(fixture.app_url) as connection:
        owner_id = connection.execute(
            "select account_id from app.bootstrap_owners where owner_key='local-bootstrap-owner'"
        ).fetchone()["account_id"]
    query = {selector: selected[selector] if selector == "projection_id" else selected["key"],
             "track_path": "   ", "album_key" if selector == "projection_id" else "projection_id": " "}
    request = Request({"type": "http", "method": "GET", "path": "/utilities/problematic-files/detail",
                       "query_string": urlencode(query).encode(), "headers": [], "app": app,
                       "scheme": "http", "server": ("localhost", 80)})
    request.state.current_actor = CurrentActor(
        state=ActorState.ACTIVE, account_id=owner_id, is_bootstrap_owner=True,
        current_library_id=fixture.library_id,
        library_relationships=(LibraryRelationship(fixture.library_id, "owner", True),),
    )
    response = utilities_problematic_file_detail_query(request)
    assert response.status_code == 200
    assert json.loads(response.body)["key"] == selected["key"]
    for other in ("projection_id", "album_key", "track_path"):
        if other == selector:
            continue
        request.scope["query_string"] = urlencode({selector: query[selector], other: "nonempty"}).encode()
        ambiguous = Request(request.scope)
        assert utilities_problematic_file_detail_query(ambiguous).status_code == 400


@pytest.mark.parametrize("selector", ["projection_id", "album_key"])
def test_live_missing_detail_uses_canonical_library_with_older_nonlocal(prepared_database, selector):
    from music_app.services import library_browse_postgres as browse

    fixture = prepared_database
    album_key = "canonical-missing-album"
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        owner_id = connection.execute(
            "select owner_account_id from library.libraries where id=%s", (fixture.library_id,),
        ).fetchone()["owner_account_id"]
        library_id = connection.execute(
            "insert into library.libraries(owner_account_id,name,library_kind) "
            "values(%s,'Renamed Canonical Missing','archive') returning id", (owner_id,),
        ).fetchone()["id"]
        connection.execute(
            "update library.libraries set library_kind=case when id=%s then 'local' else 'archive' end "
            "where id=any(%s::bigint[])", (library_id, [fixture.library_id, library_id]),
        )
        root_id = connection.execute(
            "insert into library.library_roots(library_id,root_path,root_kind) "
            "values(%s,'C:/canonical-missing','main_library_roots') returning id", (library_id,),
        ).fetchone()["id"]
        artist_id = connection.execute(
            "insert into library.local_artists(library_id,artist_key,name) "
            "values(%s,'canonical-missing','Canonical Missing Artist') returning id", (library_id,),
        ).fetchone()["id"]
        album_id = connection.execute(
            "insert into library.local_albums(library_id,artist_id,album_key,title,release_year) "
            "values(%s,%s,%s,'Canonical Missing Album',2026) returning id",
            (library_id, artist_id, album_key),
        ).fetchone()["id"]
        track_id = connection.execute(
            "insert into library.local_tracks(library_id,artist_id,album_id,track_key,title,track_number) "
            "values(%s,%s,%s,'canonical-missing','Canonical Missing Track',1) returning id",
            (library_id, artist_id, album_id),
        ).fetchone()["id"]
        connection.execute(
            "insert into library.local_track_files(track_id,library_root_id,private_path,metadata) "
            "values(%s,%s,'C:/canonical-missing/01.flac',%s::jsonb)",
            (track_id, root_id, json.dumps({"scan_cache": {
                "stale": True, "stale_marked_at": "2026-10-01T00:00:00Z",
                "file_entry": {"album": "Canonical Missing Album", "album_artist": "Canonical Missing Artist",
                               "artist": "Canonical Missing Artist", "title": "Canonical Missing Track", "year": 2026},
            }})),
        )
    with isolatedPostgres._connect(fixture.app_url) as connection:
        assert connection.execute(
            "select library_id from ops.resolve_problematic_projection_library()",
        ).fetchone()["library_id"] == library_id
    assert fixture.library_id < library_id
    repository = PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": fixture.app_url})
    page = publish_problematic_fixture(repository)
    assert len(page["items"]) == 1
    selected = page["items"][0]
    assert selected["inventory_status"] == "missing"
    assert selected["album_ref"] == album_key
    queries = []
    previous = sys.getprofile()

    def observe(frame, event, arg):
        if frame.f_code is browse._missing_albums_sql.__code__ and event == "return":
            queries.append(arg)
        if previous is not None:
            previous(frame, event, arg)

    sys.setprofile(observe)
    try:
        detail = repository.build_problematic_file_detail_payload(**{
            selector: selected["projection_id"] if selector == "projection_id" else album_key,
        })
    finally:
        sys.setprofile(previous)
    assert detail is not None
    assert detail["problem_reasons"] == ["Album not found"]
    assert detail.get("inventory_status") == "missing"
    assert detail["name"] == "Canonical Missing Album"
    assert detail["album_artist"] == "Canonical Missing Artist"
    assert len(queries) == 1
    assert "ops.resolve_problematic_projection_library()" in queries[0]
