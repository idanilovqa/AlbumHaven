from __future__ import annotations

import os
from uuid import uuid4

import pytest

from music_app.services.album_identity_lineage_postgres import AlbumIdentityLineageRepository
from music_app.services.cover_lookup_tasks_postgres import _current_notification_album_joins_sql
from tests.e2e.support import isolatedPostgres
from tests.py.test_album_identity_lineage_postgres import _candidate, _repository


@pytest.mark.parametrize("split", [False, True])
def test_saved_complete_paths_recover_identity_without_transition_history(split):
    rows = [_candidate(7, "new-key", matched_paths=1, requested_paths=2 if split else 1,
                       matched_by_id=False, matched_by_key=False)]
    if split:
        rows.append(_candidate(8, "second-key", matched_paths=1, requested_paths=2,
                               matched_by_id=False, matched_by_key=False))
    for row in rows:
        row["path_set_complete"] = True
    repository, _ = _repository(rows)
    result = repository.resolve(album_id=99, album_key="old-key", track_paths={"a", "b"} if split else {"a"})
    assert result["status"] == ("split" if split else "resolved")
    assert [album["album_id"] for album in result["choices"]] == ([7, 8] if split else [])
    if not split:
        assert result["album"]["album_id"] == 7


def test_partial_saved_paths_cannot_rebind_an_unresolved_identity():
    row = _candidate(7, "new-key", matched_paths=1, requested_paths=2,
                     matched_by_id=False, matched_by_key=False)
    repository, _ = _repository([row])
    assert repository.resolve(album_id=99, album_key="old-key", track_paths={"a", "missing"})["status"] == "unresolved"


def test_complete_saved_paths_override_only_a_disagreeing_identity_pair():
    current = _candidate(7, "unrelated", matched_by_id=True, matched_by_key=False)
    owner = _candidate(8, "renamed", matched_paths=1, requested_paths=1,
                       matched_by_id=False, matched_by_key=False)
    owner["path_set_complete"] = True
    repository, _ = _repository([current, owner])
    assert repository.resolve(album_id=7, album_key="historical", track_paths={"a"})["album"]["album_id"] == 8
    current["matched_by_key"] = True
    assert repository.resolve(album_id=7, album_key="unrelated", track_paths={"a"})["album"]["album_id"] == 7


def test_live_notification_and_detail_resolve_saved_paths_without_recreating_tasks():
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs are not configured.")
    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    psycopg = pytest.importorskip("psycopg")
    from psycopg.types.json import Jsonb

    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    token = "path-owner-" + uuid4().hex
    root_id = None
    album_ids = []
    artist_ids = []
    try:
        with isolatedPostgres._connect(setup_url) as connection:
            library_id = connection.execute("""select libraries.id
                from app.bootstrap_owners owners join library.libraries libraries
                  on libraries.owner_account_id=owners.account_id
                where owners.owner_key='local-bootstrap-owner'
                  and libraries.name='Local Library' and libraries.library_kind='local'""").fetchone()["id"]
            root_id = connection.execute("""insert into library.library_roots
                (library_id,root_path,root_kind,is_active) values(%s,%s,'main_library',true) returning id""",
                (library_id, "/" + token)).fetchone()["id"]
            paths = []
            for index, title in enumerate(("Renamed", "Split successor", "Unknown Album")):
                artist = "Unknown Artist" if index == 2 else token
                artist_id = connection.execute("""insert into library.local_artists
                    (library_id,artist_key,name) values(%s,%s,%s) returning id""",
                    (library_id, f"{token}-{index}", artist)).fetchone()["id"]
                artist_ids.append(artist_id)
                album_id = connection.execute("""insert into library.local_albums
                    (library_id,artist_id,album_key,title,cover_path)
                    values(%s,%s,%s,%s,%s) returning id""",
                    (library_id, artist_id, f"{token}-{index}", title, f"/{token}/{index}.jpg")).fetchone()["id"]
                album_ids.append(album_id)
                track_id = connection.execute("""insert into library.local_tracks
                    (library_id,album_id,artist_id,track_key,title)
                    values(%s,%s,%s,%s,'Track') returning id""",
                    (library_id, album_id, artist_id, f"{token}-{index}")).fetchone()["id"]
                path = f"/{token}/{index}.flac"
                paths.append(path)
                connection.execute("""insert into library.local_track_files
                    (track_id,library_root_id,private_path,metadata) values(%s,%s,%s,%s)""",
                    (track_id, root_id, path, Jsonb({"scan_cache": {"stale": False}})))
            empty_id = connection.execute("""insert into library.local_albums
                (library_id,artist_id,album_key,title,cover_path) values(%s,%s,%s,'Old empty identity','/old.jpg') returning id""",
                (library_id, artist_ids[0], token + "-empty")).fetchone()["id"]
            album_ids.append(empty_id)
            cases = {
                "renamed": ([paths[0]], "resolved", True, album_ids[0]),
                "duplicate-path": ([paths[0], paths[0]], "resolved", True, album_ids[0]),
                "empty-old": ([paths[0]], "resolved", True, album_ids[0]),
                "current": ([paths[1]], "current", True, album_ids[0]),
                "conflict": ([paths[0]], "resolved", True, album_ids[0]),
                "split": (paths[:2], "split", True, None),
                "partial": ([paths[0], f"/{token}/missing"], "unresolved", False, None),
                "deleted": ([f"/{token}/missing"], "unresolved", False, None),
                "unknown": ([paths[2]], "unresolved", False, None),
                "mixed-unknown": ([paths[0], paths[2]], "unresolved", False, None),
            }
            identities = {
                "empty-old": (empty_id, token + "-empty"),
                "current": (album_ids[0], token + "-0"),
                "conflict": (album_ids[1], token + "-old"),
            }
            for label, (saved_paths, _, _, _) in cases.items():
                saved_id, saved_key = identities.get(label, (9223372036854775806, token + "-old"))
                metadata = {"source_family": "runtime_cover_lookup_notifications_adapter",
                            "track_paths": saved_paths, "notification_order_at": "2026-01-01T00:00:00Z",
                            "source_payload": {"album_payload": {"id": saved_id, "key": saved_key},
                                               "user_selected": False}}
                connection.execute("""insert into ops.cover_lookup_tasks
                    (library_id,task_key,status,album_key,metadata) values(%s,%s,'completed',%s,%s)""",
                    (library_id, token + label, token + "-old", Jsonb(metadata)))
        repository = AlbumIdentityLineageRepository({"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url},
                                                    connect=isolatedPostgres._connect)
        with isolatedPostgres._connect(runtime_url) as connection:
            before = connection.execute("select task_key,metadata from ops.cover_lookup_tasks where task_key like %s order by task_key",
                                        (token + "%",)).fetchall()
            rows = connection.execute("""select ops.cover_lookup_tasks.task_key,
                current_album.album_id, current_album.cover_path, current_album.has_active_tracks
                from ops.cover_lookup_tasks """ + _current_notification_album_joins_sql() +
                " where ops.cover_lookup_tasks.task_key like %s", (token + "%",)).fetchall()
            projected = {row["task_key"]: row for row in rows}
            for label, (saved_paths, expected_status, visible, expected_album) in cases.items():
                saved_id, saved_key = identities.get(label, (9223372036854775806, token + "-old"))
                result = repository.resolve(album_id=saved_id, album_key=saved_key, track_paths=set(saved_paths))
                assert result["status"] == expected_status
                row = projected[token + label]
                assert row["has_active_tracks"] is visible
                assert row["album_id"] == expected_album
                if expected_album:
                    assert result["album"]["album_id"] == expected_album
                    assert row["cover_path"] == f"/{token}/0.jpg"
                if label == "split":
                    assert {album["album_id"] for album in result["choices"]} == set(album_ids[:2])
            after = connection.execute("select task_key,metadata from ops.cover_lookup_tasks where task_key like %s order by task_key",
                                       (token + "%",)).fetchall()
            assert after == before
    finally:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("delete from ops.cover_lookup_tasks where task_key like %s", (token + "%",))
            connection.execute("delete from library.local_albums where id=any(%s)", (album_ids,))
            connection.execute("delete from library.local_artists where id=any(%s)", (artist_ids,))
            if root_id:
                connection.execute("delete from library.library_roots where id=%s", (root_id,))
