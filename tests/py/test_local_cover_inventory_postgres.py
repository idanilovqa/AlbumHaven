from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import uuid4

from psycopg.types.json import Jsonb
import pytest

from music_app.services.local_cover_inventory import LocalCoverInventoryRepository, context_key, root_key
from tests.e2e.support import isolatedPostgres


@pytest.mark.parametrize("event_kind", ["file", "subtree", "disc"])
def test_unrelated_context_change_preserves_inflight_local_cover_result(event_kind):
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV) or not os.environ.get(isolatedPostgres.RUNTIME_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs are required.")
    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    repository = LocalCoverInventoryRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url, "_library_root_paths_snapshot": (Path("/"),)},
        connect=isolatedPostgres._connect,
    )
    parent = Path(f"/int028-unrelated-{uuid4()}")
    roots = [parent / "album-a", parent / "album-b"]
    paths = [{str(root / "CD1" / "track.mp3")} for root in roots]
    keys = [context_key(value) for value in paths]
    try:
        repository.request_context(paths[0])
        claimed = repository.next_context(keys[0])
        assert claimed["context_key"] == keys[0]
        repository.request_context(paths[1])
        repository.defer_context(keys[1], 1)
        with isolatedPostgres._connect(setup_url) as connection:
            before = connection.execute(
                "select revision,retry_after from library.local_cover_inventory_contexts where context_key=%s", (keys[0],)
            ).fetchone()
        changed = roots[1] / ("CD2" if event_kind == "disc" else "CD1/new.mp3")
        subtrees = [roots[1]] if event_kind == "subtree" else []
        repository.invalidate_paths(
            subtrees or [changed], subtree_paths=subtrees, context_changed=True,
            pending_contexts_below=lambda _folders: keys,
        )
        with isolatedPostgres._connect(setup_url) as connection:
            after = connection.execute(
                "select revision,retry_after from library.local_cover_inventory_contexts where context_key=%s", (keys[0],)
            ).fetchone()
            affected = connection.execute(
                "select revision,retry_after from library.local_cover_inventory_contexts where context_key=%s", (keys[1],)
            ).fetchone()
        assert after == before
        assert affected["revision"] == 2
        assert affected["retry_after"] is None
        repository.publish_context(keys[0], claimed["revision"], roots[0], foreground=True)
        assert repository.root_for_tracks(paths[0]) == Path(root_key(roots[0]))
        repository.publish_context(keys[1], 1, roots[1], foreground=True)
        assert repository.root_for_tracks(paths[1]) is None
    finally:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("delete from library.local_cover_inventory_contexts where context_key=any(%s::text[])", (keys,))
            connection.execute("delete from library.local_cover_inventories where root_path=any(%s::text[])", ([root_key(root) for root in roots],))


def test_parent_subtree_invalidation_preserves_neighbors_and_rejects_inflight_context():
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV) or not os.environ.get(isolatedPostgres.RUNTIME_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs are required.")
    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    repository = LocalCoverInventoryRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url, "_library_root_paths_snapshot": (Path("/"),)},
        connect=isolatedPostgres._connect,
    )
    parent = Path(f"/int028-subtree-{uuid4()}")
    roots = [parent / "album", Path(str(parent) + "-neighbor") / "album", parent / "CD1"]
    path_sets = [{str(root / "track.mp3")} for root in roots]
    unresolved_paths = {str(parent / "new-album" / "track.mp3")}
    keys = [context_key(paths) for paths in [*path_sets, unresolved_paths]]
    try:
        for root, paths in zip(roots, path_sets):
            repository.request_context(paths)
            repository.publish_context(context_key(paths), 1, root, foreground=True)
            assert repository.publish(root, 1, [])
        repository.request_context(unresolved_paths)
        claimed = repository.next_context(context_key(unresolved_paths))
        assert claimed["context_key"] == context_key(unresolved_paths)

        removed_disc = parent / "CD2"
        repository.invalidate_paths([removed_disc], subtree_paths=[removed_disc], context_changed=True)
        assert repository.root_for_tracks(path_sets[2]) is None
        assert repository.root_for_tracks(path_sets[1]) == Path(root_key(roots[1]))

        repository.invalidate_paths(
            [parent], subtree_paths=[parent], context_changed=True, pending_contexts_below=lambda _folders: keys,
        )

        assert repository.get(roots[0])["complete"] is False
        assert repository.get(roots[1])["complete"] is True
        assert repository.root_for_tracks(path_sets[0]) is None
        assert repository.root_for_tracks(path_sets[1]) == Path(root_key(roots[1]))
        repository.publish_context(claimed["context_key"], claimed["revision"], roots[0], foreground=True)
        assert repository.root_for_tracks(unresolved_paths) is None
    finally:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("delete from library.local_cover_inventory_contexts where context_key = any(%s::text[])", (keys,))
            connection.execute("delete from library.local_cover_inventories where root_path = any(%s::text[])", ([root_key(root) for root in roots],))


def test_local_inventory_context_revisions_leases_and_confirmed_empty(monkeypatch):
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV) or not os.environ.get(isolatedPostgres.RUNTIME_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs are required.")
    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    repository = LocalCoverInventoryRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url, "_library_root_paths_snapshot": (Path("/"),)},
        connect=isolatedPostgres._connect,
    )
    root = Path(f"/int028-{uuid4()}")
    paths = {str(root / "first.mp3"), str(root / "second.mp3")}
    try:
        assert repository.root_for_tracks(paths) is None
        repository.request_context(paths)
        context = repository.next_context(context_key(paths))
        assert context["context_key"] == context_key(paths)
        assert context["retry_in"] is None
        assert 0 < repository.next_context(context_key(paths))["retry_in"] <= 30, "a claim left behind says when it is due"
        repository.publish_context(context["context_key"], context["revision"], root, foreground=True)
        assert repository.root_for_tracks(paths) == Path(root_key(root))
        assert repository.root_for_tracks({str(root / "different-album.mp3")}) is None

        pending = repository.next_pending(root_key(root))
        assert pending["retry_in"] is None
        assert 0 < repository.next_pending(root_key(root))["retry_in"] <= 300
        assert repository.publish(root, pending["revision"], [])
        assert repository.get(root) == {"candidates": [], "error": None, "available": True, "complete": True}

        repository.invalidate_paths([str(root / "new-cover.png")])
        assert repository.root_for_tracks(paths) == Path(root_key(root))
        assert repository.get(root) == {"candidates": [], "error": None, "available": True, "complete": False}
        assert repository.publish(root, pending["revision"], []) is False
        repository.invalidate_paths(paths, context_changed=True)
        assert repository.root_for_tracks(paths) is None
    finally:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("delete from library.local_cover_inventory_contexts where context_key = %s", (context_key(paths),))
            connection.execute("delete from library.local_cover_inventories where root_path = %s", (root_key(root),))


@pytest.mark.parametrize(("retry_in", "cleared"), [
    (20, False),  # an active claim, or the 30 s storage deferral
    (3595, False),  # deferred for the hour seconds ago: the modal polls every second
    (3500, True),  # deferred for the hour a while ago
])
def test_an_open_retries_only_an_older_unresolved_folder_deferral(retry_in, cleared):
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV) or not os.environ.get(isolatedPostgres.RUNTIME_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs are required.")
    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    repository = LocalCoverInventoryRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url, "_library_root_paths_snapshot": (Path("/"),)},
        connect=isolatedPostgres._connect,
    )
    paths = {f"/int028-retry-{uuid4()}/track.mp3"}
    key = context_key(paths)
    try:
        repository.request_context(paths)
        repository.defer_context(key, 1, delay_seconds=retry_in, error=None)

        repository.request_context(paths)

        waits = repository.next_context(key)["retry_in"]
        if cleared:
            assert waits is None
        else:
            assert retry_in - 10 < waits <= retry_in, "an open during the deferral learns when the row is due"
    finally:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("delete from library.local_cover_inventory_contexts where context_key = %s", (key,))


@pytest.mark.parametrize("windows_paths", [True, False])
def test_unicode_candidate_removal_preserves_filesystem_identity(monkeypatch, tmp_path, windows_paths):
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs are not configured.")
    from types import SimpleNamespace
    import ntpath
    import posixpath
    from music_app.services import local_cover_inventory as module

    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    repository = LocalCoverInventoryRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url, "_library_root_paths_snapshot": (tmp_path,)},
        connect=isolatedPostgres._connect,
    )
    root = tmp_path / f"unicode-inventory-{uuid4()}"
    original = str(root / "ОБЛОЖКА.jpg")
    variant = str(root / "обложка.jpg")
    sharp_s = str(root / "Straße.jpg")
    double_s = str(root / "Strasse.jpg")
    monkeypatch.setattr(module, "os", SimpleNamespace(
        name="nt" if windows_paths else "posix", sep=os.sep, path=ntpath if windows_paths else posixpath,
    ))
    try:
        repository.request(root)
        assert repository.publish(root, 1, [{"path": original}, {"path": sharp_s}, {"path": double_s}])
        repository.remove_path(variant)
        remaining = [candidate["path"] for candidate in repository.get(root)["candidates"]]
        assert remaining == ([sharp_s, double_s] if windows_paths else [original, sharp_s, double_s])
        repository.remove_path(sharp_s)
        assert [candidate["path"] for candidate in repository.get(root)["candidates"]] == ([double_s] if windows_paths else [original, double_s])
    finally:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("delete from library.local_cover_inventories where root_path = %s", (root_key(root),))


_INVENTORY_TABLES = {"local_cover_inventories", "local_cover_inventory_contexts"}
_TABLE_SCANS = {"Seq Scan", "Index Scan", "Index Only Scan", "Bitmap Heap Scan", "Tid Scan", "Tid Range Scan"}
_LIBRARY_ID = (
    "select libraries.id from library.libraries as libraries join app.bootstrap_owners as owners"
    " on owners.account_id = libraries.owner_account_id where owners.owner_key = 'local-bootstrap-owner'"
    " and libraries.name = 'Local Library' and libraries.library_kind = 'local' limit 1"
)


def _rows_read(plan) -> int:
    """Every inventory row a plan's table scans touched, kept or filtered out."""
    read = 0
    if plan.get("Node Type") in _TABLE_SCANS and plan.get("Relation Name") in _INVENTORY_TABLES:
        touched = plan.get("Actual Rows", 0) + plan.get("Rows Removed by Filter", 0)
        read = round((touched + plan.get("Rows Removed by Index Recheck", 0)) * plan.get("Actual Loops", 1))
    return read + sum(_rows_read(child) for child in plan.get("Plans", ()))


class _CountedConnection:
    """Runs each inventory statement once under EXPLAIN ANALYZE in a rolled-back savepoint, then for real."""

    def __init__(self, connection, counts):
        self._connection, self._counts = connection, counts

    def __enter__(self):
        self._connection.__enter__()
        return self

    def __exit__(self, *failure):
        return self._connection.__exit__(*failure)

    def __getattr__(self, name):
        return getattr(self._connection, name)

    def execute(self, query, params=None):
        if "local_cover_inventor" in query:
            self._counts["statements"] += 1
            self._connection.execute("savepoint counted")
            plan = next(iter(self._connection.execute(f"explain (analyze, format json) {query}", params).fetchone().values()))
            self._connection.execute("rollback to savepoint counted")
            plan = json.loads(plan) if isinstance(plan, str) else plan
            self._counts["read"] += _rows_read(plan[0]["Plan"])
        return self._connection.execute(query, params)


def _inventory_versions(setup_url, base):
    with isolatedPostgres._connect(setup_url) as connection:
        rows = connection.execute(
            """select 'listing ' || root_path as row, xmin::text as version from library.local_cover_inventories
                 where root_path = %(base)s or starts_with(root_path, %(below)s)
               union all select 'context ' || context_key, xmin::text from library.local_cover_inventory_contexts
                 where starts_with(track_paths ->> 0, %(below)s)""",
            {"base": base, "below": base + os.sep},
        ).fetchall()
    return {row["row"]: row["version"] for row in rows}


def _seed_counted_library(setup_url, base, albums):
    """``albums`` albums under 50 artists, five more in one box set, and one open whose stored folder is the root.

    Paths are stored as the app keys them (``root_key``), with this platform's separator."""
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            f"""insert into library.local_cover_inventories (library_id, root_path, revision, indexed_revision)
                select ({_LIBRARY_ID}), folder, 1, 1 from (
                  select %(base)s || %(sep)s || 'artist-' || (album %% 50) || %(sep)s || 'album-' || album
                    from generate_series(1, %(albums)s) as album
                  union all select %(base)s || %(sep)s || 'box' || %(sep)s || 'album-' || album from generate_series(1, 5) as album
                  union all select %(base)s) as folders(folder)""",
            {"base": base, "albums": albums, "sep": os.sep},
        )
        # context_key is the SHA-256 of json.dumps([track]), which doubles each backslash.
        connection.execute(
            f"""insert into library.local_cover_inventory_contexts (library_id, context_key, track_paths, root_path)
                select library_id,
                  encode(sha256(convert_to('["' || replace(root_path || %(sep)s || '01.mp3', %(backslash)s, %(json_backslash)s)
                    || '"]', 'UTF8')), 'hex'),
                  jsonb_build_array(root_path || %(sep)s || '01.mp3'), root_path
                from library.local_cover_inventories where library_id = ({_LIBRARY_ID}) and starts_with(root_path, %(below)s)""",
            {"below": base + os.sep, "sep": os.sep, "backslash": "\\", "json_backslash": "\\\\"},
        )
        connection.execute(
            f"""insert into library.local_cover_inventory_contexts (library_id, context_key, track_paths, root_path)
                select ({_LIBRARY_ID}), %(key)s, %(paths)s, %(base)s""",
            {"key": context_key(_repaired_tracks(base)), "paths": Jsonb(sorted(_repaired_tracks(base))), "base": base},
        )
        connection.execute("analyze library.local_cover_inventories")
        connection.execute("analyze library.local_cover_inventory_contexts")


def _repaired_tracks(base):
    return {os.path.join(base, "repair", "01.mp3"), os.path.join(base, "repair", "02.mp3")}


def test_inventory_changes_read_and_write_only_what_they_change_at_two_library_sizes(monkeypatch):
    """6.5: a file change, a folder subtree, a root-level event, an open's repair and an idle poll
    cost the same at 2,000 and 20,000 albums; a plan that ignores migration 0292 reads the table."""
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV) or not os.environ.get(isolatedPostgres.RUNTIME_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs are required.")
    from music_app.services import local_cover_inventory as module

    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    costs = {}
    for albums in (2_000, 20_000):
        # The hosted runners are Windows: paths are keyed as the app keys them there.
        base = root_key(f"/int050-count-{uuid4().hex}")
        counts = {"statements": 0, "read": 0}
        config = {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url, "_library_root_paths_snapshot": (Path(base),)}
        repository = LocalCoverInventoryRepository(
            config, connect=lambda url: _CountedConnection(isolatedPostgres._connect(url), counts),
        )
        worker = module.LocalCoverInventoryWorker(config, repository=repository)
        repaired = _repaired_tracks(base)

        def open_repair():
            assert repository.root_for_tracks(repaired) is None, "a stored root is never an album's folder"
            worker.request_context(repaired)
            claimed = repository.next_context(context_key(repaired))
            repository.publish_context(
                claimed["context_key"], claimed["revision"], os.path.join(base, "repair"), foreground=True,
            )

        def idle_poll():
            idle, passes = module.LocalCoverInventoryWorker(config, repository=repository), []

            def wait(_timeout):
                passes.append(True)
                if len(passes) == 3:
                    idle._stop.set()

            monkeypatch.setattr(idle._wake, "wait", wait)
            idle._foreground_at -= 60
            idle._run()

        scenarios = {
            "file change": lambda: worker.invalidate_paths(
                [os.path.join(base, "artist-7", "album-7", "01.mp3")], context_changed=True,
            ),
            "folder subtree": lambda: worker.invalidate_paths(
                [os.path.join(base, "box")], subtree_paths=[os.path.join(base, "box")], context_changed=True,
            ),
            "root-level event": lambda: worker.invalidate_paths([base], subtree_paths=[base], context_changed=True),
            "open repair": open_repair,
            "idle poll": idle_poll,
        }
        try:
            _seed_counted_library(setup_url, base, albums)
            for name, scenario in scenarios.items():
                counts.update(statements=0, read=0)
                before = _inventory_versions(setup_url, base)
                scenario()
                after = _inventory_versions(setup_url, base)
                written = sum(1 for row, version in after.items() if before.get(row) != version)
                costs.setdefault(name, {})[albums] = (counts["statements"], counts["read"], written)
        finally:
            with isolatedPostgres._connect(setup_url) as connection:
                connection.execute(
                    "delete from library.local_cover_inventory_contexts where starts_with(track_paths ->> 0, %s)",
                    (base + os.sep,),
                )
                connection.execute(
                    "delete from library.local_cover_inventories where root_path = %s or starts_with(root_path, %s)",
                    (base, base + os.sep),
                )

    written = {"file change": 2, "folder subtree": 10, "root-level event": 0, "open repair": 2, "idle poll": 0}
    for name, by_size in costs.items():
        small, large = by_size[2_000], by_size[20_000]
        assert small == large, f"{name}: (statements, rows read, rows written) grew with the library: {by_size}"
        assert small[2] == written[name], f"{name} wrote {small[2]} rows, not {written[name]}"
        assert small[1] <= 4 * max(written[name], 1) + 4, f"{name} read {small[1]} rows to write {small[2]}"
    assert costs["root-level event"][2_000][0] == costs["idle poll"][2_000][0] == 0
