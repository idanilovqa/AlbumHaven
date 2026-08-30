from __future__ import annotations

from collections.abc import Callable


ConfigDict = dict[str, object]
SetLoader = Callable[[ConfigDict], set[str]]
SetSaver = Callable[[ConfigDict, set[str]], None]
LinkLoader = Callable[[ConfigDict], dict[str, str]]
LinkSaver = Callable[[ConfigDict, dict[str, str]], None]


def _normalized_text(value: object) -> str:
    return str(value or "").strip()


def create_version_exception(
    config: ConfigDict,
    album_key: object,
    *,
    load_keys: SetLoader,
    save_keys: SetSaver,
) -> tuple[set[str], str]:
    key = _normalized_text(album_key)
    if not key:
        return set(), "Missing album key"
    keys = load_keys(config)
    keys.add(key)
    save_keys(config, keys)
    return keys, ""


def validate_manual_version_link_keys(album_key: object, parent_album_key: object) -> tuple[str, str, str]:
    normalized_album_key = _normalized_text(album_key)
    normalized_parent_key = _normalized_text(parent_album_key)
    if not normalized_album_key or not normalized_parent_key:
        return "", "", "Missing album key"
    if normalized_album_key == normalized_parent_key:
        return normalized_album_key, normalized_parent_key, "Album cannot be marked as a version of itself"
    return normalized_album_key, normalized_parent_key, ""


def revert_rule_key(
    config: ConfigDict,
    key: object,
    *,
    missing_error: str,
    load_keys: SetLoader,
    save_keys: SetSaver,
) -> tuple[set[str], str]:
    normalized_key = _normalized_text(key)
    if not normalized_key:
        return set(), missing_error
    keys = load_keys(config)
    keys.discard(normalized_key)
    save_keys(config, keys)
    return keys, ""


def mark_manual_version_link(
    config: ConfigDict,
    album_key: object,
    parent_album_key: object,
    *,
    load_links: LinkLoader,
    save_links: LinkSaver,
) -> tuple[dict[str, str], str]:
    normalized_album_key, normalized_parent_key, error = validate_manual_version_link_keys(
        album_key,
        parent_album_key,
    )
    if error:
        return {}, error
    links = load_links(config)
    links[normalized_album_key] = normalized_parent_key
    save_links(config, links)
    return links, ""


def unmark_manual_version_link(
    config: ConfigDict,
    album_key: object,
    *,
    load_links: LinkLoader,
    save_links: LinkSaver,
) -> tuple[dict[str, str], str]:
    normalized_album_key = _normalized_text(album_key)
    if not normalized_album_key:
        return {}, "Missing album key"
    links = load_links(config)
    if normalized_album_key not in links:
        return links, "Album is not marked as a version"
    links.pop(normalized_album_key, None)
    save_links(config, links)
    return links, ""
