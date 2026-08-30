from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path
import re

from music_app.services.library_roots import load_library_root_settings

SettingsLoader = Callable[[dict[str, object]], dict[str, object]]


_INVALID_WINDOWS_CHARS_RE = re.compile(r'[<>:"/\\|?*]+')
_RESERVED_WINDOWS_NAMES = {
    "con",
    "prn",
    "aux",
    "nul",
    *(f"com{index}" for index in range(1, 10)),
    *(f"lpt{index}" for index in range(1, 10)),
}


@dataclass(frozen=True)
class MovePlan:
    action: str
    target_category: str
    target_root_id: str
    destination_path: str
    destination_folder_name: str
    layout_mode: str | None = None
    reuses_existing_artist_folder: bool = False


def build_move_availability_payload(
    album,
    config: dict[str, object],
    *,
    load_settings: SettingsLoader = load_library_root_settings,
) -> dict[str, object]:
    from music_app.services.library import get_album_duplicate_sources

    source_folder = _resolve_album_source_folder(album)
    source_category = _album_primary_category(album)
    blocked_reasons: list[str] = []
    actions: dict[str, dict[str, object]] = {}

    if source_category != "new_arrivals":
        blocked_reasons.append("Only New Arrivals albums advertise move actions in this slice.")
    if _album_has_invalid_year(album):
        blocked_reasons.append("Missing or invalid year metadata blocks move planning.")
    duplicate_sources = get_album_duplicate_sources(album)
    if duplicate_sources:
        blocked_reasons.append("Duplicate-source albums must be narrowed to one source folder before moving.")
    if source_folder is None and not duplicate_sources:
        blocked_reasons.append("Album tracks do not resolve to one concrete source folder.")
    if _album_spans_multiple_roots(album):
        blocked_reasons.append("Albums that span multiple library roots cannot be moved until the source is narrowed.")

    if not blocked_reasons:
        settings = load_settings(config)
        hoard_plan = _plan_move_to_hoard(album, settings)
        library_plan = _plan_move_to_library(album, settings)
        actions["move_to_hoard"] = _serialize_move_result(hoard_plan)
        actions["move_to_library"] = _serialize_move_result(library_plan)
        if not any(action_payload.get("available") for action_payload in actions.values()):
            blocked_reasons.extend(_collect_action_blocked_reasons(actions))
    else:
        actions["move_to_hoard"] = _serialize_blocked_action("move_to_hoard", "hoard", blocked_reasons)
        actions["move_to_library"] = _serialize_blocked_action("move_to_library", "main_library", blocked_reasons)

    return {
        "source_category": source_category,
        "source_folder": str(source_folder) if source_folder is not None else None,
        "can_move": any(action_payload.get("available") for action_payload in actions.values()),
        "available_actions": [
            action_name
            for action_name, action_payload in actions.items()
            if action_payload.get("available")
        ],
        "blocked_reasons": _collect_action_blocked_reasons(actions) if not any(action_payload.get("available") for action_payload in actions.values()) else [],
        "actions": actions,
    }


def plan_album_move(
    album,
    config: dict[str, object],
    *,
    action: str,
    load_settings: SettingsLoader = load_library_root_settings,
) -> MovePlan | dict[str, object]:
    settings = load_settings(config)
    if action == "move_to_hoard":
        return _plan_move_to_hoard(album, settings)
    if action == "move_to_library":
        return _plan_move_to_library(album, settings)
    return {"blocked_reasons": [f"Unsupported move action: {action}"]}


def _plan_move_to_hoard(album, settings: dict[str, object]) -> MovePlan | dict[str, object]:
    move_policy = settings.get("move_policy") if isinstance(settings, dict) else {}
    target_root_id = str((move_policy or {}).get("move_new_arrivals_to") or "").strip()
    if not target_root_id:
        return {"blocked_reasons": ["Configure a Hoard destination before planning Move to Hoard."]}
    hoard_roots = {
        str(root.get("id") or "").strip(): root
        for root in list(settings.get("hoarding_library_roots") or [])
        if isinstance(root, dict)
    }
    target_root = hoard_roots.get(target_root_id)
    if not isinstance(target_root, dict):
        return {"blocked_reasons": ["The configured Hoard destination no longer matches a saved Hoarding Library root."]}

    root_path = Path(str(target_root.get("path") or "")).resolve(strict=False)
    year = int(getattr(album, "year"))
    arrivals_folder = f"{date.today().year} Arrivals"
    folder_name = _build_root_level_album_folder_name(album, year=year)
    destination = root_path / arrivals_folder / folder_name
    return MovePlan(
        action="move_to_hoard",
        target_category="hoard",
        target_root_id=target_root_id,
        destination_path=str(destination),
        destination_folder_name=folder_name,
    )


def _plan_move_to_library(album, settings: dict[str, object]) -> MovePlan | dict[str, object]:
    main_roots = [
        root for root in list(settings.get("main_library_roots") or [])
        if isinstance(root, dict)
    ]
    if not main_roots:
        return {"blocked_reasons": ["Configure at least one Main Library root before planning Move to Library."]}

    reusable_artist_destination = _find_reusable_artist_destination(main_roots, getattr(album, "album_artist", ""))
    year = int(getattr(album, "year"))
    album_folder_name = _build_artist_album_folder_name(album, year=year)
    if reusable_artist_destination is not None:
        target_root, artist_directory = reusable_artist_destination
        destination = artist_directory / album_folder_name
        return MovePlan(
            action="move_to_library",
            target_category="main_library",
            target_root_id=str(target_root.get("id") or "").strip(),
            destination_path=str(destination),
            destination_folder_name=album_folder_name,
            layout_mode=str(target_root.get("layout_mode") or "").strip() or None,
            reuses_existing_artist_folder=True,
        )

    move_policy = settings.get("move_policy") if isinstance(settings, dict) else {}
    preferred_root_id = str((move_policy or {}).get("preferred_main_write_root") or "").strip()
    target_root = next(
        (
            root for root in main_roots
            if str(root.get("id") or "").strip() == preferred_root_id
        ),
        main_roots[0],
    )
    root_path = Path(str(target_root.get("path") or "")).resolve(strict=False)
    layout_mode = str(target_root.get("layout_mode") or "artist").strip() or "artist"
    artist_folder_name = _sanitize_folder_name(str(getattr(album, "album_artist", "") or "").strip())

    if layout_mode == "artist":
        destination = root_path / artist_folder_name / album_folder_name
    elif layout_mode == "album-at-root":
        folder_name = _build_root_level_album_folder_name(album, year=year)
        destination = root_path / folder_name
        album_folder_name = folder_name
    elif layout_mode == "genre/artist":
        return {
            "blocked_reasons": [
                "The preferred Main Library root requires a broad-genre match before creating a new artist destination.",
            ]
        }
    else:
        return {"blocked_reasons": [f"Unsupported Main Library layout mode: {layout_mode}"]}

    return MovePlan(
        action="move_to_library",
        target_category="main_library",
        target_root_id=str(target_root.get("id") or "").strip(),
        destination_path=str(destination),
        destination_folder_name=album_folder_name,
        layout_mode=layout_mode,
        reuses_existing_artist_folder=False,
    )


def _find_reusable_artist_destination(main_roots: list[dict[str, object]], album_artist: object) -> tuple[dict[str, object], Path] | None:
    artist_folder_name = _sanitize_folder_name(str(album_artist or "").strip())
    if not artist_folder_name:
        return None
    for root in main_roots:
        layout_mode = str(root.get("layout_mode") or "artist").strip() or "artist"
        root_path = Path(str(root.get("path") or "")).resolve(strict=False)
        if layout_mode == "artist":
            artist_directory = _find_child_directory(root_path, artist_folder_name)
            if artist_directory is not None:
                return root, artist_directory
            continue
        if layout_mode == "genre/artist":
            for child in _iter_child_directories(root_path):
                artist_directory = _find_child_directory(child, artist_folder_name)
                if artist_directory is not None:
                    return root, artist_directory
    return None


def _resolve_album_source_folder(album) -> Path | None:
    folders: list[Path] = []
    seen: set[str] = set()
    for track in getattr(album, "tracks", []) or []:
        folder = _resolve_track_album_folder(getattr(track, "path", None))
        if folder is None:
            continue
        folder_key = str(folder).casefold()
        if folder_key in seen:
            continue
        seen.add(folder_key)
        folders.append(folder)
    if len(folders) != 1:
        return None
    return folders[0]


def _resolve_track_album_folder(path_value: object) -> Path | None:
    raw_path = str(path_value or "").strip()
    if not raw_path:
        return None
    path = Path(raw_path)
    parent = path.parent
    normalized_name = " ".join(parent.name.strip().replace("_", " ").replace("-", " ").split()).casefold()
    if any(normalized_name.startswith(prefix) and any(char.isdigit() for char in normalized_name) for prefix in ("cd", "disc", "disk")):
        if parent.parent != parent:
            parent = parent.parent
    return parent


def _album_primary_category(album) -> str | None:
    provenance = getattr(album, "root_provenance", None)
    if isinstance(provenance, dict):
        category = str(provenance.get("primary_category") or "").strip()
        if category:
            return category
    category = str(getattr(album, "library_root_category", "") or "").strip()
    return category or None


def _album_has_invalid_year(album) -> bool:
    year = getattr(album, "year", None)
    if not isinstance(year, int):
        return True
    return year < 1000 or year > 9999


def _album_spans_multiple_roots(album) -> bool:
    provenance = getattr(album, "root_provenance", None)
    if not isinstance(provenance, dict):
        return False
    if bool(provenance.get("is_mixed")):
        return True
    root_ids = [
        str(root_id or "").strip()
        for root_id in list(provenance.get("root_ids") or [])
        if str(root_id or "").strip()
    ]
    return len(root_ids) > 1


def _build_artist_album_folder_name(album, *, year: int) -> str:
    return _sanitize_folder_name(f"{year} - {str(getattr(album, 'name', '') or '').strip()}")


def _build_root_level_album_folder_name(album, *, year: int) -> str:
    artist = str(getattr(album, "album_artist", "") or "").strip()
    name = str(getattr(album, "name", "") or "").strip()
    return _sanitize_folder_name(f"{year} - {artist} - {name}")


def _sanitize_folder_name(value: str) -> str:
    text = _INVALID_WINDOWS_CHARS_RE.sub(" ", str(value or "").strip())
    text = " ".join(text.replace(".", ". ").split()).replace(". ", ".")
    text = text.strip(" .")
    text = re.sub(r"\s+", " ", text)
    if not text:
        return "Unknown"
    if text.casefold() in _RESERVED_WINDOWS_NAMES:
        return f"{text}_"
    return text


def _serialize_move_result(result: MovePlan | dict[str, object]) -> dict[str, object]:
    if isinstance(result, MovePlan):
        return {
            "available": True,
            "action": result.action,
            "target_category": result.target_category,
            "target_root_id": result.target_root_id,
            "destination_path": result.destination_path,
            "destination_folder_name": result.destination_folder_name,
            "layout_mode": result.layout_mode,
            "reuses_existing_artist_folder": result.reuses_existing_artist_folder,
            "blocked_reasons": [],
        }
    blocked_reasons = [
        str(reason or "").strip()
        for reason in list((result or {}).get("blocked_reasons") or [])
        if str(reason or "").strip()
    ]
    return {
        "available": False,
        "action": str((result or {}).get("action") or ""),
        "target_category": str((result or {}).get("target_category") or ""),
        "target_root_id": None,
        "destination_path": None,
        "destination_folder_name": None,
        "layout_mode": None,
        "reuses_existing_artist_folder": False,
        "blocked_reasons": blocked_reasons,
    }


def _serialize_blocked_action(action: str, target_category: str, blocked_reasons: list[str]) -> dict[str, object]:
    return {
        "available": False,
        "action": action,
        "target_category": target_category,
        "target_root_id": None,
        "destination_path": None,
        "destination_folder_name": None,
        "layout_mode": None,
        "reuses_existing_artist_folder": False,
        "blocked_reasons": list(blocked_reasons),
    }


def _collect_action_blocked_reasons(actions: dict[str, dict[str, object]]) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for action_payload in actions.values():
        for reason in list(action_payload.get("blocked_reasons") or []):
            normalized = str(reason or "").strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            ordered.append(normalized)
    return ordered


def _iter_child_directories(path: Path) -> list[Path]:
    try:
        return [child for child in path.iterdir() if child.is_dir()]
    except OSError:
        return []


def _find_child_directory(parent: Path, name: str) -> Path | None:
    normalized_name = name.casefold()
    for child in _iter_child_directories(parent):
        if child.name.casefold() == normalized_name:
            return child
    return None
