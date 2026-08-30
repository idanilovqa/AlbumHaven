from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Callable

from music_app.services import music_identity_matching as identity_matching


contains_cyrillic = identity_matching.contains_cyrillic
transliterate_cyrillic = identity_matching.transliterate_cyrillic
replace_search_symbols = identity_matching.replace_search_symbols
normalize = identity_matching.normalize_search_text
similarity = identity_matching.artist_identity_similarity
incompatible_artist_identity_markers = identity_matching.incompatible_artist_identity_markers
canonical_artist_identity = identity_matching.canonical_artist_identity
same_artist_identity = identity_matching.same_artist_identity
automatic_artist_identity_match_allowed = identity_matching.automatic_artist_identity_match_allowed


_ALBUM_VARIANT_KEYWORDS = (
    "anniversary",
    "bonus",
    "deluxe",
    "edition",
    "expanded",
    "feat",
    "feature",
    "featured",
    "featuring",
    "ft",
    "instrumental",
    "mix",
    "mono",
    "remaster",
    "remastered",
    "remix",
    "remixed",
    "remixes",
    "remixing",
    "reissue",
    "single",
    "stereo",
    "version",
    "ep",
)
_FEATURE_VARIANT_KEYWORDS = {"feat", "feature", "featured", "featuring", "ft"}
_MIX_VARIANT_KEYWORDS = {"mix", "mixed", "mixes", "mixing"}
_REMIX_VARIANT_KEYWORDS = {"remix", "remixed", "remixes", "remixing"}
_SIMPLE_NUMBER_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
}
AUTOMATIC_PRIMARY_PROVIDER_ORDER = ("apple", "deezer", "spotify")
EARLY_MANUAL_PRIMARY_PROVIDER_ORDER = ("apple", "deezer")
MANUAL_PRIMARY_PROVIDER_ORDER = ("apple", "deezer", "youtube_music", "spotify")
APPLE_SUFFICIENT_COVER_EDGE = 1200
MIN_AUTHORITATIVE_COVER_EDGE = 1200


def parse_year(value: object) -> int | None:
    if value is None:
        return None
    match = re.search(r"(19|20)\d{2}", str(value))
    if not match:
        return None
    try:
        return int(match.group(0))
    except ValueError:
        return None


def canonical_album_title(value: str) -> str:
    working = re.sub(
        r"(?<![A-Za-z0-9])e\s*\.\s*p\.?(?![A-Za-z0-9])",
        "EP",
        transliterate_cyrillic(value or ""),
        flags=re.IGNORECASE,
    )
    working = re.sub(
        r"\s*[\(\[\{][^)\]\}]*\b(?:"
        + "|".join(_ALBUM_VARIANT_KEYWORDS)
        + r")\b[^)\]\}]*[\)\]\}]",
        "",
        working,
        flags=re.IGNORECASE,
    )
    working = re.sub(
        r"\s*[-:]\s*(?:"
        + "|".join(_ALBUM_VARIANT_KEYWORDS)
        + r")\b.*$",
        "",
        working,
        flags=re.IGNORECASE,
    )
    return normalize(working)


def _parse_simple_roman_numeral(value: str) -> int | None:
    text = str(value or "").strip().upper()
    if not text or not re.fullmatch(r"[IVX]+", text):
        return None
    values = {"I": 1, "V": 5, "X": 10}
    total = 0
    previous = 0
    for char in reversed(text):
        current = values.get(char, 0)
        if current < previous:
            total -= current
        else:
            total += current
            previous = current
    return total if total > 0 else None


def _parse_simple_number_word(value: str) -> int | None:
    return _SIMPLE_NUMBER_WORDS.get(str(value or "").strip().casefold())


def extract_album_part_marker(value: str) -> int | None:
    text = transliterate_cyrillic(value or "")
    if not text:
        return None
    match = re.search(
        r"\b(?:pt|part|volume|vol)\.?\s*([0-9]+|[ivx]+|one|two|three|four|five|six|seven|eight|nine|ten)\b",
        text,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    raw_marker = str(match.group(1) or "").strip()
    if raw_marker.isdigit():
        try:
            return int(raw_marker)
        except ValueError:
            return None
    word_value = _parse_simple_number_word(raw_marker)
    if word_value is not None:
        return word_value
    return _parse_simple_roman_numeral(raw_marker)


def canonical_album_title_without_part_marker(value: str) -> str:
    text = transliterate_cyrillic(value or "")
    text = re.sub(
        r"\b(?:pt|part|volume|vol)\.?\s*(?:[0-9]+|[ivx]+|one|two|three|four|five|six|seven|eight|nine|ten)\b",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"\s+", " ", text).strip()
    return canonical_album_title(text)


def normalize_edition(value: str) -> str:
    return normalize(transliterate_cyrillic(value or ""))


def build_query_variants(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
) -> list[tuple[str, str, str | None, int | None]]:
    variants = [(artist, album, edition, year)]
    translit_artist = transliterate_cyrillic(artist)
    translit_album = transliterate_cyrillic(album)
    translit_edition = transliterate_cyrillic(edition or "")
    symbol_artist = replace_search_symbols(artist)
    symbol_album = replace_search_symbols(album)
    symbol_edition = replace_search_symbols(edition or "")
    translit_symbol_artist = transliterate_cyrillic(symbol_artist)
    translit_symbol_album = transliterate_cyrillic(symbol_album)
    translit_symbol_edition = transliterate_cyrillic(symbol_edition)

    if (
        (symbol_artist.strip() and symbol_artist != artist)
        or (symbol_album.strip() and symbol_album != album)
        or (symbol_edition.strip() and symbol_edition != (edition or ""))
    ):
        variants.append((symbol_artist or artist, symbol_album or album, symbol_edition or edition, year))
    if contains_cyrillic(artist) or contains_cyrillic(album):
        if (
            (translit_artist.strip() and translit_artist != artist)
            or (translit_album.strip() and translit_album != album)
            or (translit_edition.strip() and translit_edition != (edition or ""))
        ):
            variants.append((translit_artist or artist, translit_album or album, translit_edition or edition, year))
        if (
            (translit_symbol_artist.strip() and translit_symbol_artist != artist)
            or (translit_symbol_album.strip() and translit_symbol_album != album)
            or (translit_symbol_edition.strip() and translit_symbol_edition != (edition or ""))
        ):
            variants.append(
                (
                    translit_symbol_artist or artist,
                    translit_symbol_album or album,
                    translit_symbol_edition or edition,
                    year,
                )
            )
    elif (
        (translit_symbol_artist.strip() and translit_symbol_artist != artist)
        or (translit_symbol_album.strip() and translit_symbol_album != album)
        or (translit_symbol_edition.strip() and translit_symbol_edition != (edition or ""))
    ):
        variants.append((translit_symbol_artist or artist, translit_symbol_album or album, translit_symbol_edition or edition, year))
    deduped: list[tuple[str, str, str | None, int | None]] = []
    seen: set[tuple[str, str, str, int | None]] = set()
    for variant_artist, variant_album, variant_edition, variant_year in variants:
        key = (
            " ".join(variant_artist.split()),
            " ".join(variant_album.split()),
            " ".join(str(variant_edition or "").split()),
            variant_year,
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(key)
    return deduped


def meaningful_title_tokens(value: str) -> set[str]:
    return {
        token for token in canonical_album_title(value).split()
        if len(token) >= 3 and token not in _ALBUM_VARIANT_KEYWORDS
    }


def is_short_album_title(value: str) -> bool:
    normalized = canonical_album_title(value)
    return bool(normalized) and len(normalized.replace(" ", "")) <= 2


def has_release_type_marker(value: str) -> bool:
    normalized = normalize(value)
    tokens = set(normalized.split())
    return any(token in tokens for token in {"single", "ep"})


def incompatible_album_variant_markers(value: str) -> set[str]:
    normalized_initialisms = re.sub(
        r"(?<![A-Za-z0-9])e\s*\.\s*p\.?(?![A-Za-z0-9])",
        "EP",
        str(value or ""),
        flags=re.IGNORECASE,
    )
    tokens = set(normalize(normalized_initialisms).split())
    markers = tokens & {"single", "ep"}
    if tokens & _MIX_VARIANT_KEYWORDS:
        markers.add("mix")
    if tokens & _REMIX_VARIANT_KEYWORDS:
        markers.add("remix")
    if tokens & _FEATURE_VARIANT_KEYWORDS:
        markers.add("feature")
    return markers


def has_live_marker(value: str) -> bool:
    normalized = normalize(value)
    tokens = set(normalized.split())
    return "live" in tokens


def is_self_titled_album(artist: str, album: str) -> bool:
    artist_core = canonical_album_title(artist)
    album_core = canonical_album_title(album)
    return bool(artist_core and album_core and artist_core == album_core)


def suspicious_digit_album_substitution(left: str, right: str) -> bool:
    left_norm = canonical_album_title(left)
    right_norm = canonical_album_title(right)
    if not left_norm or not right_norm or left_norm == right_norm:
        return False
    left_has_digit = any(char.isdigit() for char in left_norm)
    right_has_digit = any(char.isdigit() for char in right_norm)
    if left_has_digit == right_has_digit:
        return False
    leet_map = str.maketrans({
        "0": "o",
        "1": "i",
        "3": "e",
        "4": "a",
        "5": "s",
        "6": "g",
        "7": "t",
        "8": "b",
        "9": "g",
    })
    left_leet = left_norm.translate(leet_map)
    right_leet = right_norm.translate(leet_map)
    if left_leet != right_leet:
        return False
    return any(a != b and (a.isdigit() or b.isdigit()) for a, b in zip(left_norm, right_norm))


def edition_match_bonus(target_album: str, target_edition: str | None, candidate_album: str) -> float:
    normalized_edition = normalize_edition(target_edition or "")
    if not normalized_edition:
        return 0.0
    candidate_norm = normalize(candidate_album)
    combined_target = normalize(f"{target_album} {target_edition or ''}")
    if normalized_edition and normalized_edition in candidate_norm:
        return 0.22
    if combined_target and candidate_norm:
        combined_similarity = SequenceMatcher(None, combined_target, candidate_norm).ratio()
        if combined_similarity >= 0.94:
            return 0.16
        if combined_similarity >= 0.88:
            return 0.08
    return -0.04


def album_match_bonus(target_album: str, candidate_album: str) -> float:
    target_album_norm = canonical_album_title(target_album)
    candidate_album_norm = canonical_album_title(candidate_album)
    if not target_album_norm or not candidate_album_norm:
        return 0.0
    if target_album_norm == candidate_album_norm:
        return 0.35
    if (
        candidate_album_norm.startswith(target_album_norm)
        or target_album_norm.startswith(candidate_album_norm)
    ) and abs(len(target_album_norm) - len(candidate_album_norm)) <= 4:
        return 0.12
    return 0.0


def release_year_from_match_meta(meta: dict | None) -> int | None:
    metadata = meta or {}
    return parse_year(metadata.get("year") or metadata.get("releaseDate"))


def prefer_release_year_matches(
    matches: list[tuple[float, str, dict]],
    *,
    target_year: int | None,
) -> list[tuple[float, str, dict]]:
    if target_year is None:
        return matches
    exact_year_matches = [
        item for item in matches
        if release_year_from_match_meta(item[2]) == target_year
    ]
    near_year_matches = [
        item for item in matches
        if (
            release_year_from_match_meta(item[2]) is not None
            and abs(release_year_from_match_meta(item[2]) - target_year) <= 1
        )
    ]
    if exact_year_matches:
        return exact_year_matches
    if near_year_matches:
        return near_year_matches
    return matches


def match_score(
    target_artist: str,
    target_album: str,
    target_edition: str | None,
    target_year: int | None,
    candidate_artist: str,
    candidate_album: str,
    candidate_year: int | None,
    *,
    enforce_year: bool = True,
) -> float:
    artist_score = similarity(target_artist, candidate_artist)
    album_score = similarity(target_album, candidate_album)
    if not identity_matching.automatic_artist_identity_match_allowed(
        target_artist,
        candidate_artist,
    ):
        return 0.0
    if incompatible_album_variant_markers(target_album) != incompatible_album_variant_markers(
        candidate_album
    ):
        return 0.0
    target_album_core = canonical_album_title(target_album)
    candidate_album_core = canonical_album_title(candidate_album)
    target_part_marker = extract_album_part_marker(target_album)
    candidate_part_marker = extract_album_part_marker(candidate_album)
    if (
        target_part_marker is not None
        and candidate_part_marker is not None
        and target_part_marker != candidate_part_marker
    ):
        return 0.0
    if target_part_marker is not None and candidate_part_marker is None:
        target_base_title = canonical_album_title_without_part_marker(target_album)
        candidate_base_title = canonical_album_title_without_part_marker(candidate_album)
        if target_base_title and candidate_base_title and (
            target_base_title == candidate_base_title
            or candidate_base_title.startswith(target_base_title)
            or target_base_title.startswith(candidate_base_title)
        ):
            return 0.0
    album_core_score = similarity(target_album_core, candidate_album_core)
    is_self_titled_target = is_self_titled_album(target_artist, target_album)
    if is_self_titled_target:
        if target_album_core != candidate_album_core:
            return 0.0
        if artist_score < 0.9:
            return 0.0
        if target_year:
            if candidate_year is None or candidate_year != target_year:
                return 0.0
    if is_short_album_title(target_album) and target_album_core != candidate_album_core:
        return 0.0
    target_tokens = meaningful_title_tokens(target_album)
    candidate_tokens = meaningful_title_tokens(candidate_album)
    if target_tokens and candidate_tokens and not (target_tokens & candidate_tokens) and album_core_score < 0.93:
        return 0.0
    if has_release_type_marker(candidate_album) and not has_release_type_marker(target_album) and album_core_score < 0.9:
        return 0.0
    if has_live_marker(target_album) != has_live_marker(candidate_album) and album_core_score < 0.95:
        return 0.0
    if suspicious_digit_album_substitution(target_album, candidate_album):
        year_delta = abs(target_year - candidate_year) if target_year and candidate_year else None
        year_is_off = bool(year_delta is not None and year_delta >= 2)
        artist_is_weak = artist_score < 0.78
        if year_is_off or artist_is_weak:
            return 0.0
    effective_album_score = max(album_score, album_core_score)
    exact_album_bonus = album_match_bonus(target_album, candidate_album)
    if album_core_score < 0.82:
        return 0.0
    if effective_album_score < 0.6:
        return 0.0
    if artist_score < 0.45:
        return 0.0
    edition_bonus = edition_match_bonus(target_album, target_edition, candidate_album)
    year_bonus = 0.0
    if enforce_year and target_year and candidate_year:
        year_delta = abs(target_year - candidate_year)
        if year_delta == 0:
            year_bonus = 0.24
        elif year_delta == 1:
            year_bonus = 0.1
        elif year_delta <= 3:
            year_bonus = 0.02
        else:
            year_bonus = -0.22
    return (effective_album_score * 0.65) + (artist_score * 0.35) + year_bonus + exact_album_bonus + edition_bonus


def strong_match_cutoff(best_score: float) -> float:
    if best_score >= 1.2:
        return best_score - 0.16
    if best_score >= 1.0:
        return best_score - 0.13
    if best_score >= 0.85:
        return best_score - 0.1
    return max(0.0, best_score - 0.06)


def candidate_area_score_key(candidate: object) -> tuple[int, float]:
    width = int(getattr(candidate, "width", 0) or 0)
    height = int(getattr(candidate, "height", 0) or 0)
    score = float(getattr(candidate, "score", 0.0) or 0.0)
    return (width * height, score)


def candidate_dedupe_sort_key(candidate: object) -> tuple[float, int, str]:
    score = float(getattr(candidate, "score", 0.0) or 0.0)
    width = int(getattr(candidate, "width", 0) or 0)
    height = int(getattr(candidate, "height", 0) or 0)
    return (-score, -(width * height), str(getattr(candidate, "url", "") or ""))


def dedupe_candidates(candidates: list[object]) -> list[object]:
    deduped: list[object] = []
    seen: set[str] = set()
    for candidate in sorted(candidates, key=candidate_dedupe_sort_key):
        key = str(getattr(candidate, "url", "") or "").strip().casefold()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return deduped


def select_largest_candidate(candidates: list[object]) -> object | None:
    if not candidates:
        return None
    return max(candidates, key=candidate_area_score_key)


def cover_candidate_is_acceptable(
    candidate: object | None,
    *,
    apple_sufficient_cover_edge: int = APPLE_SUFFICIENT_COVER_EDGE,
    min_authoritative_cover_edge: int = MIN_AUTHORITATIVE_COVER_EDGE,
) -> bool:
    if candidate is None:
        return False
    width = int(getattr(candidate, "width", 0) or 0)
    height = int(getattr(candidate, "height", 0) or 0)
    score = float(getattr(candidate, "score", 0.0) or 0.0)
    if (
        width >= apple_sufficient_cover_edge
        and height >= apple_sufficient_cover_edge
        and score >= 0.85
    ):
        return True
    return width >= min_authoritative_cover_edge and height >= min_authoritative_cover_edge and score >= 0.9


def primary_fallback_rank(candidate: object | None) -> tuple[float, int, int, int]:
    if candidate is None:
        return (0.0, 0, 0, 0)
    width = int(getattr(candidate, "width", 0) or 0)
    height = int(getattr(candidate, "height", 0) or 0)
    return (
        float(getattr(candidate, "score", 0.0) or 0.0),
        width * height,
        width,
        height,
    )


def provider_priority_index(provider: object, order: tuple[str, ...] = AUTOMATIC_PRIMARY_PROVIDER_ORDER) -> int:
    source = str(provider or "").strip()
    try:
        return order.index(source)
    except ValueError:
        return len(order)


def order_provider_items(
    items: list[object],
    *,
    order: tuple[str, ...] = AUTOMATIC_PRIMARY_PROVIDER_ORDER,
    provider_name: Callable[[object], object] | None = None,
) -> list[object]:
    def item_priority(indexed_item: tuple[int, object]) -> tuple[int, int]:
        index, item = indexed_item
        provider = provider_name(item) if callable(provider_name) else getattr(item, "source", "")
        return (provider_priority_index(provider, order), index)

    return [item for _index, item in sorted(enumerate(items), key=item_priority)]


def select_primary_cover_candidate(
    candidates: list[object],
    *,
    provider_order: tuple[str, ...] = AUTOMATIC_PRIMARY_PROVIDER_ORDER,
    apple_sufficient_cover_edge: int = APPLE_SUFFICIENT_COVER_EDGE,
    min_authoritative_cover_edge: int = MIN_AUTHORITATIVE_COVER_EDGE,
) -> object | None:
    matching_candidates = [
        candidate
        for candidate in candidates
        if float(getattr(candidate, "score", 0.0) or 0.0) > 0.0
    ]
    for candidate in order_provider_items(matching_candidates, order=provider_order):
        if cover_candidate_is_acceptable(
            candidate,
            apple_sufficient_cover_edge=apple_sufficient_cover_edge,
            min_authoritative_cover_edge=min_authoritative_cover_edge,
        ):
            return candidate
    if not matching_candidates:
        return None
    return max(matching_candidates, key=primary_fallback_rank)


def album_name_in_alt(album: str, alt_text: str) -> bool:
    target = canonical_album_title(album)
    candidate = canonical_album_title(alt_text)
    if not target or not candidate:
        return False
    if target in candidate:
        return True
    return similarity(target, candidate) >= 0.9


def album_query_part_variants(value: str) -> list[str]:
    raw = " ".join(str(value or "").split()).strip()
    if not raw:
        return []
    variants = [raw]
    marker = extract_album_part_marker(raw)
    if marker is not None:
        word_lookup = {
            1: "One",
            2: "Two",
            3: "Three",
            4: "Four",
            5: "Five",
            6: "Six",
            7: "Seven",
            8: "Eight",
            9: "Nine",
            10: "Ten",
        }
        roman_lookup = {
            1: "I",
            2: "II",
            3: "III",
            4: "IV",
            5: "V",
            6: "VI",
            7: "VII",
            8: "VIII",
            9: "IX",
            10: "X",
        }
        replacements = [f"Pt. {marker}", f"Part {marker}"]
        if marker in roman_lookup:
            replacements.extend([f"Pt. {roman_lookup[marker]}", f"Part {roman_lookup[marker]}"])
        if marker in word_lookup:
            replacements.extend([f"Part {word_lookup[marker]}"])
        normalized_replacements = list(dict.fromkeys(replacements))
        variant_pattern = (
            r"\b(?:pt|part|volume|vol)\.?\s*(?:[0-9]+|[ivx]+|one|two|three|four|five|six|seven|eight|nine|ten)\b"
        )
        for replacement in normalized_replacements:
            replaced = re.sub(variant_pattern, replacement, raw, count=1, flags=re.IGNORECASE)
            if replaced and replaced not in variants:
                variants.append(replaced)
    return variants
