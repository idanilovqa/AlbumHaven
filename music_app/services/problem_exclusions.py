from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from music_app.services.ignored_repairs import (
    create_ignored_repair_keys,
    delete_ignored_repair_keys,
)


JsonDict = dict[str, object]
ProblemExclusionResolver = Callable[
    [Sequence["ProblemExclusionItem"]],
    list[JsonDict],
]

_TAG_EDIT_FIELDS = {
    "album",
    "changes",
    "confirmed",
    "ignored_rows",
    "selected_rows",
    "separate_release_keys",
    "updates",
}
_PUBLIC_ITEM_FIELDS = {
    "row_key",
    "scope",
    "path",
    "filename",
    "field",
    "album",
    "artist",
    "year",
    "problem_reason",
    "album_group_key",
}


@dataclass(frozen=True, slots=True)
class ProblemExclusionItem:
    row_key: str
    scope: str
    album_key: str = ""
    path: str = ""


@dataclass(frozen=True, slots=True)
class ProblemExclusionResult:
    applied_items: list[JsonDict]
    removed_legacy_row_keys: list[str]


def parse_problem_exclusion_items(payload: Mapping[str, object]) -> tuple[ProblemExclusionItem, ...]:
    if any(field in payload for field in _TAG_EDIT_FIELDS):
        raise ValueError("Problem exclusions do not accept tag-edit fields")

    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError("No problem exclusions were provided")

    parsed: list[ProblemExclusionItem] = []
    seen_row_keys: set[str] = set()
    for raw_item in raw_items:
        if not isinstance(raw_item, Mapping):
            raise ValueError("Problem exclusion items must be objects")
        row_key = _text(raw_item.get("row_key"))
        scope = _text(raw_item.get("scope"))
        album_key = _text(raw_item.get("album_key"))
        path = _text(raw_item.get("path"))
        if not row_key or row_key in seen_row_keys:
            raise ValueError("Problem exclusion row keys must be present and unique")
        if scope == "album":
            valid_identity = (
                bool(album_key)
                and not path
                and "::problem-album::" in row_key
                and "::problem-file::" not in row_key
            )
        elif scope == "file":
            valid_identity = (
                bool(path)
                and not album_key
                and row_key.startswith(f"{path}::problem-file::")
            )
        else:
            valid_identity = False
        if not valid_identity:
            raise ValueError("Problem exclusion scope does not match its identity")
        seen_row_keys.add(row_key)
        parsed.append(
            ProblemExclusionItem(
                row_key=row_key,
                scope=scope,
                album_key=album_key,
                path=path,
            )
        )
    return tuple(parsed)


def create_problem_exclusions(
    config: dict,
    payload: Mapping[str, object],
    *,
    resolve_items: ProblemExclusionResolver,
) -> ProblemExclusionResult:
    requested_items = parse_problem_exclusion_items(payload)
    resolved_items = list(resolve_items(requested_items))
    resolved_by_row_key = {
        _text(item.get("row_key")): item
        for item in resolved_items
        if isinstance(item, Mapping) and _text(item.get("row_key"))
    }

    ordered_resolved: list[Mapping[str, object]] = []
    for requested in requested_items:
        resolved = resolved_by_row_key.get(requested.row_key)
        if not resolved or not _resolved_owner_matches(requested, resolved):
            raise ValueError("Problem exclusion row is unknown or stale")
        ordered_resolved.append(resolved)
    if len(resolved_by_row_key) != len(requested_items):
        raise ValueError("Problem exclusion row is unknown or stale")

    row_keys = {item.row_key for item in requested_items}
    album_keys_by_repair_key = {
        item.row_key: item.album_key
        for item in requested_items
        if item.scope == "album"
    }
    legacy_row_keys = sorted({
        _text(legacy_row_key)
        for item in ordered_resolved
        for legacy_row_key in item.get("legacy_row_keys") or []
        if _text(legacy_row_key)
    })
    create_ignored_repair_keys(
        config,
        row_keys,
        album_keys_by_repair_key=album_keys_by_repair_key,
        remove_row_keys=set(legacy_row_keys),
    )
    return ProblemExclusionResult(
        applied_items=[
            {
                key: item.get(key)
                for key in _PUBLIC_ITEM_FIELDS
            }
            for item in ordered_resolved
        ],
        removed_legacy_row_keys=legacy_row_keys,
    )


def revert_problem_exclusion(config: dict, raw_row_key: object) -> str:
    row_key = _text(raw_row_key)
    if not row_key:
        raise ValueError("Missing ignored problem key")
    delete_ignored_repair_keys(config, {row_key})
    return row_key


def _resolved_owner_matches(
    requested: ProblemExclusionItem,
    resolved: Mapping[str, object],
) -> bool:
    if _text(resolved.get("scope")) != requested.scope:
        return False
    if requested.scope == "album":
        return (
            _text(resolved.get("album_key")) == requested.album_key
            and not _text(resolved.get("path"))
        )
    return _text(resolved.get("path")) == requested.path


def _text(value: object) -> str:
    return str(value or "").strip()
