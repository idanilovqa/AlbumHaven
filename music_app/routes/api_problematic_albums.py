from __future__ import annotations

from collections.abc import Callable


ProblemReasonBuilder = Callable[[str, str], str | None]
ArtistAliasProblemReasonBuilder = Callable[[object, dict[str, str] | None], str | None]
YearProblemReasonBuilder = Callable[[object], str | None]
AlbumProblemIgnoreChecker = Callable[[object, dict[str, dict[str, object]], set[str], str, str, str], bool]
TrackYearProblemIgnoreChecker = Callable[[object, dict[str, dict[str, object]], set[str], str], bool]
TrackLevelProblemCollector = Callable[[object, dict[str, dict[str, object]], set[str], dict[str, str] | None], list[str]]
EncodingRepairPreviewBuilder = Callable[[object, dict[str, dict[str, object]], set[str], dict[str, str] | None, bool], dict[str, object]]
TrackProblemRowCollector = Callable[[object, dict[str, dict[str, object]], set[str], dict[str, str] | None], list[dict[str, object]]]
SeparateReleaseCandidateBuilder = Callable[[object, dict[str, dict[str, object]], set[str]], dict[str, object] | None]
AlbumSerializer = Callable[[object], dict[str, object]]
DuplicateSourceChecker = Callable[[object], object]
ImageDimensionsReader = Callable[[object], tuple[int, int]]
IgnoredRepairKeyLoader = Callable[[dict], set[str]]
SeparateReleaseKeyLoader = Callable[[dict], set[str]]
StateGetter = Callable[[], dict[str, object]]


def _require_config(config: dict | None) -> dict:
    if config is None:
        raise ValueError("config is required")
    return config


def _build_problematic_album_key_candidates(album_key: str) -> list[str]:
    raw_key = str(album_key or "")
    candidates = [raw_key]
    try:
        repaired_key = raw_key.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        repaired_key = ""
    if repaired_key and repaired_key not in candidates:
        candidates.append(repaired_key)
    return candidates


def _collect_album_file_types(album: object) -> list[str]:
    file_types = {
        str(str(getattr(track, "path", "") or "").split(".")[-1]).upper()
        for track in getattr(album, "tracks", []) or []
        if "." in str(getattr(track, "path", "") or "")
    }
    return sorted(file_type for file_type in file_types if file_type)


def _collect_album_track_summaries(album: object) -> list[dict[str, str]]:
    return [
        {
            "path": str(getattr(track, "path", "") or ""),
            "title": str(getattr(track, "title", "") or ""),
        }
        for track in getattr(album, "tracks", []) or []
        if str(getattr(track, "path", "") or "")
    ]


def _build_problematic_album_summary_payload(
    album: object,
    *,
    problem_reasons: list[str],
    repair_preview: dict[str, object],
    cover_width: int,
    cover_height: int,
) -> dict[str, object]:
    tracks = _collect_album_track_summaries(album)
    track_titles = [str(track.get("title") or "") for track in tracks if str(track.get("title") or "").strip()]
    search_parts = [
        str(getattr(album, "name", "") or ""),
        str(getattr(album, "album_artist", "") or ""),
        str(getattr(album, "year", "") or ""),
        str(repair_preview.get("raw_name") or ""),
        str(repair_preview.get("raw_album_artist") or ""),
        *[str(reason or "") for reason in problem_reasons],
        *track_titles,
    ]
    return {
        "key": getattr(album, "key", ""),
        "name": getattr(album, "name", ""),
        "album_artist": getattr(album, "album_artist", ""),
        "artists": list(getattr(album, "artists", []) or []),
        "is_compilation": bool(getattr(album, "is_compilation", False)),
        "cover_path": str(getattr(album, "cover_path", "") or "") or None,
        "local_cover_width": getattr(album, "local_cover_width", None),
        "local_cover_height": getattr(album, "local_cover_height", None),
        "remote_cover_url": getattr(album, "remote_cover_url", None),
        "remote_cover_thumbnail_url": getattr(album, "remote_cover_thumbnail_url", None),
        "remote_cover_source": getattr(album, "remote_cover_source", None),
        "remote_cover_source_label": getattr(album, "remote_cover_source_label", None),
        "remote_cover_album_url": getattr(album, "remote_cover_album_url", None),
        "remote_cover_width": getattr(album, "remote_cover_width", None),
        "remote_cover_height": getattr(album, "remote_cover_height", None),
        "year": getattr(album, "year", None),
        "release_date": getattr(album, "release_date", None),
        "edition": getattr(album, "edition", None),
        "album_rating": int(getattr(album, "album_rating", 0) or 0),
        "problem_reasons": list(problem_reasons),
        "cover_width": cover_width,
        "cover_height": cover_height,
        "has_encoding_repairs": bool(repair_preview.get("has_repairs")),
        "raw_name": repair_preview.get("raw_name"),
        "raw_album_artist": repair_preview.get("raw_album_artist"),
        "track_count": len(tracks),
        "tracks": tracks,
        "track_paths": [str(track.get("path") or "") for track in tracks],
        "file_types": _collect_album_file_types(album),
        "search_text": "\n".join(part for part in search_parts if str(part or "").strip()),
        "detail_loaded": False,
    }


def _build_problematic_album_detail_payload(
    album: object,
    *,
    album_to_dict: AlbumSerializer,
    problem_reasons: list[str],
    repair_preview: dict[str, object],
    track_problem_rows: list[dict[str, object]],
    separate_release_candidate: dict[str, object] | None,
    cover_width: int,
    cover_height: int,
) -> dict[str, object]:
    album_payload = album_to_dict(album)
    album_payload["problem_reasons"] = problem_reasons
    album_payload["cover_width"] = cover_width
    album_payload["cover_height"] = cover_height
    album_payload["has_encoding_repairs"] = bool(repair_preview["has_repairs"])
    album_payload["raw_name"] = repair_preview["raw_name"]
    album_payload["raw_album_artist"] = repair_preview["raw_album_artist"]
    album_payload["repair_preview_rows"] = repair_preview["preview_rows"]
    album_payload["track_problem_rows"] = track_problem_rows
    album_payload["problematic_track_paths"] = [str(row.get("path") or "") for row in track_problem_rows]
    album_payload["separate_release_candidate"] = separate_release_candidate
    album_payload["track_count"] = len(getattr(album, "tracks", []) or [])
    album_payload["track_paths"] = [str(getattr(track, "path", "") or "") for track in getattr(album, "tracks", []) or []]
    album_payload["file_types"] = _collect_album_file_types(album)
    album_payload["detail_loaded"] = True
    return album_payload


def _collect_problematic_album_context(
    album: object,
    *,
    file_cache: dict[str, dict[str, object]],
    ignored_row_keys: set[str],
    separate_release_keys: set[str],
    alias_to_canonical: dict[str, str],
    text_problem_reason: ProblemReasonBuilder,
    artist_alias_problem_reason: ArtistAliasProblemReasonBuilder,
    year_problem_reason: YearProblemReasonBuilder,
    all_track_text_problems_ignored: AlbumProblemIgnoreChecker,
    all_track_year_problems_ignored: TrackYearProblemIgnoreChecker,
    collect_track_level_problem_reasons: TrackLevelProblemCollector,
    build_encoding_repair_preview: EncodingRepairPreviewBuilder,
    collect_track_problem_rows: TrackProblemRowCollector,
    separate_release_candidate: SeparateReleaseCandidateBuilder,
    get_album_duplicate_sources: DuplicateSourceChecker,
    poor_art_min_edge: int,
    include_detail_fields: bool = True,
) -> dict[str, object] | None:
    reasons: list[str] = []
    cover_width = 0
    cover_height = 0

    artist_reason = text_problem_reason("Artist", getattr(album, "album_artist", ""))
    if artist_reason and not (
        artist_reason == "Undecoded characters"
        and all_track_text_problems_ignored(album, file_cache, ignored_row_keys, "album_artist", "Artist", artist_reason)
    ):
        reasons.append(artist_reason)

    canonical_artist_reason = artist_alias_problem_reason(getattr(album, "album_artist", ""), alias_to_canonical)
    if canonical_artist_reason and canonical_artist_reason not in reasons:
        reasons.append(canonical_artist_reason)

    album_reason = text_problem_reason("Album", getattr(album, "name", ""))
    if album_reason and not (
        album_reason == "Undecoded characters"
        and all_track_text_problems_ignored(album, file_cache, ignored_row_keys, "album", "Album", album_reason)
    ):
        reasons.append(album_reason)

    year_reason = year_problem_reason(getattr(album, "year", None))
    if year_reason and not (
        year_reason == "Missing year"
        and all_track_year_problems_ignored(album, file_cache, ignored_row_keys, year_reason)
    ):
        reasons.append(year_reason)

    cover_path_value = getattr(album, "cover_path", None)
    if not cover_path_value:
        reasons.append("Missing cover art")
    else:
        cover_width = int(getattr(album, "local_cover_width", 0) or 0)
        cover_height = int(getattr(album, "local_cover_height", 0) or 0)
        if (
            cover_width > 0
            and cover_height > 0
            and (cover_width < poor_art_min_edge or cover_height < poor_art_min_edge)
        ):
            reasons.append("Poor art quality")

    if get_album_duplicate_sources(album):
        reasons.append("Duplicate files")

    for reason in collect_track_level_problem_reasons(album, file_cache, ignored_row_keys, alias_to_canonical):
        if reason not in reasons:
            reasons.append(reason)

    summary_repair_preview = build_encoding_repair_preview(
        album,
        file_cache,
        ignored_row_keys,
        alias_to_canonical,
        False,
    )
    if not reasons and not summary_repair_preview["has_repairs"]:
        return None
    repair_preview = summary_repair_preview if not include_detail_fields else build_encoding_repair_preview(
        album,
        file_cache,
        ignored_row_keys,
        alias_to_canonical,
        True,
    )

    return {
        "problem_reasons": reasons,
        "repair_preview": repair_preview,
        "track_problem_rows": (
            collect_track_problem_rows(album, file_cache, ignored_row_keys, alias_to_canonical)
            if include_detail_fields else []
        ),
        "separate_release_candidate": (
            separate_release_candidate(album, file_cache, separate_release_keys)
            if include_detail_fields else None
        ),
        "cover_width": cover_width,
        "cover_height": cover_height,
    }


def build_problematic_albums_payload(
    *,
    state_getter: StateGetter,
    config: dict | None = None,
    load_ignored_repair_keys: IgnoredRepairKeyLoader,
    load_separate_release_keys: SeparateReleaseKeyLoader,
    text_problem_reason: ProblemReasonBuilder,
    artist_alias_problem_reason: ArtistAliasProblemReasonBuilder,
    year_problem_reason: YearProblemReasonBuilder,
    all_track_text_problems_ignored: AlbumProblemIgnoreChecker,
    all_track_year_problems_ignored: TrackYearProblemIgnoreChecker,
    collect_track_level_problem_reasons: TrackLevelProblemCollector,
    build_encoding_repair_preview: EncodingRepairPreviewBuilder,
    collect_track_problem_rows: TrackProblemRowCollector,
    separate_release_candidate: SeparateReleaseCandidateBuilder,
    album_to_dict: AlbumSerializer,
    get_album_duplicate_sources: DuplicateSourceChecker,
    image_dimensions: ImageDimensionsReader,
    poor_art_min_edge: int,
) -> dict[str, object]:
    cfg = _require_config(config)
    st = state_getter()
    file_cache = st.get("file_cache", {}) or {}
    relation_views = st.get("relation_views", {}) or {}
    alias_to_canonical = relation_views.get("alias_to_canonical", {}) or {}
    ignored_row_keys = load_ignored_repair_keys(cfg)
    separate_release_keys = load_separate_release_keys(cfg)
    st["separate_release_keys"] = separate_release_keys
    problematic = []

    for album in st.get("albums", []):
        context = _collect_problematic_album_context(
            album,
            file_cache=file_cache,
            ignored_row_keys=ignored_row_keys,
            separate_release_keys=separate_release_keys,
            alias_to_canonical=alias_to_canonical,
            text_problem_reason=text_problem_reason,
            artist_alias_problem_reason=artist_alias_problem_reason,
            year_problem_reason=year_problem_reason,
            all_track_text_problems_ignored=all_track_text_problems_ignored,
            all_track_year_problems_ignored=all_track_year_problems_ignored,
            collect_track_level_problem_reasons=collect_track_level_problem_reasons,
            build_encoding_repair_preview=build_encoding_repair_preview,
            collect_track_problem_rows=collect_track_problem_rows,
            separate_release_candidate=separate_release_candidate,
            get_album_duplicate_sources=get_album_duplicate_sources,
            poor_art_min_edge=poor_art_min_edge,
            include_detail_fields=False,
        )
        if context is None:
            continue
        problematic.append(_build_problematic_album_summary_payload(
            album,
            problem_reasons=list(context["problem_reasons"]),
            repair_preview=dict(context["repair_preview"]),
            cover_width=int(context["cover_width"]),
            cover_height=int(context["cover_height"]),
        ))

    problematic.sort(
        key=lambda item: (
            str(item.get("name") or "").casefold(),
            str(item.get("album_artist") or "").casefold(),
            str(item.get("year") or ""),
        )
    )
    return {
        "items": problematic,
        "count": len(problematic),
    }


def build_problematic_album_detail_payload(
    *,
    album_key: str,
    state_getter: StateGetter,
    config: dict | None = None,
    load_ignored_repair_keys: IgnoredRepairKeyLoader,
    load_separate_release_keys: SeparateReleaseKeyLoader,
    text_problem_reason: ProblemReasonBuilder,
    artist_alias_problem_reason: ArtistAliasProblemReasonBuilder,
    year_problem_reason: YearProblemReasonBuilder,
    all_track_text_problems_ignored: AlbumProblemIgnoreChecker,
    all_track_year_problems_ignored: TrackYearProblemIgnoreChecker,
    collect_track_level_problem_reasons: TrackLevelProblemCollector,
    build_encoding_repair_preview: EncodingRepairPreviewBuilder,
    collect_track_problem_rows: TrackProblemRowCollector,
    separate_release_candidate: SeparateReleaseCandidateBuilder,
    album_to_dict: AlbumSerializer,
    get_album_duplicate_sources: DuplicateSourceChecker,
    image_dimensions: ImageDimensionsReader,
    poor_art_min_edge: int,
) -> dict[str, object] | None:
    cfg = _require_config(config)
    st = state_getter()
    requested_keys = set(_build_problematic_album_key_candidates(album_key))
    file_cache = st.get("file_cache", {}) or {}
    relation_views = st.get("relation_views", {}) or {}
    alias_to_canonical = relation_views.get("alias_to_canonical", {}) or {}
    ignored_row_keys = load_ignored_repair_keys(cfg)
    separate_release_keys = load_separate_release_keys(cfg)
    st["separate_release_keys"] = separate_release_keys

    for album in st.get("albums", []):
        if str(getattr(album, "key", "") or "") not in requested_keys:
            continue
        context = _collect_problematic_album_context(
            album,
            file_cache=file_cache,
            ignored_row_keys=ignored_row_keys,
            separate_release_keys=separate_release_keys,
            alias_to_canonical=alias_to_canonical,
            text_problem_reason=text_problem_reason,
            artist_alias_problem_reason=artist_alias_problem_reason,
            year_problem_reason=year_problem_reason,
            all_track_text_problems_ignored=all_track_text_problems_ignored,
            all_track_year_problems_ignored=all_track_year_problems_ignored,
            collect_track_level_problem_reasons=collect_track_level_problem_reasons,
            build_encoding_repair_preview=build_encoding_repair_preview,
            collect_track_problem_rows=collect_track_problem_rows,
            separate_release_candidate=separate_release_candidate,
            get_album_duplicate_sources=get_album_duplicate_sources,
            poor_art_min_edge=poor_art_min_edge,
            include_detail_fields=True,
        )
        if context is None:
            return None
        return _build_problematic_album_detail_payload(
            album,
            album_to_dict=album_to_dict,
            problem_reasons=list(context["problem_reasons"]),
            repair_preview=dict(context["repair_preview"]),
            track_problem_rows=list(context["track_problem_rows"]),
            separate_release_candidate=context["separate_release_candidate"],
            cover_width=int(context["cover_width"]),
            cover_height=int(context["cover_height"]),
        )
    return None
