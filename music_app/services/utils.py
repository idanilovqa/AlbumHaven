from __future__ import annotations
from functools import lru_cache
import re
import unicodedata

_QUESTIONABLE_MARKERS = {"??", "�"}
_SUSPICIOUS_MOJIBAKE_SEQUENCES = (
    "Ð", "Ñ", "Ã", "Â", "ÄÄ", "ÄÅ", "ÄÆ", "ÄÇ", "ÄÈ", "ÄÉ", "ÄÊ", "ÄË", "ÄÌ", "ÄÍ", "ÄÎ", "ÄÏ", "ÄÒ", "ÄÓ",
    "Ýï", "Þð", "Øå", "Ð°", "Ñ‚", "Ñƒ", "Ñ�", "Ðµ", "Ð¾", "Ð¸", "Ð½", "Ð»", "Ðº",
    "Àë", "Áå", "Âî", "Ãî", "Äå", "Åë", "Æè", "Çà", "Èë", "Éî", "Êð", "Ëå", "Ìî", "Íà", "Îò", "Ïî", "Ðî", "Ñë",
    "Òå", "Óñ", "Ôå", "Õî", "Öå", "×å", "Øå", "Ùå", "Úå", "Ûé", "Üÿ", "Ýò", "Þð", "ß ",
    "àë", "áå", "âî", "ãî", "äå", "åë", "æè", "çà", "èë", "éî", "êð", "ëå", "ìî", "íà", "îò", "ïî", "ðî", "ñë",
    "òå", "óñ", "ôå", "õî", "öå", "÷å", "øå", "ùå", "úå", "ûé", "üÿ", "ýò", "þð",
)
_LIKELY_VALID_EXTENDED_LATIN = set("ðÐþÞæÆøØåÅöÖäÄüÜéÉíÍóÓáÁúÚýÝ")
_CP1251_AS_LATIN_CODEPOINTS = set(range(0x00C0, 0x0100)) | {0x00A8, 0x00B8}
MOJIBAKE_ENCODING_CANDIDATE_CHARS = "".join(
    chr(codepoint) for codepoint in sorted(_CP1251_AS_LATIN_CODEPOINTS)
)
MOJIBAKE_CANDIDATE_MARKERS = sorted(
    _QUESTIONABLE_MARKERS | set(_SUSPICIOUS_MOJIBAKE_SEQUENCES)
)
MOJIBAKE_CANDIDATE_PATTERN = "|".join(
    re.escape(marker) for marker in MOJIBAKE_CANDIDATE_MARKERS
)


def _is_cp1251_as_latin_char(char: str) -> bool:
    return ord(char) in _CP1251_AS_LATIN_CODEPOINTS


def _has_dense_cp1251_as_latin_signal(text: str) -> bool:
    meaningful_chars = [
        char for char in text
        if char.isalpha() or _is_cp1251_as_latin_char(char)
    ]
    if len(meaningful_chars) < 4:
        return False
    suspicious_count = sum(1 for char in meaningful_chars if _is_cp1251_as_latin_char(char))
    return suspicious_count >= 3 and (suspicious_count / len(meaningful_chars)) >= 0.45


def _is_cjk_unified_char(char: str) -> bool:
    return 0x3400 <= ord(char) <= 0x9FFF


def _count_ascii_letters(text: str) -> int:
    return sum(1 for char in text if char.isascii() and char.isalpha())


def _count_cjk_chars(text: str) -> int:
    return sum(1 for char in text if _is_cjk_unified_char(char))


def _count_latin_letters(text: str) -> int:
    return sum(1 for char in text if ("A" <= char <= "Z") or ("a" <= char <= "z"))


def _script_bonus(char: str) -> int:
    codepoint = ord(char)
    if 0x0400 <= codepoint <= 0x04FF:
        return 4
    if 0x3040 <= codepoint <= 0x30FF:
        return 4
    if 0x4E00 <= codepoint <= 0x9FFF:
        return 4
    if char.isalpha():
        return 2
    if char.isdigit():
        return 1
    return 0


def _text_readability_score(text: str) -> int:
    score = 0
    for char in text:
        if char in {"?", "�"}:
            score -= 6
        category = unicodedata.category(char)
        if category.startswith("L") or category.startswith("N"):
            score += _script_bonus(char)
        elif char.isspace():
            score += 1
        elif category.startswith("P"):
            score += 0
        else:
            score -= 1
        if char in _LIKELY_VALID_EXTENDED_LATIN:
            score += 2
    if "??" in text:
        score -= 10
    for marker in _SUSPICIOUS_MOJIBAKE_SEQUENCES:
        if marker in text:
            score -= max(4, len(marker) * 2)
    return score


def _has_strong_mojibake_signal(text: str) -> bool:
    if text.isascii():
        return "??" in text
    if any(marker in text for marker in _QUESTIONABLE_MARKERS):
        return True
    if _has_dense_cp1251_as_latin_signal(text):
        return True
    if _has_utf16_byte_swap_signal(text):
        return True
    return any(marker in text for marker in _SUSPICIOUS_MOJIBAKE_SEQUENCES)


def _has_utf16_byte_swap_signal(text: str) -> bool:
    normalized = str(text or "")
    if len(normalized) < 4:
        return False
    original_cjk = _count_cjk_chars(normalized)
    if original_cjk < 3:
        return False
    original_ascii_letters = _count_ascii_letters(normalized)
    for source_encoding, target_encoding in (("utf-16be", "utf-16le"), ("utf-16le", "utf-16be")):
        try:
            candidate = normalized.encode(source_encoding).decode(target_encoding)
        except Exception:
            continue
        if not candidate or candidate == normalized:
            continue
        if _is_plausible_utf16_swap_repair(normalized, candidate, original_ascii_letters=original_ascii_letters, original_cjk=original_cjk):
            return True
    return False


def _is_plausible_utf16_swap_repair(
    original: str,
    candidate: str,
    *,
    original_ascii_letters: int | None = None,
    original_cjk: int | None = None,
) -> bool:
    if not candidate or candidate == original:
        return False
    original_ascii_letters = _count_ascii_letters(original) if original_ascii_letters is None else original_ascii_letters
    original_cjk = _count_cjk_chars(original) if original_cjk is None else original_cjk
    candidate_ascii_letters = _count_ascii_letters(candidate)
    candidate_latin_letters = _count_latin_letters(candidate)
    candidate_cjk = _count_cjk_chars(candidate)
    candidate_alpha = sum(1 for char in candidate if char.isalpha())
    if original_cjk < 3:
        return False
    if candidate_ascii_letters < max(3, original_ascii_letters + 3):
        return False
    if candidate_latin_letters < max(3, candidate_alpha // 2):
        return False
    if candidate_cjk >= original_cjk:
        return False
    return True


@lru_cache(maxsize=16384)
def looks_like_mojibake(text: str | None, *, require_repair_improvement: bool = True) -> bool:
    if not text:
        return False
    normalized = str(text)
    if not _has_strong_mojibake_signal(normalized):
        return False
    if not require_repair_improvement:
        return True
    original_score = _text_readability_score(normalized)
    for candidate in _repair_text_candidates(normalized):
        if _is_plausible_utf16_swap_repair(normalized, candidate):
            return True
        if _text_readability_score(candidate) >= original_score + 8:
            return True
    return False


def _repair_text_candidates(text: str) -> list[str]:
    candidates: list[str] = []
    for source_encoding in ("latin-1", "cp1252"):
        for target_encoding in ("utf-8", "cp1251"):
            try:
                repaired = text.encode(source_encoding).decode(target_encoding)
            except Exception:
                continue
            if repaired and repaired != text and repaired not in candidates:
                candidates.append(repaired)
    for source_encoding, target_encoding in (("utf-16be", "utf-16le"), ("utf-16le", "utf-16be")):
        try:
            repaired = text.encode(source_encoding).decode(target_encoding)
        except Exception:
            continue
        if repaired and repaired != text and repaired not in candidates:
            candidates.append(repaired)
    return candidates


@lru_cache(maxsize=8192)
def repair_display_text(text: str | None) -> str | None:
    if text is None:
        return None
    normalized = str(text)
    if not looks_like_mojibake(normalized):
        return normalized

    for candidate in _repair_text_candidates(normalized):
        if _is_plausible_utf16_swap_repair(normalized, candidate):
            return candidate

    best = normalized
    best_score = _text_readability_score(normalized)
    for candidate in _repair_text_candidates(normalized):
        candidate_score = _text_readability_score(candidate)
        if candidate_score > best_score:
            best = candidate
            best_score = candidate_score
    return best


def collect_text_repairs(text: str | None) -> list[str]:
    if text is None:
        return []
    normalized = str(text)
    candidates = []
    for candidate in _repair_text_candidates(normalized):
        if _is_plausible_utf16_swap_repair(normalized, candidate):
            candidates.append(candidate)
            continue
        if _text_readability_score(candidate) >= _text_readability_score(normalized) + 8:
            candidates.append(candidate)
    return candidates


def title_case_tag_value(text: str | None) -> str | None:
    if text is None:
        return None
    normalized = str(text)
    if not normalized.strip():
        return normalized

    def convert_word(match: re.Match[str]) -> str:
        word = match.group(0)
        letters = [char for char in word if char.isalpha()]
        if len(letters) > 1 and all(char.isupper() for char in letters):
            return word
        if len(word) > 1 and any(char.isupper() for char in word[1:]):
            return word
        return word[:1].upper() + word[1:].lower()

    return re.sub(r"[^\W\d_]+(?:['’][^\W\d_]+)?", convert_word, normalized, flags=re.UNICODE)

def safe_int(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, list):
        value = value[0] if value else None
    if value is None:
        return None
    text = str(value).split("/")[0].strip()
    return int(text) if text.lstrip("-").isdigit() else None

def clamp_rating_10(value: int | None) -> int | None:
    if value is None:
        return None
    return max(0, min(10, int(value)))

def format_duration(total_seconds: int) -> str:
    minutes, seconds = divmod(max(total_seconds, 0), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m {seconds:02d}s"
