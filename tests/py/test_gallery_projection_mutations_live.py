"""Transaction, scope and privilege proof on the existing disposable PG fixture."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from threading import Event
from time import monotonic, sleep

import psycopg
import pytest
from psycopg.types.json import Jsonb

from music_app.services import gallery_projection_postgres as gallery
from music_app.services import library_browse_postgres as browse
from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory


@pytest.fixture
def gallery_inventory(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    first = fixture.entry("Owner/First/one.flac", album="First")
    second = fixture.entry("Owner/Second/two.flac", album="Second", artist="Owner feat. Guest")
    fixture.seed(first, second)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        fixture.first_album_key = connection.execute("""
            select albums.album_key from library.local_albums albums
            join library.local_tracks tracks on tracks.album_id=albums.id
            join library.local_track_files files on files.track_id=tracks.id
            where files.private_path=%s
        """, (first["path"],)).fetchone()["album_key"]
        connection.execute("""
            insert into library.exception_overrides(library_id, track_key, override_payload)
            select library_id, %s, '{}'::jsonb from library.local_tracks limit 1
        """, (first["path"],))
    from music_app.services.relation_projection_postgres import ensure_relation_projection_ready
    ensure_relation_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    # Setup needs the published state, not who built it: since c72277e26 the seed's startup baseline already
    # publishes both root scopes, so this call may build nothing.
    gallery.ensure_gallery_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    fixture.first = first
    fixture.second = second
    fixture.view_state = browse._root_sidebar_view_state({})
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        fixture.context = gallery.gallery_projection_context(connection)
        for params in ({}, {"gallery_scope": "new_arrivals"}):
            assert gallery._ready_header(connection, fixture.context, browse._root_sidebar_view_state(params)), (
                f"root scope {params or 'all'} has a ready header"
            )
        assert gallery.load_gallery_projection_page(connection, fixture.view_state, {}) is not None
    return fixture


def generation(connection, library_id):
    return connection.execute(
        "select generation from library.gallery_projection_state where library_id=%s", (library_id,)
    ).fetchone()["generation"]


def publish(connection, context, state, *, revision="a" * 64, rows=None, sidebar=None):
    return connection.execute("""
        select library.replace_gallery_projection(%s,%s,%s,%s,%s,%s,%s,%s) as published
    """, (
        context["library_id"], gallery.gallery_projection_scope_key(state), context["generation"],
        gallery.BUILDER_VERSION, revision, Jsonb(sidebar or []), len(rows or []), Jsonb(rows or []),
    )).fetchone()["published"]


MUTATIONS = (
    ("albums", "update library.local_albums set title=title || ' changed'"),
    ("artists", "update library.local_artists set sort_name=sort_name || ' changed'"),
    ("featured", "update library.local_album_featured_artists set metadata="
     "jsonb_set(metadata,'{relation_evidence_kind}','\"gallery-proof\"'::jsonb)"),
    ("tracks", "update library.local_tracks set album_id=null"),
    ("files", "update library.local_track_files set metadata="
     "jsonb_set(metadata,'{scan_cache,stale}',to_jsonb(not scan_cache_stale))"),
    ("exceptions", "update library.exception_overrides set override_payload="
     "'{\"exception_type\":null}'::jsonb"),
    ("roots", "update library.library_roots set is_active=not is_active"),
    ("libraries", "update library.libraries set name=name || ' changed'"),
)


def test_all_eight_source_updates_invalidate_in_transaction_and_rollback(gallery_inventory):
    fixture = gallery_inventory
    library_id = fixture.context["library_id"]
    for name, sql in MUTATIONS:
        with isolatedPostgres._connect(fixture.setup_url) as writer:
            before = generation(writer, library_id)
            assert writer.execute(sql).rowcount > 0, name
            assert generation(writer, library_id) == before + 1, name
            assert gallery.load_gallery_projection_page(writer, fixture.view_state, {}) is None, name
            with isolatedPostgres._connect(fixture.runtime_url) as reader:
                assert generation(reader, library_id) == before, name
                assert gallery.load_gallery_projection_page(reader, fixture.view_state, {}) is not None, name
            writer.rollback()
            assert generation(writer, library_id) == before, name
            assert gallery.load_gallery_projection_page(writer, fixture.view_state, {}) is not None, name


def test_committed_source_changes_advance_generation_even_when_already_stale(gallery_inventory):
    fixture = gallery_inventory
    library_id = fixture.context["library_id"]
    for name, sql in MUTATIONS:
        with isolatedPostgres._connect(fixture.setup_url) as writer:
            before = generation(writer, library_id)
            assert writer.execute(sql).rowcount > 0, name
        with isolatedPostgres._connect(fixture.runtime_url) as reader:
            assert generation(reader, library_id) == before + 1, name
            assert gallery.load_gallery_projection_page(reader, fixture.view_state, {}) is None, name


def test_bulk_and_repeated_statements_coalesce_but_savepoint_rollback_restores_state(gallery_inventory):
    fixture = gallery_inventory
    library_id = fixture.context["library_id"]
    with isolatedPostgres._connect(fixture.setup_url) as writer:
        before = generation(writer, library_id)
        writer.execute("savepoint before_mutation")
        writer.execute("update library.local_albums set title=title || ' changed'")
        writer.execute("update library.local_artists set sort_name=sort_name || ' changed'")
        assert generation(writer, library_id) == before + 1
        writer.execute("rollback to savepoint before_mutation")
        assert generation(writer, library_id) == before
        assert gallery.load_gallery_projection_page(writer, fixture.view_state, {}) is not None
        writer.execute("update library.local_albums set title=title || ' committed'")
        writer.execute("update library.local_albums set title=title || ' twice'")
        assert generation(writer, library_id) == before + 1
    with isolatedPostgres._connect(fixture.runtime_url) as reader:
        assert generation(reader, library_id) == before + 1
        assert gallery.load_gallery_projection_page(reader, fixture.view_state, {}) is None


def test_same_transaction_source_publication_is_rejected(gallery_inventory):
    fixture = gallery_inventory
    with isolatedPostgres._connect(fixture.setup_url) as writer:
        writer.execute("update library.local_albums set title=title || ' first'")
        context = gallery.gallery_projection_context(writer)
        writer.execute("update library.local_albums set title=title || ' second'")
        assert gallery.gallery_projection_context(writer) == context
        assert publish(writer, context, fixture.view_state) is False
        assert gallery.load_gallery_projection_page(writer, fixture.view_state, {}) is None
        writer.rollback()
    with isolatedPostgres._connect(fixture.runtime_url) as publisher:
        assert publish(publisher, fixture.context, fixture.view_state) is True


def test_override_missing_key_and_explicit_null_change_effective_missing_membership(gallery_inventory):
    fixture = gallery_inventory
    repository = browse.PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    with isolatedPostgres._connect(fixture.setup_url) as writer:
        writer.execute("""update library.local_track_files set
            metadata=jsonb_set(jsonb_set(metadata,'{scan_cache,stale}','true'::jsonb),
                '{scan_cache,file_entry,exception_type}','\"non-album rarity\"'::jsonb)
            where private_path=%s""", (fixture.first["path"],))
    # A path override without the key falls back to the file's rarity exclusion.
    assert fixture.first_album_key not in {row["album_key"] for row in repository._load_missing_album_rows()}
    with isolatedPostgres._connect(fixture.setup_url) as writer:
        before = generation(writer, fixture.context["library_id"])
        writer.execute("update library.exception_overrides set override_payload='{}'::jsonb")
        assert generation(writer, fixture.context["library_id"]) == before
        writer.execute("update library.exception_overrides set override_payload='{\"exception_type\":null}'::jsonb")
        assert generation(writer, fixture.context["library_id"]) == before + 1
    assert fixture.first_album_key in {row["album_key"] for row in repository._load_missing_album_rows()}
    with isolatedPostgres._connect(fixture.setup_url) as writer:
        before = generation(writer, fixture.context["library_id"])
        writer.execute("delete from library.exception_overrides")
        assert generation(writer, fixture.context["library_id"]) == before + 1
    assert fixture.first_album_key not in {row["album_key"] for row in repository._load_missing_album_rows()}


def test_newest_track_override_wins_and_file_delete_invalidates(gallery_inventory):
    """eea310882: of two track overrides (no path override), the newest decides, as in the loader."""
    fixture = gallery_inventory
    repository = browse.PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    with isolatedPostgres._connect(fixture.setup_url) as writer:
        writer.execute("delete from library.exception_overrides")
        writer.execute("update library.local_track_files set metadata="
                       "jsonb_set(metadata,'{scan_cache,stale}','true'::jsonb) where private_path=%s",
                       (fixture.first["path"],))
        for key, value in (("proof-older", None), ("proof-newer", "non-album rarity")):
            writer.execute("""insert into library.exception_overrides(library_id,track_id,track_key,override_payload)
                select library_id,id,%s,%s from library.local_tracks where track_key=%s""",
                (key, Jsonb({"exception_type": value}), fixture.first["path"]))
    # The newer rarity override excludes the album from missing albums.
    assert fixture.first_album_key not in {row["album_key"] for row in repository._load_missing_album_rows()}
    with isolatedPostgres._connect(fixture.setup_url) as writer:
        before = generation(writer, fixture.context["library_id"])
        writer.execute("delete from library.exception_overrides where track_key='proof-newer'")
        assert generation(writer, fixture.context["library_id"]) == before + 1
    assert fixture.first_album_key in {row["album_key"] for row in repository._load_missing_album_rows()}
    with isolatedPostgres._connect(fixture.setup_url) as writer:
        before = generation(writer, fixture.context["library_id"])
        writer.execute("delete from library.local_track_files where private_path=%s", (fixture.first["path"],))
        assert generation(writer, fixture.context["library_id"]) == before + 1


def test_obsolete_builder_waits_for_writer_then_refuses_publication(gallery_inventory):
    fixture = gallery_inventory
    entered = Event()
    backend_pid = []

    def attempt():
        with isolatedPostgres._connect(fixture.runtime_url) as publisher:
            publisher.execute("set local statement_timeout='10s'")
            backend_pid.append(publisher.info.backend_pid)
            entered.set()
            return publish(publisher, fixture.context, fixture.view_state)

    with isolatedPostgres._connect(fixture.setup_url) as writer:
        writer.execute("update library.local_albums set title=title || ' concurrent'")
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(attempt)
            try:
                assert entered.wait(5), "publisher did not connect"
                deadline = monotonic() + 5
                with isolatedPostgres._connect(fixture.runtime_url) as observer:
                    while monotonic() < deadline:
                        waiting = observer.execute(
                            "select wait_event_type from pg_stat_activity where pid=%s", (backend_pid[0],)
                        ).fetchone()
                        if waiting and waiting["wait_event_type"] == "Lock":
                            break
                        observer.commit()
                        sleep(0.02)
                    else:
                        pytest.fail("publisher did not wait for the source transaction")
                assert not future.done()
                writer.commit()
                assert future.result(timeout=10) is False
            finally:
                writer.rollback()
    with isolatedPostgres._connect(fixture.runtime_url) as reader:
        assert gallery.load_gallery_projection_page(reader, fixture.view_state, {}) is None


def test_gallery_staging_does_not_hold_inventory_publication_lock(gallery_inventory):
    from music_app.services import scan_cache_persistence as persistence

    fixture = gallery_inventory
    revision = "b" * 64
    scope_key = gallery.gallery_projection_scope_key(fixture.view_state)
    publisher_pid = []
    connected = Event()

    with isolatedPostgres._connect(fixture.setup_url) as blocker:
        blocker.execute(
            """
            insert into library.gallery_projection_occurrences(
              library_id, scope_key, revision, ordinal, payload
            ) values (%s, %s, %s, 0, %s)
            """,
            (
                fixture.context["library_id"],
                scope_key,
                revision,
                Jsonb({"album_key": "blocked", "album_title": "Blocked"}),
            ),
        )
        blocker.execute(
            """
            select 1
            from library.gallery_projection_occurrences
            where library_id=%s and scope_key=%s and revision=%s and ordinal=0
            for update
            """,
            (fixture.context["library_id"], scope_key, revision),
        )

        def attempt_publication():
            with isolatedPostgres._connect(fixture.runtime_url) as publisher:
                publisher.execute("set local statement_timeout='10s'")
                publisher_pid.append(publisher.info.backend_pid)
                connected.set()
                return publish(
                    publisher,
                    fixture.context,
                    fixture.view_state,
                    revision=revision,
                    rows=[{"album_key": "proof", "album_title": "Proof"}],
                )

        with ThreadPoolExecutor(max_workers=1) as executor:
            publication = executor.submit(attempt_publication)
            try:
                assert connected.wait(5), "publisher did not connect"
                deadline = monotonic() + 5
                with isolatedPostgres._connect(fixture.runtime_url) as observer:
                    while monotonic() < deadline:
                        waiting = observer.execute(
                            "select wait_event_type from pg_stat_activity where pid=%s",
                            (publisher_pid[0],),
                        ).fetchone()
                        if waiting and waiting["wait_event_type"] == "Lock":
                            break
                        observer.commit()
                        sleep(0.02)
                    else:
                        pytest.fail("publisher did not pause while staging occurrences")

                with isolatedPostgres._connect(fixture.runtime_url) as mutation:
                    mutation.execute("set local statement_timeout='1s'")
                    mutation.execute(persistence._inventory_publication_advisory_lock_sql())
                    mutation.execute(
                        "update library.local_albums set title=title || ' foreground'"
                    )

                assert not publication.done()
            finally:
                blocker.rollback()

            assert publication.result(timeout=10) is False


def test_gallery_cleanup_removes_only_expired_inactive_revisions(gallery_inventory):
    fixture = gallery_inventory
    scope_key = gallery.gallery_projection_scope_key(fixture.view_state)
    expired_revision = "c" * 64
    fresh_revision = "d" * 64
    next_revision = "e" * 64

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        ready_revision = connection.execute(
            """
            select revision
            from library.gallery_projection_snapshots
            where library_id=%s and scope_key=%s
            """,
            (fixture.context["library_id"], scope_key),
        ).fetchone()["revision"]
        connection.execute(
            """
            delete from library.gallery_projection_snapshots
            where library_id=%s and scope_key=%s
            """,
            (fixture.context["library_id"], scope_key),
        )
        connection.execute(
            """
            insert into library.gallery_projection_occurrences(
              library_id, scope_key, revision, ordinal, payload, staged_at
            ) values
              (%s, %s, %s, 0, %s, clock_timestamp() - interval '6 minutes'),
              (%s, %s, %s, 0, %s, clock_timestamp())
            """,
            (
                fixture.context["library_id"],
                scope_key,
                expired_revision,
                Jsonb({"album_key": "expired", "album_title": "Expired"}),
                fixture.context["library_id"],
                scope_key,
                fresh_revision,
                Jsonb({"album_key": "fresh", "album_title": "Fresh"}),
            ),
        )

    with isolatedPostgres._connect(fixture.runtime_url) as publisher:
        assert publish(
            publisher,
            fixture.context,
            fixture.view_state,
            revision=next_revision,
            rows=[{"album_key": "next", "album_title": "Next"}],
        )

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        revisions = {
            row["revision"]
            for row in connection.execute(
                """
                select distinct revision
                from library.gallery_projection_occurrences
                where library_id=%s and scope_key=%s
                """,
                (fixture.context["library_id"], scope_key),
            ).fetchall()
        }

    assert expired_revision not in revisions
    assert {ready_revision, fresh_revision, next_revision} <= revisions


def test_repeatable_read_observer_sees_complete_old_then_new_publication(gallery_inventory):
    fixture = gallery_inventory
    occurrence = {
        "artist_id": "proof-id", "artist_name": "Proof", "artist_sort_name": "proof",
        "album_id": 42, "album_key": "proof", "album_title": "Proof",
    }
    sidebar = [{"artist": "Proof", "artist_display": "Proof", "count": 1}]
    with isolatedPostgres._connect(fixture.runtime_url) as reader:
        reader.execute("set transaction isolation level repeatable read, read only")
        old = gallery.load_gallery_projection_page(reader, fixture.view_state, {})
        with isolatedPostgres._connect(fixture.runtime_url) as publisher:
            assert gallery._publish_gallery_projection_on_connection(
                publisher, fixture.context, fixture.view_state,
                {"revision": "a" * 64, "ordered": [occurrence], "sidebar": sidebar, "album_count": 1},
            )
        assert gallery.load_gallery_projection_page(reader, fixture.view_state, {}) == old
    with isolatedPostgres._connect(fixture.runtime_url) as reader:
        new = gallery.load_gallery_projection_page(reader, fixture.view_state, {})
        assert new[0] == [occurrence]
        assert new[1] == sidebar
        assert new[2] == 1
        assert new[3]["revision"] == "a" * 64


def test_gallery_grants_allow_reads_but_only_bounded_publisher_writes(gallery_inventory):
    fixture = gallery_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        for table in ("state", "snapshots", "occurrences"):
            relation = "library.gallery_projection_" + table
            privileges = connection.execute("""select
                has_table_privilege('album_haven_readonly',%s,'SELECT') as read,
                has_table_privilege('album_haven_app',%s,'SELECT') as app_read,
                has_table_privilege('album_haven_app',%s,'INSERT,UPDATE,DELETE,TRUNCATE') as app_write,
                has_table_privilege('album_haven_readonly',%s,'INSERT,UPDATE,DELETE,TRUNCATE') as readonly_write
            """, (relation, relation, relation, relation)).fetchone()
            assert privileges == {"read": True, "app_read": True, "app_write": False, "readonly_write": False}
        function = "library.replace_gallery_projection(bigint,text,bigint,text,text,jsonb,bigint,jsonb)"
        assert connection.execute(
            "select has_function_privilege('album_haven_readonly',%s,'EXECUTE') as allowed", (function,)
        ).fetchone()["allowed"] is False
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        connection.execute("set transaction read only")
        assert gallery.load_gallery_projection_page(connection, fixture.view_state, {}) is not None
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            publish(connection, fixture.context, fixture.view_state)
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            connection.execute("update library.gallery_projection_state set generation=generation+1")


def test_other_library_is_not_published_or_selected_by_cursor(gallery_inventory):
    fixture = gallery_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        other_id = connection.execute("""insert into library.libraries(owner_account_id,name,library_kind)
            select owner_account_id,'Other Library','local' from library.libraries where id=%s returning id""",
            (fixture.context["library_id"],)).fetchone()["id"]
        other_generation = generation(connection, other_id)
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        with pytest.raises(psycopg.errors.RaiseException, match="outside the bootstrap scope"):
            publish(connection, {"library_id": other_id, "generation": other_generation}, fixture.view_state)
        connection.rollback()
        assert gallery.gallery_projection_context(connection) == fixture.context
        assert gallery.load_gallery_projection_page(connection, fixture.view_state,
                                                    {"library_id": str(other_id)}) is not None


def test_publisher_accepts_and_round_trips_featured_kind(gallery_inventory):
    fixture = gallery_inventory
    occurrence = {
        "artist_id": "guest-id",
        "artist_name": "Guest",
        "artist_sort_name": "guest",
        "album_id": 42,
        "album_key": "featured-proof",
        "album_title": "Featured Proof",
        "album_release_year": 2000,
        "featured_kind": "featured_track_artist",
    }

    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        assert gallery._publish_gallery_projection_on_connection(
            connection,
            fixture.context,
            fixture.view_state,
            {"revision": "a" * 64, "ordered": [occurrence],
             "sidebar": [{"artist": "Guest", "artist_display": "Guest", "count": 1}],
             "album_count": 1},
        ) is True

    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        page = gallery.load_gallery_projection_page(connection, fixture.view_state, {})

    assert page is not None
    assert page[0] == [occurrence]


@pytest.mark.parametrize("field", ["private_path", "metadata", "rating", "cover"])
def test_publisher_rejects_private_payload_and_preserves_ready_snapshot(gallery_inventory, field):
    fixture = gallery_inventory
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        old = gallery.load_gallery_projection_page(connection, fixture.view_state, {})
        with pytest.raises(psycopg.errors.RaiseException, match="unsupported fields"):
            publish(connection, fixture.context, fixture.view_state,
                    rows=[{"album_key": "proof", field: "private-proof"}])
        connection.rollback()
        assert gallery.load_gallery_projection_page(connection, fixture.view_state, {}) == old


@pytest.mark.parametrize("fail_first", [False, True])
def test_native_scan_invalidation_recovers_root_snapshot_publication(gallery_inventory, monkeypatch, fail_first):
    fixture = gallery_inventory
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        before = gallery.load_gallery_projection_page(connection, fixture.view_state, {})
    assert before is not None
    added = fixture.entry("New Artist/Third/three.flac", artist="New Artist", album="Third")
    # A native scan's publication without the startup baseline (c72277e26), which would repair it at once.
    fixture.seed(fixture.first, fixture.second, added, startup_baseline=False)
    repository = browse.PostgresLibraryBrowseRepository(
        fixture.config, connect=isolatedPostgres._connect,
    )
    assert repository._load_relation_alias_maps().get("projection_stale_reason")
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        assert gallery.load_gallery_projection_page(connection, fixture.view_state, {}) is None

    from music_app.services import relation_projection_postgres as relations
    from time import monotonic, sleep

    ensure_relations = relations.ensure_relation_projection_ready
    attempts = []

    def repair(*args, **kwargs):
        attempts.append(True)
        if fail_first and len(attempts) == 1:
            raise RuntimeError("temporary relation repair failure")
        return ensure_relations(*args, **kwargs)

    monkeypatch.setattr(relations, "ensure_relation_projection_ready", repair)
    refreshes = []
    schedule_refresh = gallery.schedule_gallery_projection_refresh

    def record_refresh(*args, **kwargs):
        future = schedule_refresh(*args, **kwargs)
        refreshes.append(future)
        return future

    monkeypatch.setattr(gallery, "schedule_gallery_projection_refresh", record_refresh)
    # 6.5 (option 1): browsing the stale gallery schedules nothing; the scan's own publication owns recovery.
    repository.build_root_startup_preview_payload()
    assert refreshes == [], "a browse request never schedules the gallery refresh"

    def scan_publication_owner():
        # As cache.py does after a scan's snapshot is saved.
        gallery.schedule_gallery_projection_refresh(fixture.config, connect=isolatedPostgres._connect)

    scan_publication_owner()
    assert len(refreshes) == 1
    assert refreshes[0] is not None
    if fail_first:
        with pytest.raises(RuntimeError, match="temporary relation repair failure"):
            refreshes[0].result(timeout=10)
        # Keep last families: the scopes published before the failed relation
        # rebuild, so the watcher-found artist already shows, ungrouped.
        with isolatedPostgres._connect(fixture.runtime_url) as connection:
            page = gallery.load_gallery_projection_page(connection, fixture.view_state, {})
        assert page is not None
        assert "name:new artist" in {row["artist_id"] for row in page[0]}
        assert repository._load_relation_alias_maps().get("projection_stale_reason")
        deadline = monotonic() + 5
        identity = (fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"], "refresh")
        while True:
            with gallery._PENDING_LOCK:
                pending = identity in gallery._PENDING
            if not pending or monotonic() >= deadline:
                break
            sleep(0.01)
        assert not pending, "Failed refresh did not release its single-flight slot"
        # Requests after the failure still schedule nothing; the next source change recovers it once.
        for _request in range(3):
            repository.build_root_startup_preview_payload()
        assert len(refreshes) == 1, "requests after a failed refresh schedule nothing"
        scan_publication_owner()
        assert len(refreshes) == 2
    # Keep last families (431e0375b): while a relation rebuild is pending, the refresh publishes both root
    # scopes with the last families, rebuilds relations, then republishes both once the relation publication
    # moves the source generation, so 2 scopes x 2 publications. (Before 431e0375b relations were rebuilt
    # first and the refresh reused the replayed membership: built 0.) After a failed relation rebuild
    # (fail_first) the failed refresh already published both scopes at this generation, and under option 1
    # no request changes anything in between, so the recovering refresh skips them (ready headers) and
    # publishes only after its relation rebuild: 2. That 2 depends on the pre-pass reusing the headers the failed
    # attempt already published at the current generation; a later change that rebuilds ready headers shows
    # up here as 4.
    # Edits always save (R3/R4): the relation replay now patches each header from its own generation by the
    # journal's albums instead of asking for a full republication. After the relation rebuild the scopes are
    # already current, so the second full publication of both scopes is gone: 2 (the pre-pass) without a
    # failure, and 0 after one, since the failed attempt's pre-pass already published them.
    assert refreshes[-1].result(timeout=10) == {"built": 0 if fail_first else 2}
    assert len(attempts) == (2 if fail_first else 1)
    assert not repository._load_relation_alias_maps().get("projection_stale_reason")
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        page = gallery.load_gallery_projection_page(connection, fixture.view_state, {})
        assert page is not None
        assert {(row["artist_name"], row["album_title"]) for row in page[0]} == {
            ("Owner", "First"), ("Owner", "Second"), ("Guest", "Second"),
            ("Owner", "Third"), ("New Artist", "Third"),
        }
        assert page[2] == 3
        assert page[3]["revision"] != before[3]["revision"]
        context = gallery.gallery_projection_context(connection)
        header = connection.execute(
            "select source_generation from library.gallery_membership_headers where library_id=%s and scope_key=%s",
            (context["library_id"], gallery.gallery_projection_scope_key(fixture.view_state)),
        ).fetchone()
        assert header["source_generation"] == context["generation"]


def test_relation_refresh_and_targeted_publication_use_consistent_lock_order(gallery_inventory):
    from threading import Event
    from music_app.services import relation_projection_postgres as relations
    from music_app.services import scan_cache_persistence as persistence

    fixture = gallery_inventory
    added = fixture.entry("Added/Third/three.flac", artist="Added", album="Third")
    # The relation refresh must have work to do: no startup baseline (c72277e26), which would publish it first.
    fixture.seed(fixture.first, fixture.second, added, startup_baseline=False)
    concurrent = fixture.entry("Concurrent/Fourth/four.flac", artist="Concurrent", album="Fourth")
    refresh_locked, target_attempted = Event(), Event()
    inventory_lock = relations.inventory_publication_advisory_lock_sql()
    relation_lock = relations.relation_projection_advisory_lock_sql()
    lock_order = {False: [], True: []}

    class Connection:
        def __init__(self, connection, *, targeted):
            self.connection = connection
            self.targeted = targeted

        def __enter__(self):
            self.connection.__enter__()
            return self

        def __exit__(self, *args):
            return self.connection.__exit__(*args)

        def __getattr__(self, name):
            return getattr(self.connection, name)

        def execute(self, query, params=None):
            statement = str(query)
            if statement in (inventory_lock, relation_lock):
                lock_order[self.targeted].append(statement)
            if self.targeted and statement == inventory_lock:
                target_attempted.set()
            result = self.connection.execute(query, params)
            if not self.targeted and statement == inventory_lock:
                refresh_locked.set()
                assert target_attempted.wait(10)
            return result

    def connect(database_url, *, targeted):
        connection = isolatedPostgres._connect(database_url)
        connection.execute("set statement_timeout = '5s'")
        return Connection(connection, targeted=targeted)

    adapter = persistence.PostgresScanCacheAdapter(
        fixture.config, connect=lambda url: connect(url, targeted=True),
    )
    with ThreadPoolExecutor(max_workers=2) as executor:
        refresh = executor.submit(
            relations.ensure_relation_projection_ready, fixture.config,
            connect=lambda url: connect(url, targeted=False),
        )
        try:
            assert refresh_locked.wait(10)
            mutation = executor.submit(
                adapter.persist_targeted_inventory_mutation,
                root_id=fixture.roots[0]["id"],
                active_file_entries={concurrent["path"]: concurrent},
            )
            assert target_attempted.wait(10)
            mutation.result(timeout=15)
            refresh.result(timeout=15)
        finally:
            target_attempted.set()
    assert lock_order == {False: [inventory_lock, relation_lock], True: [inventory_lock, relation_lock]}

    repository = browse.PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    aliases = repository._load_relation_alias_maps()
    assert not aliases["projection_stale_reason"]
    assert "Concurrent" in aliases["alias_to_canonical"]
    assert "Added" in aliases["alias_to_canonical"]


def test_targeted_publication_coexists_with_legacy_relation_only_publisher(gallery_inventory, monkeypatch):
    from threading import Event
    from music_app.services import relation_projection_postgres as relations
    from music_app.services import scan_cache_persistence as persistence

    fixture = gallery_inventory
    added = fixture.entry("Added/Third/three.flac", artist="Added", album="Third")
    fixture.seed(fixture.first, fixture.second, added)
    relations.ensure_relation_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    concurrent = fixture.entry("Concurrent/Fourth/four.flac", artist="Concurrent", album="Fourth")
    family_locked, release_publisher = Event(), Event()
    replace_families = relations.replace_artist_family_projection_in_transaction

    def pause_legacy_publisher(*args, **kwargs):
        result = replace_families(*args, **kwargs)
        family_locked.set()
        assert release_publisher.wait(10)
        return result

    class Connection:
        def __init__(self, connection, *, targeted):
            self.connection = connection
            self.targeted = targeted

        def __enter__(self):
            self.connection.__enter__()
            return self

        def __exit__(self, *args):
            return self.connection.__exit__(*args)

        def __getattr__(self, name):
            return getattr(self.connection, name)

        def execute(self, query, params=None):
            statement = str(query)
            if not self.targeted and statement == relations.inventory_publication_advisory_lock_sql():
                # Emulate the old publisher protocol using real SQL everywhere else.
                return self.connection.execute("select 1")
            if self.targeted and statement == relations.relation_projection_advisory_lock_sql():
                # The fixed writer waits before touching metadata or family rows.
                release_publisher.set()
            result = self.connection.execute(query, params)
            if self.targeted and statement == persistence._increment_inventory_mutation_revision_sql():
                # Without the early relation lock, reproduce metadata/family inversion.
                release_publisher.set()
            return result

    def connect(database_url, *, targeted):
        connection = isolatedPostgres._connect(database_url)
        connection.execute("set statement_timeout = '5s'")
        return Connection(connection, targeted=targeted)

    def publish_legacy_relations():
        # An older process owns only the relation lock and publishes only legacy tables.
        with connect(fixture.runtime_url, targeted=False) as connection:
            connection.execute(relations.relation_projection_advisory_lock_sql())
            snapshot = connection.execute(persistence._load_scan_snapshot_sql()).fetchone()["scan_cache"]
            relations.replace_artist_family_projection_in_transaction(
                connection, snapshot["relation_views"],
                relations_last_built=snapshot["relations_last_built"], legacy=True,
            )
            connection.execute(persistence._save_scan_snapshot_sql(), {"scan_cache": Jsonb(snapshot)})

    monkeypatch.setattr(relations, "replace_artist_family_projection_in_transaction", pause_legacy_publisher)
    adapter = persistence.PostgresScanCacheAdapter(
        fixture.config, connect=lambda url: connect(url, targeted=True),
    )
    with ThreadPoolExecutor(max_workers=2) as executor:
        refresh = executor.submit(publish_legacy_relations)
        try:
            assert family_locked.wait(10)
            mutation = executor.submit(
                adapter.persist_targeted_inventory_mutation,
                root_id=fixture.roots[0]["id"],
                active_file_entries={concurrent["path"]: concurrent},
            )
            mutation.result(timeout=15)
            refresh.result(timeout=15)
        finally:
            release_publisher.set()
    # The watcher publication leaves its relations to the queued background refresh.
    relations.ensure_relation_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    aliases = browse.PostgresLibraryBrowseRepository(
        fixture.config, connect=isolatedPostgres._connect,
    )._load_relation_alias_maps()
    assert not aliases["projection_stale_reason"]
    assert "Concurrent" in aliases["alias_to_canonical"]


@pytest.mark.parametrize('sort_name', [None, 'Owner custom sort'])
def test_targeted_inventory_preserves_shared_artist_identity(watcher_repair_inventory, sort_name):
    from music_app.services import relation_projection_postgres as relations
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    fixture = watcher_repair_inventory
    first = fixture.entry('Owner/First/one.flac', artist='Owner', album='First')
    second = fixture.entry('Owner/Second/two.flac', artist='Owner', album='Second')
    fixture.seed(first, second)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(
            'update library.local_artists set sort_name=%s where name=%s',
            (sort_name, 'Owner'),
        )
    relations.ensure_relation_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    gallery.ensure_gallery_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    sibling_fact_sql = """
        select to_jsonb(facts) as record, facts.xmin::text as revision
        from library.local_relation_album_facts facts
        join library.local_albums albums on albums.id=facts.album_id
        join library.local_tracks tracks on tracks.album_id=albums.id
        join library.local_track_files files on files.track_id=tracks.id
        where files.private_path=%s
    """
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        sibling_before = connection.execute(sibling_fact_sql, (second['path'],)).fetchone()
        assert sibling_before is not None
    updated = {**first, 'title': 'Updated track title'}
    adapter = PostgresScanCacheAdapter(fixture.config, connect=isolatedPostgres._connect)
    adapter.persist_targeted_inventory_mutation(
        root_id=fixture.roots[0]['id'], active_file_entries={updated['path']: updated},
    )
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        artist = connection.execute(
            'select name, sort_name from library.local_artists where name=%s', ('Owner',),
        ).fetchone()
        assert dict(artist) == {'name': 'Owner', 'sort_name': sort_name}
        assert connection.execute(sibling_fact_sql, (second['path'],)).fetchone() == sibling_before
        assert connection.execute('select count(*) as count from library.local_relation_dirty_albums').fetchone()['count'] == 0
    added = fixture.entry('New Artist/Third/three.flac', artist='New Artist', album='Third')
    adapter.persist_targeted_inventory_mutation(
        root_id=fixture.roots[0]['id'], active_file_entries={added['path']: added},
    )
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute(
            'select name, sort_name from library.local_artists where name=%s', ('New Artist',),
        ).fetchone() == {'name': 'New Artist', 'sort_name': 'new artist'}


def test_first_anchored_request_after_republish_ignores_stale_statistics(gallery_inventory):
    """A performance bound on #65's own anchored and previous-page path, which reads the membership tables
    (7a7dd5933), after a republish whose statistics predate it.

    Main's failure (CI run 44445861031: 5,332 rows estimated as 1 made its occurrence self-join a 1.6 M-buffer
    nested loop) has no counterpart here: #65's bounds target is a one-row LIMIT 1 subquery on the outer side.
    Measured on #65 with stale statistics at 5.3k entries, every bounds plan read 152-437 buffers with and
    without the materialized target; this test keeps that bound."""
    from music_app.services.utils import artist_collation_key

    fixture = gallery_inventory
    scope_key = gallery.gallery_projection_scope_key(fixture.view_state)
    revision = "f" * 64
    payloads = [{
        "artist_id": f"artist-{index // 4:04d}", "artist_name": f"Artist {index // 4:04d}",
        "album_id": index, "album_key": f"album-{index}", "album_title": f"Album {index:04d}",
        "album_release_year": 2000,
    } for index in range(5332)]
    rows = [{
        "artist_id": payload["artist_id"], "album_key": payload["album_key"],
        "artist_sort": [*artist_collation_key(payload["artist_name"]), *artist_collation_key(payload["artist_name"])],
        "artist_display": payload["artist_name"], "album_year": 2000,
        "album_sort": payload["album_title"].casefold(), "payload": payload,
    } for payload in payloads]
    tables = ("gallery_membership_entries", "gallery_membership_artists")
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        # Statistics are taken while the scope is empty and never refreshed after the republish.
        for table in tables:
            connection.execute(f"delete from library.{table} where library_id = %s and scope_key = %s",
                               (fixture.context["library_id"], scope_key))
            connection.execute(f"alter table library.{table} set (autovacuum_enabled = false)")
            connection.execute(f"analyze library.{table}")
    try:
        state = {key: fixture.view_state.get(key) for key in ("gallery_scope", "visible_library_categories")}
        with isolatedPostgres._connect(fixture.runtime_url) as connection:
            assert connection.execute("""
                select library.patch_gallery_membership(%s, %s, %s, %s, %s, %s, %s, null, %s) as published
            """, (fixture.context["library_id"], scope_key, fixture.context["generation"],
                  fixture.context["generation"], gallery.BUILDER_VERSION, revision, Jsonb(state),
                  Jsonb(rows))).fetchone()["published"]

        class Recording:
            """Records each bounds query the page runs, to explain it afterwards."""

            def __init__(self, connection):
                self.connection, self.bounds = connection, []

            def execute(self, query, params=None):
                if "join library.gallery_membership_artists artist" in str(query):
                    self.bounds.append((str(query), dict(params or {})))
                return self.connection.execute(query, params)

            def __getattr__(self, name):
                return getattr(self.connection, name)

        with isolatedPostgres._connect(fixture.runtime_url) as raw:
            # Both sides of the bounds join still look empty to the planner: the artists table is the outer
            # side whose underestimate lets an inlined target rerun per artist row.
            for table in tables:
                estimate = raw.execute(f"""
                    explain (format json) select 1 from library.{table}
                    where library_id = %s and scope_key = %s
                """, (fixture.context["library_id"], scope_key)).fetchone()["QUERY PLAN"][0]["Plan"]
                assert estimate["Plan Rows"] < 100, f"statistics for {table} must still predate the republish"
            connection = Recording(raw)

            started = monotonic()
            page, _sidebar, count, metadata = gallery.load_gallery_projection_page(
                connection, fixture.view_state, {"gallery_page_size": "60", "gallery_anchor_artist": "Artist 0666"})
            anchored_ms = (monotonic() - started) * 1000
            assert metadata.get("previous_cursor"), "the anchored page has a previous page"
            started = monotonic()
            previous, _sidebar, _count, _metadata = gallery.load_gallery_projection_page(
                connection, fixture.view_state,
                {"gallery_page_size": "60", "gallery_cursor": metadata["previous_cursor"],
                 "gallery_page_direction": "previous"})
            previous_ms = (monotonic() - started) * 1000

            assert {"artist_name", "ordinal"} <= {key for _query, params in connection.bounds
                                                  for key, value in params.items() if value is not None}, (
                "both bounds forms ran: by artist name and by ordinal"
            )
            explained = [raw.execute("explain (analyze, buffers, format json) " + query, params)
                         .fetchone()["QUERY PLAN"][0] for query, params in connection.bounds]
    finally:
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            for table in tables:
                connection.execute(f"alter table library.{table} reset (autovacuum_enabled)")

    assert count == len(rows)
    assert metadata["revision"] == revision
    names = [row["artist_name"] for row in page]
    assert names.count("Artist 0666") == 4, "the requested artist's albums are on the page"
    assert all(names.count(name) == 4 for name in set(names)), "pages hold whole artist groups"
    assert previous and all([row["artist_name"] for row in previous].count(name) == 4
                            for name in {row["artist_name"] for row in previous})
    assert anchored_ms < 1000, f"first anchored gallery request took {anchored_ms:.0f} ms"
    assert previous_ms < 1000, f"previous-page gallery request took {previous_ms:.0f} ms"
    for plan in explained:
        buffers = plan["Plan"]["Shared Hit Blocks"] + plan["Plan"]["Shared Read Blocks"]
        assert buffers < 1000, f"a bounds query read {buffers} buffers: {json.dumps(plan)[:400]}"


def test_a_cover_look_up_save_journals_one_album_and_its_owner_drains_it_alone(gallery_inventory, monkeypatch):
    """6.5 (option a), on real Postgres: a Cover Look Up save journals exactly its album; the owner it queues
    after the commit drains that album alone (affected set 1), with no browse request and no whole-scope
    gallery rebuild, and leaves no dirty row behind."""
    from concurrent.futures import Future

    from music_app.services import cache

    fixture = gallery_inventory
    held = []

    class Executor:
        """Holds the queued owner, so the save is proven to return before it runs."""

        def submit(self, action):
            future = Future()
            held.append((action, future))
            return future

    monkeypatch.setattr(cache, "_CACHE_WRITE_EXECUTOR", Executor())
    monkeypatch.setattr(gallery, "ensure_gallery_projection_ready",
                        lambda *_a, **_k: pytest.fail("a cover save rebuilt the whole gallery scope"))
    track = fixture.first["path"]
    cover = Path(track).parent / "chosen.jpg"
    cover.parent.mkdir(parents=True, exist_ok=True)
    cover.write_bytes(b"\xff\xd8\xff\xe0cover")
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute("select count(*) as rows from library.local_relation_dirty_albums").fetchone()["rows"] == 0
        album_id = connection.execute("""
            select tracks.album_id from library.local_tracks tracks
            join library.local_track_files files on files.track_id=tracks.id where files.private_path=%s
        """, (track,)).fetchone()["album_id"]

    result = cache.persist_cover_selection_for_tracks_for_config(
        fixture.config, {track}, cover, cover_revision="chosen-revision", cover_selection_origin="user",
    )

    assert result["album_rows_updated"] == 1
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        dirty = [row["album_id"] for row in connection.execute(
            "select album_id from library.local_relation_dirty_albums order by album_id").fetchall()]
    assert dirty == [album_id], f"the save journals its album alone, and the save returned before the drain: {dirty}"
    assert len(held) == 1, "one owner queued after the commit"
    action, future = held[0]
    outcome = action()
    future.set_result(outcome)
    assert outcome.get("updated") and not outcome.get("gallery_rebuild_required"), outcome
    assert list(outcome["processed_relation_album_ids"]) == [album_id], "the drain is keyed to that album (affected set 1)"
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute("select count(*) as rows from library.local_relation_dirty_albums").fetchone()["rows"] == 0
