from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
from threading import RLock

from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
from config import PERSISTENCE_BACKEND_POSTGRES


_MAIN_ROOTS_KEY = "main_library_roots"
_HOARD_ROOTS_KEY = "hoarding_library_roots"
_NEW_ARRIVALS_ROOTS_KEY = "new_arrivals_roots"
_ROOT_KEYS = (_MAIN_ROOTS_KEY, _HOARD_ROOTS_KEY, _NEW_ARRIVALS_ROOTS_KEY)
_ALLOWED_LAYOUT_MODES = {"genre/artist", "artist", "album-at-root"}
_CATEGORY_SLUGS = {
    _MAIN_ROOTS_KEY: "main_library",
    _HOARD_ROOTS_KEY: "hoard",
    _NEW_ARRIVALS_ROOTS_KEY: "new_arrivals",
}
_CATEGORY_LABELS = {
    _MAIN_ROOTS_KEY: "Main Library",
    _HOARD_ROOTS_KEY: "Hoard",
    _NEW_ARRIVALS_ROOTS_KEY: "New Arrivals",
}
_CATEGORY_BADGE_LABELS = {
    _MAIN_ROOTS_KEY: None,
    _HOARD_ROOTS_KEY: "Hoard",
    _NEW_ARRIVALS_ROOTS_KEY: "New",
}
_CONFIGURED_ROOT_PATHS_SNAPSHOT_KEY = "_library_root_paths_snapshot"
_CONFIGURED_ROOT_PATHS_SNAPSHOT_LOCK = RLock()


def _root_paths_from_settings(settings: object) -> tuple[Path, ...]:
    if not isinstance(settings, dict):
        return ()
    return tuple(
        Path(str(root["path"])).resolve(strict=False)
        for category_key in _ROOT_KEYS
        for root in list(settings.get(category_key) or [])
        if isinstance(root, dict) and str(root.get("path") or "").strip()
    )


def _store_configured_root_paths_snapshot(
    config: dict[str, object],
    settings: object,
) -> tuple[Path, ...]:
    root_paths = _root_paths_from_settings(settings)
    config[_CONFIGURED_ROOT_PATHS_SNAPSHOT_KEY] = root_paths
    return root_paths


def load_library_root_settings(
    config: dict[str, object],
    *,
    connection: object | None = None,
) -> dict[str, object]:
    from music_app.services.persistence_selection import select_runtime_persistence_adapter

    with _CONFIGURED_ROOT_PATHS_SNAPSHOT_LOCK:
        selection = select_runtime_persistence_adapter("library_roots", config)
        if selection.effective_backend != PERSISTENCE_BACKEND_POSTGRES:
            raise ValueError("Postgres runtime persistence adapter is unavailable for library_roots.")
        store = PostgresLibraryRootSettingsStore(config)
        settings = (
            store.load_settings(connection=connection)
            if connection is not None
            else store.load_settings()
        )
        _store_configured_root_paths_snapshot(config, settings)
        return settings


def save_library_root_settings(config: dict[str, object], raw_payload: object) -> dict[str, object]:
    from music_app.services.persistence_selection import select_runtime_persistence_adapter

    with _CONFIGURED_ROOT_PATHS_SNAPSHOT_LOCK:
        selection = select_runtime_persistence_adapter("library_roots", config)
        if selection.effective_backend != PERSISTENCE_BACKEND_POSTGRES:
            raise ValueError("Postgres runtime persistence adapter is unavailable for library_roots.")
        settings = PostgresLibraryRootSettingsStore(config).save_settings(raw_payload)
        _store_configured_root_paths_snapshot(config, settings)
        return settings


def configured_library_root_paths_snapshot(
    config: dict[str, object],
    *,
    connection: object | None = None,
) -> tuple[Path, ...]:
    with _CONFIGURED_ROOT_PATHS_SNAPSHOT_LOCK:
        cached_root_paths = config.get(_CONFIGURED_ROOT_PATHS_SNAPSHOT_KEY)
        if isinstance(cached_root_paths, tuple):
            return cached_root_paths
        settings = (
            load_library_root_settings(config, connection=connection)
            if connection is not None
            else load_library_root_settings(config)
        )
        return _store_configured_root_paths_snapshot(config, settings)


def normalize_library_root_settings(raw_payload: object, *, fallback_main_root: Path) -> dict[str, object]:
    payload = raw_payload if isinstance(raw_payload, dict) else {}

    return _normalize_library_root_settings_payload(payload, fallback_main_root=fallback_main_root)


def normalize_persisted_library_root_settings(raw_payload: object) -> dict[str, object]:
    if not isinstance(raw_payload, dict):
        raise ValueError("Persisted library root settings must be a JSON object.")
    normalized = _normalize_library_root_settings_payload(raw_payload, fallback_main_root=None)
    if not normalized[_MAIN_ROOTS_KEY]:
        raise ValueError("At least one Main Library root is required.")
    return normalized


def empty_library_root_settings() -> dict[str, object]:
    return {
        "version": 1,
        _MAIN_ROOTS_KEY: [],
        _HOARD_ROOTS_KEY: [],
        _NEW_ARRIVALS_ROOTS_KEY: [],
        "move_policy": {},
    }


def _normalize_library_root_settings_payload(
    payload: dict[str, object],
    *,
    fallback_main_root: Path | None,
) -> dict[str, object]:

    main_roots = _normalize_root_entries(payload.get(_MAIN_ROOTS_KEY), category=_MAIN_ROOTS_KEY)
    if not main_roots and fallback_main_root is not None:
        main_roots = [{
            "id": "main-library-root-1",
            "path": str(fallback_main_root),
            "layout_mode": "artist",
        }]
    hoard_roots = _normalize_root_entries(payload.get(_HOARD_ROOTS_KEY), category=_HOARD_ROOTS_KEY)
    new_arrivals_roots = _normalize_root_entries(payload.get(_NEW_ARRIVALS_ROOTS_KEY), category=_NEW_ARRIVALS_ROOTS_KEY)

    _validate_root_overlap(
        [*main_roots, *hoard_roots, *new_arrivals_roots],
    )

    move_policy = _normalize_move_policy(
        payload.get("move_policy"),
        main_roots=main_roots,
        hoard_roots=hoard_roots,
    )

    return {
        "version": 1,
        _MAIN_ROOTS_KEY: main_roots,
        _HOARD_ROOTS_KEY: hoard_roots,
        _NEW_ARRIVALS_ROOTS_KEY: new_arrivals_roots,
        "move_policy": move_policy,
    }


def get_primary_music_root(config: dict[str, object]) -> Path:
    settings = load_library_root_settings(config)
    main_roots = settings.get(_MAIN_ROOTS_KEY)
    if not isinstance(main_roots, list) or not main_roots:
        raise ValueError("Library root settings are not initialized.")
    root = main_roots[0]
    return Path(str(root["path"])).resolve(strict=False)


def get_library_roots(config: dict[str, object]) -> list[dict[str, object]]:
    settings = load_library_root_settings(config)
    roots: list[dict[str, object]] = []
    for key in _ROOT_KEYS:
        for root in settings.get(key, []):
            if isinstance(root, dict):
                enriched = dict(root)
                enriched["category"] = key
                roots.append(enriched)
    return roots


def library_category_slug(category: object) -> str:
    text = str(category or "").strip()
    if text in _CATEGORY_SLUGS.values():
        return text
    return _CATEGORY_SLUGS.get(text, _CATEGORY_SLUGS[_MAIN_ROOTS_KEY])


def library_category_label(category: object) -> str:
    text = str(category or "").strip()
    if text in _CATEGORY_SLUGS.values():
        for key, slug in _CATEGORY_SLUGS.items():
            if slug == text:
                return _CATEGORY_LABELS[key]
    return _CATEGORY_LABELS.get(text, _CATEGORY_LABELS[_MAIN_ROOTS_KEY])


def library_category_badge_label(category: object) -> str | None:
    text = str(category or "").strip()
    if text in _CATEGORY_SLUGS.values():
        for key, slug in _CATEGORY_SLUGS.items():
            if slug == text:
                return _CATEGORY_BADGE_LABELS[key]
    return _CATEGORY_BADGE_LABELS.get(text, None)


def library_category_slugs() -> list[str]:
    return [
        _CATEGORY_SLUGS[_MAIN_ROOTS_KEY],
        _CATEGORY_SLUGS[_HOARD_ROOTS_KEY],
        _CATEGORY_SLUGS[_NEW_ARRIVALS_ROOTS_KEY],
    ]


def build_root_provenance_payload(root_id: object, category: object) -> dict[str, object]:
    normalized_category = library_category_slug(category)
    return {
        "root_id": str(root_id or "").strip(),
        "category": normalized_category,
        "category_label": library_category_label(normalized_category),
        "badge_label": library_category_badge_label(normalized_category),
    }


def summarize_root_provenance_payloads(payloads: list[dict[str, object]] | tuple[dict[str, object], ...]) -> dict[str, object]:
    normalized_payloads = [payload for payload in payloads if isinstance(payload, dict)]
    root_ids: list[str] = []
    categories: list[str] = []
    category_labels: list[str] = []
    badges: list[str] = []
    seen_ids: set[str] = set()
    seen_categories: set[str] = set()
    seen_badges: set[str] = set()

    for payload in normalized_payloads:
        root_id = str(payload.get("root_id") or "").strip()
        category = library_category_slug(payload.get("category"))
        category_label = library_category_label(category)
        badge_label = library_category_badge_label(category)
        if root_id and root_id not in seen_ids:
            seen_ids.add(root_id)
            root_ids.append(root_id)
        if category not in seen_categories:
            seen_categories.add(category)
            categories.append(category)
            category_labels.append(category_label)
        if badge_label and badge_label not in seen_badges:
            seen_badges.add(badge_label)
            badges.append(badge_label)

    primary_category = categories[0] if len(categories) == 1 else None
    return {
        "root_ids": root_ids,
        "categories": categories,
        "category_labels": category_labels,
        "primary_category": primary_category,
        "primary_category_label": library_category_label(primary_category) if primary_category else None,
        "badges": badges,
        "is_mixed": len(categories) > 1,
    }


def library_root_cache_identity(config: dict[str, object]) -> str:
    payload = load_library_root_settings(config)
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def resolve_configured_media_path(
    config: dict[str, object],
    raw_path: str,
    *,
    require_file: bool = True,
    require_exists: bool = True,
    configured_root_paths: list[Path] | tuple[Path, ...] | None = None,
) -> Path | None:
    if not raw_path:
        return None

    candidate = Path(str(raw_path)).expanduser()
    matched_paths: list[Path] = []
    root_paths = (
        list(configured_root_paths)
        if configured_root_paths is not None
        else iter_library_root_paths(config)
    )
    for root in root_paths:
        resolved = _resolve_candidate_under_root(
            root=root,
            candidate=candidate,
            require_file=require_file,
            require_exists=require_exists,
        )
        if resolved is not None:
            matched_paths.append(resolved)

    if not matched_paths:
        return None

    unique_matches = []
    seen: set[str] = set()
    for match in matched_paths:
        key = _path_key(match)
        if key in seen:
            continue
        seen.add(key)
        unique_matches.append(match)
    if len(unique_matches) != 1:
        return None
    return unique_matches[0]


def relative_parts_within_roots(config: dict[str, object], raw_path: str) -> tuple[dict[str, object], tuple[str, ...]] | None:
    resolved = resolve_configured_media_path(config, raw_path)
    if resolved is None:
        return None
    for root in get_library_roots(config):
        root_path = Path(str(root["path"])).resolve(strict=False)
        try:
            rel_parts = resolved.relative_to(root_path).parts
        except Exception:
            continue
        return root, rel_parts
    return None


def resolve_album_open_directories(config: dict[str, object], album_payload: dict[str, object]) -> list[Path]:
    preview_directories = album_payload.get("open_directory_paths") if isinstance(album_payload, dict) else None
    if isinstance(preview_directories, list):
        resolved_preview_dirs: list[Path] = []
        seen_preview_dirs: set[str] = set()
        for raw_directory in preview_directories:
            resolved_directory = resolve_configured_media_path(
                config,
                str(raw_directory or ""),
                require_file=False,
            )
            if resolved_directory is None:
                continue
            key = _path_key(resolved_directory)
            if key in seen_preview_dirs:
                continue
            seen_preview_dirs.add(key)
            resolved_preview_dirs.append(resolved_directory)
        if resolved_preview_dirs:
            return resolved_preview_dirs

    tracks = album_payload.get("tracks") if isinstance(album_payload, dict) else None
    if not isinstance(tracks, list):
        return []

    resolved_dirs: list[Path] = []
    seen: set[str] = set()
    album_name = str(album_payload.get("name") or "").strip()

    for track in tracks:
        if not isinstance(track, dict):
            continue
        resolved_track = resolve_configured_media_path(config, str(track.get("path") or ""))
        if resolved_track is None:
            continue

        parent = resolved_track.parent
        open_dir = parent
        if (
            album_name
            and parent.parent
            and parent.parent != parent
            and _is_disc_subfolder(parent)
            and _album_folder_matches(parent.parent, album_name)
        ):
            open_dir = parent.parent
        elif album_name and _album_folder_matches(parent, album_name):
            open_dir = parent

        key = _path_key(open_dir)
        if key in seen:
            continue
        seen.add(key)
        resolved_dirs.append(open_dir)

    return resolved_dirs


def iter_library_root_paths(config: dict[str, object]) -> list[Path]:
    return [
        Path(str(root["path"])).resolve(strict=False)
        for root in get_library_roots(config)
    ]


def root_definition_for_path(roots: list[dict[str, object]], path: Path | str) -> dict[str, object] | None:
    candidate = Path(str(path)).resolve(strict=False)
    for root in roots:
        if not isinstance(root, dict):
            continue
        root_path = Path(str(root.get("path") or "")).resolve(strict=False)
        try:
            candidate.relative_to(root_path)
        except Exception:
            continue
        return root
    return None


def _normalize_root_entries(raw_entries: object, *, category: str) -> list[dict[str, object]]:
    entries = raw_entries if isinstance(raw_entries, list) else []
    normalized: list[dict[str, object]] = []
    seen_ids: set[str] = set()

    for index, raw_entry in enumerate(entries, start=1):
        if isinstance(raw_entry, str):
            raw_entry = {"path": raw_entry}
        if not isinstance(raw_entry, dict):
            raise ValueError(f"Invalid {category} entry at position {index}.")
        path_value = str(raw_entry.get("path") or "").strip()
        if not path_value:
            raise ValueError(f"{category} entry {index} is missing a path.")
        root_path = Path(path_value).expanduser().resolve(strict=False)
        root_id = str(raw_entry.get("id") or f"{category}-{index}").strip()
        if not root_id:
            raise ValueError(f"{category} entry {index} is missing an id.")
        if root_id in seen_ids:
            raise ValueError(f"Duplicate library root id: {root_id}")
        seen_ids.add(root_id)

        normalized_entry: dict[str, object] = {
            "id": root_id,
            "path": str(root_path),
        }
        if category == _MAIN_ROOTS_KEY:
            layout_mode = str(raw_entry.get("layout_mode") or "artist").strip()
            if layout_mode not in _ALLOWED_LAYOUT_MODES:
                raise ValueError(f"Unsupported Main Library layout mode: {layout_mode}")
            normalized_entry["layout_mode"] = layout_mode
        normalized.append(normalized_entry)

    return normalized


def _normalize_move_policy(
    raw_policy: object,
    *,
    main_roots: list[dict[str, object]],
    hoard_roots: list[dict[str, object]],
) -> dict[str, object]:
    policy = raw_policy if isinstance(raw_policy, dict) else {}
    normalized: dict[str, object] = {}
    preferred_main = str(policy.get("preferred_main_write_root") or "").strip()
    if preferred_main:
        normalized["preferred_main_write_root"] = _normalize_root_reference(
            preferred_main,
            allowed_roots=main_roots,
            field_name="preferred_main_write_root",
        )
    move_new_arrivals_to = str(policy.get("move_new_arrivals_to") or "").strip()
    if move_new_arrivals_to:
        normalized["move_new_arrivals_to"] = _normalize_root_reference(
            move_new_arrivals_to,
            allowed_roots=hoard_roots,
            field_name="move_new_arrivals_to",
        )
    return normalized


def _normalize_root_reference(reference: str, *, allowed_roots: list[dict[str, object]], field_name: str) -> str:
    normalized_reference = reference.strip()
    if not normalized_reference:
        raise ValueError(f"{field_name} cannot be empty.")
    allowed_ids = {str(root.get("id") or "").strip() for root in allowed_roots}
    allowed_paths = {
        _path_key(Path(str(root.get("path") or "")).resolve(strict=False)): str(root.get("id") or "").strip()
        for root in allowed_roots
    }
    if normalized_reference in allowed_ids:
        return normalized_reference

    normalized_path_key = _path_key(Path(normalized_reference).expanduser().resolve(strict=False))
    if normalized_path_key in allowed_paths:
        return allowed_paths[normalized_path_key]

    raise ValueError(f"{field_name} must point at a configured root in the matching category.")


def _validate_root_overlap(roots: list[dict[str, object]]) -> None:
    resolved_roots = [
        (str(root.get("id") or ""), Path(str(root.get("path") or "")).resolve(strict=False))
        for root in roots
    ]
    if not resolved_roots:
        raise ValueError("At least one Main Library root is required.")

    seen_paths: dict[str, str] = {}
    for root_id, root_path in resolved_roots:
        path_key = _path_key(root_path)
        if path_key in seen_paths:
            raise ValueError(f"Duplicate library root path: {root_path}")
        seen_paths[path_key] = root_id

    for index, (_, left_path) in enumerate(resolved_roots):
        for _, right_path in resolved_roots[index + 1:]:
            if _paths_overlap(left_path, right_path):
                raise ValueError(
                    f"Library roots cannot overlap or nest: {left_path} and {right_path}"
                )


def _resolve_candidate_under_root(
    *,
    root: Path,
    candidate: Path,
    require_file: bool,
    require_exists: bool,
) -> Path | None:
    candidate_under_root = candidate if candidate.is_absolute() else root / candidate
    try:
        resolved = candidate_under_root.resolve(strict=False)
        resolved.relative_to(root)
    except Exception:
        return None
    try:
        if require_exists and not resolved.exists():
            return None
        if require_file and (not resolved.exists() or not resolved.is_file()):
            return None
        if not require_file and require_exists and not resolved.is_dir():
            return None
    except OSError:
        return None
    return resolved


def _paths_overlap(left: Path, right: Path) -> bool:
    try:
        left.relative_to(right)
        return True
    except Exception:
        pass
    try:
        right.relative_to(left)
        return True
    except Exception:
        return False


def _path_key(path: Path) -> str:
    return os.path.normcase(str(path.resolve(strict=False)))


_DISC_FOLDER_NAMES = ("cd", "disc", "disk")


def _is_disc_subfolder(path: Path) -> bool:
    name = " ".join(path.name.strip().replace("_", " ").replace("-", " ").split()).casefold()
    return any(name.startswith(prefix) and any(char.isdigit() for char in name) for prefix in _DISC_FOLDER_NAMES)


def _album_folder_matches(parent: Path, album_name: str) -> bool:
    return _normalize_album_folder_name(parent.name) == _normalize_album_folder_name(album_name)


def _normalize_album_folder_name(value: str) -> str:
    text = " ".join((value or "").strip().split())
    if not text:
        return ""
    text = re.sub(r"^\d{4}\s*[-_.: ]+\s*", "", text)
    text = re.sub(r"\s*[-_.: ]+\d{4}$", "", text)
    text = re.sub(r"^[\[(]\d{4}[\])]\s*", "", text)
    text = re.sub(r"\s*[\[(]\d{4}[\])]\s*$", "", text)
    text = re.sub(r"[_\-]+", " ", text)
    return " ".join(text.split()).casefold()
