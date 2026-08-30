from __future__ import annotations

from pathlib import Path
import re

from music_app.routes.api_rules_helpers import (
    albums_share_any_artist,
    looks_like_collaboration_name,
    text_problem_reason,
    year_problem_reason,
)
from music_app.services.covers import image_dimensions
from music_app.services.library import album_separate_release_key
from music_app.services.metadata import build_text_repairs_for_entry
from music_app.services.problematic_albums import (
    build_problematic_album_detail_payload as _build_problematic_album_detail_payload,
    build_problematic_albums_payload as _build_problematic_albums_payload,
    find_problematic_album_by_track_paths as _service_find_problematic_album_by_track_paths,
)
from music_app.services.utils import title_case_tag_value

_ALBUM_DISC_MARKER_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:cd|disc|disk)\s*[-_.]?\s*(?P<number>\d{1,2})(?![A-Za-z0-9])",
    re.IGNORECASE,
)


def _is_shared_artist_album(album) -> bool:
    if not getattr(album, "is_compilation", False):
        return False
    artist_names = [str(artist or "").strip() for artist in getattr(album, "artists", []) if str(artist or "").strip()]
    if len(artist_names) < 2:
        return False
    return bool(
        albums_share_any_artist(
            artist_names,
            [str(getattr(album, "album_artist", "") or "").strip()],
        )
    )


def _is_ignored_problem(ignored_row_keys: set[str], path: str, field_name: str) -> bool:
    return f"{path}::{field_name}" in ignored_row_keys


def _all_track_text_problems_ignored(
    album,
    file_cache: dict[str, dict[str, object]],
    ignored_row_keys: set[str],
    field_name: str,
    label: str,
    target_reason: str,
) -> bool:
    found_reason = False
    for track in getattr(album, "tracks", []) or []:
        path = str(getattr(track, "path", "") or "")
        if not path:
            continue
        entry = file_cache.get(path)
        if not isinstance(entry, dict):
            continue
        reason = text_problem_reason(label, str(entry.get(field_name) or ""), detect_encoding=True)
        if reason != target_reason:
            continue
        found_reason = True
        if not _is_ignored_problem(ignored_row_keys, path, field_name):
            return False
    return found_reason


def _all_track_year_problems_ignored(
    album,
    file_cache: dict[str, dict[str, object]],
    ignored_row_keys: set[str],
    target_reason: str,
) -> bool:
    found_reason = False
    for track in getattr(album, "tracks", []) or []:
        path = str(getattr(track, "path", "") or "")
        if not path:
            continue
        entry = file_cache.get(path)
        if not isinstance(entry, dict):
            continue
        reason = year_problem_reason(entry.get("year"))
        if reason != target_reason:
            continue
        found_reason = True
        if not _is_ignored_problem(ignored_row_keys, path, "year"):
            return False
    return found_reason


def _separate_release_candidate(
    album,
    file_cache: dict[str, dict[str, object]],
    separate_release_keys: set[str],
) -> dict[str, object] | None:
    entries: list[dict[str, object]] = []
    for track in getattr(album, "tracks", []) or []:
        entry = file_cache.get(str(getattr(track, "path", "")))
        if isinstance(entry, dict):
            entries.append(entry)
    if not entries:
        return None

    album_names = {
        str(entry.get("album") or "").strip().casefold()
        for entry in entries
        if str(entry.get("album") or "").strip()
    }
    valid_years = sorted({int(entry.get("year")) for entry in entries if str(entry.get("year") or "").strip().isdigit()})
    folders = {str(Path(str(entry.get("path") or "")).parent) for entry in entries if str(entry.get("path") or "")}
    base_key = album_separate_release_key(
        str(getattr(album, "album_artist", "") or ""),
        str(getattr(album, "name", "") or ""),
        getattr(album, "edition", None),
    )
    if base_key in separate_release_keys:
        return None
    if len(album_names) == 1 and len(valid_years) > 1 and len(folders) > 1:
        return {
            "key": base_key,
            "years": valid_years,
            "folder_count": len(folders),
        }
    return None


def _album_tag_contains_disc_marker(value: object) -> bool:
    return bool(_ALBUM_DISC_MARKER_RE.search(str(value or "")))


def _clean_album_disc_marker(album_name: str) -> tuple[str, int] | None:
    text = str(album_name or "").strip()
    match = _ALBUM_DISC_MARKER_RE.search(text)
    if not text or not match:
        return None
    try:
        disc_number = int(match.group("number"))
    except Exception:
        return None
    if disc_number <= 0:
        return None

    cleaned = f"{text[:match.start()]}{text[match.end():]}"
    cleaned = re.sub(r"\s*[\(\[\{]\s*[\)\]\}]\s*", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    cleaned = re.sub(r"^[\s\-_.:|/]+", "", cleaned).strip()
    cleaned = re.sub(r"[\s\-_.:|/]+$", "", cleaned).strip()
    cleaned = re.sub(r"\s+([)\]\}])", r"\1", cleaned)
    cleaned = re.sub(r"([(\[\{])\s+", r"\1", cleaned)

    if not cleaned or cleaned == text:
        return None
    return cleaned, disc_number


def _build_disc_marker_repairs_for_entry(entry: dict[str, object]) -> dict[str, str]:
    parsed = _clean_album_disc_marker(str(entry.get("album") or ""))
    if not parsed:
        return {}
    cleaned_album, disc_number = parsed
    repairs: dict[str, str] = {"album": title_case_tag_value(cleaned_album) or cleaned_album}
    if str(entry.get("disc_number") or "").strip() != str(disc_number):
        repairs["disc_number"] = str(disc_number)
    return repairs


def _build_artist_alias_repairs_for_entry(
    entry: dict[str, object],
    alias_to_canonical: dict[str, str] | None = None,
) -> dict[str, str]:
    alias_to_canonical = alias_to_canonical or {}
    repairs: dict[str, str] = {}
    raw_album_artist = str(entry.get("album_artist") or "").strip()
    if not raw_album_artist:
        return repairs
    if looks_like_collaboration_name(raw_album_artist):
        return repairs
    canonical_artist = str(alias_to_canonical.get(raw_album_artist, raw_album_artist) or "").strip()
    if looks_like_collaboration_name(canonical_artist):
        return repairs
    if canonical_artist and canonical_artist != raw_album_artist:
        repairs["album_artist"] = canonical_artist
    return repairs


def _artist_alias_problem_reason(
    value: object,
    alias_to_canonical: dict[str, str] | None = None,
) -> str | None:
    raw_value = str(value or "").strip()
    if not raw_value:
        return None
    if looks_like_collaboration_name(raw_value):
        return None
    alias_to_canonical = alias_to_canonical or {}
    canonical_value = str(alias_to_canonical.get(raw_value, raw_value) or "").strip()
    if looks_like_collaboration_name(canonical_value):
        return None
    if not canonical_value or canonical_value == raw_value:
        return None
    if canonical_value.casefold() == raw_value.casefold():
        return "Artist name casing differs from canonical"
    return "Artist name variant differs from canonical"


def _collect_track_level_problem_reasons(
    album,
    file_cache: dict[str, dict[str, object]],
    ignored_row_keys: set[str],
    alias_to_canonical: dict[str, str] | None = None,
) -> list[str]:
    reasons: list[str] = []
    track_entries: list[dict[str, object]] = []

    for track in getattr(album, "tracks", []) or []:
        entry = file_cache.get(str(getattr(track, "path", "")))
        if isinstance(entry, dict):
            track_entries.append(entry)

    if not track_entries:
        return reasons

    album_tag_values = {str(entry.get("album") or "").strip() for entry in track_entries}
    album_artist_values = {str(entry.get("album_artist") or "").strip() for entry in track_entries}
    valid_years = {int(entry.get("year")) for entry in track_entries if str(entry.get("year") or "").strip().isdigit()}
    raw_year_values = {str(entry.get("year") or "").strip() for entry in track_entries}
    ignore_album_artist_mismatch = _is_shared_artist_album(album)

    if len({value.casefold() for value in album_tag_values if value}) > 1:
        reasons.append("Album name mismatch")
    if not ignore_album_artist_mismatch and len({value.casefold() for value in album_artist_values if value}) > 1:
        reasons.append("Album artist mismatch")
    if len(valid_years) > 1:
        reasons.append("Year mismatch")
    elif len({value for value in raw_year_values if value}) > 1 and not valid_years:
        reasons.append("Inconsistent year")

    for entry in track_entries:
        album_name = str(entry.get("album") or "")
        album_artist = str(entry.get("album_artist") or "")
        track_artist = str(entry.get("artist") or "")
        year = entry.get("year")
        track_number = entry.get("track_number")

        if _album_tag_contains_disc_marker(album_name) and "Disc marker in album name" not in reasons:
            reasons.append("Disc marker in album name")

        artist_alias_reason = _artist_alias_problem_reason(album_artist, alias_to_canonical)
        if artist_alias_reason:
            row_key = f"{str(entry.get('path') or '')}::album_artist"
            if row_key not in ignored_row_keys and artist_alias_reason not in reasons:
                reasons.append(artist_alias_reason)

        tag_checks = [
            ("Album", album_name),
            ("Track title", str(entry.get("title") or "")),
            ("Track artist", track_artist),
        ]
        if text_problem_reason("Track artist", track_artist, detect_encoding=False):
            tag_checks.append(("Album artist", album_artist))

        for label, value in tag_checks:
            field_name = {
                "Album": "album",
                "Track title": "title",
                "Album artist": "album_artist",
                "Track artist": "artist",
            }[label]
            row_key = f"{str(entry.get('path') or '')}::{field_name}"
            reason = None if row_key in ignored_row_keys else text_problem_reason(label, value, detect_encoding=True)
            if reason and reason not in reasons:
                reasons.append(reason)

        year_reason = None if _is_ignored_problem(ignored_row_keys, str(entry.get("path") or ""), "year") else year_problem_reason(year)
        if year_reason and year_reason not in reasons:
            reasons.append(year_reason)

        if track_number in (None, ""):
            if "Missing track number" not in reasons:
                reasons.append("Missing track number")
        else:
            try:
                if int(track_number) <= 0 and "Invalid track number" not in reasons:
                    reasons.append("Invalid track number")
            except Exception:
                if "Invalid track number" not in reasons:
                    reasons.append("Invalid track number")

    return reasons


def _collect_track_problem_rows(
    album,
    file_cache: dict[str, dict[str, object]],
    ignored_row_keys: set[str],
    alias_to_canonical: dict[str, str] | None = None,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    track_entries: list[dict[str, object]] = []

    for track in getattr(album, "tracks", []) or []:
        entry = file_cache.get(str(getattr(track, "path", "")))
        if isinstance(entry, dict):
            track_entries.append(entry)

    album_tag_values = {
        str(entry.get("album") or "").strip().casefold()
        for entry in track_entries
        if str(entry.get("album") or "").strip()
    }
    album_artist_values = {
        str(entry.get("album_artist") or "").strip().casefold()
        for entry in track_entries
        if str(entry.get("album_artist") or "").strip()
    }
    valid_years = {int(entry.get("year")) for entry in track_entries if str(entry.get("year") or "").strip().isdigit()}
    raw_year_values = {str(entry.get("year") or "").strip() for entry in track_entries if str(entry.get("year") or "").strip()}
    ignore_album_artist_mismatch = _is_shared_artist_album(album)

    mismatch_album = len(album_tag_values) > 1
    mismatch_artist = (len(album_artist_values) > 1) and not ignore_album_artist_mismatch
    mismatch_year = len(valid_years) > 1 or (len(raw_year_values) > 1 and not valid_years)

    for entry in track_entries:
        path = str(entry.get("path") or "")
        if not path:
            continue
        reasons: list[str] = []
        ignorable_reasons: list[dict[str, str]] = []

        def add_reason(reason: str | None) -> None:
            if reason and reason not in reasons:
                reasons.append(reason)

        def add_ignorable_reason(reason: str | None, field_name: str) -> None:
            if not reason or reason not in {"Undecoded characters", "Missing year"}:
                return
            row_key = f"{path}::{field_name}"
            if row_key in ignored_row_keys:
                return
            ignorable_reasons.append({
                "reason": reason,
                "field": field_name,
                "row_key": row_key,
            })

        if mismatch_album or mismatch_artist or mismatch_year:
            if mismatch_album:
                add_reason("Album name mismatch")
            if mismatch_artist:
                add_reason("Album artist mismatch")
            if mismatch_year:
                year_value = str(entry.get("year") or "").strip()
                add_reason(f"Year mismatch: {year_value or 'Missing'}")

        if _album_tag_contains_disc_marker(entry.get("album")):
            add_reason("Disc marker in album name")

        artist_alias_reason = _artist_alias_problem_reason(entry.get("album_artist"), alias_to_canonical)
        if artist_alias_reason and not _is_ignored_problem(ignored_row_keys, path, "album_artist"):
            add_reason(artist_alias_reason)

        tag_checks = [
            ("album", "Album"),
            ("title", "Track title"),
            ("artist", "Track artist"),
        ]
        if text_problem_reason("Track artist", str(entry.get("artist") or ""), detect_encoding=False):
            tag_checks.append(("album_artist", "Album artist"))

        for field_name, label in tag_checks:
            row_key = f"{path}::{field_name}"
            reason = None if row_key in ignored_row_keys else text_problem_reason(label, str(entry.get(field_name) or ""), detect_encoding=True)
            add_reason(reason)
            add_ignorable_reason(reason, field_name)

        year_reason = None if _is_ignored_problem(ignored_row_keys, path, "year") else year_problem_reason(entry.get("year"))
        add_reason(year_reason)
        add_ignorable_reason(year_reason, "year")

        track_number = entry.get("track_number")
        if track_number in (None, ""):
            add_reason("Missing track number")
        else:
            try:
                if int(track_number) <= 0:
                    add_reason("Invalid track number")
            except Exception:
                add_reason("Invalid track number")

        if reasons:
            rows.append({
                "path": path,
                "filename": Path(path).name,
                "file_type": Path(path).suffix.lstrip(".").upper(),
                "reasons": reasons,
                "ignorable_reasons": ignorable_reasons,
            })

    return sorted(rows, key=lambda row: str(row.get("filename") or "").casefold())


def _build_encoding_repair_preview(
    album,
    file_cache: dict[str, dict[str, object]],
    ignored_row_keys: set[str],
    alias_to_canonical: dict[str, str] | None = None,
    include_preview_rows: bool = True,
) -> dict[str, object]:
    preview_rows: list[dict[str, object]] = []
    raw_album_name = ""
    raw_album_artist = ""
    has_repairs = False

    for track in getattr(album, "tracks", []) or []:
        track_path = str(getattr(track, "path", ""))
        entry = file_cache.get(track_path)
        if not isinstance(entry, dict):
            continue

        if not raw_album_name:
            raw_album_name = str(entry.get("album") or "").strip()
        if not raw_album_artist:
            raw_album_artist = str(entry.get("album_artist") or "").strip()

        repairs = build_text_repairs_for_entry(entry)
        repairs.update(_build_artist_alias_repairs_for_entry(entry, alias_to_canonical))
        for field, repaired in repairs.items():
            original = str(entry.get(field) or "").strip()
            if not original:
                continue
            row_key = f"{track_path}::{field}"
            if row_key in ignored_row_keys:
                continue
            has_repairs = True
            if not include_preview_rows:
                break
            preview_rows.append({
                "row_key": row_key,
                "path": track_path,
                "track_title": str(entry.get("title") or "").strip() or Path(track_path).stem,
                "field": field,
                "original": original,
                "repaired": repaired,
            })
        if has_repairs and not include_preview_rows:
            break

        disc_marker_repairs = _build_disc_marker_repairs_for_entry(entry)
        if disc_marker_repairs:
            row_key = f"{track_path}::album_disc_marker"
            if row_key not in ignored_row_keys:
                has_repairs = True
                if not include_preview_rows:
                    break
                preview_rows.append({
                    "row_key": row_key,
                    "path": track_path,
                    "track_title": str(entry.get("title") or "").strip() or Path(track_path).stem,
                    "field": "album_disc_marker",
                    "original": str(entry.get("album") or "").strip(),
                    "repaired": f"Album: {disc_marker_repairs.get('album', '')}; Disc Number: {disc_marker_repairs.get('disc_number') or entry.get('disc_number') or ''}",
                })

    if include_preview_rows:
        preview_rows.sort(
            key=lambda item: (
                str(item.get("track_title") or "").casefold(),
                str(item.get("field") or ""),
                str(item.get("original") or "").casefold(),
            )
        )
    return {
        "has_repairs": has_repairs if not include_preview_rows else bool(preview_rows),
        "raw_name": raw_album_name or getattr(album, "name", ""),
        "raw_album_artist": raw_album_artist or getattr(album, "album_artist", ""),
        "preview_rows": preview_rows,
    }


def build_problematic_albums_payload(
    *,
    config=None,
    library_state: dict[str, object] | None = None,
    logger=None,
) -> dict[str, object]:
    return _build_problematic_albums_payload(
        text_problem_reason=text_problem_reason,
        artist_alias_problem_reason=_artist_alias_problem_reason,
        year_problem_reason=year_problem_reason,
        all_track_text_problems_ignored=_all_track_text_problems_ignored,
        all_track_year_problems_ignored=_all_track_year_problems_ignored,
        collect_track_level_problem_reasons=_collect_track_level_problem_reasons,
        build_encoding_repair_preview=_build_encoding_repair_preview,
        collect_track_problem_rows=_collect_track_problem_rows,
        separate_release_candidate=_separate_release_candidate,
        image_dimensions=image_dimensions,
        config=config,
        library_state=library_state,
        logger=logger,
    )


def build_problematic_album_detail_payload(
    album_key: str,
    *,
    config=None,
    library_state: dict[str, object] | None = None,
    logger=None,
) -> dict[str, object] | None:
    return _build_problematic_album_detail_payload(
        album_key,
        text_problem_reason=text_problem_reason,
        artist_alias_problem_reason=_artist_alias_problem_reason,
        year_problem_reason=year_problem_reason,
        all_track_text_problems_ignored=_all_track_text_problems_ignored,
        all_track_year_problems_ignored=_all_track_year_problems_ignored,
        collect_track_level_problem_reasons=_collect_track_level_problem_reasons,
        build_encoding_repair_preview=_build_encoding_repair_preview,
        collect_track_problem_rows=_collect_track_problem_rows,
        separate_release_candidate=_separate_release_candidate,
        image_dimensions=image_dimensions,
        config=config,
        library_state=library_state,
        logger=logger,
    )


def find_problematic_album_by_track_paths(
    track_paths: set[str],
    *,
    config=None,
    library_state: dict[str, object] | None = None,
    logger=None,
) -> dict[str, object] | None:
    return _service_find_problematic_album_by_track_paths(
        track_paths,
        build_problematic_albums_payload=lambda: build_problematic_albums_payload(
            config=config,
            library_state=library_state,
            logger=logger,
        ),
    )
