"""Read-only, evidence-backed tag proposals and reserved apply validation."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import date

from music_app.routes.api_rules_helpers import looks_like_collaboration_name
from music_app.services.utils import (
    _repair_text_candidates, _text_readability_score,
    _is_plausible_utf16_swap_repair, looks_like_mojibake,
)

_FIELDS = ("album", "album_artist", "artist", "title", "year", "track_number", "disc_number")
_DISC = re.compile(r"(?<![A-Za-z0-9])(?:cd|disc|disk)\s*[-_.]?\s*(?P<number>\d{1,2})(?![A-Za-z0-9])", re.I)


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str).encode()).hexdigest()


def _text(value):
    return "" if value is None else str(value).strip()


def _encoding_correction(original):
    if "�" in original or "?" in original or not looks_like_mojibake(original, require_repair_improvement=False):
        return None
    candidates = set()
    pairs = [(source, target) for source in ("latin-1", "cp1252") for target in ("utf-8", "cp1251")]
    pairs += [("utf-16be", "utf-16le"), ("utf-16le", "utf-16be")]
    for candidate in _repair_text_candidates(original):
        if not candidate or looks_like_mojibake(candidate) or "�" in candidate:
            continue
        utf8_contraction = len(candidate) < len(original) and any(
            _reversible_pair(original, candidate, source, "utf-8") for source in ("latin-1", "cp1252")
        )
        plausible = (_text_readability_score(candidate) >= _text_readability_score(original) + (1 if utf8_contraction else 8)
                     or _is_plausible_utf16_swap_repair(original, candidate))
        if not plausible:
            continue
        for source, target in pairs:
            try:
                if original.encode(source).decode(target) == candidate and candidate.encode(target).decode(source) == original:
                    candidates.add(candidate)
            except (UnicodeError, LookupError):
                continue
    return next(iter(candidates)) if len(candidates) == 1 else None


def _reversible_pair(original, candidate, source, target):
    try:
        return original.encode(source).decode(target) == candidate and candidate.encode(target).decode(source) == original
    except UnicodeError:
        return False


def build_problem_suggestions(path, entry, *, alias_to_canonical=None, verified_metadata=None):
    """Compute proposals; supplied evidence must come from a server-owned adapter."""
    proposals = []

    def add(field, updates, reason, evidence):
        revision = _digest({"path": path, "mtime": entry.get("mtime"), "size": entry.get("size"),
                            "tags": {name: _text(entry.get(name)) for name in updates}})
        original = _text(entry.get("album" if field == "album_disc_marker" else field))
        corrected = (f"Album: {updates['album']}; Disc number: {updates['disc_number']}"
                     if field == "album_disc_marker" else updates[field])
        identity = _digest([path, field, original, updates, revision, evidence])
        proposals.append({"id": identity, "path": path, "field": field, "type": field,
                          "original": original, "corrected": corrected, "updates": updates,
                          "source_revision": revision, "reason": reason})

    aliases = alias_to_canonical or {}
    for field in ("album", "album_artist", "artist", "title"):
        original = _text(entry.get(field))
        if not original:
            continue
        canonical = _text(aliases.get(original)) if field in {"artist", "album_artist"} else ""
        if canonical and canonical != original and not any(looks_like_collaboration_name(value) for value in (original, canonical)):
            reason = "Artist name casing differs from canonical" if original.casefold() == canonical.casefold() else "Artist name variant differs from canonical"
            add(field, {field: canonical}, reason, ["canonical", original, canonical])
            continue
        correction = _encoding_correction(original)
        if correction:
            add(field, {field: correction}, "Encoding problem", ["reversible", original, correction])

    album = _text(entry.get("album"))
    markers = list(_DISC.finditer(album))
    if len(markers) == 1 and not any("album" in row["updates"] for row in proposals):
        match = markers[0]
        number = int(match.group("number"))
        existing = _text(entry.get("disc_number"))
        cleaned = album[:match.start()] + album[match.end():]
        cleaned = re.sub(r"\s*[\(\[\{]\s*[\)\]\}]\s*", " ", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip(" \t-_.:|/")
        if number > 0 and cleaned and existing in {"", "0", str(number)}:
            add("album_disc_marker", {"album": cleaned, "disc_number": number}, "Disc marker in album name", ["disc-marker", album, existing])

    evidence = verified_metadata or {}
    if evidence.get("track_path") == path and evidence.get("source_id"):
        for field in ("year", "track_number"):
            value = (evidence.get("values") or {}).get(field)
            text = _text(value)
            valid = bool(re.fullmatch(r"[1-9]\d*(?:-\d{2}-\d{2})?" if field == "year" else r"[1-9]\d*", text))
            if valid and field == "year" and "-" in text:
                try:
                    date.fromisoformat(text)
                except ValueError:
                    valid = False
            if valid and text != _text(entry.get(field)):
                label = "year" if field == "year" else "track number"
                reason = f"Missing {label}" if not _text(entry.get(field)) else f"Invalid {label}"
                add(field, {field: value}, reason, evidence)
    return proposals


def validate_problem_suggestions(proposal_ids, entries, *, alias_to_canonical=None, read_metadata):
    """Resolve only current-library entries, then verify physical sources under reservation."""
    if not isinstance(proposal_ids, list) or not proposal_ids or any(not isinstance(key, str) for key in proposal_ids) or len(set(proposal_ids)) != len(proposal_ids):
        raise ValueError("Invalid suggestion selection. Refresh and try again.")
    wanted = set(proposal_ids)
    current = {row["id"]: row for path, entry in entries.items() if isinstance(entry, dict)
               for row in build_problem_suggestions(path, entry, alias_to_canonical=alias_to_canonical)
               if row["id"] in wanted}
    if set(current) != wanted:
        raise ValueError("Suggestions changed or are unavailable. Refresh and try again.")
    updates = {}
    for path in dict.fromkeys(current[key]["path"] for key in proposal_ids):
        physical = read_metadata(path)
        fresh = {row["id"]: row for row in build_problem_suggestions(path, physical, alias_to_canonical=alias_to_canonical)}
        for key in proposal_ids:
            if current[key]["path"] != path:
                continue
            if key not in fresh:
                raise ValueError("Tags changed since these suggestions were loaded. Refresh and try again.")
            target = updates.setdefault(path, {})
            for field, value in fresh[key]["updates"].items():
                if field in target and target[field] != value:
                    raise ValueError("Conflicting suggestions. Refresh and try again.")
                target[field] = value
    return updates
