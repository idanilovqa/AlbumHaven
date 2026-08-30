from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher


_CYRILLIC_TO_LATIN = {
    "\u0430": "a", "\u0431": "b", "\u0432": "v", "\u0433": "g", "\u0434": "d", "\u0435": "e", "\u0451": "yo",
    "\u0436": "zh", "\u0437": "z", "\u0438": "i", "\u0439": "y", "\u043a": "k", "\u043b": "l", "\u043c": "m",
    "\u043d": "n", "\u043e": "o", "\u043f": "p", "\u0440": "r", "\u0441": "s", "\u0442": "t", "\u0443": "u",
    "\u0444": "f", "\u0445": "kh", "\u0446": "ts", "\u0447": "ch", "\u0448": "sh", "\u0449": "shch",
    "\u044a": "", "\u044b": "y", "\u044c": "", "\u044d": "e", "\u044e": "yu", "\u044f": "ya",
}
_SEARCH_SYMBOL_WORDS = {
    "?": "question mark",
    "!": "exclamation mark",
    "&": "and",
    "+": "plus",
    "@": "at",
    "#": "number",
    "%": "percent",
    "$": "dollar",
    "*": "star",
}
_ARTIST_IDENTITY_ROLE_TOKENS = {
    "band",
    "ensemble",
    "experience",
    "group",
    "orchestra",
    "project",
    "tribute",
}
_AUTOMATIC_IDENTITY_TOKEN_SIMILARITY_FLOOR = 0.8


def _as_text(value: object) -> str:
    if value is None:
        return ""
    return str(value)


def contains_cyrillic(value: object) -> bool:
    return any("\u0400" <= char <= "\u04ff" for char in _as_text(value))


def transliterate_cyrillic(value: object) -> str:
    result: list[str] = []
    for char in _as_text(value):
        lower = char.lower()
        replacement = _CYRILLIC_TO_LATIN.get(lower)
        if replacement is None:
            result.append(char)
            continue
        if char.isupper():
            if len(replacement) > 1:
                result.append(replacement[:1].upper() + replacement[1:])
            else:
                result.append(replacement.upper())
        else:
            result.append(replacement)
    return "".join(result)


def replace_search_symbols(value: object) -> str:
    result: list[str] = []
    for char in _as_text(value):
        replacement = _SEARCH_SYMBOL_WORDS.get(char)
        if replacement is None:
            result.append(char)
            continue
        result.append(f" {replacement} ")
    return "".join(result)


def normalize_search_text(value: object) -> str:
    symbol_expanded = replace_search_symbols(value)
    transliterated = transliterate_cyrillic(symbol_expanded)
    ascii_text = unicodedata.normalize("NFKD", transliterated).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", " ", ascii_text.casefold()).strip()


def incompatible_artist_identity_markers(value: object) -> set[str]:
    tokens = set(normalize_search_text(value).split())
    markers = {
        f"identity-role:{token}"
        for token in tokens
        if token in _ARTIST_IDENTITY_ROLE_TOKENS
    }
    if {"cover", "band"} <= tokens:
        markers.add("cover-band")
    return markers


def canonical_artist_identity(value: object) -> str:
    transliterated = transliterate_cyrillic(value)
    ascii_text = unicodedata.normalize("NFKD", transliterated).encode(
        "ascii",
        "ignore",
    ).decode("ascii")
    identity_parts: list[str] = []
    for char in ascii_text.casefold():
        if char.isalnum():
            identity_parts.append(char)
            continue
        symbol_word = _SEARCH_SYMBOL_WORDS.get(char)
        if symbol_word:
            identity_parts.append(re.sub(r"[^a-z0-9]+", "", symbol_word.casefold()))
    return "".join(identity_parts)


def same_artist_identity(target_artist: object, candidate_artist: object) -> bool:
    if incompatible_artist_identity_markers(target_artist) != incompatible_artist_identity_markers(
        candidate_artist
    ):
        return False
    target_identity = normalize_search_text(target_artist)
    candidate_identity = normalize_search_text(candidate_artist)
    if target_identity and candidate_identity and target_identity == candidate_identity:
        return True
    target_without_conjunction = [
        token for token in target_identity.split() if token != "and"
    ]
    candidate_without_conjunction = [
        token for token in candidate_identity.split() if token != "and"
    ]
    if (
        len(target_without_conjunction) >= 2
        and target_without_conjunction == candidate_without_conjunction
    ):
        return True
    target_canonical = canonical_artist_identity(target_artist)
    candidate_canonical = canonical_artist_identity(candidate_artist)
    return bool(
        target_canonical
        and candidate_canonical
        and target_canonical == candidate_canonical
    )


def _automatic_identity_tokens(value: object) -> tuple[str, ...]:
    tokens = normalize_search_text(value).split()
    if tokens and tokens[0] == "the":
        tokens = tokens[1:]
    return tuple(token for token in tokens if token != "and")


def automatic_artist_identity_match_allowed(
    target_artist: object,
    candidate_artist: object,
) -> bool:
    """Return whether an automatic exact or fuzzy artist match is identity-safe.

    Exact normalized identities remain valid even when punctuation adds a conjunction.
    Fuzzy matching is limited to names with the same semantic token shape so a close
    score cannot silently add or remove a collaborator, ensemble, or tribute identity.
    The caller still owns its provider-specific similarity threshold.
    """
    if same_artist_identity(target_artist, candidate_artist):
        return True
    if incompatible_artist_identity_markers(target_artist) != incompatible_artist_identity_markers(
        candidate_artist
    ):
        return False
    target_tokens = _automatic_identity_tokens(target_artist)
    candidate_tokens = _automatic_identity_tokens(candidate_artist)
    if not target_tokens or len(target_tokens) != len(candidate_tokens):
        return False
    target_raw_tokens = normalize_search_text(target_artist).split()
    candidate_raw_tokens = normalize_search_text(candidate_artist).split()
    has_leading_article = bool(
        (target_raw_tokens and target_raw_tokens[0] == "the")
        or (candidate_raw_tokens and candidate_raw_tokens[0] == "the")
    )
    if has_leading_article and any(
        _singular_plural_token_pair(target_token, candidate_token)
        for target_token, candidate_token in zip(target_tokens, candidate_tokens)
    ):
        return False
    return all(
        SequenceMatcher(None, target_token, candidate_token).ratio()
        >= _AUTOMATIC_IDENTITY_TOKEN_SIMILARITY_FLOOR
        for target_token, candidate_token in zip(target_tokens, candidate_tokens)
    )


def _singular_plural_token_pair(left: str, right: str) -> bool:
    return bool(
        len(left) > 1
        and len(right) > 1
        and (
            (left.endswith("s") and left[:-1] == right)
            or (right.endswith("s") and right[:-1] == left)
        )
    )


def artist_identity_similarity(left: object, right: object) -> float:
    left_norm = normalize_search_text(left)
    right_norm = normalize_search_text(right)
    if not left_norm or not right_norm:
        return 0.0
    if left_norm == right_norm:
        return 1.0
    shorter_text = left_norm if len(left_norm) <= len(right_norm) else right_norm
    longer_text = right_norm if shorter_text is left_norm else left_norm
    if len(shorter_text) >= 3 and shorter_text in longer_text:
        shorter = min(len(left_norm), len(right_norm))
        longer = max(len(left_norm), len(right_norm))
        if longer > 0:
            return max(0.9, shorter / longer)
    return SequenceMatcher(None, left_norm, right_norm).ratio()
