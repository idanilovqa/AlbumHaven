"""Transaction, scope and privilege proof on the existing disposable PG fixture."""
from concurrent.futures import ThreadPoolExecutor
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
    result = gallery.ensure_gallery_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    assert result["built"] > 0
    fixture.first = first
    fixture.second = second
    fixture.view_state = browse._root_sidebar_view_state({})
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        fixture.context = gallery.gallery_projection_context(connection)
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


def test_lowest_id_track_override_fallback_and_file_delete_invalidate(gallery_inventory):
    fixture = gallery_inventory
    repository = browse.PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    with isolatedPostgres._connect(fixture.setup_url) as writer:
        writer.execute("delete from library.exception_overrides")
        writer.execute("update library.local_track_files set metadata="
                       "jsonb_set(metadata,'{scan_cache,stale}','true'::jsonb) where private_path=%s",
                       (fixture.first["path"],))
        for key, value in (("proof-low", "non-album rarity"), ("proof-high", None)):
            writer.execute("""insert into library.exception_overrides(library_id,track_id,track_key,override_payload)
                select library_id,id,%s,%s from library.local_tracks where track_key=%s""",
                (key, Jsonb({"exception_type": value}), fixture.first["path"]))
    assert fixture.first_album_key not in {row["album_key"] for row in repository._load_missing_album_rows()}
    with isolatedPostgres._connect(fixture.setup_url) as writer:
        before = generation(writer, fixture.context["library_id"])
        writer.execute("delete from library.exception_overrides where track_key='proof-low'")
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


def test_repeatable_read_observer_sees_complete_old_then_new_publication(gallery_inventory):
    fixture = gallery_inventory
    with isolatedPostgres._connect(fixture.runtime_url) as reader:
        reader.execute("set transaction isolation level repeatable read, read only")
        old = gallery.load_gallery_projection_page(reader, fixture.view_state, {})
        with isolatedPostgres._connect(fixture.runtime_url) as publisher:
            assert publish(publisher, fixture.context, fixture.view_state,
                           rows=[{"album_key": "proof", "album_title": "Proof"}],
                           sidebar=[{"artist": "Proof", "artist_display": "Proof", "count": 1}])
        assert gallery.load_gallery_projection_page(reader, fixture.view_state, {}) == old
    with isolatedPostgres._connect(fixture.runtime_url) as reader:
        new = gallery.load_gallery_projection_page(reader, fixture.view_state, {})
        assert new[0] == [{"album_key": "proof", "album_title": "Proof"}]
        assert new[1] == [{"artist": "Proof", "artist_display": "Proof", "count": 1}]
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
        "album_id": 42,
        "album_key": "featured-proof",
        "album_title": "Featured Proof",
        "album_release_year": 2000,
        "featured_kind": "featured_track_artist",
    }

    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        assert publish(
            connection,
            fixture.context,
            fixture.view_state,
            rows=[occurrence],
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
    added = fixture.entry("New Artist/Third/three.flac", artist="New Artist", album="Third")
    fixture.seed(fixture.first, fixture.second, added)
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
    repository.build_root_startup_preview_payload()
    assert len(refreshes) == 1, "Stale root browse did not schedule recovery"
    assert refreshes[0] is not None
    if fail_first:
        with pytest.raises(RuntimeError, match="temporary relation repair failure"):
            refreshes[0].result(timeout=10)
        with isolatedPostgres._connect(fixture.runtime_url) as connection:
            assert gallery.load_gallery_projection_page(connection, fixture.view_state, {}) is None
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
        repository.build_root_startup_preview_payload()
        assert len(refreshes) == 2
    assert refreshes[-1].result(timeout=10)["built"] > 0
    assert len(attempts) == (2 if fail_first else 1)
    assert not repository._load_relation_alias_maps().get("projection_stale_reason")
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        assert gallery.load_gallery_projection_page(connection, fixture.view_state, {}) is not None


def test_relation_refresh_and_targeted_publication_use_consistent_lock_order(gallery_inventory, monkeypatch):
    from threading import Event
    from music_app.services import relation_projection_postgres as relations
    from music_app.services import scan_cache_persistence as persistence

    fixture = gallery_inventory
    added = fixture.entry("Added/Third/three.flac", artist="Added", album="Third")
    fixture.seed(fixture.first, fixture.second, added)
    concurrent = fixture.entry("Concurrent/Fourth/four.flac", artist="Concurrent", album="Fourth")
    built, publish, revision_locked = Event(), Event(), Event()
    release_target, target_family_attempt = Event(), Event()
    build_views = relations.build_relation_views_from_postgres_rows
    replace_families = relations.replace_artist_family_projection_in_transaction

    def pause_built_sources(*args, **kwargs):
        result = build_views(*args, **kwargs)
        built.set()
        assert publish.wait(10)
        return result

    def coordinate_family_publication(*args, **kwargs):
        result = replace_families(*args, **kwargs)
        release_target.set()
        assert target_family_attempt.wait(10)
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
            if not self.targeted and statement == persistence._inventory_publication_advisory_lock_sql():
                # The fixed publisher waits behind the inventory owner instead of
                # taking family rows that the owner still needs to replace.
                release_target.set()
            if self.targeted and "insert into library.local_artist_family_links" in statement.lower():
                target_family_attempt.set()
            result = self.connection.execute(query, params)
            if self.targeted and statement == persistence._increment_inventory_mutation_revision_sql():
                revision_locked.set()
                assert release_target.wait(10)
            return result

    def connect(database_url, *, targeted):
        connection = isolatedPostgres._connect(database_url)
        connection.execute("set statement_timeout = '5s'")
        return Connection(connection, targeted=targeted)

    monkeypatch.setattr(relations, "build_relation_views_from_postgres_rows", pause_built_sources)
    monkeypatch.setattr(relations, "replace_artist_family_projection_in_transaction", coordinate_family_publication)
    adapter = persistence.PostgresScanCacheAdapter(
        fixture.config, connect=lambda url: connect(url, targeted=True),
    )
    with ThreadPoolExecutor(max_workers=2) as executor:
        refresh = executor.submit(
            relations.ensure_relation_projection_ready, fixture.config,
            connect=lambda url: connect(url, targeted=False),
        )
        try:
            assert built.wait(10)
            mutation = executor.submit(
                adapter.persist_targeted_inventory_mutation,
                root_id=fixture.roots[0]["id"],
                active_file_entries={concurrent["path"]: concurrent},
            )
            assert revision_locked.wait(10)
            publish.set()
            mutation.result(timeout=15)
            refresh.result(timeout=15)
        finally:
            publish.set()
            release_target.set()
            target_family_attempt.set()
    repository = browse.PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)
    aliases = repository._load_relation_alias_maps()
    assert not aliases["projection_stale_reason"]
    assert "Concurrent" in aliases["alias_to_canonical"]


def test_targeted_publication_coexists_with_legacy_relation_only_publisher(gallery_inventory, monkeypatch):
    from threading import Event
    from music_app.services import relation_projection_postgres as relations
    from music_app.services import scan_cache_persistence as persistence

    fixture = gallery_inventory
    added = fixture.entry("Added/Third/three.flac", artist="Added", album="Third")
    fixture.seed(fixture.first, fixture.second, added)
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

    monkeypatch.setattr(relations, "replace_artist_family_projection_in_transaction", pause_legacy_publisher)
    adapter = persistence.PostgresScanCacheAdapter(
        fixture.config, connect=lambda url: connect(url, targeted=True),
    )
    with ThreadPoolExecutor(max_workers=2) as executor:
        refresh = executor.submit(
            relations.ensure_relation_projection_ready, fixture.config,
            connect=lambda url: connect(url, targeted=False),
        )
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
    aliases = browse.PostgresLibraryBrowseRepository(
        fixture.config, connect=isolatedPostgres._connect,
    )._load_relation_alias_maps()
    assert not aliases["projection_stale_reason"]
    assert "Concurrent" in aliases["alias_to_canonical"]
