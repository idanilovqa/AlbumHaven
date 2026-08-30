from __future__ import annotations

import base64
import binascii
from copy import deepcopy
from collections.abc import Callable, Iterable, Mapping
import json
from pathlib import Path
import re
from threading import Event, Lock
from types import SimpleNamespace
from typing import Any

from config import PERSISTENCE_BACKEND_POSTGRES
from music_app.routes.api_rules_helpers import (
    artist_alias_problem_reason,
    text_problem_reason,
    year_problem_reason,
)
from music_app.services.album_ratings_postgres import PostgresAlbumRatingsService
from music_app.services.gallery_display import (
    DEFAULT_GALLERY_DISPLAY_MODE,
    DEFAULT_GALLERY_SCALE_PERCENT,
    normalize_gallery_display_mode,
    normalize_gallery_scale_percent,
)
from music_app.services.gallery_playback_context import (
    build_gallery_playback_context,
    gallery_has_playable_albums,
)
from music_app.services.gallery_scope import (
    entry_visible_in_categories,
    normalize_gallery_scope,
    normalize_visible_categories,
)
from music_app.services.artist_credits import deduplicate_repeated_album_artist_members
from music_app.services.library_inventory_postgres import (
    MAX_NON_ALBUM_CANDIDATE_LIMIT,
    PostgresLibraryInventoryRepository,
    local_inventory_identity_key,
)
from music_app.services.listen_through import (
    apply_album_preference_overlay,
    default_album_preference_overlay,
)
from music_app.services.library_roots import configured_library_root_paths_snapshot
from music_app.services.opinion_read_seams import (
    build_popularity_browse_payload,
    build_viewer_opinion_preferences_payload,
)
from music_app.services.metadata import (
    NON_ALBUM_EXCEPTION_VALUES,
    build_text_repairs_for_entry,
    normalize_exception_value,
)
from music_app.services.non_album_view_payloads import (
    build_non_album_album_groups,
    build_non_album_track_list,
    has_meaningful_album_name,
    is_loose_track_album_value,
)
from music_app.services.runtime_shutdown import create_daemon_executor
from music_app.services.utility_rule_fallbacks import fallback_version_album_payload
from music_app.services.utils import (
    MOJIBAKE_CANDIDATE_PATTERN,
    MOJIBAKE_ENCODING_CANDIDATE_CHARS,
    format_duration,
)
from version import RELEASE_VERSION

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - keeps the module importable without psycopg.
    psycopg = None
    dict_row = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_UTILITY_PROJECTION_PREWARM_CONFIG_KEY = "ALBUM_HAVEN_UTILITY_PROJECTION_PREWARM_ENABLED"
_LIBRARY_BROWSE_SEAM_ID = "library_browse"
_SOURCE_TELEMETRY = "postgres_library_browse"
_DISPLAY_COVER_VARIANT_SIZE = 480
_DISPLAY_COVER_QUEUE_LIMIT = 2
_SEARCH_ALL_ARTISTS_DISPLAY_COVER_QUEUE_LIMIT = 2
_STARTUP_PREVIEW_ARTIST_LIMIT = 6
_UTILITY_PROJECTION_CACHE_LOCK = Lock()
_UTILITY_PROJECTION_CACHE: dict[tuple[str, str], dict[str, object]] = {}
_UTILITY_PROJECTION_PREWARM_INFLIGHT: set[tuple[str, str]] = set()
_UTILITY_PROJECTION_SINGLEFLIGHT: dict[tuple[str, str], Event] = {}
_UTILITY_PROJECTION_GENERATIONS: dict[tuple[str, str], int] = {}
_UTILITY_PROJECTION_PREWARM_EXECUTOR = create_daemon_executor(
    max_workers=1,
    thread_name_prefix="albumhaven-postgres-utility-prewarm",
)


def invalidate_postgres_utility_projection_cache(
    *,
    database_url: object | None = None,
    kinds: Iterable[str] | None = None,
) -> None:
    normalized_database_url = str(database_url or "").strip()
    normalized_kinds = {
        str(kind or "").strip()
        for kind in (kinds or ("problematic-files", "rules"))
        if str(kind or "").strip()
    }
    if not normalized_kinds:
        return
    with _UTILITY_PROJECTION_CACHE_LOCK:
        if normalized_database_url:
            affected_keys = {
                (normalized_database_url, kind)
                for kind in normalized_kinds
            }
        else:
            affected_keys = {
                key
                for key in (
                    set(_UTILITY_PROJECTION_CACHE)
                    | set(_UTILITY_PROJECTION_SINGLEFLIGHT)
                    | set(_UTILITY_PROJECTION_PREWARM_INFLIGHT)
                    | set(_UTILITY_PROJECTION_GENERATIONS)
                )
                if key[1] in normalized_kinds
            }
        for cache_key in affected_keys:
            _UTILITY_PROJECTION_GENERATIONS[cache_key] = (
                _UTILITY_PROJECTION_GENERATIONS.get(cache_key, 0) + 1
            )
            _UTILITY_PROJECTION_CACHE.pop(cache_key, None)


def _request_flag(value: object) -> bool:
    return str(value or "").strip().casefold() in {"1", "true", "yes", "on"}


def is_library_browse_postgres_available(config: dict[str, object] | None) -> bool:
    if not isinstance(config, dict):
        return False
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    return bool(database_url) and psycopg is not None and callable(getattr(psycopg, "connect", None))


class PostgresLibraryBrowseRepository:
    def __init__(
        self,
        config: dict[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
        album_ratings_service: Any | None = None,
    ) -> None:
        self._config = config
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        prewarm_enabled = str(
            config.get(_UTILITY_PROJECTION_PREWARM_CONFIG_KEY, "1")
        ).strip().casefold() not in {"0", "false", "no"}
        self._allow_background_prewarm = connect is None and prewarm_enabled
        self._connect = connect or _connect
        self._inventory_repository = PostgresLibraryInventoryRepository(
            config,
            connect=self._connect,
        )
        self._album_ratings_service = (
            album_ratings_service
            if album_ratings_service is not None
            else PostgresAlbumRatingsService(config, connect=self._connect)
        )

    def _apply_private_album_rating_overlays(
        self,
        albums: Iterable[dict[str, object]],
        *,
        source_rows: Iterable[object] = (),
        connection: Any | None = None,
        ensure_gallery_summary: bool = False,
    ) -> None:
        albums_by_key: dict[str, list[dict[str, object]]] = {}
        for album in albums:
            album_key = str(album.get("key") or album.get("album_ref") or "").strip()
            if album_key:
                albums_by_key.setdefault(album_key, []).append(album)
        if not albums_by_key:
            return

        tag_ratings_by_key: dict[str, tuple[object, object]] = {}
        for row in source_rows:
            row_payload = _row_mapping(row)
            album_key = str(row_payload.get("album_key") or "").strip()
            if not album_key or album_key in tag_ratings_by_key:
                continue
            metadata = _row_json_mapping(row_payload.get("album_metadata"))
            tag_rating = metadata.get("tag_album_rating")
            tag_ratings_by_key[album_key] = (
                tag_rating,
                (
                    str(metadata.get("tag_album_rating_source") or "file_tag")
                    if tag_rating is not None
                    else None
                ),
            )

        rating_rows = (
            self._album_ratings_service.load_album_ratings(
                albums_by_key,
                connection=connection,
            )
            if connection is not None
            else self._album_ratings_service.load_album_ratings(albums_by_key)
        )
        for album_key, matching_albums in albums_by_key.items():
            rating_row = rating_rows.get(album_key)
            for album in matching_albums:
                tag_rating, tag_rating_source = tag_ratings_by_key.get(
                    album_key,
                    (None, None),
                )
                album["tag_album_rating"] = tag_rating
                album["tag_album_rating_source"] = tag_rating_source
                overlay = default_album_preference_overlay()
                if rating_row is not None:
                    overlay["rating"] = rating_row.get("rating")
                    overlay["provenance"] = rating_row.get("provenance")
                    overlay["can_edit"] = True
                apply_album_preference_overlay(
                    album,
                    overlay,
                    ensure_gallery_summary=ensure_gallery_summary,
                )

    def _load_non_album_entries(
        self,
        *,
        view_state: Mapping[str, object],
        alias_to_canonical: Mapping[str, object],
        canonical_to_aliases: Mapping[str, object],
        visible_artist_names: Iterable[object] = (),
        query: object = "",
        connection: Any | None = None,
    ) -> list[dict[str, object]]:
        rows = self._inventory_repository.load_non_album_candidates(
            limit=MAX_NON_ALBUM_CANDIDATE_LIMIT,
            connection=connection,
        )
        return _non_album_entries_from_inventory_candidates(
            rows,
            visible_library_categories=list(
                view_state.get("visible_library_categories") or []
            ),
            alias_to_canonical=alias_to_canonical,
            canonical_to_aliases=canonical_to_aliases,
            visible_artist_names=visible_artist_names,
            query=query,
        )

    def build_root_counts_payload(
        self,
        *,
        query_params: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        view_state = _root_sidebar_view_state(query_params)
        connection = self._connect_to_database()
        try:
            connection.execute(
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
            )
            relation_alias_maps = self._load_relation_alias_maps(
                connection=connection,
            )
            root_alias_to_canonical = _root_browse_alias_to_canonical(
                relation_alias_maps["alias_to_canonical"]
            )
            rows = _canonicalize_artist_rows(
                self._load_root_sidebar_rows(
                    view_state,
                    connection=connection,
                ),
                root_alias_to_canonical,
            )
        finally:
            try:
                rollback = getattr(connection, "rollback", None)
                if callable(rollback):
                    rollback()
            finally:
                close = getattr(connection, "close", None)
                if callable(close):
                    close()
        _artist_displays, _artist_sort_values, artist_counts, album_count = (
            _root_sidebar_aggregate(rows)
        )
        return {
            "artist_count": len(artist_counts),
            "album_count": album_count,
            "show_all_artists_sidebar_link": True,
        }

    def build_root_sidebar_payload(
        self,
        *,
        query_params: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        view_state = _root_sidebar_view_state(query_params)
        connection = self._connect_to_database()
        try:
            connection.execute(
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
            )
            relation_alias_maps = self._load_relation_alias_maps(
                connection=connection,
            )
            root_alias_to_canonical = _root_browse_alias_to_canonical(
                relation_alias_maps["alias_to_canonical"]
            )
            support_state = self._inventory_repository.load_support_state(
                connection=connection,
            )
            raw_rows, raw_preview_rows = self._load_root_startup_rows(
                view_state,
                root_alias_to_canonical,
                connection=connection,
            )
            rows = _canonicalize_artist_rows(
                raw_rows,
                root_alias_to_canonical,
            )
            preview_rows = _canonicalize_artist_rows(
                raw_preview_rows,
                root_alias_to_canonical,
            )
            non_album_entries = self._load_non_album_entries(
                view_state=view_state,
                alias_to_canonical=relation_alias_maps["alias_to_canonical"],
                canonical_to_aliases=relation_alias_maps["canonical_to_aliases"],
                connection=connection,
            )
            configured_root_paths = (
                configured_library_root_paths_snapshot(
                    self._config,
                    connection=connection,
                )
                if non_album_entries
                else ()
            )
            preview_artist_groups = _root_album_browse_artist_groups(preview_rows)
            self._apply_private_album_rating_overlays(
                _album_payloads_from_groups(preview_artist_groups),
                source_rows=preview_rows,
                connection=connection,
            )
        finally:
            try:
                rollback = getattr(connection, "rollback", None)
                if callable(rollback):
                    rollback()
            finally:
                close = getattr(connection, "close", None)
                if callable(close):
                    close()
        non_album_tracks = build_non_album_track_list(
            non_album_entries,
            config=self._config,
            configured_root_paths=configured_root_paths,
        )
        artist_displays, artist_sort_values, artist_counts, album_count = (
            _root_sidebar_aggregate(rows)
        )
        ordered_artist_keys = sorted(
            artist_counts,
            key=lambda key: (
                artist_sort_values.get(key, artist_displays.get(key, key)).casefold(),
                artist_displays.get(key, key).casefold(),
            ),
        )
        artists_sidebar = [
            {
                "artist": artist_displays.get(artist_key, artist_key),
                "artist_display": _artist_tree_display_value(
                    artist_displays.get(artist_key, artist_key)
                ),
                "count": int(artist_counts[artist_key]),
            }
            for artist_key in ordered_artist_keys
        ]
        payload = {
            "surface": _build_view_surface_payload("albums"),
            "shell_layout": _build_shell_layout_payload(
                active_surface="albums",
                selected_artist="",
                local_tree_submode="",
            ),
            "artist_groups": preview_artist_groups,
            "primary_artist_groups": preview_artist_groups,
            "family_artist_groups": [],
            "related_artists": [],
            "artist_family_filters": [],
            "artists_sidebar": artists_sidebar,
            "album_count": album_count,
            "artist_count": len(artists_sidebar),
            "query": "",
            "search_filters": _build_search_filter_state(),
            "search_filter_contract": _build_search_filter_contract(),
            "search_query_contract": _build_search_query_contract(),
            "selected_artist": "",
            "all_artists_active": False,
            "show_all_artists_sidebar_link": True,
            "related_filter_artists": [],
            "primary_filter_active": False,
            "gallery_scope": view_state["gallery_scope"],
            "gallery_display_mode": view_state["gallery_display_mode"],
            "gallery_scale_percent": view_state["gallery_scale_percent"],
            "local_tree_submode": "",
            "visible_library_categories": view_state["visible_library_categories"],
            "music_dir": str(self._config_value("MUSIC_DIR")),
            "app_name": str(self._config_value("APP_NAME", "Album Haven")),
            "app_version": str(self._config_value("APP_VERSION", RELEASE_VERSION)),
            "ignored_version_keys": support_state["ignored_version_keys"],
            "manual_version_links": support_state["manual_version_links"],
            "non_album_tracks": non_album_tracks,
            "non_album_exception_values": sorted(set(NON_ALBUM_EXCEPTION_VALUES.values())),
            "viewer_opinion_preferences": build_viewer_opinion_preferences_payload({}),
            "popularity_browse": build_popularity_browse_payload(viewer_opinion_preferences={}),
            "payload_tier": "sidebar",
            "initial_view_partial": True,
            "persistence_backend": PERSISTENCE_BACKEND_POSTGRES,
            "persistence_seam": _LIBRARY_BROWSE_SEAM_ID,
            "view_data_source": _SOURCE_TELEMETRY,
        }
        _queue_display_cover_variants_for_groups(
            self._config,
            preview_artist_groups,
        )
        self.queue_settings_projection_prewarm()
        return payload

    def build_selected_artist_payload(
        self,
        *,
        query_params: Mapping[str, object] | None = None,
        library_state: Mapping[str, object] | None = None,
        _relation_alias_maps: Mapping[str, object] | None = None,
        _search_sidebar_artist_groups: list[dict[str, object]] | None = None,
        _selected_artist_preview_rows: list[object] | None = None,
        _connection: Any | None = None,
    ) -> dict[str, object]:
        if _connection is None:
            with self._connect_to_database() as connection:
                connection.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                )
                return self.build_selected_artist_payload(
                    query_params=query_params,
                    library_state=library_state,
                    _relation_alias_maps=_relation_alias_maps,
                    _search_sidebar_artist_groups=_search_sidebar_artist_groups,
                    _selected_artist_preview_rows=_selected_artist_preview_rows,
                    _connection=connection,
                )
        view_state = _root_sidebar_view_state(query_params)
        query = str((query_params or {}).get("q") or "").strip()
        requested_artist = str((query_params or {}).get("artist") or "").strip()
        relation_alias_maps = dict(
            _relation_alias_maps
            or self._load_relation_alias_maps(connection=_connection)
        )
        support_state = self._inventory_repository.load_support_state(
            connection=_connection,
        )
        alias_to_canonical = dict(relation_alias_maps.get("alias_to_canonical") or {})
        canonical_to_aliases = dict(relation_alias_maps.get("canonical_to_aliases") or {})
        selected_artist_alias_to_canonical = _root_browse_alias_to_canonical(
            alias_to_canonical
        )
        selected_artist = _canonical_artist_name(
            requested_artist,
            selected_artist_alias_to_canonical,
        )
        selected_artist_scope = _expanded_primary_artist_names(
            selected_artist,
            selected_artist_alias_to_canonical,
            canonical_to_aliases,
        )
        omit_sidebar = _request_flag((query_params or {}).get("omit_sidebar"))
        use_preview_albums = bool(query)
        hydrate_query_primary_albums = bool(
            query
            and selected_artist
            and _request_flag((query_params or {}).get("primary_filter"))
        )
        if use_preview_albums and not hydrate_query_primary_albums:
            rows = (
                _selected_artist_preview_rows
                if _selected_artist_preview_rows is not None
                else self._load_selected_artist_preview_rows(
                    selected_artist_scope,
                    view_state,
                    connection=_connection,
                )
            )
        else:
            rows = self._load_selected_artist_rows(
                selected_artist_scope,
                view_state,
                connection=_connection,
            )
        rows = _canonicalize_artist_rows(
            rows,
            selected_artist_alias_to_canonical,
        )
        artist_display = _selected_artist_display_name(rows, selected_artist)
        albums = (
            _root_album_browse_album_payloads(rows, artist_display)
            if use_preview_albums and not hydrate_query_primary_albums
            else _selected_artist_album_payloads(rows, artist_display)
        )
        if not use_preview_albums or hydrate_query_primary_albums:
            _annotate_album_payload_problematic_tracks(albums, rows)
        family_context = _selected_artist_family_context_from_state(
            artist_display,
            config=self._config,
            connect=self._connect,
            alias_to_canonical=alias_to_canonical,
            canonical_to_aliases=canonical_to_aliases,
            connection=_connection,
        )
        family_artists = list(family_context["family_artists"])
        full_family_artist_scope = _expanded_artist_name_list(
            [artist_display, *family_artists],
            family_context["alias_to_canonical"],
            family_context["canonical_to_aliases"],
        )
        non_album_entries = self._load_non_album_entries(
            view_state=view_state,
            alias_to_canonical=family_context["alias_to_canonical"],
            canonical_to_aliases=family_context["canonical_to_aliases"],
            visible_artist_names=full_family_artist_scope,
            query=query,
            connection=_connection,
        )
        non_album_tracks = build_non_album_track_list(
            non_album_entries,
            config=self._config,
        )
        family_preview_rows = (
            self._load_artist_preview_rows(
                _expanded_artist_name_list(
                    family_artists,
                    alias_to_canonical,
                    canonical_to_aliases,
                ),
                view_state,
                connection=_connection,
            )
            if family_artists
            else []
        )
        primary_artist_groups = _selected_artist_primary_groups(
            artist_display,
            albums,
            use_preview_albums=use_preview_albums,
            alias_to_canonical=family_context["alias_to_canonical"],
            canonical_to_aliases=family_context["canonical_to_aliases"],
        )
        reusable_primary_artist_groups = list(primary_artist_groups)
        family_artist_groups = _selected_artist_family_groups_from_preview_rows(
            family_artists,
            family_preview_rows,
            alias_to_canonical=family_context["alias_to_canonical"],
            canonical_to_aliases=family_context["canonical_to_aliases"],
        )
        sidebar_family_artist_groups = list(family_artist_groups)
        requested_related_artists = _query_param_list(query_params, "related_artist")
        primary_filter_requested = _request_flag(
            (query_params or {}).get("primary_filter")
        )
        selected_artist_family_filter_state = _derive_selected_artist_family_filter_state(
            family_artists=family_artists,
            requested_related_artists=requested_related_artists,
            requested_primary_filter=primary_filter_requested,
        )
        family_artists = list(selected_artist_family_filter_state["family_artists"])
        related_filter_artists = list(
            selected_artist_family_filter_state["related_filter_artists"]
        )
        primary_filter_active = bool(
            selected_artist_family_filter_state["primary_filter_active"]
        )
        renderable_family_artist_keys = {
            _selected_artist_family_group_filter_key(
                group,
                family_context["alias_to_canonical"],
                family_artists,
            )
            for group in family_artist_groups
            if _selected_artist_family_group_filter_key(
                group,
                family_context["alias_to_canonical"],
                family_artists,
            )
        }
        family_artists = [
            artist
            for artist in family_artists
            if _artist_display_dedupe_key(artist) in renderable_family_artist_keys
        ]
        related_filter_artists = [
            artist
            for artist in related_filter_artists
            if _artist_display_dedupe_key(artist) in renderable_family_artist_keys
        ]
        visible_family_artist_keys = {
            _artist_display_dedupe_key(artist)
            for artist in (
                related_filter_artists if related_filter_artists else family_artists
            )
            if _artist_display_dedupe_key(artist)
        }
        if primary_filter_active and not related_filter_artists:
            visible_family_artist_keys = set()
        if related_filter_artists and not primary_filter_active:
            primary_artist_groups = []
        family_artist_groups = [
            group
            for group in family_artist_groups
            if _selected_artist_family_group_filter_key(
                group,
                family_context["alias_to_canonical"],
                family_artists,
            )
            in visible_family_artist_keys
        ]
        artist_groups = (
            _render_selected_artist_artist_groups(
                primary_artist_groups,
                family_artist_groups,
                family_display_mode=_selected_artist_family_display_mode(query_params),
            )
            if not use_preview_albums
            else []
        )
        search_sidebar_artist_groups: list[dict[str, object]] = []
        if query and not omit_sidebar:
            search_sidebar_artist_groups = (
                list(_search_sidebar_artist_groups)
                if _search_sidebar_artist_groups is not None
                else _search_artist_groups(
                    _canonicalize_artist_rows(
                        self._load_search_rows(
                            query,
                            view_state,
                            connection=_connection,
                        ),
                        alias_to_canonical,
                    ),
                    query=query,
                )
            )
        self._apply_private_album_rating_overlays(
            _album_payloads_from_groups(
                [
                    *artist_groups,
                    *reusable_primary_artist_groups,
                    *sidebar_family_artist_groups,
                ]
            ),
            source_rows=[*rows, *family_preview_rows],
            connection=_connection,
            ensure_gallery_summary=use_preview_albums,
        )
        selected_artist_family_filters = _selected_artist_family_filter_payloads(
            artist_display,
            family_artists,
            family_context["alias_to_canonical"],
            family_context["canonical_to_aliases"],
        )
        artist_page = _build_artist_page_seam(
            artist_display,
            page_mode=(query_params or {}).get("page_mode"),
            family_display_mode=(query_params or {}).get("family_display")
            or (query_params or {}).get("selected_artist_family_display_mode"),
            gallery_display_mode=view_state["gallery_display_mode"],
            gallery_scale_percent=view_state["gallery_scale_percent"],
            timeline_at=(query_params or {}).get("timeline_at"),
        )
        artist_page["gallery_payload"] = _build_artist_page_gallery_payload(artist_display)
        playback_context = None if use_preview_albums else _selected_artist_playback_context(albums)
        search_filters = _build_search_filter_state()
        payload = {
            "surface": _build_view_surface_payload("albums"),
            "shell_layout": _build_shell_layout_payload(
                active_surface="albums",
                selected_artist=artist_display,
                local_tree_submode="",
            ),
            "artist_groups": artist_groups,
            "primary_artist_groups": primary_artist_groups,
            "family_artist_groups": family_artist_groups,
            "related_filter_base_primary_groups": reusable_primary_artist_groups,
            "related_filter_base_family_groups": sidebar_family_artist_groups,
            "related_artists": family_artists,
            "artist_family_filters": selected_artist_family_filters,
            "album_count": (
                len(_selected_artist_included_album_payloads(primary_artist_groups, family_artist_groups))
                if artist_display
                else len(albums)
            ),
            "artist_count": len(_selected_artist_visible_artist_names(primary_artist_groups, family_artist_groups)),
            "query": query,
            "search_filters": search_filters,
            "search_filter_contract": _build_search_filter_contract(),
            "search_query_contract": _build_search_query_contract(),
            "selected_artist": artist_display,
            "all_artists_active": False,
            "show_all_artists_sidebar_link": True,
            "related_filter_artists": related_filter_artists,
            "primary_filter_active": primary_filter_active,
            "gallery_scope": view_state["gallery_scope"],
            "gallery_display_mode": view_state["gallery_display_mode"],
            "gallery_scale_percent": view_state["gallery_scale_percent"],
            "local_tree_submode": "",
            "visible_library_categories": view_state["visible_library_categories"],
            "music_dir": str(self._config_value("MUSIC_DIR")),
            "app_name": str(self._config_value("APP_NAME", "Album Haven")),
            "app_version": str(self._config_value("APP_VERSION", RELEASE_VERSION)),
            "ignored_version_keys": support_state["ignored_version_keys"],
            "manual_version_links": support_state["manual_version_links"],
            "non_album_tracks": non_album_tracks,
            "non_album_exception_values": sorted(set(NON_ALBUM_EXCEPTION_VALUES.values())),
            "listen_through_scope_candidates": _selected_artist_listen_through_scope_candidates(
                selected_artist=artist_display,
                primary_artist_groups=primary_artist_groups,
                family_artist_groups=family_artist_groups,
                selected_artist_family_filters=selected_artist_family_filters,
            ) if artist_display else {},
            **({"playback_context": playback_context} if playback_context else {}),
            "viewer_opinion_preferences": build_viewer_opinion_preferences_payload({}),
            "popularity_browse": build_popularity_browse_payload(viewer_opinion_preferences={}),
            "selected_artist_family_display_mode": _selected_artist_family_display_mode(query_params),
            "artist_page": artist_page,
            "payload_tier": "full",
            "persistence_backend": PERSISTENCE_BACKEND_POSTGRES,
            "persistence_seam": _LIBRARY_BROWSE_SEAM_ID,
            "view_data_source": _SOURCE_TELEMETRY,
        }
        search_context = _build_legacy_search_context(
            committed_query=query,
            selected_artist=artist_display,
            requested_artist=str((query_params or {}).get("artist") or "").strip(),
            requested_all_artists=False,
            direct_match_artists=[artist_display] if artist_display else [],
            related_match_artists=[],
            search_filters=search_filters,
        )
        if search_context is not None:
            payload["search_context"] = search_context
        if query and not omit_sidebar:
            rendered_selected_family_groups = _render_selected_artist_artist_groups(
                primary_artist_groups,
                sidebar_family_artist_groups,
                family_display_mode=_selected_artist_family_display_mode(query_params),
            )
            sidebar_groups = _merge_artist_groups_for_sidebar(
                rendered_selected_family_groups,
                search_sidebar_artist_groups,
            )
            payload["artists_sidebar"] = _artists_sidebar_from_groups(sidebar_groups)
            payload["artist_count"] = len(sidebar_groups)
            selected_family_keys = {
                _artist_display_dedupe_key(str(group.get("artist") or "").strip())
                for group in rendered_selected_family_groups
                if str(group.get("artist") or "").strip()
            }
            payload["show_all_artists_sidebar_link"] = any(
                _artist_display_dedupe_key(str(group.get("artist") or "").strip())
                not in selected_family_keys
                for group in sidebar_groups
                if str(group.get("artist") or "").strip()
            )
            if _search_sidebar_artist_groups is None:
                _queue_display_cover_variants_for_groups(
                    self._config,
                    [
                        group
                        for group in search_sidebar_artist_groups
                        if _artist_display_dedupe_key(
                            str(group.get("artist") or "").strip()
                        )
                        not in selected_family_keys
                    ],
                    limit=_SEARCH_ALL_ARTISTS_DISPLAY_COVER_QUEUE_LIMIT,
                )
        _queue_display_cover_variants_for_groups(
            self._config,
            (
                [*primary_artist_groups, *sidebar_family_artist_groups]
                if query
                else artist_groups if artist_groups else [*primary_artist_groups, *family_artist_groups]
            ),
        )
        self.queue_settings_projection_prewarm()
        return payload

    def build_album_detail_payload(
        self,
        album_key: object,
        *,
        client_surface_class: object = None,
    ) -> dict[str, object] | None:
        normalized_album_key = str(album_key or "").strip()
        if not normalized_album_key:
            return None
        rows = self._load_album_detail_rows(normalized_album_key)
        if not rows:
            return None
        first_row_payload = _row_mapping(rows[0])
        metadata = _row_json_mapping(first_row_payload.get("album_metadata"))
        artist_display = str(
            metadata.get("album_artist")
            or first_row_payload.get("artist_name")
            or ""
        ).strip()
        albums = _selected_artist_album_payloads(rows, artist_display)
        detail_album = next(
            (
                album
                for album in albums
                if str(album.get("key") or album.get("album_ref") or "").strip() == normalized_album_key
            ),
            None,
        )
        if detail_album is None:
            return None
        detail_album["album_id"] = first_row_payload.get("album_id")
        detail_album["cover_candidate_snapshot"] = _cover_candidate_snapshot_summary(
            first_row_payload.get("cover_candidate_snapshot")
        )
        self._apply_private_album_rating_overlays(
            [detail_album],
            source_rows=rows,
        )
        _annotate_album_payload_problematic_tracks([detail_album], rows)
        from music_app.services.album_details import _attach_album_detail_track_rows

        return _attach_album_detail_track_rows(
            detail_album,
            client_surface_class=client_surface_class,
            config=None,
            viewer_opinion_preferences={},
        )

    def build_non_album_detail_payload(
        self,
        album_key: object,
        *,
        client_surface_class: object = None,
    ) -> dict[str, object] | None:
        normalized_album_key = str(album_key or "").strip()
        if not normalized_album_key.startswith("non-album::"):
            return None
        relation_alias_maps = self._load_relation_alias_maps()
        rows = self._inventory_repository.load_non_album_candidates(
            limit=MAX_NON_ALBUM_CANDIDATE_LIMIT,
        )
        entries = _non_album_entries_from_inventory_candidates(
            rows,
            visible_library_categories=[],
            alias_to_canonical=relation_alias_maps["alias_to_canonical"],
            canonical_to_aliases=relation_alias_maps["canonical_to_aliases"],
        )
        from music_app.services.album_details import _attach_album_detail_track_rows

        for group in build_non_album_album_groups(entries):
            for album in list(group.get("albums") or []):
                if str(album.get("key") or "").strip() != normalized_album_key:
                    continue
                return _attach_album_detail_track_rows(
                    dict(album),
                    client_surface_class=client_surface_class,
                    config=self._config,
                    viewer_opinion_preferences={},
                )
        return None

    def build_root_album_browse_payload(
        self,
        *,
        query_params: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        view_state = _root_sidebar_view_state(query_params)
        omit_sidebar = _request_flag((query_params or {}).get("omit_sidebar"))
        relation_alias_maps = self._load_relation_alias_maps()
        root_alias_to_canonical = _root_browse_alias_to_canonical(
            relation_alias_maps["alias_to_canonical"]
        )
        support_state = self._inventory_repository.load_support_state()
        rows = _canonicalize_artist_rows(
            self._load_root_album_browse_rows(view_state),
            root_alias_to_canonical,
        )
        artist_groups = _root_album_browse_artist_groups(rows)
        self._apply_private_album_rating_overlays(
            _album_payloads_from_groups(artist_groups),
            source_rows=rows,
        )
        album_count = len(_album_identity_set(rows))
        non_album_entries = self._load_non_album_entries(
            view_state=view_state,
            alias_to_canonical=relation_alias_maps["alias_to_canonical"],
            canonical_to_aliases=relation_alias_maps["canonical_to_aliases"],
        )
        non_album_tracks = build_non_album_track_list(
            non_album_entries,
            config=self._config,
        )
        payload = {
            "surface": _build_view_surface_payload("albums"),
            "shell_layout": _build_shell_layout_payload(
                active_surface="albums",
                selected_artist="",
                local_tree_submode="",
            ),
            "artist_groups": artist_groups,
            "primary_artist_groups": [],
            "family_artist_groups": [],
            "related_artists": [],
            "artist_family_filters": [],
            "album_count": album_count,
            "artist_count": len(artist_groups),
            "query": "",
            "search_filters": _build_search_filter_state(),
            "search_filter_contract": _build_search_filter_contract(),
            "search_query_contract": _build_search_query_contract(),
            "selected_artist": "",
            "all_artists_active": False,
            "show_all_artists_sidebar_link": True,
            "related_filter_artists": [],
            "primary_filter_active": False,
            "gallery_scope": view_state["gallery_scope"],
            "gallery_display_mode": view_state["gallery_display_mode"],
            "gallery_scale_percent": view_state["gallery_scale_percent"],
            "local_tree_submode": "",
            "visible_library_categories": view_state["visible_library_categories"],
            "music_dir": str(self._config_value("MUSIC_DIR")),
            "app_name": str(self._config_value("APP_NAME", "Album Haven")),
            "app_version": str(self._config_value("APP_VERSION", RELEASE_VERSION)),
            "ignored_version_keys": support_state["ignored_version_keys"],
            "manual_version_links": support_state["manual_version_links"],
            "non_album_tracks": non_album_tracks,
            "non_album_exception_values": sorted(set(NON_ALBUM_EXCEPTION_VALUES.values())),
            "listen_through_scope_candidates": {},
            "viewer_opinion_preferences": build_viewer_opinion_preferences_payload({}),
            "popularity_browse": build_popularity_browse_payload(viewer_opinion_preferences={}),
            "payload_tier": "full",
            "persistence_backend": PERSISTENCE_BACKEND_POSTGRES,
            "persistence_seam": _LIBRARY_BROWSE_SEAM_ID,
            "view_data_source": _SOURCE_TELEMETRY,
        }
        if not omit_sidebar:
            payload["artists_sidebar"] = _artists_sidebar_from_groups(artist_groups)
        _queue_display_cover_variants_for_groups(
            self._config,
            artist_groups,
        )
        self.queue_settings_projection_prewarm()
        return payload

    def build_search_payload(
        self,
        *,
        query_params: Mapping[str, object] | None = None,
        library_state: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        with self._connect_to_database() as connection:
            connection.execute(
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
            )
            return self._build_search_payload_from_snapshot(
                query_params=query_params,
                library_state=library_state,
                connection=connection,
            )

    def _build_search_payload_from_snapshot(
        self,
        *,
        query_params: Mapping[str, object] | None = None,
        library_state: Mapping[str, object] | None = None,
        connection: Any,
    ) -> dict[str, object]:
        params = query_params or {}
        view_state = _root_sidebar_view_state(params)
        query = str(params.get("q") or "").strip()
        requested_all_artists = _request_flag(params.get("all_artists"))
        omit_sidebar = _request_flag(params.get("omit_sidebar"))
        relation_alias_maps = self._load_relation_alias_maps(connection=connection)
        alias_to_canonical = relation_alias_maps["alias_to_canonical"]
        canonical_to_aliases = relation_alias_maps["canonical_to_aliases"]
        projection_is_current = (
            "projection_stale_reason" in relation_alias_maps
            and not str(relation_alias_maps.get("projection_stale_reason") or "")
        )
        exact_artist_match = ""
        if query and not requested_all_artists:
            if projection_is_current:
                exact_artist_match = _exact_projected_artist_match(
                    query,
                    alias_to_canonical,
                    canonical_to_aliases,
                )
            else:
                exact_artist_match = self._load_exact_artist_match(
                    query,
                    view_state,
                    connection=connection,
                )
        if exact_artist_match:
            sidebar_artist_groups = []
            selected_artist_preview_rows = None
            if not omit_sidebar:
                exact_artist_scope = _expanded_artist_names(
                    exact_artist_match,
                    alias_to_canonical,
                    canonical_to_aliases,
                )
                search_rows = (
                    self._load_search_rows(
                        query,
                        view_state,
                        connection=connection,
                    )
                    if any(character.isalnum() for character in query)
                    else self._load_artist_preview_rows(
                        _expanded_artist_name_list(
                            exact_artist_scope,
                            alias_to_canonical,
                            canonical_to_aliases,
                        ),
                        view_state,
                        connection=connection,
                    )
                )
                canonical_search_rows = _canonicalize_artist_rows(
                    search_rows,
                    alias_to_canonical,
                )
                sidebar_artist_groups = _search_artist_groups(
                    canonical_search_rows,
                    query=query,
                )
                if len(exact_artist_scope) == 1:
                    exact_artist_key = local_inventory_identity_key(exact_artist_match)
                    selected_artist_preview_rows = [
                        row
                        for row in canonical_search_rows
                        if local_inventory_identity_key(
                            str(_row_mapping(row).get("artist_name") or "")
                        )
                        == exact_artist_key
                    ] or None
            delegated_params = _clone_query_params_mapping(params)
            delegated_params["artist"] = exact_artist_match
            if "surface" not in delegated_params:
                delegated_params["surface"] = "albums"
            payload = self.build_selected_artist_payload(
                query_params=delegated_params,
                library_state=library_state,
                _relation_alias_maps=relation_alias_maps,
                _search_sidebar_artist_groups=sidebar_artist_groups,
                _selected_artist_preview_rows=selected_artist_preview_rows,
                _connection=connection,
            )
            search_context = payload.get("search_context")
            if isinstance(search_context, dict):
                search_context["selected_artist_source"] = "auto_top_match"
            primary_artist_groups = list(payload.get("primary_artist_groups") or [])
            family_artist_groups = list(payload.get("family_artist_groups") or [])
            has_complete_selected_family_groups = (
                "related_filter_base_primary_groups" in payload
                and "related_filter_base_family_groups" in payload
            )
            complete_selected_family_groups = [
                *list(payload.get("related_filter_base_primary_groups") or []),
                *list(payload.get("related_filter_base_family_groups") or []),
            ]
            complete_selected_family_keys = {
                _artist_display_dedupe_key(str(group.get("artist") or "").strip())
                for group in complete_selected_family_groups
                if str(group.get("artist") or "").strip()
            }
            search_matches_outside_selected_family = (
                has_complete_selected_family_groups
                and any(
                    _artist_display_dedupe_key(
                        str(group.get("artist") or "").strip()
                    )
                    not in complete_selected_family_keys
                    for group in sidebar_artist_groups
                    if str(group.get("artist") or "").strip()
                )
            )
            if search_matches_outside_selected_family:
                family_artist_groups = []
                payload["family_artist_groups"] = []
            rendered_artist_groups = _render_selected_artist_artist_groups(
                primary_artist_groups,
                family_artist_groups,
                family_display_mode=_selected_artist_family_display_mode(query_params),
            )
            payload["artist_groups"] = rendered_artist_groups
            if not omit_sidebar:
                sidebar_groups = _merge_artist_groups_for_sidebar(
                    rendered_artist_groups,
                    sidebar_artist_groups,
                )
                payload["artists_sidebar"] = _artists_sidebar_from_groups(
                    sidebar_groups
                )
                payload["artist_count"] = len(sidebar_groups)
                selected_family_keys = {
                    _artist_display_dedupe_key(str(group.get("artist") or "").strip())
                    for group in rendered_artist_groups
                    if str(group.get("artist") or "").strip()
                }
                payload["show_all_artists_sidebar_link"] = any(
                    _artist_display_dedupe_key(str(group.get("artist") or "").strip())
                    not in selected_family_keys
                    for group in sidebar_groups
                    if str(group.get("artist") or "").strip()
                )
                _queue_display_cover_variants_for_groups(
                    self._config,
                    sidebar_artist_groups,
                    limit=_SEARCH_ALL_ARTISTS_DISPLAY_COVER_QUEUE_LIMIT,
                )
            return payload
        support_state = self._inventory_repository.load_support_state(
            connection=connection,
        )
        rows = _canonicalize_artist_rows(
            self._load_search_rows(query, view_state, connection=connection),
            alias_to_canonical,
        )
        artist_groups = _search_artist_groups(rows, query=query)
        _queue_display_cover_variants_for_groups(
            self._config,
            artist_groups,
            limit=1,
            priority="interactive",
        )
        selected_artist = "" if requested_all_artists else _top_search_selected_artist(artist_groups, query=query)
        family_context = _selected_artist_family_context_from_state(
            selected_artist,
            config=self._config,
            connect=self._connect,
            alias_to_canonical=alias_to_canonical,
            canonical_to_aliases=canonical_to_aliases,
            connection=connection,
        ) if selected_artist else {
            "family_artists": [],
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
        }
        family_artists = list(family_context["family_artists"])
        family_preview_rows = (
            self._load_artist_preview_rows(
                _expanded_artist_name_list(
                    family_artists,
                    alias_to_canonical,
                    canonical_to_aliases,
                ),
                view_state,
                connection=connection,
            )
            if selected_artist and family_artists
            else []
        )
        primary_artist_groups = (
            _selected_artist_groups_from_existing_groups(
                selected_artist,
                artist_groups,
                alias_to_canonical=family_context["alias_to_canonical"],
                canonical_to_aliases=family_context["canonical_to_aliases"],
            )
            if selected_artist and not requested_all_artists
            else []
        )
        family_artist_groups = (
            _selected_artist_family_groups_from_preview_rows(
                family_artists,
                family_preview_rows,
                alias_to_canonical=family_context["alias_to_canonical"],
                canonical_to_aliases=family_context["canonical_to_aliases"],
            )
            if selected_artist and not requested_all_artists
            else []
        )
        selected_artist_family_filters = (
            _selected_artist_family_filter_payloads(
                selected_artist,
                family_artists,
                family_context["alias_to_canonical"],
                family_context["canonical_to_aliases"],
            )
            if selected_artist and not requested_all_artists
            else []
        )
        rendered_artist_groups = (
            _render_selected_artist_artist_groups(
                primary_artist_groups,
                family_artist_groups,
                family_display_mode=_selected_artist_family_display_mode(query_params),
            )
            if selected_artist and not requested_all_artists
            else artist_groups
        )
        self._apply_private_album_rating_overlays(
            _album_payloads_from_groups(
                [*rendered_artist_groups, *primary_artist_groups, *family_artist_groups]
            ),
            source_rows=[*rows, *family_preview_rows],
            connection=connection,
            ensure_gallery_summary=True,
        )
        non_album_scope_artists = (
            _expanded_artist_name_list(
                [selected_artist, *family_artists],
                family_context["alias_to_canonical"],
                family_context["canonical_to_aliases"],
            )
            if selected_artist and not requested_all_artists
            else [
                str(group.get("artist") or "").strip()
                for group in artist_groups
                if str(group.get("artist") or "").strip()
            ]
        )
        non_album_entries = self._load_non_album_entries(
            view_state=view_state,
            alias_to_canonical=(
                family_context["alias_to_canonical"]
                if selected_artist and not requested_all_artists
                else alias_to_canonical
            ),
            canonical_to_aliases=(
                family_context["canonical_to_aliases"]
                if selected_artist and not requested_all_artists
                else canonical_to_aliases
            ),
            visible_artist_names=non_album_scope_artists,
            query=query,
            connection=connection,
        )
        non_album_tracks = build_non_album_track_list(
            non_album_entries,
            config=self._config,
        )
        direct_match_artists = [str(group.get("artist") or "").strip() for group in artist_groups]
        album_count = (
            len(_selected_artist_included_album_payloads(primary_artist_groups, family_artist_groups))
            if selected_artist and not requested_all_artists
            else sum(len(group.get("albums") or []) for group in artist_groups)
        )
        search_filters = _build_search_filter_state()
        search_context = _build_legacy_search_context(
            committed_query=query,
            selected_artist=selected_artist,
            requested_artist="",
            requested_all_artists=requested_all_artists,
            direct_match_artists=direct_match_artists,
            related_match_artists=[],
            search_filters=search_filters,
        )
        selected_family_keys = {
            _artist_display_dedupe_key(str(family_artist or "").strip())
            for family_artist in [selected_artist, *family_artists]
            if str(family_artist or "").strip()
        }
        payload = {
            "surface": _build_view_surface_payload("albums"),
            "shell_layout": _build_shell_layout_payload(
                active_surface="albums",
                selected_artist=selected_artist,
                local_tree_submode="",
            ),
            "artist_groups": rendered_artist_groups,
            "primary_artist_groups": primary_artist_groups,
            "family_artist_groups": family_artist_groups,
            "related_artists": family_artists,
            "artist_family_filters": selected_artist_family_filters,
            "album_count": album_count,
            "artist_count": (
                len(_selected_artist_visible_artist_names(primary_artist_groups, family_artist_groups))
                if selected_artist and not requested_all_artists
                else len(artist_groups)
            ),
            "query": query,
            "search_filters": search_filters,
            "search_filter_contract": _build_search_filter_contract(),
            "search_query_contract": _build_search_query_contract(),
            "selected_artist": selected_artist,
            "all_artists_active": requested_all_artists and not selected_artist,
            "show_all_artists_sidebar_link": (
                requested_all_artists
                or not selected_artist
                or any(
                    _artist_display_dedupe_key(str(group.get("artist") or "").strip())
                    not in selected_family_keys
                    for group in artist_groups
                    if str(group.get("artist") or "").strip()
                )
            ),
            "related_filter_artists": [],
            "primary_filter_active": False,
            "gallery_scope": view_state["gallery_scope"],
            "gallery_display_mode": view_state["gallery_display_mode"],
            "gallery_scale_percent": view_state["gallery_scale_percent"],
            "local_tree_submode": "",
            "visible_library_categories": view_state["visible_library_categories"],
            "music_dir": str(self._config_value("MUSIC_DIR")),
            "app_name": str(self._config_value("APP_NAME", "Album Haven")),
            "app_version": str(self._config_value("APP_VERSION", RELEASE_VERSION)),
            "ignored_version_keys": support_state["ignored_version_keys"],
            "manual_version_links": support_state["manual_version_links"],
            "non_album_tracks": non_album_tracks,
            "non_album_exception_values": sorted(set(NON_ALBUM_EXCEPTION_VALUES.values())),
            "listen_through_scope_candidates": (
                _selected_artist_listen_through_scope_candidates(
                    selected_artist=selected_artist,
                    primary_artist_groups=primary_artist_groups,
                    family_artist_groups=family_artist_groups,
                    selected_artist_family_filters=selected_artist_family_filters,
                )
                if selected_artist and not requested_all_artists
                else {}
            ),
            "viewer_opinion_preferences": build_viewer_opinion_preferences_payload({}),
            "popularity_browse": build_popularity_browse_payload(viewer_opinion_preferences={}),
            **(
                {"selected_artist_family_display_mode": _selected_artist_family_display_mode(query_params)}
                if selected_artist else {}
            ),
            "payload_tier": "full",
            "persistence_backend": PERSISTENCE_BACKEND_POSTGRES,
            "persistence_seam": _LIBRARY_BROWSE_SEAM_ID,
            "view_data_source": _SOURCE_TELEMETRY,
        }
        if search_context is not None:
            payload["search_context"] = search_context
        if not omit_sidebar:
            sidebar_groups = (
                _merge_artist_groups_for_sidebar(
                    rendered_artist_groups,
                    artist_groups,
                )
                if selected_artist and not requested_all_artists
                else artist_groups
            )
            payload["artists_sidebar"] = _artists_sidebar_from_groups(
                sidebar_groups
            )
            payload["artist_count"] = len(sidebar_groups)
        _queue_display_cover_variants_for_groups(
            self._config,
            rendered_artist_groups if selected_artist and not requested_all_artists else artist_groups,
        )
        self.queue_settings_projection_prewarm()
        return payload

    def build_problematic_files_payload(self) -> dict[str, object]:
        kind = "problematic-files"
        while True:
            cached_payload = self._get_cached_utility_projection(kind)
            if cached_payload is not None:
                cached_payload["projection_cache_status"] = "hit"
                return cached_payload
            cache_key = self._utility_projection_cache_key(kind)
            if cache_key is None:
                payload = self._build_problematic_files_payload_uncached()
                payload["projection_cache_status"] = "rebuilt"
                return payload
            with _UTILITY_PROJECTION_CACHE_LOCK:
                flight = _UTILITY_PROJECTION_SINGLEFLIGHT.get(cache_key)
                if flight is None:
                    flight = Event()
                    _UTILITY_PROJECTION_SINGLEFLIGHT[cache_key] = flight
                    generation = _UTILITY_PROJECTION_GENERATIONS.setdefault(cache_key, 0)
                    leader = True
                else:
                    leader = False
            if leader:
                break
            flight.wait()
        try:
            payload = self._build_problematic_files_payload_uncached()
            self._set_cached_utility_projection(kind, payload, expected_generation=generation)
            payload["projection_cache_status"] = "rebuilt"
            return payload
        finally:
            with _UTILITY_PROJECTION_CACHE_LOCK:
                if _UTILITY_PROJECTION_SINGLEFLIGHT.get(cache_key) is flight:
                    _UTILITY_PROJECTION_SINGLEFLIGHT.pop(cache_key, None)
                    flight.set()

    def _build_problematic_files_payload_uncached(self) -> dict[str, object]:
        with self._connect_to_database() as connection:
            connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            connection.execute("SET LOCAL work_mem = '16MB'")
            connection.execute("SET LOCAL jit = off")
            projected_items = [
                (item, album)
                for album in _problematic_album_projection_payloads(
                    self._load_problematic_file_rows(connection=connection)
                )
                if (item := _problematic_album_summary_payload(album)) is not None
            ]
            projected_items.sort(
                key=lambda projected_item: (
                    str(projected_item[0].get("name") or "").casefold(),
                    str(projected_item[0].get("album_artist") or "").casefold(),
                    str(projected_item[0].get("year") or ""),
                )
            )
            items = [item for item, _album in projected_items]
            initial_detail = None
            if projected_items:
                first_album = projected_items[0][1]
                first_key = str(first_album.get("key") or "")
                initial_detail = _problematic_album_detail_payload(first_album)
                if initial_detail is None:
                    raise RuntimeError(
                        "Problematic Files summary/detail snapshot invariant failed for "
                        f"album {first_key!r}."
                    )
        return {
            "items": items,
            "initial_detail": initial_detail,
            "count": len(items),
            "persistence_backend": PERSISTENCE_BACKEND_POSTGRES,
            "persistence_seam": _LIBRARY_BROWSE_SEAM_ID,
            "view_data_source": _SOURCE_TELEMETRY,
        }

    def build_problematic_album_payload_by_track_paths(
        self,
        track_paths: set[str],
    ) -> dict[str, object] | None:
        normalized_paths = _normalized_track_paths(track_paths)
        if not normalized_paths:
            return None
        albums = _problematic_album_projection_payloads(
            self._load_problematic_file_rows(candidate_summary=False)
        )
        for album in albums:
            album_track_paths = {
                str(track.get("path") or "").strip()
                for track in list(album.get("tracks") or [])
                if isinstance(track, Mapping)
            }
            if album_track_paths & normalized_paths:
                return _problematic_album_detail_payload(album)
        return None

    def build_problematic_file_detail_payload(self, album_key: object) -> dict[str, object] | None:
        albums = _problematic_album_projection_payloads(
            self._load_problematic_file_rows(album_key=str(album_key or ""))
        )
        requested_keys = set(_problematic_album_key_candidates(str(album_key or "")))
        for album in albums:
            if str(album.get("key") or "") not in requested_keys:
                continue
            return _problematic_album_detail_payload(album)
        return None

    def build_album_payloads_by_track_paths(self, track_paths: set[str]) -> list[dict[str, object]]:
        normalized_paths = _normalized_track_paths(track_paths)
        if not normalized_paths:
            return []
        rows = self._load_album_rows_by_track_paths(normalized_paths)
        rows_by_artist: dict[str, list[object]] = {}
        for row in rows:
            artist_display = str(_row_mapping(row).get("artist_name") or "").strip()
            rows_by_artist.setdefault(artist_display, []).append(row)
        albums: list[dict[str, object]] = []
        for artist_display in sorted(rows_by_artist, key=lambda value: value.casefold()):
            albums.extend(_selected_artist_album_payloads(rows_by_artist[artist_display], artist_display))
        affected_albums = [
            album
            for album in albums
            if _album_payload_track_paths(album) & normalized_paths
        ]
        _annotate_album_payload_problematic_tracks(affected_albums, rows)
        return affected_albums

    def build_track_file_entries_by_paths(
        self,
        track_paths: set[str],
    ) -> dict[str, dict[str, object]]:
        normalized_paths = _normalized_track_paths(track_paths)
        if not normalized_paths:
            return {}
        entries: dict[str, dict[str, object]] = {}
        for row in self._load_album_rows_by_track_paths(normalized_paths):
            row_payload = _row_mapping(row)
            path = str(row_payload.get("file_private_path") or "").strip()
            if path not in normalized_paths:
                continue
            file_entry = dict(_row_json_mapping(row_payload.get("file_entry")))
            file_entry.update(
                {
                    "album_id": row_payload.get("album_id"),
                    "path": path,
                    "title": str(
                        _first_inventory_value(
                            row_payload.get("track_title"),
                            file_entry.get("title"),
                            "",
                        )
                        or ""
                    ).strip(),
                    "album": str(
                        _first_inventory_value(
                            row_payload.get("album_title"),
                            file_entry.get("album"),
                            "",
                        )
                        or ""
                    ).strip(),
                    "album_artist": str(
                        _first_inventory_value(
                            _row_json_mapping(
                                row_payload.get("album_metadata")
                            ).get("album_artist"),
                            file_entry.get("album_artist"),
                            row_payload.get("artist_name"),
                            "",
                        )
                        or ""
                    ).strip(),
                    "exception_type": normalize_exception_value(
                        row_payload.get("exception_type")
                        if "exception_type" in row_payload
                        else file_entry.get("exception_type")
                    ),
                }
            )
            entries[path] = file_entry
        unresolved_paths = normalized_paths - set(entries)
        if unresolved_paths:
            for row in self._inventory_repository.load_non_album_candidates(
                private_paths=unresolved_paths,
                limit=len(unresolved_paths),
            ):
                file_entry = _non_album_entry_from_inventory_candidate(row)
                path = str(file_entry.get("path") or "").strip()
                if path in unresolved_paths:
                    entries[path] = file_entry
        return entries

    def build_utility_rules_payload(self) -> dict[str, object]:
        kind = "rules"
        cached_payload = self._get_cached_utility_projection(kind)
        if cached_payload is not None:
            return cached_payload
        with _UTILITY_PROJECTION_CACHE_LOCK:
            cache_key = self._utility_projection_cache_key(kind)
            generation = (
                _UTILITY_PROJECTION_GENERATIONS.setdefault(cache_key, 0)
                if cache_key is not None
                else None
            )
        payload = _utility_rules_projection_payload(self._load_utility_rules_rows())
        self._set_cached_utility_projection(kind, payload, expected_generation=generation)
        return deepcopy(payload)

    def resolve_problem_exclusion_items(
        self,
        items: Iterable[object],
    ) -> list[dict[str, object]]:
        requested_items = tuple(items)
        album_keys = sorted({
            str(getattr(item, "album_key", "") or "").strip()
            for item in requested_items
            if str(getattr(item, "album_key", "") or "").strip()
        })
        file_paths = sorted({
            str(getattr(item, "path", "") or "").strip()
            for item in requested_items
            if str(getattr(item, "path", "") or "").strip()
        })
        if not album_keys and not file_paths:
            return []

        with self._connect_to_database() as connection:
            cursor = connection.execute(
                _problem_exclusion_candidates_sql(),
                {"album_keys": album_keys, "file_paths": file_paths},
            )
            rows = list(cursor.fetchall())

        explicit_legacy_keys_by_album: dict[str, set[str]] = {}
        for row in rows:
            row_payload = _row_mapping(row)
            album_key = str(row_payload.get("album_key") or "").strip()
            explicit_legacy_keys_by_album.setdefault(album_key, set()).update(
                _row_string_list(row_payload.get("legacy_repair_keys"))
            )

        candidates_by_row_key: dict[str, dict[str, object]] = {}
        for row in rows:
            row_payload = _row_mapping(row)
            preprojected_row_key = str(
                row_payload.get("ignored_repair_key") or ""
            ).strip()
            if not preprojected_row_key:
                continue
            preprojected = _utility_problem_ignore_payload(row_payload)
            preprojected["album_key"] = str(
                row_payload.get("album_key") or ""
            ).strip()
            preprojected["legacy_row_keys"] = sorted(
                _row_string_list(row_payload.get("legacy_repair_keys"))
            )
            candidates_by_row_key[preprojected_row_key] = preprojected
        for album in _problematic_album_projection_payloads(rows):
            detail = _problematic_album_detail_payload(album)
            if detail is None:
                continue
            durable_album_key = str(
                album.get("_persisted_album_key") or album.get("key") or ""
            ).strip()
            common = {
                "album": str(detail.get("name") or "").strip(),
                "artist": str(detail.get("album_artist") or "").strip(),
                "year": str(detail.get("year") or ""),
                "album_group_key": " :: ".join(
                    value
                    for value in (
                        str(detail.get("album_artist") or "").strip(),
                        str(detail.get("name") or "").strip(),
                    )
                    if value
                ),
                "album_key": durable_album_key,
            }
            for problem_row in detail.get("album_problem_rows") or []:
                if not isinstance(problem_row, Mapping):
                    continue
                row_key = str(problem_row.get("row_key") or "").strip()
                reason = str(problem_row.get("reason") or "").strip()
                if not row_key or not reason:
                    continue
                candidates_by_row_key[row_key] = {
                    "row_key": row_key,
                    "scope": "album",
                    "path": "",
                    "filename": "",
                    "field": "problem-album",
                    **common,
                    "problem_reason": reason,
                    "legacy_row_keys": sorted(
                        explicit_legacy_keys_by_album.get(durable_album_key, set())
                        or _legacy_album_problem_row_keys(album, reason)
                    ),
                }
            for track_row in detail.get("track_problem_rows") or []:
                if not isinstance(track_row, Mapping):
                    continue
                for problem_row in track_row.get("ignorable_reasons") or []:
                    if not isinstance(problem_row, Mapping):
                        continue
                    row_key = str(problem_row.get("row_key") or "").strip()
                    path = str(problem_row.get("path") or "").strip()
                    reason = str(problem_row.get("reason") or "").strip()
                    if not row_key or not path or not reason:
                        continue
                    candidates_by_row_key[row_key] = {
                        "row_key": row_key,
                        "scope": "file",
                        "path": path,
                        "filename": str(track_row.get("filename") or Path(path).name),
                        "field": "problem-file",
                        **common,
                        "year": str(
                            next(
                                (
                                    entry.get("year")
                                    for entry in album.get("_file_entries") or []
                                    if isinstance(entry, Mapping)
                                    and str(entry.get("path") or "") == path
                                ),
                                detail.get("year") or "",
                            )
                            or ""
                        ),
                        "problem_reason": reason,
                        "legacy_row_keys": [],
                    }

        return [
            candidates_by_row_key[row_key]
            for item in requested_items
            if (row_key := str(getattr(item, "row_key", "") or "").strip())
            in candidates_by_row_key
        ]

    def _load_root_sidebar_rows(
        self,
        view_state: Mapping[str, object],
        *,
        connection: Any | None = None,
    ) -> list[object]:
        if connection is not None:
            cursor = connection.execute(_root_sidebar_sql(), _root_sidebar_params(view_state))
            return list(cursor.fetchall())
        with self._connect_to_database() as owned_connection:
            cursor = owned_connection.execute(
                _root_sidebar_sql(),
                _root_sidebar_params(view_state),
            )
            return list(cursor.fetchall())

    def _load_selected_artist_rows(
        self,
        selected_artists: list[str],
        view_state: Mapping[str, object],
        *,
        connection: Any | None = None,
    ) -> list[object]:
        params = {
            "artist_keys": [local_inventory_identity_key(artist) for artist in selected_artists],
            **_root_sidebar_params(view_state),
        }
        if connection is not None:
            cursor = connection.execute(_selected_artist_sql(), params)
            return list(cursor.fetchall())
        with self._connect_to_database() as owned_connection:
            cursor = owned_connection.execute(_selected_artist_sql(), params)
            return list(cursor.fetchall())

    def _load_selected_artist_preview_rows(
        self,
        selected_artists: list[str],
        view_state: Mapping[str, object],
        *,
        connection: Any | None = None,
    ) -> list[object]:
        params = {
            "artist_keys": [local_inventory_identity_key(artist) for artist in selected_artists],
            **_root_sidebar_params(view_state),
        }
        if connection is not None:
            cursor = connection.execute(_selected_artist_preview_sql(), params)
            return list(cursor.fetchall())
        with self._connect_to_database() as owned_connection:
            cursor = owned_connection.execute(_selected_artist_preview_sql(), params)
            return list(cursor.fetchall())

    def _load_artist_preview_rows(
        self,
        artists: list[str],
        view_state: Mapping[str, object],
        *,
        connection: Any | None = None,
    ) -> list[object]:
        normalized_artists = [str(artist or "").strip() for artist in artists if str(artist or "").strip()]
        if not normalized_artists:
            return []
        params = {
            "artist_names": normalized_artists,
            "artist_keys": [local_inventory_identity_key(artist) for artist in normalized_artists],
            **_root_sidebar_params(view_state),
        }
        if connection is not None:
            cursor = connection.execute(_artist_preview_rows_sql(), params)
            return list(cursor.fetchall())
        with self._connect_to_database() as owned_connection:
            cursor = owned_connection.execute(_artist_preview_rows_sql(), params)
            return list(cursor.fetchall())

    def _load_album_detail_rows(self, album_key: str) -> list[object]:
        with self._connect_to_database() as connection:
            cursor = connection.execute(_album_detail_sql(), {"album_key": album_key})
            return list(cursor.fetchall())

    def _load_root_album_browse_rows(self, view_state: Mapping[str, object]) -> list[object]:
        with self._connect_to_database() as connection:
            cursor = connection.execute(_root_album_browse_sql(), _root_sidebar_params(view_state))
            return list(cursor.fetchall())

    def _load_root_startup_rows(
        self,
        view_state: Mapping[str, object],
        alias_to_canonical: Mapping[str, object],
        *,
        connection: Any | None = None,
    ) -> tuple[list[object], list[object]]:
        params = {
            **_root_sidebar_params(view_state),
            "alias_to_canonical": json.dumps(
                dict(alias_to_canonical),
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        }

        def load_rows(active_connection: Any) -> tuple[list[object], list[object]]:
            cursor = active_connection.execute(
                _root_startup_payload_sql(_STARTUP_PREVIEW_ARTIST_LIMIT),
                params,
            )
            if callable(getattr(cursor, "fetchone", None)):
                row = cursor.fetchone()
            else:
                fetched = list(cursor.fetchall())
                row = fetched[0] if fetched else None
            payload = _row_mapping(row)
            return (
                list(payload.get("root_sidebar_rows") or []),
                list(payload.get("preview_rows") or []),
            )

        if connection is not None:
            return load_rows(connection)
        with self._connect_to_database() as owned_connection:
            return load_rows(owned_connection)

    def _load_search_rows(
        self,
        query: str,
        view_state: Mapping[str, object],
        *,
        connection: Any | None = None,
    ) -> list[object]:
        params = {
            "query_like": f"%{query}%",
            **_root_sidebar_params(view_state),
        }
        if connection is not None:
            cursor = connection.execute(_search_preview_sql(), params)
            return list(cursor.fetchall())
        with self._connect_to_database() as owned_connection:
            cursor = owned_connection.execute(_search_preview_sql(), params)
            return list(cursor.fetchall())

    def _load_exact_artist_match(
        self,
        query: str,
        view_state: Mapping[str, object],
        *,
        connection: Any | None = None,
    ) -> str:
        normalized_query = str(query or "").strip()
        if not normalized_query:
            return ""
        params = {
            "artist_name": normalized_query,
            "artist_key": local_inventory_identity_key(normalized_query),
            **_root_sidebar_params(view_state),
        }
        if connection is not None:
            cursor = connection.execute(_exact_artist_match_sql(), params)
            row = cursor.fetchone() if hasattr(cursor, "fetchone") else None
        else:
            with self._connect_to_database() as owned_connection:
                cursor = owned_connection.execute(
                _exact_artist_match_sql(),
                    params,
                )
                row = cursor.fetchone() if hasattr(cursor, "fetchone") else None
        return str(_row_mapping(row).get("artist_name") or "").strip() if row else ""

    def _load_relation_alias_maps(self, *, connection: Any | None = None) -> dict[str, object]:
        from music_app.services.relation_projection_postgres import (
            relation_projection_stale_reason,
        )

        if connection is not None:
            cursor = connection.execute(_relation_alias_maps_sql())
            if callable(getattr(cursor, "fetchone", None)):
                row = cursor.fetchone()
            elif callable(getattr(cursor, "fetchall", None)):
                rows = list(cursor.fetchall())
                row = rows[0] if rows else None
            else:
                row = None
        else:
            with self._connect_to_database() as owned_connection:
                cursor = owned_connection.execute(_relation_alias_maps_sql())
                if callable(getattr(cursor, "fetchone", None)):
                    row = cursor.fetchone()
                elif callable(getattr(cursor, "fetchall", None)):
                    rows = list(cursor.fetchall())
                    row = rows[0] if rows else None
                else:
                    row = None
        payload = _row_mapping(row)
        relation_views = _row_json_mapping(payload.get("relation_views"))
        relation_projection = _row_json_mapping(payload.get("relation_projection"))
        scan_cache = {
            "relation_views": relation_views,
            "relation_projection": relation_projection,
        }
        return {
            "alias_to_canonical": _row_json_mapping(
                relation_views.get("alias_to_canonical")
            ),
            "canonical_to_aliases": _row_json_mapping(
                relation_views.get("canonical_to_aliases")
            ),
            "projection_stale_reason": relation_projection_stale_reason(scan_cache),
        }

    def _load_album_rows_by_track_paths(self, track_paths: set[str]) -> list[object]:
        with self._connect_to_database() as connection:
            cursor = connection.execute(
                _album_rows_by_track_paths_sql(),
                {"track_paths": sorted(track_paths)},
            )
            return list(cursor.fetchall())

    def _load_problematic_file_rows(
        self,
        album_key: str | None = None,
        *,
        candidate_summary: bool = True,
        connection: Any | None = None,
    ) -> list[object]:
        normalized_album_key = str(album_key or "").strip() or None
        use_candidate_summary = candidate_summary and normalized_album_key is None
        candidate_params = {
            "mojibake_candidate_pattern": MOJIBAKE_CANDIDATE_PATTERN,
            "encoding_candidate_chars": MOJIBAKE_ENCODING_CANDIDATE_CHARS,
        }

        def load_rows(active_connection: Any) -> list[object]:
            if use_candidate_summary:
                cursor = active_connection.execute(
                    _problematic_files_sql(candidate_summary=True),
                    candidate_params,
                )
                return list(cursor.fetchall())
            cursor = active_connection.execute(
                _problematic_files_sql(),
                {"album_key": normalized_album_key},
            )
            return list(cursor.fetchall())

        if connection is not None:
            return load_rows(connection)
        with self._connect_to_database() as owned_connection:
            return load_rows(owned_connection)

    def _load_utility_rules_rows(self) -> list[object]:
        with self._connect_to_database() as connection:
            cursor = connection.execute(_utility_rules_sql(), {})
            return list(cursor.fetchall())

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres library browse.")
        return self._connect(self._database_url)

    def _config_value(self, key: str, default: object = "") -> object:
        return self._config.get(key, default)

    def _utility_projection_cache_key(self, kind: str) -> tuple[str, str] | None:
        if not self._database_url:
            return None
        normalized_kind = str(kind or "").strip()
        if not normalized_kind:
            return None
        return (self._database_url, normalized_kind)

    def _get_cached_utility_projection(self, kind: str) -> dict[str, object] | None:
        cache_key = self._utility_projection_cache_key(kind)
        if cache_key is None:
            return None
        with _UTILITY_PROJECTION_CACHE_LOCK:
            payload = _UTILITY_PROJECTION_CACHE.get(cache_key)
            return deepcopy(payload) if payload is not None else None

    def _set_cached_utility_projection(
        self,
        kind: str,
        payload: dict[str, object],
        *,
        expected_generation: int | None = None,
    ) -> None:
        cache_key = self._utility_projection_cache_key(kind)
        if cache_key is None:
            return
        with _UTILITY_PROJECTION_CACHE_LOCK:
            if (
                expected_generation is not None
                and _UTILITY_PROJECTION_GENERATIONS.get(cache_key, 0) != expected_generation
            ):
                return
            _UTILITY_PROJECTION_CACHE[cache_key] = deepcopy(payload)

    def queue_settings_projection_prewarm(self) -> None:
        if not self._allow_background_prewarm:
            return
        for kind in ("problematic-files", "rules"):
            self.queue_utility_projection_prewarm(kind)

    def queue_utility_projection_prewarm(self, kind: str) -> None:
        if not self._allow_background_prewarm:
            return
        cache_key = self._utility_projection_cache_key(kind)
        if cache_key is None:
            return
        with _UTILITY_PROJECTION_CACHE_LOCK:
            if cache_key in _UTILITY_PROJECTION_CACHE:
                return
            if cache_key in _UTILITY_PROJECTION_PREWARM_INFLIGHT:
                return
            _UTILITY_PROJECTION_PREWARM_INFLIGHT.add(cache_key)
        _UTILITY_PROJECTION_PREWARM_EXECUTOR.submit(self._run_utility_projection_prewarm, kind, cache_key)

    def _run_utility_projection_prewarm(self, kind: str, cache_key: tuple[str, str]) -> None:
        try:
            if kind == "problematic-files":
                self.build_problematic_files_payload()
            elif kind == "rules":
                self.build_utility_rules_payload()
        finally:
            with _UTILITY_PROJECTION_CACHE_LOCK:
                _UTILITY_PROJECTION_PREWARM_INFLIGHT.discard(cache_key)


def _first_inventory_value(*values: object) -> object:
    for value in values:
        if value is not None:
            return value
    return None


def _non_album_entry_from_inventory_candidate(row: object) -> dict[str, object]:
    payload = _row_mapping(row)
    file_entry = dict(_row_json_mapping(payload.get("file_entry")))
    track_metadata = _row_json_mapping(payload.get("track_metadata"))
    album_metadata = _row_json_mapping(payload.get("album_metadata"))
    entry = dict(file_entry)
    entry.update({
        "album_id": payload.get("album_id"),
        "path": str(
            _first_inventory_value(
                payload.get("private_path"),
                file_entry.get("path"),
                "",
            )
            or ""
        ),
        "artist": _first_inventory_value(
            payload.get("raw_file_artist"),
            file_entry.get("artist"),
            track_metadata.get("artist"),
            payload.get("artist_name"),
            "",
        ),
        "album_artist": _first_inventory_value(
            payload.get("raw_file_album_artist"),
            file_entry.get("album_artist"),
            payload.get("raw_track_album_artist"),
            payload.get("raw_album_artist"),
            album_metadata.get("album_artist"),
            payload.get("artist_name"),
            "",
        ),
        "album": _first_inventory_value(
            payload.get("raw_file_album"),
            file_entry.get("album"),
            payload.get("raw_track_album"),
            payload.get("album_title"),
            "",
        ),
        "title": _first_inventory_value(
            payload.get("raw_file_title"),
            file_entry.get("title"),
            payload.get("track_title"),
            "",
        ),
        "year": _first_inventory_value(
            file_entry.get("year"),
            track_metadata.get("year"),
            payload.get("album_release_year"),
        ),
        "edition": _first_inventory_value(
            file_entry.get("edition"),
            album_metadata.get("edition"),
            "",
        ),
        "track_number": _first_inventory_value(
            payload.get("track_number"),
            file_entry.get("track_number"),
        ),
        "disc_number": _first_inventory_value(
            payload.get("disc_number"),
            file_entry.get("disc_number"),
        ),
        "duration_seconds": _coerce_duration_seconds(
            _first_inventory_value(
                payload.get("duration_seconds"),
                file_entry.get("duration_seconds"),
            ),
        ),
        "cover_path": _first_inventory_value(
            payload.get("album_cover_path"),
            file_entry.get("cover_path"),
        ),
        "cover_revision": _first_inventory_value(
            album_metadata.get("cover_revision"),
            file_entry.get("cover_revision"),
        ),
        "library_root_id": payload.get("root_id"),
        "library_root_category": _first_inventory_value(
            payload.get("library_root_category"),
            file_entry.get("library_root_category"),
        ),
        "exception_type": normalize_exception_value(
            payload.get("exception_type")
            if payload.get("exception_override_present") is True
            else _first_inventory_value(
                payload.get("exception_type"),
                file_entry.get("exception_type"),
            )
        ),
    })
    entry["raw_artist"] = entry.get("artist")
    entry["raw_album_artist"] = entry.get("album_artist")
    return entry


def _non_album_entries_from_inventory_candidates(
    rows: Iterable[object],
    *,
    visible_library_categories: list[str],
    alias_to_canonical: Mapping[str, object],
    canonical_to_aliases: Mapping[str, object],
    visible_artist_names: Iterable[object] = (),
    query: object = "",
) -> list[dict[str, object]]:
    from music_app.services.view_search import (
        normalize_search_text,
        search_terms_match_fields,
        split_search_terms,
    )

    visible_artists = {
        str(artist or "").strip()
        for artist in visible_artist_names
        if str(artist or "").strip()
    }
    visible_artist_keys = {local_inventory_identity_key(artist) for artist in visible_artists}
    visible_path_parts = {
        normalize_search_text(alias)
        for artist in visible_artists
        for alias in _expanded_artist_names(
            artist,
            alias_to_canonical,
            canonical_to_aliases,
        )
        if normalize_search_text(alias)
    }
    query_terms = split_search_terms(str(query or ""))
    entries: list[dict[str, object]] = []
    for row in rows:
        payload = _row_mapping(row)
        entry = _non_album_entry_from_inventory_candidate(payload)
        exception_type = normalize_exception_value(entry.get("exception_type"))
        if (
            not exception_type
            and has_meaningful_album_name(entry.get("album"))
            and not is_loose_track_album_value(entry.get("album"))
        ):
            continue
        entry_artist = str(entry.get("album_artist") or entry.get("artist") or "").strip()
        canonical_artist = _canonical_artist_name(entry_artist, alias_to_canonical)
        entry["album_artist"] = canonical_artist or entry_artist
        entry["exception_type"] = exception_type
        if not entry_visible_in_categories(entry, visible_library_categories):
            continue
        relative_path = str(payload.get("relative_path") or "").strip()
        path_parts = {
            normalize_search_text(part)
            for part in Path(relative_path).parts[:-1]
            if normalize_search_text(part)
        }
        if visible_artist_keys and (
            local_inventory_identity_key(entry_artist) not in visible_artist_keys
            and local_inventory_identity_key(canonical_artist) not in visible_artist_keys
            and not visible_path_parts.intersection(path_parts)
        ):
            continue
        if query_terms:
            search_fields = [
                normalize_search_text(str(value or ""))
                for value in (
                    entry_artist,
                    canonical_artist,
                    entry.get("artist"),
                    entry.get("album"),
                    entry.get("title"),
                    entry.get("year"),
                    entry.get("exception_type"),
                    payload.get("relative_path"),
                    payload.get("private_path"),
                )
                if str(value or "").strip()
            ]
            if not search_terms_match_fields(query_terms, search_fields):
                continue
        entries.append(entry)
    return entries

def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres library browse.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _row_mapping(row: object) -> Mapping[str, object]:
    if isinstance(row, Mapping):
        return row
    if isinstance(row, (tuple, list)) and len(row) >= 3:
        return {"artist_name": row[0], "sort_name": row[1], "album_count": row[2]}
    return {}


def _root_sidebar_aggregate(
    rows: Iterable[object],
) -> tuple[dict[str, str], dict[str, str], dict[str, int], int]:
    artist_displays: dict[str, str] = {}
    artist_sort_values: dict[str, str] = {}
    all_album_ids: set[object] = set()
    fallback_album_count = 0
    artist_album_ids: dict[str, set[object]] = {}
    fallback_artist_counts: dict[str, int] = {}
    for row in rows:
        row_payload = _row_mapping(row)
        artist_name = str(row_payload.get("artist_name") or "").strip()
        if not artist_name:
            continue
        artist_album_count = _coerce_int(row_payload.get("album_count"))
        if artist_album_count <= 0:
            continue
        artist_identity = _row_artist_identity(row_payload)
        if not artist_identity:
            continue
        album_ids = _row_album_id_set(row_payload)
        if album_ids:
            all_album_ids.update(album_ids)
            artist_album_ids.setdefault(artist_identity, set()).update(album_ids)
        else:
            fallback_album_count += artist_album_count
            fallback_artist_counts[artist_identity] = (
                fallback_artist_counts.get(artist_identity, 0) + artist_album_count
            )
        existing_display = artist_displays.get(artist_identity, "")
        if not existing_display or _prefer_artist_display(artist_name, existing_display):
            artist_displays[artist_identity] = artist_name
        sort_value = str(
            row_payload.get("sort_name")
            or row_payload.get("artist_sort_name")
            or artist_name
        ).strip()
        existing_sort = artist_sort_values.get(artist_identity, "")
        if sort_value and (
            not existing_sort or _prefer_artist_display(sort_value, existing_sort)
        ):
            artist_sort_values[artist_identity] = sort_value
    artist_counts = {
        artist_identity: len(artist_album_ids.get(artist_identity, set()))
        + fallback_artist_counts.get(artist_identity, 0)
        for artist_identity in set(artist_album_ids) | set(fallback_artist_counts)
    }
    return (
        artist_displays,
        artist_sort_values,
        artist_counts,
        len(all_album_ids) + fallback_album_count,
    )


def _coerce_int(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _coerce_duration_seconds(value: object) -> int:
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def _row_json_mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return {}
    return value if isinstance(value, Mapping) else {}


def _row_string_list(value: object) -> list[str]:
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, (list, tuple, set)):
        values = list(value)
    else:
        values = []
    return [str(item or "").strip() for item in values if str(item or "").strip()]


def _normalized_track_paths(track_paths: set[str]) -> set[str]:
    return {str(path or "").strip() for path in track_paths if str(path or "").strip()}


def _album_payload_track_paths(album: Mapping[str, object]) -> set[str]:
    return {
        str(track.get("path") or "").strip()
        for track in list(album.get("tracks") or [])
        if isinstance(track, Mapping) and str(track.get("path") or "").strip()
    }


def _separate_release_album_key(base_key: str, year: object) -> str:
    year_text = str(year or "").strip().lower()
    return f"{base_key}::year::{year_text}" if year_text else base_key


def _album_separate_release_key(album_artist: str, album_name: str, edition: object | None = None) -> str:
    parts = [album_artist.strip().lower(), album_name.strip().lower()]
    edition_text = str(edition or "").strip()
    if edition_text:
        parts.append(edition_text.lower())
    return "::".join(parts)


def _row_album_identity(
    row_payload: Mapping[str, object],
    artist_display: str,
    *,
    metadata: Mapping[str, object] | None = None,
    separate_release_keys: set[str] | None = None,
    base_key: str | None = None,
) -> tuple[object, str, object]:
    resolved_metadata = (
        metadata
        if metadata is not None
        else _problematic_album_metadata_from_row(row_payload)
    )
    album_name = str(row_payload.get("album_title") or "").strip()
    album_artist = str(resolved_metadata.get("album_artist") or artist_display).strip()
    edition = resolved_metadata.get("edition", row_payload.get("album_edition"))
    resolved_base_key = base_key or _album_separate_release_key(
        album_artist,
        album_name,
        edition,
    )
    resolved_separate_release_keys = (
        separate_release_keys
        if separate_release_keys is not None
        else set(_row_string_list(row_payload.get("separate_release_keys")))
    )
    file_entry = _row_json_mapping(row_payload.get("file_entry"))
    split_year = file_entry.get(
        "year",
        row_payload.get("file_year", row_payload.get("album_release_year")),
    )
    if resolved_base_key in resolved_separate_release_keys and str(split_year or "").strip():
        split_key = _separate_release_album_key(resolved_base_key, split_year)
        return split_key, split_key, split_year

    album_id = row_payload.get("album_id")
    album_key = str(row_payload.get("album_key") or "").strip()
    album_identity = album_id if album_id is not None else album_key
    return album_identity, album_key, row_payload.get("album_release_year")


def _problematic_album_key_candidates(album_key: str) -> list[str]:
    raw_key = str(album_key or "")
    candidates = [raw_key]
    try:
        repaired_key = raw_key.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        repaired_key = ""
    if repaired_key and repaired_key not in candidates:
        candidates.append(repaired_key)
    return candidates


def _effective_row_exception_type(row_payload: Mapping[str, object]) -> str:
    file_entry = _row_json_mapping(row_payload.get("file_entry"))
    if row_payload.get("exception_override_present") is True:
        effective_exception_value = row_payload.get("exception_type")
    elif row_payload.get("exception_override_present") is False:
        effective_exception_value = file_entry.get("exception_type")
    else:
        effective_exception_value = _first_inventory_value(
            row_payload.get("exception_type"),
            file_entry.get("exception_type"),
        )
    return normalize_exception_value(effective_exception_value)


def _annotate_album_payload_problematic_tracks(
    albums: list[dict[str, object]],
    rows: list[object],
) -> None:
    non_album_track_paths = {
        str(row_payload.get("file_private_path") or "").strip()
        for row in rows
        if (row_payload := _row_mapping(row))
        and _effective_row_exception_type(row_payload) in NON_ALBUM_EXCEPTION_VALUES.values()
        and str(row_payload.get("file_private_path") or "").strip()
    }
    problematic_track_paths = {
        str(problem_row.get("path") or "").strip()
        for problematic_album in _problematic_album_projection_payloads(rows)
        for problem_row in _problematic_track_problem_rows(problematic_album)
        if str(problem_row.get("path") or "").strip()
        and str(problem_row.get("path") or "").strip() not in non_album_track_paths
    }
    for album in albums:
        for track in album.get("tracks") or []:
            if isinstance(track, dict):
                track["is_problematic"] = (
                    str(track.get("path") or "").strip()
                    in problematic_track_paths
                )


def _problematic_album_projection_payloads(rows: list[object]) -> list[dict[str, object]]:
    albums: dict[object, dict[str, object]] = {}
    seen_track_paths_by_album: dict[object, set[str]] = {}
    metadata_by_persisted_album: dict[object, dict[str, object]] = {}
    base_key_by_persisted_album: dict[object, str] = {}
    string_set_cache: dict[tuple[str, ...], set[str]] = {}
    previous_ignored_value: object = object()
    previous_ignored_keys: set[str] = set()
    previous_separate_value: object = object()
    previous_separate_keys: set[str] = set()
    for row in rows:
        row_payload = _row_mapping(row)
        persisted_album_id = row_payload.get("album_id")
        persisted_album_key = str(row_payload.get("album_key") or "").strip()
        if persisted_album_id is None and not persisted_album_key:
            continue
        persisted_identity = (
            persisted_album_id
            if persisted_album_id is not None
            else persisted_album_key
        )
        metadata = metadata_by_persisted_album.get(persisted_identity)
        if metadata is None:
            metadata = _problematic_album_metadata_from_row(row_payload)
            metadata_by_persisted_album[persisted_identity] = metadata
        ignored_value = row_payload.get("ignored_repair_keys")
        if ignored_value == previous_ignored_value:
            ignored_repair_keys = previous_ignored_keys
        else:
            ignored_repair_key_values = tuple(_row_string_list(ignored_value))
            ignored_repair_keys = string_set_cache.setdefault(
                ignored_repair_key_values,
                set(ignored_repair_key_values),
            )
            previous_ignored_value = ignored_value
            previous_ignored_keys = ignored_repair_keys
        separate_value = row_payload.get("separate_release_keys")
        if separate_value == previous_separate_value:
            separate_release_keys = previous_separate_keys
        else:
            separate_release_key_values = tuple(_row_string_list(separate_value))
            separate_release_keys = string_set_cache.setdefault(
                separate_release_key_values,
                set(separate_release_key_values),
            )
            previous_separate_value = separate_value
            previous_separate_keys = separate_release_keys
        artist_display = str(row_payload.get("artist_name") or "").strip()
        base_key = base_key_by_persisted_album.get(persisted_identity)
        if base_key is None:
            base_key = _album_separate_release_key(
                str(metadata.get("album_artist") or artist_display),
                str(row_payload.get("album_title") or ""),
                metadata.get("edition", row_payload.get("album_edition")),
            )
            base_key_by_persisted_album[persisted_identity] = base_key
        album_identity, album_key, album_year = _row_album_identity(
            row_payload,
            artist_display,
            metadata=metadata,
            separate_release_keys=separate_release_keys,
            base_key=base_key,
        )
        if not album_identity:
            continue
        album = albums.get(album_identity)
        if album is None:
            artists = metadata.get("artists")
            if not isinstance(artists, list):
                artists = [artist_display] if artist_display else []
            album = {
                "key": album_key,
                "album_ref": album_key,
                "_persisted_album_key": persisted_album_key,
                "name": str(row_payload.get("album_title") or "").strip(),
                "album_artist": str(metadata.get("album_artist") or artist_display).strip(),
                "artists": [str(artist or "").strip() for artist in artists if str(artist or "").strip()],
                "is_compilation": bool(metadata.get("is_compilation")),
                "cover_path": row_payload.get("album_cover_path"),
                "cover_revision": metadata.get("cover_revision"),
                "cover_selection_origin": (
                    str(metadata.get("cover_selection_origin") or "").strip().casefold()
                    if str(metadata.get("cover_selection_origin") or "").strip().casefold()
                    in {"user", "automatic"}
                    else None
                ),
                "local_cover_width": _nullable_int(metadata.get("local_cover_width")),
                "local_cover_height": _nullable_int(metadata.get("local_cover_height")),
                "remote_cover_url": metadata.get("remote_cover_url"),
                "remote_cover_thumbnail_url": metadata.get("remote_cover_thumbnail_url"),
                "remote_cover_source": metadata.get("remote_cover_source"),
                "remote_cover_source_label": metadata.get("remote_cover_source_label"),
                "remote_cover_album_url": metadata.get("remote_cover_album_url"),
                "remote_cover_width": _nullable_int(metadata.get("remote_cover_width")),
                "remote_cover_height": _nullable_int(metadata.get("remote_cover_height")),
                "year": album_year,
                "release_date": metadata.get("release_date"),
                "edition": metadata.get("edition"),
                "album_rating": _coerce_int(metadata.get("album_rating")),
                "root_provenance": dict(_row_json_mapping(metadata.get("root_provenance"))),
                "tracks": [],
                "_file_entries": [],
                "_ignored_repair_keys": set(ignored_repair_keys),
                "_separate_release_keys": set(separate_release_keys),
                "_duplicate_file_counts": {},
            }
            albums[album_identity] = album
            seen_track_paths_by_album[album_identity] = set()
        else:
            album["_ignored_repair_keys"].update(ignored_repair_keys)
            album["_separate_release_keys"].update(separate_release_keys)

        track_path = str(row_payload.get("file_private_path") or "").strip()
        if not track_path or track_path in seen_track_paths_by_album[album_identity]:
            continue
        seen_track_paths_by_album[album_identity].add(track_path)
        file_entry = _problematic_file_entry_from_row(row_payload)
        album["_file_entries"].append(file_entry)
        duplicate_count = _coerce_int_or_default(row_payload.get("duplicate_file_count"), 1)
        album["_duplicate_file_counts"][track_path] = duplicate_count
        album["tracks"].append(
            {
                "key": str(row_payload.get("track_key") or "").strip(),
                "track_ref": str(row_payload.get("track_key") or "").strip(),
                "path": track_path,
                "title": str(row_payload.get("track_title") or "").strip(),
                "disc_number": row_payload.get("disc_number"),
                "track_number": row_payload.get("track_number"),
                "duration_seconds": _coerce_duration_seconds(row_payload.get("duration_seconds")),
                "exception_type": _effective_row_exception_type(row_payload),
            }
        )
    projected_albums = list(albums.values())
    for album in projected_albums:
        album["tracks"].sort(
            key=lambda track: (
                track.get("disc_number") is None,
                _coerce_int_or_default(track.get("disc_number"), 0),
                track.get("track_number") is None,
                _coerce_int_or_default(track.get("track_number"), 0),
                str(track.get("title") or "").casefold(),
                str(track.get("path") or "").casefold(),
            )
        )
        album["_file_entries"].sort(key=lambda entry: str(entry.get("path") or "").casefold())
    return projected_albums


def _nullable_int(value: object) -> int | None:
    if value in (None, ""):
        return None
    return _coerce_int(value)


def _problematic_album_metadata_from_row(
    row_payload: Mapping[str, object],
) -> dict[str, object]:
    metadata = dict(_row_json_mapping(row_payload.get("album_metadata")))
    if metadata:
        return metadata
    artists = row_payload.get("album_artists")
    if isinstance(artists, str):
        try:
            artists = json.loads(artists)
        except (TypeError, ValueError):
            artists = []
    if not isinstance(artists, list):
        artists = []
    return {
        "album_artist": row_payload.get("album_artist"),
        "artists": artists,
        "is_compilation": row_payload.get("album_is_compilation"),
        "cover_revision": row_payload.get("album_cover_revision"),
        "cover_selection_origin": row_payload.get("album_cover_selection_origin"),
        "local_cover_width": row_payload.get("album_local_cover_width"),
        "local_cover_height": row_payload.get("album_local_cover_height"),
        "remote_cover_url": row_payload.get("album_remote_cover_url"),
        "remote_cover_thumbnail_url": row_payload.get("album_remote_cover_thumbnail_url"),
        "remote_cover_source": row_payload.get("album_remote_cover_source"),
        "remote_cover_source_label": row_payload.get("album_remote_cover_source_label"),
        "remote_cover_album_url": row_payload.get("album_remote_cover_album_url"),
        "remote_cover_width": row_payload.get("album_remote_cover_width"),
        "remote_cover_height": row_payload.get("album_remote_cover_height"),
        "release_date": row_payload.get("album_release_date"),
        "edition": row_payload.get("album_edition"),
        "album_rating": row_payload.get("album_rating"),
        "root_provenance": row_payload.get("album_root_provenance"),
    }


def _problematic_file_entry_from_row(row_payload: Mapping[str, object]) -> dict[str, object]:
    raw_file_entry = row_payload.get("file_entry")
    file_entry = _row_json_mapping(raw_file_entry)
    track_path = str(row_payload.get("file_private_path") or file_entry.get("path") or "").strip()
    compact_scan_entry_present = row_payload.get("file_entry_is_object") is True
    hydrated_scan_entry_present = isinstance(raw_file_entry, Mapping)
    if isinstance(raw_file_entry, str):
        try:
            hydrated_scan_entry_present = isinstance(json.loads(raw_file_entry), Mapping)
        except (TypeError, ValueError):
            hydrated_scan_entry_present = False
    scan_entry_present = compact_scan_entry_present or hydrated_scan_entry_present

    def required_text_value(
        entry_field: str,
        compact_field: str,
        canonical_value: object,
    ) -> str:
        if scan_entry_present:
            raw_value = (
                row_payload.get(compact_field)
                if compact_scan_entry_present
                else file_entry.get(entry_field)
            )
        else:
            raw_value = canonical_value
        return str(raw_value or "").strip()

    if compact_scan_entry_present:
        raw_track_number = row_payload.get("file_track_number")
        raw_year = row_payload.get("file_year")
    elif hydrated_scan_entry_present:
        raw_track_number = file_entry.get("track_number")
        raw_year = file_entry.get("year")
    else:
        raw_track_number = row_payload.get("track_number")
        raw_year = row_payload.get("album_release_year")
    return {
        "path": track_path,
        "album": required_text_value("album", "file_album", row_payload.get("album_title")),
        "album_artist": required_text_value(
            "album_artist",
            "file_album_artist",
            row_payload.get("artist_name"),
        ),
        "artist": required_text_value("artist", "file_artist", row_payload.get("artist_name")),
        "title": required_text_value("title", "file_title", row_payload.get("track_title")),
        "genre": str(file_entry.get("genre") or "").strip(),
        "track_number": raw_track_number,
        "disc_number": file_entry.get("disc_number", row_payload.get("disc_number")),
        "disc_number_raw": file_entry.get("disc_number_raw"),
        "duration_seconds": file_entry.get("duration_seconds", row_payload.get("duration_seconds")),
        "cover_path": file_entry.get("cover_path", row_payload.get("album_cover_path")),
        "cover_revision": file_entry.get("cover_revision", row_payload.get("album_cover_revision")),
        "year": raw_year,
        "edition": file_entry.get("edition"),
        "album_rating": file_entry.get("album_rating"),
        "exception_type": _effective_row_exception_type(row_payload),
        "_text_mojibake_candidate": row_payload.get("file_text_mojibake_candidate"),
    }


def _normalized_problem_year(value: object) -> int | None:
    try:
        normalized_year = int(value)
    except (TypeError, ValueError):
        return None
    return normalized_year if normalized_year > 0 else None


def _album_file_year_mismatch(album: Mapping[str, object]) -> bool:
    album_year = _normalized_problem_year(album.get("year"))
    if album_year is None:
        return False
    ignored_repair_keys = set(album.get("_ignored_repair_keys") or set())
    for entry in album.get("_file_entries") or []:
        if not isinstance(entry, Mapping):
            continue
        path = str(entry.get("path") or "")
        if f"{path}::year" in ignored_repair_keys:
            continue
        file_year = _normalized_problem_year(entry.get("year"))
        if file_year is not None and file_year != album_year:
            return True
    return False


_PROBLEM_REASON_IDENTITY_CODES = {
    "Missing artist": "missing-artist",
    "Missing album": "missing-album",
    "Missing track title": "missing-track-title",
    "Missing track artist": "missing-track-artist",
    "Missing album artist": "missing-album-artist",
    "Missing year": "missing-year",
    "Invalid year": "invalid-year",
    "Missing track number": "missing-track-number",
    "Invalid track number": "invalid-track-number",
    "Missing cover art": "missing-cover-art",
    "Poor art quality": "poor-art-quality",
    "Duplicate files": "duplicate-files",
    "Album name mismatch": "album-name-mismatch",
    "Album artist mismatch": "album-artist-mismatch",
    "Year mismatch": "year-mismatch",
    "Inconsistent year": "inconsistent-year",
    "Undecoded characters": "undecoded-characters",
    "Encoding problem": "encoding-problem",
}
_PROBLEM_REASON_BY_IDENTITY_CODE = {
    code: reason for reason, code in _PROBLEM_REASON_IDENTITY_CODES.items()
}
_ENCODED_PROBLEM_REASON_PREFIX = "reason-b64-"


def _encoded_problem_reason_identity(reason: str) -> str:
    encoded_reason = base64.urlsafe_b64encode(reason.encode("utf-8")).decode("ascii")
    return f"{_ENCODED_PROBLEM_REASON_PREFIX}{encoded_reason.rstrip('=')}"


def _decoded_problem_reason_identity(reason_code: str) -> str:
    if not reason_code.startswith(_ENCODED_PROBLEM_REASON_PREFIX):
        return ""
    encoded_reason = reason_code.removeprefix(_ENCODED_PROBLEM_REASON_PREFIX)
    padding = "=" * (-len(encoded_reason) % 4)
    try:
        decoded_reason = base64.b64decode(
            f"{encoded_reason}{padding}",
            altchars=b"-_",
            validate=True,
        )
        return decoded_reason.decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return ""


def _problem_reason_identity_code(reason: object) -> str:
    normalized_reason = str(reason or "").strip()
    return _PROBLEM_REASON_IDENTITY_CODES.get(
        normalized_reason,
        _encoded_problem_reason_identity(normalized_reason),
    )


def _problem_identity_row_key(
    path: object,
    reason: object,
    *,
    scope: str,
) -> str:
    return "::".join(
        (
            str(path or ""),
            f"problem-{scope}",
            _problem_reason_identity_code(reason),
        )
    )


def _problem_reason_is_ignored(
    ignored_repair_keys: set[str],
    path: object,
    reason: object,
    *,
    scope: str,
    legacy_field: str | None = None,
) -> bool:
    if _problem_identity_row_key(path, reason, scope=scope) in ignored_repair_keys:
        return True
    return bool(
        legacy_field
        and f"{str(path or '')}::{legacy_field}" in ignored_repair_keys
    )


def _problematic_album_reasons(album: Mapping[str, object]) -> list[str]:
    cached_reasons = album.get("_problematic_reasons")
    if isinstance(cached_reasons, list):
        return list(cached_reasons)
    reasons: list[str] = []
    ignored_repair_keys = set(album.get("_ignored_repair_keys") or set())
    file_entries = [entry for entry in album.get("_file_entries") or [] if isinstance(entry, dict)]
    album_problem_identity = str(
        album.get("album_ref") or album.get("key") or ""
    )

    def add(reason: str | None) -> None:
        if (
            reason
            and reason not in reasons
            and not _problem_reason_is_ignored(
                ignored_repair_keys,
                album_problem_identity,
                reason,
                scope="album",
            )
        ):
            reasons.append(reason)

    add(_cached_problematic_text_reason(album, "Artist", str(album.get("album_artist") or "")))
    add(_cached_problematic_text_reason(album, "Album", str(album.get("name") or "")))
    add(year_problem_reason(album.get("year")))

    if not album.get("cover_path"):
        add("Missing cover art")
    else:
        width = _coerce_int(album.get("local_cover_width"))
        height = _coerce_int(album.get("local_cover_height"))
        if width > 0 and height > 0 and (width < 600 or height < 600):
            add("Poor art quality")

    duplicate_counts = album.get("_duplicate_file_counts") or {}
    if any(_coerce_int_or_default(count, 1) > 1 for count in getattr(duplicate_counts, "values", lambda: [])()):
        add("Duplicate files")

    album_values = {str(entry.get("album") or "").strip().casefold() for entry in file_entries if str(entry.get("album") or "").strip()}
    artist_values = {
        str(entry.get("album_artist") or "").strip().casefold()
        for entry in file_entries
        if str(entry.get("album_artist") or "").strip()
    }
    valid_years = {
        int(entry.get("year"))
        for entry in file_entries
        if str(entry.get("year") or "").strip().isdigit()
    }
    raw_years = {str(entry.get("year") or "").strip() for entry in file_entries if str(entry.get("year") or "").strip()}
    if len(album_values) > 1:
        add("Album name mismatch")
    if len(artist_values) > 1 and not bool(album.get("is_compilation")):
        add("Album artist mismatch")
    if len(valid_years) > 1:
        add("Year mismatch")
    elif len(raw_years) > 1 and not valid_years:
        add("Inconsistent year")
    if _album_file_year_mismatch(album):
        add("Year mismatch")

    for entry in file_entries:
        path = str(entry.get("path") or "")
        for field_name, label in (
            ("album", "Album"),
            ("title", "Track title"),
            ("artist", "Track artist"),
            ("album_artist", "Album artist"),
        ):
            if f"{path}::{field_name}" in ignored_repair_keys:
                continue
            add(
                _cached_problematic_text_reason(
                    album,
                    label,
                    str(entry.get(field_name) or ""),
                    detect_encoding=entry.get("_text_mojibake_candidate") is not False,
                )
            )
        if f"{path}::year" not in ignored_repair_keys:
            add(year_problem_reason(entry.get("year")))
        if f"{path}::track_number" not in ignored_repair_keys:
            add(_track_number_problem(entry.get("track_number")))

    for track_order_issue in _track_order_issues(album):
        add(_track_order_issue_reason(track_order_issue))

    if _problematic_encoding_repair_preview(album, include_preview_rows=False)["has_repairs"]:
        add("Encoding problem")
    if isinstance(album, dict):
        album["_problematic_reasons"] = list(reasons)
    return reasons


def _problematic_album_scope_reasons(album: Mapping[str, object]) -> list[str]:
    """Return only problems owned by the album-level exclusion surface."""
    reasons: list[str] = []
    ignored_repair_keys = set(album.get("_ignored_repair_keys") or set())
    album_problem_identity = str(
        album.get("album_ref") or album.get("key") or ""
    )

    def add(reason: str | None) -> None:
        if (
            reason
            and reason not in reasons
            and not _problem_reason_is_ignored(
                ignored_repair_keys,
                album_problem_identity,
                reason,
                scope="album",
            )
        ):
            reasons.append(reason)

    add(_cached_problematic_text_reason(album, "Artist", str(album.get("album_artist") or "")))
    add(_cached_problematic_text_reason(album, "Album", str(album.get("name") or "")))
    add(year_problem_reason(album.get("year")))

    if not album.get("cover_path"):
        add("Missing cover art")
    else:
        width = _coerce_int(album.get("local_cover_width"))
        height = _coerce_int(album.get("local_cover_height"))
        if width > 0 and height > 0 and (width < 600 or height < 600):
            add("Poor art quality")

    duplicate_counts = album.get("_duplicate_file_counts") or {}
    if any(
        _coerce_int_or_default(count, 1) > 1
        for count in getattr(duplicate_counts, "values", lambda: [])()
    ):
        add("Duplicate files")

    file_entries = [
        entry
        for entry in album.get("_file_entries") or []
        if isinstance(entry, dict)
    ]
    album_values = {
        str(entry.get("album") or "").strip().casefold()
        for entry in file_entries
        if str(entry.get("album") or "").strip()
    }
    artist_values = {
        str(entry.get("album_artist") or "").strip().casefold()
        for entry in file_entries
        if str(entry.get("album_artist") or "").strip()
    }
    valid_years = {
        int(entry.get("year"))
        for entry in file_entries
        if str(entry.get("year") or "").strip().isdigit()
    }
    raw_years = {
        str(entry.get("year") or "").strip()
        for entry in file_entries
        if str(entry.get("year") or "").strip()
    }
    if len(album_values) > 1:
        add("Album name mismatch")
    if len(artist_values) > 1 and not bool(album.get("is_compilation")):
        add("Album artist mismatch")
    if len(valid_years) > 1:
        add("Year mismatch")
    elif len(raw_years) > 1 and not valid_years:
        add("Inconsistent year")
    if _album_file_year_mismatch(album):
        add("Year mismatch")
    return reasons


def _problematic_album_reason_display(
    album: Mapping[str, object],
    reason: str,
) -> str:
    """Explain album tag problems without changing their canonical identity."""
    tag_candidates = (
        (
            "Album",
            album.get("name"),
            _cached_problematic_text_reason(
                album,
                "Album",
                str(album.get("name") or ""),
            ),
        ),
        (
            "Artist",
            album.get("album_artist"),
            _cached_problematic_text_reason(
                album,
                "Artist",
                str(album.get("album_artist") or ""),
            ),
        ),
        ("Year", album.get("year"), year_problem_reason(album.get("year"))),
    )
    for field, value, candidate_reason in tag_candidates:
        if candidate_reason == reason:
            return f'{reason} ("{str(value or "").strip()}" in {field})'
    return reason


def _text_problem_reason_fast(
    label: str,
    value: str,
    *,
    detect_encoding: bool = True,
) -> str | None:
    normalized_value = str(value or "")
    return text_problem_reason(
        label,
        normalized_value,
        detect_encoding=detect_encoding and not normalized_value.isascii(),
    )


def _cached_problematic_text_reason(
    album: Mapping[str, object],
    label: str,
    value: str,
    *,
    detect_encoding: bool = True,
) -> str | None:
    cache = album.setdefault("_text_problem_reason_cache", {}) if isinstance(album, dict) else {}
    cache_key = (label, value, detect_encoding)
    if cache_key not in cache:
        cache[cache_key] = _text_problem_reason_fast(
            label,
            value,
            detect_encoding=detect_encoding,
        )
    return cache[cache_key]


def _track_number_problem(value: object) -> str | None:
    if value in (None, ""):
        return "Missing track number"
    try:
        if int(value) <= 0:
            return "Invalid track number"
    except Exception:
        return "Invalid track number"
    return None


def _positive_track_number(value: object) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _leading_filename_track_number(path: object) -> int | None:
    filename = Path(str(path or "")).name
    match = re.match(r"^(\d+)(?:\.|\s*-\s*)", filename)
    if match is None:
        return None
    return _positive_track_number(match.group(1))


def _effective_track_order_number(
    track: Mapping[str, object],
    file_entry: Mapping[str, object],
) -> int | None:
    return (
        _positive_track_number(track.get("track_number"))
        or _positive_track_number(file_entry.get("track_number"))
        or _leading_filename_track_number(
            track.get("path") or file_entry.get("path")
        )
    )


def _has_incomplete_track_order(album: Mapping[str, object]) -> bool:
    return bool(_track_order_issues(album))


def _track_order_issue_reason(issue: Mapping[str, object]) -> str:
    missing_numbers = ", ".join(
        str(number)
        for number in issue.get("missing_track_numbers") or []
    )
    return (
        "Incomplete track order: "
        f"Disc {issue.get('disc_number')} missing {missing_numbers}"
    )


def _track_order_issues(album: Mapping[str, object]) -> list[dict[str, object]]:
    cached_issues = album.get("_track_order_issues")
    if isinstance(cached_issues, list):
        return cached_issues
    file_entries_by_path = {
        str(entry.get("path") or ""): entry
        for entry in album.get("_file_entries") or []
        if isinstance(entry, Mapping)
    }
    track_numbers_by_disc: dict[int, set[int]] = {}
    for track in album.get("tracks") or []:
        if not isinstance(track, Mapping):
            continue
        if normalize_exception_value(track.get("exception_type")) in NON_ALBUM_EXCEPTION_VALUES.values():
            continue
        path = str(track.get("path") or "")
        file_entry = file_entries_by_path.get(path, {})
        effective_track_number = _effective_track_order_number(track, file_entry)
        if effective_track_number is None:
            continue
        disc_number = (
            _positive_track_number(track.get("disc_number"))
            or _positive_track_number(file_entry.get("disc_number"))
            or 1
        )
        track_numbers_by_disc.setdefault(disc_number, set()).add(
            effective_track_number
        )
    issues: list[dict[str, object]] = []
    for disc_number, track_numbers in sorted(track_numbers_by_disc.items()):
        if not track_numbers:
            continue
        missing_numbers = sorted(set(range(1, max(track_numbers) + 1)) - track_numbers)
        if missing_numbers:
            issues.append(
                {
                    "disc_number": disc_number,
                    "missing_track_numbers": missing_numbers,
                }
            )
    if isinstance(album, dict):
        album["_track_order_issues"] = issues
    return issues


def _coerce_int_or_default(value: object, default: int) -> int:
    try:
        return int(value or default)
    except (TypeError, ValueError):
        try:
            return int(float(value or default))
        except (TypeError, ValueError):
            return int(default)


def _problematic_encoding_repair_preview(
    album: Mapping[str, object],
    *,
    include_preview_rows: bool,
) -> dict[str, object]:
    cached_preview = album.get("_encoding_repair_preview_full")
    if isinstance(cached_preview, dict):
        if include_preview_rows:
            return cached_preview
        return {**cached_preview, "preview_rows": []}
    ignored_repair_keys = set(album.get("_ignored_repair_keys") or set())
    file_entries = [entry for entry in album.get("_file_entries") or [] if isinstance(entry, dict)]
    preview_rows: list[dict[str, object]] = []
    has_repairs = False
    raw_name = ""
    raw_album_artist = ""
    for entry in file_entries:
        path = str(entry.get("path") or "")
        if not raw_name:
            raw_name = str(entry.get("album") or "").strip()
        if not raw_album_artist:
            raw_album_artist = str(entry.get("album_artist") or "").strip()
        repair_values = (
            str(entry.get("album") or ""),
            str(entry.get("album_artist") or ""),
            str(entry.get("artist") or ""),
            str(entry.get("title") or ""),
        )
        repairs = (
            {}
            if entry.get("_text_mojibake_candidate") is False
            or all(value.isascii() for value in repair_values)
            else build_text_repairs_for_entry(entry)
        )
        for field_name, repaired in repairs.items():
            original = str(entry.get(field_name) or "").strip()
            if not original or f"{path}::{field_name}" in ignored_repair_keys:
                continue
            has_repairs = True
            preview_rows.append(
                {
                    "row_key": f"{path}::{field_name}",
                    "path": path,
                    "track_title": str(entry.get("title") or "").strip() or Path(path).stem,
                    "field": field_name,
                    "original": original,
                    "repaired": repaired,
                }
            )
    preview_rows.sort(
        key=lambda item: (
            str(item.get("track_title") or "").casefold(),
            str(item.get("field") or ""),
            str(item.get("original") or "").casefold(),
        )
    )
    result = {
        "has_repairs": bool(preview_rows) or has_repairs,
        "raw_name": raw_name or str(album.get("name") or ""),
        "raw_album_artist": raw_album_artist or str(album.get("album_artist") or ""),
        "preview_rows": preview_rows,
    }
    if isinstance(album, dict):
        album["_encoding_repair_preview_full"] = result
    return result if include_preview_rows else {**result, "preview_rows": []}


def _problematic_track_problem_rows(album: Mapping[str, object]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    ignored_repair_keys = set(album.get("_ignored_repair_keys") or set())
    album_problem_identity = str(album.get("album_ref") or album.get("key") or "")
    track_order_issues = _track_order_issues(album)
    album_year = _normalized_problem_year(album.get("year"))
    include_complete_repair_scope = bool(track_order_issues)
    track_order_issue_by_disc = {
        int(issue["disc_number"]): issue
        for issue in track_order_issues
    }
    tracks_by_path = {
        str(track.get("path") or ""): track
        for track in album.get("tracks") or []
        if isinstance(track, Mapping) and str(track.get("path") or "")
    }
    entries_by_path = {
        str(entry.get("path") or ""): entry
        for entry in album.get("_file_entries") or []
        if isinstance(entry, dict) and str(entry.get("path") or "")
    }
    ordered_entries = [
        entries_by_path.pop(str(track.get("path") or ""))
        for track in album.get("tracks") or []
        if isinstance(track, Mapping)
        and str(track.get("path") or "") in entries_by_path
    ]
    ordered_entries.extend(
        sorted(
            entries_by_path.values(),
            key=lambda entry: str(entry.get("path") or "").casefold(),
        )
    )
    for entry in ordered_entries:
        if not isinstance(entry, dict):
            continue
        path = str(entry.get("path") or "")
        if not path:
            continue
        reasons: list[str] = []
        reason_fields: dict[str, str] = {}

        def add(reason: str | None, field: str) -> None:
            if (
                reason
                and reason not in reasons
                and not _problem_reason_is_ignored(
                    ignored_repair_keys,
                    album_problem_identity,
                    reason,
                    scope="album",
                )
                and not _problem_reason_is_ignored(
                    ignored_repair_keys,
                    path,
                    reason,
                    scope="file",
                    legacy_field=field,
                )
            ):
                reasons.append(reason)
                reason_fields[reason] = field

        for field_name, label in (
            ("album", "Album"),
            ("title", "Track title"),
            ("artist", "Track artist"),
            ("album_artist", "Album artist"),
        ):
            if f"{path}::{field_name}" in ignored_repair_keys:
                continue
            add(
                _cached_problematic_text_reason(album, label, str(entry.get(field_name) or "")),
                field_name,
            )
        if f"{path}::year" not in ignored_repair_keys:
            add(year_problem_reason(entry.get("year")), "year")
            file_year = _normalized_problem_year(entry.get("year"))
            if (
                album_year is not None
                and file_year is not None
                and file_year != album_year
            ):
                add("Year mismatch", "year")
        if f"{path}::track_number" not in ignored_repair_keys:
            add(_track_number_problem(entry.get("track_number")), "track_number")
        if include_complete_repair_scope:
            track = tracks_by_path.get(path, {})
            effective_disc_number = (
                _positive_track_number(track.get("disc_number"))
                or _positive_track_number(entry.get("disc_number"))
                or 1
            )
            issue = track_order_issue_by_disc.get(effective_disc_number)
            if issue is not None:
                add(_track_order_issue_reason(issue), "track_number")
        if not reasons and not include_complete_repair_scope:
            continue
        rows.append(
            {
                "path": path,
                "filename": Path(path).name,
                "file_type": Path(path).suffix.lstrip(".").upper(),
                "reasons": reasons,
                "ignorable_reasons": [
                    {
                        "reason": reason,
                        "field": reason_fields[reason],
                        "path": path,
                        "row_key": _problem_identity_row_key(
                            path,
                            reason,
                            scope="file",
                        ),
                    }
                    for reason in reasons
                ],
            }
        )
    if include_complete_repair_scope:
        return rows
    return sorted(rows, key=lambda row: str(row.get("filename") or "").casefold())


def _problematic_filter_reasons(reasons: Iterable[object]) -> list[str]:
    filter_reasons: list[str] = []
    for value in reasons:
        reason = str(value or "")
        filter_reason = (
            "Incomplete track order"
            if reason.startswith("Incomplete track order:")
            else reason
        )
        if filter_reason and filter_reason not in filter_reasons:
            filter_reasons.append(filter_reason)
    return filter_reasons


def _problematic_surviving_reasons(
    album: Mapping[str, object],
    *,
    album_scope_reasons: list[str] | None = None,
    track_problem_rows: list[dict[str, object]] | None = None,
) -> list[str]:
    """Return ordered distinct reasons that still have a visible scoped owner."""
    reasons: list[str] = []

    def add(reason: object) -> None:
        value = str(reason or "")
        if value and value not in reasons:
            reasons.append(value)

    for reason in (
        album_scope_reasons
        if album_scope_reasons is not None
        else _problematic_album_scope_reasons(album)
    ):
        add(reason)
    for row in (
        track_problem_rows
        if track_problem_rows is not None
        else _problematic_track_problem_rows(album)
    ):
        for reason in row.get("reasons") or []:
            add(reason)
    return reasons


_PROBLEMATIC_OPTIONAL_SUMMARY_FIELDS = frozenset(
    {
        "cover_path",
        "cover_revision",
        "local_cover_width",
        "local_cover_height",
        "remote_cover_url",
        "remote_cover_thumbnail_url",
        "remote_cover_source",
        "remote_cover_source_label",
        "remote_cover_album_url",
        "remote_cover_width",
        "remote_cover_height",
        "year",
        "release_date",
        "edition",
        "album_rating",
        "cover_width",
        "cover_height",
        "raw_name",
        "raw_album_artist",
    }
)


def _path_file_type(path: object) -> str:
    filename = re.split(r"[\\/]", str(path or ""))[-1]
    _stem, separator, suffix = filename.rpartition(".")
    return suffix.upper() if separator and suffix else ""


def _problematic_album_summary_payload(
    album: Mapping[str, object],
    *,
    album_scope_reasons: list[str] | None = None,
    track_problem_rows: list[dict[str, object]] | None = None,
) -> dict[str, object] | None:
    reasons = _problematic_surviving_reasons(
        album,
        album_scope_reasons=album_scope_reasons,
        track_problem_rows=track_problem_rows,
    )
    repair_preview = _problematic_encoding_repair_preview(album, include_preview_rows=False)
    if not reasons and not repair_preview["has_repairs"]:
        return None
    tracks = [
        {
            "path": str(track.get("path") or ""),
            "title": str(track.get("title") or ""),
        }
        for track in album.get("tracks") or []
        if isinstance(track, Mapping) and str(track.get("path") or "")
    ]
    payload = {
        "key": str(album.get("key") or ""),
        "name": str(album.get("name") or ""),
        "album_artist": str(album.get("album_artist") or ""),
        "artists": list(album.get("artists") or []),
        "is_compilation": bool(album.get("is_compilation")),
        "cover_path": album.get("cover_path") or None,
        "cover_revision": album.get("cover_revision") or None,
        "local_cover_width": album.get("local_cover_width"),
        "local_cover_height": album.get("local_cover_height"),
        "remote_cover_url": album.get("remote_cover_url"),
        "remote_cover_thumbnail_url": album.get("remote_cover_thumbnail_url"),
        "remote_cover_source": album.get("remote_cover_source"),
        "remote_cover_source_label": album.get("remote_cover_source_label"),
        "remote_cover_album_url": album.get("remote_cover_album_url"),
        "remote_cover_width": album.get("remote_cover_width"),
        "remote_cover_height": album.get("remote_cover_height"),
        "year": album.get("year"),
        "release_date": album.get("release_date"),
        "edition": album.get("edition"),
        "album_rating": _coerce_int(album.get("album_rating")),
        "problem_reasons": reasons,
        "issue_count": len(reasons),
        "cover_width": _coerce_int(album.get("local_cover_width")),
        "cover_height": _coerce_int(album.get("local_cover_height")),
        "has_encoding_repairs": bool(repair_preview.get("has_repairs")),
        "raw_name": repair_preview.get("raw_name"),
        "raw_album_artist": repair_preview.get("raw_album_artist"),
        "track_count": len(tracks),
        "track_paths": [str(track.get("path") or "") for track in tracks],
        "file_types": sorted(
            {
                file_type
                for track in tracks
                if (file_type := _path_file_type(track.get("path")))
            }
        ),
        "search_text": "\n".join(
            str(track.get("title") or "")
            for track in tracks
            if str(track.get("title") or "").strip()
        ),
        "detail_loaded": False,
    }
    return {
        key: value
        for key, value in payload.items()
        if key not in _PROBLEMATIC_OPTIONAL_SUMMARY_FIELDS
        or value not in (None, "", [])
    }


def _problematic_album_detail_payload(album: Mapping[str, object]) -> dict[str, object] | None:
    album_scope_reasons = _problematic_album_scope_reasons(album)
    track_problem_rows = _problematic_track_problem_rows(album)
    summary = _problematic_album_summary_payload(
        album,
        album_scope_reasons=album_scope_reasons,
        track_problem_rows=track_problem_rows,
    )
    if summary is None:
        return None
    repair_preview = _problematic_encoding_repair_preview(album, include_preview_rows=True)
    reasons = list(summary.get("problem_reasons") or [])
    album_problem_identity = str(
        album.get("album_ref") or album.get("key") or ""
    )
    detail = {
        **summary,
        "problem_reasons": reasons,
        "issue_count": len(reasons),
        "album_problem_rows": [
            {
                "row_key": _problem_identity_row_key(
                    album_problem_identity,
                    reason,
                    scope="album",
                ),
                "album_key": str(
                    album.get("_persisted_album_key")
                    or album.get("key")
                    or ""
                ),
                "reason": reason,
                "display_reason": _problematic_album_reason_display(album, reason),
            }
            for reason in album_scope_reasons
        ],
        "album_ref": str(album.get("album_ref") or album.get("key") or ""),
        "root_provenance": dict(_row_json_mapping(album.get("root_provenance"))),
        "tracks": list(album.get("tracks") or []),
        "repair_preview_rows": repair_preview.get("preview_rows", []),
        "track_problem_rows": track_problem_rows,
        "track_order_issues": _track_order_issues(album),
        "problematic_track_paths": [
            str(row.get("path") or "")
            for row in track_problem_rows
        ],
        "separate_release_candidate": None,
        "detail_loaded": True,
        "persistence_backend": PERSISTENCE_BACKEND_POSTGRES,
        "persistence_seam": _LIBRARY_BROWSE_SEAM_ID,
        "view_data_source": _SOURCE_TELEMETRY,
    }
    return detail


def _legacy_album_problem_row_keys(
    album: Mapping[str, object],
    reason: str,
) -> set[str]:
    legacy_fields: set[str] = set()
    if _cached_problematic_text_reason(
        album,
        "Album",
        str(album.get("name") or ""),
    ) == reason:
        legacy_fields.add("album")
    if _cached_problematic_text_reason(
        album,
        "Artist",
        str(album.get("album_artist") or ""),
    ) == reason:
        legacy_fields.add("album_artist")
    if year_problem_reason(album.get("year")) == reason:
        legacy_fields.add("year")
    if not legacy_fields:
        return set()
    ignored_repair_keys = set(album.get("_ignored_repair_keys") or set())
    return {
        legacy_row_key
        for track in album.get("tracks") or []
        if isinstance(track, Mapping)
        and (path := str(track.get("path") or "").strip())
        for field_name in legacy_fields
        if (legacy_row_key := f"{path}::{field_name}") in ignored_repair_keys
    }


def _utility_rules_projection_payload(rows: list[object]) -> dict[str, object]:
    ignored_version_keys: set[str] = set()
    version_albums_by_key: dict[str, dict[str, object]] = {}
    problem_items_by_key: dict[str, dict[str, object]] = {}
    for row in rows:
        row_payload = _row_mapping(row)
        ignored_version_key = str(row_payload.get("ignored_version_key") or "").strip()
        if ignored_version_key:
            ignored_version_keys.add(ignored_version_key)
            if row_payload.get("album_id") is not None or str(row_payload.get("album_key") or "").strip():
                version_albums_by_key[ignored_version_key] = _utility_version_album_payload(row_payload)
        ignored_repair_key = str(row_payload.get("ignored_repair_key") or "").strip()
        if ignored_repair_key:
            problem_items_by_key[ignored_repair_key] = _utility_problem_ignore_payload(row_payload)

    version_albums = [
        version_albums_by_key.get(key)
        or fallback_version_album_payload(key)
        for key in sorted(ignored_version_keys)
    ]
    problem_ignores = [
        problem_items_by_key[key]
        for key in sorted(problem_items_by_key)
    ]
    album_problem_ignores = [
        item for item in problem_ignores if item.get("scope") == "album"
    ]
    file_problem_ignores = [
        item for item in problem_ignores if item.get("scope") == "file"
    ]
    return {
        "ok": True,
        "rules": [
            {
                "key": "version-exceptions",
                "title": "Version exceptions",
                "description": "Albums that should not be counted as versions of another album with the same title.",
                "count": len(version_albums),
                "albums": version_albums,
            },
            {
                "key": "problem-ignores",
                "title": "Problem exclusions",
                "description": "Album or file problems excluded from Problematic Files.",
                "count": len(problem_ignores),
                "items": problem_ignores,
                "album_items": album_problem_ignores,
                "file_items": file_problem_ignores,
            },
        ],
        "ignored_version_keys": sorted(ignored_version_keys),
        "persistence_backend": PERSISTENCE_BACKEND_POSTGRES,
        "persistence_seam": _LIBRARY_BROWSE_SEAM_ID,
        "view_data_source": _SOURCE_TELEMETRY,
    }


def _utility_version_album_payload(row_payload: Mapping[str, object]) -> dict[str, object]:
    metadata = _row_json_mapping(row_payload.get("album_metadata"))
    artist_display = str(metadata.get("album_artist") or row_payload.get("artist_name") or "").strip()
    artists = metadata.get("artists")
    if not isinstance(artists, list):
        artists = [artist_display] if artist_display else []
    return {
        "key": str(row_payload.get("album_key") or row_payload.get("ignored_version_key") or ""),
        "album_ref": str(row_payload.get("album_key") or row_payload.get("ignored_version_key") or ""),
        "name": str(row_payload.get("album_title") or "").strip(),
        "album_artist": artist_display,
        "artists": [str(artist or "").strip() for artist in artists if str(artist or "").strip()],
        "cover_path": row_payload.get("album_cover_path"),
        "cover_revision": metadata.get("cover_revision"),
        "year": row_payload.get("album_release_year") or "",
        "release_date": metadata.get("release_date"),
        "edition": metadata.get("edition") or "",
        "album_rating": _coerce_int(metadata.get("album_rating")),
        "tracks": [],
    }


def _utility_problem_ignore_payload(row_payload: Mapping[str, object]) -> dict[str, object]:
    row_key = str(row_payload.get("ignored_repair_key") or "").strip()
    album_identity, album_marker, album_reason_code = row_key.rpartition(
        "::problem-album::"
    )
    file_identity, file_marker, file_reason_code = row_key.rpartition(
        "::problem-file::"
    )
    if album_marker:
        identity = album_identity
        structured_scope = "problem-album"
        reason_code = album_reason_code
        field = structured_scope
        scope = "album"
    elif file_marker:
        identity = file_identity
        structured_scope = "problem-file"
        reason_code = file_reason_code
        field = structured_scope
        scope = "file"
    else:
        identity, _, field = row_key.rpartition("::")
        structured_scope = ""
        reason_code = ""
        scope = "file"
    entry = _problematic_file_entry_from_row(row_payload)
    album_name = str(entry.get("album") or row_payload.get("album_title") or "").strip()
    artist_name = str(entry.get("album_artist") or entry.get("artist") or "").strip()
    alias_to_canonical = _row_json_mapping(row_payload.get("alias_to_canonical"))
    reason = ""
    if field == "year":
        reason = year_problem_reason(entry.get("year")) or ""
    elif field == "album_artist":
        reason = (
            artist_alias_problem_reason(entry.get("album_artist"), dict(alias_to_canonical))
            or _text_problem_reason_fast("Album artist", str(entry.get("album_artist") or ""))
            or ""
        )
    elif field == "artist":
        reason = _text_problem_reason_fast("Track artist", str(entry.get("artist") or "")) or ""
    elif field == "title":
        reason = _text_problem_reason_fast("Track title", str(entry.get("title") or "")) or ""
    elif field == "album":
        reason = _text_problem_reason_fast("Album", str(entry.get("album") or "")) or ""
    elif structured_scope.startswith("problem-"):
        reason = (
            _PROBLEM_REASON_BY_IDENTITY_CODE.get(reason_code, "")
            or _decoded_problem_reason_identity(reason_code)
        )
        if not reason and reason_code.startswith("incomplete-track-order-disc-"):
            reason = "Incomplete track order"
    album_group_key = " :: ".join(
        part for part in [artist_name.strip(), album_name.strip()] if part
    ) or (identity if scope == "album" else str(Path(identity).parent))
    path = "" if scope == "album" else identity
    return {
        "row_key": row_key,
        "scope": scope,
        "path": path,
        "filename": Path(path).name if path else "",
        "field": field or "problem",
        "album": album_name,
        "artist": artist_name,
        "year": str(entry.get("year") or ""),
        "problem_reason": reason,
        "album_group_key": album_group_key,
    }


def _root_sidebar_view_state(query_params: Mapping[str, object] | None) -> dict[str, object]:
    params = query_params or {}
    gallery_scope = normalize_gallery_scope(params.get("gallery_scope"))
    return {
        "gallery_scope": gallery_scope,
        "gallery_display_mode": normalize_gallery_display_mode(
            params.get("gallery_display") or params.get("gallery_display_mode") or DEFAULT_GALLERY_DISPLAY_MODE,
        ),
        "gallery_scale_percent": normalize_gallery_scale_percent(
            params.get("gallery_scale_percent") or DEFAULT_GALLERY_SCALE_PERCENT,
        ),
        "visible_library_categories": normalize_visible_categories(
            _multi_values(params, "category"),
            gallery_scope,
        ),
    }


def _multi_values(params: Mapping[str, object], key: str) -> list[object]:
    getlist = getattr(params, "getlist", None)
    if callable(getlist):
        return list(getlist(key))
    value = params.get(key)
    if isinstance(value, (list, tuple, set)):
        return list(value)
    if value is None:
        return []
    return [value]


def _clone_query_params_mapping(params: Mapping[str, object]) -> dict[str, object]:
    keys = list(params.keys()) if hasattr(params, "keys") else []
    if not keys:
        return dict(params)
    cloned: dict[str, object] = {}
    for key in keys:
        values = _multi_values(params, str(key))
        if not values:
            continue
        cloned[str(key)] = values if len(values) > 1 else values[0]
    return cloned


def _artist_display_dedupe_key(value: object) -> str:
    from music_app.services.artist_sidebar import artist_display_dedupe_key

    return artist_display_dedupe_key(value) or str(value or "").strip().casefold()


def _artist_tree_display_value(value: object) -> str:
    raw_value = str(value or "").strip()
    deduplicated_members = deduplicate_repeated_album_artist_members(raw_value)
    return " / ".join(deduplicated_members) if deduplicated_members else raw_value


def _prefer_artist_display(candidate: str, existing: str) -> bool:
    candidate_key = (
        1 if candidate.islower() else 0,
        len(candidate),
        sum(1 for character in candidate if character.isupper()),
        candidate.casefold(),
    )
    existing_key = (
        1 if existing.islower() else 0,
        len(existing),
        sum(1 for character in existing if character.isupper()),
        existing.casefold(),
    )
    return candidate_key < existing_key


def _row_artist_identity(row_payload: Mapping[str, object]) -> str:
    artist_name = str(row_payload.get("artist_name") or "").strip()
    dedupe_key = _artist_display_dedupe_key(
        _artist_tree_display_value(artist_name)
    )
    return f"name:{dedupe_key}" if dedupe_key else ""


def _canonical_artist_name(
    artist: object,
    alias_to_canonical: Mapping[str, object],
    *,
    normalized_alias_to_canonical: Mapping[str, object] | None = None,
) -> str:
    artist_name = str(artist or "").strip()
    canonical = alias_to_canonical.get(artist_name)
    if canonical is None:
        artist_key = local_inventory_identity_key(artist_name)
        normalized_aliases = normalized_alias_to_canonical
        if normalized_aliases is None:
            normalized_aliases = {}
            for alias, value in alias_to_canonical.items():
                normalized_aliases.setdefault(
                    local_inventory_identity_key(alias),
                    value,
                )
        canonical = normalized_aliases.get(artist_key, artist_name)
    return str(canonical or artist_name).strip()


def _root_browse_alias_to_canonical(
    alias_to_canonical: Mapping[str, object],
) -> dict[str, object]:
    from music_app.services.selected_artist_membership import collaboration_alias_of

    return {
        str(alias or "").strip(): canonical
        for alias, canonical in alias_to_canonical.items()
        if str(alias or "").strip()
        and not collaboration_alias_of(alias, canonical)
    }


def _expanded_artist_names(
    artist: object,
    alias_to_canonical: Mapping[str, object],
    canonical_to_aliases: Mapping[str, object],
) -> list[str]:
    canonical = _canonical_artist_name(artist, alias_to_canonical)
    values = [canonical]
    aliases = canonical_to_aliases.get(canonical)
    if isinstance(aliases, (list, tuple, set)):
        values.extend(aliases)
    seen: set[str] = set()
    expanded: list[str] = []
    for value in values:
        text = str(value or "").strip()
        key = local_inventory_identity_key(text)
        if not text or key in seen:
            continue
        seen.add(key)
        expanded.append(text)
    return expanded


def _expanded_primary_artist_names(
    artist: object,
    alias_to_canonical: Mapping[str, object],
    canonical_to_aliases: Mapping[str, object],
) -> list[str]:
    from music_app.services.selected_artist_membership import collaboration_alias_of

    canonical = _canonical_artist_name(artist, alias_to_canonical)
    return [
        value
        for value in _expanded_artist_names(
            canonical,
            alias_to_canonical,
            canonical_to_aliases,
        )
        if value == canonical or not collaboration_alias_of(value, canonical)
    ]


def _expanded_artist_name_list(
    artists: Iterable[object],
    alias_to_canonical: Mapping[str, object],
    canonical_to_aliases: Mapping[str, object],
) -> list[str]:
    values: list[str] = []
    seen: set[str] = set()
    for artist in artists:
        for value in _expanded_artist_names(
            artist,
            alias_to_canonical,
            canonical_to_aliases,
        ):
            key = local_inventory_identity_key(value)
            if key in seen:
                continue
            seen.add(key)
            values.append(value)
    return values


def _exact_projected_artist_match(
    query: object,
    alias_to_canonical: Mapping[str, object],
    canonical_to_aliases: Mapping[str, object],
) -> str:
    requested = str(query or "").strip()
    requested_key = local_inventory_identity_key(requested)
    if not requested_key:
        return ""
    for alias, canonical in alias_to_canonical.items():
        if local_inventory_identity_key(alias) == requested_key:
            return str(canonical or "").strip()
    for canonical, aliases in canonical_to_aliases.items():
        canonical_name = str(canonical or "").strip()
        if local_inventory_identity_key(canonical_name) == requested_key:
            return canonical_name
        if isinstance(aliases, (list, tuple, set)) and any(
            local_inventory_identity_key(alias) == requested_key for alias in aliases
        ):
            return canonical_name
    return ""


def _canonicalize_artist_rows(
    rows: list[object],
    alias_to_canonical: Mapping[str, object],
) -> list[object]:
    normalized_alias_to_canonical: dict[str, object] = {}
    for alias, canonical in alias_to_canonical.items():
        normalized_alias_to_canonical.setdefault(
            local_inventory_identity_key(alias),
            canonical,
        )
    canonical_rows: list[object] = []
    for row in rows:
        payload = _row_mapping(row)
        if not payload:
            canonical_rows.append(row)
            continue
        artist_name = str(payload.get("artist_name") or "").strip()
        canonical_name = _canonical_artist_name(
            artist_name,
            alias_to_canonical,
            normalized_alias_to_canonical=normalized_alias_to_canonical,
        )
        next_payload = dict(payload)
        next_payload["source_artist_id"] = payload.get("artist_id")
        next_payload["artist_id"] = None
        next_payload["artist_name"] = canonical_name
        next_payload["artist_sort_name"] = canonical_name.casefold()
        next_payload["sort_name"] = canonical_name.casefold()
        canonical_rows.append(next_payload)
    return canonical_rows


def _row_album_id_set(row_payload: Mapping[str, object]) -> set[object]:
    album_ids = row_payload.get("album_ids")
    if not isinstance(album_ids, (list, tuple, set)):
        return set()
    return {album_id for album_id in album_ids if album_id is not None}


def _album_identity_set(rows: Iterable[object]) -> set[object]:
    identities: set[object] = set()
    for row in rows:
        payload = _row_mapping(row)
        album_id = payload.get("album_id")
        album_key = str(payload.get("album_key") or "").strip()
        if album_id is not None:
            identities.add(("id", album_id))
        elif album_key:
            identities.add(("key", album_key))
    return identities


def _group_rows_by_artist_identity(rows: list[object]) -> list[tuple[str, list[object]]]:
    rows_by_artist: dict[str, list[object]] = {}
    artist_displays: dict[str, str] = {}
    artist_sort_values: dict[str, str] = {}

    for row in rows:
        row_payload = _row_mapping(row)
        artist_display = str(row_payload.get("artist_name") or "").strip()
        if not artist_display:
            continue
        artist_identity = _row_artist_identity(row_payload)
        if not artist_identity:
            continue
        rows_by_artist.setdefault(artist_identity, []).append(row)
        existing_display = artist_displays.get(artist_identity, "")
        if not existing_display or _prefer_artist_display(artist_display, existing_display):
            artist_displays[artist_identity] = artist_display
        sort_value = str(
            row_payload.get("artist_sort_name")
            or row_payload.get("sort_name")
            or artist_display
            or ""
        ).strip()
        existing_sort = artist_sort_values.get(artist_identity, "")
        if sort_value and (not existing_sort or _prefer_artist_display(sort_value, existing_sort)):
            artist_sort_values[artist_identity] = sort_value

    ordered_artist_ids = sorted(
        rows_by_artist,
        key=lambda artist_identity: (
            artist_sort_values.get(artist_identity, artist_displays.get(artist_identity, artist_identity)).casefold(),
            artist_displays.get(artist_identity, artist_identity).casefold(),
        ),
    )
    return [
        (artist_displays.get(artist_identity, ""), rows_by_artist[artist_identity])
        for artist_identity in ordered_artist_ids
    ]


def _root_sidebar_params(view_state: Mapping[str, object]) -> dict[str, object]:
    visible_categories = [
        str(category or "").strip()
        for category in list(view_state.get("visible_library_categories") or [])
        if str(category or "").strip()
    ]
    all_categories = ["main_library", "hoard", "new_arrivals"]
    filter_categories = [] if visible_categories == all_categories else visible_categories
    return {
        "category_count": len(filter_categories),
        "visible_categories": filter_categories,
    }


def _build_search_filter_state() -> dict[str, object]:
    from music_app.services.view_search import build_search_filter_state

    return build_search_filter_state()


def _build_search_filter_contract() -> dict[str, object]:
    from music_app.services.view_search import build_search_filter_contract

    return build_search_filter_contract()


def _build_search_query_contract() -> dict[str, object]:
    from music_app.services.view_search import build_search_query_contract

    return build_search_query_contract()


def _selected_artist_family_context_from_state(
    selected_artist: str,
    *,
    config: dict[str, object],
    connect: Callable[[str], Any] | None = None,
    alias_to_canonical: Mapping[str, object] | None = None,
    canonical_to_aliases: Mapping[str, object] | None = None,
    connection: Any | None = None,
) -> dict[str, object]:
    artist = str(selected_artist or "").strip()
    if not artist:
        return {
            "family_artists": [],
            "relation_views": {},
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
        }
    artist_family_postgres = __import__(
        "music_app.services.artist_family_postgres",
        fromlist=["load_selected_artist_family_projection"],
    )
    projection_artist = _canonical_artist_name(
        artist,
        alias_to_canonical or {},
    )
    postgres_family_projection = artist_family_postgres.load_selected_artist_family_projection(
        config,
        projection_artist,
        connect=connect,
        connection=connection,
    )
    postgres_alias_to_canonical = {
        str(alias or "").strip(): str(canonical or "").strip()
        for alias, canonical in dict(postgres_family_projection.get("alias_to_canonical") or {}).items()
        if str(alias or "").strip() and str(canonical or "").strip()
    }
    postgres_canonical_to_aliases = {
        str(canonical or "").strip(): [
            str(alias or "").strip()
            for alias in list(aliases or [])
            if str(alias or "").strip()
        ]
        for canonical, aliases in dict(postgres_family_projection.get("canonical_to_aliases") or {}).items()
        if str(canonical or "").strip()
    }
    effective_alias_to_canonical = {
        str(alias or "").strip(): str(canonical or "").strip()
        for alias, canonical in dict(alias_to_canonical or postgres_alias_to_canonical).items()
        if str(alias or "").strip() and str(canonical or "").strip()
    }
    effective_canonical_to_aliases = {
        str(canonical or "").strip(): [
            str(alias or "").strip()
            for alias in list(aliases or [])
            if str(alias or "").strip()
        ]
        for canonical, aliases in dict(
            canonical_to_aliases or postgres_canonical_to_aliases
        ).items()
        if str(canonical or "").strip()
    }
    postgres_family_artists = list(postgres_family_projection.get("family_artists") or [])
    postgres_projection_loaded = bool(postgres_family_projection.get("loaded"))
    family_artists = (
        _membership_selected_artist_family_artists(
            artist,
            postgres_family_artists,
            effective_canonical_to_aliases,
            effective_alias_to_canonical,
        )
        if postgres_projection_loaded and postgres_family_artists
        else []
    )
    return {
        "family_artists": family_artists,
        "relation_views": {},
        "alias_to_canonical": effective_alias_to_canonical,
        "canonical_to_aliases": effective_canonical_to_aliases,
    }


def _queue_display_cover_variants_for_groups(
    config: Mapping[str, object] | None,
    artist_groups: list[dict[str, object]] | None,
    *,
    limit: int = _DISPLAY_COVER_QUEUE_LIMIT,
    priority: str = "background",
) -> None:
    if not isinstance(config, Mapping):
        return
    data_dir = str(config.get("DATA_DIR") or "").strip()
    remaining = max(0, int(limit or 0))
    if not data_dir or remaining <= 0:
        return
    try:
        from music_app.services.covers import queue_cover_display_variant_generation
    except Exception:
        return

    cache_root = Path(data_dir)
    priority_options = (
        {}
        if str(priority or "").strip().casefold() == "background"
        else {"priority": priority}
    )
    seen_cover_paths: set[str] = set()
    for group in list(artist_groups or []):
        if not isinstance(group, Mapping):
            continue
        for album in list(group.get("albums") or []):
            if remaining <= 0:
                return
            if not isinstance(album, Mapping):
                continue
            cover_path = str(album.get("cover_path") or "").strip()
            if not cover_path or cover_path in seen_cover_paths:
                continue
            seen_cover_paths.add(cover_path)
            try:
                queue_cover_display_variant_generation(
                    Path(cover_path),
                    cache_root=cache_root,
                    max_size=_DISPLAY_COVER_VARIANT_SIZE,
                    **priority_options,
                )
            except Exception:
                continue
            remaining -= 1


def _selected_artist_primary_groups(
    selected_artist: str,
    albums: list[dict[str, object]],
    *,
    use_preview_albums: bool,
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
) -> list[dict[str, object]]:
    if not selected_artist or not albums:
        return []
    primary_artist_groups = [{
        "artist": selected_artist,
        "artist_display": _artist_tree_display_value(selected_artist),
        "albums": albums,
        "sections": [] if use_preview_albums else _selected_artist_sections(albums),
    }]
    return _decorate_selected_artist_group_payloads(
        primary_artist_groups,
        alias_to_canonical=alias_to_canonical,
        canonical_to_aliases=canonical_to_aliases,
    )


def _selected_artist_groups_from_existing_groups(
    selected_artist: str,
    artist_groups: list[dict[str, object]],
    *,
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
) -> list[dict[str, object]]:
    target_key = _artist_display_dedupe_key(selected_artist)
    primary_groups = [
        dict(group)
        for group in list(artist_groups or [])
        if _artist_display_dedupe_key(str(group.get("artist") or "").strip()) == target_key
    ]
    return _decorate_selected_artist_group_payloads(
        primary_groups,
        alias_to_canonical=alias_to_canonical,
        canonical_to_aliases=canonical_to_aliases,
    )


def _selected_artist_family_groups_from_preview_rows(
    family_artists: list[str],
    rows: list[object],
    *,
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
) -> list[dict[str, object]]:
    normalized_family_artists = [str(artist or "").strip() for artist in family_artists if str(artist or "").strip()]
    if not normalized_family_artists or not rows:
        return []
    family_album_payloads = _root_album_browse_album_payloads(rows, "", include_artist_members=True)
    if not family_album_payloads:
        return []
    payloads_by_key = {
        str(payload.get("key") or payload.get("album_ref") or "").strip(): payload
        for payload in family_album_payloads
        if str(payload.get("key") or payload.get("album_ref") or "").strip()
    }
    album_objects = [
        SimpleNamespace(**payload)
        for payload in family_album_payloads
        if str(payload.get("key") or payload.get("album_ref") or "").strip()
    ]
    family_artist_groups = _membership_build_artist_membership_groups(
        album_objects,
        normalized_family_artists,
        alias_to_canonical,
        canonical_to_aliases,
        exact_group_matches=True,
        album_serializer=lambda album: dict(payloads_by_key.get(str(getattr(album, "key", "") or "").strip(), {})),
    )
    family_artist_groups = _membership_merge_duplicate_artist_groups(family_artist_groups)
    family_artist_groups = _restore_selected_artist_family_group_labels(
        family_artist_groups,
        normalized_family_artists,
        alias_to_canonical=alias_to_canonical,
    )
    return _decorate_selected_artist_group_payloads(
        family_artist_groups,
        alias_to_canonical=alias_to_canonical,
        canonical_to_aliases=canonical_to_aliases,
    )


def _restore_selected_artist_family_group_labels(
    family_artist_groups: list[dict[str, object]],
    family_artists: list[str],
    *,
    alias_to_canonical: Mapping[str, str] | None = None,
) -> list[dict[str, object]]:
    from music_app.services.selected_artist_membership import collaboration_alias_of

    preferred_by_key = {
        _artist_display_dedupe_key(artist): artist
        for artist in family_artists
        if _artist_display_dedupe_key(artist)
    }
    restored_groups: list[dict[str, object]] = []
    for group in family_artist_groups:
        group_artist = str(group.get("artist") or "").strip()
        canonical_group_artist = str(
            (alias_to_canonical or {}).get(group_artist, group_artist) or ""
        ).strip()
        preferred_artist = preferred_by_key.get(
            _artist_display_dedupe_key(canonical_group_artist)
        )
        if not preferred_artist:
            restored_groups.append(group)
            continue
        if (
            group_artist != canonical_group_artist
            and collaboration_alias_of(group_artist, canonical_group_artist)
        ):
            restored_groups.append(group)
            continue
        restored_group = dict(group)
        restored_group["artist"] = preferred_artist
        restored_group["artist_display"] = preferred_artist
        restored_groups.append(restored_group)
    return restored_groups


def _selected_artist_family_group_filter_key(
    group: Mapping[str, object],
    alias_to_canonical: Mapping[str, str],
    family_artists: Iterable[object],
) -> str:
    group_artist = str(group.get("artist") or "").strip()
    group_key = _artist_display_dedupe_key(group_artist)
    family_artist_keys = {
        _artist_display_dedupe_key(artist)
        for artist in family_artists
        if _artist_display_dedupe_key(artist)
    }
    if group_key in family_artist_keys:
        return group_key
    canonical_artist = str(
        alias_to_canonical.get(group_artist, group_artist) or ""
    ).strip()
    return _artist_display_dedupe_key(canonical_artist)


def _artist_match_rank(query: str, canonical_artist: str, aliases: set[str]) -> tuple[int, int, str]:
    from music_app.services.view_search import artist_match_rank

    return artist_match_rank(query, canonical_artist, aliases)


def _build_legacy_search_context(**kwargs: object) -> dict[str, object] | None:
    from music_app.services.view_search import build_legacy_search_context

    return build_legacy_search_context(**kwargs)


def _build_view_surface_payload(active_surface: str) -> dict[str, object]:
    from music_app.services.playlist_read_seams import build_view_surface_payload

    return build_view_surface_payload(active_surface)


def _build_shell_layout_payload(**kwargs: object) -> dict[str, object]:
    from music_app.services.shell_layout_seams import build_shell_layout_payload

    return build_shell_layout_payload(**kwargs)


def _build_artist_page_seam(artist_ref: object, **kwargs: object) -> dict[str, object]:
    from music_app.services.page_resource_seams import build_artist_page_seam

    return build_artist_page_seam(artist_ref, **kwargs)


def _ensure_relation_views(library_state: dict[str, object], config: dict[str, object]) -> bool:
    from music_app.services.relation_state import ensure_relation_views

    return ensure_relation_views(library_state, config)


def _refresh_relation_views(library_state: dict[str, object], config: dict[str, object]) -> dict[str, object]:
    from music_app.services.relation_state import refresh_relation_views_in_state

    return refresh_relation_views_in_state(library_state, config)


def _get_related_for_artist(
    selected_artist: str,
    relation_views: Mapping[str, object],
    config: dict[str, object],
) -> tuple[list[str], object]:
    from music_app.services.relations import get_related_for_artist

    return get_related_for_artist(selected_artist, relation_views, config)


def _membership_selected_artist_family_artists(
    selected_artist: str,
    related_artists: list[str],
    canonical_to_aliases: dict[str, list[str]],
    alias_to_canonical: dict[str, str],
) -> list[str]:
    from music_app.services.selected_artist_membership import selected_artist_family_artists

    return selected_artist_family_artists(
        selected_artist,
        related_artists,
        canonical_to_aliases,
        alias_to_canonical,
    )


def _membership_build_artist_membership_groups(
    albums: list[object],
    artists: list[str],
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
    **kwargs: object,
) -> list[dict[str, object]]:
    from music_app.services.selected_artist_membership import build_artist_membership_groups

    return build_artist_membership_groups(
        albums,
        artists,
        alias_to_canonical,
        canonical_to_aliases,
        **kwargs,
    )


def _membership_merge_duplicate_artist_groups(
    groups: list[dict[str, object]],
) -> list[dict[str, object]]:
    from music_app.services.selected_artist_membership import merge_duplicate_artist_groups

    return merge_duplicate_artist_groups(groups)


def _decorate_selected_artist_group_payloads(
    artist_groups: list[dict[str, object]],
    *,
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
) -> list[dict[str, object]]:
    from music_app.services.view_payloads import _decorate_selected_artist_group_payloads as decorate

    return decorate(
        artist_groups,
        alias_to_canonical=alias_to_canonical,
        canonical_to_aliases=canonical_to_aliases,
    )


def _selected_artist_family_filter_payloads(
    selected_artist: object,
    family_artists: list[str],
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
) -> list[dict[str, object]]:
    from music_app.services.view_payloads import _selected_artist_family_filter_payloads as build_filters

    return build_filters(
        selected_artist,
        family_artists,
        alias_to_canonical,
        canonical_to_aliases,
    )


def _derive_selected_artist_family_filter_state(
    *,
    family_artists: list[str],
    requested_related_artists: list[str],
    requested_primary_filter: bool,
) -> dict[str, object]:
    from music_app.services.view_payloads import (
        _derive_selected_artist_family_filter_state as build_filter_state,
    )

    return build_filter_state(
        family_artists=family_artists,
        requested_related_artists=requested_related_artists,
        requested_primary_filter=requested_primary_filter,
    )


def _selected_artist_listen_through_scope_candidates(
    *,
    selected_artist: object,
    primary_artist_groups: list[dict[str, object]],
    family_artist_groups: list[dict[str, object]],
    selected_artist_family_filters: list[dict[str, object]],
) -> dict[str, object]:
    from music_app.services.view_payloads import (
        _selected_artist_listen_through_scope_candidates as build_candidates,
    )

    return build_candidates(
        selected_artist=selected_artist,
        primary_artist_groups=primary_artist_groups,
        family_artist_groups=family_artist_groups,
        selected_artist_family_filters=selected_artist_family_filters,
    )


def _selected_artist_visible_artist_names(
    primary_artist_groups: list[dict[str, object]],
    family_artist_groups: list[dict[str, object]],
) -> set[str]:
    from music_app.services.view_payloads import _selected_artist_visible_artist_names as visible_names

    return visible_names(primary_artist_groups, family_artist_groups)


def _selected_artist_included_album_payloads(
    primary_artist_groups: list[dict[str, object]],
    family_artist_groups: list[dict[str, object]],
) -> list[dict[str, object]]:
    from music_app.services.view_payloads import _selected_artist_included_album_payloads as included_payloads

    return included_payloads(primary_artist_groups, family_artist_groups)


def _render_selected_artist_artist_groups(
    primary_artist_groups: list[dict[str, object]],
    family_artist_groups: list[dict[str, object]],
    *,
    family_display_mode: object,
) -> list[dict[str, object]]:
    from music_app.services.view_payloads import _render_selected_artist_artist_groups as render_groups

    return render_groups(
        primary_artist_groups,
        family_artist_groups,
        family_display_mode=family_display_mode,
    )


def _selected_artist_display_name(rows: list[object], fallback: str) -> str:
    grouped_rows = _group_rows_by_artist_identity(rows)
    fallback_key = _artist_display_dedupe_key(fallback)
    if fallback_key:
        for artist_display, _artist_rows in grouped_rows:
            if _artist_display_dedupe_key(artist_display) == fallback_key:
                return artist_display
    if grouped_rows:
        return grouped_rows[0][0]
    return fallback


def _query_param_list(query_params: Mapping[str, object] | None, key: str) -> list[str]:
    if query_params is None:
        return []
    getlist = getattr(query_params, "getlist", None)
    if callable(getlist):
        return [str(value or "").strip() for value in getlist(key) if str(value or "").strip()]
    value = (query_params or {}).get(key)
    if isinstance(value, (list, tuple, set)):
        return [str(item or "").strip() for item in value if str(item or "").strip()]
    text = str(value or "").strip()
    return [text] if text else []


def _selected_artist_album_payloads(rows: list[object], artist_display: str) -> list[dict[str, object]]:
    albums: dict[object, dict[str, object]] = {}
    track_ids_by_album: dict[object, set[object]] = {}
    directory_paths_by_album: dict[object, list[str]] = {}
    seen_directory_paths_by_album: dict[object, set[str]] = {}
    for row in rows:
        row_payload = _row_mapping(row)
        persisted_album_id = row_payload.get("album_id")
        persisted_album_key = str(row_payload.get("album_key") or "").strip()
        if persisted_album_id is None and not persisted_album_key:
            continue
        file_entry = _row_json_mapping(row_payload.get("file_entry"))
        exception_type = _effective_row_exception_type(row_payload)
        if exception_type in NON_ALBUM_EXCEPTION_VALUES.values():
            continue
        album_identity, album_key, album_year = _row_album_identity(row_payload, artist_display)
        if not album_identity:
            continue
        album = albums.get(album_identity)
        if album is None:
            metadata = _row_json_mapping(row_payload.get("album_metadata"))
            root_provenance = _row_json_mapping(metadata.get("root_provenance"))
            raw_album_artist = str(metadata.get("album_artist") or artist_display).strip()
            deduplicated_album_artist_members = deduplicate_repeated_album_artist_members(raw_album_artist)
            album_artist = (
                " / ".join(deduplicated_album_artist_members)
                if deduplicated_album_artist_members
                else raw_album_artist
            )
            artists = metadata.get("artists")
            if not isinstance(artists, list):
                artists = [artist_display] if artist_display else []
            album = {
                "key": album_key,
                "album_ref": album_key,
                "name": str(row_payload.get("album_title") or "").strip(),
                "album_artist": album_artist,
                "artists": [str(artist or "").strip() for artist in artists if str(artist or "").strip()],
                "cover_path": row_payload.get("album_cover_path"),
                "cover_revision": metadata.get("cover_revision"),
                "cover_selection_origin": (
                    str(metadata.get("cover_selection_origin") or "").strip().casefold()
                    if str(metadata.get("cover_selection_origin") or "").strip().casefold()
                    in {"user", "automatic"}
                    else None
                ),
                "local_cover_width": _nullable_int(metadata.get("local_cover_width")),
                "local_cover_height": _nullable_int(metadata.get("local_cover_height")),
                "remote_cover_url": metadata.get("remote_cover_url"),
                "remote_cover_thumbnail_url": metadata.get("remote_cover_thumbnail_url"),
                "remote_cover_source": metadata.get("remote_cover_source"),
                "remote_cover_source_label": metadata.get("remote_cover_source_label"),
                "remote_cover_album_url": metadata.get("remote_cover_album_url"),
                "remote_cover_width": _nullable_int(metadata.get("remote_cover_width")),
                "remote_cover_height": _nullable_int(metadata.get("remote_cover_height")),
                "year": album_year,
                "release_date": metadata.get("release_date"),
                "edition": metadata.get("edition"),
                "root_provenance": dict(root_provenance),
                "library_root_id": row_payload.get("file_library_root_id"),
                "library_root_category": row_payload.get("file_library_root_category"),
                "track_count_preview": 0,
                "total_duration_seconds": 0,
                "total_duration_display": format_duration(0),
                "tracks": [],
                "open_directory_paths": [],
                "preview_only": False,
            }
            albums[album_identity] = album
            track_ids_by_album[album_identity] = set()
            directory_paths_by_album[album_identity] = []
            seen_directory_paths_by_album[album_identity] = set()
        track_id = row_payload.get("track_id")
        track_key = str(row_payload.get("track_key") or "").strip()
        track_identity = track_id if track_id is not None else track_key
        if track_identity and track_identity not in track_ids_by_album[album_identity]:
            duration_seconds = _coerce_duration_seconds(row_payload.get("duration_seconds"))
            track_metadata = _row_json_mapping(row_payload.get("track_metadata"))
            track_ids_by_album[album_identity].add(track_identity)
            track_payload = {
                "key": track_key,
                "track_ref": track_key,
                "title": str(row_payload.get("track_title") or "").strip(),
                "artist": str(
                    file_entry.get("artist")
                    or row_payload.get("track_artist_name")
                    or album.get("album_artist")
                    or artist_display
                ).strip(),
                "album_artist": str(album.get("album_artist") or artist_display).strip(),
                "album": str(album.get("name") or "").strip(),
                "secondary_credit": str(track_metadata.get("secondaryCredit") or "").strip(),
                "genre": str(file_entry.get("genre") or "").strip(),
                "year": file_entry.get("year", album.get("year")),
                "cover_path": album.get("cover_path"),
                "cover_revision": album.get("cover_revision"),
                "disc_number": row_payload.get("disc_number"),
                "disc_number_raw": file_entry.get("disc_number_raw"),
                "track_number": row_payload.get("track_number"),
                "duration_seconds": duration_seconds,
                "duration_display": format_duration(duration_seconds),
                "path": row_payload.get("file_private_path"),
                "track_scrobble_count": int(row_payload.get("track_scrobble_count") or 0),
                "track_preference_overlay": {
                    "rating": row_payload.get("track_preference_rating"),
                    "love_tier": row_payload.get("track_preference_love_tier"),
                },
            }
            if exception_type:
                track_payload["exception_type"] = exception_type
            album["tracks"].append(track_payload)
            album["total_duration_seconds"] = int(album["total_duration_seconds"]) + duration_seconds
        directory_path = _directory_path(row_payload.get("file_private_path"))
        if directory_path and directory_path not in seen_directory_paths_by_album[album_identity]:
            seen_directory_paths_by_album[album_identity].add(directory_path)
            directory_paths_by_album[album_identity].append(directory_path)
    for album_identity, album in albums.items():
        album["tracks"] = sorted(
            list(album["tracks"]),
            key=lambda track: (
                _coerce_int(track.get("disc_number")),
                _coerce_int(track.get("track_number")),
                str(track.get("title") or "").casefold(),
            ),
        )
        album["track_count_preview"] = len(track_ids_by_album[album_identity])
        album["total_duration_display"] = format_duration(int(album["total_duration_seconds"]))
        album["open_directory_paths"] = directory_paths_by_album[album_identity]
    return sorted(
        (album for album in albums.values() if album.get("tracks")),
        key=lambda album: (
            _coerce_int(album.get("year")) if album.get("year") else 9999,
            str(album.get("name") or "").casefold(),
            str(album.get("key") or "").casefold(),
        ),
    )


def _root_album_browse_album_payloads(
    rows: list[object],
    artist_display: str,
    *,
    include_artist_members: bool = False,
    include_total_duration_seconds: bool = False,
) -> list[dict[str, object]]:
    albums: dict[object, dict[str, object]] = {}
    for row in rows:
        row_payload = _row_mapping(row)
        album_id = row_payload.get("album_id")
        album_key = str(row_payload.get("album_key") or "").strip()
        if album_id is None and not album_key:
            continue
        album_identity = album_id if album_id is not None else album_key
        matched_artist = (
            str(row_payload.get("artist_name") or "").strip()
            if include_artist_members
            else ""
        )
        if album_identity in albums:
            if matched_artist:
                existing_artists = albums[album_identity].setdefault("artists", [])
                existing_artist_keys = {
                    _artist_display_dedupe_key(artist)
                    for artist in existing_artists
                    if _artist_display_dedupe_key(artist)
                }
                if _artist_display_dedupe_key(matched_artist) not in existing_artist_keys:
                    existing_artists.append(matched_artist)
            continue
        metadata = _row_json_mapping(row_payload.get("album_metadata"))
        stored_cover_selection_origin = str(
            metadata.get("cover_selection_origin") or ""
        ).strip().casefold()
        raw_album_artist = str(metadata.get("album_artist") or artist_display).strip()
        deduplicated_album_artist_members = deduplicate_repeated_album_artist_members(
            raw_album_artist
        )
        album_artist = (
            " / ".join(deduplicated_album_artist_members)
            if deduplicated_album_artist_members
            else raw_album_artist
        )
        artists = metadata.get("artists")
        if not isinstance(artists, list):
            artists = [album_artist] if album_artist else []
        duration_seconds = _coerce_duration_seconds(row_payload.get("total_duration_seconds"))
        album_payload = {
            "album_id": album_id,
            "key": album_key,
            "name": str(row_payload.get("album_title") or "").strip(),
            "album_artist": album_artist,
            "cover_path": row_payload.get("album_cover_path"),
            "cover_revision": metadata.get("cover_revision"),
            "cover_selection_origin": (
                stored_cover_selection_origin
                if stored_cover_selection_origin in {"user", "automatic"}
                else None
            ),
            "cover_candidate_snapshot": _cover_candidate_snapshot_summary(
                row_payload.get("cover_candidate_snapshot")
            ),
            "year": row_payload.get("album_release_year"),
            "edition": metadata.get("edition"),
            "track_count_preview": _coerce_int(row_payload.get("track_count")),
            "total_duration_display": format_duration(duration_seconds),
            "preview_only": True,
        }
        if include_total_duration_seconds:
            album_payload["total_duration_seconds"] = duration_seconds
        if include_artist_members:
            album_payload["artists"] = [
                str(artist or "").strip()
                for artist in artists
                if str(artist or "").strip()
            ]
            if (
                matched_artist
                and _artist_display_dedupe_key(matched_artist)
                not in {
                    _artist_display_dedupe_key(artist)
                    for artist in album_payload["artists"]
                    if _artist_display_dedupe_key(artist)
                }
            ):
                album_payload["artists"].append(matched_artist)
            album_payload["is_compilation"] = bool(metadata.get("is_compilation"))
            album_payload["release_date"] = metadata.get("release_date")
        albums[album_identity] = album_payload
    return sorted(
        albums.values(),
        key=lambda album: (
            _coerce_int(album.get("year")) if album.get("year") else 9999,
            str(album.get("name") or "").casefold(),
            str(album.get("key") or "").casefold(),
        ),
    )


def _cover_candidate_snapshot_summary(value: object) -> dict[str, object] | None:
    snapshot = _row_json_mapping(value)
    if not snapshot:
        return None
    search_kind = str(snapshot.get("search_kind") or "").strip().casefold()
    automatic_improvement_revision = _coerce_int(
        snapshot.get("automatic_improvement_revision")
    )
    seen_automatic_improvement_revision = _coerce_int(
        snapshot.get("seen_automatic_improvement_revision")
    )
    return {
        "search_kind": search_kind if search_kind in {"automatic", "manual"} else None,
        "automatic_improvement_revision": automatic_improvement_revision,
        "seen_automatic_improvement_revision": seen_automatic_improvement_revision,
        "has_unseen_automatic_improvement": (
            automatic_improvement_revision > seen_automatic_improvement_revision
        ),
    }


def _root_album_browse_artist_groups(rows: list[object]) -> list[dict[str, object]]:
    artist_groups = []
    for artist_display, artist_rows in _group_rows_by_artist_identity(rows):
        albums = _root_album_browse_album_payloads(artist_rows, artist_display)
        if not albums:
            continue
        artist_groups.append(
            {
                "artist": artist_display,
                "artist_display": _artist_tree_display_value(artist_display),
                "albums": albums,
                # The root all-artists grid renders directly from albums and does not
                # consume compatibility sections, so avoid serializing the same album
                # list twice during startup hydration.
                "sections": [],
            }
        )
    return artist_groups


def _album_payloads_from_groups(
    artist_groups: Iterable[Mapping[str, object]],
) -> list[dict[str, object]]:
    albums: list[dict[str, object]] = []
    seen_album_objects: set[int] = set()
    for group in artist_groups:
        for album in group.get("albums") or []:
            if not isinstance(album, dict) or id(album) in seen_album_objects:
                continue
            seen_album_objects.add(id(album))
            albums.append(album)
    return albums


def _search_artist_group_sort_key(artist_display: str, *, query: str) -> tuple[object, ...]:
    artist = str(artist_display or "").strip()
    return (
        _artist_match_rank(query, artist, set()),
        artist.casefold(),
    )


def _search_artist_groups(rows: list[object], *, query: str = "") -> list[dict[str, object]]:
    artist_groups = []
    grouped_rows = sorted(
        _group_rows_by_artist_identity(rows),
        key=lambda grouped: _search_artist_group_sort_key(grouped[0], query=query),
    )
    for artist_display, artist_rows in grouped_rows:
        albums = _root_album_browse_album_payloads(
            artist_rows,
            artist_display,
            include_total_duration_seconds=True,
        )
        if not albums:
            continue
        artist_groups.append(
            {
                "artist": artist_display,
                "artist_display": _artist_tree_display_value(artist_display),
                "albums": albums,
                # Query-scoped gallery results only need preview cards; they do not
                # consume duplicate section payloads during the initial render.
                "sections": [],
            }
        )
    return artist_groups


def _top_search_selected_artist(artist_groups: list[dict[str, object]], *, query: str) -> str:
    if not str(query or "").strip():
        return ""
    for group in artist_groups:
        artist = str(group.get("artist") or "").strip()
        if artist:
            return artist
    return ""


def _artists_sidebar_from_groups(artist_groups: list[dict[str, object]]) -> list[dict[str, object]]:
    return [
        {
            "artist": str(group.get("artist") or "").strip(),
            "artist_display": _artist_tree_display_value(
                group.get("artist_display") or group.get("artist")
            ),
            "count": len(group.get("albums") or []),
        }
        for group in artist_groups
        if str(group.get("artist") or "").strip()
    ]


def _merge_artist_groups_for_sidebar(
    primary_groups: list[dict[str, object]],
    extra_groups: list[dict[str, object]],
) -> list[dict[str, object]]:
    merged: list[dict[str, object]] = []
    seen_keys: set[str] = set()
    for group in [*list(primary_groups or []), *list(extra_groups or [])]:
        artist = str(group.get("artist") or "").strip()
        if not artist:
            continue
        artist_key = _artist_display_dedupe_key(artist)
        if artist_key in seen_keys:
            continue
        seen_keys.add(artist_key)
        merged.append(group)
    return merged


def _directory_path(value: object) -> str:
    path = str(value or "").strip()
    if not path:
        return ""
    last_separator = max(path.rfind("\\"), path.rfind("/"))
    return path[:last_separator] if last_separator > 0 else ""


def _selected_artist_sections(albums: list[dict[str, object]]) -> list[dict[str, object]]:
    return [{"title": "Albums", "albums": albums}] if albums else []


def _selected_artist_playback_context(albums: list[dict[str, object]]) -> dict[str, object] | None:
    if not gallery_has_playable_albums(albums):
        return None
    return build_gallery_playback_context(
        kind="artist_page",
        ordered_albums=albums,
    )


def _selected_artist_family_display_mode(query_params: Mapping[str, object] | None) -> str:
    value = (query_params or {}).get("selected_artist_family_display_mode") or (query_params or {}).get("family_display")
    normalized = str(value or "").strip().casefold()
    return normalized if normalized == "chronological" else "grouped"


def _build_artist_page_gallery_payload(artist_ref: str) -> dict[str, object]:
    return {
        "artist_ref": artist_ref,
        "payload_source": "top_level_selected_artist_payload",
        "artist_groups_field": "artist_groups",
        "primary_artist_groups_field": "primary_artist_groups",
        "family_artist_groups_field": "family_artist_groups",
        "related_artists_field": "related_artists",
        "artist_family_filters_field": "artist_family_filters",
        "album_count_field": "album_count",
        "artist_count_field": "artist_count",
        "playback_context_field": "playback_context",
        "listen_through_scope_candidates_field": "listen_through_scope_candidates",
    }


def _visible_album_clause(album_ref: str) -> str:
    return f"""
             %(category_count)s = 0
             or ({album_ref}.metadata #>> '{{root_provenance,primary_category}}') = any(%(visible_categories)s::text[])
             or exists (
               select 1
               from jsonb_array_elements_text(
                 coalesce(
                   {album_ref}.metadata #> '{{root_provenance,categories}}',
                   '[]'::jsonb
                 )
               ) as root_categories(category)
               where root_categories.category = any(%(visible_categories)s::text[])
             )
             or (
               'main_library' = any(%(visible_categories)s::text[])
               and coalesce({album_ref}.metadata #>> '{{root_provenance,primary_category}}', '') = ''
               and coalesce(
                 jsonb_array_length(
                   coalesce(
                     {album_ref}.metadata #> '{{root_provenance,categories}}',
                     '[]'::jsonb
                   )
                 ),
                 0
               ) = 0
             )
    """.strip()


def _eligible_album_tracks_cte_sql(
    *,
    materialized: bool = True,
    candidate_albums_only: bool = False,
) -> str:
    materialization = "materialized" if materialized else "not materialized"
    candidate_album_join = (
        """
          join search_candidate_album_ids
            on search_candidate_album_ids.library_id = library.local_tracks.library_id
           and search_candidate_album_ids.album_id = library.local_tracks.album_id
        """.rstrip()
        if candidate_albums_only
        else ""
    )
    return f"""
        track_override_defaults as materialized (
          select distinct on (
            library.exception_overrides.library_id,
            library.exception_overrides.track_id
          )
            library.exception_overrides.library_id,
            library.exception_overrides.track_id,
            library.exception_overrides.override_payload
          from library.exception_overrides
          where library.exception_overrides.track_id is not null
          order by
            library.exception_overrides.library_id,
            library.exception_overrides.track_id,
            library.exception_overrides.id
        ),
        eligible_album_tracks as {materialization} (
          select
            library.local_tracks.library_id,
            library.local_tracks.album_id,
            library.local_tracks.id as track_id,
            max(library.local_tracks.duration_seconds) as duration_seconds
          from library.local_tracks
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
{candidate_album_join}
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and library.local_track_files.scan_cache_stale is false
          left join library.exception_overrides as path_override
            on path_override.library_id = library.local_tracks.library_id
           and path_override.track_key = library.local_track_files.private_path
          left join track_override_defaults as track_override
            on track_override.library_id = library.local_tracks.library_id
           and track_override.track_id = library.local_tracks.id
           and path_override.id is null
          where lower(btrim(coalesce(
            case
              when path_override.override_payload ? 'exception_type'
              then path_override.override_payload ->> 'exception_type'
              when track_override.override_payload ? 'exception_type'
              then track_override.override_payload ->> 'exception_type'
              else library.local_track_files.metadata
                #>> '{{scan_cache,file_entry,exception_type}}'
            end,
            ''
          ))) <> 'non-album rarity'
          group by
            library.local_tracks.library_id,
            library.local_tracks.album_id,
            library.local_tracks.id
        )
    """.strip()


def _root_sidebar_sql() -> str:
    return f"""
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        {_eligible_album_tracks_cte_sql()},
        artist_album_rows as (
          select distinct
            library.local_artists.id as artist_id,
            library.local_artists.name as artist_name,
            coalesce(nullif(library.local_artists.sort_name, ''), library.local_artists.name) as sort_name,
            library.local_albums.id as album_id
          from library.local_artists
          join bootstrap_context
            on bootstrap_context.library_id = library.local_artists.library_id
          join library.local_album_featured_artists
            on library.local_album_featured_artists.library_id = library.local_artists.library_id
           and library.local_album_featured_artists.artist_id = library.local_artists.id
          join library.local_albums
            on library.local_albums.id = library.local_album_featured_artists.album_id
           and ({_visible_album_clause("library.local_albums")})
          join eligible_album_tracks
            on eligible_album_tracks.library_id = library.local_albums.library_id
           and eligible_album_tracks.album_id = library.local_albums.id
        )
        select
          artist_id,
          min(artist_name) as artist_name,
          min(sort_name) as sort_name,
          array_agg(distinct album_id order by album_id) as album_ids,
          count(distinct album_id)::integer as album_count
        from artist_album_rows
        group by artist_id
        order by
          coalesce(min(nullif(sort_name, '')), min(artist_name)),
          min(artist_name);
    """


def _selected_artist_sql() -> str:
    return f"""
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        target_artists as (
          select
            library.local_artists.id,
            library.local_artists.library_id,
            library.local_artists.name,
            library.local_artists.sort_name
          from library.local_artists
          join bootstrap_context
            on bootstrap_context.library_id = library.local_artists.library_id
          where library.local_artists.artist_key = any(%(artist_keys)s::text[])
        ),
        selected_artist_albums as (
          select distinct
            target_artists.id as artist_id,
            target_artists.name as artist_name,
            target_artists.sort_name as artist_sort_name,
            library.local_albums.library_id,
            library.local_albums.id as album_id,
            library.local_albums.album_key,
            library.local_albums.title as album_title,
            library.local_albums.release_year as album_release_year,
            library.local_albums.cover_path as album_cover_path,
            library.local_albums.metadata as album_metadata
          from target_artists
          join library.local_album_featured_artists
            on library.local_album_featured_artists.library_id = target_artists.library_id
           and library.local_album_featured_artists.artist_id = target_artists.id
          join library.local_albums
            on library.local_albums.id = library.local_album_featured_artists.album_id
           and ({_visible_album_clause("library.local_albums")})
        )
        select
          selected_artist_albums.artist_id,
          selected_artist_albums.artist_name,
          selected_artist_albums.artist_sort_name,
          selected_artist_albums.album_id,
          selected_artist_albums.album_key,
          selected_artist_albums.album_title,
          selected_artist_albums.album_release_year,
          selected_artist_albums.album_cover_path,
          selected_artist_albums.album_metadata,
          library.local_tracks.id as track_id,
          library.local_tracks.track_key,
          library.local_tracks.title as track_title,
          library.local_tracks.disc_number,
          library.local_tracks.track_number,
          library.local_tracks.duration_seconds,
          library.local_track_files.private_path as file_private_path,
          library.local_track_files.metadata #> '{{scan_cache,file_entry}}' as file_entry,
          library.local_track_files.library_root_id as file_library_root_id,
          library.local_track_files.metadata ->> 'library_root_category' as file_library_root_category,
          exception_override.override_payload ->> 'exception_type' as exception_type,
          coalesce(
            exception_override.override_payload ? 'exception_type',
            false
          ) as exception_override_present
        from selected_artist_albums
        left join library.local_tracks
          on library.local_tracks.library_id = selected_artist_albums.library_id
         and library.local_tracks.album_id = selected_artist_albums.album_id
        left join library.local_track_files
          on library.local_track_files.track_id = library.local_tracks.id
         and coalesce((library.local_track_files.metadata #>> '{{scan_cache,stale}}')::boolean, false) is false
        left join lateral (
          select library.exception_overrides.override_payload
          from library.exception_overrides
          where library.exception_overrides.library_id = selected_artist_albums.library_id
            and (
              library.exception_overrides.track_key = library.local_track_files.private_path
              or library.exception_overrides.track_id = library.local_tracks.id
            )
          order by
            case
              when library.exception_overrides.track_key = library.local_track_files.private_path then 0
              when library.exception_overrides.track_id = library.local_tracks.id then 1
              else 2
            end,
            library.exception_overrides.id
          limit 1
        ) exception_override on true
        order by
          selected_artist_albums.album_release_year nulls last,
          selected_artist_albums.album_title,
          selected_artist_albums.album_key,
          library.local_tracks.disc_number nulls last,
          library.local_tracks.track_number nulls last,
          library.local_tracks.title,
          library.local_tracks.track_key;
    """


def _album_detail_sql() -> str:
    return """
        with bootstrap_context as (
          select
            library.libraries.id as library_id,
            app.bootstrap_owners.account_id as account_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        scrobble_counts as (
          select
            integration.listen_history.track_key,
            count(*)::int as scrobble_count
          from integration.listen_history
          join bootstrap_context
            on bootstrap_context.library_id = integration.listen_history.library_id
           and bootstrap_context.account_id = integration.listen_history.account_id
          where integration.listen_history.source_family in (
            'runtime_listen_history_adapter',
            'phase_6_json_file_backfill'
          )
            and integration.listen_history.scrobble_status = 'scrobbled'
          group by integration.listen_history.track_key
        ),
        track_preferences as (
          select
            app.track_preferences.track_key,
            app.track_preferences.rating,
            app.track_preferences.love_tier
          from app.track_preferences
          join bootstrap_context
            on bootstrap_context.library_id = app.track_preferences.library_id
           and bootstrap_context.account_id = app.track_preferences.account_id
        ),
        ignored_repair_rollup as (
          select
            library.local_track_files.private_path as file_private_path,
            array_agg(
              library.ignored_repairs.repair_key
              order by library.ignored_repairs.repair_key
            ) as ignored_repair_keys
          from library.local_track_files
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
          join library.local_albums
            on library.local_albums.id = library.local_tracks.album_id
           and library.local_albums.library_id = library.local_tracks.library_id
          join library.ignored_repairs
            on library.ignored_repairs.library_id = library.local_albums.library_id
           and (
                (
                  library.ignored_repairs.repair_key ~ '::problem-album::[^:]+$'
                  and library.local_albums.album_key = nullif(
                    library.ignored_repairs.metadata ->> 'album_key',
                    ''
                  )
                )
                or (
                  library.ignored_repairs.repair_key !~ '::problem-album::[^:]+$'
                  and library.local_track_files.private_path = split_part(library.ignored_repairs.repair_key, '::', 1)
                )
           )
          where library.local_albums.album_key = %(album_key)s
            and library.local_track_files.scan_cache_stale is false
          group by library.local_track_files.private_path
        )
        select
          library.local_artists.id as artist_id,
          coalesce(
            nullif(library.local_albums.metadata ->> 'album_artist', ''),
            library.local_artists.name
          ) as artist_name,
          library.local_artists.sort_name as artist_sort_name,
          library.local_albums.id as album_id,
          library.local_albums.album_key,
          library.local_albums.title as album_title,
          library.local_albums.release_year as album_release_year,
          library.local_albums.cover_path as album_cover_path,
          library.local_albums.metadata as album_metadata,
          case
            when cover_candidate_snapshots.album_id is null then null
            else jsonb_build_object(
              'search_kind', cover_candidate_snapshots.search_kind,
              'automatic_improvement_revision',
                cover_candidate_snapshots.automatic_improvement_revision,
              'seen_automatic_improvement_revision',
                cover_candidate_snapshots.seen_automatic_improvement_revision
            )
          end as cover_candidate_snapshot,
          library.local_tracks.id as track_id,
          library.local_tracks.track_key,
          library.local_tracks.title as track_title,
          library.local_tracks.metadata as track_metadata,
          track_artists.name as track_artist_name,
          library.local_tracks.disc_number,
          library.local_tracks.track_number,
          library.local_tracks.duration_seconds,
          library.local_track_files.private_path as file_private_path,
          library.local_track_files.metadata #> '{scan_cache,file_entry}' as file_entry,
          library.local_track_files.library_root_id as file_library_root_id,
          library.local_track_files.metadata ->> 'library_root_category' as file_library_root_category,
          exception_override.override_payload ->> 'exception_type' as exception_type,
          coalesce(
            exception_override.override_payload ? 'exception_type',
            false
          ) as exception_override_present,
          coalesce(
            ignored_repair_rollup.ignored_repair_keys,
            array[]::text[]
          ) as ignored_repair_keys,
          coalesce(scrobble_counts.scrobble_count, 0) as track_scrobble_count,
          track_preferences.rating as track_preference_rating,
          track_preferences.love_tier as track_preference_love_tier
        from library.local_albums
        join bootstrap_context
          on bootstrap_context.library_id = library.local_albums.library_id
        join library.local_artists
          on library.local_artists.library_id = library.local_albums.library_id
         and library.local_artists.id = library.local_albums.artist_id
        left join library.local_album_cover_candidate_snapshots cover_candidate_snapshots
          on cover_candidate_snapshots.album_id = library.local_albums.id
        left join library.local_tracks
          on library.local_tracks.library_id = library.local_albums.library_id
         and library.local_tracks.album_id = library.local_albums.id
        left join library.local_artists track_artists
          on track_artists.library_id = library.local_tracks.library_id
         and track_artists.id = library.local_tracks.artist_id
        left join library.local_track_files
          on library.local_track_files.track_id = library.local_tracks.id
         and coalesce((library.local_track_files.metadata #>> '{{scan_cache,stale}}')::boolean, false) is false
        left join lateral (
          select library.exception_overrides.override_payload
          from library.exception_overrides
          where library.exception_overrides.library_id = bootstrap_context.library_id
            and (
              library.exception_overrides.track_key = library.local_track_files.private_path
              or library.exception_overrides.track_id = library.local_tracks.id
            )
          order by
            case
              when library.exception_overrides.track_key = library.local_track_files.private_path then 0
              when library.exception_overrides.track_id = library.local_tracks.id then 1
              else 2
            end,
            library.exception_overrides.id
          limit 1
        ) exception_override on true
        left join scrobble_counts
          on scrobble_counts.track_key = library.local_tracks.track_key
        left join track_preferences
          on track_preferences.track_key = library.local_tracks.track_key
        left join ignored_repair_rollup
          on ignored_repair_rollup.file_private_path = library.local_track_files.private_path
        where library.local_albums.album_key = %(album_key)s
        order by
          library.local_tracks.disc_number nulls last,
          library.local_tracks.track_number nulls last,
          library.local_tracks.title,
          library.local_tracks.track_key;
    """


def _root_album_browse_sql() -> str:
    return f"""
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        {_eligible_album_tracks_cte_sql()},
        album_rows as (
          select distinct
            library.local_artists.id as artist_id,
            library.local_artists.name as artist_name,
            library.local_artists.sort_name as artist_sort_name,
            library.local_albums.library_id,
            library.local_albums.id as album_id,
            library.local_albums.album_key,
            library.local_albums.title as album_title,
            library.local_albums.release_year as album_release_year,
            library.local_albums.cover_path as album_cover_path,
            library.local_albums.metadata as album_metadata
          from library.local_artists
          join bootstrap_context
            on bootstrap_context.library_id = library.local_artists.library_id
          join library.local_album_featured_artists
            on library.local_album_featured_artists.library_id = library.local_artists.library_id
           and library.local_album_featured_artists.artist_id = library.local_artists.id
          join library.local_albums
            on library.local_albums.id = library.local_album_featured_artists.album_id
           and ({_visible_album_clause("library.local_albums")})
          join eligible_album_tracks
            on eligible_album_tracks.library_id = library.local_albums.library_id
           and eligible_album_tracks.album_id = library.local_albums.id
        ),
        track_rollups as (
          select
            eligible_album_tracks.album_id,
            count(distinct eligible_album_tracks.track_id)::integer as track_count,
            coalesce(sum(eligible_album_tracks.duration_seconds), 0)::integer as total_duration_seconds
          from eligible_album_tracks
          join album_rows
            on album_rows.library_id = eligible_album_tracks.library_id
           and album_rows.album_id = eligible_album_tracks.album_id
          group by eligible_album_tracks.album_id
        )
        select
          album_rows.artist_id,
          album_rows.artist_name,
          album_rows.artist_sort_name,
          album_rows.album_id,
          album_rows.album_key,
          album_rows.album_title,
          album_rows.album_release_year,
          album_rows.album_cover_path,
          album_rows.album_metadata,
          case
            when cover_candidate_snapshots.album_id is null then null
            else jsonb_build_object(
              'search_kind', cover_candidate_snapshots.search_kind,
              'automatic_improvement_revision',
                cover_candidate_snapshots.automatic_improvement_revision,
              'seen_automatic_improvement_revision',
                cover_candidate_snapshots.seen_automatic_improvement_revision
            )
          end as cover_candidate_snapshot,
          coalesce(track_rollups.track_count, 0) as track_count,
          coalesce(track_rollups.total_duration_seconds, 0) as total_duration_seconds
        from album_rows
        left join track_rollups
          on track_rollups.album_id = album_rows.album_id
        left join library.local_album_cover_candidate_snapshots cover_candidate_snapshots
          on cover_candidate_snapshots.album_id = album_rows.album_id
        order by
          coalesce(
            nullif(album_rows.artist_sort_name, ''),
            album_rows.artist_name
          ),
          album_rows.artist_name,
          album_rows.album_release_year nulls last,
          album_rows.album_title,
          album_rows.album_key;
    """


def _root_startup_payload_sql(artist_limit: int) -> str:
    normalized_artist_limit = max(1, int(artist_limit or 0))
    return f"""
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        track_override_defaults as materialized (
          select distinct on (
            library.exception_overrides.library_id,
            library.exception_overrides.track_id
          )
            library.exception_overrides.library_id,
            library.exception_overrides.track_id,
            library.exception_overrides.override_payload
          from library.exception_overrides
          where library.exception_overrides.track_id is not null
          order by
            library.exception_overrides.library_id,
            library.exception_overrides.track_id,
            library.exception_overrides.id
        ),
        eligible_album_ids as materialized (
          select distinct
            library.local_tracks.library_id,
            library.local_tracks.album_id
          from library.local_tracks
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and library.local_track_files.scan_cache_stale is false
          left join library.exception_overrides as path_override
            on path_override.library_id = library.local_tracks.library_id
           and path_override.track_key = library.local_track_files.private_path
          left join track_override_defaults as track_override
            on track_override.library_id = library.local_tracks.library_id
           and track_override.track_id = library.local_tracks.id
           and path_override.id is null
          where lower(btrim(coalesce(
            case
              when path_override.override_payload ? 'exception_type'
              then path_override.override_payload ->> 'exception_type'
              when track_override.override_payload ? 'exception_type'
              then track_override.override_payload ->> 'exception_type'
              else library.local_track_files.metadata
                #>> '{{scan_cache,file_entry,exception_type}}'
            end,
            ''
          ))) <> 'non-album rarity'
        ),
        artist_album_rows as materialized (
          select distinct
            library.local_artists.id as artist_id,
            library.local_artists.library_id,
            library.local_artists.name as artist_name,
            coalesce(
              nullif(library.local_artists.sort_name, ''),
              library.local_artists.name
            ) as sort_name,
            coalesce(
              nullif(
                %(alias_to_canonical)s::jsonb ->> library.local_artists.name,
                ''
              ),
              library.local_artists.name
            ) as canonical_artist_name,
            library.local_albums.id as album_id
          from library.local_artists
          join bootstrap_context
            on bootstrap_context.library_id = library.local_artists.library_id
          join library.local_album_featured_artists
            on library.local_album_featured_artists.library_id = library.local_artists.library_id
           and library.local_album_featured_artists.artist_id = library.local_artists.id
          join library.local_albums
            on library.local_albums.id = library.local_album_featured_artists.album_id
           and ({_visible_album_clause("library.local_albums")})
          join eligible_album_ids
            on eligible_album_ids.library_id = library.local_albums.library_id
           and eligible_album_ids.album_id = library.local_albums.id
        ),
        root_sidebar_rows as (
          select
            artist_album_rows.artist_id,
            min(artist_album_rows.artist_name) as artist_name,
            min(artist_album_rows.sort_name) as sort_name,
            array_agg(
              distinct artist_album_rows.album_id
              order by artist_album_rows.album_id
            ) as album_ids,
            count(distinct artist_album_rows.album_id)::integer as album_count
          from artist_album_rows
          group by artist_album_rows.artist_id
        ),
        visible_artists as (
          select distinct
            artist_album_rows.artist_id,
            artist_album_rows.library_id,
            artist_album_rows.artist_name,
            artist_album_rows.sort_name as artist_sort_name,
            artist_album_rows.canonical_artist_name
          from artist_album_rows
        ),
        canonical_artist_sort_values as (
          select
            visible_artists.canonical_artist_name,
            min(coalesce(nullif(visible_artists.artist_sort_name, ''), visible_artists.canonical_artist_name)) as canonical_sort_name
          from visible_artists
          group by visible_artists.canonical_artist_name
        ),
        ranked_canonical_artists as (
          select
            canonical_artist_sort_values.*,
            dense_rank() over (
              order by
                lower(canonical_artist_sort_values.canonical_sort_name),
                canonical_artist_sort_values.canonical_sort_name,
                lower(canonical_artist_sort_values.canonical_artist_name),
                canonical_artist_sort_values.canonical_artist_name
            ) as canonical_artist_rank
          from canonical_artist_sort_values
        ),
        preview_artists as (
          select visible_artists.*
          from visible_artists
          join ranked_canonical_artists
            on ranked_canonical_artists.canonical_artist_name = visible_artists.canonical_artist_name
          where ranked_canonical_artists.canonical_artist_rank <= {normalized_artist_limit}
        ),
        matched_album_rows as (
          select distinct
            preview_artists.artist_id,
            preview_artists.artist_name,
            preview_artists.artist_sort_name,
            library.local_albums.library_id,
            library.local_albums.id as album_id,
            library.local_albums.album_key,
            library.local_albums.title as album_title,
            library.local_albums.release_year as album_release_year,
            library.local_albums.cover_path as album_cover_path,
            library.local_albums.metadata as album_metadata
          from preview_artists
          join library.local_album_featured_artists
            on library.local_album_featured_artists.library_id = preview_artists.library_id
           and library.local_album_featured_artists.artist_id = preview_artists.artist_id
          join library.local_albums
            on library.local_albums.id = library.local_album_featured_artists.album_id
           and ({_visible_album_clause("library.local_albums")})
        ),
        preview_eligible_album_tracks as materialized (
          select
            library.local_tracks.library_id,
            library.local_tracks.album_id,
            library.local_tracks.id as track_id,
            max(library.local_tracks.duration_seconds) as duration_seconds
          from library.local_tracks
          join matched_album_rows
            on matched_album_rows.library_id = library.local_tracks.library_id
           and matched_album_rows.album_id = library.local_tracks.album_id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and library.local_track_files.scan_cache_stale is false
          left join library.exception_overrides as path_override
            on path_override.library_id = library.local_tracks.library_id
           and path_override.track_key = library.local_track_files.private_path
          left join track_override_defaults as track_override
            on track_override.library_id = library.local_tracks.library_id
           and track_override.track_id = library.local_tracks.id
           and path_override.id is null
          where lower(btrim(coalesce(
            case
              when path_override.override_payload ? 'exception_type'
              then path_override.override_payload ->> 'exception_type'
              when track_override.override_payload ? 'exception_type'
              then track_override.override_payload ->> 'exception_type'
              else library.local_track_files.metadata
                #>> '{{scan_cache,file_entry,exception_type}}'
            end,
            ''
          ))) <> 'non-album rarity'
          group by
            library.local_tracks.library_id,
            library.local_tracks.album_id,
            library.local_tracks.id
        ),
        track_rollups as (
          select
            preview_eligible_album_tracks.album_id,
            count(distinct preview_eligible_album_tracks.track_id)::integer as track_count,
            coalesce(
              sum(preview_eligible_album_tracks.duration_seconds),
              0
            )::integer as total_duration_seconds
          from preview_eligible_album_tracks
          group by preview_eligible_album_tracks.album_id
        ),
        preview_rows as (
          select
            matched_album_rows.artist_id,
            matched_album_rows.artist_name,
            matched_album_rows.artist_sort_name,
            matched_album_rows.album_id,
            matched_album_rows.album_key,
            matched_album_rows.album_title,
            matched_album_rows.album_release_year,
            matched_album_rows.album_cover_path,
            matched_album_rows.album_metadata,
            coalesce(track_rollups.track_count, 0) as track_count,
            coalesce(
              track_rollups.total_duration_seconds,
              0
            ) as total_duration_seconds
          from matched_album_rows
          left join track_rollups
            on track_rollups.album_id = matched_album_rows.album_id
        )
        select
          (
            select coalesce(
              jsonb_agg(
                to_jsonb(root_sidebar_rows)
                order by
                  root_sidebar_rows.sort_name,
                  root_sidebar_rows.artist_name
              ),
              '[]'::jsonb
            )
            from root_sidebar_rows
          ) as root_sidebar_rows,
          (
            select coalesce(
              jsonb_agg(
                to_jsonb(preview_rows)
                order by
                  coalesce(
                    nullif(preview_rows.artist_sort_name, ''),
                    preview_rows.artist_name
                  ),
                  preview_rows.artist_name,
                  preview_rows.album_release_year nulls last,
                  preview_rows.album_title,
                  preview_rows.album_key
              ),
              '[]'::jsonb
            )
            from preview_rows
          ) as preview_rows;
    """


def _exact_artist_match_sql() -> str:
    return f"""
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        {_eligible_album_tracks_cte_sql(materialized=False)},
        visible_artists as (
          select distinct
            library.local_artists.id,
            library.local_artists.artist_key,
            library.local_artists.name
          from library.local_artists
          join bootstrap_context
            on bootstrap_context.library_id = library.local_artists.library_id
          join library.local_album_featured_artists
            on library.local_album_featured_artists.library_id = library.local_artists.library_id
           and library.local_album_featured_artists.artist_id = library.local_artists.id
          join library.local_albums
            on library.local_albums.id = library.local_album_featured_artists.album_id
           and ({_visible_album_clause("library.local_albums")})
          join eligible_album_tracks
            on eligible_album_tracks.library_id = library.local_albums.library_id
           and eligible_album_tracks.album_id = library.local_albums.id
        )
        select visible_artists.name as artist_name
        from visible_artists
        where visible_artists.artist_key = %(artist_key)s
           or lower(visible_artists.name) = lower(%(artist_name)s)
        order by case when visible_artists.artist_key = %(artist_key)s then 0 else 1 end
        limit 1;
    """


def _selected_artist_preview_sql() -> str:
    return f"""
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        {_eligible_album_tracks_cte_sql()},
        target_artists as (
          select
            library.local_artists.id,
            library.local_artists.library_id,
            library.local_artists.name,
            library.local_artists.sort_name
          from library.local_artists
          join bootstrap_context
            on bootstrap_context.library_id = library.local_artists.library_id
          where library.local_artists.artist_key = any(%(artist_keys)s::text[])
        ),
        matched_album_rows as (
          select distinct
            target_artists.id as artist_id,
            target_artists.name as artist_name,
            target_artists.sort_name as artist_sort_name,
            library.local_albums.library_id,
            library.local_albums.id as album_id,
            library.local_albums.album_key,
            library.local_albums.title as album_title,
            library.local_albums.release_year as album_release_year,
            library.local_albums.cover_path as album_cover_path,
            library.local_albums.metadata as album_metadata
          from target_artists
          join library.local_album_featured_artists
            on library.local_album_featured_artists.library_id = target_artists.library_id
           and library.local_album_featured_artists.artist_id = target_artists.id
          join library.local_albums
            on library.local_albums.id = library.local_album_featured_artists.album_id
           and ({_visible_album_clause("library.local_albums")})
          join eligible_album_tracks
            on eligible_album_tracks.library_id = library.local_albums.library_id
           and eligible_album_tracks.album_id = library.local_albums.id
        ),
        track_rollups as (
          select
            eligible_album_tracks.album_id,
            count(distinct eligible_album_tracks.track_id)::integer as track_count,
            coalesce(sum(eligible_album_tracks.duration_seconds), 0)::integer as total_duration_seconds
          from eligible_album_tracks
          join matched_album_rows
            on matched_album_rows.library_id = eligible_album_tracks.library_id
           and matched_album_rows.album_id = eligible_album_tracks.album_id
          group by eligible_album_tracks.album_id
        )
        select
          matched_album_rows.artist_id,
          matched_album_rows.artist_name,
          matched_album_rows.artist_sort_name,
          matched_album_rows.album_id,
          matched_album_rows.album_key,
          matched_album_rows.album_title,
          matched_album_rows.album_release_year,
          matched_album_rows.album_cover_path,
          matched_album_rows.album_metadata,
          coalesce(track_rollups.track_count, 0) as track_count,
          coalesce(track_rollups.total_duration_seconds, 0) as total_duration_seconds
        from matched_album_rows
        left join track_rollups
          on track_rollups.album_id = matched_album_rows.album_id
        order by
          matched_album_rows.album_release_year nulls last,
          matched_album_rows.album_title,
          matched_album_rows.album_key;
    """


def _artist_preview_rows_sql() -> str:
    return f"""
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        target_artists as (
          select
            library.local_artists.id,
            library.local_artists.library_id,
            library.local_artists.name,
            library.local_artists.sort_name
          from library.local_artists
          join bootstrap_context
            on bootstrap_context.library_id = library.local_artists.library_id
          where library.local_artists.artist_key = any(%(artist_keys)s::text[])
        ),
        search_candidate_album_ids as materialized (
          select distinct
            library.local_albums.library_id,
            library.local_albums.id as album_id
          from target_artists
          join library.local_album_featured_artists
            on library.local_album_featured_artists.library_id = target_artists.library_id
           and library.local_album_featured_artists.artist_id = target_artists.id
          join library.local_albums
            on library.local_albums.id = library.local_album_featured_artists.album_id
           and ({_visible_album_clause("library.local_albums")})
        ),
        {_eligible_album_tracks_cte_sql(candidate_albums_only=True)},
        matched_album_rows as (
          select distinct
            target_artists.id as artist_id,
            target_artists.name as artist_name,
            target_artists.sort_name as artist_sort_name,
            library.local_albums.library_id,
            library.local_albums.id as album_id,
            library.local_albums.album_key,
            library.local_albums.title as album_title,
            library.local_albums.release_year as album_release_year,
            library.local_albums.cover_path as album_cover_path,
            library.local_albums.metadata as album_metadata
          from target_artists
          join library.local_album_featured_artists
            on library.local_album_featured_artists.library_id = target_artists.library_id
           and library.local_album_featured_artists.artist_id = target_artists.id
          join library.local_albums
            on library.local_albums.id = library.local_album_featured_artists.album_id
           and ({_visible_album_clause("library.local_albums")})
          join eligible_album_tracks
            on eligible_album_tracks.library_id = library.local_albums.library_id
           and eligible_album_tracks.album_id = library.local_albums.id
        ),
        track_rollups as (
          select
            eligible_album_tracks.album_id,
            count(distinct eligible_album_tracks.track_id)::integer as track_count,
            coalesce(sum(eligible_album_tracks.duration_seconds), 0)::integer as total_duration_seconds
          from eligible_album_tracks
          join matched_album_rows
            on matched_album_rows.library_id = eligible_album_tracks.library_id
           and matched_album_rows.album_id = eligible_album_tracks.album_id
          group by eligible_album_tracks.album_id
        )
        select
          matched_album_rows.artist_id,
          matched_album_rows.artist_name,
          matched_album_rows.artist_sort_name,
          matched_album_rows.album_id,
          matched_album_rows.album_key,
          matched_album_rows.album_title,
          matched_album_rows.album_release_year,
          matched_album_rows.album_cover_path,
          matched_album_rows.album_metadata,
          coalesce(track_rollups.track_count, 0) as track_count,
          coalesce(track_rollups.total_duration_seconds, 0) as total_duration_seconds
        from matched_album_rows
        left join track_rollups
          on track_rollups.album_id = matched_album_rows.album_id
        order by
          coalesce(
            nullif(matched_album_rows.artist_sort_name, ''),
            matched_album_rows.artist_name
          ),
          matched_album_rows.artist_name,
          matched_album_rows.album_release_year nulls last,
          matched_album_rows.album_title,
          matched_album_rows.album_key;
    """


def _search_preview_sql() -> str:
    return f"""
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        album_title_matches as materialized (
          select
            library.local_albums.library_id,
            library.local_albums.id as album_id
          from library.local_albums
          where lower(btrim(coalesce(library.local_albums.title, ''))) like lower(%(query_like)s)
        ),
        display_artist_matches as materialized (
          select
            library.local_artists.library_id,
            library.local_artists.id as artist_id
          from library.local_artists
          where lower(btrim(coalesce(library.local_artists.name, ''))) like lower(%(query_like)s)
        ),
        credited_artist_matches as materialized (
          select
            library.local_albums.library_id,
            library.local_albums.id as album_id
          from library.local_albums
          where lower(btrim(coalesce(library.local_albums.metadata ->> 'album_artist', ''))) like lower(%(query_like)s)
        ),
        track_title_matches as materialized (
          select
            library.local_tracks.library_id,
            library.local_tracks.album_id,
            library.local_tracks.id as track_id
          from library.local_tracks
          where lower(btrim(coalesce(library.local_tracks.title, ''))) like lower(%(query_like)s)
        ),
        file_name_matches as materialized (
          select library.local_track_files.track_id
          from library.local_track_files
          where coalesce((library.local_track_files.metadata #>> '{{scan_cache,stale}}')::boolean, false) is false
            and (
              lower(btrim(regexp_replace(coalesce(library.local_track_files.private_path, ''), '^.*[\\\\/]', ''))) like lower(%(query_like)s)
              or lower(btrim(
                regexp_replace(
                  regexp_replace(coalesce(library.local_track_files.private_path, ''), '^.*[\\\\/]', ''),
                  '\\.[^.]*$',
                  ''
                )
              )) like lower(%(query_like)s)
            )
        ),
        matched_track_album_ids as materialized (
          select
            track_title_matches.library_id,
            track_title_matches.album_id,
            track_title_matches.track_id
          from track_title_matches
          union
          select
            library.local_tracks.library_id,
            library.local_tracks.album_id,
            file_name_matches.track_id
          from file_name_matches
          join library.local_tracks
            on library.local_tracks.id = file_name_matches.track_id
        ),
        search_candidate_album_ids as materialized (
          select
            album_title_matches.library_id,
            album_title_matches.album_id
          from album_title_matches
          union
          select
            library.local_album_featured_artists.library_id,
            library.local_album_featured_artists.album_id
          from display_artist_matches
          join library.local_album_featured_artists
            on library.local_album_featured_artists.library_id = display_artist_matches.library_id
           and library.local_album_featured_artists.artist_id = display_artist_matches.artist_id
          union
          select
            credited_artist_matches.library_id,
            credited_artist_matches.album_id
          from credited_artist_matches
          union
          select
            matched_track_album_ids.library_id,
            matched_track_album_ids.album_id
          from matched_track_album_ids
        ),
        {_eligible_album_tracks_cte_sql(candidate_albums_only=True)},
        visible_album_ids as materialized (
          select distinct
            library.local_albums.library_id,
            library.local_albums.id as album_id
          from search_candidate_album_ids
          join library.local_albums
            on library.local_albums.library_id = search_candidate_album_ids.library_id
           and library.local_albums.id = search_candidate_album_ids.album_id
          join bootstrap_context
            on bootstrap_context.library_id = library.local_albums.library_id
          join eligible_album_tracks
            on eligible_album_tracks.library_id = library.local_albums.library_id
           and eligible_album_tracks.album_id = library.local_albums.id
          where ({_visible_album_clause("library.local_albums")})
        ),
        eligible_matched_track_album_ids as materialized (
          select distinct
            matched_track_album_ids.library_id,
            matched_track_album_ids.album_id
          from matched_track_album_ids
          join eligible_album_tracks
            on eligible_album_tracks.library_id = matched_track_album_ids.library_id
           and eligible_album_tracks.album_id = matched_track_album_ids.album_id
           and eligible_album_tracks.track_id = matched_track_album_ids.track_id
        ),
        matched_album_ids as materialized (
          select album_title_matches.album_id
          from album_title_matches
          join visible_album_ids
            on visible_album_ids.library_id = album_title_matches.library_id
           and visible_album_ids.album_id = album_title_matches.album_id
          union
          select library.local_album_featured_artists.album_id
          from display_artist_matches
          join library.local_album_featured_artists
            on library.local_album_featured_artists.library_id = display_artist_matches.library_id
           and library.local_album_featured_artists.artist_id = display_artist_matches.artist_id
          join visible_album_ids
            on visible_album_ids.library_id = library.local_album_featured_artists.library_id
           and visible_album_ids.album_id = library.local_album_featured_artists.album_id
          union
          select credited_artist_matches.album_id
          from credited_artist_matches
          join visible_album_ids
            on visible_album_ids.library_id = credited_artist_matches.library_id
           and visible_album_ids.album_id = credited_artist_matches.album_id
          union
          select eligible_matched_track_album_ids.album_id
          from eligible_matched_track_album_ids
          join visible_album_ids
            on visible_album_ids.library_id = eligible_matched_track_album_ids.library_id
           and visible_album_ids.album_id = eligible_matched_track_album_ids.album_id
        ),
        matched_album_rows as (
          select distinct
            library.local_artists.id as artist_id,
            library.local_artists.name as display_artist,
            library.local_artists.sort_name as artist_sort_name,
            library.local_albums.library_id,
            library.local_albums.id as album_id,
            library.local_albums.album_key,
            library.local_albums.title as album_title,
            library.local_albums.release_year as album_release_year,
            library.local_albums.cover_path as album_cover_path,
            library.local_albums.metadata as album_metadata
          from matched_album_ids
          join library.local_albums
            on library.local_albums.id = matched_album_ids.album_id
          join library.local_album_featured_artists
            on library.local_album_featured_artists.library_id = library.local_albums.library_id
           and library.local_album_featured_artists.album_id = library.local_albums.id
          join library.local_artists
            on library.local_artists.library_id = library.local_album_featured_artists.library_id
           and library.local_artists.id = library.local_album_featured_artists.artist_id
        ),
        matched_album_identities as (
          select distinct
            matched_album_rows.library_id,
            matched_album_rows.album_id
          from matched_album_rows
        ),
        track_rollups as (
          select
            eligible_album_tracks.album_id,
            count(distinct eligible_album_tracks.track_id)::integer as track_count,
            coalesce(sum(eligible_album_tracks.duration_seconds), 0)::integer as total_duration_seconds
          from eligible_album_tracks
          join matched_album_identities
            on matched_album_identities.library_id = eligible_album_tracks.library_id
           and matched_album_identities.album_id = eligible_album_tracks.album_id
          group by eligible_album_tracks.album_id
        )
        select
          matched_album_rows.artist_id,
          matched_album_rows.display_artist as artist_name,
          matched_album_rows.artist_sort_name,
          matched_album_rows.album_id,
          matched_album_rows.album_key,
          matched_album_rows.album_title,
          matched_album_rows.album_release_year,
          matched_album_rows.album_cover_path,
          matched_album_rows.album_metadata,
          coalesce(track_rollups.track_count, 0) as track_count,
          coalesce(track_rollups.total_duration_seconds, 0) as total_duration_seconds
        from matched_album_rows
        left join track_rollups
          on track_rollups.album_id = matched_album_rows.album_id
        order by
          matched_album_rows.display_artist,
          matched_album_rows.album_release_year nulls last,
          matched_album_rows.album_title,
          matched_album_rows.album_key;
    """


def _album_rows_by_track_paths_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        matched_album_ids as (
          select distinct library.local_tracks.album_id
          from library.local_tracks
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and coalesce((library.local_track_files.metadata #>> '{scan_cache,stale}')::boolean, false) is false
          where library.local_track_files.private_path = any(%(track_paths)s::text[])
        ),
        ignored_repair_rollup as (
          select
            library.local_track_files.private_path as file_private_path,
            array_agg(
              library.ignored_repairs.repair_key
              order by library.ignored_repairs.repair_key
            ) as ignored_repair_keys
          from library.local_track_files
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
          join matched_album_ids
            on matched_album_ids.album_id = library.local_tracks.album_id
          join library.local_albums
            on matched_album_ids.album_id = library.local_albums.id
           and library.local_albums.library_id = library.local_tracks.library_id
          join library.ignored_repairs
            on library.ignored_repairs.library_id = library.local_albums.library_id
           and (
                (
                  library.ignored_repairs.repair_key ~ '::problem-album::[^:]+$'
                  and library.local_albums.album_key = nullif(
                    library.ignored_repairs.metadata ->> 'album_key',
                    ''
                  )
                )
                or (
                  library.ignored_repairs.repair_key !~ '::problem-album::[^:]+$'
                  and library.local_track_files.private_path = split_part(library.ignored_repairs.repair_key, '::', 1)
                )
           )
          where coalesce(
                  (
                    library.local_track_files.metadata
                      #>> '{scan_cache,stale}'
                  )::boolean,
                  false
                ) is false
          group by library.local_track_files.private_path
        ),
        separate_release_rollup as (
          select
            library.separate_releases.library_id,
            array_agg(library.separate_releases.release_key order by library.separate_releases.release_key) as separate_release_keys
          from library.separate_releases
          join bootstrap_context
            on bootstrap_context.library_id = library.separate_releases.library_id
          group by library.separate_releases.library_id
        )
        select
          library.local_artists.id as artist_id,
          coalesce(
            nullif(library.local_albums.metadata ->> 'album_artist', ''),
            library.local_artists.name
          ) as artist_name,
          library.local_artists.sort_name as artist_sort_name,
          library.local_albums.id as album_id,
          library.local_albums.album_key,
          library.local_albums.title as album_title,
          library.local_albums.release_year as album_release_year,
          library.local_albums.cover_path as album_cover_path,
          library.local_albums.metadata as album_metadata,
          library.local_tracks.id as track_id,
          library.local_tracks.track_key,
          library.local_tracks.title as track_title,
          library.local_tracks.disc_number,
          library.local_tracks.track_number,
          library.local_tracks.duration_seconds,
          library.local_track_files.private_path as file_private_path,
          library.local_track_files.library_root_id as file_library_root_id,
          library.local_track_files.metadata ->> 'library_root_category' as file_library_root_category,
          coalesce(
            library.local_track_files.metadata #> '{scan_cache,file_entry}',
            '{}'::jsonb
          ) ||
          case
            when exception_override.override_payload ? 'exception_type'
            then jsonb_build_object(
              'exception_type',
              exception_override.override_payload ->> 'exception_type'
            )
            else '{}'::jsonb
          end as file_entry,
          coalesce(
            ignored_repair_rollup.ignored_repair_keys,
            array[]::text[]
          ) as ignored_repair_keys,
          coalesce(separate_release_rollup.separate_release_keys, array[]::text[]) as separate_release_keys
        from library.local_albums
        join bootstrap_context
          on bootstrap_context.library_id = library.local_albums.library_id
        join matched_album_ids
          on matched_album_ids.album_id = library.local_albums.id
        left join library.local_artists
          on library.local_artists.id = library.local_albums.artist_id
        left join library.local_tracks
          on library.local_tracks.library_id = library.local_albums.library_id
         and library.local_tracks.album_id = library.local_albums.id
        left join library.local_track_files
          on library.local_track_files.track_id = library.local_tracks.id
         and coalesce((library.local_track_files.metadata #>> '{scan_cache,stale}')::boolean, false) is false
        left join lateral (
          select library.exception_overrides.override_payload
          from library.exception_overrides
          where library.exception_overrides.library_id = bootstrap_context.library_id
            and (
              library.exception_overrides.track_key = library.local_track_files.private_path
              or library.exception_overrides.track_id = library.local_tracks.id
            )
          order by
            case
              when library.exception_overrides.track_key = library.local_track_files.private_path then 0
              when library.exception_overrides.track_id = library.local_tracks.id then 1
              else 2
            end,
            library.exception_overrides.id
          limit 1
        ) exception_override on true
        left join ignored_repair_rollup
          on ignored_repair_rollup.file_private_path =
            library.local_track_files.private_path
        left join separate_release_rollup
          on separate_release_rollup.library_id = library.local_albums.library_id
        order by
          coalesce(
            nullif(library.local_artists.sort_name, ''),
            coalesce(
              nullif(library.local_albums.metadata ->> 'album_artist', ''),
              library.local_artists.name
            )
          ),
          library.local_albums.release_year nulls last,
          library.local_albums.title,
          library.local_albums.album_key,
          library.local_tracks.disc_number nulls last,
          library.local_tracks.track_number nulls last,
          library.local_tracks.title,
          library.local_track_files.private_path;
    """


def _mojibake_candidate_signal_sql(text_expression: str) -> str:
    return f"""
        (
          btrim({text_expression}) = '?'
          or position('??' in {text_expression}) > 0
          or position(chr(65533) in {text_expression}) > 0
          or position('\u043f\u0457\u0455' in {text_expression}) > 0
          or case
            when {text_expression} !~ '[À-ÿ¨¸]' then false
            else {text_expression} ~ %(mojibake_candidate_pattern)s::text
              or (
                char_length({text_expression})
                  - char_length(translate({text_expression}, %(encoding_candidate_chars)s::text, ''))
              ) >= 3
              and (
                char_length({text_expression})
                  - char_length(translate({text_expression}, %(encoding_candidate_chars)s::text, ''))
              ) * 100 >= 45 * char_length(
                regexp_replace({text_expression}, '[^[:alpha:]À-ÿ¨¸]', '', 'g')
              )
          end
          or case
            when char_length({text_expression}) < 3 then false
            when {text_expression} !~ '[㐀-鿿]' then false
            else 3 <= (
              select count(*)
              from regexp_split_to_table({text_expression}, '') as candidate_character(value)
              where ascii(candidate_character.value) between 13312 and 40959
                and mod(ascii(candidate_character.value), 256) = 0
                and (
                  ascii(candidate_character.value) / 256 between 65 and 90
                  or ascii(candidate_character.value) / 256 between 97 and 122
                )
            )
          end
        )
    """


def _relation_alias_maps_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        select
          coalesce(
            library.libraries.metadata #> '{scan_cache,relation_views}',
            '{}'::jsonb
          ) as relation_views,
          coalesce(
            library.libraries.metadata #> '{scan_cache,relation_projection}',
            '{}'::jsonb
          ) as relation_projection
        from library.libraries
        join bootstrap_context on bootstrap_context.library_id = library.libraries.id
        limit 1;
    """


def _mojibake_candidate_fields_sql(text_expressions: Iterable[str]) -> str:
    return "(\n" + "\n          or ".join(
        _mojibake_candidate_signal_sql(expression).strip()
        for expression in text_expressions
    ) + "\n        )"


def _problematic_files_sql(
    *,
    candidate_summary: bool = False,
    candidate_ids_only: bool = False,
    selected_album_ids: bool = False,
    targeted_problem_owners: bool = False,
) -> str:
    if (candidate_ids_only or selected_album_ids) and not candidate_summary:
        raise ValueError("Problematic candidate query modes require candidate_summary=True.")
    if candidate_ids_only and selected_album_ids:
        raise ValueError("Problematic candidate query modes are mutually exclusive.")
    candidate_ctes = ""
    selected_album_join = ""
    selected_album_filter = (
        "where (%(album_key)s::text is null or library.local_albums.album_key = %(album_key)s::text)"
    )
    if targeted_problem_owners:
        selected_album_filter = """
          where
            library.local_albums.album_key = any(%(album_keys)s::text[])
            or exists (
              select 1
              from library.local_tracks as owner_tracks
              join library.local_track_files as owner_files
                on owner_files.track_id = owner_tracks.id
               and owner_files.scan_cache_stale is false
              where owner_tracks.library_id = library.local_albums.library_id
                and owner_tracks.album_id = library.local_albums.id
                and owner_files.private_path = any(%(file_paths)s::text[])
            )
        """
    if candidate_summary and not selected_album_ids:
        album_text_expressions = (
            "coalesce(library.local_albums.title, '')",
            "coalesce(nullif(library.local_albums.metadata ->> 'album_artist', ''), library.local_artists.name, '')",
        )
        candidate_ctes = """
        active_problem_rows as materialized (
          select
            library.local_tracks.album_id,
            library.local_track_files.track_id,
            coalesce(nullif(library.local_tracks.disc_number, 0), 1) as disc_number,
            case
              when library.local_tracks.track_number > 0
                then library.local_tracks.track_number
            end as effective_track_number,
            (
              library.local_tracks.scan_title_problem_candidate is true
              or library.local_tracks.track_number is null
              or library.local_tracks.track_number <= 0
            ) as track_problem,
            (
              library.local_track_files.scan_file_entry_is_object is true
              and (
                library.local_track_files.scan_file_text_mojibake_candidate is true
                or library.local_track_files.scan_file_metadata_problem_candidate is true
              )
            ) as file_problem,
            nullif(lower(btrim(library.local_track_files.scan_file_album)), '') as file_album,
            nullif(lower(btrim(library.local_track_files.scan_file_album_artist)), '') as file_album_artist,
            nullif(btrim(coalesce(library.local_track_files.scan_file_year, '')), '') as file_year
          from library.local_track_files
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
          where library.local_track_files.scan_cache_stale is false
            and (
              (select count(*) = 1 from library.libraries)
              or library.local_tracks.library_id = (
                select library_id from bootstrap_context
              )
            )
        ),
        duplicate_album_ids as (
          select active_problem_rows.album_id
          from active_problem_rows
          group by active_problem_rows.album_id, active_problem_rows.track_id
          having count(*) > 1
        ),
        active_album_rollup as (
          select
            active_problem_rows.album_id,
            bool_or(active_problem_rows.track_problem) as track_problem,
            bool_or(active_problem_rows.file_problem) as file_problem,
            min(active_problem_rows.file_album) as min_file_album,
            max(active_problem_rows.file_album) as max_file_album,
            count(active_problem_rows.file_album) < count(*) as has_blank_album,
            min(active_problem_rows.file_album_artist) as min_file_album_artist,
            max(active_problem_rows.file_album_artist) as max_file_album_artist,
            count(active_problem_rows.file_album_artist) < count(*) as has_blank_album_artist,
            min(active_problem_rows.file_year) as min_file_year,
            max(active_problem_rows.file_year) as max_file_year
          from active_problem_rows
          group by active_problem_rows.album_id
        ),
        required_text_missing_album_ids as (
          select distinct library.local_tracks.album_id
          from library.local_track_files
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
          where library.local_track_files.scan_cache_stale is false
            and library.local_track_files.scan_file_entry_is_object is true
            and (
              coalesce(library.local_track_files.scan_file_album, '') !~ '[^[:space:]]'
              or coalesce(library.local_track_files.scan_file_album_artist, '') !~ '[^[:space:]]'
              or coalesce(library.local_track_files.scan_file_artist, '') !~ '[^[:space:]]'
              or coalesce(library.local_track_files.scan_file_title, '') !~ '[^[:space:]]'
            )
            and (
              (select count(*) = 1 from library.libraries)
              or library.local_tracks.library_id = (
                select library_id from bootstrap_context
              )
            )
        ),
        active_candidate_ids as (
          select library.local_albums.id as album_id
          from active_album_rollup
          join library.local_albums
            on library.local_albums.id = active_album_rollup.album_id
          left join library.local_artists
            on library.local_artists.id = library.local_albums.artist_id
          where
            lower(btrim(coalesce(library.local_albums.title, ''))) in ('', 'unknown', 'unknown artist', 'unknown album', 'none', 'null')
            or lower(btrim(coalesce(
              nullif(library.local_albums.metadata ->> 'album_artist', ''),
              library.local_artists.name,
              ''
            ))) in ('', 'unknown', 'unknown artist', 'unknown album', 'none', 'null')
            or btrim(coalesce(library.local_albums.title, '')) = '?'
            or btrim(coalesce(
              nullif(library.local_albums.metadata ->> 'album_artist', ''),
              library.local_artists.name,
              ''
            )) = '?'
            or __ALBUM_MOJIBAKE_CANDIDATE__
            or library.local_albums.release_year is null
            or library.local_albums.release_year <= 0
            or nullif(btrim(coalesce(library.local_albums.cover_path, '')), '') is null
            or (
              case
                when btrim(coalesce(library.local_albums.metadata ->> 'local_cover_width', '')) ~ '^[+-]?[0-9]+$'
                  then btrim(library.local_albums.metadata ->> 'local_cover_width')::numeric
              end > 0
              and case
                when btrim(coalesce(library.local_albums.metadata ->> 'local_cover_height', '')) ~ '^[+-]?[0-9]+$'
                  then btrim(library.local_albums.metadata ->> 'local_cover_height')::numeric
              end > 0
              and (
                case
                  when btrim(coalesce(library.local_albums.metadata ->> 'local_cover_width', '')) ~ '^[+-]?[0-9]+$'
                    then btrim(library.local_albums.metadata ->> 'local_cover_width')::numeric
                end < 600
                or case
                  when btrim(coalesce(library.local_albums.metadata ->> 'local_cover_height', '')) ~ '^[+-]?[0-9]+$'
                    then btrim(library.local_albums.metadata ->> 'local_cover_height')::numeric
                end < 600
              )
            )
            or active_album_rollup.track_problem
            or library.local_artists.scan_name_problem_candidate is true
            or active_album_rollup.file_problem
            or least(
              active_album_rollup.min_file_album,
              case
                when active_album_rollup.has_blank_album
                  then lower(btrim(coalesce(library.local_albums.title, '')))
              end
            ) <> greatest(
              active_album_rollup.max_file_album,
              case
                when active_album_rollup.has_blank_album
                  then lower(btrim(coalesce(library.local_albums.title, '')))
              end
            )
            or (
              not coalesce((library.local_albums.metadata ->> 'is_compilation')::boolean, false)
              and least(
                active_album_rollup.min_file_album_artist,
                case
                  when active_album_rollup.has_blank_album_artist
                    then lower(btrim(coalesce(
                      nullif(library.local_albums.metadata ->> 'album_artist', ''),
                      library.local_artists.name,
                      ''
                    )))
                end
              ) <> greatest(
                active_album_rollup.max_file_album_artist,
                case
                  when active_album_rollup.has_blank_album_artist
                    then lower(btrim(coalesce(
                      nullif(library.local_albums.metadata ->> 'album_artist', ''),
                      library.local_artists.name,
                      ''
                    )))
                end
              )
            )
            or active_album_rollup.min_file_year <> active_album_rollup.max_file_year
            or (
              library.local_albums.release_year is not null
              and (
                (
                  active_album_rollup.min_file_year ~ '^[+-]?[0-9]+$'
                  and active_album_rollup.min_file_year::bigint
                    <> library.local_albums.release_year
                )
                or (
                  active_album_rollup.max_file_year ~ '^[+-]?[0-9]+$'
                  and active_album_rollup.max_file_year::bigint
                    <> library.local_albums.release_year
                )
              )
            )
        ),
        active_track_order_rollup as (
          select
            active_problem_rows.album_id,
            active_problem_rows.disc_number,
            (
              min(active_problem_rows.effective_track_number) <> 1
              or count(distinct active_problem_rows.effective_track_number)
                <> max(active_problem_rows.effective_track_number)
            ) as incomplete_track_order
          from active_problem_rows
          where active_problem_rows.effective_track_number is not null
          group by active_problem_rows.album_id, active_problem_rows.disc_number
        ),
        candidate_album_ids as (
          select active_candidate_ids.album_id from active_candidate_ids
          union
          select required_text_missing_album_ids.album_id
          from required_text_missing_album_ids
          union
          select duplicate_album_ids.album_id from duplicate_album_ids
          union
          select active_track_order_rollup.album_id
          from active_track_order_rollup
          where active_track_order_rollup.incomplete_track_order is true
        ),
        """
        candidate_ctes = (
            candidate_ctes
            .replace(
                "__ALBUM_MOJIBAKE_CANDIDATE__",
                _mojibake_candidate_fields_sql(album_text_expressions),
            )
        )
        selected_album_join = "join candidate_album_ids on candidate_album_ids.album_id = library.local_albums.id"
        selected_album_filter = ""
    if candidate_ids_only:
        candidate_ctes_sql = candidate_ctes.rstrip()
        if candidate_ctes_sql.endswith(","):
            candidate_ctes_sql = candidate_ctes_sql[:-1]
        return f"""
            with bootstrap_context as (
              select library.libraries.id as library_id
              from app.bootstrap_owners
              join library.libraries
                on library.libraries.owner_account_id = app.bootstrap_owners.account_id
               and library.libraries.name = 'Local Library'
               and library.libraries.library_kind = 'local'
              where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
              limit 1
            ),
            {candidate_ctes_sql}
            select candidate_album_ids.album_id
            from candidate_album_ids;
        """
    if selected_album_ids:
        selected_album_filter = (
            "where library.local_albums.id = any(%(album_ids)s::bigint[])"
        )
    if candidate_summary:
        selected_album_projection = """
            library.local_albums.id,
            library.local_albums.library_id,
            library.local_albums.artist_id,
            library.local_albums.album_key,
            library.local_albums.title,
            library.local_albums.release_year,
            library.local_albums.cover_path,
            library.local_albums.metadata ->> 'album_artist' as album_artist,
            library.local_albums.metadata ->> 'artists' as album_artists,
            coalesce((library.local_albums.metadata ->> 'is_compilation')::boolean, false) as album_is_compilation,
            library.local_albums.metadata ->> 'cover_revision' as album_cover_revision,
            library.local_albums.metadata ->> 'local_cover_width' as album_local_cover_width,
            library.local_albums.metadata ->> 'local_cover_height' as album_local_cover_height,
            library.local_albums.metadata ->> 'remote_cover_url' as album_remote_cover_url,
            library.local_albums.metadata ->> 'remote_cover_thumbnail_url' as album_remote_cover_thumbnail_url,
            library.local_albums.metadata ->> 'remote_cover_source' as album_remote_cover_source,
            library.local_albums.metadata ->> 'remote_cover_source_label' as album_remote_cover_source_label,
            library.local_albums.metadata ->> 'remote_cover_album_url' as album_remote_cover_album_url,
            library.local_albums.metadata ->> 'remote_cover_width' as album_remote_cover_width,
            library.local_albums.metadata ->> 'remote_cover_height' as album_remote_cover_height,
            library.local_albums.metadata ->> 'release_date' as album_release_date,
            library.local_albums.metadata ->> 'edition' as album_edition,
            library.local_albums.metadata ->> 'album_rating' as album_rating,
            library.local_albums.metadata ->> 'root_provenance' as album_root_provenance
        """
        active_track_file_projection = """
            library.local_track_files.track_id,
            library.local_track_files.private_path,
            library.local_track_files.scan_file_entry_is_object as file_entry_is_object,
            library.local_track_files.scan_file_album as file_album,
            library.local_track_files.scan_file_album_artist as file_album_artist,
            library.local_track_files.scan_file_artist as file_artist,
            library.local_track_files.scan_file_title as file_title,
            library.local_track_files.scan_file_year as file_year,
            library.local_track_files.scan_file_track_number as file_track_number,
            library.local_track_files.scan_file_text_mojibake_candidate as file_text_mojibake_candidate,
            exception_override.override_payload ->> 'exception_type' as exception_type,
            coalesce(
              exception_override.override_payload ? 'exception_type',
              false
            ) as exception_override_present
        """
        album_result_projection = """
          selected_albums.album_artist,
          selected_albums.album_artists,
          selected_albums.album_is_compilation,
          selected_albums.album_cover_revision,
          selected_albums.album_local_cover_width,
          selected_albums.album_local_cover_height,
          selected_albums.album_remote_cover_url,
          selected_albums.album_remote_cover_thumbnail_url,
          selected_albums.album_remote_cover_source,
          selected_albums.album_remote_cover_source_label,
          selected_albums.album_remote_cover_album_url,
          selected_albums.album_remote_cover_width,
          selected_albums.album_remote_cover_height,
          selected_albums.album_release_date,
          selected_albums.album_edition,
          selected_albums.album_rating,
          selected_albums.album_root_provenance,
        """
        file_result_projection = """
          active_track_files.file_entry_is_object,
          active_track_files.file_album,
          active_track_files.file_album_artist,
          active_track_files.file_artist,
          active_track_files.file_title,
          active_track_files.file_year,
          active_track_files.file_track_number,
          active_track_files.file_text_mojibake_candidate,
          active_track_files.exception_type,
          active_track_files.exception_override_present,
        """
        album_artist_result_expression = "selected_albums.album_artist"
    else:
        selected_album_projection = """
            library.local_albums.id,
            library.local_albums.library_id,
            library.local_albums.artist_id,
            library.local_albums.album_key,
            library.local_albums.title,
            library.local_albums.release_year,
            library.local_albums.cover_path,
            library.local_albums.metadata
        """
        active_track_file_projection = """
            library.local_track_files.track_id,
            library.local_track_files.private_path,
            library.local_track_files.metadata,
            library.local_track_files.scan_file_text_mojibake_candidate as file_text_mojibake_candidate,
            exception_override.override_payload ->> 'exception_type' as exception_type,
            coalesce(
              exception_override.override_payload ? 'exception_type',
              false
            ) as exception_override_present
        """
        album_result_projection = "selected_albums.metadata as album_metadata,"
        file_result_projection = """
          active_track_files.metadata #> '{scan_cache,file_entry}' as file_entry,
          active_track_files.file_text_mojibake_candidate,
          active_track_files.exception_type,
          active_track_files.exception_override_present,
        """
        album_artist_result_expression = "selected_albums.metadata ->> 'album_artist'"
    if candidate_summary:
        selected_active_track_file_rows_sql = f"""
        selected_active_track_file_rows as materialized (
          select selected_track_file.*
          from selected_tracks
          cross join lateral (
            select
              {active_track_file_projection}
            from library.local_track_files
            left join lateral (
              select library.exception_overrides.override_payload
              from library.exception_overrides
              where library.exception_overrides.library_id = selected_tracks.library_id
                and (
                  library.exception_overrides.track_key = library.local_track_files.private_path
                  or library.exception_overrides.track_id = selected_tracks.id
                )
              order by
                case
                  when library.exception_overrides.track_key = library.local_track_files.private_path then 0
                  when library.exception_overrides.track_id = selected_tracks.id then 1
                  else 2
                end,
                library.exception_overrides.id
              limit 1
            ) exception_override on true
            where library.local_track_files.track_id = selected_tracks.id
              and library.local_track_files.scan_cache_stale is false
            offset 0
          ) selected_track_file
        ),
        """
    else:
        selected_active_track_file_rows_sql = f"""
        selected_active_track_file_rows as materialized (
          select
            {active_track_file_projection}
          from library.local_track_files
          join selected_tracks
            on selected_tracks.id = library.local_track_files.track_id
          left join lateral (
            select library.exception_overrides.override_payload
            from library.exception_overrides
            where library.exception_overrides.library_id = selected_tracks.library_id
              and (
                library.exception_overrides.track_key = library.local_track_files.private_path
                or library.exception_overrides.track_id = selected_tracks.id
              )
            order by
              case
                when library.exception_overrides.track_key = library.local_track_files.private_path then 0
                when library.exception_overrides.track_id = selected_tracks.id then 1
                else 2
              end,
              library.exception_overrides.id
            limit 1
          ) exception_override on true
          where coalesce(
            (library.local_track_files.metadata #>> '{{scan_cache,stale}}')::boolean,
            false
          ) is false
        ),
        """
    return f"""
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        {candidate_ctes}
        selected_albums as (
          select
            {selected_album_projection}
          from library.local_albums
          join bootstrap_context
            on bootstrap_context.library_id = library.local_albums.library_id
          {selected_album_join}
          {selected_album_filter}
        ),
        selected_tracks as (
          select
            library.local_tracks.id,
            library.local_tracks.library_id,
            library.local_tracks.album_id,
            library.local_tracks.track_key,
            library.local_tracks.title,
            library.local_tracks.disc_number,
            library.local_tracks.track_number,
            library.local_tracks.duration_seconds
          from library.local_tracks
          join selected_albums
            on selected_albums.id = library.local_tracks.album_id
           and selected_albums.library_id = library.local_tracks.library_id
        ),
        {selected_active_track_file_rows_sql}
        active_track_files as (
          select
            selected_active_track_file_rows.*,
            count(*) over (
              partition by selected_active_track_file_rows.track_id
            )::integer as duplicate_file_count
          from selected_active_track_file_rows
        ),
        ignored_repair_rollup as (
          select
            library.ignored_repairs.library_id,
            array_agg(library.ignored_repairs.repair_key order by library.ignored_repairs.repair_key) as ignored_repair_keys
          from library.ignored_repairs
          join bootstrap_context
            on bootstrap_context.library_id = library.ignored_repairs.library_id
          group by library.ignored_repairs.library_id
        ),
        separate_release_rollup as (
          select
            library.separate_releases.library_id,
            array_agg(library.separate_releases.release_key order by library.separate_releases.release_key) as separate_release_keys
          from library.separate_releases
          join bootstrap_context
            on bootstrap_context.library_id = library.separate_releases.library_id
          group by library.separate_releases.library_id
        )
        select
          selected_albums.id as album_id,
          selected_albums.album_key,
          selected_albums.title as album_title,
          selected_albums.release_year as album_release_year,
          selected_albums.cover_path as album_cover_path,
          {album_result_projection}
          coalesce(
            nullif({album_artist_result_expression}, ''),
            library.local_artists.name
          ) as artist_name,
          selected_tracks.id as track_id,
          selected_tracks.track_key,
          selected_tracks.title as track_title,
          selected_tracks.disc_number,
          selected_tracks.track_number,
          selected_tracks.duration_seconds,
          active_track_files.private_path as file_private_path,
          {file_result_projection}
          coalesce(ignored_repair_rollup.ignored_repair_keys, array[]::text[]) as ignored_repair_keys,
          coalesce(separate_release_rollup.separate_release_keys, array[]::text[]) as separate_release_keys,
          coalesce(active_track_files.duplicate_file_count, 1) as duplicate_file_count
        from selected_albums
        left join library.local_artists
          on library.local_artists.id = selected_albums.artist_id
        left join selected_tracks
          on selected_tracks.album_id = selected_albums.id
        left join active_track_files
          on active_track_files.track_id = selected_tracks.id
        left join ignored_repair_rollup
          on ignored_repair_rollup.library_id = selected_albums.library_id
        left join separate_release_rollup
          on separate_release_rollup.library_id = selected_albums.library_id;
    """


def _problem_exclusion_candidates_sql() -> str:
    return _problematic_files_sql(targeted_problem_owners=True)


def _utility_rules_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        relation_context as (
          select
            library.libraries.id as library_id,
            coalesce(
              library.libraries.metadata #> '{scan_cache,relation_views,alias_to_canonical}',
              '{}'::jsonb
            ) as alias_to_canonical
          from library.libraries
          join bootstrap_context
            on bootstrap_context.library_id = library.libraries.id
        ),
        version_rows as (
          select
            'version'::text as row_kind,
            library.ignored_versions.version_key as ignored_version_key,
            null::text as ignored_repair_key,
            library.local_albums.id as album_id,
            library.local_albums.album_key,
            library.local_albums.title as album_title,
            library.local_albums.release_year as album_release_year,
            library.local_albums.cover_path as album_cover_path,
            library.local_albums.metadata as album_metadata,
            coalesce(
              nullif(library.local_albums.metadata ->> 'album_artist', ''),
              library.local_artists.name
            ) as artist_name,
            null::text as file_private_path,
            null::jsonb as file_entry,
            relation_context.alias_to_canonical
          from library.ignored_versions
          join bootstrap_context
            on bootstrap_context.library_id = library.ignored_versions.library_id
          join relation_context
            on relation_context.library_id = library.ignored_versions.library_id
          left join library.local_albums
            on library.local_albums.library_id = library.ignored_versions.library_id
           and library.local_albums.album_key = library.ignored_versions.version_key
          left join library.local_artists
            on library.local_artists.id = library.local_albums.artist_id
        ),
        repair_rows as (
          select
            'problem_ignore'::text as row_kind,
            null::text as ignored_version_key,
            library.ignored_repairs.repair_key as ignored_repair_key,
            library.local_albums.id as album_id,
            library.local_albums.album_key,
            library.local_albums.title as album_title,
            library.local_albums.release_year as album_release_year,
            library.local_albums.cover_path as album_cover_path,
            library.local_albums.metadata as album_metadata,
            coalesce(
              nullif(library.local_albums.metadata ->> 'album_artist', ''),
              library.local_artists.name
            ) as artist_name,
            library.local_track_files.private_path as file_private_path,
            library.local_track_files.metadata #> '{scan_cache,file_entry}' as file_entry,
            relation_context.alias_to_canonical
          from library.ignored_repairs
          join bootstrap_context
            on bootstrap_context.library_id = library.ignored_repairs.library_id
          join relation_context
            on relation_context.library_id = library.ignored_repairs.library_id
          left join library.local_track_files
            on library.ignored_repairs.repair_key !~ '::problem-album::[^:]+$'
           and library.local_track_files.private_path = case
                 when library.ignored_repairs.repair_key ~ '::problem-file::[^:]+$'
                   then regexp_replace(
                     library.ignored_repairs.repair_key,
                     '::problem-file::[^:]+$',
                     ''
                   )
                 else regexp_replace(
                   library.ignored_repairs.repair_key,
                   '::[^:]+$',
                   ''
                 )
               end
           and coalesce((library.local_track_files.metadata #>> '{scan_cache,stale}')::boolean, false) is false
          left join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
           and library.local_tracks.library_id = library.ignored_repairs.library_id
          left join library.local_albums
            on library.local_albums.library_id = library.ignored_repairs.library_id
           and (
                (
                  library.ignored_repairs.repair_key ~ '::problem-album::[^:]+$'
                  and library.local_albums.album_key = nullif(
                    library.ignored_repairs.metadata ->> 'album_key',
                    ''
                  )
                )
                or (
                  library.ignored_repairs.repair_key !~ '::problem-album::[^:]+$'
                  and library.local_albums.id = library.local_tracks.album_id
                )
           )
          left join library.local_artists
            on library.local_artists.id = library.local_albums.artist_id
        )
        select * from version_rows
        union all
        select * from repair_rows
        order by row_kind, ignored_version_key nulls last, ignored_repair_key nulls last;
    """
