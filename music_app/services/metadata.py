from __future__ import annotations
from pathlib import Path
import re
try:
    from mutagen import File as MutagenFile
except ImportError:
    MutagenFile = None
try:
    from mutagen.id3 import TXXX, Encoding
except ImportError:
    TXXX = None
    Encoding = None
try:
    from mutagen.easyid3 import EasyID3
except ImportError:
    EasyID3 = None
from music_app.services.utils import safe_int, clamp_rating_10, repair_display_text, title_case_tag_value

NON_ALBUM_EXCEPTION_VALUES = {
    "interview": "Interview",
    "non-album rarity": "Non-album rarity",
    "non album rarity": "Non-album rarity",
}
NON_ALBUM_EXCEPTION_TAG_NAMES = [
    "albumhavenexception",
    "album haven exception",
    "album_haven_exception",
]
FILE_METADATA_SCHEMA_VERSION = 2

if EasyID3 is not None:
    EasyID3.RegisterTXXXKey("albumrating", "Album Rating")
_FULL_TAG_TEXT_ALIASES = {
    "talb": "album",
    "tpe2": "albumartist",
    "tpe1": "artist",
    "tit2": "title",
    "tcon": "genre",
    "tdrc": "date",
    "tdor": "originaldate",
    "trck": "tracknumber",
    "tpos": "discnumber",
    "tit3": "version",
    "tsst": "discsubtitle",
    "tso2": "albumartistsort",
    "\xa9alb": "album",
    "aart": "albumartist",
    "\xa9art": "artist",
    "\xa9nam": "title",
    "\xa9gen": "genre",
    "\xa9day": "date",
    "soaa": "albumartistsort",
}
_FULL_TAG_PAIR_ALIASES = {
    "trkn": "tracknumber",
    "disk": "discnumber",
}


def file_metadata_schema_is_current(entry: object) -> bool:
    if not isinstance(entry, dict):
        return False
    value = entry.get("metadata_schema_version")
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and value == FILE_METADATA_SCHEMA_VERSION
        and "release_date" in entry
    )


def normalize_exception_value(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return NON_ALBUM_EXCEPTION_VALUES.get(text.casefold(), text)

def _decode_ape_text(value: bytes) -> str:
    for encoding in ("utf-8", "latin-1"):
        try:
            return value.decode(encoding, errors="replace").replace("\x00", "; ").strip()
        except Exception:
            continue
    return ""


def read_apev2_tags(path: Path) -> dict[str, object]:
    try:
        with path.open("rb") as handle:
            handle.seek(0, 2)
            file_size = handle.tell()
            read_size = min(file_size, 65536)
            handle.seek(file_size - read_size)
            tail = handle.read(read_size)

        footer_index = tail.rfind(b"APETAGEX")
        if footer_index < 0 or footer_index + 32 > len(tail):
            return {}

        footer = tail[footer_index:footer_index + 32]
        tag_size = int.from_bytes(footer[12:16], "little", signed=False)
        item_count = int.from_bytes(footer[16:20], "little", signed=False)
        if tag_size < 32 or item_count <= 0:
            return {}

        tag_start = footer_index - tag_size + 32
        if tag_start < 0:
            return {}

        tags: dict[str, object] = {}
        position = tag_start
        for _ in range(item_count):
            if position + 8 > footer_index:
                break
            value_size = int.from_bytes(tail[position:position + 4], "little", signed=False)
            position += 8

            key_start = position
            while position < footer_index and tail[position] != 0:
                position += 1
            if position >= footer_index:
                break
            key = tail[key_start:position].decode("ascii", errors="ignore").strip().lower()
            position += 1

            if not key or position + value_size > len(tail):
                break
            value = _decode_ape_text(tail[position:position + value_size])
            position += value_size
            if value:
                tags[key] = value
        return tags
    except Exception:
        return {}


def _full_tag_aliases(tags: dict[str, object]) -> dict[str, object]:
    aliases: dict[str, object] = {}
    for source_key, target_key in _FULL_TAG_TEXT_ALIASES.items():
        value = tags.get(source_key)
        if value is not None:
            aliases[target_key] = value
    for source_key, target_key in _FULL_TAG_PAIR_ALIASES.items():
        value = tags.get(source_key)
        values = value if isinstance(value, list) else [value]
        normalized_values: list[str] = []
        for item in values:
            if not isinstance(item, tuple) or not item:
                continue
            number = safe_int(item[0])
            total = safe_int(item[1]) if len(item) > 1 else None
            if number is None:
                continue
            normalized_values.append(f"{number}/{total}" if total else str(number))
        if normalized_values:
            aliases[target_key] = normalized_values
    return aliases


def read_tags(path: Path) -> dict[str, object]:
    if MutagenFile is None:
        return read_apev2_tags(path)
    try:
        data: dict[str, object] = {}
        audio_full = MutagenFile(path)
        if audio_full is not None and getattr(audio_full, "tags", None):
            for key, value in audio_full.tags.items():
                data[str(key).lower()] = value
            for key, value in _full_tag_aliases(data).items():
                data.setdefault(key, value)
        if (
            audio_full is not None
            and getattr(audio_full, "info", None)
            and getattr(audio_full.info, "length", None)
        ):
            data["duration_seconds"] = int(audio_full.info.length)
        data.update(read_apev2_tags(path))
        return data
    except Exception:
        return read_apev2_tags(path)

def first_tag(tags: dict[str, object], keys: list[str]) -> str | None:
    for key in keys:
        value = tags.get(key)
        if isinstance(value, list) and value:
            item = value[0]
            if isinstance(item, bytes):
                try:
                    return item.decode("utf-8", errors="ignore").strip()
                except Exception:
                    return str(item).strip()
            return str(item).strip()
        if isinstance(value, bytes):
            try:
                return value.decode("utf-8", errors="ignore").strip()
            except Exception:
                return str(value).strip()
        if isinstance(value, str):
            return value.strip()
        text_values = getattr(value, "text", None)
        if isinstance(text_values, (list, tuple)):
            for item in text_values:
                text = str(item).strip()
                if text:
                    return text
            continue
        if text_values is not None:
            text = str(text_values).strip()
            if text:
                return text
        if value is not None and not isinstance(value, (dict, tuple)):
            text = str(value).strip()
            if text:
                return text
    return None


def first_custom_tag(tags: dict[str, object], logical_names: list[str]) -> str | None:
    wanted = {name.strip().lower() for name in logical_names if str(name).strip()}
    for key, value in tags.items():
        raw_key = str(key).strip().lower()
        normalized = raw_key.replace('_', ' ').replace('-', ' ').strip()
        candidates = {raw_key, normalized}
        if ':' in raw_key:
            prefix, suffix = raw_key.split(':', 1)
            candidates.add(suffix.strip())
            candidates.add(suffix.replace('_', ' ').replace('-', ' ').strip())
        if not (candidates & wanted):
            continue

        if isinstance(value, list) and value:
            item = value[0]
        else:
            item = value

        if isinstance(item, bytes):
            try:
                return item.decode('utf-8', errors='ignore').strip() or None
            except Exception:
                return str(item).strip() or None
        return str(item).strip() or None
    return None

def extract_year(tags: dict[str, object]) -> int | None:
    for key in ["date", "year", "originaldate", "tdrc", "tyer", "tdor", "tory"]:
        raw = first_tag(tags, [key])
        if raw:
            digits = "".join(ch for ch in raw if ch.isdigit() or ch == "-")
            year_text = digits[:4]
            if year_text.isdigit():
                return int(year_text)
    return None


def extract_release_date(tags: dict[str, object]) -> str | None:
    for key in ["date", "originaldate", "tdrc", "tdor", "year", "tyer", "tory"]:
        raw = first_tag(tags, [key])
        if not raw:
            continue
        match = re.search(r"(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?", raw)
        if not match:
            continue
        year = match.group(1)
        month = match.group(2)
        day = match.group(3)
        if month and day:
            return f"{year}-{month.zfill(2)}-{day.zfill(2)}"
        if month:
            return f"{year}-{month.zfill(2)}"
        return year
    return None

def _extract_digits_rating(raw: object) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, list):
        if not raw:
            return None
        raw = raw[0]
    if isinstance(raw, bool):
        return None
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8", errors="ignore")
        except Exception:
            raw = str(raw)
    text = str(raw).strip()
    fraction_match = re.fullmatch(r"(\d+)\s*/\s*10", text)
    labeled_match = re.fullmatch(r"rating\s*[:=]\s*(\d+)", text, flags=re.IGNORECASE)
    if fraction_match:
        value = int(fraction_match.group(1))
        return value if 1 <= value <= 10 else None
    if labeled_match:
        value = int(labeled_match.group(1))
        return value if 1 <= value <= 10 else None
    if not re.fullmatch(r"\d+", text):
        return None
    value = int(text)
    if 1 <= value <= 10:
        return value
    if 10 < value <= 100:
        value = round(value / 10)
    elif 100 < value <= 255:
        value = round(value / 25.5)
    else:
        return None
    return value if 1 <= value <= 10 else None

def _extract_from_popm(popm_value: object) -> int | None:
    if popm_value is None:
        return None
    items = popm_value if isinstance(popm_value, list) else [popm_value]
    for item in items:
        rating_attr = getattr(item, "rating", None)
        if rating_attr is not None:
            return clamp_rating_10(round(int(rating_attr) / 25.5))
        text = str(item)
        match = re.search(r"rating\s*=\s*(\d+)", text, flags=re.IGNORECASE)
        if match:
            return clamp_rating_10(round(int(match.group(1)) / 25.5))
        nums = [int(x) for x in re.findall(r"\d+", text)]
        plausible = [n for n in nums if 0 <= n <= 255]
        if plausible:
            return clamp_rating_10(round(max(plausible) / 25.5))
    return None

def extract_album_rating(tags: dict[str, object]) -> int | None:
    direct_candidates = [
        "album rating", "albumrating", "album_rating", "album rate", "rating",
        "wm/albumrating", "albumscore", "score", "rate", "rtng",
        "----:com.apple.itunes:album rating", "----:com.apple.itunes:albumrating",
        "txxx:album rating", "txxx:albumrating", "txxx:rating", "txxx:album_rating", "txxx:album rate",
    ]
    for key in direct_candidates:
        if key in tags:
            value = _extract_digits_rating(tags.get(key))
            if value is not None:
                return value
    for key, value in tags.items():
        normalized = str(key).strip().lower()
        if "album" in normalized and "rating" in normalized:
            extracted = _extract_digits_rating(value)
            if extracted is not None:
                return extracted
    for key in ["popm", "popm:"]:
        if key in tags:
            extracted = _extract_from_popm(tags.get(key))
            if extracted is not None:
                return extracted
    return None


def build_text_repairs_for_entry(entry: dict[str, object]) -> dict[str, str]:
    repairs: dict[str, str] = {}
    for field in ("album", "album_artist", "artist", "title"):
        raw_value = entry.get(field)
        if raw_value is None:
            continue
        raw_text = str(raw_value)
        repaired = repair_display_text(raw_text)
        if repaired and repaired != raw_text:
            repaired = title_case_tag_value(repaired)
            repairs[field] = repaired
    return repairs


def apply_text_repairs_to_file(path: Path, repairs: dict[str, str]) -> tuple[bool, list[str]]:
    if MutagenFile is None or not repairs:
        return False, []

    audio = MutagenFile(path, easy=True)
    if audio is None:
        return False, []

    if getattr(audio, "tags", None) is None:
        try:
            audio.add_tags()
        except Exception:
            pass

    tag_map = {
        "album": "album",
        "album_artist": "albumartist",
        "artist": "artist",
        "title": "title",
        "genre": "genre",
        "year": "date",
        "track_number": "tracknumber",
        "disc_number": "discnumber",
        "edition": "version",
        "album_rating": "albumrating",
    }

    changed_fields: list[str] = []
    requested_standard_fields: list[str] = []
    standard_fields_changed = False
    for field, value in repairs.items():
        if field == "exception_type":
            continue
        tag_name = tag_map.get(field)
        if not tag_name:
            continue
        expected_value = str(value or "").strip()
        requested_standard_fields.append(field)
        try:
            existing = audio.get(tag_name, [])
            existing_value = str(existing[0]).strip() if existing else ""
            if existing_value == expected_value:
                continue
            if expected_value:
                audio[tag_name] = [expected_value]
            else:
                try:
                    del audio[tag_name]
                except KeyError:
                    pass
            standard_fields_changed = True
        except Exception as exc:
            raise RuntimeError(
                f"Could not assign {field} tag for {path}: {exc}"
            ) from exc

    if standard_fields_changed:
        try:
            audio.save()
        except Exception as exc:
            raise RuntimeError(f"Could not save tags for {path}: {exc}") from exc

    if requested_standard_fields:
        try:
            verified_audio = MutagenFile(path, easy=True)
        except Exception as exc:
            raise RuntimeError(f"Could not reopen tags for {path}: {exc}") from exc
        if verified_audio is None:
            raise RuntimeError(f"Could not reopen tags for {path}")
        mismatches: list[str] = []
        for field in requested_standard_fields:
            tag_name = tag_map[field]
            expected_value = str(repairs.get(field) or "").strip()
            try:
                actual = verified_audio.get(tag_name, [])
                actual_value = str(actual[0]).strip() if actual else ""
            except Exception as exc:
                raise RuntimeError(
                    f"Could not read back {field} tag for {path}: {exc}"
                ) from exc
            if actual_value != expected_value:
                mismatches.append(
                    f"{field} expected {expected_value!r}, got {actual_value!r}"
                )
        if mismatches:
            raise RuntimeError(
                f"Tag verification failed for {path}: " + "; ".join(mismatches)
            )
        changed_fields.extend(requested_standard_fields)

    exception_value = normalize_exception_value(repairs.get("exception_type"))
    if "exception_type" in repairs:
        try:
            audio_full = MutagenFile(path)
            if audio_full is not None:
                tags = getattr(audio_full, "tags", None)
                if tags is None and hasattr(audio_full, "add_tags"):
                    try:
                        audio_full.add_tags()
                        tags = getattr(audio_full, "tags", None)
                    except Exception:
                        tags = getattr(audio_full, "tags", None)
                exception_changed = False
                if tags is not None:
                    if TXXX is not None and tags.__class__.__module__.startswith("mutagen.id3"):
                        existing = tags.getall("TXXX:AlbumHavenException") if hasattr(tags, "getall") else []
                        existing_value = ""
                        if existing:
                            existing_text = getattr(existing[0], "text", None) or []
                            existing_value = str(existing_text[0]).strip() if existing_text else ""
                        if existing_value != exception_value:
                            if hasattr(tags, "delall"):
                                tags.delall("TXXX:AlbumHavenException")
                            if exception_value:
                                tags.add(TXXX(encoding=Encoding.UTF8 if Encoding is not None else 3, desc="AlbumHavenException", text=[exception_value]))
                            exception_changed = True
                    else:
                        key_name = "ALBUMHAVENEXCEPTION"
                        current_values = audio_full.tags.get(key_name, []) if getattr(audio_full, "tags", None) is not None else []
                        current_value = str(current_values[0]).strip() if current_values else ""
                        if current_value != exception_value:
                            if exception_value:
                                audio_full.tags[key_name] = [exception_value]
                            else:
                                try:
                                    del audio_full.tags[key_name]
                                except Exception:
                                    pass
                            exception_changed = True
                if exception_changed:
                    audio_full.save()
                    changed_fields.append("exception_type")
        except Exception as exc:
            raise RuntimeError(
                f"Could not save exception_type tag for {path}: {exc}"
            ) from exc

    if not changed_fields:
        return False, []

    return True, changed_fields


def read_editable_tag_values(path: Path, fields: set[str]) -> dict[str, str]:
    """Read exact physical Edit Tags values without display fallbacks."""
    if MutagenFile is None:
        raise RuntimeError("Mutagen is required to read editable tags.")
    tag_map = {
        "album": "album",
        "album_artist": "albumartist",
        "artist": "artist",
        "title": "title",
        "genre": "genre",
        "year": "date",
        "track_number": "tracknumber",
        "disc_number": "discnumber",
        "edition": "version",
        "album_rating": "albumrating",
    }
    requested_fields = {str(field) for field in fields}
    unsupported = requested_fields.difference(tag_map)
    if unsupported:
        raise ValueError(
            "Unsupported editable physical fields: " + ", ".join(sorted(unsupported))
        )
    try:
        audio = MutagenFile(path, easy=True)
    except Exception as exc:
        raise RuntimeError(f"Could not open tags for {path}: {exc}") from exc
    if audio is None:
        raise RuntimeError(f"Could not open tags for {path}")
    values: dict[str, str] = {}
    for field in requested_fields:
        try:
            raw_values = audio.get(tag_map[field], [])
            values[field] = str(raw_values[0]).strip() if raw_values else ""
        except Exception as exc:
            raise RuntimeError(f"Could not read {field} tag for {path}: {exc}") from exc
    return values

def read_metadata_for_file(path: Path) -> dict[str, object]:
    tags = read_tags(path)
    stat = path.stat()
    album_name = first_tag(tags, ["album", "talb"]) or ""
    track_artist = first_tag(tags, ["artist", "artists", "albumartist", "tpe1", "tpe2"])
    album_artist = first_tag(tags, ["albumartist", "album artist", "albumartistsort", "wm/albumartist", "tpe2", "tpe1", "artist"]) or track_artist or "Unknown Artist"
    track_artist = track_artist or album_artist
    track_title = first_tag(tags, ["title", "tit2"]) or path.stem
    genre = first_tag(tags, ["genre", "tcon", "\xa9gen"])
    track_number = safe_int(first_tag(tags, ["tracknumber", "track number", "track", "trck"]))
    disc_number_raw = first_tag(tags, ["discnumber", "disc number", "tpos"]) or first_custom_tag(tags, ["discnumber", "disc number", "tpos"])
    disc_number = safe_int(disc_number_raw)
    duration_seconds = safe_int(tags.get("duration_seconds"))
    year = extract_year(tags)
    release_date = extract_release_date(tags)
    edition = first_tag(tags, ["edition", "album edition", "albumedition", "version", "subtitle", "discsubtitle"]) or first_custom_tag(tags, ["edition", "album edition", "albumedition"])
    album_rating = extract_album_rating(tags)
    exception_type = normalize_exception_value(first_custom_tag(tags, NON_ALBUM_EXCEPTION_TAG_NAMES))
    return {
        "path": str(path), "mtime": stat.st_mtime, "size": stat.st_size,
        "album": album_name, "album_artist": album_artist, "title": track_title,
        "genre": genre,
        "track_number": track_number, "disc_number": disc_number, "disc_number_raw": disc_number_raw, "artist": track_artist,
        "duration_seconds": duration_seconds, "year": year, "release_date": release_date, "edition": edition, "album_rating": album_rating,
        "exception_type": exception_type or None,
        "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
    }
