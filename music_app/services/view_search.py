from __future__ import annotations

import re
import shlex

from music_app.routes.api_rules_helpers import looks_like_collaboration_name
from music_app.services.library import shared_album_display_artist

_SEARCH_PUNCT_RE = re.compile(r"[\W_]+", re.UNICODE)
_SEARCH_QUERY_SPLIT_RE = re.compile(r"\s*(?:[-\u2013\u2014:|/\\]+|[;,]+)\s*")
_TRACK_PATH_SEPARATOR_RE = re.compile(r"[\\/]+")
_SEARCH_COMMIT_DEBOUNCE_MS = 150


def normalize_search_text(value: str) -> str:
    text = (value or "").strip().casefold()
    text = text.replace("'", "").replace("\u2019", "")
    text = _SEARCH_PUNCT_RE.sub(" ", text)
    words = []
    for word in text.split():
        if len(word) > 3 and word.endswith("s"):
            word = word[:-1]
        words.append(word)
    return " ".join(words)


def split_search_terms(value: str) -> list[str]:
    raw_text = str(value or "").strip()
    normalized_full = normalize_search_text(raw_text)
    if not normalized_full:
        return []
    terms = [normalized_full]
    seen = {normalized_full}
    for part in _SEARCH_QUERY_SPLIT_RE.split(raw_text):
        normalized_part = normalize_search_text(part)
        if not normalized_part or normalized_part in seen:
            continue
        seen.add(normalized_part)
        terms.append(normalized_part)
    return terms


def compact_search_key(value: str) -> str:
    return re.sub(r"[\W_]+", "", str(value or "").casefold(), flags=re.UNICODE)


def _iter_source_text_variants(source: object) -> list[str]:
    if source is None:
        return []
    if isinstance(source, dict):
        romanized_name = source.get("romanized_name")
        transliteration_variants = source.get("transliteration_variants")
    else:
        romanized_name = getattr(source, "romanized_name", None)
        transliteration_variants = getattr(source, "transliteration_variants", None)

    variants: list[str] = []
    if romanized_name is not None:
        variants.append(str(romanized_name or ""))
    if isinstance(transliteration_variants, (list, tuple, set)):
        variants.extend(str(value or "") for value in transliteration_variants)
    elif transliteration_variants is not None:
        variants.append(str(transliteration_variants or ""))
    return variants


def _normalize_search_fields(*values: object, source: object = None) -> list[str]:
    normalized_fields: list[str] = []
    seen: set[str] = set()
    for raw_value in [*values, *_iter_source_text_variants(source)]:
        normalized = normalize_search_text(str(raw_value or ""))
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        normalized_fields.append(normalized)
    return normalized_fields


def _track_path_leaf_and_stem(value: object) -> tuple[str, str]:
    raw_path = str(value or "").strip().rstrip("\\/")
    if not raw_path:
        return "", ""
    leaf = _TRACK_PATH_SEPARATOR_RE.split(raw_path)[-1]
    if not leaf:
        return "", ""
    stem = leaf.rsplit(".", 1)[0] if "." in leaf else leaf
    return leaf, stem


def _normalize_search_filter_values(values: list[str] | tuple[str, ...] | set[str] | None) -> list[str]:
    normalized_values: list[str] = []
    seen = set()
    for value in values or []:
        text = str(value or "").strip()
        if not text:
            continue
        dedupe_key = text.casefold()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        normalized_values.append(text)
    return normalized_values


def _normalize_optional_int(value: object) -> int | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        normalized = int(text)
    except (TypeError, ValueError):
        return None
    return normalized if normalized >= 0 else None


def _normalize_csv_search_values(value: object) -> list[str]:
    normalized_values: list[str] = []
    seen = set()
    for candidate in str(value or "").split(","):
        text = " ".join(str(candidate or "").strip().split())
        if not text:
            continue
        dedupe_key = text.casefold()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        normalized_values.append(text)
    return normalized_values


def build_advanced_search_shell_state(query: object) -> dict[str, object] | None:
    raw_query = " ".join(str(query or "").strip().split())
    if not raw_query:
        return None

    try:
        raw_tokens = shlex.split(raw_query)
    except ValueError:
        return None

    people_terms: list[str] = []
    people_seen: set[str] = set()
    for raw_token in raw_tokens:
        token = raw_token[1:] if raw_token.startswith("-") else raw_token
        if ":" not in token:
            continue
        field_name, raw_value = token.split(":", 1)
        if str(field_name or "").strip().casefold() != "persons":
            continue
        for value in _normalize_csv_search_values(raw_value):
            dedupe_key = value.casefold()
            if dedupe_key in people_seen:
                continue
            people_seen.add(dedupe_key)
            people_terms.append(value)

    if not people_terms:
        return None

    return {
        "shell_kind": "generic_search_page",
        "supports_page_shell": True,
        "structured_terms": {
            "persons": people_terms,
        },
        "persons_match_mode": "all_of",
        "persons_result_scope": "local_library_only",
    }


def build_search_filter_state(
    *,
    genre: list[str] | tuple[str, ...] | set[str] | None = None,
    mood: list[str] | tuple[str, ...] | set[str] | None = None,
    style: list[str] | tuple[str, ...] | set[str] | None = None,
    duration_min: object = None,
    duration_max: object = None,
) -> dict[str, object]:
    return {
        "genre": _normalize_search_filter_values(genre),
        "mood": _normalize_search_filter_values(mood),
        "style": _normalize_search_filter_values(style),
        "duration": {
            "min_seconds": _normalize_optional_int(duration_min),
            "max_seconds": _normalize_optional_int(duration_max),
        },
    }


def build_search_filter_contract() -> dict[str, object]:
    shared_result_kinds = [
        "artists",
        "albums",
        "tracks",
        "playlist_rows",
        "album_top_items",
        "favorite_song_rows",
    ]
    return {
        "shared_surfaces": [
            "global_search",
            "playlist_detail",
            "album_tops",
            "favorite_songs",
        ],
        "fields": {
            "genre": {
                "param": "genre",
                "value_type": "string",
                "multi_value": "or",
                "supported_result_kinds": list(shared_result_kinds),
            },
            "mood": {
                "param": "mood",
                "value_type": "string",
                "multi_value": "or",
                "supported_result_kinds": list(shared_result_kinds),
            },
            "style": {
                "param": "style",
                "value_type": "string",
                "multi_value": "or",
                "supported_result_kinds": list(shared_result_kinds),
            },
            "duration": {
                "min_param": "duration_min",
                "max_param": "duration_max",
                "value_type": "seconds",
                "supported_result_kinds": [
                    "albums",
                    "tracks",
                    "playlist_rows",
                    "album_top_items",
                    "favorite_song_rows",
                ],
                "duration_scope_by_result_kind": {
                    "albums": "album",
                    "tracks": "track",
                    "playlist_rows": "track",
                    "album_top_items": "album",
                    "favorite_song_rows": "track",
                },
            },
        },
    }


def build_search_query_contract() -> dict[str, object]:
    return {
        "shared_surfaces": [
            "global_search",
            "playlist_detail",
            "album_tops",
            "favorite_songs",
        ],
        "draft_commit_model": {
            "draft_state_owner": "client",
            "committed_state_owner": "server",
            "commit_triggers": ["debounce", "enter"],
            "debounce_ms": _SEARCH_COMMIT_DEBOUNCE_MS,
            "draft_sync_policy": "preserve_local_draft_until_committed_view_catches_up",
            "empty_query_behavior": "restore_root_browse",
            "in_flight_request_policy": "interrupt_previous_search_commit",
        },
        "grammar": {
            "supports_cross_field_and": True,
            "supports_same_field_or": True,
            "supports_negation": True,
            "supports_quoted_values": True,
            "supports_comparison_operators": True,
            "supports_fuzzy_commit_matching": True,
            "shortcut_tokens": [
                {
                    "token": ":loved",
                    "expands_to": {
                        "field": "love",
                        "value": "loved",
                    },
                    "availability": "authorized_private_track_search",
                },
                {
                    "token": ":obsessed",
                    "expands_to": {
                        "field": "love",
                        "value": "obsessed",
                    },
                    "availability": "authorized_private_track_search",
                },
                {
                    "token": ":returns_to",
                    "expands_to": {
                        "field": "return",
                        "value": "returns_to",
                    },
                    "availability": "authorized_private_track_search",
                },
                {
                    "token": ":not_often",
                    "expands_to": {
                        "field": "replay",
                        "value": "not_often",
                    },
                    "availability": "authorized_private_track_search",
                },
            ],
            "field_terms": {
                "artist": {
                    "value_type": "string",
                    "supports_quotes": True,
                    "supports_fuzzy_commit": True,
                    "availability": "shared",
                },
                "genre": {
                    "value_type": "string",
                    "supports_quotes": True,
                    "supports_fuzzy_commit": True,
                    "supports_structured_suggestions": True,
                    "availability": "shared",
                },
                "mood": {
                    "value_type": "string",
                    "supports_quotes": True,
                    "supports_fuzzy_commit": True,
                    "supports_structured_suggestions": True,
                    "availability": "shared",
                },
                "style": {
                    "value_type": "string",
                    "supports_quotes": True,
                    "supports_fuzzy_commit": True,
                    "supports_structured_suggestions": True,
                    "availability": "shared",
                },
                "duration": {
                    "value_type": "duration_comparison",
                    "supports_structured_suggestions": False,
                    "availability": "shared",
                },
                "love": {
                    "value_type": "enum",
                    "allowed_values": ["loved", "obsessed"],
                    "availability": "authorized_private_track_search",
                },
                "return": {
                    "value_type": "enum",
                    "allowed_values": ["returns_to"],
                    "availability": "authorized_private_track_search",
                },
                "replay": {
                    "value_type": "enum",
                    "allowed_values": ["not_often"],
                    "availability": "authorized_private_track_search",
                },
                "persons": {
                    "value_type": "csv_string",
                    "match_mode": "all_of",
                    "supports_fuzzy_commit": True,
                    "availability": "local_library_only",
                },
            },
        },
        "structured_suggestions": {
            "value_fields": ["genre", "mood", "style"],
            "fuzzy_commit_without_exact_suggestion": True,
        },
        "committed_matching": {
            "priority_order": [
                "exact",
                "alias",
                "phrase",
                "prefix",
                "distributed",
                "fuzzy",
            ],
            "numeric_terms_are_near_exact": True,
        },
    }


def bounded_edit_distance(left: str, right: str, max_distance: int = 2) -> int:
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    if abs(len(left) - len(right)) > max_distance:
        return max_distance + 1
    if len(left) > len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, start=1):
        current = [left_index]
        row_min = current[0]
        for right_index, right_char in enumerate(right, start=1):
            cost = 0 if left_char == right_char else 1
            current_value = min(
                previous[right_index] + 1,
                current[right_index - 1] + 1,
                previous[right_index - 1] + cost,
            )
            current.append(current_value)
            if current_value < row_min:
                row_min = current_value
        if row_min > max_distance:
            return max_distance + 1
        previous = current
    return previous[-1]


def search_word_matches(query_word: str, candidate_word: str) -> bool:
    query_text = str(query_word or "").strip()
    candidate_text = str(candidate_word or "").strip()
    if not query_text or not candidate_text:
        return False
    if query_text == candidate_text:
        return True
    if len(query_text) >= 3 and (query_text in candidate_text or candidate_text in query_text):
        return True
    if query_text[0] != candidate_text[0] and min(len(query_text), len(candidate_text)) >= 4:
        return False
    max_distance = 1 if min(len(query_text), len(candidate_text)) <= 5 else 2
    return bounded_edit_distance(query_text, candidate_text, max_distance) <= max_distance


def search_term_matches_field(term: str, field: str) -> bool:
    normalized_term = str(term or "").strip()
    normalized_field = str(field or "").strip()
    if not normalized_term or not normalized_field:
        return False
    if normalized_term in normalized_field:
        return True
    field_words = [word for word in normalized_field.split() if word]
    if any(search_word_matches(normalized_term, word) for word in field_words):
        return True
    compact_term = compact_search_key(normalized_term)
    compact_field = compact_search_key(normalized_field)
    if not compact_term or not compact_field:
        return False
    if compact_term == compact_field:
        return True
    if len(compact_term) < 5 or len(compact_field) < 5:
        return False
    if compact_term[0] != compact_field[0]:
        return False
    if abs(len(compact_term) - len(compact_field)) > 2:
        return False
    max_distance = 1 if min(len(compact_term), len(compact_field)) <= 8 else 2
    return bounded_edit_distance(compact_term, compact_field, max_distance) <= max_distance


def search_terms_match_fields(terms: list[str], fields: list[str]) -> bool:
    normalized_fields = [str(field or "").strip() for field in fields if str(field or "").strip()]
    if not terms or not normalized_fields:
        return False
    return all(any(search_term_matches_field(term, field) for field in normalized_fields) for term in terms)


def artist_match_rank(query: str, canonical_artist: str, aliases: set[str]) -> tuple[int, int, str]:
    normalized_query = normalize_search_text(query)
    candidates = {normalize_search_text(canonical_artist), *{normalize_search_text(value) for value in aliases if value}}
    best_rank = (5, 9999, canonical_artist.casefold())
    for candidate in candidates:
        if not candidate:
            continue
        if candidate == normalized_query:
            rank = (0, 0, candidate)
        elif candidate.startswith(normalized_query):
            rank = (1, len(candidate) - len(normalized_query), candidate)
        elif f" {normalized_query}" in candidate or candidate.endswith(normalized_query):
            rank = (2, candidate.find(normalized_query), candidate)
        elif normalized_query in candidate:
            rank = (3, candidate.find(normalized_query), candidate)
        elif search_term_matches_field(normalized_query, candidate):
            rank = (4, abs(len(candidate) - len(normalized_query)), candidate)
        else:
            rank = (5, len(candidate), candidate)
        if rank < best_rank:
            best_rank = rank
    return best_rank


def artist_alias_matches_query(artist: str, aliases: list[str] | set[str], query_terms: list[str]) -> bool:
    candidate_fields = [normalize_search_text(artist), *[normalize_search_text(value) for value in aliases if value]]
    return search_terms_match_fields(query_terms, candidate_fields)


def resolve_requested_artist(
    requested_artist: str,
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
) -> str:
    requested_artist = str(requested_artist or "").strip()
    if not requested_artist:
        return ""
    direct_match = str(alias_to_canonical.get(requested_artist, requested_artist) or "").strip()
    if requested_artist in alias_to_canonical or direct_match in canonical_to_aliases:
        if requested_artist in alias_to_canonical and looks_like_collaboration_name(requested_artist):
            return requested_artist
        return direct_match

    requested_key = normalize_search_text(requested_artist)
    if not requested_key:
        return direct_match

    for canonical_artist, aliases in canonical_to_aliases.items():
        candidates = [canonical_artist, *(aliases or [])]
        if any(normalize_search_text(candidate) == requested_key for candidate in candidates if candidate):
            if looks_like_collaboration_name(requested_artist):
                return requested_artist
            return str(canonical_artist or "").strip() or direct_match
    return direct_match


def build_legacy_search_context(
    *,
    committed_query: str,
    selected_artist: str,
    requested_artist: str,
    requested_all_artists: bool,
    direct_match_artists: list[str],
    related_match_artists: list[str],
    search_filters: dict[str, object] | None,
) -> dict[str, object] | None:
    committed_query_text = str(committed_query or "").strip()
    if not committed_query_text:
        return None

    selected_artist_text = str(selected_artist or "").strip()
    requested_artist_text = str(requested_artist or "").strip()
    if requested_all_artists:
        selected_artist_source = "requested_all_artists"
    elif requested_artist_text and selected_artist_text:
        selected_artist_source = "requested_artist"
    elif selected_artist_text:
        selected_artist_source = "auto_top_match"
    else:
        selected_artist_source = "none"

    advanced_search = build_advanced_search_shell_state(committed_query_text)

    return {
        "transport": "view_data",
        "response_kind": "legacy_artist_gallery",
        "committed_query": committed_query_text,
        **({"advanced_search": advanced_search} if advanced_search is not None else {}),
        "result_surface": {
            "kind": "grouped_artist_results",
            "group_order": ["direct_matches", "related_matches"],
            "default_selection_behavior": "explicit_result_selection",
        },
        "result_groups": {
            "direct_matches": [str(artist or "").strip() for artist in direct_match_artists if str(artist or "").strip()],
            "related_matches": [str(artist or "").strip() for artist in related_match_artists if str(artist or "").strip()],
        },
        "search_filters": search_filters or build_search_filter_state(),
        "selected_artist": selected_artist_text,
        "selected_artist_source": selected_artist_source,
        "direct_match_artists": [str(artist or "").strip() for artist in direct_match_artists if str(artist or "").strip()],
        "related_match_artists": [str(artist or "").strip() for artist in related_match_artists if str(artist or "").strip()],
    }


def _is_shared_artist_album(album) -> bool:
    return bool(getattr(album, "is_compilation", False))


def _is_various_album(album) -> bool:
    return str(getattr(album, "album_artist", "") or "").strip().casefold() in {"va", "v.a.", "various artists", "various artist", "various"}


def _album_member_artists(album, alias_to_canonical: dict[str, str] | None = None) -> list[str]:
    alias_to_canonical = alias_to_canonical or {}
    members = list(getattr(album, "artists", []) or [])
    if not members and getattr(album, "album_artist", None):
        members = [getattr(album, "album_artist")]
    canonical_members = []
    seen = set()
    for member in members:
        artist = str(member or "").strip()
        if not artist:
            continue
        canonical = str(alias_to_canonical.get(artist, artist) or "").strip()
        if not canonical or canonical in seen:
            continue
        seen.add(canonical)
        canonical_members.append(canonical)
    return canonical_members


def _get_album_track_search_fields(album) -> tuple[list[str], str]:
    cached_fields = getattr(album, "_cached_track_search_fields", None)
    cached_blob = getattr(album, "_cached_track_search_blob", None)
    if isinstance(cached_fields, list) and isinstance(cached_blob, str):
        return cached_fields, cached_blob

    fields: list[str] = []
    seen = set()
    for track in getattr(album, "tracks", []) or []:
        track_path_name, track_path_stem = _track_path_leaf_and_stem(getattr(track, "path", "") or "")
        for normalized in _normalize_search_fields(
            getattr(track, "title", "") or "",
            track_path_name,
            track_path_stem,
            source=track,
        ):
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            fields.append(normalized)
    blob = " || ".join(fields)
    setattr(album, "_cached_track_search_fields", fields)
    setattr(album, "_cached_track_search_blob", blob)
    return fields, blob


def album_track_matches_query(album, query: str) -> bool:
    track_fields, track_blob = _get_album_track_search_fields(album)
    if not track_fields:
        return False
    if query and query in track_blob:
        return True
    query_terms = split_search_terms(query)
    return len(query_terms) > 1 and search_terms_match_fields(query_terms, track_fields)


def artist_search_buckets(all_albums, relation_views, query: str):
    query = normalize_search_text(query)
    alias_to_canonical = relation_views.get("alias_to_canonical", {})
    canonical_to_aliases = relation_views.get("canonical_to_aliases", {})
    folder_related = relation_views.get("folder_related", {})

    direct_albums = []
    related_albums = []
    direct_artists: set[str] = set()
    related_artists: set[str] = set()

    if not query:
        return {
            "albums": list(all_albums),
            "direct_artists": direct_artists,
            "related_artists": related_artists,
            "direct_artists_ordered": [],
            "related_artists_ordered": [],
            "matched_artists": set(),
        }

    query_terms = split_search_terms(query)
    distributed_query = len(query_terms) > 1

    for album in all_albums:
        album_name_fields = _normalize_search_fields(getattr(album, "name", ""), source=album)
        album_name = album_name_fields[0] if album_name_fields else ""
        member_artists = _album_member_artists(album, alias_to_canonical)
        member_fields = [field for artist in member_artists for field in _normalize_search_fields(artist)]
        alias_fields = [
            field
            for artist in member_artists
            for value in canonical_to_aliases.get(artist, [])
            for field in _normalize_search_fields(value)
        ]
        related_fields = [
            field
            for artist in member_artists
            for value in folder_related.get(artist, set())
            for field in _normalize_search_fields(value)
        ]
        direct_fields = [*album_name_fields, *member_fields, *alias_fields]
        is_direct = (
            any(query in album_field for album_field in album_name_fields)
            or any(query in member_key for member_key in member_fields)
            or any(query in alias_key for alias_key in alias_fields)
        )
        if not is_direct:
            track_fields, track_blob = _get_album_track_search_fields(album)
            if distributed_query:
                direct_fields.extend(track_fields)
            track_match = (
                bool(query and query in track_blob)
                or (distributed_query and search_terms_match_fields(query_terms, track_fields))
            )
            is_direct = bool(
                track_match
                or (distributed_query and search_terms_match_fields(query_terms, direct_fields))
            )
        is_related = (not is_direct) and (
            any(query in related_key for related_key in related_fields)
            or (distributed_query and search_terms_match_fields(query_terms, related_fields))
        )

        if is_direct:
            direct_albums.append(album)
            matched_members = [
                artist for artist in member_artists
                if artist_alias_matches_query(artist, canonical_to_aliases.get(artist, []), query_terms)
            ]
            direct_artists.update(matched_members or member_artists)
            combined_artist = shared_album_display_artist(album, alias_to_canonical)
            if _is_shared_artist_album(album) and combined_artist and not _is_various_album(album):
                direct_artists.add(combined_artist)
        elif is_related:
            related_albums.append(album)
            matched_related = [
                artist for artist in member_artists
                if search_terms_match_fields(query_terms, [normalize_search_text(value) for value in folder_related.get(artist, set()) if value])
            ]
            related_artists.update(matched_related or member_artists)
            combined_artist = shared_album_display_artist(album, alias_to_canonical)
            if _is_shared_artist_album(album) and combined_artist and not _is_various_album(album):
                related_artists.add(combined_artist)

    direct_artists_ordered = sorted(
        direct_artists,
        key=lambda artist: artist_match_rank(query, artist, set(canonical_to_aliases.get(artist, []))),
    )
    related_artists_ordered = sorted(
        related_artists,
        key=lambda artist: artist_match_rank(query, artist, set(canonical_to_aliases.get(artist, []))),
    )

    return {
        "albums": direct_albums + related_albums,
        "direct_artists": direct_artists,
        "related_artists": related_artists,
        "direct_artists_ordered": direct_artists_ordered,
        "related_artists_ordered": related_artists_ordered,
        "matched_artists": direct_artists | related_artists,
    }
