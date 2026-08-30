from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import logging
import sys
import time
from collections.abc import Iterable
from types import SimpleNamespace

from music_app.services.artist_alias_views import enrich_casefold_artist_alias_views
from music_app.services.artist_sidebar import (
    artist_display_dedupe_key,
    build_artists_sidebar,
    is_various_album,
)
from music_app.services.album_note_read_seams import build_album_note_payload, build_visible_album_notes_payload
from music_app.services.app_logging import log_app_event
from music_app.services.artist_family_postgres import (
    load_selected_artist_family_projection,
)
from music_app.services.gallery_scope import (
    album_visible_in_categories,
    entry_visible_in_categories,
    normalize_gallery_scope,
    normalize_visible_categories,
)
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
from music_app.services.ignored_versions import load_ignored_version_keys
from music_app.services.library import album_preview_to_dict, build_artist_groups
from music_app.services.library_roots import (
    get_primary_music_root,
    relative_parts_within_roots,
)
from music_app.services.manual_versions import load_manual_version_links
from music_app.services.metadata import NON_ALBUM_EXCEPTION_VALUES, normalize_exception_value
from music_app.services.non_album_view_payloads import (
    build_non_album_track_list,
    has_meaningful_album_name,
    is_loose_track_album_value,
)
from music_app.services.opinion_read_seams import (
    build_artist_popularity_payload,
    build_popularity_browse_payload,
    build_viewer_opinion_preferences_payload,
    resolve_viewer_opinion_preferences,
)
from music_app.services.page_resource_seams import build_artist_page_seam
from music_app.services.playlist_read_seams import (
    build_playlist_surface_payload,
    build_view_surface_payload,
    resolve_active_view_surface,
)
from music_app.services.discovery_center_read_seams import build_discovery_center_page_payload
from music_app.services.recent_listen_read_seams import build_recent_listen_payloads
from music_app.services.shell_layout_seams import build_shell_layout_payload
from music_app.services.state import (
    format_timestamp,
    relations_percent_for_state,
    scan_percent_for_state,
)
from music_app.services.selected_artist_membership import (
    album_matches_group_artist as membership_album_matches_group_artist,
    build_artist_membership_groups as membership_build_artist_membership_groups,
    cached_album_matches_group_artist as membership_cached_album_matches_group_artist,
    merge_duplicate_artist_groups as membership_merge_duplicate_artist_groups,
    selected_artist_family_artists as membership_selected_artist_family_artists,
)
from music_app.services.view_search import (
    artist_alias_matches_query,
    artist_search_buckets,
    build_legacy_search_context,
    build_search_filter_contract,
    build_search_query_contract,
    build_search_filter_state,
    compact_search_key,
    normalize_search_text,
    resolve_requested_artist,
    split_search_terms,
)
from music_app.services.client_surfaces import resolve_client_surface_class
from version import RELEASE_VERSION


_LOGGER = logging.getLogger(__name__)


# Keep a small service-backed compatibility seam for focused tests that monkeypatch
# artist-group helpers to prove cache-backed paths do not rebuild groups.
artist_group_helpers = SimpleNamespace(
    build_artist_groups=build_artist_groups,
    _build_artist_membership_groups=membership_build_artist_membership_groups,
    _cached_album_matches_group_artist=membership_cached_album_matches_group_artist,
)


def _compat_cached_album_matches_group_artist(
    album,
    artist: str,
    alias_to_canonical: dict[str, str],
    album_group_match_cache: dict[tuple[str, str], bool],
) -> bool:
    """Preserve the historical monkeypatch seam for cached group-artist matching."""
    service_helper = artist_group_helpers._cached_album_matches_group_artist
    if service_helper is not membership_cached_album_matches_group_artist:
        return service_helper(album, artist, alias_to_canonical, album_group_match_cache)

    # Older focused tests could monkeypatch the historical route helper directly.
    route_helper_module = sys.modules.get("music_app.routes.api_view_payload_helpers")
    route_helper = getattr(route_helper_module, "_cached_album_matches_group_artist", None)
    if (
        callable(route_helper)
        and getattr(route_helper, "__module__", "") != "music_app.routes.api_view_payload_helpers"
    ):
        return route_helper(album, artist, alias_to_canonical, album_group_match_cache)
    return service_helper(
        album,
        artist,
        alias_to_canonical,
        album_group_match_cache,
    )


_SELECTED_ARTIST_FAMILY_DISPLAY_MODES = {"grouped", "chronological"}


@dataclass(frozen=True)
class _ViewPayloadRequest:
    query_raw: str
    query: str
    active_surface: str
    gallery_scope: str
    gallery_display_mode: str | None
    gallery_scale_percent: int | None
    arrivals_only_scope: bool
    category_filter_requested: bool
    root_aware_filtering_active: bool
    selected_artist_family_display_mode: str
    local_tree_submode: str
    visible_library_categories: list[str]
    requested_artist: str
    requested_payload_tier: str
    sidebar_only_payload: bool
    omit_sidebar: bool
    search_filters: dict[str, object]
    requested_playlist_id: str | None
    requested_all_artists: bool
    requested_related_artists: list[str]
    requested_primary_filter: bool
    page_mode: str | None
    family_display_mode: str | None
    timeline_at: str | None


def _request_flag(value: object) -> bool:
    return str(value or "").strip().casefold() in {"1", "true", "yes", "on"}


def _query_args_getlist(query_args: object, key: str) -> list[object]:
    getlist = getattr(query_args, "getlist", None)
    if callable(getlist):
        return list(getlist(key))
    get = getattr(query_args, "get", None)
    if not callable(get):
        return []
    value = get(key, [])
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


def _resolve_view_payload_request(
    *,
    active_surface_override: str | None = None,
    query_args: object = None,
) -> _ViewPayloadRequest:
    args = query_args if query_args is not None else {}
    query_raw = str(args.get("q", "") or "").strip()
    active_surface = resolve_active_view_surface(
        active_surface_override
        if active_surface_override is not None
        else args.get("surface")
    )
    gallery_scope = normalize_gallery_scope(args.get("gallery_scope"))
    gallery_display_mode = normalize_gallery_display_mode(args.get("gallery_display"))
    gallery_scale_percent = normalize_gallery_scale_percent(args.get("gallery_scale_percent"))
    category_values = _query_args_getlist(args, "category")
    category_filter_requested = bool(category_values)
    requested_payload_tier = str(args.get("payload_tier", "") or "").strip().casefold()

    return _ViewPayloadRequest(
        query_raw=query_raw,
        query=normalize_search_text(query_raw),
        active_surface=active_surface,
        gallery_scope=gallery_scope,
        gallery_display_mode=gallery_display_mode,
        gallery_scale_percent=gallery_scale_percent,
        arrivals_only_scope=gallery_scope == "new_arrivals",
        category_filter_requested=category_filter_requested,
        root_aware_filtering_active=gallery_scope == "new_arrivals" or category_filter_requested,
        selected_artist_family_display_mode=_normalize_selected_artist_family_display_mode(
            args.get("family_display")
        ),
        local_tree_submode=_normalize_local_tree_submode(args.get("tree_mode")),
        visible_library_categories=normalize_visible_categories(
            category_values,
            gallery_scope,
        ),
        requested_artist=str(args.get("artist", "") or "").strip(),
        requested_payload_tier=requested_payload_tier,
        sidebar_only_payload=requested_payload_tier == "sidebar",
        omit_sidebar=_request_flag(args.get("omit_sidebar", "")),
        search_filters=build_search_filter_state(
            genre=_query_args_getlist(args, "genre"),
            mood=_query_args_getlist(args, "mood"),
            style=_query_args_getlist(args, "style"),
            duration_min=args.get("duration_min"),
            duration_max=args.get("duration_max"),
        ),
        requested_playlist_id=args.get("playlist_id"),
        requested_all_artists=_request_flag(args.get("all_artists", "")),
        requested_related_artists=[
            value.strip()
            for value in _query_args_getlist(args, "related_artist")
            if value and value.strip()
        ],
        requested_primary_filter=_request_flag(args.get("primary_filter", "")),
        page_mode=args.get("page_mode"),
        family_display_mode=args.get("family_display"),
        timeline_at=args.get("timeline_at"),
    )


def _freeze_cache_signature(value: object) -> object:
    if isinstance(value, dict):
        return tuple(
            (str(key), _freeze_cache_signature(item_value))
            for key, item_value in sorted(value.items(), key=lambda item: str(item[0]))
        )
    if isinstance(value, (list, tuple)):
        return tuple(_freeze_cache_signature(item) for item in value)
    if isinstance(value, set):
        return tuple(sorted(_freeze_cache_signature(item) for item in value))
    return value


def _build_root_browse_cache_key(
    *,
    albums_state: object,
    relation_view_cache_identity: int,
    gallery_scope: str,
    visible_library_categories: Iterable[str],
    viewer_opinion_preference_signature: object,
) -> tuple[object, ...]:
    return (
        id(albums_state),
        relation_view_cache_identity,
        gallery_scope,
        tuple(visible_library_categories),
        viewer_opinion_preference_signature,
    )


def _write_root_browse_cache_payload(
    root_browse_cache: dict[object, object] | None,
    root_browse_cache_key: tuple[object, ...] | None,
    **payload_updates: object,
) -> dict[str, object] | None:
    if not isinstance(root_browse_cache, dict) or root_browse_cache_key is None or not payload_updates:
        return None
    existing_root_payload = root_browse_cache.get(root_browse_cache_key)
    root_payload = dict(existing_root_payload) if isinstance(existing_root_payload, dict) else {}
    root_payload.update(payload_updates)
    root_browse_cache.clear()
    root_browse_cache[root_browse_cache_key] = root_payload
    return root_payload


def _build_search_bucket_cache_key(
    *,
    albums_state: object,
    relation_view_cache_identity: int,
    query: str,
) -> tuple[object, ...]:
    return (
        id(albums_state),
        relation_view_cache_identity,
        query,
    )


def _resolve_search_buckets(
    library_state: dict[str, object],
    *,
    albums_state: object,
    relation_view_cache_identity: int,
    all_albums: list[object],
    relation_views: dict[str, object],
    query: str,
) -> dict[str, object]:
    if not query:
        return artist_search_buckets(all_albums, relation_views, query)

    search_bucket_cache = library_state.setdefault("_view_payload_search_bucket_cache", {})
    search_bucket_cache_key = _build_search_bucket_cache_key(
        albums_state=albums_state,
        relation_view_cache_identity=relation_view_cache_identity,
        query=query,
    )
    cached_search_buckets = search_bucket_cache.get(search_bucket_cache_key)
    if isinstance(cached_search_buckets, dict):
        return cached_search_buckets

    search_buckets = artist_search_buckets(all_albums, relation_views, query)
    search_bucket_cache.clear()
    search_bucket_cache[search_bucket_cache_key] = search_buckets
    return search_buckets


def _build_query_artist_group_cache_key(
    *,
    albums_state: object,
    relation_views_state: object,
    query: str,
    visible_library_categories: Iterable[str],
    ordered_artists: Iterable[str],
    viewer_opinion_preference_signature: object | None = None,
) -> tuple[object, ...]:
    cache_key: tuple[object, ...] = (
        id(albums_state),
        id(relation_views_state),
        query,
        tuple(visible_library_categories),
        tuple(ordered_artists),
    )
    if viewer_opinion_preference_signature is not None:
        return (*cache_key, viewer_opinion_preference_signature)
    return cache_key


def _resolve_query_artist_group_index(
    library_state: dict[str, object],
    *,
    albums_state: object,
    relation_views_state: object,
    query: str,
    visible_library_categories: Iterable[str],
    ordered_artists: Iterable[str],
    filtered_albums: list[object],
    alias_to_canonical: dict[str, str],
    album_group_match_cache: dict[tuple[str, str], bool],
    viewer_opinion_preference_signature: object | None = None,
) -> tuple[dict[str, list[object]], tuple[object, ...]]:
    query_group_cache = library_state.setdefault("_view_payload_query_group_cache", {})
    query_group_cache_key = _build_query_artist_group_cache_key(
        albums_state=albums_state,
        relation_views_state=relation_views_state,
        query=query,
        visible_library_categories=visible_library_categories,
        ordered_artists=ordered_artists,
        viewer_opinion_preference_signature=viewer_opinion_preference_signature,
    )
    cached_query_artist_group_index = query_group_cache.get(query_group_cache_key)
    if isinstance(cached_query_artist_group_index, dict):
        return cached_query_artist_group_index, query_group_cache_key

    query_artist_group_index = {
        artist: [
            album for album in filtered_albums
            if _compat_cached_album_matches_group_artist(
                album,
                artist,
                alias_to_canonical,
                album_group_match_cache,
            )
        ]
        for artist in ordered_artists
    }
    query_group_cache.clear()
    query_group_cache[query_group_cache_key] = query_artist_group_index
    return query_artist_group_index, query_group_cache_key


def _build_query_selected_artist_group_cache_key(
    *,
    query_group_cache_key: tuple[object, ...],
    artist: str,
    public_safe: bool,
    selected_artist_album_note_cache_signature: object,
) -> tuple[object, ...]:
    return (
        query_group_cache_key,
        artist,
        public_safe,
        selected_artist_album_note_cache_signature,
    )


def _warm_query_selected_artist_group_cache(
    selected_artist_group_cache: dict[object, object],
    *,
    query_group_cache_key: tuple[object, ...],
    warm_precompute_artists: list[str],
    public_safe: bool,
    selected_artist_album_note_cache_signature: object,
    build_cached_selected_artist_groups,
) -> None:
    warm_cache_keys = [
        _build_query_selected_artist_group_cache_key(
            query_group_cache_key=query_group_cache_key,
            artist=artist,
            public_safe=public_safe,
            selected_artist_album_note_cache_signature=selected_artist_album_note_cache_signature,
        )
        for artist in warm_precompute_artists
    ]
    if all(cache_key in selected_artist_group_cache for cache_key in warm_cache_keys):
        return

    selected_artist_group_cache.clear()
    for artist in warm_precompute_artists:
        selected_artist_group_cache[
            _build_query_selected_artist_group_cache_key(
                query_group_cache_key=query_group_cache_key,
                artist=artist,
                public_safe=public_safe,
                selected_artist_album_note_cache_signature=selected_artist_album_note_cache_signature,
            )
        ] = build_cached_selected_artist_groups(artist)


def _build_full_selected_artist_group_cache_key(
    *,
    albums_state: object,
    relation_view_cache_identity: int,
    visible_library_categories: Iterable[str],
    selected_artist: str,
    public_safe: bool,
    viewer_opinion_preference_signature: object,
    selected_artist_album_note_cache_signature: object,
) -> tuple[object, ...]:
    return (
        id(albums_state),
        relation_view_cache_identity,
        tuple(visible_library_categories),
        selected_artist,
        public_safe,
        viewer_opinion_preference_signature,
        selected_artist_album_note_cache_signature,
    )


def _write_full_selected_artist_group_cache_payload(
    selected_artist_group_cache: dict[object, object],
    full_selected_artist_cache_key: tuple[object, ...] | None,
    *,
    family_artists: list[str],
    primary_artist_groups: list[dict[str, object]],
    family_artist_groups: list[dict[str, object]],
    timings: dict[str, float],
) -> None:
    if full_selected_artist_cache_key is None:
        return

    selected_artist_group_cache.clear()
    selected_artist_group_cache[full_selected_artist_cache_key] = {
        "family_artists": list(family_artists),
        "primary_artist_groups": list(primary_artist_groups),
        "family_artist_groups": list(family_artist_groups),
        "timings": {
            "selected_artist_primary_album_collection_ms": timings.get("selected_artist_primary_album_collection_ms", 0.0),
            "selected_artist_family_album_collection_ms": timings.get("selected_artist_family_album_collection_ms", 0.0),
            "selected_artist_primary_group_build_ms": timings.get("selected_artist_primary_group_build_ms", 0.0),
            "selected_artist_family_group_build_ms": timings.get("selected_artist_family_group_build_ms", 0.0),
        },
    }


def _build_sidebar_cache_key(
    *,
    albums_state: object,
    relation_view_cache_identity: int,
    query: str,
    gallery_scope: str,
    visible_library_categories: Iterable[str],
) -> tuple[object, ...]:
    return (
        id(albums_state),
        relation_view_cache_identity,
        query,
        gallery_scope,
        tuple(visible_library_categories),
    )


def _resolve_artists_sidebar(
    library_state: dict[str, object],
    *,
    albums_state: object,
    relation_view_cache_identity: int,
    query: str,
    gallery_scope: str,
    visible_library_categories: Iterable[str],
    sidebar_source_albums: list[object],
    relation_views: dict[str, object],
) -> list[dict[str, object]]:
    sidebar_cache = library_state.setdefault("_view_payload_sidebar_cache", {})
    sidebar_cache_key = _build_sidebar_cache_key(
        albums_state=albums_state,
        relation_view_cache_identity=relation_view_cache_identity,
        query=query,
        gallery_scope=gallery_scope,
        visible_library_categories=visible_library_categories,
    )
    cached_sidebar = sidebar_cache.get(sidebar_cache_key)
    if isinstance(cached_sidebar, list):
        return list(cached_sidebar)

    artists_sidebar = build_artists_sidebar(sidebar_source_albums, relation_views)
    sidebar_cache.clear()
    sidebar_cache[sidebar_cache_key] = list(artists_sidebar)
    return artists_sidebar


def _build_non_album_candidate_cache_key(
    *,
    file_cache: object,
    relation_view_cache_identity: int,
    visible_library_categories: Iterable[str],
) -> tuple[object, ...]:
    return (
        id(file_cache),
        relation_view_cache_identity,
        tuple(visible_library_categories),
    )


def _resolve_non_album_candidates(
    library_state: dict[str, object],
    *,
    config: object,
    file_cache: dict[str, object],
    relation_view_cache_identity: int,
    visible_library_categories: Iterable[str],
    alias_to_canonical: dict[str, str],
) -> list[dict[str, object]]:
    non_album_candidate_cache = library_state.setdefault("_view_payload_non_album_candidate_cache", {})
    non_album_candidate_cache_key = _build_non_album_candidate_cache_key(
        file_cache=file_cache,
        relation_view_cache_identity=relation_view_cache_identity,
        visible_library_categories=visible_library_categories,
    )
    cached_non_album_candidates = non_album_candidate_cache.get(non_album_candidate_cache_key)
    if isinstance(cached_non_album_candidates, list):
        return cached_non_album_candidates

    non_album_candidates = _build_non_album_entry_candidates(
        file_cache,
        alias_to_canonical,
        list(visible_library_categories),
        config=config,
    )
    non_album_candidate_cache.clear()
    non_album_candidate_cache[non_album_candidate_cache_key] = non_album_candidates
    return non_album_candidates


def _visible_artist_path_candidates(
    visible_artist_names: Iterable[str],
    relation_views: dict[str, object],
) -> set[str]:
    canonical_to_aliases = relation_views.get("canonical_to_aliases", {}) or {}
    candidate_names: set[str] = set()
    for artist in visible_artist_names:
        artist_text = str(artist or "").strip()
        if not artist_text:
            continue
        candidate_names.add(normalize_search_text(artist_text))
        for alias in canonical_to_aliases.get(artist_text, []):
            alias_text = str(alias or "").strip()
            if alias_text:
                candidate_names.add(normalize_search_text(alias_text))
    return {candidate for candidate in candidate_names if candidate}


def _non_album_entry_path_parts(entry: dict[str, object], *, config: object) -> frozenset[str]:
    rel_match = relative_parts_within_roots(config, str(entry.get("path") or ""))
    if rel_match is None:
        return frozenset()
    _, rel_parts_all = rel_match
    rel_parts = rel_parts_all[:-1]
    return frozenset(
        normalize_search_text(part)
        for part in rel_parts
        if part
    )


def _build_non_album_entry_candidates(
    file_cache: dict[str, object],
    alias_to_canonical: dict[str, str],
    visible_library_categories: list[str],
    *,
    config: object,
) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    for entry in file_cache.values():
        if not isinstance(entry, dict):
            continue
        exception_type = normalize_exception_value(entry.get("exception_type"))
        if (
            not exception_type
            and has_meaningful_album_name(entry.get("album"))
            and not is_loose_track_album_value(entry.get("album"))
        ):
            continue
        entry_artist = str(entry.get("album_artist") or entry.get("artist") or "")
        canonical_artist = alias_to_canonical.get(entry_artist, entry_artist)
        normalized_copy = dict(entry)
        normalized_copy["album_artist"] = canonical_artist or entry_artist
        normalized_copy["exception_type"] = exception_type
        if not entry_visible_in_categories(normalized_copy, visible_library_categories):
            continue
        candidates.append({
            "entry": normalized_copy,
            "entry_artist": entry_artist,
            "canonical_artist": canonical_artist,
            "path_parts": _non_album_entry_path_parts(entry, config=config),
        })
    return candidates


def _resolve_casefold_relation_views(
    st: dict[str, object],
    all_albums: list[object],
    *,
    config: object = None,
    allow_rebuild_alias_views: bool = True,
) -> tuple[dict[str, object], dict[str, str], dict[str, list[str]]]:
    relation_views_state = st.get("relation_views", {}) or {}
    relation_views = dict(relation_views_state)
    cached_alias_to_canonical = relation_views_state.get("casefold_alias_to_canonical", {}) if isinstance(relation_views_state, dict) else {}
    cached_canonical_to_aliases = relation_views_state.get("casefold_canonical_to_aliases", {}) if isinstance(relation_views_state, dict) else {}
    has_cached_casefold_views = (
        isinstance(relation_views_state, dict)
        and "casefold_alias_to_canonical" in relation_views_state
        and "casefold_canonical_to_aliases" in relation_views_state
    )
    if has_cached_casefold_views and isinstance(cached_alias_to_canonical, dict) and isinstance(cached_canonical_to_aliases, dict):
        relation_views["alias_to_canonical"] = cached_alias_to_canonical
        relation_views["canonical_to_aliases"] = cached_canonical_to_aliases
        return relation_views, cached_alias_to_canonical, cached_canonical_to_aliases

    alias_to_canonical, canonical_to_aliases = enrich_casefold_artist_alias_views(
        all_albums,
        relation_views.get("alias_to_canonical", {}) or {},
        relation_views.get("canonical_to_aliases", {}) or {},
        allow_rebuild_alias_views=allow_rebuild_alias_views,
        config=config,
    )
    if isinstance(relation_views_state, dict):
        relation_views_state["casefold_alias_to_canonical"] = alias_to_canonical
        relation_views_state["casefold_canonical_to_aliases"] = canonical_to_aliases
    relation_views["alias_to_canonical"] = alias_to_canonical
    relation_views["canonical_to_aliases"] = canonical_to_aliases
    return relation_views, alias_to_canonical, canonical_to_aliases


def _ordered_gallery_albums_from_artist_groups(
    artist_groups: list[dict[str, object]],
    album_lookup: dict[str, object],
) -> list[object]:
    ordered_albums: list[object] = []
    seen_refs: set[str] = set()
    for group in artist_groups or []:
        if not isinstance(group, dict):
            continue
        for album_payload in list(group.get("albums") or []):
            if not isinstance(album_payload, dict):
                continue
            album_ref = str(album_payload.get("key") or "").strip()
            if not album_ref or album_ref in seen_refs:
                continue
            album = album_lookup.get(album_ref)
            if album is None:
                continue
            seen_refs.add(album_ref)
            ordered_albums.append(album)
    return ordered_albums


def _normalize_selected_artist_family_display_mode(family_display_mode: object) -> str:
    normalized = str(family_display_mode or "").strip().casefold()
    return (
        normalized
        if normalized in _SELECTED_ARTIST_FAMILY_DISPLAY_MODES
        else "grouped"
    )


def _normalize_local_tree_submode(value: object) -> str:
    normalized = str(value or "").strip().casefold()
    if normalized in {"folders", "artists", "albums", "broad_genres", "subtle_genres"}:
        return normalized
    return "folders"


def _selected_artist_family_tag_ref(
    artist_name: object,
    alias_to_canonical: dict[str, str],
) -> str | None:
    from music_app.services.selected_artist_membership import collaboration_alias_of

    artist_text = str(artist_name or "").strip()
    if not artist_text:
        return None
    canonical_artist = str(
        alias_to_canonical.get(artist_text, artist_text) or artist_text
    ).strip() or artist_text
    identity_artist = (
        artist_text
        if collaboration_alias_of(artist_text, canonical_artist)
        else canonical_artist
    )
    normalized_ref = compact_search_key(identity_artist)
    return f"artist-family:{normalized_ref}" if normalized_ref else None


def _selected_artist_family_variation_names(
    artist_name: object,
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
) -> list[str]:
    from music_app.services.selected_artist_membership import collaboration_alias_of

    artist_text = str(artist_name or "").strip()
    if not artist_text:
        return []
    canonical_artist = str(
        alias_to_canonical.get(artist_text, artist_text) or artist_text
    ).strip() or artist_text
    if collaboration_alias_of(artist_text, canonical_artist):
        return [artist_text]
    ordered_names: list[str] = []
    seen_names: set[str] = set()

    for candidate in [
        canonical_artist,
        *(canonical_to_aliases.get(canonical_artist, []) or []),
        artist_text,
    ]:
        candidate_text = str(candidate or "").strip()
        candidate_key = artist_display_dedupe_key(
            candidate_text
        )
        if (
            not candidate_text
            or candidate_key in seen_names
            or collaboration_alias_of(candidate_text, canonical_artist)
        ):
            continue
        seen_names.add(candidate_key)
        ordered_names.append(candidate_text)

    return ordered_names


def _selected_artist_family_filter_payloads(
    selected_artist: object,
    family_artists: list[str],
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
) -> list[dict[str, object]]:
    filters: list[dict[str, object]] = []
    seen_filter_refs: set[str] = set()

    for index, artist_name in enumerate([selected_artist, *(family_artists or [])]):
        tag_ref = _selected_artist_family_tag_ref(artist_name, alias_to_canonical)
        if not tag_ref or tag_ref in seen_filter_refs:
            continue
        variation_names = _selected_artist_family_variation_names(
            artist_name,
            alias_to_canonical,
            canonical_to_aliases,
        )
        filters.append({
            "family_tag_ref": tag_ref,
            "display_name": variation_names[0] if variation_names else str(artist_name or "").strip(),
            "variation_names": variation_names,
            "is_selected_artist": index == 0,
        })
        seen_filter_refs.add(tag_ref)

    return filters


def _selected_artist_album_display_artist(album_payload: dict[str, object]) -> str:
    for candidate in (
        album_payload.get("display_artist"),
        album_payload.get("album_artist"),
        album_payload.get("artist"),
    ):
        text = str(candidate or "").strip()
        if text:
            return text
    return ""


def _selected_artist_album_artist_credits(
    album_payload: dict[str, object],
) -> list[str]:
    ordered_credits: list[str] = []
    seen_credits: set[str] = set()

    for candidate in [
        _selected_artist_album_display_artist(album_payload),
        album_payload.get("album_artist"),
        *(album_payload.get("artists") or []),
    ]:
        text = str(candidate or "").strip()
        key = artist_display_dedupe_key(text)
        if not text or key in seen_credits:
            continue
        seen_credits.add(key)
        ordered_credits.append(text)

    return ordered_credits


def _dedupe_artist_display_names(values: object) -> list[str]:
    ordered_names: list[str] = []
    seen_names: set[str] = set()

    for candidate in list(values or []):
        text = str(candidate or "").strip()
        dedupe_key = artist_display_dedupe_key(text)
        if not text or dedupe_key in seen_names:
            continue
        seen_names.add(dedupe_key)
        ordered_names.append(text)

    return ordered_names


def _merge_artist_family_variation_names_by_tag_ref(
    existing_mapping: object,
    incoming_mapping: object,
) -> dict[str, list[str]]:
    merged_mapping: dict[str, list[str]] = {}

    for source_mapping in [existing_mapping, incoming_mapping]:
        if not isinstance(source_mapping, dict):
            continue
        for raw_tag_ref, raw_names in source_mapping.items():
            tag_ref = str(raw_tag_ref or "").strip()
            if not tag_ref:
                continue
            merged_names = _dedupe_artist_display_names(raw_names)
            if not merged_names:
                continue
            existing_names = merged_mapping.get(tag_ref, [])
            merged_mapping[tag_ref] = _dedupe_artist_display_names(
                [*existing_names, *merged_names]
            )

    return merged_mapping


def _decorate_selected_artist_album_payload(
    album_payload: dict[str, object],
    *,
    tag_refs: list[str],
    variation_names_by_tag_ref: dict[str, list[str]] | None = None,
) -> dict[str, object]:
    decorated_payload = dict(album_payload)
    display_artist = _selected_artist_album_display_artist(decorated_payload)
    if display_artist:
        decorated_payload["display_artist"] = display_artist
    decorated_payload["artist_credits_seen"] = _selected_artist_album_artist_credits(
        decorated_payload
    )
    decorated_payload["artist_family_tag_refs"] = list(tag_refs)
    family_variation_names_by_tag_ref = _merge_artist_family_variation_names_by_tag_ref(
        decorated_payload.get("artist_family_variation_names_by_tag_ref"),
        variation_names_by_tag_ref or {},
    )
    if family_variation_names_by_tag_ref:
        decorated_payload["artist_family_variation_names_by_tag_ref"] = (
            family_variation_names_by_tag_ref
        )
    return decorated_payload


def _decorate_selected_artist_group_payloads(
    artist_groups: list[dict[str, object]],
    *,
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
) -> list[dict[str, object]]:
    decorated_groups: list[dict[str, object]] = []

    for group in list(artist_groups or []):
        if not isinstance(group, dict):
            continue
        decorated_group = dict(group)
        group_artist = str(decorated_group.get("artist") or "").strip()
        family_tag_ref = _selected_artist_family_tag_ref(
            group_artist,
            alias_to_canonical,
        )
        if family_tag_ref:
            decorated_group["family_tag_ref"] = family_tag_ref
        variation_names = _selected_artist_family_variation_names(
            group_artist,
            alias_to_canonical,
            canonical_to_aliases,
        )
        if variation_names:
            decorated_group["variation_names"] = variation_names
        decorated_group["albums"] = [
            _decorate_selected_artist_album_payload(
                album_payload,
                tag_refs=[family_tag_ref] if family_tag_ref else [],
                variation_names_by_tag_ref=(
                    {family_tag_ref: variation_names}
                    if family_tag_ref and variation_names
                    else None
                ),
            )
            for album_payload in list(decorated_group.get("albums") or [])
            if isinstance(album_payload, dict)
        ]
        decorated_group["sections"] = _build_selected_artist_compatibility_sections(
            decorated_group["albums"]
        )
        decorated_groups.append(decorated_group)

    return decorated_groups


def _selected_artist_source_groups(
    primary_artist_groups: list[dict[str, object]],
    family_artist_groups: list[dict[str, object]],
) -> list[dict[str, object]]:
    return [
        group
        for group in [*(primary_artist_groups or []), *(family_artist_groups or [])]
        if isinstance(group, dict)
    ]


def _selected_artist_included_album_payloads(
    primary_artist_groups: list[dict[str, object]],
    family_artist_groups: list[dict[str, object]],
) -> list[dict[str, object]]:
    included_albums: list[dict[str, object]] = []
    seen_album_refs: dict[str, int] = {}

    for group in _selected_artist_source_groups(
        primary_artist_groups,
        family_artist_groups,
    ):
        for album_payload in list(group.get("albums") or []):
            if not isinstance(album_payload, dict):
                continue
            album_ref = str(album_payload.get("key") or "").strip()
            if album_ref:
                existing_index = seen_album_refs.get(album_ref)
                if existing_index is not None:
                    existing_album = included_albums[existing_index]
                    merged_tag_refs = list(existing_album.get("artist_family_tag_refs") or [])
                    for tag_ref in list(album_payload.get("artist_family_tag_refs") or []):
                        if tag_ref and tag_ref not in merged_tag_refs:
                            merged_tag_refs.append(tag_ref)
                    existing_album["artist_family_tag_refs"] = merged_tag_refs
                    merged_variation_names_by_tag_ref = (
                        _merge_artist_family_variation_names_by_tag_ref(
                            existing_album.get(
                                "artist_family_variation_names_by_tag_ref"
                            ),
                            album_payload.get(
                                "artist_family_variation_names_by_tag_ref"
                            ),
                        )
                    )
                    if merged_variation_names_by_tag_ref:
                        existing_album["artist_family_variation_names_by_tag_ref"] = (
                            merged_variation_names_by_tag_ref
                        )
                    continue
                seen_album_refs[album_ref] = len(included_albums)
            included_albums.append(album_payload)

    return included_albums


def _selected_artist_visible_artist_count(
    primary_artist_groups: list[dict[str, object]],
    family_artist_groups: list[dict[str, object]],
) -> int:
    visible_artist_keys: set[str] = set()

    for group in _selected_artist_source_groups(
        primary_artist_groups,
        family_artist_groups,
    ):
        artist = str(group.get("artist") or "").strip()
        artist_key = artist_display_dedupe_key(artist)
        if artist_key:
            visible_artist_keys.add(artist_key)

    return len(visible_artist_keys)


def _selected_artist_album_refs_from_groups(
    primary_artist_groups: list[dict[str, object]],
    family_artist_groups: list[dict[str, object]],
) -> list[str]:
    album_refs: list[str] = []
    seen_album_refs: set[str] = set()

    for album_payload in _selected_artist_included_album_payloads(
        primary_artist_groups,
        family_artist_groups,
    ):
        album_ref = str(album_payload.get("key") or "").strip()
        if not album_ref or album_ref in seen_album_refs:
            continue
        seen_album_refs.add(album_ref)
        album_refs.append(album_ref)

    return album_refs


def _build_selected_artist_listen_through_scope(
    *,
    scope_kind: str,
    album_refs: list[str],
) -> dict[str, object]:
    normalized_album_refs = list(album_refs or [])
    return {
        "scope_kind": scope_kind,
        "in_scope_album_refs": normalized_album_refs,
        "local_completion_denominator": {
            "album_refs": normalized_album_refs,
            "album_count": len(normalized_album_refs),
        },
        "missing_releases": [],
    }


def _selected_artist_listen_through_scope_candidates(
    *,
    selected_artist: object,
    primary_artist_groups: list[dict[str, object]],
    family_artist_groups: list[dict[str, object]],
    selected_artist_family_filters: list[dict[str, object]],
) -> dict[str, object]:
    selected_artist_ref = str(selected_artist or "").strip()
    if not selected_artist_ref:
        return {}

    primary_album_refs = _selected_artist_album_refs_from_groups(
        primary_artist_groups,
        [],
    )
    family_album_refs = _selected_artist_album_refs_from_groups(
        primary_artist_groups,
        family_artist_groups,
    )
    primary_family_tag_ref = ""
    for group in list(primary_artist_groups or []):
        primary_family_tag_ref = str(group.get("family_tag_ref") or "").strip()
        if primary_family_tag_ref:
            break

    family_tag_refs: list[str] = []
    seen_family_tag_refs: set[str] = set()
    for filter_payload in list(selected_artist_family_filters or []):
        family_tag_ref = str(filter_payload.get("family_tag_ref") or "").strip()
        if not family_tag_ref or family_tag_ref in seen_family_tag_refs:
            continue
        seen_family_tag_refs.add(family_tag_ref)
        family_tag_refs.append(family_tag_ref)

    return {
        "artist": {
            **_build_selected_artist_listen_through_scope(
                scope_kind="artist",
                album_refs=primary_album_refs,
            ),
            "artist_ref": selected_artist_ref,
            "family_tag_ref": primary_family_tag_ref or None,
        },
        "artist_family": {
            **_build_selected_artist_listen_through_scope(
                scope_kind="artist_family",
                album_refs=family_album_refs,
            ),
            "selected_artist_ref": selected_artist_ref,
            "family_tag_refs": family_tag_refs,
        },
    }


def _selected_artist_visible_artist_names(
    primary_artist_groups: list[dict[str, object]],
    family_artist_groups: list[dict[str, object]],
) -> set[str]:
    visible_artist_names: set[str] = set()

    for group in _selected_artist_source_groups(
        primary_artist_groups,
        family_artist_groups,
    ):
        artist = str(group.get("artist") or "").strip()
        if artist:
            visible_artist_names.add(artist)

    return visible_artist_names


def _selected_artist_chronological_album_sort_key(
    album_payload: dict[str, object],
) -> tuple[str, int, str, str]:
    release_date = str(album_payload.get("release_date") or "").strip()
    normalized_release_date = ""
    if release_date:
        parts = release_date.split("-")
        if 1 <= len(parts) <= 3 and all(part.isdigit() for part in parts):
            year_part = parts[0].zfill(4)
            month_part = parts[1].zfill(2) if len(parts) >= 2 else "99"
            day_part = parts[2].zfill(2) if len(parts) >= 3 else "99"
            normalized_release_date = f"{year_part}-{month_part}-{day_part}"

    year_value = album_payload.get("year")
    try:
        year = int(year_value)
    except (TypeError, ValueError):
        year = 9999

    release_date_key = (
        normalized_release_date
        or (f"{year:04d}-99-99" if year != 9999 else "9999-99-99")
    )
    return (
        release_date_key,
        year,
        str(album_payload.get("name") or "").casefold(),
        str(album_payload.get("key") or "").casefold(),
    )


def _build_selected_artist_compatibility_sections(
    albums: list[dict[str, object]],
) -> list[dict[str, object]]:
    return [{
        "section_ref": "unclassified",
        "section_label": "Unclassified",
        "section_kind": "parent_section",
        "albums": list(albums or []),
        "subsections": [],
    }]


def _build_artist_page_gallery_payload(
    *,
    artist_ref: str,
) -> dict[str, object]:
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
        "listen_through_scope_candidates_field": (
            "listen_through_scope_candidates"
        ),
    }


def _render_selected_artist_artist_groups(
    primary_artist_groups: list[dict[str, object]],
    family_artist_groups: list[dict[str, object]],
    *,
    family_display_mode: object,
) -> list[dict[str, object]]:
    normalized_family_display_mode = _normalize_selected_artist_family_display_mode(
        family_display_mode
    )
    if normalized_family_display_mode != "chronological":
        return [
            *list(primary_artist_groups or []),
            *list(family_artist_groups or []),
        ]

    chronological_albums = sorted(
        _selected_artist_included_album_payloads(
            primary_artist_groups,
            family_artist_groups,
        ),
        key=_selected_artist_chronological_album_sort_key,
    )
    if not chronological_albums:
        return []

    return [{
        "artist": "Chronological",
        "artist_display": "Chronological",
        "albums": chronological_albums,
        "sections": _build_selected_artist_compatibility_sections(
            chronological_albums
        ),
    }]


def _regroup_cached_selected_artist_source_groups(
    cached_selected_artist_groups: dict[str, object],
    *,
    related_filter_artists: list[str],
    primary_filter_active: bool,
) -> dict[str, object] | None:
    if not isinstance(cached_selected_artist_groups, dict):
        return None

    cached_primary_groups = cached_selected_artist_groups.get("primary_artist_groups")
    cached_family_groups = cached_selected_artist_groups.get("family_artist_groups")
    if not isinstance(cached_primary_groups, list) or not isinstance(cached_family_groups, list):
        return None

    related_filter_keys = {
        artist_display_dedupe_key(artist)
        for artist in list(related_filter_artists or [])
        if artist
    }
    include_primary_groups = primary_filter_active or not related_filter_keys
    primary_groups = deepcopy(cached_primary_groups) if include_primary_groups else []

    family_groups: list[dict[str, object]] = []
    for group in cached_family_groups:
        if not isinstance(group, dict):
            continue
        if related_filter_keys:
            group_artist = str(group.get("artist") or "").strip()
            group_key = artist_display_dedupe_key(group_artist)
            if not group_key or group_key not in related_filter_keys:
                continue
        family_groups.append(deepcopy(group))

    if not primary_groups and not family_groups:
        return None

    regrouped_payload = dict(cached_selected_artist_groups)
    regrouped_payload["primary_artist_groups"] = primary_groups
    regrouped_payload["family_artist_groups"] = family_groups
    return regrouped_payload


def _merge_selected_artist_cached_group_timings(
    timings: dict[str, float],
    cached_selected_artist_groups: object,
) -> None:
    if not isinstance(cached_selected_artist_groups, dict):
        return
    cached_group_timings = cached_selected_artist_groups.get("timings", {})
    if not isinstance(cached_group_timings, dict):
        return
    timings.update({
        key: float(value)
        for key, value in cached_group_timings.items()
        if isinstance(value, (int, float))
    })


def _derive_selected_artist_family_filter_state(
    *,
    family_artists: list[str],
    requested_related_artists: list[str],
    requested_primary_filter: bool,
) -> dict[str, object]:
    family_artist_keys = {
        artist_display_dedupe_key(artist)
        for artist in family_artists
        if artist
    }
    related_filter_artists = [
        artist
        for artist in requested_related_artists
        if artist_display_dedupe_key(artist) in family_artist_keys
    ]
    primary_filter_active = requested_primary_filter
    visible_family_artist_set = (
        set(related_filter_artists)
        if related_filter_artists
        else set(family_artists)
    )
    if primary_filter_active and not related_filter_artists:
        visible_family_artist_set = set()

    return {
        "family_artists": family_artists,
        "related_filter_artists": related_filter_artists,
        "primary_filter_active": primary_filter_active,
        "visible_family_artist_set": visible_family_artist_set,
    }


def _resolve_selected_artist_family_artists(
    selected_artist: str,
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
    *,
    config: object,
) -> dict[str, object]:
    artist = str(selected_artist or "").strip()
    if not artist:
        return {
            "family_artists": [],
            "alias_to_canonical": dict(alias_to_canonical or {}),
            "canonical_to_aliases": dict(canonical_to_aliases or {}),
        }

    persisted_projection = load_selected_artist_family_projection(config, artist)
    persisted_projection_loaded = bool(persisted_projection.get("loaded"))
    persisted_related_artists = list(persisted_projection.get("family_artists") or [])
    persisted_alias_to_canonical = {
        str(alias or "").strip(): str(canonical or "").strip()
        for alias, canonical in dict(
            persisted_projection.get("alias_to_canonical") or {}
        ).items()
        if str(alias or "").strip() and str(canonical or "").strip()
    }
    persisted_canonical_to_aliases = {
        str(canonical or "").strip(): [
            str(alias or "").strip()
            for alias in list(aliases or [])
            if str(alias or "").strip()
        ]
        for canonical, aliases in dict(
            persisted_projection.get("canonical_to_aliases") or {}
        ).items()
        if str(canonical or "").strip()
    }
    effective_alias_to_canonical = (
        persisted_alias_to_canonical
        if persisted_alias_to_canonical
        else dict(alias_to_canonical or {})
    )
    effective_canonical_to_aliases = (
        persisted_canonical_to_aliases
        if persisted_canonical_to_aliases
        else dict(canonical_to_aliases or {})
    )
    persisted_family_artists = membership_selected_artist_family_artists(
        artist,
        persisted_related_artists,
        effective_canonical_to_aliases,
        effective_alias_to_canonical,
    )
    if persisted_projection_loaded and persisted_related_artists:
        return {
            "family_artists": persisted_family_artists,
            "alias_to_canonical": effective_alias_to_canonical,
            "canonical_to_aliases": effective_canonical_to_aliases,
        }
    return {
        "family_artists": [],
        "alias_to_canonical": dict(alias_to_canonical or {}),
        "canonical_to_aliases": dict(canonical_to_aliases or {}),
    }


def _resolve_selected_artist_source_group_inputs(
    *,
    config: object,
    selected_artist: str,
    query: str,
    query_group_cache_key: tuple[object, ...] | None,
    full_selected_artist_cache_key: tuple[object, ...] | None,
    selected_artist_group_cache: dict[object, object],
    requested_related_artists: list[str],
    requested_primary_filter: bool,
    relation_views: dict[str, object],
    relations_last_built: float,
    canonical_to_aliases: dict[str, set[str]],
    alias_to_canonical: dict[str, str],
    public_safe: bool,
    selected_artist_album_note_cache_signature: object,
    cached_root_browse: object,
    clone_cached_artist_groups,
    build_cached_selected_artist_groups,
    timings: dict[str, float],
) -> dict[str, object]:
    """Resolve selected-artist group inputs, cached payloads, and family filters."""
    query_selected_artist_group_cache_key = (
        _build_query_selected_artist_group_cache_key(
            query_group_cache_key=query_group_cache_key,
            artist=selected_artist,
            public_safe=public_safe,
            selected_artist_album_note_cache_signature=selected_artist_album_note_cache_signature,
        )
        if query and query_group_cache_key is not None
        else None
    )
    cached_selected_artist_groups = (
        selected_artist_group_cache.get(query_selected_artist_group_cache_key)
        if query_selected_artist_group_cache_key is not None
        else selected_artist_group_cache.get(full_selected_artist_cache_key)
    )
    if (
        cached_selected_artist_groups is None
        and query_selected_artist_group_cache_key is not None
    ):
        cached_selected_artist_groups = build_cached_selected_artist_groups(selected_artist)
        selected_artist_group_cache[query_selected_artist_group_cache_key] = (
            cached_selected_artist_groups
        )
    use_cached_selected_artist_groups = bool(
        cached_selected_artist_groups is not None
        and not requested_related_artists
        and not requested_primary_filter
    )
    if use_cached_selected_artist_groups:
        _merge_selected_artist_cached_group_timings(
            timings,
            cached_selected_artist_groups,
        )

    if use_cached_selected_artist_groups:
        family_artists = list(cached_selected_artist_groups.get("family_artists", []))
    else:
        family_context = _resolve_selected_artist_family_artists(
            selected_artist,
            alias_to_canonical,
            canonical_to_aliases,
            config=config,
        )
        family_artists = list(family_context["family_artists"])
        alias_to_canonical = dict(family_context["alias_to_canonical"])
        canonical_to_aliases = dict(family_context["canonical_to_aliases"])

    selected_artist_family_filter_state = _derive_selected_artist_family_filter_state(
        family_artists=family_artists,
        requested_related_artists=requested_related_artists,
        requested_primary_filter=requested_primary_filter,
    )
    family_artists = list(selected_artist_family_filter_state["family_artists"])
    related_filter_artists = list(
        selected_artist_family_filter_state["related_filter_artists"]
    )
    primary_filter_active = bool(
        selected_artist_family_filter_state["primary_filter_active"]
    )
    visible_family_artist_set = set(
        selected_artist_family_filter_state["visible_family_artist_set"]
    )

    if cached_selected_artist_groups is not None and not use_cached_selected_artist_groups:
        regrouped_cached_selected_artist_groups = (
            _regroup_cached_selected_artist_source_groups(
                cached_selected_artist_groups,
                related_filter_artists=related_filter_artists,
                primary_filter_active=primary_filter_active,
            )
        )
        if regrouped_cached_selected_artist_groups is not None:
            cached_selected_artist_groups = regrouped_cached_selected_artist_groups
            use_cached_selected_artist_groups = True
            _merge_selected_artist_cached_group_timings(
                timings,
                cached_selected_artist_groups,
            )

    if (
        not public_safe
        and not use_cached_selected_artist_groups
        and not query
        and isinstance(cached_root_browse, dict)
    ):
        cached_selected_artist_groups = clone_cached_artist_groups(
            selected_artist,
            visible_family_artist_set,
        )
        use_cached_selected_artist_groups = cached_selected_artist_groups is not None
        if use_cached_selected_artist_groups:
            _merge_selected_artist_cached_group_timings(
                timings,
                cached_selected_artist_groups,
            )

    return {
        "cached_selected_artist_groups": cached_selected_artist_groups,
        "use_cached_selected_artist_groups": use_cached_selected_artist_groups,
        "family_artists": family_artists,
        "related_filter_artists": related_filter_artists,
        "primary_filter_active": primary_filter_active,
        "visible_family_artist_set": visible_family_artist_set,
    }


def _build_live_selected_artist_group_payloads(
    *,
    selected_artist: str,
    family_artists: list[str],
    related_filter_artists: list[str],
    primary_filter_active: bool,
    visible_family_artist_set: set[str],
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, set[str]],
    album_group_match_cache: dict[tuple[str, str], bool],
    album_payload_cache: dict[str, dict[str, object]],
    album_serializer,
    collect_selected_artist_album_sets,
    timings: dict[str, float],
    family_display_mode: str,
    full_selected_artist_cache_key: tuple[object, ...] | None,
    selected_artist_group_cache: dict[object, object],
    requested_related_artists: list[str],
    requested_primary_filter: bool,
    public_safe: bool,
) -> dict[str, list[dict[str, object]]]:
    """Build live selected-artist group payloads when cached groups cannot be reused."""
    primary_albums, primary_album_keys, family_albums, selected_artist_collection_timings = (
        collect_selected_artist_album_sets(
            selected_artist,
            visible_family_artist_set,
        )
    )
    timings.update(selected_artist_collection_timings)
    visible_family_artists = [
        artist for artist in family_artists if artist in visible_family_artist_set
    ]
    primary_groups_started_at = time.perf_counter()
    primary_artist_groups = (
        artist_group_helpers._build_artist_membership_groups(
            primary_albums,
            [selected_artist],
            alias_to_canonical,
            canonical_to_aliases,
            exact_group_matches=True,
            matches_group_artist_for_album=(
                lambda album, artist: membership_cached_album_matches_group_artist(
                    album,
                    artist,
                    alias_to_canonical,
                    album_group_match_cache,
                )
            ),
            album_payload_cache=album_payload_cache,
            album_serializer=album_serializer,
        )
        if (primary_filter_active or not related_filter_artists)
        else []
    )
    family_groups_started_at = time.perf_counter()
    family_artist_groups = artist_group_helpers._build_artist_membership_groups(
        family_albums,
        visible_family_artists,
        alias_to_canonical,
        canonical_to_aliases,
        exclude_album_keys=primary_album_keys,
        exact_group_matches=True,
        matches_group_artist_for_album=(
            lambda album, artist: membership_cached_album_matches_group_artist(
                album,
                artist,
                alias_to_canonical,
                album_group_match_cache,
            )
        ),
        album_payload_cache=album_payload_cache,
        album_serializer=album_serializer,
    )
    primary_artist_groups = _decorate_selected_artist_group_payloads(
        membership_merge_duplicate_artist_groups(primary_artist_groups),
        alias_to_canonical=alias_to_canonical,
        canonical_to_aliases=canonical_to_aliases,
    )
    family_artist_groups = _decorate_selected_artist_group_payloads(
        membership_merge_duplicate_artist_groups(family_artist_groups),
        alias_to_canonical=alias_to_canonical,
        canonical_to_aliases=canonical_to_aliases,
    )
    timings["selected_artist_primary_group_build_ms"] = round(
        (family_groups_started_at - primary_groups_started_at) * 1000,
        2,
    )
    timings["selected_artist_family_group_build_ms"] = round(
        (time.perf_counter() - family_groups_started_at) * 1000,
        2,
    )
    artist_groups = _render_selected_artist_artist_groups(
        primary_artist_groups,
        family_artist_groups,
        family_display_mode=family_display_mode,
    )
    if (
        full_selected_artist_cache_key is not None
        and not requested_related_artists
        and not requested_primary_filter
        and not public_safe
    ):
        _write_full_selected_artist_group_cache_payload(
            selected_artist_group_cache,
            full_selected_artist_cache_key,
            family_artists=list(family_artists),
            primary_artist_groups=list(primary_artist_groups),
            family_artist_groups=list(family_artist_groups),
            timings=timings,
        )
    return {
        "primary_artist_groups": primary_artist_groups,
        "family_artist_groups": family_artist_groups,
        "artist_groups": artist_groups,
    }


def _build_query_artist_groups(
    *,
    filtered_albums: list[object],
    direct_match_artists_ordered: list[str],
    related_match_artists_ordered: list[str],
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, set[str]],
    album_payload_cache: dict[str, dict[str, object]],
    album_serializer,
) -> list[dict[str, object]]:
    """Build merged direct-match and related-match artist groups for query views."""
    direct_groups = artist_group_helpers._build_artist_membership_groups(
        filtered_albums,
        direct_match_artists_ordered,
        alias_to_canonical,
        canonical_to_aliases,
        album_payload_cache=album_payload_cache,
        album_serializer=album_serializer,
    )
    related_groups = artist_group_helpers._build_artist_membership_groups(
        filtered_albums,
        related_match_artists_ordered,
        alias_to_canonical,
        canonical_to_aliases,
        album_payload_cache=album_payload_cache,
        album_serializer=album_serializer,
    )
    return membership_merge_duplicate_artist_groups(
        direct_groups + related_groups
    )


def _resolve_root_browse_artist_groups(
    *,
    cached_root_browse: object,
    filtered_albums: list[object],
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, set[str]],
    album_serializer,
    root_browse_cache: dict[object, object] | None,
    root_browse_cache_key: tuple[object, ...] | None,
    timings: dict[str, float],
) -> list[dict[str, object]]:
    """Resolve root-browse artist groups from cache or rebuild them from albums."""
    cached_root_artist_groups = (
        cached_root_browse.get("artist_groups")
        if isinstance(cached_root_browse, dict)
        else None
    )
    if isinstance(cached_root_artist_groups, list):
        return list(cached_root_artist_groups)

    root_artist_groups_started_at = time.perf_counter()
    artist_groups = membership_merge_duplicate_artist_groups(
        artist_group_helpers.build_artist_groups(
            filtered_albums,
            alias_to_canonical,
            canonical_to_aliases,
            album_serializer=album_serializer,
        )
    )
    timings["root_artist_groups_build_ms"] = round(
        (time.perf_counter() - root_artist_groups_started_at) * 1000,
        2,
    )
    _write_root_browse_cache_payload(
        root_browse_cache,
        root_browse_cache_key,
        artist_groups=list(artist_groups),
    )
    return artist_groups


def build_view_payload(
    *,
    public_safe: bool = False,
    active_surface_override: str | None = None,
    query_args: object = None,
    config: object = None,
    logger: object = None,
    library_state: dict[str, object] | None = None,
    client_surface_class: object = None,
) -> dict[str, object]:
    payload_started_at = time.perf_counter()
    timings: dict[str, float] = {}
    if config is None:
        raise ValueError("build_view_payload requires explicit config")
    if library_state is None:
        raise ValueError("library_state is required")
    logger = _LOGGER if logger is None else logger
    st = library_state
    viewer_opinion_preferences = resolve_viewer_opinion_preferences(
        st.get("viewer_opinion_preferences", {})
    )
    viewer_opinion_preference_signature = tuple(sorted(viewer_opinion_preferences.items()))
    view_request = _resolve_view_payload_request(
        active_surface_override=active_surface_override,
        query_args=query_args,
    )
    query_raw = view_request.query_raw
    active_surface = view_request.active_surface
    albums_state = st.get("albums", []) or []
    all_albums = list(albums_state)
    file_cache = st.get("file_cache", {}) or {}
    query = view_request.query
    gallery_scope = view_request.gallery_scope
    gallery_display_mode = view_request.gallery_display_mode
    gallery_scale_percent = view_request.gallery_scale_percent
    arrivals_only_scope = view_request.arrivals_only_scope
    category_filter_requested = view_request.category_filter_requested
    root_aware_filtering_active = view_request.root_aware_filtering_active
    selected_artist_family_display_mode = view_request.selected_artist_family_display_mode
    local_tree_submode = view_request.local_tree_submode
    visible_library_categories = view_request.visible_library_categories
    requested_artist = view_request.requested_artist
    sidebar_only_payload = view_request.sidebar_only_payload
    omit_sidebar = view_request.omit_sidebar
    search_filters = view_request.search_filters
    search_filter_contract = build_search_filter_contract()
    search_query_contract = build_search_query_contract()
    if active_surface == "playlists":
        manual_versions_started_at = time.perf_counter()
        manual_version_links = load_manual_version_links(config)
        timings["manual_version_links_ms"] = round((time.perf_counter() - manual_versions_started_at) * 1000, 2)
        ignored_versions_started_at = time.perf_counter()
        ignored_version_keys = sorted(load_ignored_version_keys(config))
        timings["ignored_version_keys_ms"] = round((time.perf_counter() - ignored_versions_started_at) * 1000, 2)
        playlist_surface_payload = build_playlist_surface_payload(
            st.get("playlists", []) or [],
            requested_playlist_id=view_request.requested_playlist_id,
            query=query_raw,
            search_filters=search_filters,
            authorized_private=not public_safe,
            config=config,
            client_surface_class=resolve_client_surface_class(client_surface_class),
        )
        payload = {
            "surface": build_view_surface_payload(active_surface),
            "shell_layout": build_shell_layout_payload(
                active_surface=active_surface,
                has_playlist_detail="playlist_detail" in playlist_surface_payload,
                local_tree_submode=local_tree_submode,
            ),
            "album_count": 0,
            "artist_count": 0,
            "query": query_raw,
            "search_filters": search_filters,
            "search_filter_contract": search_filter_contract,
            "search_query_contract": search_query_contract,
            "gallery_scope": gallery_scope,
            "gallery_display_mode": gallery_display_mode or DEFAULT_GALLERY_DISPLAY_MODE,
            "gallery_scale_percent": gallery_scale_percent or DEFAULT_GALLERY_SCALE_PERCENT,
            "local_tree_submode": local_tree_submode,
            "visible_library_categories": visible_library_categories,
            "music_dir": str(get_primary_music_root(config)),
            "app_name": config.get("APP_NAME", "Album Haven"),
            "app_version": config.get("APP_VERSION", RELEASE_VERSION),
            "ignored_version_keys": ignored_version_keys,
            "manual_version_links": manual_version_links,
            "non_album_tracks": [],
            "non_album_exception_values": sorted(set(NON_ALBUM_EXCEPTION_VALUES.values())),
            "viewer_opinion_preferences": build_viewer_opinion_preferences_payload(
                viewer_opinion_preferences,
            ),
            "popularity_browse": build_popularity_browse_payload(
                viewer_opinion_preferences=viewer_opinion_preferences,
            ),
        }
        payload.update(playlist_surface_payload)
        total_elapsed_ms = round((time.perf_counter() - payload_started_at) * 1000, 2)
        timings["total_ms"] = total_elapsed_ms
        log_app_event(
            config,
            logger,
            "View payload built",
            level="info",
            elapsed_ms=total_elapsed_ms,
            surface=active_surface,
            query=query_raw,
            selected_artist="",
            total_albums=len(all_albums),
            filtered_albums=0,
            artist_groups=0,
            sidebar_artists=0,
            non_album_entries=0,
            non_album_tracks=0,
            timings=timings,
        )
        return payload
    requested_all_artists = view_request.requested_all_artists
    requested_related_artists = view_request.requested_related_artists
    requested_primary_filter = view_request.requested_primary_filter
    relation_views_state = st.get("relation_views", {}) or {}
    relation_views_started_at = time.perf_counter()
    allow_rebuild_alias_views = bool(
        isinstance(relation_views_state, dict)
        and relation_views_state.get("alias_to_canonical")
    )
    relation_views, alias_to_canonical, canonical_to_aliases = _resolve_casefold_relation_views(
        st,
        all_albums,
        config=config,
        allow_rebuild_alias_views=allow_rebuild_alias_views,
    )
    timings["casefold_alias_views_ms"] = round((time.perf_counter() - relation_views_started_at) * 1000, 2)
    manual_versions_started_at = time.perf_counter()
    manual_version_links = load_manual_version_links(config)
    timings["manual_version_links_ms"] = round((time.perf_counter() - manual_versions_started_at) * 1000, 2)
    selected_artist = "" if requested_all_artists else resolve_requested_artist(
        requested_artist,
        alias_to_canonical,
        canonical_to_aliases,
    )
    related_filter_artists: list[str] = []
    primary_filter_active = False
    relation_views_state = st.get("relation_views", {}) or {}
    relation_view_cache_identity = id(relation_views_state)

    search_started_at = time.perf_counter()
    search_buckets = _resolve_search_buckets(
        st,
        albums_state=albums_state,
        relation_view_cache_identity=relation_view_cache_identity,
        all_albums=all_albums,
        relation_views=relation_views,
        query=query,
    )
    timings["search_buckets_ms"] = round((time.perf_counter() - search_started_at) * 1000, 2)
    filtered_albums = [
        album
        for album in list(search_buckets["albums"])
        if album_visible_in_categories(album, visible_library_categories)
    ]
    filtered_album_lookup = {
        str(getattr(album, "key", "") or "").strip(): album
        for album in filtered_albums
        if str(getattr(album, "key", "") or "").strip()
    }
    selected_artist_album_note_cache_signature = tuple(
        (
            album_key,
            _freeze_cache_signature(build_album_note_payload(album, album_ref=album_key)),
            _freeze_cache_signature(build_visible_album_notes_payload(album, album_ref=album_key)),
        )
        for album_key, album in sorted(filtered_album_lookup.items())
    )
    direct_match_artists = set(search_buckets["direct_artists"])
    related_match_artists = set(search_buckets["related_artists"])
    direct_match_artists_ordered = list(search_buckets.get("direct_artists_ordered", []))
    related_match_artists_ordered = list(search_buckets.get("related_artists_ordered", []))

    family_artists: list[str] = []
    primary_artist_groups = []
    family_artist_groups = []
    artist_groups = []
    show_all_artists_sidebar_link = True
    preferred_selection_order = []
    album_group_match_cache: dict[tuple[str, str], bool] = {}
    album_payload_cache: dict[str, dict[str, object]] = {}
    query_artist_group_index: dict[str, list[object]] = {}
    query_group_cache_key = None
    visible_sidebar_artists_ordered: list[str] = []
    search_sidebar_artists_ordered: list[str] = []
    full_selected_artist_cache_key = None
    root_browse_cache = None
    root_browse_cache_key = None
    cached_root_browse = None
    def serialize_album_preview(album):
        return album_preview_to_dict(
            album,
            public_safe=public_safe,
            include_album_note_seams=bool(selected_artist),
            config=config,
            viewer_opinion_preferences=viewer_opinion_preferences,
        )
    if not query and not public_safe:
        root_browse_cache = st.setdefault("_view_payload_root_browse_cache", {})
        root_browse_cache_key = _build_root_browse_cache_key(
            albums_state=albums_state,
            relation_view_cache_identity=relation_view_cache_identity,
            gallery_scope=gallery_scope,
            visible_library_categories=visible_library_categories,
            viewer_opinion_preference_signature=viewer_opinion_preference_signature,
        )
        cached_root_browse = root_browse_cache.get(root_browse_cache_key)
    ordered_query_artists = list(dict.fromkeys([
        *[artist for artist in direct_match_artists_ordered if artist],
        *[artist for artist in related_match_artists_ordered if artist],
    ]))
    if query and ordered_query_artists:
        query_artist_group_index, query_group_cache_key = _resolve_query_artist_group_index(
            st,
            albums_state=albums_state,
            relation_views_state=st.get("relation_views", {}) or {},
            query=query,
            visible_library_categories=visible_library_categories,
            ordered_artists=ordered_query_artists,
            filtered_albums=filtered_albums,
            alias_to_canonical=alias_to_canonical,
            album_group_match_cache=album_group_match_cache,
            viewer_opinion_preference_signature=viewer_opinion_preference_signature,
        )

    selected_artist_group_cache = st.setdefault("_view_payload_selected_artist_group_cache", {})

    def clone_cached_artist_groups(
        target_artist: str,
        visible_family_artists: set[str],
    ) -> dict[str, object] | None:
        cached_root_artist_groups = (
            cached_root_browse.get("artist_groups")
            if isinstance(cached_root_browse, dict)
            else None
        )
        if not isinstance(cached_root_artist_groups, list):
            return None

        target_key = artist_display_dedupe_key(target_artist)
        if not target_key:
            return None
        visible_family_keys = {
            artist_display_dedupe_key(artist)
            for artist in visible_family_artists
            if artist
        }

        def is_various_payload_album(album_payload: object) -> bool:
            if not isinstance(album_payload, dict):
                return False
            album_artist = str(album_payload.get("album_artist") or "").strip().casefold()
            return album_artist in {"va", "v.a.", "various artists", "various artist", "various"}

        def read_payload_album_key(album_payload: object) -> str:
            if not isinstance(album_payload, dict):
                return ""
            return str(album_payload.get("key") or "").strip()

        def clone_selected_artist_album_payload(album_payload: object) -> dict[str, object]:
            if not isinstance(album_payload, dict):
                return {}
            album_key = read_payload_album_key(album_payload)
            album = filtered_album_lookup.get(album_key)
            if album is None:
                return deepcopy(album_payload)
            return album_preview_to_dict(
                album,
                public_safe=public_safe,
                include_album_note_seams=True,
                config=config,
                viewer_opinion_preferences=viewer_opinion_preferences,
            )

        primary_groups: list[dict[str, object]] = []
        primary_album_keys: set[str] = set()

        for group in cached_root_artist_groups:
            if not isinstance(group, dict):
                continue
            group_artist = str(group.get("artist") or "").strip()
            group_key = artist_display_dedupe_key(group_artist)
            if not group_key:
                continue

            if group_key == target_key:
                cloned_group = deepcopy(group)
                cloned_group["albums"] = [
                    clone_selected_artist_album_payload(album_payload)
                    for album_payload in cloned_group.get("albums") or []
                    if isinstance(album_payload, dict)
                ]
                primary_groups.append(cloned_group)
                for album_payload in cloned_group.get("albums") or []:
                    album_key = read_payload_album_key(album_payload)
                    if album_key:
                        primary_album_keys.add(album_key)
        family_groups: list[dict[str, object]] = []
        seen_family_album_keys: set[str] = set()

        for group in cached_root_artist_groups:
            if not isinstance(group, dict):
                continue
            group_artist = str(group.get("artist") or "").strip()
            group_key = artist_display_dedupe_key(group_artist)
            if not group_key or group_key == target_key or group_key not in visible_family_keys:
                continue
            matched_family_albums = []
            for album_payload in group.get("albums") or []:
                if is_various_payload_album(album_payload):
                    continue
                album_key = read_payload_album_key(album_payload)
                if album_key and (album_key in primary_album_keys or album_key in seen_family_album_keys):
                    continue
                if album_key:
                    seen_family_album_keys.add(album_key)
                matched_family_albums.append(clone_selected_artist_album_payload(album_payload))

            if not matched_family_albums:
                continue

            cloned_group = deepcopy(group)
            cloned_group["albums"] = matched_family_albums
            family_groups.append(cloned_group)

        if not primary_groups and not family_groups:
            return None

        return {
            "family_artists": [artist for artist in family_artists if artist],
            "primary_artist_groups": primary_groups,
            "family_artist_groups": family_groups,
            "timings": {
                "selected_artist_primary_album_collection_ms": 0.0,
                "selected_artist_family_album_collection_ms": 0.0,
                "selected_artist_primary_group_build_ms": 0.0,
                "selected_artist_family_group_build_ms": 0.0,
            },
        }

    def collect_selected_artist_album_sets(
        target_artist: str,
        visible_family_artists: set[str],
    ) -> tuple[list[object], set[str], list[object], dict[str, float]]:
        primary_started_at = time.perf_counter()
        if query:
            target_primary_albums = list(query_artist_group_index.get(target_artist, []))
            target_primary_album_keys = {
                str(getattr(album, "key", "") or "")
                for album in target_primary_albums
                if str(getattr(album, "key", "") or "")
            }
            target_family_albums = []
            seen_family_album_keys: set[str] = set()
            for artist in visible_family_artists:
                for album in query_artist_group_index.get(artist, []):
                    album_key = str(getattr(album, "key", "") or "")
                    if (
                        not album_key
                        or album_key in target_primary_album_keys
                        or album_key in seen_family_album_keys
                        or is_various_album(album)
                    ):
                        continue
                    seen_family_album_keys.add(album_key)
                    target_family_albums.append(album)
            primary_elapsed_ms = round((time.perf_counter() - primary_started_at) * 1000, 2)
            return target_primary_albums, target_primary_album_keys, target_family_albums, {
                "selected_artist_primary_album_collection_ms": primary_elapsed_ms,
                "selected_artist_family_album_collection_ms": round((time.perf_counter() - primary_started_at) * 1000, 2) - primary_elapsed_ms,
            }

        target_primary_albums: list[object] = []
        target_primary_album_keys: set[str] = set()
        target_family_albums: list[object] = []
        seen_family_album_keys: set[str] = set()

        for album in filtered_albums:
            album_key = str(getattr(album, "key", "") or "")
            if membership_cached_album_matches_group_artist(
                album,
                target_artist,
                alias_to_canonical,
                album_group_match_cache,
            ):
                target_primary_albums.append(album)
                if album_key:
                    target_primary_album_keys.add(album_key)
                continue
            if (
                not album_key
                or album_key in seen_family_album_keys
                or is_various_album(album)
            ):
                continue
            if not any(
                membership_cached_album_matches_group_artist(
                    album,
                    family_artist,
                    alias_to_canonical,
                    album_group_match_cache,
                )
                for family_artist in visible_family_artists
            ):
                continue
            seen_family_album_keys.add(album_key)
            target_family_albums.append(album)
        total_elapsed_ms = round((time.perf_counter() - primary_started_at) * 1000, 2)
        return target_primary_albums, target_primary_album_keys, target_family_albums, {
            "selected_artist_primary_album_collection_ms": total_elapsed_ms,
            "selected_artist_family_album_collection_ms": 0.0,
        }

    def build_cached_selected_artist_groups(target_artist: str) -> dict[str, object]:
        def selected_artist_album_serializer(album):
            return album_preview_to_dict(
                album,
                public_safe=public_safe,
                include_album_note_seams=True,
                config=config,
                viewer_opinion_preferences=viewer_opinion_preferences,
            )

        target_family_context = _resolve_selected_artist_family_artists(
            target_artist,
            alias_to_canonical,
            canonical_to_aliases,
            config=config,
        )
        target_family_artists = list(target_family_context["family_artists"])
        target_alias_to_canonical = dict(target_family_context["alias_to_canonical"])
        target_canonical_to_aliases = dict(
            target_family_context["canonical_to_aliases"]
        )
        (
            target_primary_albums,
            target_primary_album_keys,
            target_family_albums,
            _target_collection_timings,
        ) = collect_selected_artist_album_sets(
            target_artist,
            set(target_family_artists),
        )
        target_primary_groups_started_at = time.perf_counter()
        target_primary_groups = membership_merge_duplicate_artist_groups(
            artist_group_helpers._build_artist_membership_groups(
                target_primary_albums,
                [target_artist],
                target_alias_to_canonical,
                target_canonical_to_aliases,
                exact_group_matches=True,
                matches_group_artist_for_album=(
                    lambda album, artist: membership_cached_album_matches_group_artist(
                        album,
                        artist,
                        target_alias_to_canonical,
                        album_group_match_cache,
                    )
                ),
                album_payload_cache=album_payload_cache,
                album_serializer=selected_artist_album_serializer,
            )
        )
        target_family_groups_started_at = time.perf_counter()
        target_family_groups = membership_merge_duplicate_artist_groups(
            artist_group_helpers._build_artist_membership_groups(
                target_family_albums,
                target_family_artists,
                target_alias_to_canonical,
                target_canonical_to_aliases,
                exclude_album_keys=target_primary_album_keys,
                exact_group_matches=True,
                matches_group_artist_for_album=(
                    lambda album, artist: membership_cached_album_matches_group_artist(
                        album,
                        artist,
                        target_alias_to_canonical,
                        album_group_match_cache,
                    )
                ),
                album_payload_cache=album_payload_cache,
                album_serializer=selected_artist_album_serializer,
            )
        )
        return {
            "family_artists": target_family_artists,
            "primary_artist_groups": target_primary_groups,
            "family_artist_groups": target_family_groups,
            "timings": {
                **_target_collection_timings,
                "selected_artist_primary_group_build_ms": round((target_family_groups_started_at - target_primary_groups_started_at) * 1000, 2),
                "selected_artist_family_group_build_ms": round((time.perf_counter() - target_family_groups_started_at) * 1000, 2),
            },
        }

    if query and not requested_all_artists:
        preferred_selection_order.extend(direct_match_artists_ordered)
        preferred_selection_order.extend(related_match_artists_ordered)
        visible_artist_names = set(direct_match_artists) | set(related_match_artists)
        visible_sidebar_artists_ordered = [
            str(item.get("artist") or "")
            for item in build_artists_sidebar(filtered_albums, relation_views, preferred_selection_order)
            if str(item.get("artist") or "")
        ]
        visible_sidebar_artists = set(visible_sidebar_artists_ordered)
        if not selected_artist and preferred_selection_order:
            selected_artist = preferred_selection_order[0]
        elif (
            selected_artist
            and selected_artist not in visible_artist_names
            and selected_artist not in visible_sidebar_artists
            and preferred_selection_order
        ):
            selected_artist = preferred_selection_order[0]

    if query and requested_all_artists:
        search_sidebar_artists_ordered = [
            str(item.get("artist") or "")
            for item in build_artists_sidebar(filtered_albums, relation_views, ordered_query_artists)
            if str(item.get("artist") or "")
        ]
    elif query:
        query_terms = split_search_terms(query_raw)
        search_sidebar_artists_ordered = list(
            dict.fromkeys(
                [
                    *[
                        artist
                        for artist in direct_match_artists_ordered
                        if artist_alias_matches_query(
                            artist,
                            canonical_to_aliases.get(artist, []),
                            query_terms,
                        )
                    ],
                    *related_match_artists_ordered,
                ]
            )
        )
        selected_artist_key = artist_display_dedupe_key(selected_artist)
        if (
            selected_artist_key
            and selected_artist
            and any(
                artist_display_dedupe_key(artist) == selected_artist_key
                for artist in visible_sidebar_artists_ordered
            )
            and not any(
                artist_display_dedupe_key(artist) == selected_artist_key
                for artist in search_sidebar_artists_ordered
            )
        ):
            search_sidebar_artists_ordered = [
                selected_artist,
                *search_sidebar_artists_ordered,
            ]
    if query and visible_sidebar_artists_ordered:
        combined_query_index_artists = list(dict.fromkeys([
            *ordered_query_artists,
            *visible_sidebar_artists_ordered,
        ]))
        combined_query_artist_group_index, combined_query_group_cache_key = _resolve_query_artist_group_index(
            st,
            albums_state=albums_state,
            relation_views_state=st.get("relation_views", {}) or {},
            query=query,
            visible_library_categories=visible_library_categories,
            ordered_artists=combined_query_index_artists,
            filtered_albums=filtered_albums,
            alias_to_canonical=alias_to_canonical,
            album_group_match_cache=album_group_match_cache,
            viewer_opinion_preference_signature=viewer_opinion_preference_signature,
        )
        query_artist_group_index = combined_query_artist_group_index
        query_group_cache_key = combined_query_group_cache_key
    warm_precompute_artists = [selected_artist] if selected_artist else []
    if query and query_group_cache_key is not None and len(warm_precompute_artists) <= 24:
        _warm_query_selected_artist_group_cache(
            selected_artist_group_cache,
            query_group_cache_key=query_group_cache_key,
            warm_precompute_artists=warm_precompute_artists,
            public_safe=public_safe,
            selected_artist_album_note_cache_signature=selected_artist_album_note_cache_signature,
            build_cached_selected_artist_groups=build_cached_selected_artist_groups,
        )
    if root_aware_filtering_active and selected_artist:
        has_visible_selected_artist = any(
            membership_album_matches_group_artist(album, selected_artist, alias_to_canonical)
            for album in filtered_albums
        )
        if not has_visible_selected_artist:
            selected_artist = ""

    root_sidebar_only_response = bool(
        sidebar_only_payload
        and not query
        and not selected_artist
        and not arrivals_only_scope
    )

    group_started_at = time.perf_counter()
    if root_sidebar_only_response:
        artist_groups = []
        primary_artist_groups = []
        family_artist_groups = []
    elif arrivals_only_scope:
        if selected_artist:
            artist_groups = membership_merge_duplicate_artist_groups(
                artist_group_helpers._build_artist_membership_groups(
                    filtered_albums,
                    [selected_artist],
                    alias_to_canonical,
                    canonical_to_aliases,
                    exact_group_matches=True,
                    matches_group_artist_for_album=(
                        lambda album, artist: membership_album_matches_group_artist(
                            album,
                            artist,
                            alias_to_canonical,
                        )
                    ),
                    album_serializer=serialize_album_preview,
                )
            )
        elif query:
            direct_groups = artist_group_helpers._build_artist_membership_groups(
                filtered_albums,
                direct_match_artists_ordered,
                alias_to_canonical,
                canonical_to_aliases,
                album_serializer=serialize_album_preview,
            )
            related_groups = artist_group_helpers._build_artist_membership_groups(
                filtered_albums,
                related_match_artists_ordered,
                alias_to_canonical,
                canonical_to_aliases,
                album_serializer=serialize_album_preview,
            )
            artist_groups = membership_merge_duplicate_artist_groups(direct_groups + related_groups)
        else:
            artist_groups = membership_merge_duplicate_artist_groups(
                artist_group_helpers.build_artist_groups(
                    filtered_albums,
                    alias_to_canonical,
                    canonical_to_aliases,
                    album_serializer=serialize_album_preview,
                )
            )
    elif selected_artist:
        if not query and not requested_related_artists and not requested_primary_filter:
            full_selected_artist_cache_key = _build_full_selected_artist_group_cache_key(
                albums_state=albums_state,
                relation_view_cache_identity=relation_view_cache_identity,
                visible_library_categories=visible_library_categories,
                selected_artist=selected_artist,
                public_safe=public_safe,
                viewer_opinion_preference_signature=viewer_opinion_preference_signature,
                selected_artist_album_note_cache_signature=selected_artist_album_note_cache_signature,
            )
        selected_artist_source_group_inputs = (
            _resolve_selected_artist_source_group_inputs(
                config=config,
                selected_artist=selected_artist,
                query=query,
                query_group_cache_key=query_group_cache_key,
                full_selected_artist_cache_key=full_selected_artist_cache_key,
                selected_artist_group_cache=selected_artist_group_cache,
            requested_related_artists=requested_related_artists,
            requested_primary_filter=requested_primary_filter,
            relation_views=relation_views,
            relations_last_built=float(st.get("relations_last_built") or 0.0),
            canonical_to_aliases=canonical_to_aliases,
            alias_to_canonical=alias_to_canonical,
            public_safe=public_safe,
                selected_artist_album_note_cache_signature=selected_artist_album_note_cache_signature,
                cached_root_browse=cached_root_browse,
                clone_cached_artist_groups=clone_cached_artist_groups,
                build_cached_selected_artist_groups=build_cached_selected_artist_groups,
                timings=timings,
            )
        )
        cached_selected_artist_groups = selected_artist_source_group_inputs[
            "cached_selected_artist_groups"
        ]
        use_cached_selected_artist_groups = bool(
            selected_artist_source_group_inputs["use_cached_selected_artist_groups"]
        )
        family_artists = list(selected_artist_source_group_inputs["family_artists"])
        related_filter_artists = list(
            selected_artist_source_group_inputs["related_filter_artists"]
        )
        primary_filter_active = bool(
            selected_artist_source_group_inputs["primary_filter_active"]
        )
        visible_family_artist_set = set(
            selected_artist_source_group_inputs["visible_family_artist_set"]
        )

        if use_cached_selected_artist_groups:
            primary_artist_groups = _decorate_selected_artist_group_payloads(
                list(cached_selected_artist_groups.get("primary_artist_groups", [])),
                alias_to_canonical=alias_to_canonical,
                canonical_to_aliases=canonical_to_aliases,
            )
            family_artist_groups = _decorate_selected_artist_group_payloads(
                list(cached_selected_artist_groups.get("family_artist_groups", [])),
                alias_to_canonical=alias_to_canonical,
                canonical_to_aliases=canonical_to_aliases,
            )
            artist_groups = _render_selected_artist_artist_groups(
                primary_artist_groups,
                family_artist_groups,
                family_display_mode=selected_artist_family_display_mode,
            )
        else:
            live_selected_artist_groups = _build_live_selected_artist_group_payloads(
                selected_artist=selected_artist,
                family_artists=family_artists,
                related_filter_artists=related_filter_artists,
                primary_filter_active=primary_filter_active,
                visible_family_artist_set=visible_family_artist_set,
                alias_to_canonical=alias_to_canonical,
                canonical_to_aliases=canonical_to_aliases,
                album_group_match_cache=album_group_match_cache,
                album_payload_cache=album_payload_cache,
                album_serializer=serialize_album_preview,
                collect_selected_artist_album_sets=collect_selected_artist_album_sets,
                timings=timings,
                family_display_mode=selected_artist_family_display_mode,
                full_selected_artist_cache_key=full_selected_artist_cache_key,
                selected_artist_group_cache=selected_artist_group_cache,
                requested_related_artists=requested_related_artists,
                requested_primary_filter=requested_primary_filter,
                public_safe=public_safe,
            )
            primary_artist_groups = list(
                live_selected_artist_groups["primary_artist_groups"]
            )
            family_artist_groups = list(
                live_selected_artist_groups["family_artist_groups"]
            )
            artist_groups = list(live_selected_artist_groups["artist_groups"])
    else:
        if query:
            artist_groups = _build_query_artist_groups(
                filtered_albums=filtered_albums,
                direct_match_artists_ordered=direct_match_artists_ordered,
                related_match_artists_ordered=related_match_artists_ordered,
                alias_to_canonical=alias_to_canonical,
                canonical_to_aliases=canonical_to_aliases,
                album_payload_cache=album_payload_cache,
                album_serializer=serialize_album_preview,
            )
        else:
            artist_groups = _resolve_root_browse_artist_groups(
                cached_root_browse=cached_root_browse,
                filtered_albums=filtered_albums,
                alias_to_canonical=alias_to_canonical,
                canonical_to_aliases=canonical_to_aliases,
                album_serializer=serialize_album_preview,
                root_browse_cache=root_browse_cache,
                root_browse_cache_key=root_browse_cache_key,
                timings=timings,
            )
    if query:
        all_found_artist_names = set(direct_match_artists) | set(related_match_artists)
        visible_group_artist_names = (
            _selected_artist_visible_artist_names(primary_artist_groups, family_artist_groups)
            if selected_artist
            else {
                str(group.get("artist") or "")
                for group in artist_groups
                if str(group.get("artist") or "")
            }
        )
        show_all_artists_sidebar_link = not bool(
            selected_artist
            and all_found_artist_names
            and visible_group_artist_names >= all_found_artist_names
        )
    if arrivals_only_scope:
        family_artists = []
        related_filter_artists = []
        primary_filter_active = False
        primary_artist_groups = []
        family_artist_groups = []
    elif selected_artist:
        visible_family_artist_keys = {
            artist_display_dedupe_key(str(group.get("artist") or "").strip())
            for group in family_artist_groups
            if str(group.get("artist") or "").strip()
        }
        family_artists = [
            artist
            for artist in family_artists
            if artist_display_dedupe_key(artist) in visible_family_artist_keys
        ]
        related_filter_artists = [
            artist
            for artist in related_filter_artists
            if artist_display_dedupe_key(artist) in visible_family_artist_keys
        ]
    timings["artist_groups_ms"] = round((time.perf_counter() - group_started_at) * 1000, 2)

    artists_sidebar: list[dict[str, object]] = []
    root_all_artists_count: int | None = None
    sidebar_source_albums = filtered_albums if query else [
        album for album in all_albums
        if album_visible_in_categories(album, visible_library_categories)
    ]
    if omit_sidebar and not root_sidebar_only_response:
        timings["artists_sidebar_ms"] = 0.0
    else:
        sidebar_started_at = time.perf_counter()
        artists_sidebar = _resolve_artists_sidebar(
            st,
            albums_state=albums_state,
            relation_view_cache_identity=relation_view_cache_identity,
            query=query,
            gallery_scope=gallery_scope,
            visible_library_categories=visible_library_categories,
            sidebar_source_albums=sidebar_source_albums,
            relation_views=relation_views,
        )
        if query:
            ordered_search_sidebar_keys = {
                artist_display_dedupe_key(artist): index
                for index, artist in enumerate(search_sidebar_artists_ordered)
                if str(artist or "").strip()
            }
            artists_sidebar = [
                item
                for item in artists_sidebar
                if artist_display_dedupe_key(str(item.get("artist") or "").strip()) in ordered_search_sidebar_keys
            ]
            artists_sidebar.sort(
                key=lambda item: ordered_search_sidebar_keys.get(
                    artist_display_dedupe_key(str(item.get("artist") or "").strip()),
                    len(ordered_search_sidebar_keys),
                )
            )
        if not query:
            root_browse_cache = st.setdefault("_view_payload_root_browse_cache", {})
            root_browse_cache_key = _build_root_browse_cache_key(
                albums_state=albums_state,
                relation_view_cache_identity=relation_view_cache_identity,
                gallery_scope=gallery_scope,
                visible_library_categories=visible_library_categories,
                viewer_opinion_preference_signature=viewer_opinion_preference_signature,
            )
            existing_root_payload = root_browse_cache.get(root_browse_cache_key)
            if (
                isinstance(existing_root_payload, dict)
                and isinstance(existing_root_payload.get("artist_groups"), list)
            ):
                _write_root_browse_cache_payload(
                    root_browse_cache,
                    root_browse_cache_key,
                    artists_sidebar=list(artists_sidebar),
                )
        timings["artists_sidebar_ms"] = round((time.perf_counter() - sidebar_started_at) * 1000, 2)

    if not query and not selected_artist:
        if artists_sidebar:
            root_all_artists_count = len(artists_sidebar)
        elif omit_sidebar and not root_sidebar_only_response:
            root_all_artists_count = len(
                _resolve_artists_sidebar(
                    st,
                    albums_state=albums_state,
                    relation_view_cache_identity=relation_view_cache_identity,
                    query=query,
                    gallery_scope=gallery_scope,
                    visible_library_categories=visible_library_categories,
                    sidebar_source_albums=sidebar_source_albums,
                    relation_views=relation_views,
                )
            )

    if root_sidebar_only_response:
        ignored_versions_started_at = time.perf_counter()
        ignored_version_keys = sorted(load_ignored_version_keys(config))
        timings["ignored_version_keys_ms"] = round((time.perf_counter() - ignored_versions_started_at) * 1000, 2)
        payload = {
            "artists_sidebar": artists_sidebar,
            "album_count": len(sidebar_source_albums),
            "artist_count": len(artists_sidebar),
            "query": query_raw,
            "search_filters": search_filters,
            "search_filter_contract": search_filter_contract,
            "search_query_contract": search_query_contract,
            "selected_artist": selected_artist,
            "all_artists_active": bool(query and requested_all_artists and not selected_artist),
            "show_all_artists_sidebar_link": show_all_artists_sidebar_link,
            "related_filter_artists": related_filter_artists,
            "primary_filter_active": primary_filter_active,
            "gallery_scope": gallery_scope,
            "gallery_display_mode": gallery_display_mode,
            "gallery_scale_percent": gallery_scale_percent,
            "visible_library_categories": visible_library_categories,
            "music_dir": str(get_primary_music_root(config)),
            "app_name": config.get("APP_NAME", "Album Haven"),
            "app_version": config.get("APP_VERSION", RELEASE_VERSION),
            "ignored_version_keys": ignored_version_keys,
            "manual_version_links": manual_version_links,
            "payload_tier": "sidebar",
            "initial_view_partial": True,
            "viewer_opinion_preferences": build_viewer_opinion_preferences_payload(
                viewer_opinion_preferences,
            ),
        }
        if selected_artist:
            payload["selected_artist_family_display_mode"] = selected_artist_family_display_mode
        total_elapsed_ms = round((time.perf_counter() - payload_started_at) * 1000, 2)
        timings["total_ms"] = total_elapsed_ms
        log_app_event(
            config,
            logger,
            "View payload built",
            level="info",
            elapsed_ms=total_elapsed_ms,
            query=query_raw,
            selected_artist=selected_artist,
            total_albums=len(all_albums),
            filtered_albums=len(filtered_albums),
            artist_groups=0,
            sidebar_artists=len(artists_sidebar),
            non_album_entries=0,
            non_album_tracks=0,
            payload_tier="sidebar",
            timings=timings,
        )
        return payload

    visible_artist_names = (
        _selected_artist_visible_artist_names(primary_artist_groups, family_artist_groups)
        if selected_artist
        else {
            str(group.get("artist") or "")
            for group in artist_groups
            if str(group.get("artist") or "")
        }
    )
    if not visible_artist_names and query:
        visible_artist_names.update(
            str(item.get("artist") or "")
            for item in artists_sidebar
            if str(item.get("artist") or "")
        )
    if selected_artist:
        visible_artist_names.add(selected_artist)
        visible_artist_names.update(family_artists)
    non_album_started_at = time.perf_counter()
    non_album_candidate_cache_key = _build_non_album_candidate_cache_key(
        file_cache=file_cache,
        relation_view_cache_identity=relation_view_cache_identity,
        visible_library_categories=visible_library_categories,
    )
    cached_non_album_candidates = st.setdefault("_view_payload_non_album_candidate_cache", {}).get(non_album_candidate_cache_key)
    if not isinstance(cached_non_album_candidates, list):
        non_album_candidates_started_at = time.perf_counter()
        non_album_candidates = _resolve_non_album_candidates(
            st,
            config=config,
            file_cache=file_cache,
            relation_view_cache_identity=relation_view_cache_identity,
            visible_library_categories=visible_library_categories,
            alias_to_canonical=alias_to_canonical,
        )
        timings["non_album_candidate_build_ms"] = round((time.perf_counter() - non_album_candidates_started_at) * 1000, 2)
    else:
        non_album_candidates = cached_non_album_candidates
    cached_root_non_album_entries = (
        cached_root_browse.get("non_album_entries")
        if isinstance(cached_root_browse, dict)
        else None
    )
    if not query and not selected_artist and isinstance(cached_root_non_album_entries, list):
        non_album_entries = list(cached_root_non_album_entries)
    else:
        non_album_entries = []
        visible_artist_path_candidates = _visible_artist_path_candidates(visible_artist_names, relation_views)
        for candidate in non_album_candidates:
            if not isinstance(candidate, dict):
                continue
            candidate_entry = candidate.get("entry")
            if not isinstance(candidate_entry, dict):
                continue
            entry_artist = str(candidate.get("entry_artist") or "")
            canonical_artist = str(candidate.get("canonical_artist") or "")
            path_parts = candidate.get("path_parts")
            if (
                visible_artist_names
                and canonical_artist not in visible_artist_names
                and entry_artist not in visible_artist_names
                and (
                    not isinstance(path_parts, frozenset)
                    or not visible_artist_path_candidates.intersection(path_parts)
                )
            ):
                continue
            non_album_entries.append(dict(candidate_entry))
    timings["non_album_entries_ms"] = round((time.perf_counter() - non_album_started_at) * 1000, 2)

    non_album_tracks_started_at = time.perf_counter()
    cached_root_non_album_tracks = (
        cached_root_browse.get("non_album_tracks")
        if isinstance(cached_root_browse, dict)
        else None
    )
    if not query and not selected_artist and isinstance(cached_root_non_album_tracks, list):
        non_album_tracks = list(cached_root_non_album_tracks)
    else:
        non_album_tracks = build_non_album_track_list(
            non_album_entries,
            config=config,
        )
        if (
            not query
            and not selected_artist
            and isinstance(root_browse_cache, dict)
            and root_browse_cache_key is not None
        ):
            existing_root_payload = root_browse_cache.get(root_browse_cache_key)
            if isinstance(existing_root_payload, dict):
                _write_root_browse_cache_payload(
                    root_browse_cache,
                    root_browse_cache_key,
                    non_album_entries=list(non_album_entries),
                    non_album_tracks=list(non_album_tracks),
                )
    timings["non_album_tracks_ms"] = round((time.perf_counter() - non_album_tracks_started_at) * 1000, 2)

    if query and not artist_groups and not non_album_tracks and not non_album_entries:
        selected_artist = ""
        related_filter_artists = []
        primary_filter_active = False
        family_artists = []
        artists_sidebar = []

    search_context = build_legacy_search_context(
        committed_query=query_raw,
        selected_artist=selected_artist,
        requested_artist=requested_artist,
        requested_all_artists=requested_all_artists,
        direct_match_artists=direct_match_artists_ordered,
        related_match_artists=related_match_artists_ordered,
        search_filters=search_filters,
    )

    ignored_versions_started_at = time.perf_counter()
    ignored_version_keys = sorted(load_ignored_version_keys(config))
    timings["ignored_version_keys_ms"] = round((time.perf_counter() - ignored_versions_started_at) * 1000, 2)

    selected_artist_included_album_payloads = (
        _selected_artist_included_album_payloads(
            primary_artist_groups,
            family_artist_groups,
        )
        if selected_artist and not arrivals_only_scope
        else []
    )
    selected_artist_visible_artist_count = (
        _selected_artist_visible_artist_count(
            primary_artist_groups,
            family_artist_groups,
        )
        if selected_artist and not arrivals_only_scope
        else len(artist_groups)
    )
    selected_artist_family_filters = (
        _selected_artist_family_filter_payloads(
            selected_artist,
            family_artists,
            alias_to_canonical,
            canonical_to_aliases,
        )
        if selected_artist and not arrivals_only_scope
        else []
    )
    listen_through_scope_candidates = (
        _selected_artist_listen_through_scope_candidates(
            selected_artist=selected_artist,
            primary_artist_groups=primary_artist_groups,
            family_artist_groups=family_artist_groups,
            selected_artist_family_filters=selected_artist_family_filters,
        )
        if selected_artist and not public_safe and not arrivals_only_scope
        else {}
    )

    payload = {
        "surface": build_view_surface_payload(active_surface),
        "shell_layout": build_shell_layout_payload(
            active_surface=active_surface,
            selected_artist=selected_artist,
            local_tree_submode=local_tree_submode,
        ),
        "artist_groups": artist_groups,
        "primary_artist_groups": primary_artist_groups,
        "family_artist_groups": family_artist_groups,
        "related_artists": family_artists,
        "artist_family_filters": selected_artist_family_filters,
        "album_count": (
            len(selected_artist_included_album_payloads)
            if selected_artist and not arrivals_only_scope
            else sum(len(group["albums"]) for group in artist_groups)
        ),
        "artist_count": (
            selected_artist_visible_artist_count
            if selected_artist and not arrivals_only_scope
            else (
                len(artists_sidebar)
                if query and not omit_sidebar
                else (
                root_all_artists_count
                if root_all_artists_count is not None
                else len(artist_groups)
                )
            )
        ),
        "query": query_raw,
        "search_filters": search_filters,
        "search_filter_contract": search_filter_contract,
        "search_query_contract": search_query_contract,
        "selected_artist": selected_artist,
        "all_artists_active": bool(query and requested_all_artists and not selected_artist),
        "show_all_artists_sidebar_link": show_all_artists_sidebar_link,
        "related_filter_artists": related_filter_artists,
        "primary_filter_active": primary_filter_active,
        "gallery_scope": gallery_scope,
        "gallery_display_mode": gallery_display_mode or DEFAULT_GALLERY_DISPLAY_MODE,
        "gallery_scale_percent": gallery_scale_percent or DEFAULT_GALLERY_SCALE_PERCENT,
        "local_tree_submode": local_tree_submode,
        "visible_library_categories": visible_library_categories,
        "music_dir": str(get_primary_music_root(config)),
        "app_name": config.get("APP_NAME", "Album Haven"),
        "app_version": config.get("APP_VERSION", RELEASE_VERSION),
        "ignored_version_keys": ignored_version_keys,
        "manual_version_links": manual_version_links,
        "non_album_tracks": non_album_tracks,
        "non_album_exception_values": sorted(set(NON_ALBUM_EXCEPTION_VALUES.values())),
        "viewer_opinion_preferences": build_viewer_opinion_preferences_payload(
            viewer_opinion_preferences,
        ),
        "popularity_browse": build_popularity_browse_payload(
            viewer_opinion_preferences=viewer_opinion_preferences,
        ),
    }
    artist_page_playback_context: dict[str, object] | None = None
    if selected_artist:
        payload["selected_artist_family_display_mode"] = (
            selected_artist_family_display_mode
        )
    if listen_through_scope_candidates:
        payload["listen_through_scope_candidates"] = listen_through_scope_candidates
    if selected_artist and not public_safe:
        album_lookup = {
            str(getattr(album, "key", "") or "").strip(): album
            for album in filtered_albums
            if str(getattr(album, "key", "") or "").strip()
        }
        ordered_gallery_albums = _ordered_gallery_albums_from_artist_groups(
            artist_groups,
            album_lookup,
        )
        if ordered_gallery_albums and gallery_has_playable_albums(ordered_gallery_albums):
            artist_page_playback_context = build_gallery_playback_context(
                kind="artist_page",
                ordered_albums=ordered_gallery_albums,
            )
            payload["playback_context"] = artist_page_playback_context
    if selected_artist:
        artist_popularity_overlays = st.get("artist_popularity_overlays", {}) or {}
        artist_popularity = build_artist_popularity_payload({})
        if not public_safe:
            artist_popularity = build_artist_popularity_payload(
                {"artist_popularity": artist_popularity_overlays.get(selected_artist, {})},
                viewer_opinion_preferences=viewer_opinion_preferences,
            )
        payload["artist_page"] = build_artist_page_seam(
            selected_artist,
            page_mode=view_request.page_mode,
            family_display_mode=view_request.family_display_mode,
            gallery_display_mode=view_request.gallery_display_mode,
            gallery_scale_percent=view_request.gallery_scale_percent,
            timeline_at=view_request.timeline_at,
            artist_popularity=artist_popularity,
        )
        payload["artist_page"]["gallery_payload"] = _build_artist_page_gallery_payload(
            artist_ref=selected_artist,
        )
    if search_context is not None:
        payload["search_context"] = search_context
    if not omit_sidebar:
        payload["artists_sidebar"] = artists_sidebar
    total_elapsed_ms = round((time.perf_counter() - payload_started_at) * 1000, 2)
    timings["total_ms"] = total_elapsed_ms
    log_app_event(
        config,
        logger,
        "View payload built",
        level="info",
        elapsed_ms=total_elapsed_ms,
        query=query_raw,
        selected_artist=selected_artist,
        total_albums=len(all_albums),
        filtered_albums=len(filtered_albums),
        artist_groups=len(artist_groups),
        sidebar_artists=len(artists_sidebar),
        non_album_entries=len(non_album_entries),
        non_album_tracks=len(non_album_tracks),
        timings=timings,
    )
    return payload


def build_home_payload(
    *,
    public_safe: bool = False,
    query_args: object = None,
    config: object = None,
    logger: object = None,
    library_state: dict[str, object] | None = None,
    client_surface_class: object = None,
) -> dict[str, object]:
    if config is None:
        raise ValueError("build_home_payload requires explicit config")
    if library_state is None:
        raise ValueError("library_state is required")
    logger = _LOGGER if logger is None else logger
    st = library_state
    payload = build_view_payload(
        public_safe=public_safe,
        active_surface_override="home",
        query_args=query_args,
        config=config,
        logger=logger,
        library_state=st,
        client_surface_class=client_surface_class,
    )
    payload["artist_groups"] = []
    payload["primary_artist_groups"] = []
    payload["family_artist_groups"] = []
    payload["selected_artist"] = ""
    payload["all_artists_active"] = False
    if public_safe:
        payload.update({
            "recent_local_albums": [],
            "recent_not_local_albums": [],
        })
    else:
        payload.update(build_recent_listen_payloads(config, st.get("albums", [])))
    return payload


def build_news_payload(
    *,
    public_safe: bool = False,
    query_args: object = None,
    tab: object = None,
    source: object = None,
    config: object = None,
    logger: object = None,
    library_state: dict[str, object] | None = None,
) -> dict[str, object]:
    if config is None:
        raise ValueError("build_news_payload requires explicit config")
    payload = build_home_payload(
        public_safe=public_safe,
        query_args=query_args,
        config=config,
        logger=logger,
        library_state=library_state,
    )
    shell_layout = dict(payload.get("shell_layout") or {})
    shell_slots = dict(shell_layout.get("slots") or {})
    shell_slots["main_content"] = {
        "surface_ref": "news",
        "content_kind": "discovery_center_page",
    }
    shell_layout["slots"] = shell_slots
    payload["shell_layout"] = shell_layout
    payload["discovery_center"] = build_discovery_center_page_payload(
        tab=tab,
        source=source,
    )
    return payload


def build_status_payload(library_state: dict[str, object] | None = None) -> dict[str, object]:
    if library_state is None:
        raise ValueError("library_state is required")
    st = library_state
    return {
        "scan_in_progress": bool(st.get("scan_in_progress")),
        "scan_processed": int(st.get("scan_processed") or 0),
        "scan_total": int(st.get("scan_total") or 0),
        "scan_percent": scan_percent_for_state(st),
        "scan_current_path": st.get("scan_current_path") or "",
        "scan_elapsed_seconds": float(st.get("scan_elapsed_seconds") or 0.0),
        "scan_estimated_remaining_seconds": float(st.get("scan_estimated_remaining_seconds") or 0.0),
        "scan_files_per_second": float(st.get("scan_files_per_second") or 0.0),
        "scan_album_folders_processed": int(st.get("scan_album_folders_processed") or 0),
        "scan_album_folders_total": int(st.get("scan_album_folders_total") or 0),
        "scan_phase": str(st.get("scan_phase") or "idle"),
        "scan_mode": str(st.get("scan_mode") or "idle"),
        "relations_in_progress": bool(st.get("relations_in_progress")),
        "relations_processed": int(st.get("relations_processed") or 0),
        "relations_total": int(st.get("relations_total") or 0),
        "relations_percent": relations_percent_for_state(st),
        "relations_phase": st.get("relations_phase", "Idle"),
        "relations_source": st.get("relations_source", "local"),
        "relation_projection": {
            "ready": bool(st.get("relation_projection_ready")),
            "builder_version": str(st.get("relation_projection_builder_version") or ""),
            "startup_rebuilt": bool(st.get("relation_projection_startup_rebuilt")),
            "rebuild_reason": str(st.get("relation_projection_rebuild_reason") or ""),
            "duration_ms": float(st.get("relation_projection_duration_ms") or 0.0),
        },
        "covers_in_progress": bool(st.get("covers_in_progress")),
        "covers_processed": int(st.get("covers_processed") or 0),
        "covers_total": int(st.get("covers_total") or 0),
        "covers_downloaded": int(st.get("covers_downloaded") or 0),
        "covers_current_folder": st.get("covers_current_folder") or "",
        "pending_cover_refresh_after_scan": bool(st.get("pending_cover_refresh_after_scan")),
        "last_scan_display": format_timestamp(float(st.get("last_scan") or 0.0)),
        "last_error": st.get("last_error"),
        "album_total": len(st.get("albums", [])),
    }
