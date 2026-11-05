"""Single-album edits preserve unrelated cached gallery membership."""
import pytest
from music_app.services import gallery_projection_postgres as gallery
from music_app.services import library_browse_postgres as browse


def test_scoped_missing_gallery_candidates_are_filtered_before_materialization():
    sql = browse._missing_albums_sql(scoped_albums=True)
    candidate = sql.split("stale_album_candidates as materialized (", 1)[1].split("missing_albums as (", 1)[0]
    assert "scoped_album.album_key = any(%(album_keys)s::text[])" in candidate
    assert "__STALE_ALBUM_SCOPE__" not in browse._missing_albums_sql()


def test_incremental_rows_preserve_root_oracle_sort_and_occurrence_identity():
    rows = [
        {"artist_name": name, "album_id": index, "album_key": key,
         "album_title": title, "album_release_year": year}
        for index, (name, key, title, year) in enumerate([
            ("# Artist", "punctuation", "Last", 2020),
            ("2 Artist", "number", "First", 1999),
            ("Artist", "old", "Older", 1980),
            ("Artist", "new", "Newer", 2000),
        ], 1)
    ]
    snapshot = browse._prepare_root_gallery_snapshot(rows, [], {}, {})
    normalized = gallery.membership_rows(snapshot)
    assert [row["payload"]["album_key"] for row in sorted(
        normalized, key=lambda row: (row["artist_sort"], row["artist_id"],
                                    row["album_year"], row["album_sort"], row["album_key"])
    )] == [row["album_key"] for row in snapshot["ordered"]]
    assert all(row["artist_id"] == row["payload"]["artist_id"] for row in normalized)


def test_gallery_patch_reads_only_affected_album_membership(monkeypatch):
    calls = []
    state = {"gallery_scope": "all", "visible_library_categories": []}

    class Cursor:
        def __init__(self, rows):
            self.rows = rows

        def fetchall(self):
            return self.rows

        def fetchone(self):
            return self.rows[0] if self.rows else None

    class Connection:
        def execute(self, sql, params=None):
            calls.append((sql, params))
            if "gallery_membership_headers" in sql:
                return Cursor([{"scope_key": gallery.gallery_projection_scope_key(state),
                                "view_state": state, "revision": "a" * 64, "source_generation": 7}])
            if "local_relation_projection_entries" in sql:
                assert params == (1, ['New Artist', 'guest alias', 'missing alias'])
                assert "entry_key=any" in sql
                return Cursor([{'entry_key': 'guest alias', 'payload': 'Guest Canonical'},
                               {'entry_key': 'missing alias', 'payload': 'Missing Canonical'}])
            if "patch_gallery_membership" in sql:
                return Cursor([{"published": True}])
            assert sql == "scoped-membership"
            assert params["gallery_album_ids"] == [17, 18]
            return Cursor([{"artist_name": "New Artist", "album_id": 18,
                            "album_key": "new artist::new", "album_title": "New",
                            "album_release_year": 2020},
                {"artist_name": "guest alias", "album_id": 18,
                 "album_key": "new artist::new", "album_title": "New", "album_release_year": 2020}])

    class Repository:
        def __init__(self, *_args, **_kwargs):
            pass

        def _load_missing_album_rows(self, *, album_keys, connection):
            assert album_keys == ["new artist::new", "old artist::old"]
            return [{'key': 'old artist::old', 'album_artist': 'missing alias', 'name': 'Old', 'year': 1980}]

    def membership_query(*, candidate_albums_only=False):
        assert candidate_albums_only, "patch must never load full-library memberships"
        return "scoped-membership"

    monkeypatch.setattr(browse, "PostgresLibraryBrowseRepository", Repository)
    monkeypatch.setattr(browse, "_missing_album_projection_payloads", lambda rows, **_kwargs: rows)
    monkeypatch.setattr(browse, "_root_gallery_membership_sql", membership_query)
    monkeypatch.setattr(gallery, "gallery_projection_context", lambda _connection: {
        "library_id": 1, "generation": 8,
    })
    monkeypatch.setattr(gallery, "_membership_installed", lambda _connection: True)
    count = gallery.patch_gallery_membership_in_transaction(
        Connection(), {}, affected_album_ids=[17, 18],
        affected_album_keys=["old artist::old", "new artist::new"],
        alias_to_canonical={"New Artist": "New Artist"}, expected_generation=7,
    )
    assert count == 1
    published = next(params for sql, params in calls if "patch_gallery_membership" in sql)
    assert published["expected_generation"] == 7
    assert published["generation"] == 8
    assert published["affected_album_keys"] == ["new artist::new", "old artist::old"]


    patched_rows = next(params['rows'].obj for sql, params in calls if 'patch_gallery_membership' in sql)
    assert {row['payload']['artist_name'] for row in patched_rows} == {'New Artist', 'Guest Canonical', 'Missing Canonical'}

def test_gallery_patch_does_not_promote_a_stale_baseline(monkeypatch):
    class Cursor:
        def fetchall(self):
            return []

    class Connection:
        def execute(self, sql, params=None):
            assert "source_generation" in sql
            assert params["expected_generation"] == 7
            return Cursor()

    monkeypatch.setattr(gallery, "gallery_projection_context", lambda _: {
        "library_id": 1, "generation": 8,
    })
    monkeypatch.setattr(gallery, "_membership_installed", lambda _: True)
    with pytest.raises(RuntimeError, match="baseline is unavailable"):
        gallery.patch_gallery_membership_in_transaction(
            Connection(), {}, affected_album_ids=[17], affected_album_keys=["old"],
            alias_to_canonical={}, expected_generation=7,
        )


@pytest.mark.parametrize("params", [
    {"gallery_page_size": "3"},
    {"gallery_page_size": "3", "gallery_anchor_artist": "Beta"},
    {"gallery_page_size": "3", "gallery_page_direction": "previous", "gallery_anchor_artist": "Gamma"},
])
def test_incremental_pages_match_existing_anchor_and_cursor_contract(params):
    state = {"gallery_scope": "all", "visible_library_categories": []}
    rows = [{"artist_name": artist, "album_id": index, "album_key": f"{artist}-{index}",
             "album_title": f"Album {index}", "album_release_year": 2000}
            for artist, count in [("Alpha", 4), ("Beta", 3), ("Gamma", 2)]
            for index in range(count)]
    snapshot = browse._prepare_root_gallery_snapshot(rows, [], {}, state)
    header = {**snapshot, "source_generation": 7}
    ordered = snapshot["ordered"]

    class Cursor:
        def __init__(self, result):
            self.result = result

        def fetchall(self):
            return self.result

        def fetchone(self):
            return self.result[0] if self.result else None

    class Connection:
        def execute(self, sql, query):
            if "local_artist_search_projection" in sql:
                return Cursor([])
            if "with target as" in sql:
                artist = query["artist_name"] or ordered[query["ordinal"]]["artist_name"]
                positions = [i for i, row in enumerate(ordered) if row["artist_name"] == artist]
                return Cursor([{"first_ordinal": min(positions), "group_count": len(positions)}])
            if "gallery_membership_headers" in sql:
                return Cursor([{"revision": snapshot["revision"]}])
            assert "gallery_membership_entries" in sql
            return Cursor([{"payload": row} for row in ordered[query["offset"]:query["offset"] + query["length"]]])

    actual = gallery._load_membership_page(Connection(), {"library_id": 1}, state, params, header)
    expected = browse._select_root_gallery_snapshot_page(snapshot, params)
    assert actual == expected


def test_incremental_page_rejects_a_concurrent_membership_change():
    class Cursor:
        def fetchall(self):
            return []

        def fetchone(self):
            return {"revision": "b" * 64}

    class Connection:
        def execute(self, *_args):
            return Cursor()

    with pytest.raises(browse.GalleryProjectionPending, match="being updated"):
        gallery._load_membership_page(Connection(), {"library_id": 1}, {}, {}, {
            "revision": "a" * 64, "occurrence_count": 0, "album_count": 0, "sidebar": [],
        })


@pytest.mark.parametrize("message", [
    "Gallery artist boundary is unavailable.", "Gallery membership page is incomplete.",
])
@pytest.mark.parametrize("changed", [True, False])
def test_membership_read_failure_is_retryable_only_when_revision_changed(monkeypatch, message, changed):
    def read(*_args, **_kwargs):
        raise ValueError(message)

    class Connection:
        def execute(self, *_args):
            return type("Cursor", (), {"fetchone": lambda _: {
                "revision": ("b" if changed else "a") * 64,
            }})()

    monkeypatch.setattr(gallery, "_read_membership_page", read)
    error = browse.GalleryProjectionPending if changed else ValueError
    with pytest.raises(error, match="being updated" if changed else message):
        gallery._load_membership_page(Connection(), {"library_id": 1}, {}, {}, {
            "revision": "a" * 64,
        })


def test_shared_browse_initialization_is_explicit_and_requires_migration(monkeypatch):
    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    calls = []
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://isolated", "SHARED_LIBRARY_BROWSE_ONLY": True}
    monkeypatch.setattr(gallery, "_membership_installed", lambda _: False)
    monkeypatch.setattr(gallery, "gallery_projection_context", lambda _: {"library_id": 1, "generation": 1})
    monkeypatch.setattr(gallery, "_ready_header", lambda *_: {"revision": "a" * 64})
    monkeypatch.setattr(gallery, "_ensure_gallery_projection_ready", lambda *args, **kwargs: calls.append(kwargs) or {"built": 2})
    with pytest.raises(RuntimeError, match="migration is not installed"):
        gallery.initialize_gallery_membership(config, connect=lambda _: Connection())
    assert calls == []
    monkeypatch.setattr(gallery, "_membership_installed", lambda _: True)
    assert gallery.initialize_gallery_membership(config, connect=lambda _: Connection()) == {"built": 2}
    assert calls[0]["allow_shared_seed"] is True
    assert config["SHARED_LIBRARY_BROWSE_ONLY"] is True
    monkeypatch.setattr(gallery, "_ready_header", lambda *_: None)
    with pytest.raises(RuntimeError, match="startup is not ready"):
        gallery.initialize_gallery_membership(config, connect=lambda _: Connection())


@pytest.mark.parametrize("shared", [True, False])
def test_shared_gallery_refresh_replays_dirty_keys_without_a_full_build(monkeypatch, shared):
    from music_app.services import scoped_relation_projection as relations

    calls = []
    monkeypatch.setattr(relations, "ensure_pending_relation_projection_ready",
                        lambda *_args, **_kwargs: calls.append("dirty-replay") or {"initialized": True, "updated": True})
    monkeypatch.setattr(gallery, "ensure_gallery_projection_ready",
                        lambda *_args, **_kwargs: pytest.fail("shared refresh must not build the full gallery"))

    def queue(_config, _key, action, **options):
        assert options["allow_shared"] is True
        return action()

    monkeypatch.setattr(gallery, "_queue", queue)
    assert gallery.schedule_gallery_projection_refresh({
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://isolated", "SHARED_LIBRARY_BROWSE_ONLY": shared,
    }, incremental_membership=True) == {"initialized": True, "updated": True}
    assert calls == ["dirty-replay"]


@pytest.mark.parametrize("present", [False, True])
def test_shared_custom_scope_is_seeded_once_not_rebuilt_when_stale(monkeypatch, present):
    from music_app.services import scoped_relation_projection as relations

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, sql, params):
            assert "gallery_membership_headers" in sql
            assert "source_generation" not in sql
            return type("Cursor", (), {"fetchone": lambda _: {"present": 1} if present else None})()

    calls = []
    state = {"gallery_scope": "all", "visible_library_categories": ["hoard"]}
    monkeypatch.setattr(relations, "ensure_pending_relation_projection_ready",
                        lambda *_args, **_kwargs: {"initialized": True, "updated": False})
    monkeypatch.setattr(gallery, "gallery_projection_context", lambda _: {"library_id": 1, "generation": 3})
    monkeypatch.setattr(gallery, "_queue", lambda _config, _key, action, **_options: action())
    monkeypatch.setattr(gallery, "_ensure_gallery_projection_ready",
                        lambda *_args, **options: calls.append(options) or {"built": 1})
    gallery.schedule_gallery_projection_refresh({
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://isolated", "SHARED_LIBRARY_BROWSE_ONLY": True,
    }, connect=lambda _: Connection(), view_state=state, incremental_membership=True)
    assert len(calls) == (0 if present else 1)
    if calls:
        assert calls[0]["view_state"] == state
        assert calls[0]["allow_shared_seed"] is True
