from music_app.services.library_browse_postgres import _root_gallery_page_selection
import pytest


def row(artist, key, *, artist_id=1, year=2000):
    return dict(artist_name=artist, artist_id=artist_id, album_id=key, album_key=key,
                album_title=key, album_release_year=year)


def test_root_pages_bound_large_artist_and_preserve_full_metadata():
    rows = [row('Artist', str(i), year=1900+i) for i in range(103)]
    page, sidebar, total, metadata = _root_gallery_page_selection(rows, [], {}, {}, {'gallery_page_size': '50'})
    assert len(page) == 50
    assert sidebar == [{'artist': 'Artist', 'artist_display': 'Artist', 'count': 103}]
    assert total == 103
    seen = [item['album_key'] for item in page]
    while metadata['has_more']:
        page, _, count, metadata = _root_gallery_page_selection(rows, [], {}, {}, {
            'gallery_page_size': '50', 'gallery_cursor': metadata['next_cursor']})
        assert count == 103
        seen.extend(item['album_key'] for item in page)
    assert seen == [str(i) for i in range(103)]


def test_root_page_membership_deduplicates_alias_rows_but_preserves_featured_occurrences():
    rows = [row('Alias', 'a'), row('Canonical', 'a', artist_id=2), row('Featured', 'a', artist_id=3)]
    page, sidebar, total, _ = _root_gallery_page_selection(rows, [], {'Alias': 'Canonical'}, {}, {})
    assert [item['artist'] for item in sidebar] == ['Canonical', 'Featured']
    assert len(page) == 2
    assert total == 1


def test_root_page_missing_album_is_in_sidebar_and_same_order():
    missing = [{'key': 'missing', 'album_artist': 'Before', 'name': 'Lost', 'year': 1990}]
    page, sidebar, total, _ = _root_gallery_page_selection([row('Later', 'live')], missing, {}, {}, {})
    assert [item['artist'] for item in sidebar] == ['Before', 'Later']
    assert [item['artist_name'] for item in page] == ['Before', 'Later']
    assert total == 2


@pytest.mark.parametrize('change', ['rows', 'filters'])
def test_root_page_rejects_stale_cursor(change):
    rows = [row('Artist', str(i)) for i in range(3)]
    _, _, _, meta = _root_gallery_page_selection(rows, [], {}, {}, {'gallery_page_size': '1'})
    with pytest.raises(ValueError, match='restart'):
        _root_gallery_page_selection(rows + ([row('Artist', 'new')] if change == 'rows' else []), [], {},
                                     {'gallery_scope': 'changed'} if change == 'filters' else {},
                                     {'gallery_cursor': meta['next_cursor']})


@pytest.mark.parametrize('size', ['0', '101', '-1', 'x', '1.5'])
def test_root_page_rejects_invalid_size(size):
    with pytest.raises(ValueError):
        _root_gallery_page_selection([], [], {}, {}, {'gallery_page_size': size})

def test_root_page_hydrates_only_selected_album_ids_in_one_snapshot(monkeypatch):
    from music_app.services import library_browse_postgres as browse
    from tests.py.test_library_browse_postgres import _browse_album_row, _EmptyAlbumRatingsService
    rows = [_browse_album_row(artist="Artist", album_id=i, album_key=f"album-{i}", title=f"Album {i}") for i in range(1, 8)]
    calls = []
    class Connection:
        def execute(self, sql, params=None):
            calls.append((sql, params))
            result = [row for row in rows if row["album_id"] in params["gallery_album_ids"]] if params and "gallery_album_ids" in params else rows
            return type("Cursor", (), {"fetchall": lambda self: result})()
        def rollback(self): calls.append(("rollback", None))
        def close(self): calls.append(("close", None))
    connection = Connection()
    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _url: connection, album_ratings_service=_EmptyAlbumRatingsService())
    monkeypatch.setattr(repository, "_load_relation_alias_maps", lambda **kwargs: {"alias_to_canonical": {}, "canonical_to_aliases": {}})
    monkeypatch.setattr(repository._inventory_repository, "load_support_state", lambda **kwargs: {"ignored_version_keys": [], "manual_version_links": {}})
    monkeypatch.setattr(repository, "_load_missing_album_rows", lambda **kwargs: [])
    monkeypatch.setattr(browse, "_queue_display_cover_variants_for_groups", lambda *args: None)
    loose_track = {"path": "isolated/Loose Artist/track.mp3", "artist": "Loose Artist", "title": "Loose track"}
    non_album_calls = []
    def load_non_album(**options):
        non_album_calls.append(options)
        return [loose_track]
    monkeypatch.setattr(repository, "_load_non_album_entries", load_non_album)
    monkeypatch.setattr(browse, "build_non_album_track_list", lambda entries, **_options: list(entries))
    monkeypatch.setattr(browse, "configured_library_root_paths_snapshot", lambda _config, **_options: ())
    payload = repository.build_root_startup_preview_payload(query_params={"gallery_page_size": "2", "omit_sidebar": "1"})
    assert payload["non_album_tracks"] == [loose_track]
    assert len(non_album_calls) == 1
    assert non_album_calls[0]["connection"] is connection
    assert payload["album_count"] == 7
    assert payload["artists_sidebar"][0]["count"] == 7
    assert len(payload["artist_groups"][0]["albums"]) == 2
    assert payload["gallery_page"]["has_more"] is True
    assert payload["initial_view_partial"] is False
    bounded = [params["gallery_album_ids"] for _, params in calls if params and "gallery_album_ids" in params]
    assert len(bounded) == 1 and len(bounded[0]) == 2
    assert calls[0][0] == "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
    assert calls[-2:] == [("rollback", None), ("close", None)]
    next_page = repository.build_root_startup_preview_payload(query_params={
        "gallery_page_size": "2", "omit_sidebar": "1", "gallery_cursor": payload["gallery_page"]["next_cursor"]})
    assert "artists_sidebar" not in next_page
    assert "non_album_tracks" not in next_page
    assert len(non_album_calls) == 1
    assert next_page["album_count"] == 7



@pytest.mark.parametrize('cursor', ['!', 'W10', 'e30', 'x' * 257])
def test_root_page_rejects_malformed_cursor(cursor):
    with pytest.raises(ValueError, match='cursor'):
        _root_gallery_page_selection([], [], {}, {}, {'gallery_cursor': cursor})


def test_root_page_alias_order_and_revision_do_not_depend_on_database_row_order():
    aliases = {"Alias": "Canonical"}
    rows = [dict(row("Alias", "a"), artist_sort_name="Zebra"),
            dict(row("Canonical", "a", artist_id=2), artist_sort_name="Alpha"), row("Between", "b")]
    forward = _root_gallery_page_selection(rows, [], aliases, {}, {"gallery_page_size": "1"})
    backward = _root_gallery_page_selection(list(reversed(rows)), [], aliases, {}, {"gallery_page_size": "1"})
    assert forward[1:] == backward[1:]
    assert [item["artist"] for item in forward[1]] == ["Between", "Canonical"]


def test_root_page_revision_ignores_presentation_changes():
    rows = [row("Artist", "album")]
    first = _root_gallery_page_selection(rows, [], {}, {"gallery_display_mode": "cards", "gallery_scale_percent": 100}, {})
    changed = _root_gallery_page_selection(rows, [], {}, {"gallery_display_mode": "rows", "gallery_scale_percent": 75}, {})
    assert first[3]["revision"] == changed[3]["revision"]


def test_root_page_revision_changes_when_artist_relationship_changes():
    owned = [dict(row("Artist", "album"), featured_kind="owner")]
    featured = [dict(row("Artist", "album"), featured_kind="featured_track_artist")]

    owned_page = _root_gallery_page_selection(owned, [], {}, {}, {})
    featured_page = _root_gallery_page_selection(featured, [], {}, {}, {})

    assert owned_page[3]["revision"] != featured_page[3]["revision"]

def test_root_membership_checks_eligible_files_without_full_library_track_rollups():
    from music_app.services.library_browse_postgres import _root_gallery_membership_sql

    sql = " ".join(_root_gallery_membership_sql().split()).lower()
    assert "max(library.local_tracks.duration_seconds)" not in sql
    assert "group by library.local_tracks.library_id, library.local_tracks.album_id, library.local_tracks.id" not in sql
    assert "library.local_track_files.scan_cache_stale is false" in sql
    assert "path_override.track_key = library.local_track_files.private_path" in sql
    assert "track_override.track_id = library.local_tracks.id" in sql
    assert "and path_override.id is null" in sql
    assert sql.index("when path_override.override_payload ? 'exception_type'") < sql.index("when track_override.override_payload ? 'exception_type'")
    assert "eligible.library_id = album.library_id and eligible.album_id = album.id" in sql
