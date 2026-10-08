"""Owned isolated-Postgres proof for durable root gallery snapshots."""
import pytest
from itertools import combinations, permutations
from time import perf_counter

from tests.py.test_isolated_postgres_live import watcher_repair_inventory
from tests.e2e.support import isolatedPostgres


def prepare(fixture):
    from music_app.services.relation_projection_postgres import ensure_relation_projection_ready
    from music_app.services.gallery_projection_postgres import ensure_gallery_projection_ready
    ensure_relation_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    return ensure_gallery_projection_ready(fixture.config, connect=isolatedPostgres._connect)


def test_gallery_summary_builds_exact_page_and_invalidates_old_writer(watcher_repair_inventory):
    from music_app.services.gallery_projection_postgres import (
        ensure_gallery_projection_ready, load_gallery_projection_page,
    )
    from music_app.services import library_browse_postgres as browse

    fixture = watcher_repair_inventory
    entries = [fixture.entry("Owner/First/one.flac", album="First"),
               fixture.entry("Owner/Second/two.flac", album="Second", artist="Owner feat. Guest")]
    fixture.seed(*entries)
    result = prepare(fixture)
    assert result["built"] > 0
    state = browse._root_sidebar_view_state({})
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        connection.execute("set transaction isolation level repeatable read, read only")
        page = load_gallery_projection_page(connection, state, {"gallery_page_size": "1"})
        assert page is not None
        assert page[2] == 2
        assert len(page[0]) == 1
        assert page[3]["has_more"] is True
    # Emulate an older writer: it knows no gallery service or revision API.
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("update library.local_albums set title = title || ' changed'")
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        assert load_gallery_projection_page(connection, state, {"gallery_page_size": "1"}) is None


def test_gallery_summary_cover_only_change_and_rollback_keep_revision(watcher_repair_inventory):
    from music_app.services.gallery_projection_postgres import (
        ensure_gallery_projection_ready, load_gallery_projection_page,
    )
    from music_app.services import library_browse_postgres as browse
    fixture = watcher_repair_inventory
    fixture.seed(fixture.entry("Owner/Album/one.flac"))
    prepare(fixture)
    state = browse._root_sidebar_view_state({})
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        before = load_gallery_projection_page(connection, state, {"gallery_page_size": "1"})
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""update library.local_track_files set metadata =
            jsonb_set(metadata, '{scan_cache,file_entry,cover_preview}', '"derived-preview"'::jsonb)
        """)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("update library.local_albums set title = 'rolled back'")
        connection.rollback()
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        after = load_gallery_projection_page(connection, state, {"gallery_page_size": "1"})
    assert after is not None
    assert after[3]["revision"] == before[3]["revision"]


def test_gallery_summary_all_scopes_preserve_pages_and_cross_path_cursors(watcher_repair_inventory):
    from music_app.services import library_browse_postgres as browse
    from music_app.services import gallery_projection_postgres as projection
    fixture = watcher_repair_inventory
    entries = [fixture.entry(f"Owner/Album {i}/track.flac", album=f"Album {i}", root=i % 2)
               for i in range(60)]
    entries += [fixture.entry("Guest/Shared/track.flac", album="Shared", artist="Owner feat. Guest")]
    start = perf_counter()
    fixture.seed(*entries)
    seed_seconds = perf_counter() - start
    prepare(fixture)
    repository = browse.PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    scopes = [{"gallery_scope": "new_arrivals"}]
    for count in range(1, 4):
        for categories in combinations(("main_library", "new_arrivals", "hoard"), count):
            scopes.extend({"category": list(order)} for order in permutations(categories))
    for params in scopes:
        state = browse._root_sidebar_view_state(params)
        if "category" in params:
            assert state["visible_library_categories"] == params["category"]
        with isolatedPostgres._connect(fixture.runtime_url) as connection:
            connection.execute("set transaction isolation level repeatable read, read only")
            context = projection.gallery_projection_context(connection)
            aliases = repository._load_relation_alias_maps(connection=connection)
            rows = connection.execute(browse._root_gallery_membership_sql(), browse._root_sidebar_params(state)).fetchall()
            missing = browse._missing_album_projection_payloads(repository._load_missing_album_rows(connection=connection), view_state=state)
            snapshot = browse._prepare_root_gallery_snapshot(rows, missing, browse._root_browse_alias_to_canonical(aliases["alias_to_canonical"]), state)
        assert projection.publish_gallery_projection(fixture.config, context, state, snapshot, connect=isolatedPostgres._connect)
        for size in (8, 50):
            page_params = {"gallery_page_size": str(size)}
            while True:
                expected = browse._select_root_gallery_snapshot_page(snapshot, page_params)
                with isolatedPostgres._connect(fixture.runtime_url) as connection:
                    connection.execute("set transaction isolation level repeatable read, read only")
                    actual = projection.load_gallery_projection_page(connection, state, page_params)
                assert actual == expected
                if not actual[3]["next_cursor"]:
                    break
                # A persisted-page cursor is consumed by the unchanged selector and vice versa.
                page_params["gallery_cursor"] = actual[3]["next_cursor"]
    print(f"gallery seed {len(entries)} entries: {seed_seconds:.3f}s")


def test_ready_missing_album_page_hydrates_current_bounded_details(watcher_repair_inventory, monkeypatch):
    from music_app.services import library_browse_postgres as browse
    from music_app.services import gallery_projection_postgres as projection
    fixture = watcher_repair_inventory
    fixture.seed(*(fixture.entry(f"Owner/Lost {i}/track.flac", album=f"Lost {i}") for i in range(12)))
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("update library.local_track_files set metadata = jsonb_set(metadata, '{scan_cache,stale}', 'true'::jsonb)")
    prepare(fixture)
    repository = browse.PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    keys = []
    original = repository._load_missing_album_rows
    def bounded(*args, **kwargs):
        assert kwargs.get("album_keys") and len(kwargs["album_keys"]) == 8
        keys.extend(kwargs["album_keys"])
        return original(*args, **kwargs)
    monkeypatch.setattr(repository, "_load_missing_album_rows", bounded)
    monkeypatch.setattr(browse, "_queue_display_cover_variants_for_groups", lambda *args: None)
    payload = repository.build_root_startup_preview_payload(query_params={"gallery_page_size": "8"})
    assert payload["album_count"] == 12
    assert len(keys) == len(set(keys)) == 8
    assert sum(len(group["albums"]) for group in payload["artist_groups"]) == 8
