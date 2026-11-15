from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

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
        {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, connect=isolatedPostgres._connect,
    )
    parent = Path(f"/int028-unrelated-{uuid4()}")
    roots = [parent / "album-a", parent / "album-b"]
    paths = [{str(root / "CD1" / "track.mp3")} for root in roots]
    keys = [context_key(value) for value in paths]
    try:
        repository.request_context(paths[0])
        claimed = repository.next_context(background=False)
        assert claimed["context_key"] == keys[0]
        repository.request_context(paths[1])
        repository.defer_context(keys[1], 1)
        with isolatedPostgres._connect(setup_url) as connection:
            before = connection.execute(
                "select revision,retry_after from library.local_cover_inventory_contexts where context_key=%s", (keys[0],)
            ).fetchone()
        changed = roots[1] / ("CD2" if event_kind == "disc" else "CD1/new.mp3")
        subtrees = [roots[1]] if event_kind == "subtree" else []
        repository.invalidate_paths(subtrees or [changed], subtree_paths=subtrees, context_changed=True)
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
        {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, connect=isolatedPostgres._connect,
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
        claimed = repository.next_context(background=False)
        assert claimed["context_key"] == context_key(unresolved_paths)

        removed_disc = parent / "CD2"
        repository.invalidate_paths([removed_disc], subtree_paths=[removed_disc], context_changed=True)
        assert repository.root_for_tracks(path_sets[2]) is None
        assert repository.root_for_tracks(path_sets[1]) == Path(root_key(roots[1]))

        repository.invalidate_paths([parent], subtree_paths=[parent], context_changed=True)

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
        {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, connect=isolatedPostgres._connect,
    )
    root = Path(f"/int028-{uuid4()}")
    paths = {str(root / "first.mp3"), str(root / "second.mp3")}
    try:
        assert repository.root_for_tracks(paths) is None
        repository.request_context(paths)
        context = repository.next_context(background=False)
        assert context["context_key"] == context_key(paths)
        assert repository.next_context(background=False) is None
        repository.publish_context(context["context_key"], context["revision"], root, foreground=True)
        assert repository.root_for_tracks(paths) == Path(root_key(root))
        assert repository.root_for_tracks({str(root / "different-album.mp3")}) is None

        pending = repository.next_pending(background=False)
        assert repository.next_pending(background=False) is None
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
        {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, connect=isolatedPostgres._connect,
    )
    root = tmp_path / f"unicode-inventory-{uuid4()}"
    original = str(root / "ОБЛОЖКА.jpg")
    variant = str(root / "обложка.jpg")
    sharp_s = str(root / "Straße.jpg")
    double_s = str(root / "Strasse.jpg")
    monkeypatch.setattr(module, "os", SimpleNamespace(name="nt" if windows_paths else "posix", path=ntpath if windows_paths else posixpath))
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
