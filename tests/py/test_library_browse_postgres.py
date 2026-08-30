from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import json
from pathlib import Path, PureWindowsPath
from threading import Event, Lock

import pytest


class _EmptyAlbumRatingsService:
    def load_album_ratings(self, _album_keys, *, connection=None):
        del connection
        return {}


class _NoopSearchSnapshotConnection:
    def __init__(self, inventory_state=None):
        self._inventory_state = inventory_state or {
            "ignored_version_keys": [],
            "manual_version_links": {},
            "non_album_candidates": [],
            "queries": [],
        }

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        sql_text = " ".join(str(sql).split()).lower()
        if sql_text.startswith("set transaction isolation level repeatable read"):
            return _InventoryCursor()
        if "ignored_version_state as" in sql_text and "manual_version_state as" in sql_text:
            self._inventory_state["queries"].append(("support", sql_text, dict(params or {})))
            return _InventoryCursor(row={
                "ignored_version_keys": list(self._inventory_state["ignored_version_keys"]),
                "manual_version_links": dict(self._inventory_state["manual_version_links"]),
            })
        if "exception_candidates as" in sql_text and "ranked_exception_overrides as" in sql_text:
            self._inventory_state["queries"].append(("candidates", sql_text, dict(params or {})))
            return _InventoryCursor(rows=self._inventory_state["non_album_candidates"])
        return _InventoryCursor()


@pytest.fixture(autouse=True)
def default_empty_relation_alias_projection(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    original_loader = PostgresLibraryBrowseRepository._load_relation_alias_maps
    monkeypatch.setattr(
        PostgresLibraryBrowseRepository,
        "_load_relation_alias_maps",
        lambda _self, **_kwargs: {"alias_to_canonical": {}, "canonical_to_aliases": {}},
    )
    return original_loader


class _InventoryCursor:
    def __init__(self, *, row=None, rows=None):
        self._row = row
        self._rows = list(rows or [])

    def fetchone(self):
        return self._row

    def fetchall(self):
        return list(self._rows)


class _InventoryAwareConnection:
    def __init__(self, delegate, state):
        self._delegate = delegate
        self._active_delegate = delegate
        self._state = state

    def __enter__(self):
        if hasattr(self._delegate, "__enter__"):
            self._active_delegate = self._delegate.__enter__()
        return self

    def __exit__(self, exc_type, exc, traceback):
        if hasattr(self._delegate, "__exit__"):
            return self._delegate.__exit__(exc_type, exc, traceback)
        return False

    def execute(self, sql, params=None):
        sql_text = " ".join(str(sql).split()).lower()
        normalized_params = dict(params or {})
        if "ignored_version_state as" in sql_text and "manual_version_state as" in sql_text:
            self._state["queries"].append(("support", sql_text, normalized_params))
            return _InventoryCursor(row={
                "ignored_version_keys": list(self._state["ignored_version_keys"]),
                "manual_version_links": dict(self._state["manual_version_links"]),
            })
        if "exception_candidates as" in sql_text and "ranked_exception_overrides as" in sql_text:
            self._state["queries"].append(("candidates", sql_text, normalized_params))
            return _InventoryCursor(rows=self._state["non_album_candidates"])
        if self._active_delegate is None:
            raise AssertionError(f"Unexpected non-inventory SQL: {sql_text[:160]}")
        return self._active_delegate.execute(sql, params)


@pytest.fixture(autouse=True)
def committed_inventory_queries_for_legacy_browse_fakes(monkeypatch):
    """Keep legacy browse fakes honest while production inventory SQL remains mandatory."""
    from music_app.services.library_inventory_postgres import PostgresLibraryInventoryRepository

    state = {
        "ignored_version_keys": [],
        "manual_version_links": {},
        "non_album_candidates": [],
        "queries": [],
    }
    original_init = PostgresLibraryInventoryRepository.__init__
    original_load_support_state = PostgresLibraryInventoryRepository.load_support_state
    original_load_non_album_candidates = PostgresLibraryInventoryRepository.load_non_album_candidates

    def inventory_init(self, config, *, connect=None):
        assert connect is not None

        def inventory_connect(database_url):
            return _InventoryAwareConnection(connect(database_url), state)

        original_init(self, config, connect=inventory_connect)

    def load_support_state(self, *, connection=None):
        if connection is None:
            return original_load_support_state(self)
        state["queries"].append(("support", "caller-owned snapshot", {}))
        return {
            "ignored_version_keys": list(state["ignored_version_keys"]),
            "manual_version_links": dict(state["manual_version_links"]),
        }

    def load_non_album_candidates(self, **kwargs):
        connection = kwargs.pop("connection", None)
        if connection is None:
            return original_load_non_album_candidates(self, **kwargs)
        state["queries"].append(("candidates", "caller-owned snapshot", dict(kwargs)))
        return list(state["non_album_candidates"])

    monkeypatch.setattr(PostgresLibraryInventoryRepository, "__init__", inventory_init)
    monkeypatch.setattr(PostgresLibraryInventoryRepository, "load_support_state", load_support_state)
    monkeypatch.setattr(
        PostgresLibraryInventoryRepository,
        "load_non_album_candidates",
        load_non_album_candidates,
    )
    return state


def _inventory_non_album_candidate(
    *,
    track_id: int,
    title: str,
    private_path: str,
    track_number: int,
    raw_artist: str = "Guest Vocalist",
    raw_album_artist: str = "Raw Album Credit",
    exception_type: str = "Non-album rarity",
):
    return {
        "track_id": track_id,
        "track_key": f"inventory-track-{track_id}",
        "track_title": f"Canonical {title}",
        "disc_number": 1,
        "track_number": track_number,
        "duration_seconds": 60 + track_id,
        "track_metadata": {"artist": "Canonical Track Artist", "year": 2004},
        "raw_track_album": "Canonical Album",
        "raw_track_album_artist": "Canonical Album Artist",
        "artist_id": 40,
        "artist_name": "Canonical Artist",
        "artist_sort_name": "Canonical Artist",
        "album_id": None,
        "album_title": None,
        "album_release_year": None,
        "album_cover_path": None,
        "album_metadata": {},
        "track_file_id": 1000 + track_id,
        "private_path": private_path,
        "relative_path": rf"Raw Album Credit\Loose\{Path(private_path).name}",
        "file_entry": {
            "year": "2004",
            "disc_number_raw": "01",
            "edition": "Raw Edition",
        },
        "raw_file_album": "!Non album",
        "raw_file_album_artist": raw_album_artist,
        "raw_file_artist": raw_artist,
        "raw_file_title": title,
        "root_id": 7,
        "library_root_category": "main_library",
        "exception_type": exception_type,
    }


def _browse_album_row(*, artist: str, album_id: int, album_key: str, title: str):
    return {
        "artist_id": album_id,
        "artist_name": artist,
        "artist_sort_name": artist,
        "album_id": album_id,
        "album_key": album_key,
        "album_title": title,
        "album_release_year": 2000 + album_id,
        "album_cover_path": None,
        "album_metadata": {"album_artist": artist, "artists": [artist]},
        "track_id": album_id * 100,
        "track_key": f"{album_key}-track",
        "track_title": f"{title} Track",
        "disc_number": 1,
        "track_number": 1,
        "duration_seconds": 90,
        "file_private_path": rf"D:\Music\{artist}\{title}\01.flac",
        "file_library_root_id": 1,
        "file_library_root_category": "main_library",
        "track_count": 1,
        "total_duration_seconds": 90,
    }


def _exception_album_row(
    *,
    track_id: int,
    track_key: str,
    title: str,
    track_number: int,
    duration_seconds: int,
    private_path: str,
    exception_type: str = "",
):
    file_entry = {
        "path": private_path,
        "album": "Exception Album",
        "album_artist": "Exception Artist",
        "artist": "Exception Artist",
        "title": title,
        "track_number": track_number,
        "year": "2026",
    }
    if exception_type:
        file_entry["exception_type"] = exception_type
    return {
        "artist_name": "Exception Artist",
        "artist_sort_name": "Exception Artist",
        "album_id": 601,
        "album_key": "exception-artist-exception-album",
        "album_title": "Exception Album",
        "album_release_year": 2026,
        "album_cover_path": "covers/exception.jpg",
        "album_metadata": {
            "album_artist": "Exception Artist",
            "artists": ["Exception Artist"],
        },
        "track_id": track_id,
        "track_key": track_key,
        "track_title": title,
        "disc_number": 1,
        "track_number": track_number,
        "duration_seconds": duration_seconds,
        "file_private_path": private_path,
        "file_library_root_id": 9,
        "file_library_root_category": "library",
        "file_entry": file_entry,
        "separate_release_keys": [],
    }


def _stub_windows_media_root(monkeypatch):
    from music_app.services import library_browse_postgres, non_album_view_payloads

    for module in (library_browse_postgres, non_album_view_payloads):
        monkeypatch.setattr(
            module,
            "configured_library_root_paths_snapshot",
            lambda _config, **_kwargs: (Path(r"D:\Music"),),
        )


def test_inventory_backed_root_sidebar_uses_visible_non_album_candidate_scope(
    monkeypatch,
    committed_inventory_queries_for_legacy_browse_fakes,
):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    inventory = committed_inventory_queries_for_legacy_browse_fakes
    inventory["ignored_version_keys"] = ["ignored-release"]
    inventory["manual_version_links"] = {"child-release": "parent-release"}
    inventory["non_album_candidates"] = [
        _inventory_non_album_candidate(
            track_id=1,
            title="Persisted Rarity",
            private_path=r"D:\Music\Raw Album Credit\Loose\01-rarity.flac",
            track_number=1,
        )
    ]
    _stub_windows_media_root(monkeypatch)
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(inventory),
    )
    monkeypatch.setattr(
        repository,
        "_load_root_startup_rows",
        lambda _state, _aliases, **_kwargs: ([], []),
    )

    payload = repository.build_root_sidebar_payload()

    assert payload["artists_sidebar"] == []
    assert payload["artist_groups"] == []
    assert payload["album_count"] == 0
    assert payload["artist_count"] == 0
    assert payload["ignored_version_keys"] == ["ignored-release"]
    assert payload["manual_version_links"] == {"child-release": "parent-release"}
    assert [track["title"] for track in payload["non_album_tracks"]] == [
        "Persisted Rarity"
    ]
    assert payload["non_album_exception_values"] == ["Interview", "Non-album rarity"]
    assert [kind for kind, _sql, _params in inventory["queries"]] == [
        "support",
        "candidates",
    ]


def test_inventory_backed_loose_track_reopen_honors_explicit_empty_exception_override(
    monkeypatch,
    committed_inventory_queries_for_legacy_browse_fakes,
):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    inventory = committed_inventory_queries_for_legacy_browse_fakes
    candidate = _inventory_non_album_candidate(
        track_id=2,
        title="Cleared Rarity",
        private_path=r"D:\Music\Raw Album Credit\Loose\02-cleared.flac",
        track_number=2,
        exception_type=None,
    )
    candidate["raw_file_album"] = ""
    candidate["file_entry"]["album"] = ""
    candidate["file_entry"]["exception_type"] = "Non-album rarity"
    candidate["exception_override_present"] = True
    inventory["non_album_candidates"] = [candidate]
    _stub_windows_media_root(monkeypatch)
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(inventory),
    )
    monkeypatch.setattr(
        repository,
        "_load_root_startup_rows",
        lambda _state, _aliases, **_kwargs: ([], []),
    )

    payload = repository.build_root_sidebar_payload()

    assert payload["non_album_tracks"][0]["exception_type"] == ""
    assert payload["non_album_tracks"][0]["reason_label"] == "Unmarked"


def test_inventory_backed_root_full_and_non_album_detail_preserve_raw_rows_and_exact_pseudo_key(
    monkeypatch,
    committed_inventory_queries_for_legacy_browse_fakes,
):
    from music_app.services import album_details
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    inventory = committed_inventory_queries_for_legacy_browse_fakes
    inventory["ignored_version_keys"] = ["ignored-release"]
    inventory["manual_version_links"] = {"child-release": "parent-release"}
    inventory["non_album_candidates"] = [
        _inventory_non_album_candidate(
            track_id=2,
            title="Zulu Raw Title",
            private_path=r"D:\Music\Raw Album Credit\Loose\02-zulu.flac",
            track_number=2,
            raw_artist="Guest Two",
        ),
        _inventory_non_album_candidate(
            track_id=1,
            title="Alpha Raw Title",
            private_path=r"D:\Music\Raw Album Credit\Loose\01-alpha.flac",
            track_number=1,
            raw_artist="Guest One",
        ),
    ]
    inventory["non_album_candidates"][0]["duration_seconds"] = Decimal("62.75")
    _stub_windows_media_root(monkeypatch)
    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "MUSIC_DIR": r"D:\Music",
        },
        connect=lambda _database_url: None,
    )
    monkeypatch.setattr(repository, "_load_root_album_browse_rows", lambda _state: [])
    monkeypatch.setattr(album_details, "_safe_scrobble_count_lookup", lambda _config, _refs: {})
    monkeypatch.setattr(
        album_details,
        "build_track_preference_overlay_lookup",
        lambda _config, **_kwargs: {},
    )

    payload = repository.build_root_album_browse_payload()

    assert payload["payload_tier"] == "full"
    assert payload["artists_sidebar"] == []
    assert payload["ignored_version_keys"] == ["ignored-release"]
    assert payload["manual_version_links"] == {"child-release": "parent-release"}
    assert payload["non_album_exception_values"] == ["Interview", "Non-album rarity"]
    assert [track["title"] for track in payload["non_album_tracks"]] == [
        "Alpha Raw Title",
        "Zulu Raw Title",
    ]
    assert [track["reason_label"] for track in payload["non_album_tracks"]] == [
        "Non-album rarity",
        "Non-album rarity",
    ]
    assert [track["display_path"] for track in payload["non_album_tracks"]] == [
        r"Raw Album Credit\Loose\01-alpha.flac",
        r"Raw Album Credit\Loose\02-zulu.flac",
    ]
    assert payload["non_album_tracks"][1]["duration_seconds"] == 62
    assert isinstance(payload["non_album_tracks"][1]["duration_seconds"], int)
    json.dumps(payload)

    pseudo_key = "non-album::raw album credit::type::non-album rarity::"
    detail = repository.build_non_album_detail_payload(pseudo_key)

    assert detail is not None
    assert detail["key"] == pseudo_key
    assert [track["title"] for track in detail["tracks"]] == [
        "Alpha Raw Title",
        "Zulu Raw Title",
    ]
    assert [track["artist"] for track in detail["tracks"]] == ["Guest One", "Guest Two"]
    assert [row["secondary_artist"] for row in detail["track_rows"]] == ["Guest One", "Guest Two"]
    assert detail["gallery_list_block"]["album_key"] == pseudo_key
    assert detail["gallery_list_block"]["track_rows"] == detail["track_rows"]
    assert repository.build_non_album_detail_payload(
        "non-album::raw album credit::type::missing::"
    ) is None
    assert repository.build_non_album_detail_payload("ordinary-album-key") is None

    query_kinds = [kind for kind, _sql, _params in inventory["queries"]]
    assert query_kinds == ["support", "candidates", "candidates", "candidates"]
    for kind, sql, params in inventory["queries"]:
        assert "musicbrainz" not in sql
        assert "lastfm" not in sql
        if kind == "candidates":
            assert params == {
                "track_ids": [],
                "track_id_count": 0,
                "private_paths": [],
                "private_path_count": 0,
                "limit": 5000,
            }


def test_selected_family_alias_chips_keep_independent_variations_with_constant_inventory_queries(
    monkeypatch,
    committed_inventory_queries_for_legacy_browse_fakes,
):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    inventory = committed_inventory_queries_for_legacy_browse_fakes
    inventory["non_album_candidates"] = [
        _inventory_non_album_candidate(
            track_id=index,
            title=f"Loose {index}",
            private_path=rf"D:\Music\Primary\Loose\{index}.flac",
            track_number=index,
            raw_album_artist="Primary Alias" if index % 2 else "Family Alias",
        )
        for index in range(1, 9)
    ]
    _stub_windows_media_root(monkeypatch)
    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "MUSIC_DIR": r"D:\Music",
        },
        connect=lambda _database_url: _NoopSearchSnapshotConnection(inventory),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    alias_maps = {
        "alias_to_canonical": {
            "Primary": "Primary",
            "Primary Alias": "Primary",
            "Family": "Family",
            "Family Alias": "Family",
        },
        "canonical_to_aliases": {
            "Primary": ["Primary", "Primary Alias"],
            "Family": ["Family", "Family Alias"],
        },
    }
    monkeypatch.setattr(repository, "_load_relation_alias_maps", lambda **_kwargs: alias_maps)
    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {"loaded": True, "family_artists": ["Family"]},
    )
    selected_calls = []
    family_calls = []
    monkeypatch.setattr(
        repository,
        "_load_selected_artist_rows",
        lambda artists, _state, **_kwargs: selected_calls.append(list(artists))
        or [_browse_album_row(artist="Primary Alias", album_id=1, album_key="primary", title="Primary")],
    )
    monkeypatch.setattr(
        repository,
        "_load_artist_preview_rows",
        lambda artists, _state, **_kwargs: family_calls.append(list(artists))
        or [_browse_album_row(artist="Family Alias", album_id=2, album_key="family", title="Family")],
    )

    payload = repository.build_selected_artist_payload(query_params={"artist": "Primary Alias"})

    assert selected_calls == [["Primary", "Primary Alias"]]
    assert family_calls == [["Primary", "Primary Alias", "Family", "Family Alias"]]
    assert payload["selected_artist"] == "Primary"
    assert [item["display_name"] for item in payload["artist_family_filters"]] == [
        "Primary",
        "Family",
    ]
    assert [item["variation_names"] for item in payload["artist_family_filters"]] == [
        ["Primary", "Primary Alias"],
        ["Family", "Family Alias"],
    ]
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Primary"]
    assert [group["artist"] for group in payload["family_artist_groups"]] == ["Family"]
    assert [kind for kind, _sql, _params in inventory["queries"]] == ["support", "candidates"]


def test_selected_collaboration_artist_keeps_distinct_family_chip_outside_primary_scope(
    monkeypatch,
    committed_inventory_queries_for_legacy_browse_fakes,
):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(
            committed_inventory_queries_for_legacy_browse_fakes
        ),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    alias_maps = {
        "alias_to_canonical": {
            "Neal Morse": "Neal Morse",
            "Neal Morse & The Resonance": "Neal Morse",
        },
        "canonical_to_aliases": {
            "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
        },
    }
    monkeypatch.setattr(repository, "_load_relation_alias_maps", lambda **_kwargs: alias_maps)
    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "loaded": True,
            "family_artists": ["Neal Morse & The Resonance"],
        },
    )
    selected_calls = []
    monkeypatch.setattr(
        repository,
        "_load_selected_artist_rows",
        lambda artists, _state, **_kwargs: selected_calls.append(list(artists))
        or [
            _browse_album_row(
                artist="Neal Morse",
                album_id=1,
                album_key="neal-solo",
                title="Neal Solo",
            )
        ],
    )
    monkeypatch.setattr(
        repository,
        "_load_artist_preview_rows",
        lambda *_args, **_kwargs: [
            _browse_album_row(
                artist="Neal Morse & The Resonance",
                album_id=2,
                album_key="no-hill-for-a-climber",
                title="No Hill For A Climber",
            )
        ],
    )

    payload = repository.build_selected_artist_payload(query_params={"artist": "Neal Morse"})

    assert selected_calls == [["Neal Morse"]]
    assert [item["display_name"] for item in payload["artist_family_filters"]] == [
        "Neal Morse",
        "Neal Morse & The Resonance",
    ]
    assert [item["family_tag_ref"] for item in payload["artist_family_filters"]] == [
        "artist-family:nealmorse",
        "artist-family:nealmorsetheresonance",
    ]
    assert [item["variation_names"] for item in payload["artist_family_filters"]] == [
        ["Neal Morse"],
        ["Neal Morse & The Resonance"],
    ]
    assert [group["artist"] for group in payload["family_artist_groups"]] == [
        "Neal Morse & The Resonance"
    ]
    assert payload["family_artist_groups"][0]["family_tag_ref"] == (
        "artist-family:nealmorsetheresonance"
    )


def test_inventory_backed_search_keeps_existing_selection_semantics_without_n_plus_one(
    monkeypatch,
    committed_inventory_queries_for_legacy_browse_fakes,
):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    inventory = committed_inventory_queries_for_legacy_browse_fakes
    inventory["non_album_candidates"] = [
        _inventory_non_album_candidate(
            track_id=index,
            title=f"Needle Loose {index}",
            private_path=rf"D:\Music\Broadcast\Loose\{index}.flac",
            track_number=index,
            raw_album_artist="Broadcast",
        )
        for index in range(1, 7)
    ]
    _stub_windows_media_root(monkeypatch)
    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "MUSIC_DIR": r"D:\Music",
        },
        connect=lambda _database_url: _NoopSearchSnapshotConnection(inventory),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(repository, "_load_exact_artist_match", lambda _query, _state, **_kwargs: "")
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda _query, _state, **_kwargs: [
            _browse_album_row(
                artist="Broadcast",
                album_id=3,
                album_key="needle-album",
                title="Needle Album",
            )
        ],
    )
    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {"loaded": True, "family_artists": []},
    )

    payload = repository.build_search_payload(query_params={"q": "needle", "surface": "albums"})

    assert payload["query"] == "needle"
    assert payload["selected_artist"] == "Broadcast"
    assert payload["all_artists_active"] is False
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Broadcast"]
    assert [track["title"] for track in payload["non_album_tracks"]] == [
        f"Needle Loose {index}" for index in range(1, 7)
    ]
    assert [kind for kind, _sql, _params in inventory["queries"]] == ["support", "candidates"]


def test_postgres_library_browse_builds_root_sidebar_payload_from_rows(monkeypatch):
    from music_app.services import covers as covers_module
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed_sql: list[str] = []
    preview_sql: list[str] = []
    queued_covers: list[tuple[str, str, int]] = []
    rating_loads: list[list[str]] = []
    connections = []
    monkeypatch.setattr(
        covers_module,
        "queue_cover_display_variant_generation",
        lambda source_path, *, cache_root, max_size: queued_covers.append(
            (Path(source_path).as_posix(), str(cache_root), max_size)
        ),
    )

    class FakeSidebarCursor:
        def fetchall(self):
            return [
                {"artist_id": 1, "artist_name": "Broadcast", "sort_name": "Broadcast", "album_ids": [101, 102], "album_count": 2},
                {"artist_id": 2, "artist_name": "Empty Indexed Artist", "sort_name": "Empty Indexed Artist", "album_count": 0},
                {"artist_id": 3, "artist_name": "Guest Singer", "sort_name": "Guest Singer", "album_ids": [301], "album_count": 1},
                {"artist_id": 4, "artist_name": "netherland dwarf", "sort_name": "Netherland Dwarf", "album_ids": [401], "album_count": 1},
                {"artist_id": 4, "artist_name": "Netherland Dwarf", "sort_name": "Netherland Dwarf", "album_ids": [402], "album_count": 1},
            ]

    class FakePreviewCursor:
        def fetchone(self):
            return {
                "root_sidebar_rows": FakeSidebarCursor().fetchall(),
                "preview_rows": self.fetchall(),
            }

        def fetchall(self):
            return [
                {
                    "artist_id": 1,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                        "tag_album_rating": 6,
                        "tag_album_rating_source": "file_tag",
                    },
                    "track_count": 2,
                    "total_duration_seconds": 316,
                },
                {
                    "artist_id": 3,
                    "artist_name": "Guest Singer",
                    "artist_sort_name": "Guest Singer",
                    "album_id": 301,
                    "album_key": "guest-singer-solo-debut",
                    "album_title": "Solo Debut",
                    "album_release_year": 2002,
                    "album_cover_path": None,
                    "album_metadata": {"album_artist": "Guest Singer", "artists": ["Guest Singer"]},
                    "track_count": 1,
                    "total_duration_seconds": 180,
                },
                {
                    "artist_id": 4,
                    "artist_name": "Netherland Dwarf",
                    "artist_sort_name": "Netherland Dwarf",
                    "album_id": 401,
                    "album_key": "netherland-dwarf-debut",
                    "album_title": "Debut",
                    "album_release_year": 2001,
                    "album_cover_path": None,
                    "album_metadata": {"album_artist": "Netherland Dwarf", "artists": ["Netherland Dwarf"]},
                    "track_count": 1,
                    "total_duration_seconds": 210,
                },
                {
                    "artist_id": 4,
                    "artist_name": "netherland dwarf",
                    "artist_sort_name": "Netherland Dwarf",
                    "album_id": 402,
                    "album_key": "netherland-dwarf-return",
                    "album_title": "Return",
                    "album_release_year": 2003,
                    "album_cover_path": None,
                    "album_metadata": {"album_artist": "Netherland Dwarf", "artists": ["Netherland Dwarf"]},
                    "track_count": 1,
                    "total_duration_seconds": 220,
                },
            ]

    class FakeConnection:
        def __init__(self):
            self.rollback_count = 0
            self.close_count = 0

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            sql_text = str(sql)
            if sql_text.startswith("SET TRANSACTION"):
                return FakeSidebarCursor()
            if "preview_artists as (" in sql_text:
                preview_sql.append(sql_text)
                preview_sql.append(params)
                return FakePreviewCursor()
            executed_sql.append(sql_text)
            executed_sql.append(params)
            return FakeSidebarCursor()

        def rollback(self):
            self.rollback_count += 1

        def close(self):
            self.close_count += 1

    def connect(_database_url):
        connection = FakeConnection()
        connections.append(connection)
        return connection

    class FakeAlbumRatingsService:
        def load_album_ratings(self, album_keys, *, connection=None):
            del connection
            rating_loads.append(list(album_keys))
            return {
                "broadcast-tender-buttons": {
                    "rating": 9,
                    "provenance": "explicit_import",
                }
            }

    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "DATA_DIR": r"C:\AlbumHavenData",
        },
        connect=connect,
        album_ratings_service=FakeAlbumRatingsService(),
    )

    payload = repository.build_root_sidebar_payload(
        query_params={
            "gallery_display": "list",
            "gallery_scale_percent": "130",
            "category": ["main_library", "new_arrivals"],
        },
    )

    assert payload["artists_sidebar"] == [
        {"artist": "Broadcast", "artist_display": "Broadcast", "count": 2},
        {"artist": "Guest Singer", "artist_display": "Guest Singer", "count": 1},
        {"artist": "Netherland Dwarf", "artist_display": "Netherland Dwarf", "count": 2},
    ]
    assert payload["album_count"] == 5
    assert payload["artist_count"] == 3
    assert payload["selected_artist"] == ""
    assert payload["all_artists_active"] is False
    assert payload["show_all_artists_sidebar_link"] is True
    assert payload["payload_tier"] == "sidebar"
    assert payload["surface"]["active"] == "albums"
    assert payload["shell_layout"]["slots"]["main_content"]["surface_ref"] == "albums"
    assert [group["artist"] for group in payload["artist_groups"]] == [
        "Broadcast",
        "Guest Singer",
        "Netherland Dwarf",
    ]
    assert payload["primary_artist_groups"] == payload["artist_groups"]
    assert payload["family_artist_groups"] == []
    assert payload["initial_view_partial"] is True
    assert payload["persistence_backend"] == "postgres"
    assert payload["persistence_seam"] == "library_browse"
    assert payload["view_data_source"] == "postgres_library_browse"
    assert payload["query"] == ""
    assert payload["search_filter_contract"]["fields"]["genre"]["param"] == "genre"
    assert payload["search_query_contract"]["grammar"]["field_terms"]["artist"]["availability"] == "shared"
    assert payload["gallery_scope"] == "all"
    assert payload["gallery_display_mode"] == "list"
    assert payload["gallery_scale_percent"] == 130
    assert payload["visible_library_categories"] == ["main_library", "new_arrivals"]
    assert payload["manual_version_links"] == {}
    assert payload["ignored_version_keys"] == []
    assert payload["viewer_opinion_preferences"]["preference_scope"] == "viewer_scoped"
    assert payload["popularity_browse"]["read_seam"]["source_kind"] == "lastfm_popularity_projection"
    preview_albums = [
        album
        for group in payload["artist_groups"]
        for album in group["albums"]
    ]
    tender_buttons = next(
        album for album in preview_albums
        if album["key"] == "broadcast-tender-buttons"
    )
    assert rating_loads == [[
        "broadcast-tender-buttons",
        "guest-singer-solo-debut",
        "netherland-dwarf-debut",
        "netherland-dwarf-return",
    ]]
    assert tender_buttons["tag_album_rating"] == 6
    assert tender_buttons["tag_album_rating_source"] == "file_tag"
    assert tender_buttons["album_preference"]["rating"] == 9
    assert tender_buttons["album_preference"]["provenance"] == "explicit_import"
    assert tender_buttons["album_preference"]["can_edit"] is True
    assert queued_covers == [(r"covers/tender.jpg", r"C:\AlbumHavenData", 480)]
    assert len(connections) == 1
    assert connections[0].rollback_count == 1
    assert connections[0].close_count == 1
    assert len(preview_sql) == 2
    sql = preview_sql[0]
    params = preview_sql[1]
    assert params == {
        "category_count": 2,
        "visible_categories": ["main_library", "new_arrivals"],
        "alias_to_canonical": "{}",
    }
    assert "library.local_artists" in sql
    assert "library.local_albums" in sql
    assert "library.local_album_featured_artists" in sql
    assert "join library.local_albums" in sql
    assert "root_provenance,primary_category" in sql
    assert "root_provenance,categories" in sql
    assert "'main_library' = any" in sql
    assert "library.libraries" in sql
    assert "preview_artists as (" in sql
    assert "canonical_artist_rank <= 6" in sql
    assert "dense_rank() over" in sql


def test_root_sidebar_defers_settings_projection_prewarm_until_after_database_work(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    events: list[str] = []

    class FakeCursor:
        def fetchall(self):
            return []

    class FakeConnection:
        def execute(self, _sql, _params=None):
            events.append("query")
            return FakeCursor()

        def rollback(self):
            events.append("rollback")

        def close(self):
            events.append("close")

    def connect(_database_url):
        events.append("connect")
        return FakeConnection()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=connect,
    )
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda **_kwargs: {"ignored_version_keys": [], "manual_version_links": {}},
    )
    monkeypatch.setattr(
        repository,
        "_load_root_startup_rows",
        lambda *_args, **_kwargs: ([], []),
    )
    monkeypatch.setattr(
        repository,
        "queue_settings_projection_prewarm",
        lambda: events.append("settings_prewarm"),
    )

    repository.build_root_sidebar_payload()

    assert events.count("settings_prewarm") == 1
    assert events.index("settings_prewarm") > events.index("query"), events
    assert events.index("settings_prewarm") > events.index("rollback"), events
    assert events.index("settings_prewarm") > events.index("close"), events


def test_postgres_root_sidebar_aggregates_distinct_artist_ids_through_persisted_alias_projection(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
    )
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: {
            "alias_to_canonical": {
                "Morse Portnoy George": "Morse Portnoy George",
                "Morse, Portnoy & George": "Morse Portnoy George",
            },
            "canonical_to_aliases": {
                "Morse Portnoy George": [
                    "Morse Portnoy George",
                    "Morse, Portnoy & George",
                ],
            },
        },
    )
    monkeypatch.setattr(
        repository,
        "_load_root_startup_rows",
        lambda _view_state, _aliases, **_kwargs: (
            [
                {"artist_id": 10, "artist_name": "Morse Portnoy George", "album_ids": [101], "album_count": 1},
                {"artist_id": 20, "artist_name": "Morse, Portnoy & George", "album_ids": [202], "album_count": 1},
            ],
            [],
        ),
    )

    payload = repository.build_root_sidebar_payload()

    assert payload["artists_sidebar"] == [
        {
            "artist": "Morse Portnoy George",
            "artist_display": "Morse Portnoy George",
            "count": 2,
        }
    ]
    assert payload["artist_count"] == 1
    assert payload["album_count"] == 2


def test_postgres_root_counts_preserve_alias_deduplication_and_category_filters(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
    )
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: {
            "alias_to_canonical": {
                "Morse Portnoy George": "Morse Portnoy George",
                "Morse, Portnoy & George": "Morse Portnoy George",
                "Larry Morey": "Larry Morey",
            },
            "canonical_to_aliases": {
                "Morse Portnoy George": [
                    "Morse Portnoy George",
                    "Morse, Portnoy & George",
                ],
                "Larry Morey": ["Larry Morey"],
            },
        },
    )

    def root_rows(view_state, **_kwargs):
        assert view_state["gallery_display_mode"] == "list"
        assert view_state["visible_library_categories"] == [
            "main_library",
            "new_arrivals",
        ]
        return [
            {
                "artist_id": 10,
                "artist_name": "Morse Portnoy George",
                "album_ids": [101, 102],
                "album_count": 2,
            },
            {
                "artist_id": 20,
                "artist_name": "Morse, Portnoy & George",
                "album_ids": [102, 103],
                "album_count": 2,
            },
            {
                "artist_id": 30,
                "artist_name": "Larry Morey",
                "album_ids": [104],
                "album_count": 1,
            },
        ]

    monkeypatch.setattr(repository, "_load_root_sidebar_rows", root_rows)
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("count-only reads must not load unrelated support state")
        ),
    )

    payload = repository.build_root_counts_payload(
        query_params={
            "gallery_display": "list",
            "category": ["main_library", "new_arrivals"],
        },
    )

    assert payload == {
        "artist_count": 2,
        "album_count": 4,
        "show_all_artists_sidebar_link": True,
    }


def test_postgres_root_sidebar_reads_one_repeatable_read_snapshot_and_rolls_it_back(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    connections = []
    read_connections = []

    class SnapshotConnection:
        def __init__(self):
            self.commands = []
            self.rollback_count = 0
            self.close_count = 0

        def execute(self, sql, params=None):
            self.commands.append((str(sql), dict(params or {})))
            return _InventoryCursor()

        def rollback(self):
            self.rollback_count += 1

        def close(self):
            self.close_count += 1

    def connect(_database_url):
        connection = SnapshotConnection()
        connections.append(connection)
        return connection

    class SnapshotAlbumRatingsService:
        def load_album_ratings(self, _album_keys, *, connection=None):
            read_connections.append(connection)
            return {}

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=connect,
        album_ratings_service=SnapshotAlbumRatingsService(),
    )

    def relation_alias_maps(*, connection):
        read_connections.append(connection)
        return {
            "alias_to_canonical": {
                "Canonical": "Canonical",
                "Alias": "Canonical",
            },
            "canonical_to_aliases": {"Canonical": ["Canonical", "Alias"]},
        }

    def support_state(*, connection):
        read_connections.append(connection)
        return {"ignored_version_keys": [], "manual_version_links": {}}

    def startup_rows(_view_state, _aliases, *, connection):
        read_connections.append(connection)
        return (
            [
                {"artist_id": 10, "artist_name": "Canonical", "album_ids": [101, 102], "album_count": 2},
                {"artist_id": 20, "artist_name": "Alias", "album_ids": [102, 103], "album_count": 2},
            ],
            [
                _browse_album_row(
                    artist="Canonical",
                    album_id=101,
                    album_key="canonical-album",
                    title="Canonical Album",
                ),
            ],
        )

    monkeypatch.setattr(repository, "_load_relation_alias_maps", relation_alias_maps)
    monkeypatch.setattr(repository._inventory_repository, "load_support_state", support_state)
    monkeypatch.setattr(repository, "_load_root_startup_rows", startup_rows)

    payload = repository.build_root_sidebar_payload()

    assert len(connections) == 1
    connection = connections[0]
    assert read_connections == [connection, connection, connection, connection]
    assert connection.commands == [
        ("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY", {}),
    ]
    assert connection.rollback_count == 1
    assert connection.close_count == 1
    assert payload["artists_sidebar"] == [
        {"artist": "Canonical", "artist_display": "Canonical", "count": 3},
    ]
    assert payload["artist_count"] == 1
    assert payload["album_count"] == 3


def test_postgres_root_sidebar_rolls_back_and_closes_when_snapshot_read_fails(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    class SnapshotConnection:
        def __init__(self):
            self.rollback_count = 0
            self.close_count = 0

        def execute(self, _sql, _params=None):
            return _InventoryCursor()

        def rollback(self):
            self.rollback_count += 1

        def close(self):
            self.close_count += 1

    connection = SnapshotConnection()
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
    )
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: {"alias_to_canonical": {}, "canonical_to_aliases": {}},
    )
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda **_kwargs: {"ignored_version_keys": [], "manual_version_links": {}},
    )
    def fail_preview(*_args, **_kwargs):
        raise RuntimeError("startup preview read failed")

    monkeypatch.setattr(repository, "_load_root_startup_rows", fail_preview)

    with pytest.raises(RuntimeError, match="startup preview read failed"):
        repository.build_root_sidebar_payload()

    assert connection.rollback_count == 1
    assert connection.close_count == 1


def test_postgres_library_browse_omits_category_filter_for_all_visible_categories():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    captured_params: list[dict[str, object]] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {"artist_name": "Broadcast", "sort_name": "Broadcast", "album_count": 2},
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, params=None):
            if str(_sql).startswith("SET TRANSACTION"):
                return FakeCursor()
            captured_params.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: FakeConnection(),
    )

    payload = repository.build_root_sidebar_payload()

    assert payload["visible_library_categories"] == ["main_library", "hoard", "new_arrivals"]
    assert captured_params == [
        {"category_count": 0, "visible_categories": [], "alias_to_canonical": "{}"},
    ]


def test_postgres_library_browse_builds_root_album_browse_payload_from_rows():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                        "root_provenance": {
                            "primary_category": "main_library",
                            "categories": ["main_library", "new_arrivals"],
                        },
                    },
                    "track_count": 2,
                    "total_duration_seconds": 316,
                },
                {
                    "artist_id": 11,
                    "artist_name": "Stereolab",
                    "artist_sort_name": "Stereolab",
                    "album_id": 102,
                    "album_key": "stereolab-dots-and-loops",
                    "album_title": "Dots and Loops",
                    "album_release_year": 1997,
                    "album_cover_path": None,
                    "album_metadata": {"album_artist": "Stereolab", "artists": ["Stereolab"]},
                    "track_count": 1,
                    "total_duration_seconds": 319,
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_root_album_browse_payload(
        query_params={
            "surface": "albums",
            "gallery_display": "list",
            "gallery_scale_percent": "125",
            "category": ["main_library", "new_arrivals"],
        },
    )

    assert payload["surface"]["active"] == "albums"
    assert payload["shell_layout"]["slots"]["main_content"]["surface_ref"] == "albums"
    assert payload["query"] == ""
    assert payload["selected_artist"] == ""
    assert payload["album_count"] == 2
    assert payload["artist_count"] == 2
    assert payload["payload_tier"] == "full"
    assert payload["persistence_backend"] == "postgres"
    assert payload["persistence_seam"] == "library_browse"
    assert payload["view_data_source"] == "postgres_library_browse"
    assert payload["gallery_display_mode"] == "list"
    assert payload["gallery_scale_percent"] == 125
    assert payload["visible_library_categories"] == ["main_library", "new_arrivals"]
    assert payload["family_artist_groups"] == []
    assert payload["related_artists"] == []
    assert payload["artist_family_filters"] == []
    assert payload["related_filter_artists"] == []
    assert payload["primary_filter_active"] is False
    assert payload["all_artists_active"] is False
    assert payload["listen_through_scope_candidates"] == {}
    assert payload["ignored_version_keys"] == []
    assert payload["manual_version_links"] == {}
    assert payload["non_album_tracks"] == []
    assert payload["non_album_exception_values"] == ["Interview", "Non-album rarity"]
    assert payload["viewer_opinion_preferences"]["preference_scope"] == "viewer_scoped"
    assert payload["popularity_browse"]["read_seam"]["source_kind"] == "lastfm_popularity_projection"
    assert [item["artist"] for item in payload["artists_sidebar"]] == ["Broadcast", "Stereolab"]
    assert [item["count"] for item in payload["artists_sidebar"]] == [1, 1]
    assert [group["artist"] for group in payload["artist_groups"]] == ["Broadcast", "Stereolab"]
    assert payload["primary_artist_groups"] == []
    broadcast_album = payload["artist_groups"][0]["albums"][0]
    assert broadcast_album["name"] == "Tender Buttons"
    assert broadcast_album["track_count_preview"] == 2
    assert broadcast_album["total_duration_display"] == "5m 16s"
    assert broadcast_album["preview_only"] is True
    assert "album_ref" not in broadcast_album
    assert "artists" not in broadcast_album
    assert "release_date" not in broadcast_album
    assert broadcast_album["edition"] is None
    assert "root_provenance" not in broadcast_album
    assert "total_duration_seconds" not in broadcast_album
    assert "tracks" not in broadcast_album
    assert "open_directory_paths" not in broadcast_album
    assert payload["artist_groups"][0]["sections"] == []

    assert executed[1] == {
        "category_count": 2,
        "visible_categories": ["main_library", "new_arrivals"],
    }
    sql = str(executed[0])
    compact_sql = " ".join(sql.split())
    assert "library.local_artists" in sql
    assert "library.local_albums" in sql
    assert "library.local_tracks" in sql
    assert "count(distinct eligible_album_tracks.track_id)::integer as track_count" in sql
    assert "coalesce(sum(eligible_album_tracks.duration_seconds), 0)::integer as total_duration_seconds" in sql
    assert "array_remove( array_agg(distinct" not in compact_sql
    assert "library.local_tracks.title as track_title" not in sql
    assert "root_provenance,primary_category" in sql
    assert "root_provenance,categories" in sql
    assert "library.libraries" in sql


def test_postgres_root_album_browse_payload_applies_category_filter_params():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    captured_params: list[dict[str, object]] = []

    class FakeCursor:
        def fetchall(self):
            return []

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, params=None):
            captured_params.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_root_album_browse_payload(query_params={"category": ["hoard"]})

    assert payload["album_count"] == 0
    assert payload["artist_count"] == 0
    assert payload["artist_groups"] == []
    assert payload["artists_sidebar"] == []
    assert captured_params == [{"category_count": 1, "visible_categories": ["hoard"]}]


def test_postgres_root_album_browse_groups_featured_artist_rows_by_identity_but_keeps_album_credit_text():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 40,
                    "artist_name": "guest singer",
                    "artist_sort_name": "Guest Singer",
                    "album_id": 401,
                    "album_key": "soundtrack-one",
                    "album_title": "Soundtrack One",
                    "album_release_year": 2002,
                    "album_cover_path": None,
                    "album_metadata": {
                        "album_artist": "Various Artists",
                        "artists": ["Various Artists", "Guest Singer"],
                    },
                    "track_count": 1,
                    "total_duration_seconds": 180,
                },
                {
                    "artist_id": 40,
                    "artist_name": "Guest Singer",
                    "artist_sort_name": "Guest Singer",
                    "album_id": 402,
                    "album_key": "soundtrack-two",
                    "album_title": "Soundtrack Two",
                    "album_release_year": 2004,
                    "album_cover_path": None,
                    "album_metadata": {
                        "album_artist": "Original Cast",
                        "artists": ["Original Cast", "Guest Singer"],
                    },
                    "track_count": 1,
                    "total_duration_seconds": 200,
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_root_album_browse_payload(query_params={"surface": "albums"})

    assert [group["artist"] for group in payload["artist_groups"]] == ["Guest Singer"]
    assert [album["album_artist"] for album in payload["artist_groups"][0]["albums"]] == [
        "Various Artists",
        "Original Cast",
    ]
    compact_sql = " ".join(str(executed[0]).split())
    assert "library.local_album_featured_artists.artist_id = library.local_artists.id" in compact_sql


def test_postgres_root_album_browse_payload_can_omit_sidebar():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {"album_artist": "Broadcast", "artists": ["Broadcast"]},
                    "track_count": 2,
                    "total_duration_seconds": 316,
                    "open_directory_paths": [r"D:\Music\Broadcast\Tender Buttons"],
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, _params=None):
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_root_album_browse_payload(
        query_params={
            "surface": "albums",
            "omit_sidebar": "1",
        },
    )

    assert payload["album_count"] == 1
    assert payload["artist_count"] == 1
    assert [group["artist"] for group in payload["artist_groups"]] == ["Broadcast"]
    assert "artists_sidebar" not in payload


def test_postgres_library_browse_builds_selected_artist_payload_from_direct_membership_rows():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                        "release_date": "2005-09-19",
                        "edition": "Warp",
                        "root_provenance": {
                            "primary_category": "main_library",
                            "categories": ["main_library"],
                        },
                    },
                    "track_id": 1001,
                    "track_key": "broadcast-tender-buttons-01",
                    "track_title": "I Found the F",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 145,
                    "file_private_path": r"D:\Music\Broadcast\Tender Buttons\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
                {
                    "artist_id": 10,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                        "release_date": "2005-09-19",
                        "edition": "Warp",
                        "root_provenance": {
                            "primary_category": "main_library",
                            "categories": ["main_library"],
                        },
                    },
                    "track_id": 1002,
                    "track_key": "broadcast-tender-buttons-02",
                    "track_title": "Black Cat",
                    "disc_number": 1,
                    "track_number": 2,
                    "duration_seconds": 171,
                    "file_private_path": r"D:\Music\Broadcast\Tender Buttons\02.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
                {
                    "artist_id": 10,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 102,
                    "album_key": "broadcast-noise-made-by-people",
                    "album_title": "The Noise Made by People",
                    "album_release_year": 2000,
                    "album_cover_path": None,
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                        "root_provenance": {
                            "primary_category": "main_library",
                            "categories": ["main_library"],
                        },
                    },
                    "track_id": 1003,
                    "track_key": "broadcast-noise-01",
                    "track_title": "Long Was the Year",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 215,
                    "file_private_path": r"D:\Music\Broadcast\Noise\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "MUSIC_DIR": r"D:\Music",
        },
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={
            "artist": "broadcast",
            "surface": "albums",
            "gallery_display": "list",
            "gallery_scale_percent": "125",
            "category": ["main_library"],
        },
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["album_count"] == 2
    assert payload["artist_count"] == 1
    assert payload["query"] == ""
    assert payload["payload_tier"] == "full"
    assert payload["persistence_backend"] == "postgres"
    assert payload["persistence_seam"] == "library_browse"
    assert payload["view_data_source"] == "postgres_library_browse"
    assert payload["gallery_display_mode"] == "list"
    assert payload["gallery_scale_percent"] == 125
    assert payload["visible_library_categories"] == ["main_library"]
    assert payload["related_artists"] == []
    assert payload["artist_family_filters"] == [{
        "family_tag_ref": "artist-family:broadcast",
        "display_name": "Broadcast",
        "variation_names": ["Broadcast"],
        "is_selected_artist": True,
    }]
    assert payload["related_filter_artists"] == []
    assert payload["primary_filter_active"] is False
    assert payload["family_artist_groups"] == []
    assert payload["non_album_tracks"] == []
    assert payload["listen_through_scope_candidates"]["artist"]["artist_ref"] == "Broadcast"
    assert payload["listen_through_scope_candidates"]["artist_family"]["selected_artist_ref"] == "Broadcast"
    assert payload["playback_context"] == {
        "kind": "artist_page",
        "end_behavior": "stop",
        "ordered_album_refs": [
            "broadcast-noise-made-by-people",
            "broadcast-tender-buttons",
        ],
        "albums": [
            {"album_ref": "broadcast-noise-made-by-people", "can_play": True},
            {"album_ref": "broadcast-tender-buttons", "can_play": True},
        ],
    }
    assert payload["artist_page"]["gallery_payload"]["artist_ref"] == "Broadcast"
    assert payload["artist_page"]["gallery_payload"]["artist_groups_field"] == "artist_groups"
    assert payload["artist_page"]["gallery_payload"]["playback_context_field"] == "playback_context"
    assert payload["artist_page"]["gallery_payload"]["listen_through_scope_candidates_field"] == (
        "listen_through_scope_candidates"
    )

    assert len(payload["artist_groups"]) == 1
    assert payload["primary_artist_groups"] == payload["artist_groups"]
    group = payload["artist_groups"][0]
    assert group["artist"] == "Broadcast"
    assert group["artist_display"] == "Broadcast"
    assert [album["name"] for album in group["albums"]] == [
        "The Noise Made by People",
        "Tender Buttons",
    ]
    first_album = group["albums"][0]
    assert first_album["key"] == "broadcast-noise-made-by-people"
    assert first_album["album_ref"] == "broadcast-noise-made-by-people"
    assert first_album["album_artist"] == "Broadcast"
    assert first_album["artists"] == ["Broadcast"]
    assert first_album["year"] == 2000
    assert first_album["root_provenance"]["primary_category"] == "main_library"
    assert first_album["library_root_id"] == 1
    assert first_album["library_root_category"] == "main_library"
    assert first_album["track_count_preview"] == 1
    assert first_album["total_duration_seconds"] == 215
    assert first_album["total_duration_display"] == "3m 35s"
    assert first_album["preview_only"] is False
    assert first_album["tracks"] == [
        {
            "key": "broadcast-noise-01",
                "track_ref": "broadcast-noise-01",
                "title": "Long Was the Year",
                "artist": "Broadcast",
                "album_artist": "Broadcast",
                "album": "The Noise Made by People",
                "secondary_credit": "",
                "genre": "",
                "year": 2000,
                "cover_path": None,
                "cover_revision": None,
                "disc_number": 1,
                "disc_number_raw": None,
            "track_number": 1,
            "duration_seconds": 215,
            "duration_display": "3m 35s",
                "path": r"D:\Music\Broadcast\Noise\01.flac",
                "track_scrobble_count": 0,
                "track_preference_overlay": {"rating": None, "love_tier": None},
                "is_problematic": False,
            }
        ]
    assert first_album["open_directory_paths"] == [r"D:\Music\Broadcast\Noise"]

    selected_query_index = next(
        index
        for index, value in enumerate(executed)
        if isinstance(value, dict) and "artist_keys" in value
    )
    assert executed[selected_query_index] == {
        "artist_keys": ["broadcast"],
        "category_count": 1,
        "visible_categories": ["main_library"],
    }
    sql = str(executed[selected_query_index - 1])
    assert "library.local_artists" in sql
    assert "library.local_albums" in sql
    assert "library.local_album_featured_artists" in sql
    assert "library.local_tracks" in sql
    assert "library.local_track_files" in sql
    assert "lower(library.local_artists.name)" not in sql
    assert "root_provenance,primary_category" in sql
    stale_predicate = (
        "coalesce((library.local_track_files.metadata #>> '{scan_cache,stale}')::boolean, false) is false"
    )
    assert sql.count(stale_predicate) == 1
    compact_sql = " ".join(sql.split())
    assert (
        "left join library.local_track_files on library.local_track_files.track_id = library.local_tracks.id "
        f"and {stale_predicate}"
    ) in compact_sql


def test_postgres_selected_artist_payload_uses_featured_artist_identity_but_keeps_album_artist_credit():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Folder Artist",
                    "artist_sort_name": "Folder Artist",
                    "album_id": 101,
                    "album_key": "compilation-one",
                    "album_title": "Compilation One",
                    "album_release_year": 2024,
                    "album_cover_path": None,
                    "album_metadata": {
                        "album_artist": "Various Artists",
                        "artists": ["Folder Artist"],
                    },
                    "track_id": 1001,
                    "track_key": "compilation-one-01",
                    "track_title": "Shared Track",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 61,
                    "file_private_path": r"D:\Music\Compilations\Compilation One\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "Folder Artist", "surface": "albums"},
    )

    assert payload["selected_artist"] == "Folder Artist"
    assert payload["artist_groups"][0]["artist"] == "Folder Artist"
    assert payload["artist_groups"][0]["albums"][0]["album_artist"] == "Various Artists"
    selected_query_index = next(
        index
        for index, value in enumerate(executed)
        if isinstance(value, dict) and "artist_keys" in value
    )
    assert executed[selected_query_index]["artist_keys"] == ["folder artist"]
    compact_sql = " ".join(str(executed[selected_query_index - 1]).split())
    assert "library.local_album_featured_artists.artist_id = target_artists.id" in compact_sql
    assert "where library.local_artists.artist_key = any(%(artist_keys)s::text[])" in compact_sql
    assert "lower(library.local_artists.name)" not in compact_sql


def test_postgres_selected_artist_expands_persisted_alias_projection_and_preserves_raw_credits(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    alias_maps = {
        "alias_to_canonical": {
            "Morse Portnoy George": "Morse Portnoy George",
            "Morse, Portnoy & George": "Morse Portnoy George",
        },
        "canonical_to_aliases": {
            "Morse Portnoy George": [
                "Morse Portnoy George",
                "Morse, Portnoy & George",
            ],
        },
    }
    monkeypatch.setattr(repository, "_load_relation_alias_maps", lambda **_kwargs: alias_maps)
    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {"loaded": True, "family_artists": []},
    )
    received_scopes = []

    def load_rows(selected_artists, _view_state, **_kwargs):
        received_scopes.append(list(selected_artists))
        return [
            {
                "artist_id": 10,
                "artist_name": "Morse Portnoy George",
                "artist_sort_name": "Morse Portnoy George",
                "album_id": 101,
                "album_key": "cover-to-cover",
                "album_title": "Cover to Cover",
                "album_release_year": 2006,
                "album_cover_path": None,
                "album_metadata": {
                    "album_artist": "Morse Portnoy George",
                    "artists": ["Morse Portnoy George"],
                },
                "track_id": 1001,
                "track_key": "cover-to-cover-01",
                "track_title": "First Cover",
                "disc_number": 1,
                "track_number": 1,
                "duration_seconds": 180,
                "file_private_path": r"D:\Music\Morse Portnoy George\Cover to Cover\01.flac",
                "file_library_root_id": 1,
                "file_library_root_category": "main_library",
                "file_entry": {},
            },
            {
                "artist_id": 20,
                "artist_name": "Morse, Portnoy & George",
                "artist_sort_name": "Morse, Portnoy & George",
                "album_id": 202,
                "album_key": "cover-2-cover",
                "album_title": "Cover 2 Cover",
                "album_release_year": 2012,
                "album_cover_path": None,
                "album_metadata": {
                    "album_artist": "Morse, Portnoy & George",
                    "artists": ["Morse, Portnoy & George"],
                },
                "track_id": 2001,
                "track_key": "cover-2-cover-01",
                "track_title": "Second Cover",
                "disc_number": 1,
                "track_number": 1,
                "duration_seconds": 181,
                "file_private_path": r"D:\Music\Morse, Portnoy & George\Cover 2 Cover\01.flac",
                "file_library_root_id": 1,
                "file_library_root_category": "main_library",
                "file_entry": {},
            },
        ]

    monkeypatch.setattr(repository, "_load_selected_artist_rows", load_rows)

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "morse, portnoy & george", "surface": "albums"},
    )

    assert received_scopes == [["Morse Portnoy George", "Morse, Portnoy & George"]]
    assert payload["selected_artist"] == "Morse Portnoy George"
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Cover to Cover",
        "Cover 2 Cover",
    ]
    assert [album["album_artist"] for album in payload["artist_groups"][0]["albums"]] == [
        "Morse Portnoy George",
        "Morse, Portnoy & George",
    ]


def test_postgres_selected_artist_preview_expands_aliases_in_one_query(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
    )
    alias_maps = {
        "alias_to_canonical": {"Alias": "Canonical", "Canonical": "Canonical"},
        "canonical_to_aliases": {"Canonical": ["Canonical", "Alias"]},
    }
    monkeypatch.setattr(repository, "_load_relation_alias_maps", lambda **_kwargs: alias_maps)
    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {"loaded": True, "family_artists": []},
    )
    scopes = []
    monkeypatch.setattr(
        repository,
        "_load_selected_artist_preview_rows",
        lambda artists, _state, **_kwargs: scopes.append(list(artists)) or [],
    )
    monkeypatch.setattr(
        repository,
        "_load_selected_artist_rows",
        lambda *_args, **_kwargs: pytest.fail("preview request used the full selected-artist query"),
    )
    monkeypatch.setattr(repository, "_load_search_rows", lambda *_args, **_kwargs: [])

    repository.build_selected_artist_payload(query_params={"artist": "Alias", "q": "Alias"})

    assert scopes == [["Canonical", "Alias"]]


def test_postgres_exact_alias_search_delegates_with_one_projection_load(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
    )
    alias_maps = {
        "alias_to_canonical": {"Alias": "Canonical"},
        "canonical_to_aliases": {"Canonical": ["Canonical", "Alias"]},
        "projection_stale_reason": "",
    }
    projection_loads = []
    delegated = []
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: projection_loads.append(True) or alias_maps,
    )
    monkeypatch.setattr(
        repository,
        "_load_exact_artist_match",
        lambda *_args, **_kwargs: pytest.fail("persisted exact alias fell through to SQL exact matching"),
    )
    monkeypatch.setattr(
        repository,
        "build_selected_artist_payload",
        lambda **kwargs: delegated.append(kwargs) or {
            "primary_artist_groups": [],
            "family_artist_groups": [],
        },
    )

    repository.build_search_payload(query_params={"q": "alias", "omit_sidebar": "1"})

    assert projection_loads == [True]
    assert delegated[0]["query_params"]["artist"] == "Canonical"
    assert delegated[0]["_relation_alias_maps"] == alias_maps
    assert isinstance(delegated[0]["_connection"], _NoopSearchSnapshotConnection)


def test_stale_projected_exact_alias_defers_to_current_exact_artist_sql(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    connection = _NoopSearchSnapshotConnection()
    exact_calls = []
    delegated = []
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
    )
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda *, connection=None: {
            "alias_to_canonical": {"Alias": "Stale Canonical"},
            "canonical_to_aliases": {
                "Stale Canonical": ["Stale Canonical", "Alias"],
            },
            "projection_stale_reason": "source_fingerprint_changed",
        },
    )
    monkeypatch.setattr(
        repository,
        "_load_exact_artist_match",
        lambda query, _state, *, connection=None: (
            exact_calls.append((query, connection)) or "Current Canonical"
        ),
    )
    monkeypatch.setattr(
        repository,
        "build_selected_artist_payload",
        lambda **kwargs: delegated.append(kwargs) or {
            "selected_artist": str(kwargs["query_params"]["artist"]),
            "primary_artist_groups": [],
            "family_artist_groups": [],
        },
    )

    payload = repository.build_search_payload(
        query_params={"q": "Alias", "omit_sidebar": "1"},
    )

    assert payload["selected_artist"] == "Current Canonical"
    assert exact_calls == [("Alias", connection)]
    assert delegated[0]["query_params"]["artist"] == "Current Canonical"
    assert delegated[0]["_connection"] is connection


@pytest.mark.parametrize(
    ("projection_case", "expected_stale_reason"),
    [
        ("current", ""),
        ("incomplete", "incomplete_projection"),
    ],
)
def test_relation_alias_loader_reports_persisted_projection_authority(
    projection_case,
    expected_stale_reason,
    default_empty_relation_alias_projection,
):
    from music_app.services.relation_projection_postgres import (
        RELATION_PROJECTION_BUILDER_VERSION,
    )
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    relation_views = {
        "artists": ["Canonical"],
        "artists_sidebar": [{"artist": "Canonical"}],
        "family_to_artists": {},
        "folder_related": {},
        "sidebar_families": [],
        "alias_to_canonical": {"Alias": "Canonical"},
        "canonical_to_aliases": {"Canonical": ["Canonical", "Alias"]},
    }
    if projection_case == "incomplete":
        relation_views.pop("artists_sidebar")
    scan_cache = {
        "relation_views": relation_views,
        "relation_projection": {
            "status": "ready",
            "builder_version": RELATION_PROJECTION_BUILDER_VERSION,
            "source_fingerprint": "same-source",
            "built_from_fingerprint": "same-source",
        },
    }
    sql_calls = []

    class ProjectionConnection:
        def execute(self, sql, params=None):
            sql_calls.append((str(sql), params))
            return _InventoryCursor(row={
                "relation_views": relation_views,
                "relation_projection": scan_cache["relation_projection"],
            })

    connection = ProjectionConnection()
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
    )

    result = default_empty_relation_alias_projection(
        repository,
        connection=connection,
    )

    assert result == {
        "alias_to_canonical": {"Alias": "Canonical"},
        "canonical_to_aliases": {"Canonical": ["Canonical", "Alias"]},
        "projection_stale_reason": expected_stale_reason,
    }
    assert len(sql_calls) == 1
    normalized_sql = " ".join(sql_calls[0][0].split()).lower()
    assert normalized_sql.count("'{scan_cache,relation_views}'") == 1
    assert normalized_sql.count("'{scan_cache,relation_projection}'") == 1
    assert "jsonb_build_object(" not in normalized_sql
    assert "alias_to_canonical" not in normalized_sql
    assert "canonical_to_aliases" not in normalized_sql
    assert "metadata -> 'scan_cache'" not in normalized_sql
    assert "as relation_views" in normalized_sql
    assert "as relation_projection" in normalized_sql


def test_complete_current_relation_projection_proves_non_exact_search_without_exact_sql(
    monkeypatch,
):
    from music_app.services import library_browse_postgres as browse_module
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    connection = _NoopSearchSnapshotConnection()
    seen: list[tuple[str, object]] = []
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda *, connection=None: seen.append(("aliases", connection))
        or {
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
            "projection_stale_reason": "",
        },
    )
    monkeypatch.setattr(
        repository,
        "_load_exact_artist_match",
        lambda *_args, **_kwargs: pytest.fail(
            "a complete current persisted projection proves this query has no exact artist"
        ),
    )
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda _query, _state, *, connection=None: seen.append(("search", connection))
        or [
            _browse_album_row(
                artist="Scan Artist 001",
                album_id=1,
                album_key="scan-artist-001-album-001",
                title="Album 001",
            )
        ],
    )
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda *, connection=None: seen.append(("support", connection))
        or {"ignored_version_keys": [], "manual_version_links": {}},
    )
    monkeypatch.setattr(
        browse_module,
        "_selected_artist_family_context_from_state",
        lambda *_args, connection=None, **_kwargs: seen.append(("family", connection))
        or {
            "family_artists": [],
            "relation_views": {},
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
        },
    )
    monkeypatch.setattr(repository, "_load_non_album_entries", lambda **_kwargs: [])
    monkeypatch.setattr(repository, "queue_settings_projection_prewarm", lambda: None)

    payload = repository.build_search_payload(
        query_params={"q": "Scan Artist 00", "surface": "albums"},
    )

    assert payload["query"] == "Scan Artist 00"
    assert [group["artist"] for group in payload["artist_groups"]] == [
        "Scan Artist 001"
    ]
    assert [name for name, _active_connection in seen] == [
        "aliases",
        "support",
        "search",
        "family",
    ]
    assert all(active_connection is connection for _name, active_connection in seen)


@pytest.mark.parametrize(
    "projection_stale_reason",
    [
        "missing_projection",
        "incomplete_projection",
        "missing_readiness_metadata",
        "projection_not_ready",
        "builder_version_changed",
        "source_fingerprint_changed",
    ],
)
def test_non_current_relation_projection_retains_exact_artist_sql_fallback(
    monkeypatch,
    projection_stale_reason,
):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    connection = _NoopSearchSnapshotConnection()
    exact_calls = []
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
    )
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda *, connection=None: {
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
            "projection_stale_reason": projection_stale_reason,
        },
    )
    monkeypatch.setattr(
        repository,
        "_load_exact_artist_match",
        lambda query, _state, *, connection=None: (
            exact_calls.append((query, connection)) or "Signal Artist"
        ),
    )
    monkeypatch.setattr(
        repository,
        "build_selected_artist_payload",
        lambda **kwargs: {
            "selected_artist": str(kwargs["query_params"]["artist"]),
            "primary_artist_groups": [],
            "family_artist_groups": [],
        },
    )

    payload = repository.build_search_payload(
        query_params={"q": "Signal Artist", "omit_sidebar": "1"},
    )

    assert payload["selected_artist"] == "Signal Artist"
    assert exact_calls == [("Signal Artist", connection)]


def test_postgres_exact_search_reuses_sidebar_rows_for_selected_preview(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
    )
    search_rows = [{
        "artist_id": 1,
        "artist_name": "Signal Artist",
        "artist_sort_name": "Signal Artist",
        "album_id": 10,
        "album_key": "signal-artist::signal-album",
        "album_title": "Signal Album",
        "album_metadata": {"album_artist": "Signal Artist"},
    }, {
        "artist_id": 2,
        "artist_name": "Outside Match",
        "artist_sort_name": "Outside Match",
        "album_id": 20,
        "album_key": "outside-match::signal-song",
        "album_title": "Signal Song",
        "album_metadata": {"album_artist": "Outside Match"},
    }]
    delegated = []
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: {"alias_to_canonical": {}, "canonical_to_aliases": {}},
    )
    monkeypatch.setattr(
        repository,
        "_load_exact_artist_match",
        lambda *_args, **_kwargs: "Signal Artist",
    )
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda *_args, **_kwargs: search_rows,
    )
    monkeypatch.setattr(
        repository,
        "build_selected_artist_payload",
        lambda **kwargs: delegated.append(kwargs) or {
            "selected_artist": "Signal Artist",
            "primary_artist_groups": [{"artist": "Signal Artist", "albums": []}],
            "family_artist_groups": [{"artist": "Signal Family", "albums": []}],
            "related_filter_base_primary_groups": [{"artist": "Signal Artist", "albums": []}],
            "related_filter_base_family_groups": [{"artist": "Signal Family", "albums": []}],
            "search_context": {},
        },
    )

    payload = repository.build_search_payload(query_params={"q": "Signal Artist"})

    preview_rows = delegated[0]["_selected_artist_preview_rows"]
    assert len(preview_rows) == 1
    assert preview_rows[0]["artist_name"] == "Signal Artist"
    assert preview_rows[0]["album_key"] == "signal-artist::signal-album"
    assert payload["family_artist_groups"] == []
    assert [group["artist"] for group in payload["related_filter_base_family_groups"]] == [
        "Signal Family"
    ]
    assert [group["artist"] for group in payload["artist_groups"]] == ["Signal Artist"]
    assert [item["artist"] for item in payload["artists_sidebar"]] == [
        "Signal Artist",
        "Outside Match",
    ]


def test_postgres_exact_alias_search_does_not_reuse_partial_sidebar_rows_for_selected_preview(
    monkeypatch,
):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
    )
    alias_maps = {
        "alias_to_canonical": {
            "Morse Portnoy George": "Morse Portnoy George",
            "Morse, Portnoy & George": "Morse Portnoy George",
        },
        "canonical_to_aliases": {
            "Morse Portnoy George": [
                "Morse Portnoy George",
                "Morse, Portnoy & George",
            ],
        },
        "projection_stale_reason": "",
    }
    delegated = []
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: alias_maps,
    )
    monkeypatch.setattr(
        repository,
        "_load_exact_artist_match",
        lambda *_args, **_kwargs: pytest.fail(
            "The persisted alias projection must resolve the exact canonical artist."
        ),
    )
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda *_args, **_kwargs: [{
            "artist_id": 1,
            "artist_name": "Morse Portnoy George",
            "album_id": 10,
            "album_key": "cover-to-cover",
            "album_title": "Cover to Cover",
            "album_metadata": {"album_artist": "Morse Portnoy George"},
        }],
    )
    monkeypatch.setattr(
        repository,
        "build_selected_artist_payload",
        lambda **kwargs: delegated.append(kwargs) or {
            "primary_artist_groups": [],
            "family_artist_groups": [],
        },
    )

    repository.build_search_payload(query_params={"q": "Morse Portnoy George"})

    assert delegated[0]["_selected_artist_preview_rows"] is None


def test_postgres_exact_search_without_sidebar_keeps_the_selected_preview_query(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
    )
    delegated = []
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: {"alias_to_canonical": {}, "canonical_to_aliases": {}},
    )
    monkeypatch.setattr(
        repository,
        "_load_exact_artist_match",
        lambda *_args, **_kwargs: "Signal Artist",
    )
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("omit_sidebar exact search must not load the broader search projection")
        ),
    )
    monkeypatch.setattr(
        repository,
        "build_selected_artist_payload",
        lambda **kwargs: delegated.append(kwargs) or {
            "primary_artist_groups": [],
            "family_artist_groups": [],
        },
    )

    repository.build_search_payload(
        query_params={"q": "Signal Artist", "omit_sidebar": "1"}
    )

    assert delegated[0]["_selected_artist_preview_rows"] is None

def test_postgres_family_preview_expands_family_alias_filter_with_same_maps(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
    )
    alias_maps = {
        "alias_to_canonical": {
            "Selected": "Selected",
            "Family Alias": "Family Canonical",
            "Family Canonical": "Family Canonical",
        },
        "canonical_to_aliases": {
            "Selected": ["Selected"],
            "Family Canonical": ["Family Canonical", "Family Alias"],
        },
    }
    monkeypatch.setattr(repository, "_load_relation_alias_maps", lambda **_kwargs: alias_maps)
    monkeypatch.setattr(repository, "_load_selected_artist_rows", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "loaded": True,
            "family_artists": ["Selected", "Family Alias"],
        },
    )
    family_scopes = []
    monkeypatch.setattr(
        repository,
        "_load_artist_preview_rows",
        lambda artists, _state, **_kwargs: family_scopes.append(list(artists)) or [],
    )

    repository.build_selected_artist_payload(query_params={"artist": "Selected"})

    assert family_scopes == [["Family Canonical", "Family Alias"]]


def test_postgres_root_sidebar_deduplicates_shared_alias_album_ids(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
    )
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: {
            "alias_to_canonical": {"Alias": "Canonical", "Canonical": "Canonical"},
            "canonical_to_aliases": {"Canonical": ["Canonical", "Alias"]},
        },
    )
    monkeypatch.setattr(
        repository,
        "_load_root_startup_rows",
        lambda *_args, **_kwargs: (
            [
                {"artist_id": 1, "artist_name": "Canonical", "album_ids": [10, 20], "album_count": 2},
                {"artist_id": 2, "artist_name": "Alias", "album_ids": [20, 30], "album_count": 2},
            ],
            [],
        ),
    )

    payload = repository.build_root_sidebar_payload()

    assert payload["artists_sidebar"][0]["count"] == 3
    assert payload["album_count"] == 3


@pytest.mark.parametrize(
    ("stored_origin", "expected_origin"),
    [("user", "user"), ("automatic", "automatic"), ("unknown", None)],
)
def test_root_album_browse_payload_exposes_normalized_cover_selection_origin(
    stored_origin,
    expected_origin,
):
    from music_app.services.library_browse_postgres import (
        _root_album_browse_album_payloads,
    )

    albums = _root_album_browse_album_payloads(
        [{
            "album_id": 41,
            "album_key": "artist::album",
            "album_title": "Album",
            "album_release_year": 2026,
            "album_cover_path": "C:/Music/Artist/Album/cover.jpg",
            "album_metadata": {
                "album_artist": "Artist",
                "cover_selection_origin": stored_origin,
            },
            "track_count": 1,
            "total_duration_seconds": 120,
        }],
        "Artist",
    )

    assert albums[0]["cover_selection_origin"] == expected_origin


@pytest.mark.parametrize("search_kind", ["automatic", "manual"])
def test_root_album_browse_payload_keeps_unseen_cover_improvement_across_search_kinds(
    search_kind,
):
    from music_app.services.library_browse_postgres import (
        _root_album_browse_album_payloads,
        _root_album_browse_sql,
    )

    albums = _root_album_browse_album_payloads(
        [{
            "album_id": 41,
            "album_key": "artist::album",
            "album_title": "Album",
            "album_release_year": 2026,
            "album_cover_path": "C:/Music/Artist/Album/cover.jpg",
            "album_metadata": {"album_artist": "Artist"},
            "cover_candidate_snapshot": {
                "search_kind": search_kind,
                "automatic_improvement_revision": 5,
                "seen_automatic_improvement_revision": 4,
            },
            "track_count": 1,
            "total_duration_seconds": 120,
        }],
        "Artist",
    )

    assert albums[0]["cover_candidate_snapshot"] == {
        "search_kind": search_kind,
        "automatic_improvement_revision": 5,
        "seen_automatic_improvement_revision": 4,
        "has_unseen_automatic_improvement": True,
    }
    assert albums[0]["album_id"] == 41
    sql = _root_album_browse_sql()
    assert "local_album_cover_candidate_snapshots" in sql
    assert sql.rfind("left join library.local_album_cover_candidate_snapshots") > sql.rfind(
        "from album_rows"
    )


def test_postgres_root_full_alias_group_deduplicates_album_and_global_count(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: None,
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: {
            "alias_to_canonical": {"Alias": "Canonical", "Canonical": "Canonical"},
            "canonical_to_aliases": {"Canonical": ["Canonical", "Alias"]},
        },
    )
    base = {
        "album_title": "Shared",
        "album_release_year": 2020,
        "album_cover_path": None,
        "track_count": 1,
        "total_duration_seconds": 60,
        "album_metadata": {"album_artist": "Alias"},
    }
    monkeypatch.setattr(
        repository,
        "_load_root_album_browse_rows",
        lambda _state: [
            {**base, "artist_id": 1, "artist_name": "Canonical", "album_id": 10, "album_key": "shared"},
            {**base, "artist_id": 2, "artist_name": "Alias", "album_id": 10, "album_key": "shared"},
            {**base, "artist_id": 1, "artist_name": "Canonical", "album_id": 20, "album_key": "other", "album_title": "Other"},
        ],
    )

    payload = repository.build_root_album_browse_payload()

    assert payload["artist_count"] == 1
    assert payload["album_count"] == 2
    assert [album["key"] for album in payload["artist_groups"][0]["albums"]] == ["other", "shared"]


def test_postgres_root_browse_preserves_collaboration_owner_and_folds_ordinary_alias(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    alias_maps = {
        "alias_to_canonical": {
            "Neal Morse": "Neal Morse",
            "Neal Morse & The Resonance": "Neal Morse",
            "Signal": "Signal",
            "Signal Alias": "Signal",
        },
        "canonical_to_aliases": {
            "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
            "Signal": ["Signal", "Signal Alias"],
        },
    }
    monkeypatch.setattr(repository, "_load_relation_alias_maps", lambda **_kwargs: alias_maps)
    monkeypatch.setattr(
        repository,
        "_load_root_startup_rows",
        lambda *_args, **_kwargs: (
            [
                {"artist_id": 1, "artist_name": "Neal Morse", "album_ids": [10], "album_count": 1},
                {
                    "artist_id": 2,
                    "artist_name": "Neal Morse & The Resonance",
                    "album_ids": [20],
                    "album_count": 1,
                },
                {"artist_id": 3, "artist_name": "Signal", "album_ids": [30], "album_count": 1},
                {"artist_id": 4, "artist_name": "Signal Alias", "album_ids": [40], "album_count": 1},
            ],
            [],
        ),
    )

    sidebar_payload = repository.build_root_sidebar_payload()

    assert sidebar_payload["artists_sidebar"] == [
        {"artist": "Neal Morse", "artist_display": "Neal Morse", "count": 1},
        {
            "artist": "Neal Morse & The Resonance",
            "artist_display": "Neal Morse & The Resonance",
            "count": 1,
        },
        {"artist": "Signal", "artist_display": "Signal", "count": 2},
    ]
    assert sidebar_payload["artist_count"] == 3
    assert sidebar_payload["album_count"] == 4

    def album_row(artist_id, artist_name, album_id, album_key):
        return {
            "artist_id": artist_id,
            "artist_name": artist_name,
            "album_id": album_id,
            "album_key": album_key,
            "album_title": album_key.replace("-", " ").title(),
            "album_release_year": 2020,
            "album_cover_path": None,
            "track_count": 1,
            "total_duration_seconds": 60,
            "album_metadata": {"album_artist": artist_name},
        }

    monkeypatch.setattr(
        repository,
        "_load_root_album_browse_rows",
        lambda _state: [
            album_row(1, "Neal Morse", 10, "neal-solo"),
            album_row(2, "Neal Morse & The Resonance", 20, "resonance-collaboration"),
            album_row(3, "Signal", 30, "signal-canonical"),
            album_row(4, "Signal Alias", 40, "signal-alias"),
        ],
    )

    full_payload = repository.build_root_album_browse_payload()

    assert [group["artist"] for group in full_payload["artist_groups"]] == [
        "Neal Morse",
        "Neal Morse & The Resonance",
        "Signal",
    ]
    assert {
        group["artist"]: [album["key"] for album in group["albums"]]
        for group in full_payload["artist_groups"]
    } == {
        "Neal Morse": ["neal-solo"],
        "Neal Morse & The Resonance": ["resonance-collaboration"],
        "Signal": ["signal-alias", "signal-canonical"],
    }
    assert full_payload["artists_sidebar"] == [
        {"artist": "Neal Morse", "artist_display": "Neal Morse", "count": 1},
        {
            "artist": "Neal Morse & The Resonance",
            "artist_display": "Neal Morse & The Resonance",
            "count": 1,
        },
        {"artist": "Signal", "artist_display": "Signal", "count": 2},
    ]
    assert full_payload["artist_count"] == 3
    assert full_payload["album_count"] == 4


def test_root_startup_payload_keeps_full_library_eligibility_at_album_grain():
    from music_app.services.library_browse_postgres import _root_startup_payload_sql

    compact_sql = " ".join(_root_startup_payload_sql(6).split())
    assert "eligible_album_ids as materialized (" in compact_sql
    album_eligibility_sql = compact_sql.split(
        "eligible_album_ids as materialized (",
        1,
    )[1].split(
        "), artist_album_rows as materialized (",
        1,
    )[0]

    assert "select distinct library.local_tracks.library_id, library.local_tracks.album_id" in album_eligibility_sql
    assert "library.local_tracks.id as track_id" not in album_eligibility_sql
    assert "max(library.local_tracks.duration_seconds)" not in album_eligibility_sql
    assert "join eligible_album_ids" in compact_sql


def test_root_startup_payload_limits_track_rollups_to_matched_preview_albums():
    from music_app.services.library_browse_postgres import _root_startup_payload_sql

    compact_sql = " ".join(_root_startup_payload_sql(6).split())
    assert "preview_eligible_album_tracks as materialized (" in compact_sql
    preview_eligibility_sql = compact_sql.split(
        "preview_eligible_album_tracks as materialized (",
        1,
    )[1].split(
        "), track_rollups as (",
        1,
    )[0]

    assert "join matched_album_rows" in preview_eligibility_sql
    assert "library.local_tracks.id as track_id" in preview_eligibility_sql
    assert "max(library.local_tracks.duration_seconds) as duration_seconds" in preview_eligibility_sql
    track_rollup_sql = compact_sql.split(
        "), track_rollups as (",
        1,
    )[1].split(
        "), preview_rows as (",
        1,
    )[0]
    assert "from preview_eligible_album_tracks" in track_rollup_sql
    assert "join matched_album_rows" not in track_rollup_sql


def test_root_startup_payload_preserves_override_precedence_for_both_eligibility_tiers():
    from music_app.services.library_browse_postgres import _root_startup_payload_sql

    compact_sql = " ".join(_root_startup_payload_sql(6).lower().split())

    assert compact_sql.count("library.local_track_files.scan_cache_stale is false") == 2
    assert compact_sql.count("left join library.exception_overrides as path_override") == 2
    assert compact_sql.count("left join track_override_defaults as track_override") == 2
    assert compact_sql.count("and path_override.id is null") == 2
    assert compact_sql.count("when path_override.override_payload ? 'exception_type'") == 2
    assert compact_sql.count("when track_override.override_payload ? 'exception_type'") == 2
    assert compact_sql.count("<> 'non-album rarity'") == 2


def test_root_startup_payload_keeps_canonical_ranking_and_one_snapshot_json_result():
    from music_app.services.library_browse_postgres import _root_startup_payload_sql

    compact_sql = " ".join(_root_startup_payload_sql(6).split())

    assert "dense_rank() over" in compact_sql
    assert "canonical_artist_rank <= 6" in compact_sql
    assert "canonical_artist_sort_values as (" in compact_sql
    assert "min(coalesce(nullif(visible_artists.artist_sort_name, ''), visible_artists.canonical_artist_name)) as canonical_sort_name" in compact_sql
    assert "lower(canonical_artist_sort_values.canonical_sort_name)" in compact_sql
    assert "ranked_canonical_artists.canonical_artist_name = visible_artists.canonical_artist_name" in compact_sql
    assert "limit 6" not in compact_sql
    assert "to_jsonb(root_sidebar_rows)" in compact_sql
    assert "to_jsonb(preview_rows)" in compact_sql


def test_postgres_selected_artist_payload_applies_category_filter_params():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    captured_params: list[dict[str, object]] = []

    class FakeCursor:
        def fetchall(self):
            return []

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, params=None):
            captured_params.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "Broadcast", "category": ["hoard"]},
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["album_count"] == 0
    assert payload["artist_count"] == 0
    assert payload["artist_groups"] == []
    assert next(params for params in captured_params if "artist_keys" in params) == {
        "artist_keys": ["broadcast"],
        "category_count": 1,
        "visible_categories": ["hoard"],
    }


def test_postgres_library_browse_builds_direct_album_search_payload():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                    },
                    "track_id": 1001,
                    "track_key": "broadcast-tender-buttons-01",
                    "track_title": "I Found the F",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 145,
                    "file_private_path": r"D:\Music\Broadcast\Tender Buttons\01 - I Found the F.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
                {
                    "artist_id": 11,
                    "artist_name": "Tender Forever",
                    "artist_sort_name": "Tender Forever",
                    "album_id": 102,
                    "album_key": "tender-forever-no-snare",
                    "album_title": "No Snare",
                    "album_release_year": 2010,
                    "album_cover_path": None,
                    "album_metadata": {},
                    "track_id": 1002,
                    "track_key": "tender-forever-no-snare-01",
                    "track_title": "Tiny Heart",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 60,
                    "file_private_path": r"D:\Music\Tender Forever\No Snare\01 - Tiny Heart.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )

    payload = repository.build_search_payload(
        query_params={
            "surface": "albums",
            "q": "tender",
            "gallery_display": "list",
            "category": ["main_library"],
        },
    )

    assert payload["query"] == "tender"
    assert payload["selected_artist"] == "Tender Forever"
    assert payload["all_artists_active"] is False
    assert payload["primary_filter_active"] is False
    assert payload["payload_tier"] == "full"
    assert payload["persistence_backend"] == "postgres"
    assert payload["persistence_seam"] == "library_browse"
    assert payload["view_data_source"] == "postgres_library_browse"
    assert payload["gallery_display_mode"] == "list"
    assert payload["visible_library_categories"] == ["main_library"]
    assert payload["related_artists"] == []
    assert payload["family_artist_groups"] == []
    assert payload["artist_family_filters"] == [{
        "family_tag_ref": "artist-family:tenderforever",
        "display_name": "Tender Forever",
        "variation_names": ["Tender Forever"],
        "is_selected_artist": True,
    }]
    assert payload["related_filter_artists"] == []
    assert payload["listen_through_scope_candidates"]["artist"]["artist_ref"] == "Tender Forever"
    assert payload["listen_through_scope_candidates"]["artist_family"]["selected_artist_ref"] == "Tender Forever"
    assert payload["non_album_tracks"] == []
    assert payload["album_count"] == 1
    assert payload["artist_count"] == 2
    assert [group["artist"] for group in payload["artist_groups"]] == ["Tender Forever"]
    assert payload["primary_artist_groups"] == payload["artist_groups"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == ["No Snare"]
    assert payload["artists_sidebar"] == [
        {"artist": "Tender Forever", "artist_display": "Tender Forever", "count": 1},
        {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
    ]
    assert payload["search_context"] == {
        "transport": "view_data",
        "response_kind": "legacy_artist_gallery",
        "committed_query": "tender",
        "result_surface": {
            "kind": "grouped_artist_results",
            "group_order": ["direct_matches", "related_matches"],
            "default_selection_behavior": "explicit_result_selection",
        },
        "result_groups": {
            "direct_matches": ["Tender Forever", "Broadcast"],
            "related_matches": [],
        },
        "search_filters": payload["search_filters"],
        "selected_artist": "Tender Forever",
        "selected_artist_source": "auto_top_match",
        "direct_match_artists": ["Tender Forever", "Broadcast"],
        "related_match_artists": [],
    }

    assert str(executed[0]).strip() == "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
    assert executed[3] == {
        "artist_name": "tender",
        "artist_key": "tender",
        "category_count": 1,
        "visible_categories": ["main_library"],
    }
    assert executed[5] == {
        "query_like": "%tender%",
        "category_count": 1,
        "visible_categories": ["main_library"],
    }
    sql = str(executed[4])
    assert "visible_album_ids as materialized" in sql.lower()
    assert "matched_album_ids as materialized" in sql.lower()
    assert "lower(btrim(coalesce(library.local_albums.title, ''))) like lower(%(query_like)s)" in sql
    assert "lower(btrim(coalesce(library.local_artists.name, ''))) like lower(%(query_like)s)" in sql
    assert (
        "lower(btrim(coalesce(library.local_albums.metadata ->> 'album_artist', ''))) "
        "like lower(%(query_like)s)"
    ) in sql
    assert "lower(btrim(coalesce(library.local_tracks.title, ''))) like lower(%(query_like)s)" in sql
    assert "like lower(%(query_like)s)" in sql
    assert "regexp_replace(" in sql
    stale_predicate = (
        "coalesce((library.local_track_files.metadata #>> '{scan_cache,stale}')::boolean, false) is false"
    )
    assert sql.count(stale_predicate) == 1
    compact_sql = " ".join(sql.split())
    assert "from file_name_matches join library.local_tracks" in compact_sql
    assert "library.local_artists.id = library.local_album_featured_artists.artist_id" in compact_sql


def test_postgres_direct_search_queues_visible_covers_before_family_and_non_album_work(monkeypatch):
    from music_app.services import library_browse_postgres as browse_module

    events: list[str] = []
    queue_limits: list[int] = []
    queue_priorities: list[str] = []
    original_search_artist_groups = browse_module._search_artist_groups

    def record_search_artist_groups(rows, *, query=""):
        events.append("search_artist_groups")
        return original_search_artist_groups(rows, query=query)

    def record_cover_queue(
        _config,
        _artist_groups,
        *,
        limit=browse_module._DISPLAY_COVER_QUEUE_LIMIT,
        priority="background",
    ):
        events.append("cover_queue")
        queue_limits.append(limit)
        queue_priorities.append(priority)

    def record_family_projection(*_args, **_kwargs):
        events.append("family_projection")
        return {
            "family_artists": [],
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
        }

    repository = browse_module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: None,
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: {"alias_to_canonical": {}, "canonical_to_aliases": {}},
    )
    monkeypatch.setattr(repository, "_load_exact_artist_match", lambda *_args, **_kwargs: "")
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda *_args, **_kwargs: [
            _browse_album_row(
                artist="Broadcast",
                album_id=10,
                album_key="broadcast-tender-buttons",
                title="Tender Buttons",
            )
        ],
    )
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda **_kwargs: {"ignored_version_keys": [], "manual_version_links": {}},
    )
    monkeypatch.setattr(
        repository,
        "_load_non_album_entries",
        lambda **_kwargs: events.append("non_album") or [],
    )
    monkeypatch.setattr(repository, "queue_settings_projection_prewarm", lambda: events.append("settings_prewarm"))
    monkeypatch.setattr(browse_module, "_search_artist_groups", record_search_artist_groups)
    monkeypatch.setattr(browse_module, "_queue_display_cover_variants_for_groups", record_cover_queue)
    monkeypatch.setattr(browse_module, "_selected_artist_family_context_from_state", record_family_projection)

    payload = repository._build_search_payload_from_snapshot(
        query_params={"surface": "albums", "q": "tender"},
        connection=object(),
    )

    assert payload["query"] == "tender"
    first_queue_index = events.index("cover_queue")
    assert first_queue_index == events.index("search_artist_groups") + 1
    assert first_queue_index < events.index("family_projection")
    assert first_queue_index < events.index("non_album")
    assert events.count("cover_queue") == 2
    assert queue_limits == [1, browse_module._DISPLAY_COVER_QUEUE_LIMIT]
    assert queue_priorities == ["interactive", "background"]
    assert events[-2:] == ["cover_queue", "settings_prewarm"]


def test_postgres_search_payload_groups_featured_artist_results_without_rewriting_album_artist_credit():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 20,
                    "artist_name": "Guest Singer",
                    "artist_sort_name": "Guest Singer",
                    "album_id": 103,
                    "album_key": "primary-artist-collab-record",
                    "album_title": "Collab Record",
                    "album_release_year": 2024,
                    "album_cover_path": None,
                    "album_metadata": {
                        "album_artist": "Primary Artist",
                        "artists": ["Primary Artist", "Guest Singer"],
                    },
                    "track_id": 2001,
                    "track_key": "collab-record-01",
                    "track_title": "Guest Spotlight",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 180,
                    "file_private_path": r"D:\Music\Primary Artist\Collab Record\01 - Guest Spotlight.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )

    payload = repository.build_search_payload(
        query_params={"surface": "albums", "q": "guest", "category": ["main_library"]},
    )

    assert [group["artist"] for group in payload["artist_groups"]] == ["Guest Singer"]
    assert payload["artist_groups"][0]["albums"][0]["album_artist"] == "Primary Artist"
    assert payload["search_context"]["direct_match_artists"] == ["Guest Singer"]
    compact_sql = " ".join(str(executed[4]).split())
    assert "library.local_artists.id = library.local_album_featured_artists.artist_id" in compact_sql


def test_postgres_selected_artist_payload_prefers_family_projection_table(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services import library_browse_postgres as library_browse_postgres_module

    PostgresLibraryBrowseRepository = library_browse_postgres_module.PostgresLibraryBrowseRepository

    projection_connectors: list[object] = []

    def fake_load_selected_artist_family_projection(config, selected_artist, **kwargs):
        projection_connectors.append(kwargs.get("connect"))
        return {
            "family_artists": ["Trish Keenan", "James Cargill"],
            "relations_last_built": 0.0,
            "loaded": True,
        }

    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        fake_load_selected_artist_family_projection,
    )
    class FakeCursor:
        def fetchone(self):
            return None

        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                    },
                    "track_id": 1001,
                    "track_key": "broadcast-tender-buttons-01",
                    "track_title": "I Found the F",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 145,
                    "file_private_path": r"D:\Music\Broadcast\Tender Buttons\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                }
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            return FakeCursor()

    def fake_connect(_database_url):
        return FakeConnection()

    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "MUSIC_DIR": r"D:\Music",
        },
        connect=fake_connect,
        album_ratings_service=_EmptyAlbumRatingsService(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "broadcast", "surface": "albums"},
        library_state={"relation_views": {}},
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_artists"] == []
    assert projection_connectors == [fake_connect]


def test_postgres_selected_artist_payload_builds_family_groups_from_projection_names(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda config, selected_artist, **_kwargs: {
            "family_artists": ["Trish Keenan", "James Cargill"],
            "relations_last_built": 0.0,
            "loaded": True,
        },
    )

    primary_rows = [
        {
            "artist_id": 10,
            "artist_name": "Broadcast",
            "artist_sort_name": "Broadcast",
            "album_id": 101,
            "album_key": "broadcast-tender-buttons",
            "album_title": "Tender Buttons",
            "album_release_year": 2005,
            "album_cover_path": "covers/tender.jpg",
            "album_metadata": {
                "album_artist": "Broadcast",
                "artists": ["Broadcast"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_id": 1001,
            "track_key": "broadcast-tender-buttons-01",
            "track_title": "I Found the F",
            "disc_number": 1,
            "track_number": 1,
            "duration_seconds": 145,
            "file_private_path": r"D:\Music\Broadcast\Tender Buttons\01.flac",
            "file_library_root_id": 1,
            "file_library_root_category": "main_library",
        },
    ]
    family_rows = [
        {
            "artist_id": 11,
            "artist_name": "Trish Keenan",
            "artist_sort_name": "Trish Keenan",
            "album_id": 201,
            "album_key": "trish-keenan-test-album",
            "album_title": "Test Family Album",
            "album_release_year": 2010,
            "album_cover_path": "covers/trish.jpg",
            "album_metadata": {
                "album_artist": "Trish Keenan",
                "artists": ["Trish Keenan"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_count": 8,
            "total_duration_seconds": 1800,
        },
        {
            "artist_id": 12,
            "artist_name": "James Cargill",
            "artist_sort_name": "James Cargill",
            "album_id": 202,
            "album_key": "james-cargill-test-album",
            "album_title": "Another Family Album",
            "album_release_year": 2012,
            "album_cover_path": "covers/james.jpg",
            "album_metadata": {
                "album_artist": "James Cargill",
                "artists": ["James Cargill"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_count": 6,
            "total_duration_seconds": 1500,
        },
    ]

    class FakeCursor:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return list(self._rows)

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            if params and "artist_names" in params:
                return FakeCursor(family_rows)
            return FakeCursor(primary_rows)

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "broadcast", "surface": "albums"},
        library_state={"relation_views": {}},
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_artists"] == ["Trish Keenan", "James Cargill"]
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Broadcast"]
    assert [group["artist"] for group in payload["family_artist_groups"]] == ["Trish Keenan", "James Cargill"]
    assert payload["payload_tier"] == "full"
    assert payload["primary_artist_groups"][0]["albums"][0]["preview_only"] is False
    assert all(
        album["preview_only"] is True
        for group in payload["family_artist_groups"]
        for album in group["albums"]
    )
    assert [group["artist"] for group in payload["artist_groups"]] == [
        "Broadcast",
        "Trish Keenan",
        "James Cargill",
    ]
    assert [item["display_name"] for item in payload["artist_family_filters"]] == [
        "Broadcast",
        "Trish Keenan",
        "James Cargill",
    ]
    assert payload["listen_through_scope_candidates"]["artist"]["artist_ref"] == "Broadcast"
    assert payload["listen_through_scope_candidates"]["artist_family"]["selected_artist_ref"] == "Broadcast"


def test_postgres_selected_artist_payload_keeps_family_group_when_album_artist_style_differs(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda config, selected_artist, **_kwargs: {
            "family_artists": ["Emerson, Lake & Palmer", "Emerson, Lake & Powell"],
            "relations_last_built": 100.0,
            "loaded": True,
            "alias_to_canonical": {
                "3": "3",
                "Emerson, Lake & Palmer": "Emerson, Lake & Palmer",
                "Emerson, Lake & Powell": "Emerson, Lake & Powell",
            },
            "canonical_to_aliases": {
                "3": ["3"],
                "Emerson, Lake & Palmer": ["Emerson, Lake & Palmer"],
                "Emerson, Lake & Powell": ["Emerson, Lake & Powell"],
            },
        },
    )

    primary_rows = [
        {
            "artist_id": 3,
            "artist_name": "3",
            "artist_sort_name": "3",
            "album_id": 301,
            "album_key": "3::to-the-power-of-three",
            "album_title": "To The Power Of Three",
            "album_release_year": 1988,
            "album_cover_path": "covers/3.jpg",
            "album_metadata": {
                "album_artist": "3",
                "artists": ["3"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_id": 30101,
            "track_key": "3::to-the-power-of-three::01",
            "track_title": "Talkin' Bout",
            "disc_number": 1,
            "track_number": 1,
            "duration_seconds": 226,
            "file_private_path": r"D:\Music\3\To The Power Of Three\01.flac",
            "file_library_root_id": 1,
            "file_library_root_category": "main_library",
            "file_entry": {},
            "track_count": 8,
            "total_duration_seconds": 2267,
        },
    ]
    family_rows = [
        {
            "artist_id": 30,
            "artist_name": "Emerson, Lake & Palmer",
            "artist_sort_name": "Emerson, Lake & Palmer",
            "album_id": 401,
            "album_key": "emerson-lake-palmer::tarkus",
            "album_title": "Tarkus",
            "album_release_year": 1971,
            "album_cover_path": "covers/tarkus.jpg",
            "album_metadata": {
                "album_artist": "Emerson Lake & Palmer",
                "artists": ["Emerson, Lake & Palmer"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_count": 7,
            "total_duration_seconds": 2300,
        },
        {
            "artist_id": 30,
            "artist_name": "Emerson, Lake & Palmer",
            "artist_sort_name": "Emerson, Lake & Palmer",
            "album_id": 402,
            "album_key": "emerson-lake-palmer::trilogy",
            "album_title": "Trilogy",
            "album_release_year": 1972,
            "album_cover_path": "covers/trilogy.jpg",
            "album_metadata": {
                "album_artist": "Emerson, Lake & Palmer",
                "artists": ["Emerson, Lake & Palmer"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_count": 9,
            "total_duration_seconds": 2500,
        },
        {
            "artist_id": 31,
            "artist_name": "Emerson, Lake & Powell",
            "artist_sort_name": "Emerson, Lake & Powell",
            "album_id": 501,
            "album_key": "emerson-lake-powell::emerson-lake-powell",
            "album_title": "Emerson, Lake & Powell",
            "album_release_year": 1986,
            "album_cover_path": "covers/powell.jpg",
            "album_metadata": {
                "album_artist": "Emerson, Lake & Powell",
                "artists": ["Emerson, Lake & Powell"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_count": 8,
            "total_duration_seconds": 2200,
        },
    ]

    class FakeCursor:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return list(self._rows)

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, params=None):
            if params and "artist_names" in params:
                return FakeCursor(family_rows)
            return FakeCursor(primary_rows)

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "3", "surface": "albums"},
        library_state={"relation_views": {}},
    )

    assert payload["selected_artist"] == "3"
    assert payload["related_artists"] == ["Emerson, Lake & Palmer", "Emerson, Lake & Powell"]
    assert [item["display_name"] for item in payload["artist_family_filters"]] == [
        "3",
        "Emerson, Lake & Palmer",
        "Emerson, Lake & Powell",
    ]
    assert [group["artist"] for group in payload["family_artist_groups"]] == [
        "Emerson, Lake & Palmer",
        "Emerson, Lake & Powell",
    ]
    assert [group["artist_display"] for group in payload["family_artist_groups"]] == [
        "Emerson, Lake & Palmer",
        "Emerson, Lake & Powell",
    ]
    assert [group["family_tag_ref"] for group in payload["family_artist_groups"]] == [
        "artist-family:emersonlakepalmer",
        "artist-family:emersonlakepowell",
    ]
    assert [len(group["albums"]) for group in payload["family_artist_groups"]] == [2, 1]
    assert [group["artist"] for group in payload["artist_groups"]] == [
        "3",
        "Emerson, Lake & Palmer",
        "Emerson, Lake & Powell",
    ]
    assert payload["album_count"] == 4


def test_postgres_selected_artist_payload_filters_family_groups_from_query_params(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda config, selected_artist, **_kwargs: {
            "family_artists": ["Trish Keenan", "James Cargill"],
            "relations_last_built": 0.0,
            "loaded": True,
            "alias_to_canonical": {
                "Broadcast": "Broadcast",
                "Trish Keenan": "Trish Keenan",
                "James Cargill": "James Cargill",
            },
            "canonical_to_aliases": {
                "Broadcast": ["Broadcast"],
                "Trish Keenan": ["Trish Keenan"],
                "James Cargill": ["James Cargill"],
            },
        },
    )

    primary_rows = [
        {
            "artist_id": 10,
            "artist_name": "Broadcast",
            "artist_sort_name": "Broadcast",
            "album_id": 101,
            "album_key": "broadcast-tender-buttons",
            "album_title": "Tender Buttons",
            "album_release_year": 2005,
            "album_cover_path": "covers/tender.jpg",
            "album_metadata": {
                "album_artist": "Broadcast",
                "artists": ["Broadcast"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_id": 1001,
            "track_key": "broadcast-tender-buttons-01",
            "track_title": "I Found the F",
            "disc_number": 1,
            "track_number": 1,
            "duration_seconds": 145,
            "file_private_path": r"D:\Music\Broadcast\Tender Buttons\01.flac",
            "file_library_root_id": 1,
            "file_library_root_category": "main_library",
        },
    ]
    family_rows = [
        {
            "artist_id": 11,
            "artist_name": "Trish Keenan",
            "artist_sort_name": "Trish Keenan",
            "album_id": 201,
            "album_key": "trish-keenan-test-album",
            "album_title": "Test Family Album",
            "album_release_year": 2010,
            "album_cover_path": "covers/trish.jpg",
            "album_metadata": {
                "album_artist": "Trish Keenan",
                "artists": ["Trish Keenan"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_count": 8,
            "total_duration_seconds": 1800,
        },
        {
            "artist_id": 12,
            "artist_name": "James Cargill",
            "artist_sort_name": "James Cargill",
            "album_id": 202,
            "album_key": "james-cargill-test-album",
            "album_title": "Another Family Album",
            "album_release_year": 2012,
            "album_cover_path": "covers/james.jpg",
            "album_metadata": {
                "album_artist": "James Cargill",
                "artists": ["James Cargill"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_count": 6,
            "total_duration_seconds": 1500,
        },
    ]

    class FakeCursor:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return list(self._rows)

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            if params and "artist_names" in params:
                return FakeCursor(family_rows)
            return FakeCursor(primary_rows)

    def fake_connect(_database_url):
        return FakeConnection()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=fake_connect,
    )

    payload = repository.build_selected_artist_payload(
        query_params={
            "artist": "broadcast",
            "surface": "albums",
            "related_artist": ["James Cargill"],
        },
        library_state={"relation_views": {}},
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_artists"] == ["Trish Keenan", "James Cargill"]
    assert [
        family_filter["display_name"]
        for family_filter in payload["artist_family_filters"]
    ] == ["Broadcast", "Trish Keenan", "James Cargill"]
    assert payload["related_filter_artists"] == ["James Cargill"]
    assert payload["primary_filter_active"] is False
    assert payload["primary_artist_groups"] == []
    assert [group["artist"] for group in payload["family_artist_groups"]] == [
        "James Cargill",
    ]
    assert [group["artist"] for group in payload["related_filter_base_primary_groups"]] == [
        "Broadcast"
    ]
    assert [group["artist"] for group in payload["related_filter_base_family_groups"]] == [
        "Trish Keenan",
        "James Cargill",
    ]
    assert [group["artist"] for group in payload["artist_groups"]] == ["James Cargill"]


def test_postgres_selected_artist_payload_primary_filter_hides_family_groups_when_no_related_artist(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda config, selected_artist, **_kwargs: {
            "family_artists": ["Trish Keenan"],
            "relations_last_built": 0.0,
            "loaded": True,
            "alias_to_canonical": {
                "Broadcast": "Broadcast",
                "Trish Keenan": "Trish Keenan",
            },
            "canonical_to_aliases": {
                "Broadcast": ["Broadcast"],
                "Trish Keenan": ["Trish Keenan"],
            },
        },
    )

    primary_rows = [
        {
            "artist_id": 10,
            "artist_name": "Broadcast",
            "artist_sort_name": "Broadcast",
            "album_id": 101,
            "album_key": "broadcast-tender-buttons",
            "album_title": "Tender Buttons",
            "album_release_year": 2005,
            "album_cover_path": "covers/tender.jpg",
            "album_metadata": {
                "album_artist": "Broadcast",
                "artists": ["Broadcast"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_id": 1001,
            "track_key": "broadcast-tender-buttons-01",
            "track_title": "I Found the F",
            "disc_number": 1,
            "track_number": 1,
            "duration_seconds": 145,
            "file_private_path": r"D:\Music\Broadcast\Tender Buttons\01.flac",
            "file_library_root_id": 1,
            "file_library_root_category": "main_library",
        },
    ]
    family_rows = [
        {
            "artist_id": 11,
            "artist_name": "Trish Keenan",
            "artist_sort_name": "Trish Keenan",
            "album_id": 201,
            "album_key": "trish-keenan-test-album",
            "album_title": "Test Family Album",
            "album_release_year": 2010,
            "album_cover_path": "covers/trish.jpg",
            "album_metadata": {
                "album_artist": "Trish Keenan",
                "artists": ["Trish Keenan"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_count": 8,
            "total_duration_seconds": 1800,
        },
    ]

    class FakeCursor:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return list(self._rows)

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            if params and "artist_names" in params:
                return FakeCursor(family_rows)
            return FakeCursor(primary_rows)

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={
            "artist": "broadcast",
            "surface": "albums",
            "primary_filter": "1",
        },
        library_state={"relation_views": {}},
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_filter_artists"] == []
    assert payload["primary_filter_active"] is True
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Broadcast"]
    assert payload["family_artist_groups"] == []
    assert [group["artist"] for group in payload["related_filter_base_primary_groups"]] == [
        "Broadcast"
    ]
    assert [group["artist"] for group in payload["related_filter_base_family_groups"]] == [
        "Trish Keenan"
    ]
    assert [group["artist"] for group in payload["artist_groups"]] == ["Broadcast"]


def test_postgres_selected_artist_payload_does_not_repair_loaded_empty_projection_from_runtime_cache(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services import library_browse_postgres as library_browse_postgres_module

    PostgresLibraryBrowseRepository = library_browse_postgres_module.PostgresLibraryBrowseRepository

    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda config, selected_artist, **_kwargs: {
            "family_artists": [],
            "relations_last_built": 0.0,
            "loaded": True,
        },
    )
    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                    },
                    "track_id": 1001,
                    "track_key": "broadcast-tender-buttons-01",
                    "track_title": "I Found the F",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 180,
                    "file_private_path": r"D:\Music\Broadcast\Tender Buttons\01 - I Found the F.mp3",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, params=None):
            requested_artists = list((params or {}).get("artist_names") or [])
            if requested_artists == ["The Focus Group"]:
                return type("FamilyCursor", (), {
                    "fetchall": lambda self: [
                        {
                            "artist_id": 11,
                            "artist_name": "The Focus Group",
                            "artist_sort_name": "The Focus Group",
                            "album_id": 202,
                            "album_key": "the-focus-group-sketches",
                            "album_title": "Sketches and Spells",
                            "album_release_year": 2005,
                            "album_cover_path": "covers/focus-group.jpg",
                            "album_metadata": {
                                "album_artist": "The Focus Group",
                                "artists": ["The Focus Group"],
                            },
                            "track_id": 2001,
                            "track_key": "the-focus-group-sketches-01",
                            "track_title": "Intro",
                            "disc_number": 1,
                            "track_number": 1,
                            "duration_seconds": 120,
                            "file_private_path": r"D:\Music\The Focus Group\Sketches and Spells\01 - Intro.mp3",
                            "file_library_root_id": 1,
                            "file_library_root_category": "main_library",
                        },
                    ]
                })()
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "broadcast", "surface": "albums"},
        library_state={"relation_views": {}},
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_artists"] == []
    assert payload["family_artist_groups"] == []
    assert [item["display_name"] for item in payload["artist_family_filters"]] == ["Broadcast"]
def test_postgres_selected_artist_payload_omit_sidebar_uses_persisted_projection_without_runtime_cache(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services import library_browse_postgres as library_browse_postgres_module

    PostgresLibraryBrowseRepository = library_browse_postgres_module.PostgresLibraryBrowseRepository

    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda config, selected_artist, **_kwargs: {
            "family_artists": [],
            "relations_last_built": 0.0,
            "loaded": True,
        },
    )
    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                    },
                    "track_id": 1001,
                    "track_key": "broadcast-tender-buttons-01",
                    "track_title": "I Found the F",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 180,
                    "file_private_path": r"D:\Music\Broadcast\Tender Buttons\01 - I Found the F.mp3",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, _params=None):
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "broadcast", "surface": "albums", "omit_sidebar": "1"},
        library_state={"relation_views": {}},
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_artists"] == []
    assert payload["family_artist_groups"] == []
    assert "artists_sidebar" not in payload


def test_postgres_selected_artist_payload_preserves_query_context():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "БИ-2",
                    "artist_sort_name": "БИ-2",
                    "album_id": 101,
                    "album_key": "bi2-allitluia",
                    "album_title": "Аллилуйя",
                    "album_release_year": 2022,
                    "album_cover_path": "covers/bi2.jpg",
                    "album_metadata": {
                        "album_artist": "БИ-2",
                        "artists": ["БИ-2"],
                    },
                    "track_id": 1001,
                    "track_key": "bi2-allitluia-01",
                    "track_title": "Пекло",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 220,
                    "file_private_path": r"D:\Music\BI-2\Аллилуйя\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, params=None):
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={"surface": "albums", "q": "Ария", "artist": "БИ-2", "omit_sidebar": "1"},
        library_state={},
    )

    assert payload["query"] == "Ария"
    assert payload["selected_artist"] == "БИ-2"
    assert payload["artist_groups"] == []
    assert len(payload["primary_artist_groups"]) == 1
    assert payload["primary_artist_groups"][0]["albums"][0]["preview_only"] is True
    assert "tracks" not in payload["primary_artist_groups"][0]["albums"][0]
    assert payload["search_context"]["committed_query"] == "Ария"
    assert payload["search_context"]["selected_artist"] == "БИ-2"
    assert payload["search_context"]["selected_artist_source"] == "requested_artist"


def test_postgres_selected_artist_query_context_rebuilds_filtered_family_sidebar(monkeypatch):
    from music_app.services import library_browse_postgres as browse_module

    primary_row = _browse_album_row(
        artist="Neal Morse",
        album_id=1,
        album_key="neal-morse-one",
        title="One",
    )
    family_row = _browse_album_row(
        artist="The Neal Morse Band",
        album_id=2,
        album_key="neal-morse-band-similitude",
        title="The Similitude of a Dream",
    )
    monkeypatch.setattr(
        browse_module,
        "_selected_artist_family_context_from_state",
        lambda *_args, **_kwargs: {
            "family_artists": ["The Neal Morse Band"],
            "alias_to_canonical": {
                "Neal Morse": "Neal Morse",
                "The Neal Morse Band": "The Neal Morse Band",
            },
            "canonical_to_aliases": {
                "Neal Morse": ["Neal Morse"],
                "The Neal Morse Band": ["The Neal Morse Band"],
            },
        },
    )
    repository = browse_module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda **_kwargs: {"ignored_version_keys": [], "manual_version_links": {}},
    )
    monkeypatch.setattr(
        repository,
        "_load_selected_artist_preview_rows",
        lambda *_args, **_kwargs: [primary_row],
    )
    monkeypatch.setattr(
        repository,
        "_load_artist_preview_rows",
        lambda *_args, **_kwargs: [family_row],
    )

    search_calls = []

    def load_search_rows(query, _view_state, **_kwargs):
        search_calls.append(query)
        return [primary_row, family_row]

    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        load_search_rows,
    )
    monkeypatch.setattr(repository, "_load_non_album_entries", lambda **_kwargs: [])
    monkeypatch.setattr(repository, "queue_settings_projection_prewarm", lambda: None)

    payload = repository.build_selected_artist_payload(
        query_params={
            "surface": "albums",
            "q": "neal morse",
            "artist": "Neal Morse",
        },
        library_state={},
    )

    assert payload["selected_artist"] == "Neal Morse"
    assert payload["primary_filter_active"] is False
    assert [group["artist"] for group in payload["family_artist_groups"]] == [
        "The Neal Morse Band"
    ]
    assert [group["artist"] for group in payload["related_filter_base_primary_groups"]] == [
        "Neal Morse"
    ]
    assert [group["artist"] for group in payload["related_filter_base_family_groups"]] == [
        "The Neal Morse Band"
    ]
    assert [item["display_name"] for item in payload["artist_family_filters"]] == [
        "Neal Morse",
        "The Neal Morse Band",
    ]
    assert [item["artist"] for item in payload["artists_sidebar"]] == [
        "Neal Morse",
        "The Neal Morse Band",
    ]
    assert payload["artist_count"] == 2
    assert payload["show_all_artists_sidebar_link"] is False
    assert search_calls == ["neal morse"]


def test_postgres_selected_artist_query_context_preserves_explicit_collaboration_selection(monkeypatch):
    from music_app.services import library_browse_postgres as browse_module

    collaboration_artist = "Neal Morse & The Resonance"
    selected_artist_preview_scopes: list[list[str]] = []
    canonical_row = _browse_album_row(
        artist="Neal Morse",
        album_id=1,
        album_key="neal-morse-one",
        title="One",
    )
    collaboration_row = _browse_album_row(
        artist=collaboration_artist,
        album_id=2,
        album_key="resonance-no-hill-for-a-climber",
        title="No Hill for a Climber",
    )
    family_row = _browse_album_row(
        artist="The Neal Morse Band",
        album_id=3,
        album_key="neal-morse-band-similitude",
        title="The Similitude of a Dream",
    )
    alias_maps = {
        "alias_to_canonical": {
            "Neal Morse": "Neal Morse",
            collaboration_artist: "Neal Morse",
            "The Neal Morse Band": "The Neal Morse Band",
        },
        "canonical_to_aliases": {
            "Neal Morse": ["Neal Morse", collaboration_artist],
            "The Neal Morse Band": ["The Neal Morse Band"],
        },
    }
    monkeypatch.setattr(
        browse_module,
        "_selected_artist_family_context_from_state",
        lambda *_args, **_kwargs: {
            "family_artists": ["The Neal Morse Band"],
            **alias_maps,
        },
    )
    repository = browse_module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(repository, "_load_relation_alias_maps", lambda **_kwargs: alias_maps)
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda **_kwargs: {"ignored_version_keys": [], "manual_version_links": {}},
    )

    def load_selected_artist_preview_rows(selected_artists, *_args, **_kwargs):
        selected_artist_preview_scopes.append(list(selected_artists))
        return [
            row
            for row in [canonical_row, collaboration_row]
            if row["artist_name"] in selected_artists
        ]

    monkeypatch.setattr(
        repository,
        "_load_selected_artist_preview_rows",
        load_selected_artist_preview_rows,
    )
    monkeypatch.setattr(
        repository,
        "_load_artist_preview_rows",
        lambda *_args, **_kwargs: [family_row],
    )
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda *_args, **_kwargs: [canonical_row, collaboration_row, family_row],
    )
    monkeypatch.setattr(repository, "_load_non_album_entries", lambda **_kwargs: [])
    monkeypatch.setattr(repository, "queue_settings_projection_prewarm", lambda: None)

    payload = repository.build_selected_artist_payload(
        query_params={
            "surface": "albums",
            "q": "neal morse",
            "artist": collaboration_artist,
        },
        library_state={},
    )

    assert payload["selected_artist"] == collaboration_artist
    assert selected_artist_preview_scopes == [[collaboration_artist]]
    assert [group["artist"] for group in payload["primary_artist_groups"]] == [
        collaboration_artist
    ]
    primary_albums = payload["primary_artist_groups"][0]["albums"]
    assert [album["name"] for album in primary_albums] == ["No Hill for a Climber"]
    assert [album["key"] for album in primary_albums] == [
        "resonance-no-hill-for-a-climber"
    ]
    assert "One" not in {album["name"] for album in primary_albums}
    assert [item["artist"] for item in payload["artists_sidebar"]] == [
        collaboration_artist,
        "The Neal Morse Band",
        "Neal Morse",
    ]


def test_postgres_selected_artist_query_primary_filter_hydrates_primary_album_tracks():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed_sql: list[str] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Cosmic Cathedral",
                    "artist_sort_name": "Cosmic Cathedral",
                    "album_id": 101,
                    "album_key": "cosmic-cathedral-deep-water",
                    "album_title": "Deep Water",
                    "album_release_year": 2025,
                    "album_cover_path": r"X:\SyntheticMusic\Progressive\Neal Morse\Progressive albums\2025 - Cosmic Cathedral - Deep Water\cover.jpg",
                    "album_metadata": {
                        "album_artist": "Cosmic Cathedral",
                        "artists": ["Cosmic Cathedral"],
                    },
                    "track_id": 1001,
                    "track_key": "cosmic-cathedral-deep-water-01",
                    "track_title": "Deep Water Suite: I. Launch Out, Pt. One",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 320,
                    "file_private_path": r"X:\SyntheticMusic\Progressive\Neal Morse\Progressive albums\2025 - Cosmic Cathedral - Deep Water\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed_sql.append(str(sql))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={
            "surface": "albums",
            "q": "Neal Morse",
            "artist": "Cosmic Cathedral",
            "primary_filter": "1",
            "omit_sidebar": "1",
        },
        library_state={},
    )

    album = payload["primary_artist_groups"][0]["albums"][0]
    assert payload["query"] == "Neal Morse"
    assert payload["selected_artist"] == "Cosmic Cathedral"
    assert payload["primary_filter_active"] is True
    assert album["preview_only"] is False
    assert album["tracks"][0]["key"] == "cosmic-cathedral-deep-water-01"
    assert "track_count" not in " ".join(executed_sql)


def test_postgres_search_payload_supports_search_scoped_all_artists():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                    },
                    "track_id": 1001,
                    "track_key": "broadcast-tender-buttons-01",
                    "track_title": "I Found the F",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 145,
                    "file_private_path": r"D:\Music\Broadcast\Tender Buttons\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
                {
                    "artist_id": 11,
                    "artist_name": "Tender Forever",
                    "artist_sort_name": "Tender Forever",
                    "album_id": 102,
                    "album_key": "tender-forever-no-snare",
                    "album_title": "No Snare",
                    "album_release_year": 2008,
                    "album_cover_path": "covers/no-snare.jpg",
                    "album_metadata": {
                        "album_artist": "Tender Forever",
                        "artists": ["Tender Forever"],
                    },
                    "track_id": 1002,
                    "track_key": "tender-forever-no-snare-01",
                    "track_title": "Tender Forever",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 171,
                    "file_private_path": r"D:\Music\Tender Forever\No Snare\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_search_payload(
        query_params={
            "surface": "albums",
            "q": "tender",
            "all_artists": "1",
            "omit_sidebar": "1",
        },
        library_state={},
    )

    assert payload["selected_artist"] == ""
    assert payload["all_artists_active"] is True
    assert payload["artist_groups"]
    assert payload["primary_artist_groups"] == []
    assert payload["family_artist_groups"] == []
    assert payload["artist_groups"][0]["albums"][0]["preview_only"] is True
    assert "artists_sidebar" not in payload
    assert payload["related_artists"] == []
    assert payload["search_context"]["selected_artist"] == ""
    assert payload["search_context"]["selected_artist_source"] == "requested_all_artists"


def test_postgres_search_payload_builds_family_groups_for_selected_artist(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    projection_connectors: list[object] = []

    def fake_load_selected_artist_family_projection(config, selected_artist, **kwargs):
        projection_connectors.append(kwargs.get("connect"))
        return {
            "family_artists": ["Stereolab"],
            "relations_last_built": 0.0,
            "loaded": True,
        }

    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        fake_load_selected_artist_family_projection,
    )

    search_rows = [
        {
            "artist_id": 10,
            "artist_name": "Broadcast",
            "artist_sort_name": "Broadcast",
            "album_id": 101,
            "album_key": "broadcast-tender-buttons",
            "album_title": "Tender Buttons",
            "album_release_year": 2005,
            "album_cover_path": "covers/tender.jpg",
            "album_metadata": {
                "album_artist": "Broadcast",
                "artists": ["Broadcast"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_count": 2,
            "total_duration_seconds": 316,
        },
    ]
    family_rows = [
        {
            "artist_id": 11,
            "artist_name": "Stereolab",
            "artist_sort_name": "Stereolab",
            "album_id": 102,
            "album_key": "stereolab-dots-and-loops",
            "album_title": "Dots and Loops",
            "album_release_year": 1997,
            "album_cover_path": "covers/dots.jpg",
            "album_metadata": {
                "album_artist": "Stereolab",
                "artists": ["Stereolab"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_count": 1,
            "total_duration_seconds": 319,
        },
    ]

    class FakeCursor:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return list(self._rows)

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            if params and "artist_names" in params:
                return FakeCursor(family_rows)
            return FakeCursor(search_rows)

    def fake_connect(_database_url):
        return FakeConnection()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=fake_connect,
    )

    payload = repository.build_search_payload(
        query_params={"surface": "albums", "q": "broadcast"},
        library_state={"relation_views": {}},
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_artists"] == ["Stereolab"]
    assert projection_connectors == [fake_connect]
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Broadcast"]
    assert [group["artist"] for group in payload["family_artist_groups"]] == ["Stereolab"]
    assert [group["artist"] for group in payload["artist_groups"]] == ["Broadcast", "Stereolab"]
    assert [item["display_name"] for item in payload["artist_family_filters"]] == ["Broadcast", "Stereolab"]


def test_postgres_search_payload_does_not_fall_back_to_runtime_cache_relation_views(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services import library_browse_postgres as library_browse_module
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda config, selected_artist, **_kwargs: {
            "family_artists": [],
            "relations_last_built": 0.0,
            "loaded": False,
        },
    )
    class FakeCursor:
        def fetchone(self):
            return None

        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                    },
                    "track_id": 1001,
                    "track_key": "broadcast-tender-buttons-01",
                    "track_title": "I Found the F",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 145,
                    "file_private_path": r"D:\Music\Broadcast\Tender Buttons\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                }
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "CACHE_PATH": r"C:\cache\library_cache.json",
        },
        connect=lambda _database_url: FakeConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )

    payload = repository.build_search_payload(
        query_params={"surface": "albums", "q": "broadcast"},
        library_state={},
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_artists"] == []
    assert payload["family_artist_groups"] == []
    assert [item["display_name"] for item in payload["artist_family_filters"]] == ["Broadcast"]


def test_postgres_search_payload_uses_exact_artist_fast_path(monkeypatch):
    from starlette.datastructures import QueryParams

    from music_app.services import covers as covers_module
    from music_app.services import library_browse_postgres as library_browse_postgres_module

    PostgresLibraryBrowseRepository = library_browse_postgres_module.PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "DATA_DIR": r"C:\AlbumHavenData",
        },
            connect=lambda _database_url: _NoopSearchSnapshotConnection(),
    )
    queued_covers: list[tuple[str, str, int]] = []
    event_order: list[str] = []
    monkeypatch.setattr(
        covers_module,
        "queue_cover_display_variant_generation",
        lambda source_path, *, cache_root, max_size: (
            event_order.append("queue"),
            queued_covers.append((Path(source_path).as_posix(), str(cache_root), max_size)),
        ),
    )
    delegated_calls: list[tuple[object, object]] = []
    exact_match_calls: list[tuple[str, dict[str, object]]] = []
    monkeypatch.setattr(
        repository,
        "_load_exact_artist_match",
        lambda query, view_state, **_kwargs: (
            exact_match_calls.append((query, dict(view_state or {})))
            or "Neal Morse"
        ),
    )
    search_row_calls: list[tuple[str, dict[str, object]]] = []
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda query, view_state, **_kwargs: (
            search_row_calls.append((query, dict(view_state or {})))
            or [
                {
                    "artist_id": 1,
                    "artist_name": "Neal Morse",
                    "artist_sort_name": "Neal Morse",
                    "album_id": 101,
                    "album_key": "neal-morse-one",
                    "album_title": "One",
                    "album_release_year": 2004,
                    "album_cover_path": "covers/neal.jpg",
                    "album_metadata": {"album_artist": "Neal Morse", "artists": ["Neal Morse"]},
                    "track_id": 1001,
                    "track_key": "neal-morse-one-01",
                    "track_title": "The Creation",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 600,
                    "file_private_path": r"D:\Music\Neal Morse\One\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
                {
                    "artist_id": 2,
                    "artist_name": "Transatlantic",
                    "artist_sort_name": "Transatlantic",
                    "album_id": 201,
                    "album_key": "transatlantic-smpte",
                    "album_title": "SMPTe",
                    "album_release_year": 2000,
                    "album_cover_path": "covers/transatlantic.jpg",
                    "album_metadata": {"album_artist": "Transatlantic", "artists": ["Transatlantic"]},
                    "track_id": 2001,
                    "track_key": "transatlantic-smpte-01",
                    "track_title": "All Of The Above",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 1800,
                    "file_private_path": r"D:\Music\Transatlantic\SMPTe\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]
        ),
    )
    monkeypatch.setattr(
        repository,
        "build_selected_artist_payload",
        lambda *, query_params=None, library_state=None, **_kwargs: (
            event_order.append("delegate")
            or
            delegated_calls.append((dict(query_params or {}), library_state))
            or {
                "selected_artist": str((query_params or {}).get("artist") or ""),
                "query": str((query_params or {}).get("q") or ""),
                "primary_artist_groups": [
                    {
                        "artist": "Neal Morse",
                        "artist_display": "Neal Morse",
                        "albums": [{"cover_path": "covers/neal.jpg"}],
                    }
                ],
                "family_artist_groups": [
                    {
                        "artist": "Cosmic Cathedral",
                        "artist_display": "Cosmic Cathedral",
                        "albums": [{"cover_path": "covers/cosmic.jpg"}],
                    }
                ],
                "artist_groups": [],
            }
        ),
    )
    payload = repository.build_search_payload(
        query_params=QueryParams([
            ("surface", "albums"),
            ("q", "Neal Morse"),
            ("category", "main_library"),
            ("category", "hoard"),
            ("category", "new_arrivals"),
        ]),
        library_state={"relation_views": {}},
    )

    assert payload["selected_artist"] == "Neal Morse"
    assert payload["query"] == "Neal Morse"
    assert [group["artist"] for group in payload["artist_groups"]] == ["Neal Morse", "Cosmic Cathedral"]
    assert [item["artist"] for item in payload["artists_sidebar"]] == ["Neal Morse", "Cosmic Cathedral", "Transatlantic"]
    assert payload["artist_count"] == 3
    assert queued_covers == [
        ("covers/neal.jpg", r"C:\AlbumHavenData", 480),
        ("covers/transatlantic.jpg", r"C:\AlbumHavenData", 480),
    ]
    assert "delegate" in event_order
    assert event_order.index("delegate") < event_order.index("queue")
    assert not hasattr(library_browse_postgres_module, "_prewarm_display_cover_variants_for_groups")
    assert search_row_calls == [
        (
            "Neal Morse",
            {
                "gallery_scope": "all",
                "gallery_display_mode": "cards",
                "gallery_scale_percent": 100,
                "visible_library_categories": ["main_library", "hoard", "new_arrivals"],
            },
        )
    ]
    assert exact_match_calls == [
        (
                "Neal Morse",
                {
                    "gallery_scope": "all",
                    "gallery_display_mode": "cards",
                    "gallery_scale_percent": 100,
                    "visible_library_categories": ["main_library", "hoard", "new_arrivals"],
                },
            )
        ]
    assert delegated_calls == [
        (
            {
                "surface": "albums",
                "q": "Neal Morse",
                "category": ["main_library", "hoard", "new_arrivals"],
                "artist": "Neal Morse",
            },
            {"relation_views": {}},
        )
    ]


def test_postgres_non_exact_best_match_sidebar_includes_projected_family(monkeypatch):
    from music_app.services import library_browse_postgres as browse_module

    primary_row = _browse_album_row(
        artist="The Flower Kings",
        album_id=1,
        album_key="flower-kings-retropolis",
        title="Retropolis",
    )
    agents_row = _browse_album_row(
        artist="Agents Of Mercy",
        album_id=2,
        album_key="agents-of-mercy-black-forest",
        title="The Black Forest",
    )
    roine_row = _browse_album_row(
        artist="Roine Stolt",
        album_id=3,
        album_key="roine-stolt-hydrophonia",
        title="Hydrophonia",
    )
    unrelated_direct_match_row = _browse_album_row(
        artist="Swedish Family",
        album_id=4,
        album_key="swedish-family-flower-kings-tribute",
        title="Flower Kings Tribute",
    )
    family_artists = ["Agents Of Mercy", "Roine Stolt"]
    alias_maps = {
        "alias_to_canonical": {
            "The Flower Kings": "The Flower Kings",
            "Agents Of Mercy": "Agents Of Mercy",
            "Roine Stolt": "Roine Stolt",
        },
        "canonical_to_aliases": {
            "The Flower Kings": ["The Flower Kings"],
            "Agents Of Mercy": ["Agents Of Mercy"],
            "Roine Stolt": ["Roine Stolt"],
        },
    }
    repository = browse_module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: alias_maps,
    )
    monkeypatch.setattr(
        repository,
        "_load_exact_artist_match",
        lambda *_args, **_kwargs: "",
    )
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda *_args, **_kwargs: [primary_row, unrelated_direct_match_row],
    )
    monkeypatch.setattr(
        browse_module,
        "_selected_artist_family_context_from_state",
        lambda *_args, **_kwargs: {
            "family_artists": family_artists,
            **alias_maps,
        },
    )
    monkeypatch.setattr(
        repository,
        "_load_artist_preview_rows",
        lambda *_args, **_kwargs: [agents_row, roine_row],
    )
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda **_kwargs: {"ignored_version_keys": [], "manual_version_links": {}},
    )
    monkeypatch.setattr(repository, "_load_non_album_entries", lambda **_kwargs: [])
    monkeypatch.setattr(repository, "queue_settings_projection_prewarm", lambda: None)

    payload = repository.build_search_payload(
        query_params={"surface": "albums", "q": "flower kings"},
        library_state={},
    )

    assert payload["selected_artist"] == "The Flower Kings"
    assert [group["artist"] for group in payload["primary_artist_groups"]] == [
        "The Flower Kings"
    ]
    assert [group["artist"] for group in payload["family_artist_groups"]] == family_artists
    assert [group["artist"] for group in payload["artist_groups"]] == [
        "The Flower Kings",
        *family_artists,
    ]
    assert [item["artist"] for item in payload["artists_sidebar"]] == [
        "The Flower Kings",
        *family_artists,
        "Swedish Family",
    ]
    assert payload["artist_count"] == 4
    assert payload["show_all_artists_sidebar_link"] is True


def test_postgres_search_payload_reuses_one_read_snapshot_for_every_projection(monkeypatch):
    from music_app.services import library_browse_postgres as browse_module
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    connection = _NoopSearchSnapshotConnection()
    seen: list[tuple[str, object]] = []

    class SnapshotAlbumRatingsService:
        def load_album_ratings(self, _album_keys, *, connection=None):
            seen.append(("ratings", connection))
            return {}

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        album_ratings_service=SnapshotAlbumRatingsService(),
    )

    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda *, connection=None: seen.append(("aliases", connection))
        or {"alias_to_canonical": {}, "canonical_to_aliases": {}},
    )
    monkeypatch.setattr(
        repository,
        "_load_exact_artist_match",
        lambda _query, _state, *, connection=None: seen.append(("exact", connection)) or "",
    )
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda _query, _state, *, connection=None: seen.append(("search", connection))
        or [_browse_album_row(artist="Joseph", album_id=1, album_key="joseph", title="Joseph")],
    )
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda *, connection=None: seen.append(("support", connection))
        or {"ignored_version_keys": [], "manual_version_links": {}},
    )
    monkeypatch.setattr(
        browse_module,
        "_selected_artist_family_context_from_state",
        lambda *_args, connection=None, **_kwargs: seen.append(("family", connection))
        or {
            "family_artists": ["Joseph Family"],
            "relation_views": {},
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
        },
    )
    monkeypatch.setattr(
        repository,
        "_load_artist_preview_rows",
        lambda _artists, _state, *, connection=None: seen.append(("family-preview", connection)) or [],
    )
    monkeypatch.setattr(
        repository,
        "_load_non_album_entries",
        lambda **kwargs: seen.append(("non-album", kwargs.get("connection"))) or [],
    )

    payload = repository.build_search_payload(query_params={"q": "joseph", "surface": "albums"})

    assert payload["query"] == "joseph"
    assert sorted(name for name, _connection in seen) == sorted([
        "aliases",
        "exact",
        "search",
        "support",
        "family",
        "family-preview",
        "non-album",
        "ratings",
    ])
    assert all(active_connection is connection for _name, active_connection in seen)


def test_exact_punctuation_artist_search_skips_the_broad_track_and_path_scan(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    punctuation_row = _browse_album_row(
        artist="***",
        album_id=1,
        album_key="punctuation-artist",
        title="Punctuation Artist",
    )
    seen_preview_scopes = []
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: {
            "alias_to_canonical": {"***": "***"},
            "canonical_to_aliases": {"***": ["***"]},
            "projection_stale_reason": "",
        },
    )
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("punctuation-only exact artists must not run the broad search")
        ),
    )
    monkeypatch.setattr(
        repository,
        "_load_artist_preview_rows",
        lambda artists, *_args, **_kwargs: seen_preview_scopes.append(list(artists))
        or [punctuation_row],
    )
    monkeypatch.setattr(
        repository,
        "build_selected_artist_payload",
        lambda **_kwargs: {
            "selected_artist": "***",
            "primary_artist_groups": [],
            "family_artist_groups": [],
            "related_filter_base_primary_groups": [],
            "related_filter_base_family_groups": [],
            "search_context": {},
        },
    )

    payload = repository.build_search_payload(
        query_params={"q": "***", "surface": "albums"},
        library_state={},
    )

    assert seen_preview_scopes == [["***"]]
    assert [item["artist"] for item in payload["artists_sidebar"]] == ["***"]


def test_postgres_selected_artist_payload_reuses_one_read_snapshot_for_every_projection(monkeypatch):
    from music_app.services import library_browse_postgres as browse_module
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    connection = _NoopSearchSnapshotConnection()
    connections = []
    seen: list[tuple[str, object]] = []

    class SnapshotAlbumRatingsService:
        def load_album_ratings(self, _album_keys, *, connection=None):
            seen.append(("ratings", connection))
            return {}

    def connect(_database_url):
        connections.append(connection)
        return connection

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=connect,
        album_ratings_service=SnapshotAlbumRatingsService(),
    )
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda *, connection=None: seen.append(("aliases", connection))
        or {"alias_to_canonical": {}, "canonical_to_aliases": {}},
    )
    monkeypatch.setattr(
        repository,
        "_load_selected_artist_rows",
        lambda _artists, _state, *, connection=None: seen.append(("selected", connection))
        or [_browse_album_row(artist="Joseph", album_id=1, album_key="joseph", title="Joseph")],
    )
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda *, connection=None: seen.append(("support", connection))
        or {"ignored_version_keys": [], "manual_version_links": {}},
    )
    monkeypatch.setattr(
        browse_module,
        "_selected_artist_family_context_from_state",
        lambda *_args, connection=None, **_kwargs: seen.append(("family", connection))
        or {
            "family_artists": ["Joseph Family"],
            "relation_views": {},
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
        },
    )
    monkeypatch.setattr(
        repository,
        "_load_artist_preview_rows",
        lambda _artists, _state, *, connection=None: seen.append(("family-preview", connection)) or [],
    )
    monkeypatch.setattr(
        repository,
        "_load_non_album_entries",
        lambda **kwargs: seen.append(("non-album", kwargs.get("connection"))) or [],
    )

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "Joseph", "surface": "albums"},
    )

    assert payload["selected_artist"] == "Joseph"
    assert connections == [connection]
    assert sorted(name for name, _connection in seen) == sorted([
        "aliases",
        "selected",
        "support",
        "family",
        "family-preview",
        "non-album",
        "ratings",
    ])
    assert all(active_connection is connection for _name, active_connection in seen)


def test_postgres_search_owned_snapshot_rolls_back_and_closes_on_loader_failure(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    lifecycle = []

    class FailingSnapshotConnection:
        def __enter__(self):
            lifecycle.append("enter")
            return self

        def __exit__(self, exc_type, exc, traceback):
            lifecycle.append(("exit", exc_type, str(exc)))
            lifecycle.append("closed")
            return False

        def execute(self, sql, params=None):
            lifecycle.append(("execute", str(sql).strip(), dict(params or {})))
            return _InventoryCursor()

    connection = FailingSnapshotConnection()
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
    )
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("alias loader failed")),
    )

    with pytest.raises(RuntimeError, match="alias loader failed"):
        repository.build_search_payload(query_params={"q": "joseph"})

    assert lifecycle[0] == "enter"
    assert lifecycle[1][0] == "execute"
    assert lifecycle[1][1] == "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
    assert lifecycle[2][0] == "exit"
    assert lifecycle[2][1] is RuntimeError
    assert lifecycle[2][2] == "alias loader failed"
    assert lifecycle[3] == "closed"


def test_postgres_search_rows_query_authoritative_database_on_every_request():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[dict[str, object]] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Ария",
                    "album_id": 100,
                    "album_title": "Мания величия",
                }
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, params=None):
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/search-cache-test",
            "DATA_DIR": r"C:\AlbumHavenData",
        },
        connect=lambda _database_url: FakeConnection(),
    )
    view_state = {
        "visible_library_categories": ["main_library", "hoard", "new_arrivals"],
    }

    first_rows = repository._load_search_rows("Ария", view_state)
    second_rows = repository._load_search_rows("ария", view_state)
    filtered_rows = repository._load_search_rows(
        "Ария",
        {"visible_library_categories": ["main_library"]},
    )

    assert first_rows == second_rows
    assert filtered_rows == first_rows
    assert len(executed) == 3
    assert executed[1]["category_count"] == 0
    assert executed[1]["visible_categories"] == []
    assert [executed[0], executed[2]] == [
        {
            "query_like": "%Ария%",
            "category_count": 0,
            "visible_categories": [],
        },
        {
            "query_like": "%Ария%",
            "category_count": 1,
            "visible_categories": ["main_library"],
        },
    ]


def test_postgres_search_payload_exact_artist_match_applies_category_filter_params():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[tuple[str, dict[str, object]]] = []

    class FakeCursor:
        def __init__(self, *, row=None, rows=None):
            self._row = row
            self._rows = list(rows or [])

        def fetchone(self):
            return self._row

        def fetchall(self):
            return list(self._rows)

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append((str(sql), dict(params or {})))
            if len(executed) == 2:
                return FakeCursor(row={"artist_name": "Ария"})
            return FakeCursor(rows=[
                {
                    "artist_id": 10,
                    "artist_name": "Ария",
                    "artist_sort_name": "Ария",
                    "album_id": 101,
                    "album_key": "aria-round-loop",
                    "album_title": "Замкнутый круг",
                    "album_release_year": 1988,
                    "album_cover_path": "covers/aria.jpg",
                    "album_metadata": {
                        "album_artist": "Ария",
                        "artists": ["Ария"],
                    },
                    "track_id": 1001,
                    "track_key": "aria-round-loop-01",
                    "track_title": "Замкнутый круг",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 255,
                    "file_private_path": r"D:\Music\Ария\Замкнутый круг\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ])

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )

    payload = repository.build_search_payload(
        query_params={
            "surface": "albums",
            "q": "Ария",
            "category": ["main_library"],
        },
        library_state={"relation_views": {}},
    )

    assert payload["selected_artist"] == "Ария"
    assert payload["search_context"]["committed_query"] == "Ария"
    assert payload["search_context"]["selected_artist_source"] == "auto_top_match"
    assert executed
    assert executed[1][1] == {
        "artist_name": "Ария",
        "artist_key": "ария",
        "category_count": 1,
        "visible_categories": ["main_library"],
    }


def test_postgres_artist_identity_queries_collapse_repeated_whitespace_and_preserve_display():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[tuple[str, dict[str, object]]] = []

    class FakeCursor:
        def fetchone(self):
            return {"artist_name": "Signal  Family Lead"}

        def fetchall(self):
            return []

    class FakeConnection:
        def execute(self, sql, params=None):
            executed.append((" ".join(str(sql).split()), dict(params or {})))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: None,
    )
    connection = FakeConnection()
    view_state = {"visible_library_categories": ["main_library"]}

    exact_match = repository._load_exact_artist_match(
        "Signal Family Lead",
        view_state,
        connection=connection,
    )
    repository._load_selected_artist_rows(
        [exact_match],
        view_state,
        connection=connection,
    )
    repository._load_selected_artist_preview_rows(
        [exact_match],
        view_state,
        connection=connection,
    )
    repository._load_artist_preview_rows(
        [exact_match, "Signal Family Relative"],
        view_state,
        connection=connection,
    )

    assert exact_match == "Signal  Family Lead"
    assert executed[0][1]["artist_name"] == "Signal Family Lead"
    assert executed[0][1]["artist_key"] == "signal family lead"
    assert "where visible_artists.artist_key = %(artist_key)s" in executed[0][0]
    assert executed[1][1]["artist_keys"] == ["signal family lead"]
    assert executed[2][1]["artist_keys"] == ["signal family lead"]
    assert executed[3][1]["artist_names"] == [
        "Signal  Family Lead",
        "Signal Family Relative",
    ]
    assert executed[3][1]["artist_keys"] == [
        "signal family lead",
        "signal family relative",
    ]


def test_projected_artist_family_identity_collapses_whitespace_without_collapsing_punctuation():
    from music_app.services.library_browse_postgres import (
        _canonical_artist_name,
        _exact_projected_artist_match,
        _expanded_artist_name_list,
    )

    alias_to_canonical = {
        "Signal  Family Lead": "Signal  Family Lead",
        "Signal Family Relative": "Signal Family Relative",
        "Morse, Portnoy & George": "Morse Portnoy George",
    }
    canonical_to_aliases = {
        "Signal  Family Lead": ["Signal  Family Lead", "Signal Family Lead"],
        "Signal Family Relative": ["Signal Family Relative"],
        "Morse Portnoy George": ["Morse, Portnoy & George"],
    }

    assert (
        _exact_projected_artist_match(
            "Signal Family Lead",
            alias_to_canonical,
            canonical_to_aliases,
        )
        == "Signal  Family Lead"
    )
    assert _canonical_artist_name("Signal Family Lead", alias_to_canonical) == "Signal  Family Lead"
    assert _expanded_artist_name_list(
        ["Signal Family Lead", "Signal Family Relative"],
        alias_to_canonical,
        canonical_to_aliases,
    ) == ["Signal  Family Lead", "Signal Family Relative"]
    assert _canonical_artist_name("Morse, Portnoy & George", alias_to_canonical) == "Morse Portnoy George"
    assert _exact_projected_artist_match(
        "Morse Portnoy George",
        alias_to_canonical,
        canonical_to_aliases,
    ) == "Morse Portnoy George"
    assert not _exact_projected_artist_match(
        "Morse Portnoy & George",
        alias_to_canonical,
        canonical_to_aliases,
    )


def test_canonicalize_artist_rows_builds_normalized_alias_lookup_once():
    from music_app.services.library_browse_postgres import _canonicalize_artist_rows

    class CountingAliasMap(dict):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.items_calls = 0

        def items(self):
            self.items_calls += 1
            return super().items()

    alias_to_canonical = CountingAliasMap(
        {
            "Signal  Family Lead": "Signal  Family Lead",
            "Signal Family Relative": "Signal Family Relative",
        }
    )

    rows = _canonicalize_artist_rows(
        [
            {"artist_id": 1, "artist_name": "Signal Family Lead"},
            {"artist_id": 2, "artist_name": "Signal Family Lead"},
        ],
        alias_to_canonical,
    )

    assert [row["artist_name"] for row in rows] == [
        "Signal  Family Lead",
        "Signal  Family Lead",
    ]
    assert alias_to_canonical.items_calls == 1


def test_postgres_selected_artist_payload_queues_visible_display_cover_variants(monkeypatch):
    from music_app.services import covers as covers_module
    from music_app.services import library_browse_postgres as library_browse_postgres_module

    PostgresLibraryBrowseRepository = library_browse_postgres_module.PostgresLibraryBrowseRepository
    queued_covers: list[tuple[str, str, int]] = []
    monkeypatch.setattr(
        covers_module,
        "queue_cover_display_variant_generation",
        lambda source_path, *, cache_root, max_size: queued_covers.append(
            (Path(source_path).as_posix(), str(cache_root), max_size)
        ),
    )

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 1,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                        "root_provenance": {"primary_category": "main_library", "categories": ["main_library"]},
                    },
                    "track_id": 1001,
                    "track_key": "broadcast-tender-buttons::i-found-the-f",
                    "track_title": "I Found the F",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 180,
                    "file_private_path": r"D:\Music\Broadcast\Tender Buttons\01 - I Found the F.mp3",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, params=None):
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "DATA_DIR": r"C:\AlbumHavenData",
            "MUSIC_DIR": r"D:\Music",
        },
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "broadcast", "surface": "albums"},
    )

    assert payload["selected_artist"] == "Broadcast"
    assert queued_covers == [(r"covers/tender.jpg", r"C:\AlbumHavenData", 480)]
    assert not hasattr(library_browse_postgres_module, "_prewarm_display_cover_variants_for_groups")


def test_postgres_cover_variant_queue_uses_preview_and_full_card_sizes(monkeypatch):
    from music_app.services import covers as covers_module
    from music_app.services.library_browse_postgres import _queue_display_cover_variants_for_groups

    queued_covers: list[tuple[str, str, int]] = []
    monkeypatch.setattr(
        covers_module,
        "queue_cover_display_variant_generation",
        lambda source_path, *, cache_root, max_size: queued_covers.append(
            (Path(source_path).as_posix(), str(cache_root), max_size)
        ),
    )

    _queue_display_cover_variants_for_groups(
        {"DATA_DIR": r"C:\AlbumHavenData"},
        [
            {
                "albums": [
                    {"cover_path": "covers/preview.jpg", "preview_only": True},
                    {"cover_path": "covers/full.jpg", "preview_only": False},
                ]
            }
        ],
    )

    assert queued_covers == [
        ("covers/preview.jpg", r"C:\AlbumHavenData", 480),
        ("covers/full.jpg", r"C:\AlbumHavenData", 480),
    ]


def test_postgres_cover_variant_queue_deduplicates_without_consuming_limit(monkeypatch):
    from music_app.services import covers as covers_module
    from music_app.services.library_browse_postgres import _queue_display_cover_variants_for_groups

    queued_covers: list[tuple[str, str, int]] = []
    monkeypatch.setattr(
        covers_module,
        "queue_cover_display_variant_generation",
        lambda source_path, *, cache_root, max_size: queued_covers.append(
            (Path(source_path).as_posix(), str(cache_root), max_size)
        ),
    )

    _queue_display_cover_variants_for_groups(
        {"DATA_DIR": r"C:\AlbumHavenData"},
        [
            {
                "albums": [
                    {"cover_path": "covers/shared.jpg", "preview_only": True},
                    {"cover_path": "covers/shared.jpg", "preview_only": False},
                    {"cover_path": "covers/full.jpg", "preview_only": False},
                    {"cover_path": "covers/beyond-limit.jpg", "preview_only": True},
                ]
            }
        ],
        limit=2,
    )

    assert queued_covers == [
        ("covers/shared.jpg", r"C:\AlbumHavenData", 480),
        ("covers/full.jpg", r"C:\AlbumHavenData", 480),
    ]


def test_postgres_search_all_artists_cover_variant_queue_is_bounded_to_two(monkeypatch):
    from music_app.services import covers as covers_module
    from music_app.services.library_browse_postgres import (
        _queue_display_cover_variants_for_groups,
    )

    queued_covers: list[tuple[str, str, int]] = []
    monkeypatch.setattr(
        covers_module,
        "queue_cover_display_variant_generation",
        lambda source_path, *, cache_root, max_size: queued_covers.append(
            (Path(source_path).as_posix(), str(cache_root), max_size)
        ),
    )
    albums = [
        {"cover_path": "covers/artist-0.jpg", "preview_only": True},
        {"cover_path": "covers/artist-0.jpg", "preview_only": False},
        {"cover_path": "covers/artist-1.jpg", "preview_only": False},
        {"cover_path": "covers/artist-2.jpg", "preview_only": True},
    ]

    _queue_display_cover_variants_for_groups(
        {"DATA_DIR": r"C:\AlbumHavenData"},
        [{"albums": albums}],
        limit=2,
    )

    assert queued_covers == [
        ("covers/artist-0.jpg", r"C:\AlbumHavenData", 480),
        ("covers/artist-1.jpg", r"C:\AlbumHavenData", 480),
    ]
    assert all(path != "covers/artist-2.jpg" for path, _cache_root, _size in queued_covers)


def test_postgres_root_album_browse_payload_queues_visible_display_cover_variants(monkeypatch):
    from music_app.services import covers as covers_module
    from music_app.services import library_browse_postgres as library_browse_postgres_module

    PostgresLibraryBrowseRepository = library_browse_postgres_module.PostgresLibraryBrowseRepository
    queued_covers: list[tuple[str, str, int]] = []
    monkeypatch.setattr(
        covers_module,
        "queue_cover_display_variant_generation",
        lambda source_path, *, cache_root, max_size: queued_covers.append(
            (Path(source_path).as_posix(), str(cache_root), max_size)
        ),
    )

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 1,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                        "root_provenance": {"primary_category": "main_library", "categories": ["main_library"]},
                    },
                    "track_id": 1001,
                    "track_key": "broadcast-tender-buttons::i-found-the-f",
                    "track_title": "I Found the F",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 180,
                    "file_private_path": r"D:\Music\Broadcast\Tender Buttons\01 - I Found the F.mp3",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, params=None):
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "DATA_DIR": r"C:\AlbumHavenData",
            "MUSIC_DIR": r"D:\Music",
        },
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_root_album_browse_payload(
        query_params={"surface": "albums"},
    )

    assert payload["artist_count"] == 1
    assert queued_covers == [(r"covers/tender.jpg", r"C:\AlbumHavenData", 480)]
    assert not hasattr(library_browse_postgres_module, "_prewarm_display_cover_variants_for_groups")


def test_postgres_selected_artist_preview_payload_queues_reusable_family_cover_variants(monkeypatch):
    from music_app.services import covers as covers_module
    from music_app.services import artist_family_postgres
    from music_app.services import library_browse_postgres as library_browse_postgres_module

    PostgresLibraryBrowseRepository = library_browse_postgres_module.PostgresLibraryBrowseRepository
    queued_covers: list[tuple[str, str, int]] = []
    monkeypatch.setattr(
        covers_module,
        "queue_cover_display_variant_generation",
        lambda source_path, *, cache_root, max_size: queued_covers.append(
            (Path(source_path).as_posix(), str(cache_root), max_size)
        ),
    )

    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda config, selected_artist, **_kwargs: {
            "family_artists": ["Trish Keenan"],
            "relations_last_built": 0.0,
            "loaded": True,
            "alias_to_canonical": {
                "Broadcast": "Broadcast",
                "Trish Keenan": "Trish Keenan",
            },
            "canonical_to_aliases": {
                "Broadcast": ["Broadcast"],
                "Trish Keenan": ["Trish Keenan"],
            },
        },
    )

    primary_rows = [
        {
            "artist_id": 10,
            "artist_name": "Broadcast",
            "artist_sort_name": "Broadcast",
            "album_id": 101,
            "album_key": "broadcast-tender-buttons",
            "album_title": "Tender Buttons",
            "album_release_year": 2005,
            "album_cover_path": "covers/tender.jpg",
            "album_metadata": {
                "album_artist": "Broadcast",
                "artists": ["Broadcast"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_count": 9,
            "total_duration_seconds": 1450,
        },
    ]
    family_rows = [
        {
            "artist_id": 11,
            "artist_name": "Trish Keenan",
            "artist_sort_name": "Trish Keenan",
            "album_id": 201,
            "album_key": "trish-keenan-test-album",
            "album_title": "Test Family Album",
            "album_release_year": 2010,
            "album_cover_path": "covers/trish.jpg",
            "album_metadata": {
                "album_artist": "Trish Keenan",
                "artists": ["Trish Keenan"],
                "root_provenance": {"primary_category": "main_library"},
            },
            "track_count": 8,
            "total_duration_seconds": 1800,
        },
    ]

    class FakeCursor:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return list(self._rows)

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, params=None):
            if params and "artist_names" in params:
                return FakeCursor(family_rows)
            return FakeCursor(primary_rows)

    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "DATA_DIR": r"C:\AlbumHavenData",
            "MUSIC_DIR": r"D:\Music",
        },
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={
            "artist": "Broadcast",
            "q": "broad",
            "surface": "albums",
        },
        library_state={"relation_views": {}},
    )

    assert payload["artist_groups"] == []
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Broadcast"]
    assert [group["artist"] for group in payload["family_artist_groups"]] == [
        "Trish Keenan"
    ]
    assert [group["artist"] for group in payload["related_filter_base_family_groups"]] == [
        "Trish Keenan"
    ]
    assert queued_covers == [
        (r"covers/tender.jpg", r"C:\AlbumHavenData", 480),
        (r"covers/trish.jpg", r"C:\AlbumHavenData", 480),
    ]
    assert not hasattr(library_browse_postgres_module, "_prewarm_display_cover_variants_for_groups")


def test_postgres_selected_artist_payload_does_not_fall_back_to_runtime_family_when_projection_is_not_loaded(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda config, selected_artist, **_kwargs: {
            "family_artists": [],
            "relations_last_built": 0.0,
            "loaded": False,
        },
    )
    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                    },
                    "track_id": 1001,
                    "track_key": "broadcast-tender-buttons-01",
                    "track_title": "I Found the F",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 145,
                    "file_private_path": r"D:\Music\Broadcast\Tender Buttons\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                }
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "Broadcast", "surface": "albums"},
        library_state={
            "relation_views": {
                "artists": ["Broadcast", "Trish Keenan", "James Cargill"],
                "folder_related": {
                    "Broadcast": {"Trish Keenan", "James Cargill"},
                },
                "alias_to_canonical": {},
                "canonical_to_aliases": {},
            },
            "relations_last_built": 456.0,
        },
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_artists"] == []
    assert payload["family_artist_groups"] == []
    assert [item["display_name"] for item in payload["artist_family_filters"]] == ["Broadcast"]


def test_postgres_selected_artist_payload_uses_loaded_projection_even_when_runtime_has_superset(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda config, selected_artist, **_kwargs: {
            "family_artists": ["Neal Morse & The Resonance", "The Neal Morse Band"],
            "relations_last_built": 100.0,
            "loaded": True,
        },
    )

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Neal Morse",
                    "artist_sort_name": "Neal Morse",
                    "album_id": 101,
                    "album_key": "neal-morse",
                    "album_title": "Neal Morse",
                    "album_release_year": 1999,
                    "album_cover_path": "covers/neal.jpg",
                    "album_metadata": {
                        "album_artist": "Neal Morse",
                        "artists": ["Neal Morse"],
                    },
                    "track_id": 1001,
                    "track_key": "neal-morse-01",
                    "track_title": "Track One",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 145,
                    "file_private_path": r"D:\Music\Neal Morse\Neal Morse\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                }
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "Neal Morse", "surface": "albums"},
        library_state={
            "relation_views": {
                "artists": [
                    "Neal Morse",
                    "Neal Morse & The Resonance",
                    "The Neal Morse Band",
                    "Cosmic Cathedral",
                ],
                "folder_related": {
                    "Neal Morse": {
                        "Neal Morse & The Resonance",
                        "The Neal Morse Band",
                        "Cosmic Cathedral",
                    },
                },
                "alias_to_canonical": {},
                "canonical_to_aliases": {},
            },
            "relations_last_built": 789.0,
        },
    )

    assert payload["related_artists"] == []


def test_postgres_selected_artist_payload_suppresses_family_without_contributing_album(monkeypatch):
    from music_app.services import artist_family_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    monkeypatch.setattr(
        artist_family_postgres,
        "load_selected_artist_family_projection",
        lambda config, selected_artist, **_kwargs: {
            "family_artists": ["Ghost Family Artist"],
            "relations_last_built": 100.0,
            "loaded": True,
        },
    )

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Neal Morse",
                    "artist_sort_name": "Neal Morse",
                    "album_id": 101,
                    "album_key": "neal-morse",
                    "album_title": "Neal Morse",
                    "album_release_year": 1999,
                    "album_cover_path": "covers/neal.jpg",
                    "album_metadata": {
                        "album_artist": "Neal Morse",
                        "artists": ["Neal Morse"],
                    },
                    "track_id": 1001,
                    "track_key": "neal-morse-01",
                    "track_title": "Track One",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 145,
                    "file_private_path": r"D:\Music\Neal Morse\Neal Morse\01.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                }
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "Neal Morse", "surface": "albums"},
        library_state={
            "relation_views": {
                "artists": ["Neal Morse"],
                "folder_related": {
                    "Neal Morse": set(),
                },
                "alias_to_canonical": {},
                "canonical_to_aliases": {},
            },
            "relations_last_built": 200.0,
        },
    )

    assert payload["selected_artist"] == "Neal Morse"
    assert payload["related_artists"] == []
    assert payload["family_artist_groups"] == []


def test_postgres_album_detail_payload_loads_tracks_for_album_key():
    import music_app.services.album_details as album_details_module
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 3,
                    "artist_name": "Emerson, Lake & Palmer",
                    "artist_sort_name": "Emerson, Lake & Palmer",
                    "album_id": 301,
                    "album_key": "3::to the power of three",
                    "album_title": "To the Power of Three",
                    "album_release_year": 1988,
                    "album_cover_path": r"X:\SyntheticMusic\Progressive\ELP\cover.jpg",
                    "album_metadata": {
                        "album_artist": "Emerson, Lake & Palmer",
                        "artists": ["Emerson, Lake & Palmer"],
                        "root_provenance": {"primary_category": "main_library"},
                    },
                    "cover_candidate_snapshot": {
                        "search_kind": "automatic",
                        "automatic_improvement_revision": 3,
                        "seen_automatic_improvement_revision": 2,
                    },
                    "track_id": 7001,
                    "track_key": "elp-ttpot-01",
                    "track_title": "Talkin' Bout",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 214,
                    "file_private_path": r"X:\SyntheticMusic\Progressive\ELP\01 - Talkin' Bout.flac",
                    "file_library_root_id": 1,
                    "file_library_root_category": "main_library",
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, sql, params=None):
            executed.extend([sql, params])
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "MUSIC_DIR": r"X:\SyntheticMusic",
        },
        connect=lambda _database_url: FakeConnection(),
    )
    album_details_module.build_scrobbled_play_count_lookup = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("Postgres album detail payload should use prehydrated scrobble counts.")
    )
    album_details_module.build_track_preference_overlay_lookup = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("Postgres album detail payload should use prehydrated track preferences.")
    )

    payload = repository.build_album_detail_payload(
        "3::to the power of three",
        client_surface_class="tv",
    )

    assert payload is not None
    assert payload["album_id"] == 301
    assert payload["key"] == "3::to the power of three"
    assert payload["preview_only"] is False
    assert payload["track_count_preview"] == 1
    assert payload["track_rows"][0]["path"] == r"X:\SyntheticMusic\Progressive\ELP\01 - Talkin' Bout.flac"
    assert payload["tracks"][0]["artist"] == "Emerson, Lake & Palmer"
    assert payload["tracks"][0]["album_artist"] == "Emerson, Lake & Palmer"
    assert payload["tracks"][0]["album"] == "To the Power of Three"
    assert payload["tracks"][0]["cover_path"] == r"X:\SyntheticMusic\Progressive\ELP\cover.jpg"
    assert payload["cover_candidate_snapshot"] == {
        "search_kind": "automatic",
        "automatic_improvement_revision": 3,
        "seen_automatic_improvement_revision": 2,
        "has_unseen_automatic_improvement": True,
    }
    assert payload["track_rows"][0]["track_stats"]["scrobble_count"] == 0
    assert payload["track_rows"][0]["track_preference"]["allowed_actions"]["can_rate"] is True
    assert payload["gallery_list_block"]["track_rows_source"] == "inline"
    assert executed[1] == {"album_key": "3::to the power of three"}
    sql = str(executed[0])
    assert "where library.local_albums.album_key = %(album_key)s" in sql
    assert "library.local_track_files.private_path as file_private_path" in sql
    assert "coalesce(scrobble_counts.scrobble_count, 0) as track_scrobble_count" in sql
    assert "track_preferences.rating as track_preference_rating" in sql
    assert "local_album_cover_candidate_snapshots" in sql


def test_postgres_album_detail_deduplicates_header_artists_without_collapsing_distinct_credits():
    from music_app.services.library_browse_postgres import _selected_artist_album_payloads

    raw_album_artist = (
        "Frank Churchill / Leigh Harline / Larry Morey / "
        "Frank Churchill / Larry Morey"
    )
    expected_artists = ["Frank Churchill", "Leigh Harline", "Larry Morey"]
    expected_display = " / ".join(expected_artists)
    rows = [
        {
            "artist_id": 3,
            "artist_name": raw_album_artist,
            "album_id": 301,
            "album_key": "snow-white-composite-credit::snow-white-and-the-seven-dwarfs",
            "album_title": "Snow White And The Seven Dwarfs",
            "album_release_year": 1937,
            "album_metadata": {
                "album_artist": raw_album_artist,
                "artists": expected_artists,
            },
            "track_id": 7001,
            "track_key": "snow-white-01",
            "track_title": "Overture",
            "track_artist_name": expected_display,
            "disc_number": 1,
            "track_number": 1,
            "duration_seconds": 131,
            "file_private_path": r"X:\SyntheticMusic\Snow White\01 - Overture.flac",
        }
    ]

    payloads = _selected_artist_album_payloads(rows, raw_album_artist)

    assert len(payloads) == 1
    album = payloads[0]
    assert album["album_artist"] == expected_display
    assert album["artists"] == expected_artists
    assert album["tracks"][0]["artist"] == expected_display
    header_artist_keys = [
        member.strip().casefold()
        for member in str(album["album_artist"]).split("/")
        if member.strip()
    ]
    assert header_artist_keys == [artist.casefold() for artist in expected_artists]
    assert len(header_artist_keys) == len(set(header_artist_keys))


@pytest.mark.parametrize(
    ("stored_origin", "expected_origin"),
    [("user", "user"), ("automatic", "automatic"), ("unknown", None)],
)
def test_postgres_selected_album_payload_exposes_normalized_cover_selection_origin(
    stored_origin,
    expected_origin,
):
    from music_app.services.library_browse_postgres import _selected_artist_album_payloads

    rows = [{
        "artist_id": 3,
        "artist_name": "Mastodon",
        "album_id": 301,
        "album_key": "mastodon::leviathan",
        "album_title": "Leviathan",
        "album_release_year": 2004,
        "album_metadata": {
            "album_artist": "Mastodon",
            "artists": ["Mastodon"],
            "cover_selection_origin": stored_origin,
        },
        "track_id": 7001,
        "track_key": "mastodon-leviathan-01",
        "track_title": "Blood and Thunder",
        "track_artist_name": "Mastodon",
        "disc_number": 1,
        "track_number": 1,
        "duration_seconds": 228,
        "file_private_path": r"X:\SyntheticMusic\Mastodon\Leviathan\01 - Blood and Thunder.flac",
    }]

    payloads = _selected_artist_album_payloads(rows, "Mastodon")

    assert payloads[0]["cover_selection_origin"] == expected_origin


def test_postgres_selected_artist_track_payload_preserves_cached_genre():
    from music_app.services.library_browse_postgres import _selected_artist_album_payloads

    rows = [
        {
            "artist_id": 3,
            "artist_name": "Fixture Artist",
            "album_id": 301,
            "album_key": "fixture-artist::fixture-album::2000",
            "album_title": "Fixture Album",
            "album_release_year": 2000,
            "album_metadata": {
                "album_artist": "Fixture Artist",
                "artists": ["Fixture Artist"],
            },
            "track_id": 7001,
            "track_key": "fixture-track-01",
            "track_title": "Fixture Track",
            "track_artist_name": "Fixture Artist",
            "disc_number": 1,
            "track_number": 1,
            "duration_seconds": 131,
            "file_private_path": r"X:\SyntheticMusic\Fixture Artist\Fixture Album\01 - Fixture Track.flac",
            "file_entry": {
                "album": "Fixture Album",
                "album_artist": "Fixture Artist",
                "artist": "Fixture Artist",
                "title": "Fixture Track",
                "genre": "Progressive Rock",
                "year": 2000,
            },
        }
    ]

    payloads = _selected_artist_album_payloads(rows, "Fixture Artist")

    assert payloads[0]["tracks"][0]["genre"] == "Progressive Rock"


def _persisted_non_album_override_row(
    *,
    track_id: int,
    title: str,
    track_number: int,
    private_path: str,
):
    row = _exception_album_row(
        track_id=track_id,
        track_key=f"exception-album-{track_id}",
        title=title,
        track_number=track_number,
        duration_seconds=120 + track_number,
        private_path=private_path,
    )
    row["exception_type"] = "Non-album rarity"
    return row


def _selected_artist_payload_for_exception_rows(monkeypatch, rows):
    from music_app.services import library_browse_postgres as browse_module

    repository = browse_module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(repository, "_load_selected_artist_rows", lambda *_args, **_kwargs: rows)
    monkeypatch.setattr(repository, "_load_non_album_entries", lambda **_kwargs: [])
    monkeypatch.setattr(
        browse_module,
        "_selected_artist_family_context_from_state",
        lambda *_args, **_kwargs: {
            "family_artists": [],
            "relation_views": {},
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
        },
    )
    return repository.build_selected_artist_payload(
        query_params={"artist": "Exception Artist", "surface": "albums", "omit_sidebar": "1"},
    )


def test_postgres_track_file_entry_batch_uses_effective_persisted_exception_values(
    monkeypatch,
):
    from music_app.services.library_browse_postgres import (
        PostgresLibraryBrowseRepository,
    )

    selected_path = r"D:\Music\Exception Artist\Exception Album\01 Rarity.flac"
    unrelated_path = r"D:\Music\Exception Artist\Exception Album\02 Other.flac"
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: None,
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    selected_row = _persisted_non_album_override_row(
        track_id=9691,
        title="Rarity",
        track_number=1,
        private_path=selected_path,
    )
    unrelated_row = _exception_album_row(
        track_id=9692,
        track_key="exception-album-9692",
        title="Other",
        track_number=2,
        duration_seconds=122,
        private_path=unrelated_path,
    )
    monkeypatch.setattr(
        repository,
        "_load_album_rows_by_track_paths",
        lambda track_paths: (
            [selected_row, unrelated_row]
            if track_paths == {selected_path}
            else []
        ),
    )

    entries = repository.build_track_file_entries_by_paths({selected_path})

    assert set(entries) == {selected_path}
    assert entries[selected_path]["exception_type"] == "Non-album rarity"
    assert entries[selected_path]["album"] == "Exception Album"
    assert entries[selected_path]["album_artist"] == "Exception Artist"


def test_postgres_track_file_entry_batch_resolves_detached_non_album_paths(
    monkeypatch,
):
    from music_app.services.library_browse_postgres import (
        PostgresLibraryBrowseRepository,
    )

    selected_path = r"D:\Music\Exception Artist\Loose\01 Rarity.flac"
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: None,
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    candidate = _inventory_non_album_candidate(
        track_id=9693,
        title="Rarity",
        track_number=1,
        private_path=selected_path,
        raw_artist="Exception Artist",
        raw_album_artist="Exception Artist",
    )
    candidate["raw_file_album"] = ""
    monkeypatch.setattr(repository, "_load_album_rows_by_track_paths", lambda _paths: [])
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_non_album_candidates",
        lambda **kwargs: [candidate]
        if kwargs.get("private_paths") == {selected_path}
        else [],
    )

    entries = repository.build_track_file_entries_by_paths({selected_path})

    assert set(entries) == {selected_path}
    assert entries[selected_path]["exception_type"] == "Non-album rarity"
    assert entries[selected_path]["album"] == ""
    assert entries[selected_path]["album_artist"] == "Exception Artist"


def test_postgres_selected_artist_payload_excludes_persisted_non_album_override_and_keeps_sibling(
    monkeypatch,
):
    from music_app.services.library_browse_postgres import _selected_artist_sql

    overridden_path = r"D:\Music\Exception Artist\Exception Album\01 Rarity.flac"
    sibling_path = r"D:\Music\Exception Artist\Exception Album\02 Album Track.flac"
    payload = _selected_artist_payload_for_exception_rows(
        monkeypatch,
        [
            _persisted_non_album_override_row(
                track_id=9701,
                title="Rarity",
                track_number=1,
                private_path=overridden_path,
            ),
            _exception_album_row(
                track_id=9702,
                track_key="exception-album-9702",
                title="Album Track",
                track_number=2,
                duration_seconds=122,
                private_path=sibling_path,
            ),
        ],
    )

    albums = payload["primary_artist_groups"][0]["albums"]
    assert [track["path"] for track in albums[0]["tracks"]] == [sibling_path]
    assert albums[0]["tracks"][0]["is_problematic"] is True
    assert payload["album_count"] == 1
    sql = " ".join(_selected_artist_sql().split())
    assert "library.exception_overrides" in sql
    assert "override_payload ->> 'exception_type'" in sql


def test_postgres_selected_artist_payload_omits_album_when_all_tracks_have_persisted_non_album_overrides(
    monkeypatch,
):
    first_path = r"D:\Music\Exception Artist\Exception Album\01 Rarity.flac"
    second_path = r"D:\Music\Exception Artist\Exception Album\02 Interview.flac"
    payload = _selected_artist_payload_for_exception_rows(
        monkeypatch,
        [
            _persisted_non_album_override_row(
                track_id=9711,
                title="Rarity",
                track_number=1,
                private_path=first_path,
            ),
            _persisted_non_album_override_row(
                track_id=9712,
                title="Interview",
                track_number=2,
                private_path=second_path,
            ),
        ],
    )

    assert payload["primary_artist_groups"] == []
    assert payload["artist_groups"] == []
    assert payload["album_count"] == 0


def test_postgres_selected_artist_blank_override_masks_embedded_non_album_value(
    monkeypatch,
):
    path = r"D:\Music\Exception Artist\Exception Album\01 Restored.flac"
    row = _exception_album_row(
        track_id=9713,
        track_key="exception-album-9713",
        title="Restored",
        track_number=1,
        duration_seconds=123,
        private_path=path,
        exception_type="Non-album rarity",
    )
    row["exception_type"] = ""
    row["exception_override_present"] = True

    payload = _selected_artist_payload_for_exception_rows(monkeypatch, [row])

    albums = payload["primary_artist_groups"][0]["albums"]
    assert [track["path"] for track in albums[0]["tracks"]] == [path]


def test_postgres_album_detail_payload_excludes_persisted_non_album_override_and_keeps_sibling(
    monkeypatch,
):
    from music_app.services.library_browse_postgres import (
        PostgresLibraryBrowseRepository,
        _album_detail_sql,
    )

    overridden_path = r"D:\Music\Exception Artist\Exception Album\01 Rarity.flac"
    sibling_path = r"D:\Music\Exception Artist\Exception Album\02 Album Track.flac"
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: None,
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(
        repository,
        "_load_album_detail_rows",
        lambda _album_key: [
            _persisted_non_album_override_row(
                track_id=9721,
                title="Rarity",
                track_number=1,
                private_path=overridden_path,
            ),
            _exception_album_row(
                track_id=9722,
                track_key="exception-album-9722",
                title="Album Track",
                track_number=2,
                duration_seconds=122,
                private_path=sibling_path,
            ),
        ],
    )

    payload = repository.build_album_detail_payload("exception-artist-exception-album")

    assert payload is not None
    assert [track["path"] for track in payload["tracks"]] == [sibling_path]
    assert payload["track_count_preview"] == 1
    sql = " ".join(_album_detail_sql().split())
    assert "library.exception_overrides" in sql
    assert "override_payload ->> 'exception_type'" in sql


def test_postgres_album_detail_blank_override_masks_embedded_non_album_value(
    monkeypatch,
):
    from music_app.services.library_browse_postgres import (
        PostgresLibraryBrowseRepository,
    )

    path = r"D:\Music\Exception Artist\Exception Album\01 Restored.flac"
    row = _exception_album_row(
        track_id=9723,
        track_key="exception-album-9723",
        title="Restored",
        track_number=1,
        duration_seconds=123,
        private_path=path,
        exception_type="Non-album rarity",
    )
    row["exception_type"] = ""
    row["exception_override_present"] = True
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: None,
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(
        repository,
        "_load_album_detail_rows",
        lambda _album_key: [row],
    )

    payload = repository.build_album_detail_payload(
        "exception-artist-exception-album"
    )

    assert payload is not None
    assert [track["path"] for track in payload["tracks"]] == [path]


def test_postgres_album_detail_payload_omits_album_when_all_tracks_have_persisted_non_album_overrides(
    monkeypatch,
):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: None,
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(
        repository,
        "_load_album_detail_rows",
        lambda _album_key: [
            _persisted_non_album_override_row(
                track_id=9731,
                title="Rarity",
                track_number=1,
                private_path=r"D:\Music\Exception Artist\Exception Album\01 Rarity.flac",
            ),
            _persisted_non_album_override_row(
                track_id=9732,
                title="Interview",
                track_number=2,
                private_path=r"D:\Music\Exception Artist\Exception Album\02 Interview.flac",
            ),
        ],
    )

    assert repository.build_album_detail_payload("exception-artist-exception-album") is None


def test_postgres_album_projections_mark_full_scope_for_incomplete_track_order(monkeypatch):
    import music_app.services.album_details as album_details_module
    from music_app.services.library_browse_postgres import (
        PostgresLibraryBrowseRepository,
        _problematic_album_detail_payload,
        _problematic_album_projection_payloads,
    )

    problematic_path = r"D:\Music\Neal Morse\Neal Morse Plays Pink Floyd\18 - Echoes.flac"
    healthy_path = r"D:\Music\Neal Morse\Neal Morse Plays Pink Floyd\02 - Breathe.flac"
    ignored_only_path = r"D:\Music\Neal Morse\Neal Morse Plays Pink Floyd\03 - Time.flac"

    problematic_row = _normal_problematic_product_row(
        album_key="neal-morse::neal-morse-plays-pink-floyd",
        album_title="Neal Morse Plays Pink Floyd",
    )
    problematic_row.update({
        "album_cover_path": r"D:\Music\Neal Morse\Neal Morse Plays Pink Floyd\cover.jpg",
        "album_release_year": 2023,
        "artist_name": "Neal Morse",
        "track_id": 518,
        "track_key": "neal-morse-pink-floyd-18",
        "track_title": "Echoes",
        "track_number": None,
        "file_private_path": problematic_path,
    })
    problematic_row["album_metadata"] = {
        "album_artist": "Neal Morse",
        "artists": ["Neal Morse"],
    }
    problematic_row["file_entry"] = {
        "path": problematic_path,
        "album": "Neal Morse Plays Pink Floyd",
        "album_artist": "Neal Morse",
        "artist": "Neal Morse",
        "title": "Echoes",
        "year": "2023",
        "track_number": None,
    }

    healthy_row = _normal_problematic_product_row(
        album_key="neal-morse::neal-morse-plays-pink-floyd",
        album_title="Neal Morse Plays Pink Floyd",
    )
    healthy_row.update({
        "album_cover_path": r"D:\Music\Neal Morse\Neal Morse Plays Pink Floyd\cover.jpg",
        "album_release_year": 2023,
        "artist_name": "Neal Morse",
        "track_id": 502,
        "track_key": "neal-morse-pink-floyd-02",
        "track_title": "Breathe",
        "track_number": 2,
        "file_private_path": healthy_path,
    })
    healthy_row["album_metadata"] = dict(problematic_row["album_metadata"])
    healthy_row["file_entry"] = {
        "path": healthy_path,
        "album": "Neal Morse Plays Pink Floyd",
        "album_artist": "Neal Morse",
        "artist": "Neal Morse",
        "title": "Breathe",
        "year": "2023",
        "track_number": 2,
    }

    ignored_only_row = _normal_problematic_product_row(
        album_key="neal-morse::neal-morse-plays-pink-floyd",
        album_title="Neal Morse Plays Pink Floyd",
    )
    ignored_only_row.update({
        "album_cover_path": r"D:\Music\Neal Morse\Neal Morse Plays Pink Floyd\cover.jpg",
        "album_release_year": 2023,
        "artist_name": "Neal Morse",
        "track_id": 503,
        "track_key": "neal-morse-pink-floyd-03",
        "track_title": "Time",
        "track_number": None,
        "file_private_path": ignored_only_path,
        "ignored_repair_keys": [f"{ignored_only_path}::track_number"],
    })
    ignored_only_row["album_metadata"] = dict(problematic_row["album_metadata"])
    ignored_only_row["file_entry"] = {
        "path": ignored_only_path,
        "album": "Neal Morse Plays Pink Floyd",
        "album_artist": "Neal Morse",
        "artist": "Neal Morse",
        "title": "Time",
        "year": "2023",
        "track_number": None,
    }
    projection_rows = [healthy_row, ignored_only_row, problematic_row]
    authoritative_detail = _problematic_album_detail_payload(
        _problematic_album_projection_payloads(projection_rows)[0]
    )
    assert authoritative_detail is not None
    assert set(authoritative_detail["problematic_track_paths"]) == {
        healthy_path,
        ignored_only_path,
        problematic_path,
    }

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: None,
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(repository, "_load_album_detail_rows", lambda _album_key: projection_rows)
    monkeypatch.setattr(
        repository,
        "_load_album_rows_by_track_paths",
        lambda _track_paths: projection_rows,
    )
    monkeypatch.setattr(
        repository,
        "_load_problematic_file_rows",
        lambda **_kwargs: projection_rows,
    )
    monkeypatch.setattr(album_details_module, "build_scrobbled_play_count_lookup", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(album_details_module, "build_track_preference_overlay_lookup", lambda *_args, **_kwargs: {})

    payload = repository.build_album_detail_payload("neal-morse::neal-morse-plays-pink-floyd")

    assert payload is not None
    tracks_by_path = {track["path"]: track for track in payload["tracks"]}
    assert tracks_by_path[problematic_path]["is_problematic"] is True
    assert tracks_by_path[healthy_path]["is_problematic"] is True
    assert tracks_by_path[ignored_only_path]["is_problematic"] is True

    structural_payloads = repository.build_album_payloads_by_track_paths(
        {problematic_path},
    )

    assert len(structural_payloads) == 1
    structural_tracks_by_path = {
        track["path"]: track
        for track in structural_payloads[0]["tracks"]
    }
    assert structural_tracks_by_path[problematic_path]["is_problematic"] is True
    assert structural_tracks_by_path[healthy_path]["is_problematic"] is True
    assert structural_tracks_by_path[ignored_only_path]["is_problematic"] is True


def test_album_detail_sql_scopes_ignored_repairs_to_requested_album_paths():
    from music_app.services.library_browse_postgres import (
        _album_detail_sql,
        _album_rows_by_track_paths_sql,
    )

    sql = " ".join(_album_detail_sql().split()).lower()
    ignored_rollup = sql.split("ignored_repair_rollup as (", 1)[1].split(") select", 1)[0]

    assert "library.local_albums.album_key = %(album_key)s" in ignored_rollup
    assert "split_part(library.ignored_repairs.repair_key, '::', 1)" in ignored_rollup
    assert "library.local_track_files.private_path" in ignored_rollup
    assert "library.ignored_repairs.repair_key ~ '::problem-album::[^:]+$'" in ignored_rollup
    assert "library.ignored_repairs.metadata ->> 'album_key'" in ignored_rollup
    assert "library.local_track_files.library_id" not in ignored_rollup
    assert "group by library.ignored_repairs.library_id" not in ignored_rollup

    structural_sql = " ".join(_album_rows_by_track_paths_sql().split()).lower()
    structural_rollup = structural_sql.split("ignored_repair_rollup as (", 1)[1].split(
        ") separate_release_rollup", 1
    )[0]
    assert "library.ignored_repairs.repair_key ~ '::problem-album::[^:]+$'" in structural_rollup
    assert "library.ignored_repairs.metadata ->> 'album_key'" in structural_rollup
    assert "library.local_track_files.library_id" not in structural_rollup
    assert "matched_album_ids.album_id = library.local_albums.id" in structural_rollup


def test_postgres_album_detail_preserves_raw_featured_title_and_projects_track_artist_credit(monkeypatch):
    import music_app.services.album_details as album_details_module
    from music_app.services.library_browse_postgres import (
        PostgresLibraryBrowseRepository,
        _album_detail_sql,
    )

    raw_title = "Signal (feat. Featured Voice)"
    repository = PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "MUSIC_DIR": r"X:\SyntheticMusic",
        },
        connect=lambda _database_url: None,
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(
        repository,
        "_load_album_detail_rows",
        lambda _album_key: [
            {
                "artist_id": 3,
                "artist_name": "Various Artists",
                "artist_sort_name": "Various Artists",
                "album_id": 301,
                "album_key": "various-artists::signals",
                "album_title": "Signals",
                "album_release_year": 2026,
                "album_cover_path": r"X:\SyntheticMusic\Various Artists\Signals\cover.jpg",
                "album_metadata": {
                    "album_artist": "Various Artists",
                    "artists": ["Solo Voice", "Featured Voice"],
                },
                "track_id": 7001,
                "track_key": "signals-01",
                "track_title": raw_title,
                "track_artist_name": "Various Artists",
                "track_metadata": {"secondaryCredit": "feat. Persisted Voice"},
                "disc_number": 1,
                "track_number": 1,
                "duration_seconds": 214,
                "file_private_path": r"X:\SyntheticMusic\Various Artists\Signals\01 - Signal.flac",
                "file_library_root_id": 1,
                "file_library_root_category": "main_library",
                "file_entry": {"artist": "Solo Voice"},
            }
        ],
    )
    monkeypatch.setattr(
        album_details_module,
        "build_scrobbled_play_count_lookup",
        lambda *_args, **_kwargs: {},
    )
    monkeypatch.setattr(
        album_details_module,
        "build_track_preference_overlay_lookup",
        lambda *_args, **_kwargs: {},
    )

    payload = repository.build_album_detail_payload("various-artists::signals")

    assert payload is not None
    assert payload["tracks"][0]["title"] == raw_title
    assert payload["tracks"][0]["artist"] == "Solo Voice"
    assert payload["track_rows"][0]["title"] == "Signal"
    assert payload["tracks"][0]["secondary_credit"] == "feat. Persisted Voice"
    assert payload["track_rows"][0]["secondary_artist"] == "feat. Persisted Voice"
    sql = " ".join(_album_detail_sql().split())
    assert "left join library.local_artists track_artists" in sql
    assert "track_artists.name as track_artist_name" in sql
    assert "library.local_tracks.metadata as track_metadata" in sql


def test_postgres_direct_search_matches_album_ids_before_fetching_all_track_rows():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_id": 10,
                    "artist_name": "Broadcast",
                    "artist_sort_name": "Broadcast",
                    "album_id": 101,
                    "album_key": "broadcast-tender-buttons",
                    "album_title": "Tender Buttons",
                    "album_release_year": 2005,
                    "album_cover_path": "covers/tender.jpg",
                    "album_metadata": {
                        "album_artist": "Broadcast",
                        "artists": ["Broadcast"],
                    },
                    "track_count": 2,
                    "total_duration_seconds": 316,
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )

    payload = repository.build_search_payload(query_params={"surface": "albums", "q": "needle"})

    albums = payload["artist_groups"][0]["albums"]
    assert len(albums) == 1
    assert albums[0]["preview_only"] is True
    assert albums[0]["track_count_preview"] == 2
    assert albums[0]["total_duration_seconds"] == 316
    assert albums[0]["total_duration_display"] == "5m 16s"
    assert "tracks" not in albums[0]

    sql = str(executed[4])
    assert "visible_album_ids as materialized (" in sql
    assert "matched_album_ids as materialized (" in sql
    assert "from matched_album_ids" in sql
    assert "library.local_albums.id = matched_album_ids.album_id" in sql
    assert "join album_rows" not in sql
    assert "matched_album_identities as (" in sql
    assert "join matched_album_identities" in sql


def test_postgres_search_payload_preserves_aggregate_preview_rows_without_track_identity(monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(repository, "_load_exact_artist_match", lambda *_args, **_kwargs: "")
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda *_args, **_kwargs: [
            {
                "artist_id": 70,
                "artist_name": "E2E Rarity Artist",
                "artist_sort_name": "E2E Rarity Artist",
                "album_id": 701,
                "album_key": "e2e-rarity-artist-two-track-rarity-fixture",
                "album_title": "Two Track Rarity Fixture",
                "album_release_year": 2026,
                "album_cover_path": None,
                "album_metadata": {
                    "album_artist": "E2E Rarity Artist",
                    "artists": ["E2E Rarity Artist"],
                },
                "track_count": 2,
                "total_duration_seconds": 316,
            }
        ],
    )

    payload = repository.build_search_payload(
        query_params={
            "surface": "albums",
            "q": "rarity fixture",
            "all_artists": "1",
            "omit_sidebar": "1",
        },
    )

    assert [group["artist"] for group in payload["artist_groups"]] == ["E2E Rarity Artist"]
    albums = payload["artist_groups"][0]["albums"]
    assert [album["name"] for album in albums] == ["Two Track Rarity Fixture"]
    assert albums[0]["track_count_preview"] == 2
    assert albums[0]["total_duration_seconds"] == 316
    assert albums[0]["total_duration_display"] == "5m 16s"


def test_postgres_direct_search_scans_each_indexed_base_table_once_before_album_expansion():
    from music_app.services.library_browse_postgres import _search_preview_sql

    sql = " ".join(_search_preview_sql().split())

    assert sql.count("like lower(%(query_like)s)") == 6
    assert "album_title_matches as materialized (" in sql
    assert "display_artist_matches as materialized (" in sql
    assert "credited_artist_matches as materialized (" in sql
    assert "track_title_matches as materialized (" in sql
    assert "file_name_matches as materialized (" in sql
    assert "file_basename_matches as materialized (" not in sql
    assert "file_stem_matches as materialized (" not in sql
    assert "from library.local_albums where lower(btrim(coalesce(library.local_albums.title, '')))" in sql
    assert "from library.local_artists where lower(btrim(coalesce(library.local_artists.name, '')))" in sql
    assert (
        "lower(btrim(coalesce(library.local_albums.metadata ->> 'album_artist', ''))) "
        "like lower(%(query_like)s)"
    ) in sql
    assert (
        "lower(btrim(coalesce(library.local_tracks.title, ''))) "
        "like lower(%(query_like)s)"
    ) in sql
    assert sql.count("from library.local_track_files where") == 1
    assert "matched_track_album_ids as materialized (" in sql
    assert "search_candidate_album_ids as materialized (" in sql
    assert "eligible_matched_track_album_ids as materialized (" in sql
    assert (
        "join search_candidate_album_ids "
        "on search_candidate_album_ids.library_id = library.local_tracks.library_id"
    ) in sql
    assert "join album_rows" not in sql
    assert sql.count("from matched_album_ids") == 1
    assert (
        "matched_album_identities as ( select distinct "
        "matched_album_rows.library_id, matched_album_rows.album_id from matched_album_rows )"
    ) in sql
    assert "join matched_album_identities" in sql
    assert "sum(distinct library.local_tracks.duration_seconds)" not in sql


def test_album_eligibility_uses_index_addressable_override_precedence_without_or_scan():
    from music_app.services.library_browse_postgres import (
        _eligible_album_tracks_cte_sql,
        _exact_artist_match_sql,
        _search_preview_sql,
    )

    sql = " ".join(_eligible_album_tracks_cte_sql().split()).lower()

    assert "track_override_defaults as materialized (" in sql
    assert "select distinct on (" in sql
    assert "library.exception_overrides.track_id )" in sql
    assert "left join library.exception_overrides as path_override" in sql
    assert "path_override.track_key = library.local_track_files.private_path" in sql
    assert "left join track_override_defaults as track_override" in sql
    assert "track_override.track_id = library.local_tracks.id" in sql
    assert "library.local_track_files.scan_cache_stale is false" in sql
    assert "metadata #>> '{scan_cache,stale}'" not in sql
    assert (
        "when path_override.override_payload ? 'exception_type' "
        "then path_override.override_payload ->> 'exception_type'"
    ) in sql
    assert "or library.exception_overrides.track_id = library.local_tracks.id" not in sql
    assert "eligible_album_tracks as not materialized (" in " ".join(
        _exact_artist_match_sql().split()
    ).lower()
    assert "eligible_album_tracks as materialized (" in " ".join(
        _search_preview_sql().split()
    ).lower()


def test_search_deduplicates_visible_albums_and_checks_track_match_eligibility_once():
    from music_app.services.library_browse_postgres import _search_preview_sql

    sql = " ".join(_search_preview_sql().split()).lower()

    assert (
        "visible_album_ids as materialized ( select distinct "
        "library.local_albums.library_id"
    ) in sql
    assert "matched_track_album_ids as materialized (" in sql
    assert "eligible_matched_track_album_ids as materialized (" in sql
    assert sql.count("join eligible_album_tracks") == 2
    assert (
        "select eligible_matched_track_album_ids.album_id "
        "from eligible_matched_track_album_ids"
    ) in sql


def test_related_artist_preview_scopes_album_eligibility_to_the_requested_family():
    from music_app.services.library_browse_postgres import _artist_preview_rows_sql

    sql = " ".join(_artist_preview_rows_sql().split()).lower()

    target_artists_position = sql.index("target_artists as (")
    candidate_albums_position = sql.index("search_candidate_album_ids as materialized (")
    eligible_tracks_position = sql.index("eligible_album_tracks as materialized (")

    assert target_artists_position < candidate_albums_position < eligible_tracks_position
    assert (
        "join search_candidate_album_ids "
        "on search_candidate_album_ids.library_id = library.local_tracks.library_id "
        "and search_candidate_album_ids.album_id = library.local_tracks.album_id"
    ) in sql
    assert (
        "select distinct library.local_albums.library_id, "
        "library.local_albums.id as album_id from target_artists"
    ) in sql


def test_postgres_album_payloads_by_track_paths_exclude_stale_track_files_from_both_joins():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return []

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_album_payloads_by_track_paths({r"D:\Music\Artist\Album\01.flac"})

    assert payload == []
    assert executed[1] == {"track_paths": [r"D:\Music\Artist\Album\01.flac"]}
    sql = str(executed[0])
    stale_predicate = (
        "coalesce((library.local_track_files.metadata #>> '{scan_cache,stale}')::boolean, false) is false"
    )
    assert sql.count(stale_predicate) == 2

    compact_sql = " ".join(sql.split())
    assert (
        "join library.local_track_files on library.local_track_files.track_id = library.local_tracks.id "
        f"and {stale_predicate}"
    ) in compact_sql
    assert (
        "left join library.local_track_files on library.local_track_files.track_id = library.local_tracks.id "
        f"and {stale_predicate}"
    ) in compact_sql


def test_postgres_album_payloads_by_track_paths_applies_separate_release_split_to_requested_paths():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    requested_path = r"D:\Music\Split Artist\Split Album\1999\01.flac"
    other_path = r"D:\Music\Split Artist\Split Album\2001\01.flac"
    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "artist_name": "Split Artist",
                    "artist_sort_name": "Split Artist",
                    "album_id": 501,
                    "album_key": "split artist::split album",
                    "album_title": "Split Album",
                    "album_release_year": None,
                    "album_cover_path": "covers/split.jpg",
                    "album_metadata": {
                        "album_artist": "Split Artist",
                        "artists": ["Split Artist"],
                    },
                    "track_id": 9001,
                    "track_key": "split-1999-01",
                    "track_title": "1999 Track",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 120,
                    "file_private_path": requested_path,
                    "file_library_root_id": 7,
                    "file_library_root_category": "library",
                    "file_entry": {
                        "path": requested_path,
                        "album": "Split Album",
                        "album_artist": "Split Artist",
                        "artist": "Split Artist",
                        "title": "1999 Track",
                        "year": "1999",
                    },
                    "separate_release_keys": ["split artist::split album"],
                },
                {
                    "artist_name": "Split Artist",
                    "artist_sort_name": "Split Artist",
                    "album_id": 501,
                    "album_key": "split artist::split album",
                    "album_title": "Split Album",
                    "album_release_year": None,
                    "album_cover_path": "covers/split.jpg",
                    "album_metadata": {
                        "album_artist": "Split Artist",
                        "artists": ["Split Artist"],
                    },
                    "track_id": 9002,
                    "track_key": "split-2001-01",
                    "track_title": "2001 Track",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 121,
                    "file_private_path": other_path,
                    "file_library_root_id": 7,
                    "file_library_root_category": "library",
                    "file_entry": {
                        "path": other_path,
                        "album": "Split Album",
                        "album_artist": "Split Artist",
                        "artist": "Split Artist",
                        "title": "2001 Track",
                        "year": "2001",
                    },
                    "separate_release_keys": ["split artist::split album"],
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_album_payloads_by_track_paths({requested_path})

    assert executed[1] == {"track_paths": [requested_path]}
    assert "scan_cache,file_entry" in str(executed[0])
    assert payload == [
        {
            "key": "split artist::split album::year::1999",
            "album_ref": "split artist::split album::year::1999",
            "name": "Split Album",
            "album_artist": "Split Artist",
            "artists": ["Split Artist"],
            "cover_path": "covers/split.jpg",
            "cover_revision": None,
            "cover_selection_origin": None,
            "local_cover_width": None,
            "local_cover_height": None,
            "remote_cover_url": None,
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": None,
            "remote_cover_source_label": None,
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "year": "1999",
            "release_date": None,
            "edition": None,
            "root_provenance": {},
            "library_root_id": 7,
            "library_root_category": "library",
            "track_count_preview": 1,
            "total_duration_seconds": 120,
            "total_duration_display": "2m 00s",
                "tracks": [
                    {
                        "key": "split-1999-01",
                        "track_ref": "split-1999-01",
                        "title": "1999 Track",
                        "artist": "Split Artist",
                        "album_artist": "Split Artist",
                        "album": "Split Album",
                        "secondary_credit": "",
                        "genre": "",
                        "year": "1999",
                        "is_problematic": True,
                        "cover_path": "covers/split.jpg",
                        "cover_revision": None,
                        "disc_number": 1,
                        "disc_number_raw": None,
                        "track_number": 1,
                        "duration_seconds": 120,
                        "duration_display": "2m 00s",
                        "path": requested_path,
                        "track_scrobble_count": 0,
                        "track_preference_overlay": {"rating": None, "love_tier": None},
                    }
                ],
            "open_directory_paths": [r"D:\Music\Split Artist\Split Album\1999"],
            "preview_only": False,
        }
    ]


def test_postgres_album_payloads_by_track_paths_overlays_exception_override_file_entry():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    requested_path = r"D:\Music\Exception Artist\Exception Album\01.flac"
    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                _exception_album_row(
                    track_id=9601,
                    track_key="exception-album-01",
                    title="Exception Track",
                    track_number=1,
                    duration_seconds=121,
                    private_path=requested_path,
                    exception_type="Postgres override",
                ),
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_album_payloads_by_track_paths({requested_path})

    assert payload[0]["tracks"][0]["exception_type"] == "Postgres override"
    sql = str(executed[0])
    compact_sql = " ".join(sql.split())
    assert "library.exception_overrides" in sql
    assert "left join lateral" in compact_sql
    assert "override_payload ->> 'exception_type'" in sql
    assert "library.exception_overrides.track_key = library.local_track_files.private_path" in compact_sql
    assert "library.exception_overrides.track_id = library.local_tracks.id" in compact_sql
    assert (
        "order by case "
        "when library.exception_overrides.track_key = library.local_track_files.private_path then 0 "
        "when library.exception_overrides.track_id = library.local_tracks.id then 1 "
        "else 2 end"
    ) in compact_sql
    assert "scan_cache,file_entry" in sql
    assert executed[1] == {"track_paths": [requested_path]}


def test_postgres_album_payloads_by_track_paths_excludes_exception_track_and_keeps_sibling():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    requested_path = r"D:\Synthetic Music\Exception Artist\Exception Album\01 Apply Rarity.flac"
    sibling_path = r"D:\Synthetic Music\Exception Artist\Exception Album\02 Remain Editable.flac"
    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                _exception_album_row(
                    track_id=9601,
                    track_key="exception-album-01",
                    title="Apply Rarity",
                    track_number=1,
                    duration_seconds=121,
                    private_path=requested_path,
                    exception_type="Non-album rarity",
                ),
                _exception_album_row(
                    track_id=9602,
                    track_key="exception-album-02",
                    title="Remain Editable",
                    track_number=2,
                    duration_seconds=122,
                    private_path=sibling_path,
                ),
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_album_payloads_by_track_paths({requested_path, sibling_path})

    assert payload == [
        {
            "key": "exception-artist-exception-album",
            "album_ref": "exception-artist-exception-album",
            "name": "Exception Album",
            "album_artist": "Exception Artist",
            "artists": ["Exception Artist"],
            "cover_path": "covers/exception.jpg",
            "cover_revision": None,
            "cover_selection_origin": None,
            "local_cover_width": None,
            "local_cover_height": None,
            "remote_cover_url": None,
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": None,
            "remote_cover_source_label": None,
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "year": 2026,
            "release_date": None,
            "edition": None,
            "root_provenance": {},
            "library_root_id": 9,
            "library_root_category": "library",
            "track_count_preview": 1,
            "total_duration_seconds": 122,
            "total_duration_display": "2m 02s",
            "tracks": [
                {
                    "key": "exception-album-02",
                    "track_ref": "exception-album-02",
                    "title": "Remain Editable",
                    "artist": "Exception Artist",
                    "album_artist": "Exception Artist",
                    "album": "Exception Album",
                    "secondary_credit": "",
                    "genre": "",
                    "year": "2026",
                    "is_problematic": True,
                    "cover_path": "covers/exception.jpg",
                    "cover_revision": None,
                    "disc_number": 1,
                    "disc_number_raw": None,
                    "track_number": 2,
                    "duration_seconds": 122,
                    "duration_display": "2m 02s",
                    "path": sibling_path,
                    "track_scrobble_count": 0,
                    "track_preference_overlay": {"rating": None, "love_tier": None},
                }
            ],
            "open_directory_paths": [r"D:\Synthetic Music\Exception Artist\Exception Album"],
            "preview_only": False,
        }
    ]
    sql = str(executed[0])
    compact_sql = " ".join(sql.split())
    assert "library.exception_overrides" in sql
    assert "left join lateral" in compact_sql
    assert "override_payload ->> 'exception_type'" in sql
    assert "library.exception_overrides.track_key = library.local_track_files.private_path" in compact_sql
    assert "library.exception_overrides.track_id = library.local_tracks.id" in compact_sql
    assert (
        "order by case "
        "when library.exception_overrides.track_key = library.local_track_files.private_path then 0 "
        "when library.exception_overrides.track_id = library.local_tracks.id then 1 "
        "else 2 end"
    ) in compact_sql
    assert "scan_cache,file_entry" in sql
    assert executed[1] == {"track_paths": sorted([requested_path, sibling_path])}


def test_postgres_album_payloads_by_track_paths_drops_album_when_all_tracks_are_exceptions():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    requested_path = r"D:\Synthetic Music\Exception Artist\Exception Album\01 Apply Rarity.flac"

    class FakeCursor:
        def fetchall(self):
            return [
                _exception_album_row(
                    track_id=9601,
                    track_key="exception-album-01",
                    title="Apply Rarity",
                    track_number=1,
                    duration_seconds=121,
                    private_path=requested_path,
                    exception_type="Non-album rarity",
                ),
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, _params=None):
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    assert repository.build_album_payloads_by_track_paths({requested_path}) == []


def test_postgres_library_browse_builds_problematic_files_projection_from_rows():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "album_id": 101,
                    "album_key": "broken-album",
                    "album_title": "Broken Album",
                    "album_release_year": None,
                    "album_cover_path": None,
                    "album_metadata": {
                        "album_artist": "Broken Artist",
                        "artists": ["Broken Artist"],
                        "root_provenance": {"primary_category": "new_arrivals"},
                    },
                    "artist_name": "Broken Artist",
                    "track_id": 1001,
                    "track_key": "broken-album-01",
                    "track_title": "First Track",
                    "disc_number": 1,
                    "track_number": None,
                    "duration_seconds": 93,
                    "file_private_path": r"D:\Music\Broken Artist\Broken Album\01.flac",
                    "file_entry": {
                        "path": r"D:\Music\Broken Artist\Broken Album\01.flac",
                        "album": "Broken Album",
                        "album_artist": "Broken Artist",
                        "artist": "Broken Artist",
                        "title": "First Track",
                        "track_number": None,
                        "disc_number": 1,
                        "year": None,
                    },
                    "ignored_repair_keys": [],
                    "separate_release_keys": [],
                    "duplicate_file_count": 1,
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_problematic_files_payload()
    detail_payload = repository.build_problematic_file_detail_payload("broken-album")

    assert payload["count"] == 1
    assert payload["persistence_backend"] == "postgres"
    assert payload["persistence_seam"] == "library_browse"
    assert payload["view_data_source"] == "postgres_library_browse"
    item = payload["items"][0]
    assert item["key"] == "broken-album"
    assert item["name"] == "Broken Album"
    assert item["album_artist"] == "Broken Artist"
    assert "Missing year" in item["problem_reasons"]
    assert "Missing cover art" in item["problem_reasons"]
    assert "Missing track number" in item["problem_reasons"]
    assert len(item["problem_reasons"]) == len(set(item["problem_reasons"]))
    assert item["issue_count"] == len(item["problem_reasons"])
    assert item["track_count"] == 1
    assert item["track_paths"] == [r"D:\Music\Broken Artist\Broken Album\01.flac"]
    assert item["detail_loaded"] is False
    assert item["search_text"] == "First Track"
    assert "root_provenance" not in item
    assert "track_problem_rows" not in item
    assert "remote_cover_url" not in item
    assert "remote_cover_thumbnail_url" not in item

    initial_detail = payload["initial_detail"]
    assert initial_detail["key"] == item["key"]
    assert initial_detail["detail_loaded"] is True
    assert initial_detail["root_provenance"] == {"primary_category": "new_arrivals"}
    assert initial_detail["track_problem_rows"][0]["filename"] == "01.flac"
    assert initial_detail["problem_reasons"] == item["problem_reasons"]
    assert initial_detail["issue_count"] == len(initial_detail["problem_reasons"])

    album_problem_rows = initial_detail["album_problem_rows"]
    assert [row["reason"] for row in album_problem_rows] == [
        "Missing year",
        "Missing cover art",
    ]
    assert all(row["album_key"] == "broken-album" for row in album_problem_rows)
    assert len({row["row_key"] for row in album_problem_rows}) == len(album_problem_rows)
    assert all(row["row_key"] not in {row["reason"], "Broken Album"} for row in album_problem_rows)
    assert {row["row_key"] for row in album_problem_rows} == {
        "broken-album::problem-album::missing-year",
        "broken-album::problem-album::missing-cover-art",
    }
    assert all(r"D:\Music" not in row["row_key"] for row in album_problem_rows)

    track_problem_row = initial_detail["track_problem_rows"][0]
    assert [row["reason"] for row in track_problem_row["ignorable_reasons"]] == track_problem_row["reasons"]
    assert all(row["path"] == track_problem_row["path"] for row in track_problem_row["ignorable_reasons"])
    assert len({row["row_key"] for row in track_problem_row["ignorable_reasons"]}) == len(
        track_problem_row["ignorable_reasons"]
    )
    assert all(
        row["row_key"] not in {row["reason"], track_problem_row["filename"]}
        for row in track_problem_row["ignorable_reasons"]
    )
    missing_track_number_row = next(
        row
        for row in track_problem_row["ignorable_reasons"]
        if row["reason"] == "Missing track number"
    )
    assert missing_track_number_row == {
        "row_key": (
            r"D:\Music\Broken Artist\Broken Album\01.flac"
            "::problem-file::missing-track-number"
        ),
        "path": r"D:\Music\Broken Artist\Broken Album\01.flac",
        "reason": "Missing track number",
        "field": "track_number",
    }

    assert detail_payload is not None
    assert detail_payload["key"] == "broken-album"
    assert detail_payload["detail_loaded"] is True
    assert detail_payload["root_provenance"] == {"primary_category": "new_arrivals"}
    assert detail_payload["problem_reasons"] == item["problem_reasons"]
    assert detail_payload["issue_count"] == len(detail_payload["problem_reasons"])
    assert detail_payload["tracks"][0]["title"] == "First Track"
    assert detail_payload["track_problem_rows"][0]["filename"] == "01.flac"
    assert "Missing track number" in detail_payload["track_problem_rows"][0]["reasons"]
    assert detail_payload["persistence_backend"] == "postgres"
    assert detail_payload["view_data_source"] == "postgres_library_browse"

    assert str(executed[0]) == "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
    assert str(executed[2]) == "SET LOCAL work_mem = '16MB'"
    assert str(executed[4]) == "SET LOCAL jit = off"
    candidate_sql = str(executed[6])
    assert "library.local_albums" in candidate_sql
    assert "library.local_tracks" in candidate_sql
    assert "library.local_track_files" in candidate_sql
    assert "library.ignored_repairs" in candidate_sql
    assert "library.separate_releases" in candidate_sql
    assert "scan_file_entry_is_object" in candidate_sql
    detail_sql = str(executed[8])
    assert "library.ignored_repairs" in detail_sql
    assert "library.separate_releases" in detail_sql
    from music_app.services.utils import (
        MOJIBAKE_CANDIDATE_PATTERN,
        MOJIBAKE_ENCODING_CANDIDATE_CHARS,
    )

    assert executed[7] == {
        "mojibake_candidate_pattern": MOJIBAKE_CANDIDATE_PATTERN,
        "encoding_candidate_chars": MOJIBAKE_ENCODING_CANDIDATE_CHARS,
    }
    assert executed[9] == {"album_key": "broken-album"}


def test_problematic_album_detail_explains_album_tag_problem_with_value_and_field():
    from music_app.services.library_browse_postgres import (
        _problematic_album_detail_payload,
    )

    detail = _problematic_album_detail_payload(
        {
            "key": "neal-morse-questions",
            "album_ref": "neal morse::?",
            "name": "?",
            "album_artist": "Neal Morse",
            "year": 2005,
            "cover_path": "covers/neal-morse-questions.jpg",
            "local_cover_width": 1000,
            "local_cover_height": 1000,
            "tracks": [],
            "_file_entries": [],
            "_ignored_repair_keys": set(),
            "_duplicate_file_counts": {},
        }
    )

    assert detail is not None
    assert detail["album_problem_rows"] == [
        {
            "row_key": "neal morse::?::problem-album::undecoded-characters",
            "album_key": "neal-morse-questions",
            "reason": "Undecoded characters",
            "display_reason": 'Undecoded characters ("?" in Album)',
        }
    ]


def test_album_exclusion_suppresses_matching_track_reason_and_removes_summary():
    from music_app.services.library_browse_postgres import (
        _problematic_album_summary_payload,
        _problematic_track_problem_rows,
    )

    path = r"D:\Music\Neal Morse\Questions\01 The Temple.mp3"
    album = {
        "key": "neal-morse-questions",
        "album_ref": "neal morse::?",
        "name": "?",
        "album_artist": "Neal Morse",
        "year": 2005,
        "cover_path": "covers/neal-morse-questions.jpg",
        "local_cover_width": 1000,
        "local_cover_height": 1000,
        "tracks": [{"path": path, "title": "The Temple"}],
        "_file_entries": [{
            "path": path,
            "album": "?",
            "album_artist": "Neal Morse",
            "artist": "Neal Morse",
            "title": "The Temple",
            "year": 2005,
            "track_number": 1,
            "disc_number": 1,
            "_text_mojibake_candidate": False,
        }],
        "_ignored_repair_keys": {
            "neal morse::?::problem-album::undecoded-characters",
        },
        "_duplicate_file_counts": {},
    }

    track_rows = _problematic_track_problem_rows(album)

    assert track_rows == []
    assert _problematic_album_summary_payload(
        album,
        album_scope_reasons=[],
        track_problem_rows=track_rows,
    ) is None


def test_album_exclusion_suppresses_matching_track_reason_but_preserves_other_reason():
    from music_app.services.library_browse_postgres import (
        _problematic_track_problem_rows,
    )

    path = r"D:\Music\Neal Morse\Questions\01 The Temple.mp3"
    album = {
        "key": "neal-morse-questions",
        "album_ref": "neal morse::?",
        "name": "?",
        "album_artist": "Neal Morse",
        "year": 2005,
        "tracks": [{"path": path, "title": "The Temple"}],
        "_file_entries": [{
            "path": path,
            "album": "?",
            "album_artist": "Neal Morse",
            "artist": "Neal Morse",
            "title": "The Temple",
            "year": 2005,
            "track_number": None,
            "disc_number": 1,
            "_text_mojibake_candidate": False,
        }],
        "_ignored_repair_keys": {
            "neal morse::?::problem-album::undecoded-characters",
        },
    }

    track_rows = _problematic_track_problem_rows(album)

    assert len(track_rows) == 1
    assert track_rows[0]["reasons"] == ["Missing track number"]


def test_problematic_files_summary_sql_prefilters_a_safe_superset_without_changing_detail_sql():
    from music_app.services.library_browse_postgres import _problematic_files_sql

    summary_sql = " ".join(_problematic_files_sql(candidate_summary=True).split()).lower()
    detail_sql = " ".join(_problematic_files_sql().split()).lower()

    assert "album_candidate_ids as" not in summary_sql
    assert "active_candidate_source_rows as materialized" not in summary_sql
    assert "relational_file_candidate_ids as" not in summary_sql
    assert "active_candidate_rows as" not in summary_sql
    assert "active_problem_rows as materialized" in summary_sql
    assert "duplicate_album_ids as" in summary_sql
    assert "active_album_rollup as" in summary_sql
    assert "active_candidate_ids as" in summary_sql
    assert "duplicate_track_ids as" not in summary_sql
    assert "duplicate_candidate_ids as" not in summary_sql
    assert (
        "group by active_problem_rows.album_id, active_problem_rows.track_id "
        "having count(*) > 1"
    ) in summary_sql
    assert "select duplicate_album_ids.album_id from duplicate_album_ids" in summary_sql
    assert "candidate_album_ids as" in summary_sql
    assert "active_file_refs as" not in summary_sql
    assert "active_file_entry_scalars as" not in summary_sql
    assert "join candidate_album_ids on candidate_album_ids.album_id = library.local_albums.id" in summary_sql
    assert "octet_length(" not in summary_sql
    assert summary_sql.count("translate(") >= 4
    assert summary_sql.count("~ %(mojibake_candidate_pattern)s::text") >= 2
    assert summary_sql.count("mod(ascii(candidate_character.value), 256) = 0") >= 2
    assert "position(chr(65533)" in summary_sql
    assert "position('пїѕ'" in summary_sql
    assert "nullif(btrim(coalesce(library.local_albums.cover_path" in summary_sql
    assert "library.local_albums.metadata ->> 'local_cover_width'" in summary_sql
    assert "library.local_albums.metadata ->> 'local_cover_height'" in summary_sql
    assert "library.local_tracks.scan_title_problem_candidate is true" in summary_sql
    assert "library.local_artists.scan_name_problem_candidate is true" in summary_sql
    assert "library.local_tracks.track_number is null" in summary_sql
    assert "library.local_tracks.track_number <= 0" in summary_sql
    assert "library.local_track_files.scan_file_entry_is_object is true" in summary_sql
    assert "library.local_track_files.scan_file_text_mojibake_candidate is true" in summary_sql
    assert "library.local_track_files.scan_file_metadata_problem_candidate is true" in summary_sql
    assert "scan_file_required_text_missing_candidate" not in summary_sql
    assert "required_text_missing_album_ids as" in summary_sql
    for generated_field_name in (
        "scan_file_album",
        "scan_file_album_artist",
        "scan_file_artist",
        "scan_file_title",
    ):
        assert (
            f"coalesce(library.local_track_files.{generated_field_name}, '') "
            "!~ '[^[:space:]]'"
        ) in summary_sql
    assert (
        "select required_text_missing_album_ids.album_id "
        "from required_text_missing_album_ids"
    ) in summary_sql
    assert "min(active_problem_rows.file_album) as min_file_album" in summary_sql
    assert "max(active_problem_rows.file_album) as max_file_album" in summary_sql
    assert "least( active_album_rollup.min_file_album" in summary_sql
    assert "greatest( active_album_rollup.max_file_album" in summary_sql
    assert "count(distinct lower(btrim(coalesce(" not in summary_sql
    assert "not coalesce((library.local_albums.metadata ->> 'is_compilation')::boolean, false)" in summary_sql
    assert "library.local_track_files.scan_file_year as file_year" in summary_sql
    assert "library.local_track_files.scan_cache_stale is false" in summary_sql
    assert summary_sql.count("(select count(*) = 1 from library.libraries)") == 2
    assert summary_sql.count(
        "or library.local_tracks.library_id = ("
        " select library_id from bootstrap_context )"
    ) == 2
    assert "library.ignored_repairs" in summary_sql
    summary_result_sql = summary_sql.rsplit(
        "select selected_albums.id as album_id",
        1,
    )[1]
    assert "as album_metadata" not in summary_result_sql
    assert "as file_entry" not in summary_result_sql
    assert "library.local_track_files.scan_file_album as file_album" in summary_sql
    assert "library.local_track_files.scan_file_track_number as file_track_number" in summary_sql
    assert "library.local_track_files.metadata" not in summary_sql
    assert "selected_active_track_file_rows as materialized" in summary_sql
    assert "from selected_tracks cross join lateral (" in summary_sql
    assert "library.local_track_files.track_id = selected_tracks.id" in summary_sql
    assert "offset 0 ) selected_track_file" in summary_sql
    assert "from selected_active_track_file_rows" in summary_sql
    assert "count(*) over ( partition by selected_active_track_file_rows.track_id )" in summary_sql

    assert "candidate_source_rows" not in detail_sql
    assert "candidate_album_ids" not in detail_sql
    assert (
        "where (%(album_key)s::text is null "
        "or library.local_albums.album_key = %(album_key)s::text)"
    ) in detail_sql
    assert "library.ignored_repairs" in detail_sql
    assert "library.separate_releases" in detail_sql
    assert "cross join lateral" not in detail_sql


def test_problematic_candidate_sql_groups_canonical_track_order_and_overincludes_missing_numbers():
    from music_app.services.library_browse_postgres import _problematic_files_sql

    candidate_sql = " ".join(
        _problematic_files_sql(
            candidate_summary=True,
            candidate_ids_only=True,
        ).split()
    ).lower()

    assert "active_problem_rows as materialized (" in candidate_sql
    assert "active_track_order_rollup as (" in candidate_sql
    assert "required_text_missing_album_ids as (" in candidate_sql
    assert "active_candidate_source_rows as materialized" not in candidate_sql
    assert candidate_sql.count("from library.local_track_files") == 2
    order_rows_sql = candidate_sql.split(
        "active_problem_rows as materialized (",
        1,
    )[1].split("active_album_rollup as (", 1)[0]
    assert "library.local_tracks.track_number > 0" in order_rows_sql
    assert "as effective_track_number" in order_rows_sql
    assert "from library.local_track_files" in order_rows_sql
    assert "library.local_track_files.metadata" not in order_rows_sql
    assert "library.local_track_files.private_path" not in order_rows_sql
    assert "library.local_track_files.scan_file_track_number" not in order_rows_sql
    assert "regexp_match(" not in order_rows_sql
    assert "library.local_tracks.track_number is null" in order_rows_sql
    assert "library.local_tracks.track_number <= 0" in order_rows_sql

    order_rollup_sql = candidate_sql.split(
        "active_track_order_rollup as (",
        1,
    )[1].split("candidate_album_ids as (", 1)[0]
    assert (
        "group by active_problem_rows.album_id, "
        "active_problem_rows.disc_number"
    ) in order_rollup_sql
    assert "min(active_problem_rows.effective_track_number) <> 1" in order_rollup_sql
    assert "count(distinct active_problem_rows.effective_track_number)" in order_rollup_sql
    assert "incomplete_track_order" in order_rollup_sql
    assert "active_track_order_rollup.incomplete_track_order is true" in candidate_sql


def test_problematic_files_cold_path_separates_candidate_discovery_from_indexed_row_fetch():
    from music_app.services.library_browse_postgres import _problematic_files_sql

    candidate_sql = " ".join(
        _problematic_files_sql(
            candidate_summary=True,
            candidate_ids_only=True,
        ).split()
    ).lower()
    selected_rows_sql = " ".join(
        _problematic_files_sql(
            candidate_summary=True,
            selected_album_ids=True,
        ).split()
    ).lower()

    assert "candidate_album_ids as" in candidate_sql
    assert "selected_albums as" not in candidate_sql
    assert candidate_sql.endswith(
        "select candidate_album_ids.album_id from candidate_album_ids;"
    )

    assert "candidate_album_ids as" not in selected_rows_sql
    assert "library.local_albums.id = any(%(album_ids)s::bigint[])" in selected_rows_sql
    assert "library.local_track_files.scan_file_album as file_album" in selected_rows_sql
    assert "library.local_track_files.metadata #> '{scan_cache,file_entry}'" not in selected_rows_sql


def test_problematic_candidate_sql_conservatively_overincludes_only_strong_encoding_signals():
    from music_app.services.library_browse_postgres import _problematic_files_sql

    summary_sql = " ".join(_problematic_files_sql(candidate_summary=True).split()).lower()
    candidate_sql = summary_sql.split(
        "active_problem_rows as materialized (",
        1,
    )[1].split("selected_albums as", 1)[0]

    assert "ignored_repair" not in candidate_sql
    assert "octet_length(" not in candidate_sql
    assert candidate_sql.count("translate(") >= 4
    assert candidate_sql.count("~ %(mojibake_candidate_pattern)s::text") >= 2
    assert candidate_sql.count("mod(ascii(candidate_character.value), 256) = 0") >= 2
    assert "position('??'" in candidate_sql
    assert "in ('', 'unknown', 'unknown artist', 'unknown album', 'none', 'null')" in candidate_sql
    assert "library.local_track_files.scan_file_entry_is_object is true" in summary_sql
    assert (
        "group by active_problem_rows.album_id, active_problem_rows.track_id "
        "having count(*) > 1"
    ) in candidate_sql
    assert "relational_file_candidate_ids" not in candidate_sql
    assert "duplicate_track_ids" not in candidate_sql
    assert "duplicate_candidate_ids as" not in candidate_sql
    assert "select duplicate_album_ids.album_id from duplicate_album_ids" in candidate_sql


def test_problematic_candidate_sql_includes_file_years_that_differ_from_album_year():
    from music_app.services.library_browse_postgres import _problematic_files_sql

    candidate_sql = " ".join(
        _problematic_files_sql(
            candidate_summary=True,
            candidate_ids_only=True,
        ).split()
    ).lower()
    active_candidate_sql = candidate_sql.split(
        "active_candidate_ids as (",
        1,
    )[1].split("active_track_order_rollup as (", 1)[0]

    assert "library.local_albums.release_year" in active_candidate_sql
    assert "active_album_rollup.min_file_year" in active_candidate_sql
    assert "active_album_rollup.max_file_year" in active_candidate_sql
    assert "::bigint <> library.local_albums.release_year" in active_candidate_sql


def test_problematic_album_candidates_require_at_least_one_active_track_file():
    from music_app.services.library_browse_postgres import _problematic_files_sql

    candidate_sql = " ".join(
        _problematic_files_sql(
            candidate_summary=True,
            candidate_ids_only=True,
        ).split()
    ).lower()
    active_source_sql = candidate_sql.split(
        "active_problem_rows as materialized (",
        1,
    )[1].split("active_album_rollup as (", 1)[0]
    assert "library.local_track_files.scan_cache_stale is false" in active_source_sql
    assert "library.local_tracks.id = library.local_track_files.track_id" in active_source_sql
    active_candidate_sql = candidate_sql.split(
        "active_candidate_ids as (",
        1,
    )[1].split("active_track_order_rollup as (", 1)[0]
    assert "library.local_albums.id = active_album_rollup.album_id" in active_candidate_sql
    candidate_album_sql = candidate_sql.split(
        "candidate_album_ids as (",
        1,
    )[1]
    assert "from active_candidate_ids" in candidate_album_sql


def test_problematic_candidate_safe_superset_keeps_exact_python_output_in_parity_with_all_rows():
    from music_app.services.library_browse_postgres import (
        _problematic_album_projection_payloads,
        _problematic_album_summary_payload,
    )

    def healthy_row(album_id, album_key, album_title, artist="Product Artist"):
        row = _normal_problematic_product_row(album_key=album_key, album_title=album_title)
        row.update({
            "album_id": album_id,
            "album_release_year": 2001,
            "album_cover_path": rf"D:\Music\{artist}\{album_title}\cover.jpg",
            "artist_name": artist,
            "album_metadata": {
                "album_artist": artist,
                "artists": [artist],
                "local_cover_width": 1000,
                "local_cover_height": 1000,
            },
        })
        row["file_entry"] = {
            **row["file_entry"],
            "album": album_title,
            "album_artist": artist,
            "artist": artist,
            "year": "2001",
            "track_number": 1,
        }
        return row

    healthy_ascii = healthy_row(201, "healthy", "Healthy Album")
    healthy_unicode = healthy_row(202, "unicode", "Björk Album", artist="Björk")
    healthy_cyrillic = healthy_row(205, "cyrillic", "Здоровый альбом", artist="Исполнитель")
    missing_track_number = healthy_row(203, "problem", "Problem Album")
    missing_track_number["track_number"] = None
    missing_track_number["file_entry"]["track_number"] = None
    ignored_track_number = healthy_row(204, "ignored", "Ignored Album")
    ignored_track_number["track_number"] = None
    ignored_track_number["file_entry"]["track_number"] = None
    ignored_path = ignored_track_number["file_private_path"]
    ignored_track_number["ignored_repair_keys"] = [f"{ignored_path}::track_number"]

    all_rows = [healthy_ascii, healthy_unicode, healthy_cyrillic, missing_track_number, ignored_track_number]
    candidate_rows = [healthy_unicode, missing_track_number, ignored_track_number]

    def exact_summaries(rows):
        summaries = [
            summary
            for album in _problematic_album_projection_payloads(rows)
            if (summary := _problematic_album_summary_payload(album)) is not None
        ]
        return sorted(
            [(summary["key"], summary["problem_reasons"]) for summary in summaries],
            key=lambda item: item[0],
        )

    assert exact_summaries(candidate_rows) == exact_summaries(all_rows)
    assert exact_summaries(all_rows) == [("problem", ["Missing track number"])]


def test_problematic_projection_marks_only_file_years_that_differ_from_album_year():
    from music_app.services.library_browse_postgres import (
        _problematic_album_detail_payload,
        _problematic_album_projection_payloads,
        _problematic_album_summary_payload,
    )

    rows = []
    for track_number, file_year in ((1, 1990), (2, 1990), (3, 1999)):
        row = _normal_problematic_product_row(
            album_key="studio-records-2",
            album_title="Studio Records2",
        )
        track_path = rf"D:\Music\Product Artist\Studio Records2\{track_number:02d}.flac"
        row.update(
            {
                "album_release_year": 1999,
                "album_cover_path": r"D:\Music\Product Artist\Studio Records2\cover.jpg",
                "album_metadata": {
                    "album_artist": "Product Artist",
                    "artists": ["Product Artist"],
                    "local_cover_width": 1000,
                    "local_cover_height": 1000,
                },
                "track_id": 500 + track_number,
                "track_key": f"studio-track-{track_number}",
                "track_title": f"Studio Track {track_number}",
                "track_number": track_number,
                "file_private_path": track_path,
                "file_entry": {
                    **row["file_entry"],
                    "path": track_path,
                    "album": "Studio Records2",
                    "title": f"Studio Track {track_number}",
                    "year": file_year,
                    "track_number": track_number,
                },
            }
        )
        rows.append(row)

    album = _problematic_album_projection_payloads(rows)[0]
    summary = _problematic_album_summary_payload(album)
    detail = _problematic_album_detail_payload(album)

    assert summary is not None
    assert "Year mismatch" in summary["problem_reasons"]
    assert detail is not None
    mismatched_paths = [
        rows[0]["file_private_path"],
        rows[1]["file_private_path"],
    ]
    matching_path = rows[2]["file_private_path"]
    assert detail["problematic_track_paths"] == mismatched_paths
    assert matching_path not in detail["problematic_track_paths"]
    assert [row["path"] for row in detail["track_problem_rows"]] == mismatched_paths
    assert {
        tuple(problem_row["reasons"])
        for problem_row in detail["track_problem_rows"]
    } == {("Year mismatch",)}


@pytest.mark.parametrize(
    ("field_name", "reason"),
    [
        ("album", "Missing album"),
        ("album_artist", "Missing album artist"),
        ("artist", "Missing track artist"),
        ("title", "Missing track title"),
    ],
)
@pytest.mark.parametrize("blank_value", ["", "\t\n"])
@pytest.mark.parametrize("compact_row", [False, True])
def test_problematic_projection_preserves_explicit_blank_required_file_tags(
    field_name,
    reason,
    blank_value,
    compact_row,
):
    from music_app.services.library_browse_postgres import (
        _problematic_album_projection_payloads,
        _problematic_album_summary_payload,
    )

    row = _normal_problematic_product_row()
    row.update({
        "album_release_year": 2001,
        "album_cover_path": r"D:\Music\Product Artist\Product Album\cover.jpg",
    })
    row["file_entry"]["year"] = "2001"
    row["file_entry"][field_name] = blank_value
    if compact_row:
        file_entry = row.pop("file_entry")
        row.update({
            "file_entry_is_object": True,
            "file_album": file_entry["album"],
            "file_album_artist": file_entry["album_artist"],
            "file_artist": file_entry["artist"],
            "file_title": file_entry["title"],
            "file_year": file_entry["year"],
            "file_track_number": file_entry["track_number"],
            "file_text_mojibake_candidate": False,
        })

    album = _problematic_album_projection_payloads([row])[0]
    summary = _problematic_album_summary_payload(album)

    assert summary is not None
    assert reason in summary["problem_reasons"]


def test_problematic_projection_preserves_an_explicit_empty_scan_entry():
    from music_app.services.library_browse_postgres import (
        _problematic_album_projection_payloads,
        _problematic_album_summary_payload,
    )

    full_row = _normal_problematic_product_row()
    full_row.update({
        "album_release_year": 2001,
        "album_cover_path": r"D:\Music\Product Artist\Product Album\cover.jpg",
        "file_entry": {},
    })
    compact_row = _normal_problematic_product_row()
    compact_row.pop("file_entry")
    compact_row.update({
        "album_release_year": 2001,
        "album_cover_path": r"D:\Music\Product Artist\Product Album\cover.jpg",
        "file_entry_is_object": True,
        "file_album": None,
        "file_album_artist": None,
        "file_artist": None,
        "file_title": None,
        "file_year": None,
        "file_track_number": None,
        "file_text_mojibake_candidate": False,
    })

    def problem_reasons(row):
        album = _problematic_album_projection_payloads([row])[0]
        summary = _problematic_album_summary_payload(album)
        assert summary is not None
        return summary["problem_reasons"]

    expected_reasons = {
        "Missing album",
        "Missing album artist",
        "Missing track artist",
        "Missing track title",
        "Missing year",
        "Missing track number",
    }
    assert set(problem_reasons(full_row)) == expected_reasons
    assert set(problem_reasons(compact_row)) == expected_reasons


@pytest.mark.parametrize(
    ("value", "detect_encoding"),
    [
        ("пїЅ", True),
        ("??", True),
        ("Unknown Album", True),
        ("Ordinary title", False),
    ],
)
def test_problematic_fast_text_reason_preserves_shared_classifier_semantics(
    value,
    detect_encoding,
):
    from music_app.routes.api_rules_helpers import text_problem_reason
    from music_app.services.library_browse_postgres import _text_problem_reason_fast

    assert _text_problem_reason_fast(
        "Album",
        value,
        detect_encoding=detect_encoding,
    ) == text_problem_reason(
        "Album",
        value,
        detect_encoding=detect_encoding and not value.isascii(),
    )


def test_postgres_problematic_album_by_track_paths_applies_separate_release_split_to_requested_paths():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    requested_path = r"D:\Music\Problem Artist\Problem Album\1999\01.flac"
    other_path = r"D:\Music\Problem Artist\Problem Album\2001\01.flac"
    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "album_id": 701,
                    "album_key": "problem artist::problem album",
                    "album_title": "Problem Album",
                    "album_release_year": None,
                    "album_cover_path": None,
                    "album_metadata": {
                        "album_artist": "Problem Artist",
                        "artists": ["Problem Artist"],
                    },
                    "artist_name": "Problem Artist",
                    "track_id": 1701,
                    "track_key": "problem-1999-01",
                    "track_title": "Problem 1999",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 90,
                    "file_private_path": requested_path,
                    "file_entry": {
                        "path": requested_path,
                        "album": "Problem Album",
                        "album_artist": "Problem Artist",
                        "artist": "Problem Artist",
                        "title": "Problem 1999",
                        "track_number": 1,
                        "disc_number": 1,
                        "year": "1999",
                    },
                    "ignored_repair_keys": [],
                    "separate_release_keys": ["problem artist::problem album"],
                    "duplicate_file_count": 1,
                },
                {
                    "album_id": 701,
                    "album_key": "problem artist::problem album",
                    "album_title": "Problem Album",
                    "album_release_year": None,
                    "album_cover_path": None,
                    "album_metadata": {
                        "album_artist": "Problem Artist",
                        "artists": ["Problem Artist"],
                    },
                    "artist_name": "Problem Artist",
                    "track_id": 1702,
                    "track_key": "problem-2001-01",
                    "track_title": "Problem 2001",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 91,
                    "file_private_path": other_path,
                    "file_entry": {
                        "path": other_path,
                        "album": "Problem Album",
                        "album_artist": "Problem Artist",
                        "artist": "Problem Artist",
                        "title": "Problem 2001",
                        "track_number": 1,
                        "disc_number": 1,
                        "year": "2001",
                    },
                    "ignored_repair_keys": [],
                    "separate_release_keys": ["problem artist::problem album"],
                    "duplicate_file_count": 1,
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    detail_payload = repository.build_problematic_album_payload_by_track_paths({requested_path})

    assert detail_payload is not None
    assert detail_payload["key"] == "problem artist::problem album::year::1999"
    assert detail_payload["year"] == "1999"
    assert [track["path"] for track in detail_payload["tracks"]] == [requested_path]
    assert "Missing cover art" in detail_payload["problem_reasons"]
    assert "Inconsistent year" not in detail_payload["problem_reasons"]
    assert "scan_cache,file_entry" in str(executed[0])
    assert executed[1] == {"album_key": None}


def test_selected_artist_family_context_prefers_up_to_date_persisted_projection_without_syncing_on_read(monkeypatch):
    from music_app.services import artist_family_postgres as artist_family_postgres_module
    from music_app.services.library_browse_postgres import _selected_artist_family_context_from_state

    monkeypatch.setattr(
        artist_family_postgres_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": ["Broadcast"],
            "relations_last_built": 100.0,
            "loaded": True,
        },
    )
    context = _selected_artist_family_context_from_state(
        "Mono",
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
    )

    assert context["family_artists"] == ["Broadcast"]


def test_selected_artist_family_context_uses_canonical_projection_for_explicit_collaboration(monkeypatch):
    from music_app.services import artist_family_postgres as artist_family_postgres_module
    from music_app.services.library_browse_postgres import _selected_artist_family_context_from_state

    collaboration_artist = "Neal Morse & The Resonance"
    alias_to_canonical = {
        "Neal Morse": "Neal Morse",
        collaboration_artist: "Neal Morse",
        "The Neal Morse Band": "The Neal Morse Band",
    }
    canonical_to_aliases = {
        "Neal Morse": ["Neal Morse", collaboration_artist],
        "The Neal Morse Band": ["The Neal Morse Band"],
    }
    projection_artists = []

    def load_projection(_config, selected_artist, **_kwargs):
        projection_artists.append(selected_artist)
        return {
            "family_artists": [collaboration_artist, "The Neal Morse Band"],
            "relations_last_built": 100.0,
            "loaded": True,
            "alias_to_canonical": alias_to_canonical,
            "canonical_to_aliases": canonical_to_aliases,
        }

    monkeypatch.setattr(
        artist_family_postgres_module,
        "load_selected_artist_family_projection",
        load_projection,
    )

    context = _selected_artist_family_context_from_state(
        collaboration_artist,
        config={
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"
        },
        alias_to_canonical=alias_to_canonical,
        canonical_to_aliases=canonical_to_aliases,
    )

    assert projection_artists == ["Neal Morse"]
    assert context["family_artists"] == ["Neal Morse", "The Neal Morse Band"]


def test_selected_artist_family_context_keeps_loaded_projection_without_runtime_repair(monkeypatch):
    from music_app.services import artist_family_postgres as artist_family_postgres_module
    from music_app.services.library_browse_postgres import _selected_artist_family_context_from_state

    monkeypatch.setattr(
        artist_family_postgres_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": ["Morse Portnoy George"],
            "relations_last_built": 0.0,
            "loaded": True,
        },
    )
    context = _selected_artist_family_context_from_state(
        "Neal Morse",
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
    )

    assert context["family_artists"] == ["Morse Portnoy George"]
def test_selected_artist_family_context_keeps_loaded_projection_when_runtime_state_missing(monkeypatch):
    from music_app.services import artist_family_postgres as artist_family_postgres_module
    from music_app.services import library_browse_postgres as browse_module
    from music_app.services.library_browse_postgres import _selected_artist_family_context_from_state

    monkeypatch.setattr(
        artist_family_postgres_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": ["Morse Portnoy George"],
            "relations_last_built": 0.0,
            "loaded": True,
        },
    )
    context = _selected_artist_family_context_from_state(
        "Neal Morse",
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
    )

    assert context["family_artists"] == ["Morse Portnoy George"]
def test_selected_artist_family_context_does_not_refresh_loaded_empty_projection_when_runtime_entry_is_missing(monkeypatch):
    from music_app.services import artist_family_postgres as artist_family_postgres_module
    from music_app.services import library_browse_postgres as browse_module
    from music_app.services.library_browse_postgres import _selected_artist_family_context_from_state

    refresh_calls = []

    monkeypatch.setattr(
        artist_family_postgres_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": [],
            "relations_last_built": 50.0,
            "loaded": True,
        },
    )
    monkeypatch.setattr(
        browse_module,
        "_refresh_relation_views",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("loaded empty projections should not refresh relation views during read shaping")
        ),
    )
    monkeypatch.setattr(
        browse_module,
        "_ensure_relation_views",
        lambda library_state, _config: bool(library_state.get("relation_views")),
    )

    context = _selected_artist_family_context_from_state(
        "Neal Morse",
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
    )

    assert refresh_calls == []
    assert context["family_artists"] == []


def test_selected_artist_family_context_does_not_use_cached_relation_views_when_loaded_projection_is_empty(monkeypatch):
    from music_app.services import artist_family_postgres as artist_family_postgres_module
    from music_app.services import library_browse_postgres as browse_module
    from music_app.services.library_browse_postgres import _selected_artist_family_context_from_state

    monkeypatch.setattr(
        artist_family_postgres_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": [],
            "relations_last_built": 50.0,
            "loaded": True,
        },
    )
    context = _selected_artist_family_context_from_state(
        "Neal Morse",
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
    )

    assert context["family_artists"] == []
def test_selected_artist_family_context_does_not_rebuild_partial_relation_views_when_projection_missing(monkeypatch):
    from music_app.services import artist_family_postgres as artist_family_postgres_module
    from music_app.services import library_browse_postgres as browse_module
    from music_app.services.library_browse_postgres import _selected_artist_family_context_from_state

    monkeypatch.setattr(
        artist_family_postgres_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": [],
            "relations_last_built": 0.0,
            "loaded": False,
        },
    )

    library_state = {
        "albums": [object()],
        "relations_last_built": 10.0,
        "relation_views": {
            "artists": ["Mono", "Broadcast"],
            "alias_to_canonical": {
                "Mono": "Mono",
                "Broadcast": "Broadcast",
            },
            "canonical_to_aliases": {
                "Mono": ["Mono"],
                "Broadcast": ["Broadcast"],
            },
            "folder_related": {"Other Artist": {"Guest Artist"}},
        },
    }

    monkeypatch.setattr(
        browse_module,
        "_refresh_relation_views",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("missing projections should not be repaired from runtime relation views during read shaping")
        ),
    )

    context = _selected_artist_family_context_from_state(
        "Mono",
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
    )

    assert context["family_artists"] == []


def test_load_selected_artist_family_projection_builds_alias_maps_from_postgres_artist_rows():
    from music_app.services.artist_family_postgres import load_selected_artist_family_projection

    executed_sql: list[str] = []

    class FakeCursor:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return list(self._rows)

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            compact_sql = " ".join(str(sql).split())
            executed_sql.append(compact_sql)
            if params and "relationship_source" in params:
                return FakeCursor(
                    [
                        {
                            "selected_artist_key": "neal morse",
                            "selected_artist_name": "Neal Morse",
                            "family_artist_name": "The Neal Morse Band",
                            "family_artist_key": "the neal morse band",
                            "relations_last_built": 12.5,
                        },
                        {
                            "selected_artist_key": "neal morse",
                            "selected_artist_name": "Neal Morse",
                            "family_artist_name": "The Neal Morse Band",
                            "family_artist_key": "the neal morse band",
                            "relations_last_built": 11.0,
                        },
                    ]
                )
            if params and "artist_keys" in params:
                return FakeCursor(
                    [
                        {"artist_key": "neal morse", "alias_artist_name": "Neal Morse"},
                        {
                            "artist_key": "neal morse",
                            "alias_artist_name": "Neal Morse & The Resonance",
                        },
                        {
                            "artist_key": "the neal morse band",
                            "alias_artist_name": "The Neal Morse Band",
                        },
                    ]
                )
            raise AssertionError(f"Unexpected SQL params: {params!r}")

    projection = load_selected_artist_family_projection(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        "Neal Morse",
        connect=lambda _database_url: FakeConnection(),
    )

    assert projection["loaded"] is True
    assert projection["relations_last_built"] == 12.5
    assert projection["family_artists"] == ["The Neal Morse Band"]
    assert projection["alias_to_canonical"] == {
        "Neal Morse": "Neal Morse",
        "Neal Morse & The Resonance": "Neal Morse",
        "The Neal Morse Band": "The Neal Morse Band",
    }
    assert projection["canonical_to_aliases"] == {
        "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
        "The Neal Morse Band": ["The Neal Morse Band"],
    }
    assert all("scan_cache,relation_views" not in sql for sql in executed_sql)
    assert all("library.libraries.metadata" not in sql for sql in executed_sql)


def test_load_selected_artist_family_projection_reuses_caller_owned_snapshot():
    from music_app.services.artist_family_postgres import load_selected_artist_family_projection

    calls = []

    class FakeCursor:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return list(self._rows)

    class FakeConnection:
        def execute(self, _sql, params=None):
            calls.append(dict(params or {}))
            if "relationship_source" in (params or {}):
                return FakeCursor([
                    {
                        "selected_artist_key": "joseph",
                        "selected_artist_name": "Joseph",
                        "family_artist_name": "Joseph Family",
                        "family_artist_key": "joseph family",
                        "relations_last_built": 1.0,
                    }
                ])
            return FakeCursor([
                {"artist_key": "joseph", "alias_artist_name": "Joseph"},
                {"artist_key": "joseph family", "alias_artist_name": "Joseph Family"},
            ])

    connection = FakeConnection()
    projection = load_selected_artist_family_projection(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        "Joseph",
        connection=connection,
        connect=lambda _database_url: pytest.fail("caller-owned snapshot opened a second connection"),
    )

    assert projection["loaded"] is True
    assert projection["family_artists"] == ["Joseph Family"]
    assert len(calls) == 3


def test_load_selected_artist_family_projection_does_not_swallow_caller_connection_failure():
    from music_app.services.artist_family_postgres import load_selected_artist_family_projection

    class FailingCallerConnection:
        def execute(self, _sql, params=None):
            raise RuntimeError("caller transaction failed")

    with pytest.raises(RuntimeError, match="caller transaction failed"):
        load_selected_artist_family_projection(
            {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
            "Joseph",
            connection=FailingCallerConnection(),
            connect=lambda _database_url: pytest.fail("caller-owned read opened another connection"),
        )


def test_load_selected_artist_family_projection_sql_selects_target_artist_name():
    from music_app.services.artist_family_postgres import (
        _load_selected_artist_family_projection_sql,
    )

    sql = " ".join(_load_selected_artist_family_projection_sql().split())

    assert "select library.local_artists.id, library.local_artists.name, library.local_artists.artist_key from library.local_artists" in sql
    assert "target_artist.name as selected_artist_name" in sql
    assert "and library.local_artist_family_links.source_family = %(relationship_source)s" not in sql
    assert "local_artist_family_links.library_id = (select library_id from bootstrap_context)" in sql
    assert "case when library.local_artist_family_links.source_family = %(relationship_source)s then 0 else 1 end" in sql


def _normal_problematic_product_row(*, album_key="product-album", album_title="Product Album"):
    track_path = rf"D:\Music\Product Artist\{album_title}\01.flac"
    return {
        "album_id": 101,
        "album_key": album_key,
        "album_title": album_title,
        "album_release_year": None,
        "album_cover_path": None,
        "album_metadata": {
            "album_artist": "Product Artist",
            "artists": ["Product Artist"],
        },
        "artist_name": "Product Artist",
        "track_id": 501,
        "track_key": "product-track",
        "track_title": "Product Track",
        "disc_number": 1,
        "track_number": 1,
        "duration_seconds": 180,
        "file_private_path": track_path,
        "file_entry": {
            "path": track_path,
            "album": album_title,
            "album_artist": "Product Artist",
            "artist": "Product Artist",
            "title": "Product Track",
            "year": None,
            "track_number": 1,
        },
        "ignored_repair_keys": [],
        "separate_release_keys": [],
        "duplicate_file_count": 1,
    }


def _healthy_problematic_order_rows(
    track_numbers,
    *,
    disc_numbers=None,
    filename_numbers=None,
    file_track_numbers=None,
):
    track_numbers = list(track_numbers)
    disc_numbers = list(
        [1] * len(track_numbers) if disc_numbers is None else disc_numbers
    )
    filename_numbers = list(
        track_numbers if filename_numbers is None else filename_numbers
    )
    file_track_numbers = list(
        filename_numbers if file_track_numbers is None else file_track_numbers
    )
    rows = []
    for index, (track_number, disc_number, filename_number, file_track_number) in enumerate(
        zip(
            track_numbers,
            disc_numbers,
            filename_numbers,
            file_track_numbers,
            strict=True,
        ),
        start=1,
    ):
        row = _normal_problematic_product_row()
        row.update(
            {
                "album_release_year": 2001,
                "album_cover_path": r"D:\Music\Product Artist\Product Album\cover.jpg",
                "album_metadata": {
                    "album_artist": "Product Artist",
                    "artists": ["Product Artist"],
                    "local_cover_width": 1000,
                    "local_cover_height": 1000,
                },
                "track_id": 500 + index,
                "track_key": f"product-track-{index}",
                "track_title": f"Product Track {index}",
                "disc_number": disc_number,
                "track_number": track_number,
                "file_private_path": (
                    rf"D:\Music\Product Artist\Product Album\{int(filename_number):02d} - "
                    f"Product Track {index}.flac"
                ),
            }
        )
        row["file_entry"] = {
            **row["file_entry"],
            "path": row["file_private_path"],
            "title": row["track_title"],
            "year": "2001",
            "disc_number": disc_number,
            "track_number": file_track_number,
        }
        rows.append(row)
    return rows


@pytest.mark.parametrize(
    ("track_numbers", "expected_reasons"),
    [
        ([3, 4, 5], ["Incomplete track order: Disc 1 missing 1, 2"]),
        ([1, 3, 4], ["Incomplete track order: Disc 1 missing 2"]),
        ([1, 2, 3], []),
    ],
)
def test_problematic_album_reports_incomplete_canonical_track_order(
    track_numbers,
    expected_reasons,
):
    from music_app.services.library_browse_postgres import (
        _problematic_album_projection_payloads,
        _problematic_album_reasons,
    )

    album = _problematic_album_projection_payloads(
        _healthy_problematic_order_rows(track_numbers)
    )[0]

    assert _problematic_album_reasons(album) == expected_reasons


def _semantic_problematic_release_rows(
    track_numbers,
    *,
    album_id,
    album_key,
    year=1988,
    separate_release_keys=None,
):
    rows = _healthy_problematic_order_rows(track_numbers)
    for index, row in enumerate(rows, start=1):
        track_number = track_numbers[index - 1]
        row["album_id"] = album_id
        row["album_key"] = album_key
        row["album_title"] = "Studio Records"
        row["album_release_year"] = year
        row["album_cover_path"] = r"D:\Music\Product Artist\Studio Records\cover.jpg"
        row["album_metadata"] = {
            "album_artist": "Product Artist",
            "artists": ["Product Artist"],
            "local_cover_width": 1000,
            "local_cover_height": 1000,
        }
        row["artist_id"] = 77
        row["artist_name"] = "Product Artist"
        row["track_id"] = album_id * 100 + index
        row["track_key"] = f"{album_key}-track-{index}"
        row["track_title"] = f"Studio Track {track_number}"
        row["file_private_path"] = (
            rf"D:\Music\Product Artist\Studio Records\{track_number:02d} - "
            f"Studio Track {track_number}.flac"
        )
        row["file_entry"] = {
            **row["file_entry"],
            "path": row["file_private_path"],
            "album": "Studio Records",
            "album_artist": "Product Artist",
            "artist": "Product Artist",
            "title": row["track_title"],
            "year": str(year),
            "track_number": track_number,
        }
        row["separate_release_keys"] = list(separate_release_keys or [])
    return rows


def test_problematic_projection_keeps_explicit_separate_release_years_distinct():
    from music_app.services.library_browse_postgres import (
        _problematic_album_projection_payloads,
    )

    separate_release_key = "product artist::studio records"
    rows = [
        *_semantic_problematic_release_rows(
            [1, 2],
            album_id=501,
            album_key="product-artist::studio-records::1988",
            year=1988,
            separate_release_keys=[separate_release_key],
        ),
        *_semantic_problematic_release_rows(
            [1, 2],
            album_id=502,
            album_key="product-artist::studio-records::1992",
            year=1992,
            separate_release_keys=[separate_release_key],
        ),
    ]

    albums = _problematic_album_projection_payloads(rows)

    assert [(album["year"], len(album["tracks"])) for album in albums] == [
        ("1988", 2),
        ("1992", 2),
    ]


def test_problematic_detail_exposes_missing_numbers_and_all_tracks_for_incomplete_order():
    from music_app.services.library_browse_postgres import (
        _problematic_album_detail_payload,
        _problematic_album_projection_payloads,
    )

    album = _problematic_album_projection_payloads(
        _semantic_problematic_release_rows(
            [3, 4, 5],
            album_id=601,
            album_key="product-artist::studio-records",
        )
    )[0]

    detail = _problematic_album_detail_payload(album)

    assert detail is not None
    assert detail["track_order_issues"] == [
        {
            "disc_number": 1,
            "missing_track_numbers": [1, 2],
        }
    ]
    assert detail["problematic_track_paths"] == [
        track["path"] for track in detail["tracks"]
    ]
    assert [row["path"] for row in detail["track_problem_rows"]] == [
        track["path"] for track in detail["tracks"]
    ]
    assert all(
        "Incomplete track order: Disc 1 missing 1, 2" in row["reasons"]
        for row in detail["track_problem_rows"]
    )


def test_problematic_detail_track_preserves_persisted_exception_override_for_tag_editing():
    from music_app.services.library_browse_postgres import (
        _problematic_album_detail_payload,
        _problematic_album_projection_payloads,
        _problematic_files_sql,
    )

    rarity_row = _normal_problematic_product_row(
        album_key="exception-artist::exception-album",
        album_title="Exception Album",
    )
    rarity_row.update({
        "exception_type": "Non-album rarity",
        "exception_override_present": True,
        "track_number": 1,
    })
    rarity_row["file_entry"] = {
        **rarity_row["file_entry"],
        "exception_type": None,
        "track_number": 1,
    }
    sibling_row = {
        **rarity_row,
        "track_id": 2,
        "track_key": "exception-album-track-3",
        "track_title": "Problematic Sibling",
        "track_number": 3,
        "file_private_path": r"D:\Music\Product Artist\Exception Album\03.flac",
        "exception_type": None,
        "exception_override_present": False,
        "file_entry": {
            **rarity_row["file_entry"],
            "path": r"D:\Music\Product Artist\Exception Album\03.flac",
            "title": "Problematic Sibling",
            "track_number": 3,
        },
    }

    albums = _problematic_album_projection_payloads([rarity_row, sibling_row])
    detail = _problematic_album_detail_payload(albums[0])

    assert detail is not None
    tracks_by_path = {track["path"]: track for track in detail["tracks"]}
    assert tracks_by_path[rarity_row["file_private_path"]]["exception_type"] == "Non-album rarity"
    for candidate_summary in (False, True):
        sql = " ".join(
            _problematic_files_sql(candidate_summary=candidate_summary).split()
        )
        assert "library.exception_overrides" in sql
        assert "override_payload ->> 'exception_type' as exception_type" in sql
        assert "as exception_override_present" in sql
    assert [row["path"] for row in detail["track_problem_rows"]] == [
        track["path"] for track in detail["tracks"]
    ]
    assert all(
        "Incomplete track order: Disc 1 missing 1, 2" in row["reasons"]
        for row in detail["track_problem_rows"]
    )


def test_problematic_album_checks_track_order_per_disc():
    from music_app.services.library_browse_postgres import (
        _problematic_album_projection_payloads,
        _problematic_album_reasons,
    )

    album = _problematic_album_projection_payloads(
        _healthy_problematic_order_rows(
            [1, 2, 1, 2],
            disc_numbers=[1, 1, 2, 2],
        )
    )[0]

    assert _problematic_album_reasons(album) == []


@pytest.mark.parametrize(
    ("filename_numbers", "expected_incomplete_order"),
    [
        ([1, 2, 3], False),
        ([1, 3, 4], True),
    ],
)
def test_problematic_album_uses_leading_filename_number_without_positive_canonical_number(
    filename_numbers,
    expected_incomplete_order,
):
    from music_app.services.library_browse_postgres import (
        _problematic_album_projection_payloads,
        _problematic_album_reasons,
    )

    album = _problematic_album_projection_payloads(
        _healthy_problematic_order_rows(
            [None] * len(filename_numbers),
            filename_numbers=filename_numbers,
            file_track_numbers=[None] * len(filename_numbers),
        )
    )[0]

    reasons = _problematic_album_reasons(album)
    assert "Missing track number" in reasons
    incomplete_order_reasons = [
        reason
        for reason in reasons
        if reason.startswith("Incomplete track order:")
    ]
    assert bool(incomplete_order_reasons) is expected_incomplete_order
    if expected_incomplete_order:
        assert incomplete_order_reasons == [
            "Incomplete track order: Disc 1 missing 2"
        ]


def test_problematic_album_prefers_positive_canonical_number_over_filename_number():
    from music_app.services.library_browse_postgres import (
        _problematic_album_projection_payloads,
        _problematic_album_reasons,
    )

    album = _problematic_album_projection_payloads(
        _healthy_problematic_order_rows(
            [1, 2, 3],
            filename_numbers=[1, 3, 5],
        )
    )[0]

    assert _problematic_album_reasons(album) == []


def test_problematic_album_reads_dot_delimited_filename_number_when_canonical_is_blank():
    from music_app.services.library_browse_postgres import (
        _problematic_album_projection_payloads,
        _problematic_album_reasons,
    )

    rows = _healthy_problematic_order_rows(
        [None, None],
        filename_numbers=[1, 3],
        file_track_numbers=[None, None],
    )
    paths = [
        r"D:\Music\Product Artist\Product Album\01. Открытие.mp3",
        r"D:\Music\Product Artist\Product Album\03. Конвейер.mp3",
    ]
    for row, path in zip(rows, paths, strict=True):
        row["file_private_path"] = path
        row["file_entry"]["path"] = path

    album = _problematic_album_projection_payloads(rows)[0]

    assert set(_problematic_album_reasons(album)) == {
        "Incomplete track order: Disc 1 missing 2",
        "Missing track number",
    }


def test_album_scope_ignore_suppresses_same_label_file_problem():
    from music_app.services.library_browse_postgres import (
        _problem_identity_row_key,
        _problematic_album_detail_payload,
        _problematic_album_projection_payloads,
        _problematic_album_summary_payload,
    )

    row = _healthy_problematic_order_rows([1])[0]
    row["album_release_year"] = None
    row["file_entry"]["year"] = None
    album = _problematic_album_projection_payloads([row])[0]
    album["_ignored_repair_keys"] = {
        _problem_identity_row_key(
            album["album_ref"],
            "Missing year",
            scope="album",
        )
    }

    summary = _problematic_album_summary_payload(album)
    detail = _problematic_album_detail_payload(album)

    assert summary is None
    assert detail is None


def test_final_file_scope_ignore_removes_reason_from_summary_without_hiding_album_scope():
    from music_app.services.library_browse_postgres import (
        _problem_identity_row_key,
        _problematic_album_detail_payload,
        _problematic_album_projection_payloads,
        _problematic_album_summary_payload,
    )

    row = _normal_problematic_product_row()
    row["album_release_year"] = 2001
    row["track_number"] = None
    row["file_entry"]["year"] = "2001"
    row["file_entry"]["track_number"] = None
    album = _problematic_album_projection_payloads([row])[0]
    album["_ignored_repair_keys"] = {
        _problem_identity_row_key(
            row["file_private_path"],
            "Missing track number",
            scope="file",
        )
    }

    summary = _problematic_album_summary_payload(album)
    detail = _problematic_album_detail_payload(album)

    assert summary is not None
    assert summary["problem_reasons"] == ["Missing cover art"]
    assert summary["issue_count"] == 1
    assert "Missing track number" not in summary["problem_reasons"]
    assert detail is not None
    assert detail["problem_reasons"] == ["Missing cover art"]
    assert detail["issue_count"] == 1
    assert [row["reason"] for row in detail["album_problem_rows"]] == [
        "Missing cover art",
    ]
    assert detail["track_problem_rows"] == []


def test_problematic_summary_search_text_includes_track_titles_without_heavy_detail_arrays():
    from music_app.services.library_browse_postgres import (
        _problematic_album_projection_payloads,
        _problematic_album_summary_payload,
    )

    row = _normal_problematic_product_row(
        album_key="neal-morse::neal-morse-plays-pink-floyd",
        album_title="Neal Morse Plays Pink Floyd",
    )
    row.update({
        "track_title": "Echoes - Live at Morsefest",
        "track_number": None,
    })
    row["file_entry"] = {
        **row["file_entry"],
        "title": "Echoes - Live at Morsefest",
        "track_number": None,
    }

    album = _problematic_album_projection_payloads([row])[0]
    summary = _problematic_album_summary_payload(album)

    assert summary is not None
    assert "Echoes - Live at Morsefest" in summary["search_text"]
    assert summary["track_count"] == 1
    assert summary["track_paths"] == [
        r"D:\Music\Product Artist\Neal Morse Plays Pink Floyd\01.flac",
    ]
    assert "tracks" not in summary
    assert "track_problem_rows" not in summary
    assert "repair_preview_rows" not in summary
    assert "problematic_track_paths" not in summary
    assert album["tracks"][0]["title"] == "Echoes - Live at Morsefest"


def test_problematic_summary_skips_repairs_for_rows_rejected_by_persisted_mojibake_prefilter(
    monkeypatch,
):
    from music_app.services import library_browse_postgres as module

    row = _normal_problematic_product_row()
    row.update(
        {
            "file_entry": None,
            "file_entry_is_object": True,
            "file_album": "Product Album",
            "file_album_artist": "Product Artist",
            "file_artist": "宇多田ヒカル",
            "file_title": "光",
            "file_year": None,
            "file_track_number": 1,
            "file_text_mojibake_candidate": False,
        }
    )

    def unexpected_repair_probe(_entry):
        raise AssertionError(
            "Rows rejected by the persisted mojibake prefilter must not run text repair analysis."
        )

    monkeypatch.setattr(module, "build_text_repairs_for_entry", unexpected_repair_probe)

    album = module._problematic_album_projection_payloads([row])[0]
    summary = module._problematic_album_summary_payload(album)

    assert summary is not None
    assert "Encoding problem" not in summary["problem_reasons"]


class _ProblematicSnapshotConnectionStub:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        assert str(sql) in {
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
            "SET LOCAL work_mem = '16MB'",
            "SET LOCAL jit = off",
        }
        assert not params
        return None


def test_compact_summary_preserves_morse_portnoy_george_separate_release_years_and_first_detail():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    persisted_key = "morse portnoy george::cover to cover"
    release_key = "morse portnoy george::cover to cover"
    full_rows = []
    compact_rows = []
    for index, year in enumerate((2006, 2012), start=1):
        row = _normal_problematic_product_row(
            album_key=persisted_key,
            album_title="Cover to Cover",
        )
        row.update({
            "album_id": 900,
            "artist_name": "Morse Portnoy George",
            "album_metadata": {
                "album_artist": "Morse Portnoy George",
                "artists": ["Morse Portnoy George"],
            },
            "track_id": 9000 + index,
            "track_key": f"cover-{year}",
            "file_private_path": rf"D:\Music\Morse Portnoy George\Cover to Cover\{year}\01.flac",
            "separate_release_keys": [release_key],
        })
        row["file_entry"] = {
            **row["file_entry"],
            "path": row["file_private_path"],
            "album": "Cover to Cover",
            "album_artist": "Morse Portnoy George",
            "artist": "Morse Portnoy George",
            "year": str(year),
        }
        full_rows.append(row)
        compact = {
            key: value
            for key, value in row.items()
            if key not in {"album_metadata", "file_entry"}
        }
        compact.update({
            "album_artist": "Morse Portnoy George",
            "album_artists": '["Morse Portnoy George"]',
            "album_root_provenance": (
                '{"primary_category":"main_library","categories":["main_library"]}'
            ),
            "file_album": "Cover to Cover",
            "file_album_artist": "Morse Portnoy George",
            "file_artist": "Morse Portnoy George",
            "file_title": row["track_title"],
            "file_year": str(year),
            "file_track_number": "1",
        })
        compact_rows.append(compact)

    requested = []
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _ProblematicSnapshotConnectionStub(),
    )

    def load_rows(album_key=None, **_kwargs):
        requested.append(album_key)
        return compact_rows if album_key is None else full_rows

    repository._load_problematic_file_rows = load_rows
    payload = repository._build_problematic_files_payload_uncached()

    assert [item["key"] for item in payload["items"]] == [
        f"{release_key}::year::2006",
        f"{release_key}::year::2012",
    ]
    assert payload["initial_detail"]["key"] == f"{release_key}::year::2006"
    assert payload["initial_detail"]["root_provenance"] == {
        "primary_category": "main_library",
        "categories": ["main_library"],
    }
    assert requested == [None]


def test_compact_problematic_summary_rows_preserve_full_projection_classifier_parity():
    from music_app.services.library_browse_postgres import (
        _problematic_album_projection_payloads,
        _problematic_album_summary_payload,
    )

    def healthy_row(key, title, *, artist="Product Artist"):
        row = _normal_problematic_product_row(album_key=key, album_title=title)
        row["album_id"] = abs(hash(key))
        row["album_release_year"] = 2001
        row["album_cover_path"] = rf"D:\Music\{artist}\{title}\cover.jpg"
        row["artist_name"] = artist
        row["album_metadata"] = {
            "album_artist": artist,
            "artists": [artist],
            "local_cover_width": 1000,
            "local_cover_height": 1000,
        }
        row["file_entry"].update({
            "album": title,
            "album_artist": artist,
            "artist": artist,
            "year": "2001",
        })
        return row

    def compact(row):
        metadata = row["album_metadata"]
        file_entry = row["file_entry"]
        result = {key: value for key, value in row.items() if key not in {"album_metadata", "file_entry"}}
        result.update({
            "album_artist": metadata.get("album_artist"),
            "album_artists": metadata.get("artists"),
            "album_is_compilation": metadata.get("is_compilation"),
            "album_local_cover_width": metadata.get("local_cover_width"),
            "album_local_cover_height": metadata.get("local_cover_height"),
            "album_release_date": metadata.get("release_date"),
            "album_edition": metadata.get("edition"),
            "album_rating": metadata.get("album_rating"),
            "file_album": file_entry.get("album"),
            "file_album_artist": file_entry.get("album_artist"),
            "file_artist": file_entry.get("artist"),
            "file_title": file_entry.get("title"),
            "file_year": file_entry.get("year"),
            "file_track_number": file_entry.get("track_number"),
            "file_entry_is_object": isinstance(file_entry, dict),
        })
        return result

    swap_title = "Broken Encoding".encode("utf-16le").decode("utf-16be")
    full_rows = [
        healthy_row("marker", "Broken??Album"),
        healthy_row("dense", "\u00a8\u00a8\u00a8abc"),
        healthy_row("swap", swap_title),
        healthy_row("accented", "Fran\u00e7ois d\u00e9j\u00e0 vu", artist="Beyonc\u00e9"),
        healthy_row("cyrillic", "\u041c\u0443\u0437\u044b\u043a\u0430\u043b\u044c\u043d\u044b\u0439 \u0430\u043b\u044c\u0431\u043e\u043c", artist="\u0410\u0440\u0442\u0438\u0441\u0442"),
        healthy_row("greek", "\u039c\u03bf\u03c5\u03c3\u03b9\u03ba\u03cc \u03ac\u03bb\u03bc\u03c0\u03bf\u03c5\u03bc"),
        healthy_row("kana", "\u30ab\u30bf\u30ab\u30ca"),
        healthy_row("emoji", "Album \U0001f3b8"),
        healthy_row("cjk", "\u76f8\u5bfe\u6027\u7406\u8ad6"),
        healthy_row("missing-track", "Missing Track"),
        healthy_row("duplicate", "Duplicate"),
        healthy_row("ignored", "Ignored"),
        healthy_row("split", "Separate Release"),
        healthy_row("no-scan-entry", "No Scan Entry"),
    ]
    by_key = {row["album_key"]: row for row in full_rows}
    by_key["missing-track"]["track_number"] = None
    by_key["missing-track"]["file_entry"]["track_number"] = None
    by_key["duplicate"]["duplicate_file_count"] = 2
    by_key["ignored"]["track_number"] = None
    by_key["ignored"]["file_entry"]["track_number"] = None
    ignored_path = by_key["ignored"]["file_private_path"]
    by_key["ignored"]["ignored_repair_keys"] = [f"{ignored_path}::track_number"]
    split = by_key["split"]
    split["separate_release_keys"] = ["product artist::separate release"]
    split["file_entry"]["year"] = "2002"
    by_key["no-scan-entry"]["file_entry"] = {}

    def summaries(rows):
        return sorted(
            (
                summary["key"],
                summary["problem_reasons"],
                summary["has_encoding_repairs"],
                summary["track_paths"],
            )
            for album in _problematic_album_projection_payloads(rows)
            if (summary := _problematic_album_summary_payload(album)) is not None
        )

    assert summaries([compact(row) for row in full_rows]) == summaries(full_rows)


def test_problematic_files_summary_embeds_only_the_first_sorted_album_detail():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    zulu_row = _normal_problematic_product_row(
        album_key="z-album",
        album_title="Zulu Album",
    )
    alpha_row = _normal_problematic_product_row(
        album_key="a-album",
        album_title="Alpha Album",
    )
    alpha_row["album_id"] = 102
    alpha_row["track_id"] = 502
    alpha_row["track_key"] = "alpha-track"
    alpha_row["album_metadata"]["cover_revision"] = "alpha-cover-revision"
    alpha_row["album_metadata"]["root_provenance"] = {
        "primary_category": "new_arrivals",
    }
    loaded_rows = [zulu_row, alpha_row]
    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _ProblematicSnapshotConnectionStub(),
    )
    requested_album_keys = []

    def load_rows(album_key=None, **_kwargs):
        requested_album_keys.append(album_key)
        return loaded_rows

    repository._load_problematic_file_rows = load_rows

    payload = repository._build_problematic_files_payload_uncached()

    assert [item["key"] for item in payload["items"]] == ["a-album", "z-album"]
    assert requested_album_keys == [None]
    first_summary, remaining_summary = payload["items"]
    initial_detail = payload["initial_detail"]
    assert first_summary["key"] == initial_detail["key"] == "a-album"
    assert first_summary["detail_loaded"] is False
    assert "track_problem_rows" not in first_summary
    assert "repair_preview_rows" not in first_summary
    assert "problematic_track_paths" not in first_summary
    assert initial_detail["detail_loaded"] is True
    assert initial_detail["cover_revision"] == "alpha-cover-revision"
    assert initial_detail["root_provenance"] == {
        "primary_category": "new_arrivals",
    }
    assert initial_detail["track_problem_rows"][0]["filename"] == "01.flac"
    assert initial_detail["problematic_track_paths"] == [
        r"D:\Music\Product Artist\Alpha Album\01.flac"
    ]
    assert remaining_summary["detail_loaded"] is False
    assert "track_problem_rows" not in remaining_summary
    assert "repair_preview_rows" not in remaining_summary
    assert "problematic_track_paths" not in remaining_summary


def test_problematic_files_summary_and_initial_detail_share_one_repeatable_read_snapshot():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    database_rows = [_normal_problematic_product_row()]
    connections = []

    class FakeCursor:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return list(self._rows)

    class SnapshotConnection:
        def __init__(self):
            self.snapshot_rows = list(database_rows)
            self.commands = []

        def __enter__(self):
            connections.append(self)
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            self.commands.append((str(sql), dict(params or {})))
            if str(sql).startswith("SET"):
                return FakeCursor([])
            if "mojibake_candidate_pattern" in (params or {}):
                database_rows.clear()
            return FakeCursor(self.snapshot_rows)

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/snapshot"},
        connect=lambda _database_url: SnapshotConnection(),
    )

    payload = repository.build_problematic_files_payload()

    assert len(connections) == 1
    assert connections[0].commands[0][0] == "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
    assert connections[0].commands[1][0] == "SET LOCAL work_mem = '16MB'"
    assert connections[0].commands[2][0] == "SET LOCAL jit = off"
    assert payload["items"][0]["key"] == payload["initial_detail"]["key"] == "product-album"
    assert database_rows == []


def test_problematic_files_caches_summary_and_initial_detail_from_the_same_selected_rows():
    from music_app.services import library_browse_postgres as module

    module.invalidate_postgres_utility_projection_cache()
    data_query_count = 0

    class FakeCursor:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return list(self._rows)

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            nonlocal data_query_count
            if str(sql).startswith("SET"):
                return FakeCursor([])
            data_query_count += 1
            return FakeCursor(
                [_normal_problematic_product_row()]
                if (
                    "mojibake_candidate_pattern" in (params or {})
                    or "album_ids" in (params or {})
                )
                else []
            )

    database_url = "postgresql://album_haven_app@localhost/broken-snapshot"
    repository = module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": database_url},
        connect=lambda _database_url: FakeConnection(),
    )

    first_payload = repository.build_problematic_files_payload()
    with module._UTILITY_PROJECTION_CACHE_LOCK:
        assert (database_url, "problematic-files") in module._UTILITY_PROJECTION_CACHE
    second_payload = repository.build_problematic_files_payload()
    assert first_payload["items"][0]["key"] == first_payload["initial_detail"]["key"]
    assert second_payload["items"] == first_payload["items"]
    assert second_payload["initial_detail"] == first_payload["initial_detail"]
    assert data_query_count == 1


def test_problematic_album_projection_keeps_null_track_numbers_last():
    from music_app.services.library_browse_postgres import _problematic_album_projection_payloads

    numbered_track = _normal_problematic_product_row()
    numbered_track["track_key"] = "numbered-track"
    numbered_track["track_title"] = "Numbered Track"
    numbered_track["track_number"] = 2
    numbered_track["file_private_path"] = r"D:\Music\Product Artist\Product Album\02.flac"
    numbered_track["file_entry"] = {
        **numbered_track["file_entry"],
        "path": numbered_track["file_private_path"],
        "title": numbered_track["track_title"],
        "track_number": 2,
    }
    null_track_number = _normal_problematic_product_row()
    null_track_number["track_key"] = "null-track-number"
    null_track_number["track_title"] = "Alphabetically First But Unnumbered"
    null_track_number["track_number"] = None
    null_track_number["file_private_path"] = r"D:\Music\Product Artist\Product Album\unknown-track.flac"
    null_track_number["file_entry"] = {
        **null_track_number["file_entry"],
        "path": null_track_number["file_private_path"],
        "title": null_track_number["track_title"],
        "track_number": None,
    }
    null_disc_number = _normal_problematic_product_row()
    null_disc_number["track_key"] = "null-disc-number"
    null_disc_number["track_title"] = "Unnumbered Disc"
    null_disc_number["disc_number"] = None
    null_disc_number["track_number"] = 1
    null_disc_number["file_private_path"] = r"D:\Music\Product Artist\Product Album\unknown-disc.flac"
    null_disc_number["file_entry"] = {
        **null_disc_number["file_entry"],
        "path": null_disc_number["file_private_path"],
        "title": null_disc_number["track_title"],
        "disc_number": None,
        "track_number": 1,
    }

    albums = _problematic_album_projection_payloads([
        null_disc_number,
        null_track_number,
        numbered_track,
    ])

    assert [track["key"] for track in albums[0]["tracks"]] == [
        "numbered-track",
        "null-track-number",
        "null-disc-number",
    ]


def test_postgres_library_browse_ignores_e2e_seed_env_and_queries_product_tables(monkeypatch):
    from music_app.services import library_browse_postgres as module
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    with module._UTILITY_PROJECTION_CACHE_LOCK:
        module._UTILITY_PROJECTION_CACHE.clear()
        module._UTILITY_PROJECTION_PREWARM_INFLIGHT.clear()
    monkeypatch.setenv("ALBUM_HAVEN_E2E_PROBLEMATIC_SEED_KEY", "problematic-files-small")
    executed: list[tuple[str, dict[str, object]]] = []

    class FakeCursor:
        def fetchall(self):
            return [_normal_problematic_product_row()]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append((str(sql), dict(params or {})))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_problematic_files_payload()
    detail_payload = repository.build_problematic_file_detail_payload("product-album")

    assert payload["count"] == 1
    assert payload["items"][0]["key"] == "product-album"
    assert payload["persistence_backend"] == "postgres"
    assert detail_payload is not None
    assert detail_payload["key"] == "product-album"
    assert detail_payload["detail_loaded"] is True
    assert len(executed) == 5
    assert all(
        "library.local_track_files" in sql
        for sql, _params in executed
        if not sql.startswith("SET")
    )
    assert all("e2e_problematic_file_fixture_seeds" not in sql for sql, _params in executed)
    assert executed[0][0] == "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
    assert executed[1][0] == "SET LOCAL work_mem = '16MB'"
    assert executed[2][0] == "SET LOCAL jit = off"
    assert executed[3][1]["mojibake_candidate_pattern"]
    assert executed[4][1]["album_key"] == "product-album"


def test_postgres_library_browse_builds_utility_rules_projection_from_rows():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    executed: list[object] = []

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "album_id": 101,
                    "album_key": "ignored-album",
                    "album_title": "Ignored Album",
                    "album_release_year": 1999,
                    "album_cover_path": "covers/ignored.jpg",
                    "album_metadata": {
                        "album_artist": "Canonical Artist",
                        "artists": ["Canonical Artist"],
                        "edition": "Deluxe",
                    },
                    "ignored_version_key": "ignored-album",
                    "ignored_repair_key": r"D:\Music\Artist\Album\01.flac::album_artist",
                    "file_private_path": r"D:\Music\Artist\Album\01.flac",
                    "file_entry": {
                        "path": r"D:\Music\Artist\Album\01.flac",
                        "album": "Problem Album",
                        "album_artist": "Problem Alias",
                        "artist": "Problem Alias",
                        "title": "Problem Track",
                        "year": "2001",
                    },
                    "alias_to_canonical": {"Problem Alias": "Canonical Artist"},
                },
                {
                    "album_id": 101,
                    "album_key": "ignored-album",
                    "album_title": "Ignored Album",
                    "album_release_year": 1999,
                    "album_cover_path": "covers/ignored.jpg",
                    "album_metadata": {"album_artist": "Canonical Artist"},
                    "ignored_version_key": None,
                    "ignored_repair_key": (
                        "ignored-album::problem-album::missing-cover-art"
                    ),
                    "file_private_path": r"D:\Music\Artist\Album\01.flac",
                    "file_entry": {
                        "path": r"D:\Music\Artist\Album\01.flac",
                        "album": "Problem Album",
                        "album_artist": "Problem Alias",
                        "artist": "Problem Alias",
                        "title": "Problem Track",
                        "year": "2001",
                    },
                    "alias_to_canonical": {"Problem Alias": "Canonical Artist"},
                },
                {
                    "album_id": 101,
                    "album_key": "ignored-album",
                    "album_title": "Ignored Album",
                    "album_release_year": 1999,
                    "album_cover_path": "covers/ignored.jpg",
                    "album_metadata": {"album_artist": "Canonical Artist"},
                    "ignored_version_key": None,
                    "ignored_repair_key": (
                        r"D:\Music\Artist\Album\02.flac::problem-file::missing-year"
                    ),
                    "file_private_path": r"D:\Music\Artist\Album\02.flac",
                    "file_entry": {
                        "path": r"D:\Music\Artist\Album\02.flac",
                        "album": "Problem Album",
                        "album_artist": "Problem Alias",
                        "artist": "Problem Alias",
                        "title": "Second Problem Track",
                        "year": "",
                    },
                    "alias_to_canonical": {"Problem Alias": "Canonical Artist"},
                },
                {
                    "album_id": 202,
                    "album_key": "base::year::2026",
                    "album_title": "Delimiter Album",
                    "album_release_year": 2026,
                    "album_cover_path": "covers/delimiter.jpg",
                    "album_metadata": {"album_artist": "Delimiter Artist"},
                    "ignored_version_key": None,
                    "ignored_repair_key": (
                        "base::year::2026::problem-album::missing-cover-art"
                    ),
                    "file_private_path": None,
                    "file_entry": {
                        "album": "Delimiter Album",
                        "album_artist": "Delimiter Artist",
                    },
                    "alias_to_canonical": {},
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append(sql)
            executed.append(dict(params or {}))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_utility_rules_payload()

    assert payload["ok"] is True
    assert payload["ignored_version_keys"] == ["ignored-album"]
    assert payload["persistence_backend"] == "postgres"
    assert payload["persistence_seam"] == "library_browse"
    assert payload["view_data_source"] == "postgres_library_browse"
    version_rule, problem_rule = payload["rules"]
    assert version_rule["key"] == "version-exceptions"
    assert version_rule["count"] == 1
    assert version_rule["albums"][0]["key"] == "ignored-album"
    assert version_rule["albums"][0]["name"] == "Ignored Album"
    assert version_rule["albums"][0]["album_artist"] == "Canonical Artist"
    assert version_rule["albums"][0]["edition"] == "Deluxe"
    assert problem_rule["key"] == "problem-ignores"
    assert problem_rule["title"] == "Problem exclusions"
    assert problem_rule["description"] == "Album or file problems excluded from Problematic Files."
    assert problem_rule["count"] == 4
    assert len(problem_rule["album_items"]) == 2
    assert len(problem_rule["file_items"]) == 2
    assert problem_rule["count"] == len(problem_rule["album_items"]) + len(problem_rule["file_items"])

    album_items = {item["row_key"]: item for item in problem_rule["album_items"]}
    album_item = album_items["ignored-album::problem-album::missing-cover-art"]
    assert album_item["row_key"] == "ignored-album::problem-album::missing-cover-art"
    assert album_item["album"] == "Problem Album"
    assert album_item["problem_reason"] == "Missing cover art"
    delimiter_key = "base::year::2026::problem-album::missing-cover-art"
    delimiter_item = album_items[delimiter_key]
    assert delimiter_item["scope"] == "album"
    assert delimiter_item["album"] == "Delimiter Album"
    assert delimiter_item["problem_reason"] == "Missing cover art"
    assert delimiter_item["row_key"] == delimiter_key
    assert delimiter_item["path"] == ""

    file_items = {item["row_key"]: item for item in problem_rule["file_items"]}
    legacy_key = r"D:\Music\Artist\Album\01.flac::album_artist"
    file_key = r"D:\Music\Artist\Album\02.flac::problem-file::missing-year"
    assert file_items[legacy_key]["problem_reason"] == "Artist name variant differs from canonical"
    assert file_items[file_key]["filename"] == "02.flac"
    assert file_items[file_key]["album"] == "Problem Album"
    assert file_items[file_key]["problem_reason"] == "Missing year"
    assert {item["row_key"] for item in problem_rule["items"]} == {
        album_item["row_key"],
        delimiter_key,
        legacy_key,
        file_key,
    }

    sql = str(executed[0])
    assert "library.ignored_versions" in sql
    assert "library.ignored_repairs" in sql
    assert "library.local_albums" in sql
    assert "library.local_track_files" in sql
    assert "scan_cache,file_entry" in sql
    assert "::problem-album::" in sql
    assert "split_part(library.ignored_repairs.repair_key, '::', 2)" not in sql
    assert "split_part(library.ignored_repairs.repair_key, '::', 1)" not in sql
    assert any(
        delimiter_aware_parser in sql
        for delimiter_aware_parser in ("regexp_match(", "regexp_replace(", "substring(", "reverse(")
    ), "album exclusion SQL must identify the problem-album suffix from the right"


def test_problem_exclusion_identity_round_trips_exact_visible_reasons_into_rules():
    from music_app.services import library_browse_postgres as module

    path = r"D:\Music\Artist\Album\03 Third.flac"
    visible_reasons = (
        "Incomplete track order: Disc 1 missing 2, 4",
        "Unexpected embedded cuesheet marker",
    )
    row_keys: list[str] = []

    for reason in visible_reasons:
        row_key = module._problem_identity_row_key(path, reason, scope="file")
        repeated_row_key = module._problem_identity_row_key(path, reason, scope="file")
        rules_item = module._utility_problem_ignore_payload(
            {
                "ignored_repair_key": row_key,
                "file_private_path": path,
                "file_entry": {
                    "path": path,
                    "album": "Exact Reason Album",
                    "album_artist": "Exact Reason Artist",
                    "title": "Third",
                },
                "alias_to_canonical": {},
            }
        )

        assert repeated_row_key == row_key
        assert rules_item["row_key"] == row_key
        assert rules_item["scope"] == "file"
        assert rules_item["path"] == path
        assert rules_item["problem_reason"] == reason
        row_keys.append(row_key)

    assert row_keys[0] != row_keys[1]
    assert module._problem_identity_row_key(
        path,
        "Another unknown visible reason",
        scope="file",
    ) not in row_keys


def test_targeted_problem_ignore_projection_returns_full_canonical_item_with_durable_owner():
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
    from music_app.services.problem_exclusions import ProblemExclusionItem

    durable_album_key = "product artist::studio records"
    projected_identity = f"{durable_album_key}::year::1988"
    row_key = f"{projected_identity}::problem-album::undecoded-characters"
    track_path = "C:/Music/Product Artist/Studio Records/01.flac"
    executed: list[tuple[str, dict[str, object]]] = []

    class FakeCursor:
        def fetchall(self):
            return [{
                "row_kind": "problem_ignore",
                "album_id": 701,
                "album_key": durable_album_key,
                "album_title": "?",
                "album_release_year": 1988,
                "album_cover_path": None,
                "album_metadata": {"album_artist": "Product Artist"},
                "artist_name": "Product Artist",
                "ignored_version_key": None,
                "ignored_repair_key": row_key,
                "file_private_path": None,
                "file_entry": None,
                "alias_to_canonical": {},
                "legacy_repair_keys": [f"{track_path}::album"],
            }]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            executed.append((str(sql), dict(params or {})))
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    items = repository.resolve_problem_exclusion_items((
        ProblemExclusionItem(
            row_key=row_key,
            scope="album",
            album_key=durable_album_key,
        ),
    ))

    assert items == [{
        "row_key": row_key,
        "scope": "album",
        "path": "",
        "filename": "",
        "field": "problem-album",
        "album": "?",
        "artist": "Product Artist",
        "year": "1988",
        "problem_reason": "Undecoded characters",
        "album_group_key": "Product Artist :: ?",
        "album_key": durable_album_key,
        "legacy_row_keys": [f"{track_path}::album"],
    }]
    assert len(executed) == 1
    sql, params = executed[0]
    normalized_sql = " ".join(sql.split()).lower()
    assert "library.local_albums" in normalized_sql
    assert "library.ignored_versions" not in normalized_sql
    assert "library.ignored_repairs.repair_key = any" not in normalized_sql
    assert "album_key = any(%(album_keys)s::text[])" in normalized_sql
    assert params == {"album_keys": [durable_album_key], "file_paths": []}


def test_split_release_album_exclusion_round_trips_unsplit_postgres_album_identity_into_rules():
    from music_app.services.library_browse_postgres import (
        _problematic_album_detail_payload,
        _problematic_album_projection_payloads,
    )

    durable_album_key = "product artist::studio records"
    source_rows = _semantic_problematic_release_rows(
        [1, 2],
        album_id=701,
        album_key=durable_album_key,
        year=1988,
        separate_release_keys=[durable_album_key],
    )
    for source_row in source_rows:
        source_row["album_cover_path"] = None
        source_row["album_metadata"] = {
            "album_artist": "Product Artist",
            "artists": ["Product Artist"],
        }
    split_album = _problematic_album_projection_payloads(source_rows)[0]
    split_detail = _problematic_album_detail_payload(split_album)
    assert split_detail is not None
    split_exclusion = next(
        row
        for row in split_detail["album_problem_rows"]
        if row["reason"] == "Missing cover art"
    )
    split_key = "product artist::studio records::year::1988"
    assert split_album["key"] == split_key
    assert source_rows[0]["album_key"] == durable_album_key
    assert split_exclusion["row_key"] == (
        f"{split_key}::problem-album::missing-cover-art"
    )
    assert split_exclusion["album_key"] == durable_album_key


def test_postgres_library_browse_uses_saved_key_when_ignored_version_row_has_no_album_match():
    from music_app.services import library_browse_postgres as module
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    with module._UTILITY_PROJECTION_CACHE_LOCK:
        module._UTILITY_PROJECTION_CACHE.clear()
        module._UTILITY_PROJECTION_PREWARM_INFLIGHT.clear()

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "album_id": None,
                    "album_key": None,
                    "album_title": None,
                    "album_release_year": None,
                    "album_cover_path": None,
                    "album_metadata": None,
                    "ignored_version_key": "helloween",
                    "ignored_repair_key": None,
                    "artist_name": None,
                    "file_private_path": None,
                    "file_entry": None,
                    "alias_to_canonical": {},
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, params=None):
            return FakeCursor()

    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_utility_rules_payload()

    assert payload["rules"][0]["albums"] == [{
        "key": "helloween",
        "album_ref": "helloween",
        "name": "Helloween",
        "album_artist": "",
        "year": "",
        "edition": "",
        "tracks": [],
    }]


def test_postgres_library_browse_caches_problematic_files_payload_per_database_url():
    from music_app.services import library_browse_postgres as module

    with module._UTILITY_PROJECTION_CACHE_LOCK:
        module._UTILITY_PROJECTION_CACHE.clear()
        module._UTILITY_PROJECTION_PREWARM_INFLIGHT.clear()

    executed = {"count": 0}

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "album_id": 101,
                    "album_key": "album-1",
                    "album_title": "Problem Album",
                    "album_release_year": 2001,
                    "album_cover_path": None,
                    "album_metadata": {
                        "album_artist": "Problem Artist",
                        "artists": ["Problem Artist"],
                    },
                    "artist_name": "Problem Artist",
                    "track_id": 501,
                    "track_key": "track-1",
                    "track_title": "Problem Track",
                    "disc_number": 1,
                    "track_number": 1,
                    "duration_seconds": 180,
                    "file_private_path": r"D:\Music\Problem Artist\Problem Album\01 - Problem Track.flac",
                    "file_entry": {
                        "path": r"D:\Music\Problem Artist\Problem Album\01 - Problem Track.flac",
                        "album": "Problem Album",
                        "album_artist": "Problem Artist",
                        "artist": "Problem Artist",
                        "title": "Problem Track",
                        "year": "2001",
                    },
                    "ignored_repair_keys": [],
                    "separate_release_keys": [],
                    "duplicate_file_count": 1,
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, _params=None):
            executed["count"] += 1
            return FakeCursor()

    repository = module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    first_payload = repository.build_problematic_files_payload()
    second_payload = repository.build_problematic_files_payload()

    assert executed["count"] == 4
    assert first_payload["count"] == 1
    assert first_payload["projection_cache_status"] == "rebuilt"
    assert second_payload["projection_cache_status"] == "hit"
    assert second_payload["items"] == first_payload["items"]
    assert second_payload is not first_payload


def test_postgres_library_browse_can_disable_background_utility_projection_prewarm(monkeypatch):
    from music_app.services import library_browse_postgres as module

    submissions = []

    class RecordingExecutor:
        def submit(self, *args):
            submissions.append(args)

    monkeypatch.setattr(module, "_UTILITY_PROJECTION_PREWARM_EXECUTOR", RecordingExecutor())
    repository = module.PostgresLibraryBrowseRepository({
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "ALBUM_HAVEN_UTILITY_PROJECTION_PREWARM_ENABLED": False,
    })

    repository.queue_settings_projection_prewarm()
    repository.queue_utility_projection_prewarm("problematic-files")

    assert submissions == []


def test_postgres_library_browse_problematic_files_prewarm_and_foreground_share_one_computation(monkeypatch):
    from music_app.services import library_browse_postgres as module

    with module._UTILITY_PROJECTION_CACHE_LOCK:
        module._UTILITY_PROJECTION_CACHE.clear()
        module._UTILITY_PROJECTION_PREWARM_INFLIGHT.clear()

    first_query_started = Event()
    release_first_query = Event()
    foreground_cache_checked = Event()
    counter_lock = Lock()
    counters = {"cache_checks": 0, "queries": 0, "classifications": 0}

    class FakeCursor:
        def fetchall(self):
            return [_normal_problematic_product_row()]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, _params=None):
            with counter_lock:
                counters["queries"] += 1
                query_number = counters["queries"]
            if query_number == 1:
                first_query_started.set()
                assert release_first_query.wait(timeout=2)
            return FakeCursor()

    original_projection = module._problematic_album_projection_payloads

    def counted_projection(rows):
        with counter_lock:
            counters["classifications"] += 1
        return original_projection(rows)

    monkeypatch.setattr(module, "_problematic_album_projection_payloads", counted_projection)
    repository = module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/singleflight"},
        connect=lambda _database_url: FakeConnection(),
    )
    original_get_cached = repository._get_cached_utility_projection

    def observed_get_cached(kind):
        result = original_get_cached(kind)
        with counter_lock:
            counters["cache_checks"] += 1
            if counters["cache_checks"] == 2:
                foreground_cache_checked.set()
        return result

    monkeypatch.setattr(repository, "_get_cached_utility_projection", observed_get_cached)

    with ThreadPoolExecutor(max_workers=2) as executor:
        background_prewarm = executor.submit(repository.build_problematic_files_payload)
        assert first_query_started.wait(timeout=2)
        foreground_request = executor.submit(repository.build_problematic_files_payload)
        assert foreground_cache_checked.wait(timeout=2)
        release_first_query.set()
        background_payload = background_prewarm.result(timeout=2)
        foreground_payload = foreground_request.result(timeout=2)

    assert counters["queries"] == 4
    assert counters["classifications"] == 1
    assert background_payload["projection_cache_status"] == "rebuilt"
    assert foreground_payload["projection_cache_status"] == "hit"
    assert background_payload["items"] == foreground_payload["items"]
    assert background_payload is not foreground_payload




def test_postgres_library_browse_caches_utility_rules_payload_per_database_url():
    from music_app.services import library_browse_postgres as module

    with module._UTILITY_PROJECTION_CACHE_LOCK:
        module._UTILITY_PROJECTION_CACHE.clear()
        module._UTILITY_PROJECTION_PREWARM_INFLIGHT.clear()

    executed = {"count": 0}

    class FakeCursor:
        def fetchall(self):
            return [
                {
                    "album_id": 101,
                    "album_key": "ignored-album",
                    "album_title": "Ignored Album",
                    "album_release_year": 1999,
                    "album_cover_path": "covers/ignored.jpg",
                    "album_metadata": {
                        "album_artist": "Canonical Artist",
                        "artists": ["Canonical Artist"],
                    },
                    "ignored_version_key": "ignored-album",
                    "ignored_repair_key": "",
                    "file_private_path": None,
                    "file_entry": None,
                    "alias_to_canonical": {},
                },
            ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, _sql, _params=None):
            executed["count"] += 1
            return FakeCursor()

    repository = module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    first_payload = repository.build_utility_rules_payload()
    second_payload = repository.build_utility_rules_payload()

    assert executed["count"] == 1
    assert first_payload["ignored_version_keys"] == ["ignored-album"]
    assert second_payload == first_payload
    assert second_payload is not first_payload


def test_shared_legacy_invalidators_refresh_postgres_problematic_and_rules_projections(monkeypatch):
    from music_app.services import library_browse_postgres as module
    from music_app.services.problematic_albums import invalidate_problematic_albums_payload_cache
    from music_app.services.utility_rules import invalidate_utility_rules_payload_cache

    module.invalidate_postgres_utility_projection_cache()
    current = {"problem": "problem-1", "rule": "rule-1"}
    calls = {"problem": 0, "rule": 0}
    repository = module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/invalidation"},
        connect=lambda _database_url: None,
    )

    def build_problematic():
        calls["problem"] += 1
        return {"items": [{"key": current["problem"]}], "count": 1}

    def load_rules():
        calls["rule"] += 1
        return [{"rule": current["rule"]}]

    monkeypatch.setattr(repository, "_build_problematic_files_payload_uncached", build_problematic)
    monkeypatch.setattr(repository, "_load_utility_rules_rows", load_rules)
    monkeypatch.setattr(
        module,
        "_utility_rules_projection_payload",
        lambda rows: {"ok": True, "rule": rows[0]["rule"]},
    )

    assert repository.build_problematic_files_payload()["items"][0]["key"] == "problem-1"
    assert repository.build_utility_rules_payload()["rule"] == "rule-1"
    current.update(problem="problem-2", rule="rule-2")
    invalidate_problematic_albums_payload_cache({})
    assert repository.build_problematic_files_payload()["items"][0]["key"] == "problem-2"
    assert repository.build_utility_rules_payload()["rule"] == "rule-2"

    current.update(problem="problem-3", rule="rule-3")
    invalidate_utility_rules_payload_cache({})
    assert repository.build_problematic_files_payload()["items"][0]["key"] == "problem-3"
    assert repository.build_utility_rules_payload()["rule"] == "rule-3"
    assert calls == {"problem": 3, "rule": 3}


def test_postgres_utility_projection_cache_reuses_payload_until_explicit_invalidation(monkeypatch):
    from music_app.services import library_browse_postgres as module

    database_url = "postgresql://album_haven_app@localhost/no-expiry-cache"
    build_count = 0
    repository = module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": database_url},
        connect=lambda _database_url: None,
    )
    module.invalidate_postgres_utility_projection_cache(
        database_url=database_url,
        kinds=("problematic-files",),
    )
    assert not hasattr(module, "_UTILITY_PROJECTION_CACHE_TTL_SECONDS")

    def build_payload():
        nonlocal build_count
        build_count += 1
        return {"items": [{"key": f"payload-{build_count}"}], "count": 1}

    monkeypatch.setattr(repository, "_build_problematic_files_payload_uncached", build_payload)

    assert repository.build_problematic_files_payload()["items"][0]["key"] == "payload-1"
    assert repository.build_problematic_files_payload()["items"][0]["key"] == "payload-1"
    assert build_count == 1

    module.invalidate_postgres_utility_projection_cache(
        database_url=database_url,
        kinds=("problematic-files",),
    )
    assert repository.build_problematic_files_payload()["items"][0]["key"] == "payload-2"
    assert build_count == 2

def test_postgres_utility_projection_invalidation_is_scoped_by_database_url_and_kind():
    from music_app.services import library_browse_postgres as module

    database_a = "postgresql://album_haven_app@localhost/cache-a"
    database_b = "postgresql://album_haven_app@localhost/cache-b"
    keys = {
        (database_a, "problematic-files"),
        (database_a, "rules"),
        (database_b, "problematic-files"),
        (database_b, "rules"),
    }
    with module._UTILITY_PROJECTION_CACHE_LOCK:
        module._UTILITY_PROJECTION_CACHE.clear()
        module._UTILITY_PROJECTION_GENERATIONS.clear()
        for key in keys:
            module._UTILITY_PROJECTION_CACHE[key] = {"key": key}
            module._UTILITY_PROJECTION_GENERATIONS[key] = 4

    module.invalidate_postgres_utility_projection_cache(
        database_url=database_a,
        kinds=("problematic-files",),
    )

    with module._UTILITY_PROJECTION_CACHE_LOCK:
        assert (database_a, "problematic-files") not in module._UTILITY_PROJECTION_CACHE
        assert module._UTILITY_PROJECTION_GENERATIONS[(database_a, "problematic-files")] == 5
        assert module._UTILITY_PROJECTION_GENERATIONS[(database_a, "rules")] == 4
        assert module._UTILITY_PROJECTION_GENERATIONS[(database_b, "problematic-files")] == 4
        assert module._UTILITY_PROJECTION_GENERATIONS[(database_b, "rules")] == 4
        assert set(module._UTILITY_PROJECTION_CACHE) == keys - {(database_a, "problematic-files")}


def test_problematic_invalidation_during_singleflight_rebuilds_waiter_without_caching_stale_leader(monkeypatch):
    from music_app.services import library_browse_postgres as module

    database_url = "postgresql://album_haven_app@localhost/generation-race"
    cache_key = (database_url, "problematic-files")
    old_build_started = Event()
    release_old_build = Event()
    waiting_reader_checked_cache = Event()
    build_lock = Lock()
    build_count = 0
    cache_check_count = 0
    current_key = "old"
    repository = module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": database_url},
        connect=lambda _database_url: None,
    )

    with module._UTILITY_PROJECTION_CACHE_LOCK:
        module._UTILITY_PROJECTION_CACHE.pop(cache_key, None)
        module._UTILITY_PROJECTION_SINGLEFLIGHT.pop(cache_key, None)
        module._UTILITY_PROJECTION_GENERATIONS.pop(cache_key, None)

    def build_payload():
        nonlocal build_count
        with build_lock:
            build_count += 1
            build_number = build_count
            payload_key = current_key
        if build_number == 1:
            old_build_started.set()
            assert release_old_build.wait(timeout=2)
        return {"items": [{"key": payload_key}], "count": 1}

    monkeypatch.setattr(repository, "_build_problematic_files_payload_uncached", build_payload)
    original_get_cached = repository._get_cached_utility_projection

    def observed_get_cached(kind):
        nonlocal cache_check_count
        result = original_get_cached(kind)
        cache_check_count += 1
        if cache_check_count == 2:
            waiting_reader_checked_cache.set()
        return result

    monkeypatch.setattr(repository, "_get_cached_utility_projection", observed_get_cached)

    with ThreadPoolExecutor(max_workers=2) as executor:
        stale_leader = executor.submit(repository.build_problematic_files_payload)
        assert old_build_started.wait(timeout=2)
        waiting_reader = executor.submit(repository.build_problematic_files_payload)
        assert waiting_reader_checked_cache.wait(timeout=2)
        module.invalidate_postgres_utility_projection_cache(
            database_url=database_url,
            kinds=("problematic-files",),
        )
        current_key = "fresh"
        release_old_build.set()
        assert stale_leader.result(timeout=2)["items"][0]["key"] == "old"
        assert waiting_reader.result(timeout=2)["items"][0]["key"] == "fresh"

    assert build_count == 2
    assert repository.build_problematic_files_payload()["items"][0]["key"] == "fresh"


def test_problematic_singleflight_exception_releases_waiter(monkeypatch):
    from music_app.services import library_browse_postgres as module

    database_url = "postgresql://album_haven_app@localhost/exception-race"
    cache_key = (database_url, "problematic-files")
    failing_build_started = Event()
    release_failing_build = Event()
    waiting_reader_checked_cache = Event()
    build_lock = Lock()
    build_count = 0
    cache_check_count = 0
    repository = module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": database_url},
        connect=lambda _database_url: None,
    )
    with module._UTILITY_PROJECTION_CACHE_LOCK:
        module._UTILITY_PROJECTION_CACHE.pop(cache_key, None)
        module._UTILITY_PROJECTION_SINGLEFLIGHT.pop(cache_key, None)
        module._UTILITY_PROJECTION_GENERATIONS.pop(cache_key, None)

    def build_payload():
        nonlocal build_count
        with build_lock:
            build_count += 1
            build_number = build_count
        if build_number == 1:
            failing_build_started.set()
            assert release_failing_build.wait(timeout=2)
            raise RuntimeError("first build failed")
        return {"items": [{"key": "recovered"}], "count": 1}

    monkeypatch.setattr(repository, "_build_problematic_files_payload_uncached", build_payload)
    original_get_cached = repository._get_cached_utility_projection

    def observed_get_cached(kind):
        nonlocal cache_check_count
        result = original_get_cached(kind)
        cache_check_count += 1
        if cache_check_count == 2:
            waiting_reader_checked_cache.set()
        return result

    monkeypatch.setattr(repository, "_get_cached_utility_projection", observed_get_cached)

    with ThreadPoolExecutor(max_workers=2) as executor:
        failing_leader = executor.submit(repository.build_problematic_files_payload)
        assert failing_build_started.wait(timeout=2)
        waiting_reader = executor.submit(repository.build_problematic_files_payload)
        assert waiting_reader_checked_cache.wait(timeout=2)
        release_failing_build.set()
        with pytest.raises(RuntimeError, match="first build failed"):
            failing_leader.result(timeout=2)
        assert waiting_reader.result(timeout=2)["items"][0]["key"] == "recovered"

    assert build_count == 2
    with module._UTILITY_PROJECTION_CACHE_LOCK:
        assert cache_key not in module._UTILITY_PROJECTION_SINGLEFLIGHT


def test_invalidated_problematic_prewarm_cannot_repopulate_stale_payload(monkeypatch):
    from music_app.services import library_browse_postgres as module

    database_url = "postgresql://album_haven_app@localhost/prewarm-race"
    cache_key = (database_url, "problematic-files")
    old_build_started = Event()
    release_old_build = Event()
    current_key = "old"
    build_count = 0
    repository = module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": database_url},
        connect=lambda _database_url: None,
    )
    with module._UTILITY_PROJECTION_CACHE_LOCK:
        module._UTILITY_PROJECTION_CACHE.pop(cache_key, None)
        module._UTILITY_PROJECTION_SINGLEFLIGHT.pop(cache_key, None)
        module._UTILITY_PROJECTION_GENERATIONS.pop(cache_key, None)
        module._UTILITY_PROJECTION_PREWARM_INFLIGHT.add(cache_key)

    def build_payload():
        nonlocal build_count
        build_count += 1
        payload_key = current_key
        if build_count == 1:
            old_build_started.set()
            assert release_old_build.wait(timeout=2)
        return {"items": [{"key": payload_key}], "count": 1}

    monkeypatch.setattr(repository, "_build_problematic_files_payload_uncached", build_payload)

    with ThreadPoolExecutor(max_workers=1) as executor:
        old_prewarm = executor.submit(repository._run_utility_projection_prewarm, "problematic-files", cache_key)
        assert old_build_started.wait(timeout=2)
        module.invalidate_postgres_utility_projection_cache(
            database_url=database_url,
            kinds=("problematic-files",),
        )
        current_key = "fresh"
        release_old_build.set()
        old_prewarm.result(timeout=2)

    with module._UTILITY_PROJECTION_CACHE_LOCK:
        assert cache_key not in module._UTILITY_PROJECTION_CACHE
        assert cache_key not in module._UTILITY_PROJECTION_PREWARM_INFLIGHT
    assert repository.build_problematic_files_payload()["items"][0]["key"] == "fresh"
    assert build_count == 2


def test_utility_rules_invalidation_during_load_rejects_stale_cache_commit(monkeypatch):
    from music_app.services import library_browse_postgres as module

    database_url = "postgresql://album_haven_app@localhost/rules-generation-race"
    cache_key = (database_url, "rules")
    old_load_started = Event()
    release_old_load = Event()
    current_rule = "old"
    load_count = 0
    repository = module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": database_url},
        connect=lambda _database_url: None,
    )
    with module._UTILITY_PROJECTION_CACHE_LOCK:
        module._UTILITY_PROJECTION_CACHE.pop(cache_key, None)
        module._UTILITY_PROJECTION_GENERATIONS.pop(cache_key, None)

    def load_rows():
        nonlocal load_count
        load_count += 1
        rule = current_rule
        if load_count == 1:
            old_load_started.set()
            assert release_old_load.wait(timeout=2)
        return [{"rule": rule}]

    monkeypatch.setattr(repository, "_load_utility_rules_rows", load_rows)
    monkeypatch.setattr(
        module,
        "_utility_rules_projection_payload",
        lambda rows: {"ok": True, "rule": rows[0]["rule"]},
    )

    with ThreadPoolExecutor(max_workers=1) as executor:
        stale_load = executor.submit(repository.build_utility_rules_payload)
        assert old_load_started.wait(timeout=2)
        module.invalidate_postgres_utility_projection_cache(
            database_url=database_url,
            kinds=("rules",),
        )
        current_rule = "fresh"
        release_old_load.set()
        assert stale_load.result(timeout=2)["rule"] == "old"

    with module._UTILITY_PROJECTION_CACHE_LOCK:
        assert cache_key not in module._UTILITY_PROJECTION_CACHE
    assert repository.build_utility_rules_payload()["rule"] == "fresh"
    assert load_count == 2


def test_postgres_library_browse_problematic_detail_ignores_e2e_fixture_file(monkeypatch, tmp_path):
    from music_app.services import library_browse_postgres as module

    tmp_path.mkdir(parents=True, exist_ok=True)
    fixture_path = tmp_path / "problematic-fixture.json"
    fixture_path.write_text(json.dumps({
        "summary": {
            "items": [
                {
                    "key": "fixture-album",
                    "name": "Fixture Album",
                    "album_artist": "Fixture Artist",
                    "problem_reasons": ["Missing year"],
                    "track_paths": [r"D:\Music\Fixture Artist\Fixture Album\01.flac"],
                    "tracks": [{"path": r"D:\Music\Fixture Artist\Fixture Album\01.flac", "title": "Track One"}],
                    "detail_loaded": False,
                },
            ],
            "count": 1,
        },
        "details": {},
    }), encoding="utf-8")
    monkeypatch.setenv("ALBUM_HAVEN_E2E_PROBLEMATIC_FIXTURE_PATH", str(fixture_path))

    class FakeCursor:
        def fetchall(self):
            return [_normal_problematic_product_row()]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            assert "e2e_problematic_file_fixture_seeds" not in str(sql)
            return FakeCursor()

    repository = module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    payload = repository.build_problematic_file_detail_payload("product-album")

    assert payload is not None
    assert payload["key"] == "product-album"
    assert payload["name"] == "Product Album"
    assert payload["detail_loaded"] is True
    assert payload["problematic_track_paths"] == [r"D:\Music\Product Artist\Product Album\01.flac"]


def test_postgres_library_browse_empty_product_rows_ignore_empty_e2e_fixture(monkeypatch, tmp_path):
    from music_app.services import library_browse_postgres as module

    fixture_path = tmp_path / "problematic-fixture-empty.json"
    fixture_path.write_text(json.dumps({
        "summary": {
            "items": [],
            "count": 0,
        },
    }), encoding="utf-8")
    monkeypatch.setenv("ALBUM_HAVEN_E2E_PROBLEMATIC_FIXTURE_PATH", str(fixture_path))

    class FakeCursor:
        def fetchall(self):
            return []

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            assert "e2e_problematic_file_fixture_seeds" not in str(sql)
            return FakeCursor()

    repository = module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: FakeConnection(),
    )

    assert repository.build_problematic_files_payload() == {
        "items": [],
        "initial_detail": None,
        "count": 0,
        "persistence_backend": "postgres",
        "persistence_seam": "library_browse",
        "view_data_source": "postgres_library_browse",
        "projection_cache_status": "rebuilt",
    }


def _album_rating_overlay_test_row(
    *, artist: str, album_id: int, album_key: str, title: str, tag_album_rating: int
) -> dict[str, object]:
    row = _browse_album_row(
        artist=artist,
        album_id=album_id,
        album_key=album_key,
        title=title,
    )
    row["album_metadata"] = {
        **dict(row["album_metadata"]),
        "tag_album_rating": tag_album_rating,
    }
    return row


class _RecordingAlbumRatingsService:
    instances: list["_RecordingAlbumRatingsService"] = []

    def __init__(self, config, *, connect=None):
        self.config = config
        self.connect = connect
        self.load_calls: list[list[str]] = []
        self.__class__.instances.append(self)

    def load_album_ratings(self, album_keys, *, connection=None):
        del connection
        normalized_keys = [str(album_key) for album_key in album_keys]
        self.load_calls.append(normalized_keys)
        return {
            "numeric-album": {"rating": 8, "provenance": "explicit_import"},
            "cleared-album": {"rating": None, "provenance": "explicit_clear"},
        }


def _rating_overlay_test_rows() -> list[dict[str, object]]:
    return [
        _album_rating_overlay_test_row(
            artist="Rating Artist",
            album_id=101,
            album_key="numeric-album",
            title="Numeric Album",
            tag_album_rating=4,
        ),
        _album_rating_overlay_test_row(
            artist="Rating Artist",
            album_id=102,
            album_key="cleared-album",
            title="Cleared Album",
            tag_album_rating=6,
        ),
        _album_rating_overlay_test_row(
            artist="Rating Artist",
            album_id=103,
            album_key="missing-album",
            title="Missing Album",
            tag_album_rating=9,
        ),
    ]


def _install_recording_album_ratings_service(monkeypatch):
    from music_app.services import library_browse_postgres as browse_module

    _RecordingAlbumRatingsService.instances = []
    monkeypatch.setattr(
        browse_module,
        "PostgresAlbumRatingsService",
        _RecordingAlbumRatingsService,
        raising=False,
    )


def _assert_single_album_rating_batch() -> None:
    assert len(_RecordingAlbumRatingsService.instances) == 1
    assert len(_RecordingAlbumRatingsService.instances[0].load_calls) == 1
    assert set(_RecordingAlbumRatingsService.instances[0].load_calls[0]) == {
        "numeric-album",
        "cleared-album",
        "missing-album",
    }


def _assert_album_rating_overlay_contract(
    payload: dict[str, object],
    *,
    expect_gallery_summary: bool = False,
) -> None:
    albums = {
        album["key"]: album
        for group in payload["artist_groups"]
        for album in group["albums"]
    }

    assert albums["numeric-album"]["album_preference"]["rating"] == 8
    assert albums["numeric-album"]["album_preference"]["can_edit"] is True
    assert albums["numeric-album"]["tag_album_rating"] == 4
    assert albums["numeric-album"]["tag_album_rating_source"] == "file_tag"

    assert albums["cleared-album"]["album_preference"]["rating"] is None
    assert albums["cleared-album"]["album_preference"]["can_edit"] is True
    assert albums["cleared-album"]["tag_album_rating"] == 6
    assert albums["cleared-album"]["tag_album_rating_source"] == "file_tag"

    assert albums["missing-album"]["album_preference"]["rating"] is None
    assert albums["missing-album"]["album_preference"]["can_edit"] is False
    assert albums["missing-album"]["tag_album_rating"] == 9
    assert albums["missing-album"]["tag_album_rating_source"] == "file_tag"
    if expect_gallery_summary:
        for album in albums.values():
            assert album["gallery_list_block"]["summary"]["album_preference"] == album[
                "album_preference"
            ]


def test_private_album_rating_overlay_keeps_gallery_summary_in_sync():
    from music_app.services import library_browse_postgres as browse_module
    from music_app.services.listen_through import default_album_preference_overlay

    repository = browse_module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: None,
        album_ratings_service=_RecordingAlbumRatingsService({}, connect=None),
    )
    album = {
        "key": "numeric-album",
        "gallery_list_block": {
            "summary": {
                "album_preference": default_album_preference_overlay(),
            },
        },
    }

    repository._apply_private_album_rating_overlays([album])

    assert album["album_preference"]["rating"] == 8
    assert album["album_preference"]["provenance"] == "explicit_import"
    assert album["gallery_list_block"]["summary"]["album_preference"] == album[
        "album_preference"
    ]
    assert (
        album["gallery_list_block"]["summary"]["album_preference"]
        is not album["album_preference"]
    )


def test_root_album_browse_payload_deduplicates_repeated_composite_album_artist_credit():
    from music_app.services.library_browse_postgres import (
        _root_album_browse_album_payloads,
    )

    repeated_credit = (
        "Frank Churchill / Leigh Harline / Larry Morey / "
        "Frank Churchill / Larry Morey"
    )
    row = _album_rating_overlay_test_row(
        artist="Larry Morey",
        album_id=104,
        album_key=f"{repeated_credit.casefold()}::snow-white-and-the-seven-dwarfs",
        title="Snow White And The Seven Dwarfs",
        tag_album_rating=8,
    )
    row["album_metadata"] = {
        **dict(row["album_metadata"]),
        "album_artist": repeated_credit,
        "edition": "Fixture Edition",
    }

    albums = _root_album_browse_album_payloads([row], "Larry Morey")

    assert albums[0]["album_artist"] == "Frank Churchill / Leigh Harline / Larry Morey"
    assert albums[0]["edition"] == "Fixture Edition"
    assert albums[0]["key"] == (
        f"{repeated_credit.casefold()}::snow-white-and-the-seven-dwarfs"
    )


def test_artist_tree_payload_deduplicates_display_without_changing_selection_identity():
    from music_app.services.library_browse_postgres import (
        _artists_sidebar_from_groups,
        _root_sidebar_aggregate,
        _search_artist_groups,
        _selected_artist_primary_groups,
    )

    repeated_credit = (
        "Frank Churchill / Leigh Harline / Larry Morey / "
        "Frank Churchill / Larry Morey"
    )
    display_credit = "Frank Churchill / Leigh Harline / Larry Morey"
    albums = [{"name": "Snow White And The Seven Dwarfs"}]

    groups = _selected_artist_primary_groups(
        repeated_credit,
        albums,
        use_preview_albums=True,
        alias_to_canonical={},
        canonical_to_aliases={},
    )
    sidebar = _artists_sidebar_from_groups(groups)

    assert groups[0]["artist"] == repeated_credit
    assert groups[0]["artist_display"] == display_credit
    assert sidebar == [
        {
            "artist": repeated_credit,
            "artist_display": display_credit,
            "count": 1,
        }
    ]
    clean_search_row = _album_rating_overlay_test_row(
        artist=display_credit,
        album_id=104,
        album_key=f"{repeated_credit.casefold()}::snow-white-and-the-seven-dwarfs",
        title="Snow White And The Seven Dwarfs",
        tag_album_rating=8,
    )
    clean_search_row["artist_id"] = 550
    repeated_search_row = _album_rating_overlay_test_row(
        artist=repeated_credit,
        album_id=104,
        album_key=f"{repeated_credit.casefold()}::snow-white-and-the-seven-dwarfs",
        title="Snow White And The Seven Dwarfs",
        tag_album_rating=8,
    )
    repeated_search_row["artist_id"] = 551
    search_groups = _search_artist_groups(
        [clean_search_row, repeated_search_row],
        query="Snow White",
    )

    assert len(search_groups) == 1
    assert len(search_groups[0]["albums"]) == 1
    assert search_groups[0]["artist"] == display_credit
    assert search_groups[0]["artist_display"] == display_credit

    displays, _sort_values, counts, album_count = _root_sidebar_aggregate([
        {
            "artist_id": 550,
            "artist_name": display_credit,
            "sort_name": display_credit.casefold(),
            "album_ids": [104],
            "album_count": 1,
        },
        {
            "artist_id": 551,
            "artist_name": repeated_credit,
            "sort_name": repeated_credit.casefold(),
            "album_ids": [104],
            "album_count": 1,
        },
    ])

    assert list(displays.values()) == [display_credit]
    assert list(counts.values()) == [1]
    assert album_count == 1


def test_root_album_browse_family_preview_retains_matched_artist_identity():
    from music_app.services.library_browse_postgres import (
        _root_album_browse_album_payloads,
    )

    row = _album_rating_overlay_test_row(
        artist="Дубинин & Холстинин",
        album_id=5096,
        album_key="витальный-дубинин-feat-владимир-холстинин::авария",
        title="Авария",
        tag_album_rating=9,
    )
    row["album_metadata"] = {
        **dict(row["album_metadata"]),
        "album_artist": "Виталий Дубинин feat Владимир Холстинин",
        "artists": ["Виталий Дубинин feat Владимир Холстинин"],
    }

    albums = _root_album_browse_album_payloads(
        [row],
        "",
        include_artist_members=True,
    )

    assert albums[0]["artists"] == [
        "Виталий Дубинин feat Владимир Холстинин",
        "Дубинин & Холстинин",
    ]


def test_family_group_restores_filter_identity_without_losing_split_release_display_credit():
    from music_app.services.library_browse_postgres import (
        _restore_selected_artist_family_group_labels,
    )

    groups = _restore_selected_artist_family_group_labels(
        [{
            "artist": "IR8 / Sexoturica",
            "artist_display": "IR8 / Sexoturica",
            "albums": [{"name": "IR8 vs Sexoturica"}],
        }],
        ["IR8"],
        alias_to_canonical={"IR8 / Sexoturica": "IR8"},
    )

    assert groups == [{
        "artist": "IR8 / Sexoturica",
        "artist_display": "IR8 / Sexoturica",
        "albums": [{"name": "IR8 vs Sexoturica"}],
    }]


def test_family_group_restores_preferred_punctuation_for_ordinary_alias():
    from music_app.services.library_browse_postgres import (
        _restore_selected_artist_family_group_labels,
    )

    groups = _restore_selected_artist_family_group_labels(
        [{
            "artist": "Emerson Lake & Palmer",
            "artist_display": "Emerson Lake & Palmer / Emerson, Lake & Palmer",
            "albums": [{"name": "Brain Salad Surgery"}],
        }],
        ["Emerson, Lake & Palmer"],
        alias_to_canonical={"Emerson Lake & Palmer": "Emerson, Lake & Palmer"},
    )

    assert groups == [{
        "artist": "Emerson, Lake & Palmer",
        "artist_display": "Emerson, Lake & Palmer",
        "albums": [{"name": "Brain Salad Surgery"}],
    }]


def test_postgres_root_browse_batch_loads_private_album_rating_overlays(monkeypatch):
    from music_app.services import library_browse_postgres as browse_module

    _install_recording_album_ratings_service(monkeypatch)
    monkeypatch.setattr(
        browse_module,
        "_queue_display_cover_variants_for_groups",
        lambda *_args, **_kwargs: None,
    )
    repository = browse_module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: None,
    )
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda **_kwargs: {"ignored_version_keys": [], "manual_version_links": {}},
    )
    monkeypatch.setattr(
        repository,
        "_load_root_album_browse_rows",
        lambda _state: _rating_overlay_test_rows(),
    )
    monkeypatch.setattr(repository, "_load_non_album_entries", lambda **_kwargs: [])

    payload = repository.build_root_album_browse_payload()

    _assert_album_rating_overlay_contract(payload)
    _assert_single_album_rating_batch()


def test_postgres_selected_artist_batch_loads_private_album_rating_overlays(monkeypatch):
    from music_app.services import library_browse_postgres as browse_module

    _install_recording_album_ratings_service(monkeypatch)
    monkeypatch.setattr(
        browse_module,
        "_queue_display_cover_variants_for_groups",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        browse_module,
        "_selected_artist_family_context_from_state",
        lambda *_args, **_kwargs: {
            "family_artists": [],
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
        },
    )
    repository = browse_module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: _NoopSearchSnapshotConnection(),
    )
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda **_kwargs: {"ignored_version_keys": [], "manual_version_links": {}},
    )
    monkeypatch.setattr(
        repository,
        "_load_selected_artist_rows",
        lambda *_args, **_kwargs: _rating_overlay_test_rows(),
    )
    monkeypatch.setattr(repository, "_load_non_album_entries", lambda **_kwargs: [])

    payload = repository.build_selected_artist_payload(
        query_params={"artist": "Rating Artist"},
    )

    _assert_album_rating_overlay_contract(payload)
    _assert_single_album_rating_batch()


def test_postgres_search_batch_loads_private_album_rating_overlays(monkeypatch):
    from music_app.services import library_browse_postgres as browse_module

    class SearchConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def execute(self, sql, params=None):
            assert str(sql).startswith("SET TRANSACTION")
            return _InventoryCursor()

    _install_recording_album_ratings_service(monkeypatch)
    monkeypatch.setattr(
        browse_module,
        "_queue_display_cover_variants_for_groups",
        lambda *_args, **_kwargs: None,
    )
    repository = browse_module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: SearchConnection(),
    )
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda **_kwargs: {"ignored_version_keys": [], "manual_version_links": {}},
    )
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda *_args, **_kwargs: _rating_overlay_test_rows(),
    )
    monkeypatch.setattr(repository, "_load_non_album_entries", lambda **_kwargs: [])

    payload = repository.build_search_payload(
        query_params={"q": "album", "all_artists": "1"},
    )

    _assert_album_rating_overlay_contract(payload, expect_gallery_summary=True)
    _assert_single_album_rating_batch()


def test_postgres_album_detail_batch_loads_private_rating_and_keeps_tag_rating(monkeypatch):
    import music_app.services.album_details as album_details_module
    from music_app.services import library_browse_postgres as browse_module

    _install_recording_album_ratings_service(monkeypatch)
    repository = browse_module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: None,
    )
    detail_row = _album_rating_overlay_test_row(
        artist="Rating Artist",
        album_id=101,
        album_key="numeric-album",
        title="Numeric Album",
        tag_album_rating=4,
    )
    monkeypatch.setattr(
        repository,
        "_load_album_detail_rows",
        lambda _album_key: [detail_row],
    )
    monkeypatch.setattr(
        album_details_module,
        "build_scrobbled_play_count_lookup",
        lambda *_args, **_kwargs: {},
    )
    monkeypatch.setattr(
        album_details_module,
        "build_track_preference_overlay_lookup",
        lambda *_args, **_kwargs: {},
    )

    payload = repository.build_album_detail_payload("numeric-album")

    assert payload is not None
    assert payload["album_preference"]["rating"] == 8
    assert payload["album_preference"]["can_edit"] is True
    assert payload["tag_album_rating"] == 4
    assert payload["tag_album_rating_source"] == "file_tag"
    assert len(_RecordingAlbumRatingsService.instances) == 1
    assert _RecordingAlbumRatingsService.instances[0].load_calls == [["numeric-album"]]


def test_root_startup_gallery_and_search_sql_exclude_persisted_non_album_rarities_before_rollups():
    from music_app.services.library_browse_postgres import (
        _root_album_browse_sql,
        _root_sidebar_sql,
        _root_startup_payload_sql,
        _selected_artist_preview_sql,
        _artist_preview_rows_sql,
        _exact_artist_match_sql,
        _search_preview_sql,
    )

    surfaces = {
        "root sidebar": _root_sidebar_sql(),
        "root gallery": _root_album_browse_sql(),
        "startup preview": _root_startup_payload_sql(12),
        "selected artist preview": _selected_artist_preview_sql(),
        "related artist preview": _artist_preview_rows_sql(),
        "exact artist match": _exact_artist_match_sql(),
        "search": _search_preview_sql(),
    }

    for surface, sql in surfaces.items():
        compact_sql = " ".join(sql.lower().split())
        assert "library.exception_overrides" in compact_sql, surface
        assert "non-album rarity" in compact_sql, surface
        assert "library.local_track_files.private_path" in compact_sql, surface
        assert "<> 'non-album rarity'" in compact_sql, surface
