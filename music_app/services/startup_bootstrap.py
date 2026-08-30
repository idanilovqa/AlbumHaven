from __future__ import annotations

import secrets
from urllib.parse import quote, urlencode

from config import PERSISTENCE_BACKEND_POSTGRES
from markupsafe import Markup, escape

from music_app.services.gallery_display import (
    DEFAULT_GALLERY_DISPLAY_MODE,
    DEFAULT_GALLERY_SCALE_PERCENT,
    normalize_gallery_display_mode,
    normalize_gallery_scale_percent,
)
from music_app.services.gallery_scope import normalize_visible_categories
from music_app.services.library import strip_private_album_preference_overlays
from music_app.services.page_resource_seams import build_album_page_seam
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.playlist_read_seams import resolve_active_view_surface

_INITIAL_VIEW_GROUP_LIMIT = 6
_INITIAL_VIEW_SIDEBAR_LIMIT = 40
_STARTUP_COVER_DISPLAY_SIZE = 480
_STARTUP_EAGER_COVER_LIMIT = 2
_SELECTED_ARTIST_FAMILY_DISPLAY_MODES = {"grouped", "chronological"}
COVER_CACHE_PROCESS_TOKEN = secrets.token_hex(16)


def safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return int(default)


def library_browse_postgres_is_effective(config: dict[str, object]) -> bool:
    selection = select_runtime_persistence_adapter("library_browse", config)
    return selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES


def normalize_selected_artist_family_display_mode(value: object) -> str:
    normalized = str(value or "").strip().casefold()
    return normalized if normalized in _SELECTED_ARTIST_FAMILY_DISPLAY_MODES else "grouped"


def build_initial_view_preview(payload: dict[str, object], *, public_safe: bool = False) -> dict[str, object]:
    preview = dict(payload or {})
    artist_groups = list(payload.get("artist_groups") or []) if isinstance(payload, dict) else []
    primary_groups = list(payload.get("primary_artist_groups") or []) if isinstance(payload, dict) else []
    family_groups = list(payload.get("family_artist_groups") or []) if isinstance(payload, dict) else []
    sidebar = list(payload.get("artists_sidebar") or []) if isinstance(payload, dict) else []
    existing_partial = bool(payload.get("initial_view_partial")) if isinstance(payload, dict) else False

    preview["artist_groups"] = [
        _build_initial_artist_group_preview(group, public_safe=public_safe)
        for group in artist_groups[:_INITIAL_VIEW_GROUP_LIMIT]
    ]
    preview["primary_artist_groups"] = [
        _build_initial_artist_group_preview(group, public_safe=public_safe)
        for group in primary_groups[:_INITIAL_VIEW_GROUP_LIMIT]
    ]
    remaining_slots = max(0, _INITIAL_VIEW_GROUP_LIMIT - len(preview["primary_artist_groups"]))
    preview["family_artist_groups"] = [
        _build_initial_artist_group_preview(group, public_safe=public_safe)
        for group in family_groups[:remaining_slots]
    ]
    preview["artists_sidebar"] = sidebar[:_INITIAL_VIEW_SIDEBAR_LIMIT]
    preview["initial_view_partial"] = bool(
        existing_partial
        or len(artist_groups) > len(preview["artist_groups"])
        or len(primary_groups) > len(preview["primary_artist_groups"])
        or len(family_groups) > len(preview["family_artist_groups"])
        or len(sidebar) > len(preview["artists_sidebar"])
        or _preview_groups_are_slimmed(artist_groups)
        or _preview_groups_are_slimmed(primary_groups)
        or _preview_groups_are_slimmed(family_groups)
    )
    return preview


def _build_initial_artist_group_preview(group: dict[str, object], *, public_safe: bool = False) -> dict[str, object]:
    preview = dict(group or {})
    preview["albums"] = [
        _build_initial_album_preview(album, public_safe=public_safe)
        for album in list(group.get("albums") or [])
        if isinstance(album, dict)
    ]
    return preview


def _build_initial_album_preview(album: dict[str, object], *, public_safe: bool = False) -> dict[str, object]:
    source_album = strip_private_album_preference_overlays(album) if public_safe else dict(album or {})
    tracks = list(source_album.get("tracks") or []) if isinstance(source_album, dict) else []
    track_count_preview = (
        len(tracks)
        if tracks
        else max(0, safe_int(source_album.get("track_count_preview"), 0))
    )
    cover_path = str(source_album.get("cover_path") or "").strip()
    cover_preview_url = build_startup_cover_url(source_album) if cover_path else ""
    return {
        "key": source_album.get("key"),
        **build_album_page_seam(source_album.get("key")),
        "name": source_album.get("name"),
        "album_artist": source_album.get("album_artist"),
        "artists": list(source_album.get("artists") or []),
        "is_compilation": bool(source_album.get("is_compilation")),
        "cover_path": source_album.get("cover_path"),
        "cover_revision": source_album.get("cover_revision"),
        "cover_preview_url": cover_preview_url,
        "remote_cover_url": source_album.get("remote_cover_url"),
        "remote_cover_thumbnail_url": source_album.get("remote_cover_thumbnail_url"),
        "remote_cover_source": source_album.get("remote_cover_source"),
        "remote_cover_source_label": source_album.get("remote_cover_source_label"),
        "remote_cover_album_url": source_album.get("remote_cover_album_url"),
        "remote_cover_width": source_album.get("remote_cover_width"),
        "remote_cover_height": source_album.get("remote_cover_height"),
        "year": source_album.get("year"),
        "release_date": source_album.get("release_date"),
        "edition": source_album.get("edition"),
        "album_rating": source_album.get("album_rating"),
        "album_preference": source_album.get("album_preference"),
        "top_viewer_overlay": source_album.get("top_viewer_overlay"),
        "tag_album_rating": source_album.get("tag_album_rating"),
        "tag_album_rating_source": source_album.get("tag_album_rating_source"),
        "album_display_metadata": source_album.get("album_display_metadata"),
        "total_duration_seconds": source_album.get("total_duration_seconds"),
        "total_duration_display": source_album.get("total_duration_display"),
        "track_count_preview": track_count_preview,
        "tracks": [],
        "has_duplicate_files": bool(source_album.get("has_duplicate_files")),
        "duplicate_sources": [],
        "gallery_list_block": source_album.get("gallery_list_block"),
        "preview_only": True,
    }


def _preview_groups_are_slimmed(groups: list[dict[str, object]]) -> bool:
    for group in groups or []:
        for album in list(group.get("albums") or []):
            if isinstance(album, dict) and list(album.get("tracks") or []):
                return True
    return False


def render_stars_markup(rating: object) -> str:
    safe_rating = rating if type(rating) is int and 1 <= rating <= 10 else 0
    return "".join(
        '<span class="star filled">&#9733;</span>'
        if index <= safe_rating
        else '<span class="star">&#9734;</span>'
        for index in range(1, 11)
    )


def get_startup_album_card_rating(album: dict[str, object]) -> int | None:
    album_preference = album.get("album_preference")
    if not isinstance(album_preference, dict):
        return None
    rating = album_preference.get("rating")
    if type(rating) is not int or rating < 1 or rating > 10:
        return None
    return rating


def build_startup_cover_url(album: dict[str, object]) -> str:
    canonical_preview_url = str(album.get("cover_preview_url") or "").strip()
    if canonical_preview_url:
        return canonical_preview_url
    cover_path = str(album.get("cover_path") or "").strip()
    if cover_path:
        cover_revision = str(album.get("cover_revision") or "").strip()
        version_token = cover_revision or f"process-{COVER_CACHE_PROCESS_TOKEN}"
        params = (
            f"path={quote(cover_path)}&size={_STARTUP_COVER_DISPLAY_SIZE}"
            f"&v={quote(version_token)}"
        )
        return f"/cover?{params}"
    remote_url = str(album.get("remote_cover_thumbnail_url") or album.get("remote_cover_url") or "").strip()
    if remote_url:
        return remote_url
    return ""


def build_startup_sidebar_href(view: dict[str, object], artist: str | None = None) -> str:
    params: list[tuple[str, str]] = []
    query_raw = str(view.get("query") or "").strip()
    if query_raw or artist:
        params.append(("surface", "albums"))
    if query_raw:
        params.append(("q", query_raw))
    if artist:
        params.append(("artist", artist))
    if bool(view.get("all_artists_active")) and query_raw:
        params.append(("all_artists", "1"))
    gallery_scope = str(view.get("gallery_scope") or "").strip()
    if gallery_scope:
        params.append(("gallery_scope", gallery_scope))
    gallery_display_mode = normalize_gallery_display_mode(view.get("gallery_display_mode"))
    if gallery_display_mode != DEFAULT_GALLERY_DISPLAY_MODE:
        params.append(("gallery_display", gallery_display_mode))
    gallery_scale_percent = normalize_gallery_scale_percent(view.get("gallery_scale_percent"))
    if gallery_scale_percent != DEFAULT_GALLERY_SCALE_PERCENT:
        params.append(("gallery_scale_percent", str(gallery_scale_percent)))
    for category in list(view.get("visible_library_categories") or []):
        category_text = str(category or "").strip()
        if category_text:
            params.append(("category", category_text))
    for related_artist in list(view.get("related_filter_artists") or []):
        related_artist_text = str(related_artist or "").strip()
        if related_artist_text:
            params.append(("related_artist", related_artist_text))
    if bool(view.get("primary_filter_active")):
        params.append(("primary_filter", "1"))
    return "/" if not params else f"/?{urlencode(params, doseq=True)}"


def resolve_effective_selected_artist(view: dict[str, object] | None) -> str:
    selected_artist = str((view or {}).get("selected_artist") or "").strip()
    if selected_artist:
        return selected_artist
    query_raw = str((view or {}).get("query") or "").strip()
    if not query_raw:
        return ""
    primary_groups = [group for group in list((view or {}).get("primary_artist_groups") or []) if isinstance(group, dict)]
    if len(primary_groups) != 1:
        return ""
    return str(primary_groups[0].get("artist") or primary_groups[0].get("artist_display") or "").strip()


def build_startup_sidebar_html(view: dict[str, object]) -> Markup:
    sidebar = list(view.get("artists_sidebar") or [])
    selected_artist = resolve_effective_selected_artist(view)
    show_all_artists_link = view.get("show_all_artists_sidebar_link") is not False
    explicit_artist_count = safe_int(view.get("artist_count"), default=len(sidebar))
    surface_payload = view.get("surface")
    active_surface = (
        resolve_active_view_surface(surface_payload.get("active"))
        if isinstance(surface_payload, dict)
        else ("albums" if selected_artist or view.get("query") or view.get("all_artists_active") else "home")
    )
    all_artists_active = bool(
        active_surface == "albums"
        and (view.get("all_artists_active") or (not view.get("query") and not selected_artist))
    )
    parts: list[str] = []
    if show_all_artists_link:
        parts.append(
            '<a class="artist-link {active}" href="{href}" data-nav="1" data-sidebar-all-artists="1">'
            '<span class="artist-name-label">All artists</span>'
            '<span class="artist-count">{count}</span>'
            "</a>".format(
                active="active" if all_artists_active else "",
                href="/?surface=albums",
                count=explicit_artist_count,
            )
        )
    for item in sidebar:
        if not isinstance(item, dict):
            continue
        artist = str(item.get("artist") or "").strip()
        if not artist:
            continue
        artist_display = str(item.get("artist_display") or artist)
        count = safe_int(item.get("count") or 0)
        parts.append(
            '<a class="artist-link {active}" href="{href}" data-nav="1" data-sidebar-artist="{artist_attr}">'
            '<span class="artist-name-label">{artist_display}</span>'
            '<span class="artist-count">{count}</span>'
            "</a>".format(
                active="active" if artist == selected_artist else "",
                href=escape(build_startup_sidebar_href(view, artist)),
                artist_attr=escape(artist),
                artist_display=escape(artist_display),
                count=count,
            )
        )
    return Markup("".join(parts))


def build_startup_related_html(view: dict[str, object]) -> Markup:
    related = list(view.get("related_artists") or [])
    selected_artist = str(view.get("selected_artist") or "").strip()
    active_related = {
        str(item or "").strip()
        for item in list(view.get("related_filter_artists") or [])
        if str(item or "").strip()
    }
    parts: list[str] = []
    if selected_artist:
        parts.append(
            '<a class="related-chip is-primary{active}" href="#" data-nav="1" data-related-primary="1" aria-current="{current}">{artist}</a>'.format(
                active=" active" if view.get("primary_filter_active") else "",
                current="true" if view.get("primary_filter_active") else "false",
                artist=escape(selected_artist),
            )
        )
    for artist in related:
        artist_name = str(artist or "").strip()
        if not artist_name:
            continue
        parts.append(
            '<a class="related-chip{active}" href="#" data-nav="1" data-related-artist="{artist_attr}">{artist}</a>'.format(
                active=" active" if artist_name in active_related else "",
                artist_attr=escape(artist_name),
                artist=escape(artist_name),
            )
        )
    return Markup("".join(parts))


def build_startup_album_card_html(album: dict[str, object], eager_cover: bool = False) -> str:
    album_key = str(album.get("key") or "").strip()
    album_name = str(album.get("name") or "Album")
    album_artist = str(album.get("album_artist") or "")
    cover_url = build_startup_cover_url(album)
    cover_path = str(album.get("cover_path") or "").strip()
    remote_fallback_url = str(album.get("remote_cover_thumbnail_url") or album.get("remote_cover_url") or "").strip()
    track_count = int(album.get("track_count_preview") or len(list(album.get("tracks") or [])) or 0)
    total_length = str(album.get("total_duration_display") or "")
    rating_value = get_startup_album_card_rating(album)
    if cover_url:
        onerror_js = (
            "const failedPath=this.getAttribute('data-cover-path')||'';"
            "if(failedPath){"
            "(window.__ALBUM_HAVEN_FAILED_LOCAL_DISPLAY_COVERS__||(window.__ALBUM_HAVEN_FAILED_LOCAL_DISPLAY_COVERS__={}))[failedPath]=true;"
            "}"
            "const remoteFallback=this.getAttribute('data-remote-cover-url')||'';"
            "if(remoteFallback&&this.dataset.remoteCoverTried!=='1'){"
            "this.dataset.remoteCoverTried='1';"
            "this.src=remoteFallback;"
            "return false;"
            "}"
            "const placeholder=document.createElement('div');"
            "placeholder.className='cover-placeholder cover-placeholder-blank';"
            "placeholder.setAttribute('aria-hidden','true');"
            "this.replaceWith(placeholder);"
            "return false;"
        )
        cover_markup = (
            '<img loading="{loading}" decoding="async" fetchpriority="{priority}" src="{src}" alt="Album cover for {name}" '
            'data-cover-visual-state="pending" aria-hidden="true" data-cover-path="{cover_path}" '
            'data-remote-cover-url="{remote_fallback_url}" '
            'onload="if(this.complete&amp;&amp;this.naturalWidth&gt;0){{this.dataset.coverVisualState=\'ready\';this.removeAttribute(\'aria-hidden\');}}" '
            'onerror="{onerror_js}">'
        ).format(
            loading="eager" if eager_cover else "lazy",
            priority="high" if eager_cover else "low",
            src=escape(cover_url),
            name=escape(album_name),
            cover_path=escape(cover_path),
            remote_fallback_url=escape(remote_fallback_url),
            onerror_js=escape(onerror_js),
        )
    else:
        cover_markup = '<div class="cover-placeholder">No cover art</div>'
    length_markup = f'<span class="album-length">{escape(total_length)}</span>' if total_length else ""
    rating_markup = (
        '<div class="rating-row"><div class="stars" role="img" aria-label="Album unrated">{stars}</div></div>'
    ).format(stars=render_stars_markup(None)) if rating_value is None else (
        '<div class="rating-row"><div class="stars" role="img" aria-label="Album rating {rating}/10">{stars}</div>'
        '<div class="rating-text">{rating}/10</div></div>'
    ).format(rating=rating_value, stars=render_stars_markup(rating_value))
    return (
        '<section class="album-card" data-startup-preview-card="1">'
        '<button class="cover album-open-trigger" type="button" data-open-tracklist="1" data-album-key="{album_key}" aria-label="Open {album_name} tracklist">'
        "{cover_markup}"
        "</button>"
        '<div class="album-body">'
        '<h3 class="album-title"><button class="album-open-trigger album-title-button" type="button" data-open-tracklist="1" data-album-key="{album_key}">{album_name}</button></h3>'
        '<div class="album-meta-row"><div class="album-subtitle">{album_artist}</div><div class="album-year">{album_year}</div></div>'
        "{rating_markup}"
        '<div class="chip-row"><span class="track-count">{track_count} track{track_plural}</span>{length_markup}</div>'
        "</div>"
        "</section>"
    ).format(
        album_key=escape(album_key),
        album_name=escape(album_name),
        cover_markup=cover_markup,
        album_artist=escape(album_artist),
        album_year=escape(str(album.get("year") or "")),
        rating_markup=rating_markup,
        track_count=track_count,
        track_plural="" if track_count == 1 else "s",
        length_markup=length_markup,
    )


def build_startup_artist_section_html(group: dict[str, object], section_type: str, eager_remaining: list[int]) -> str:
    artist_name = str(group.get("artist_display") or group.get("artist") or "Artist")
    albums = [album for album in list(group.get("albums") or []) if isinstance(album, dict)]
    album_cards: list[str] = []
    for album in albums:
        eager_cover = eager_remaining[0] > 0
        if eager_cover:
            eager_remaining[0] -= 1
        album_cards.append(build_startup_album_card_html(album, eager_cover=eager_cover))
    return (
        '<section class="artist-section {section_type}" data-startup-preview-section="1">'
        '<div class="artist-header">'
        '<h2 class="artist-name">{artist_name}</h2>'
        '<div class="artist-meta">{album_count} album{album_plural}</div>'
        "</div>"
        '<div class="artist-rows"><div class="album-row" style="grid-template-columns:repeat(auto-fill, minmax(240px, 320px)); justify-content:flex-start;">{album_cards}</div></div>'
        "</section>"
    ).format(
        section_type=escape(section_type),
        artist_name=escape(artist_name),
        album_count=len(albums),
        album_plural="" if len(albums) == 1 else "s",
        album_cards="".join(album_cards),
    )


def resolve_startup_gallery_render_mode(mode: object) -> str:
    normalized = str(mode or "").strip().lower()
    return normalized if normalized in {"cards", "covers", "list"} else DEFAULT_GALLERY_DISPLAY_MODE


def build_startup_cards_gallery_html(view: dict[str, object]) -> Markup:
    primary_groups = [group for group in list(view.get("primary_artist_groups") or []) if isinstance(group, dict)]
    family_groups = [group for group in list(view.get("family_artist_groups") or []) if isinstance(group, dict)]
    fallback_groups = [group for group in list(view.get("artist_groups") or []) if isinstance(group, dict)]
    parts: list[str] = []
    eager_remaining = [_STARTUP_EAGER_COVER_LIMIT]
    if primary_groups:
        parts.append('<div class="section-split-label">Primary Artist</div>')
        parts.extend(build_startup_artist_section_html(group, "primary", eager_remaining) for group in primary_groups)
    if family_groups:
        parts.append('<div class="section-split-label">Family</div>')
        parts.extend(build_startup_artist_section_html(group, "family", eager_remaining) for group in family_groups)
    if not primary_groups and not family_groups:
        parts.extend(build_startup_artist_section_html(group, "all", eager_remaining) for group in fallback_groups)
    return Markup("".join(parts))


def get_startup_gallery_renderer(mode: object):
    resolve_startup_gallery_render_mode(mode)
    return build_startup_cards_gallery_html


def build_startup_gallery_html(view: dict[str, object]) -> Markup:
    renderer = get_startup_gallery_renderer(view.get("gallery_display_mode"))
    return renderer(view)


def build_startup_preview_contract(
    view: dict[str, object],
    preview_mode: str,
    *,
    render_gallery_markup: bool,
) -> dict[str, object]:
    related_html = build_startup_related_html(view)
    has_related = bool(str(view.get("selected_artist") or "").strip()) and bool(list(view.get("related_artists") or []))
    return {
        "mode": preview_mode,
        "sidebar_html": build_startup_sidebar_html(view),
        "gallery_html": build_startup_gallery_html(view) if render_gallery_markup else Markup(""),
        "related_html": related_html,
        "has_related": has_related,
        "related_expanded": False,
        "render_gallery_markup": render_gallery_markup,
    }
