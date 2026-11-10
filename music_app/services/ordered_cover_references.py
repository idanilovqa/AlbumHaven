"""Validate bounded, persisted cover references without resolving their sources.

This is an internal metadata contract, not source authorization or a save API.
Local references remain private. Their existence, current bytes, and the latest
provider candidate inventory do not determine whether a saved slot survives.
"""
from __future__ import annotations

from collections.abc import Mapping
from pathlib import PurePosixPath, PureWindowsPath
import re
from urllib.parse import urlsplit
from uuid import UUID


_LOCAL_FIELDS = frozenset({"selection_id", "kind", "path"})
_REMOTE_FIELDS = frozenset({
    "selection_id", "kind", "url", "thumbnail_url", "source", "source_label",
    "album_url", "width", "height", "art_kind", "art_label", "candidate_id",
    "candidate_generation",
})
_INTEGER_FIELDS = frozenset({"width", "height"})


class OrderedCoverSelectionConflict(RuntimeError):
    """An operation cannot preserve the concrete album's ordered cover authority."""


def _text(value: object, *, nonempty: bool = False) -> str:
    if not isinstance(value, str) or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("Cover reference fields must be plain text.")
    if nonempty and (not value or value != value.strip()):
        raise ValueError("Cover reference fields must not contain surrounding whitespace.")
    return value


def _remote_identity(value: object) -> tuple[str, str, int, str, str]:
    url = _text(value, nonempty=True)
    if any(char.isspace() for char in url) or "#" in url or "\\" in url:
        raise ValueError("Cover reference URLs must be absolute HTTP(S) URLs.")
    try:
        parsed = urlsplit(url)
        if (
            parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
        ):
            raise ValueError("Cover reference URLs must be absolute HTTP(S) URLs without credentials.")
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid cover reference URL.") from exc
    return (
        parsed.scheme, parsed.hostname.casefold(),
        port if port is not None else (443 if parsed.scheme == "https" else 80),
        parsed.path, parsed.query,
    )


def _local_identity(value: object) -> tuple[str, str]:
    path = _text(value, nonempty=True)
    windows = PureWindowsPath(path)
    parsed = windows if windows.is_absolute() else PurePosixPath(path)
    if not parsed.is_absolute() or ".." in parsed.parts:
        raise ValueError("Local cover references require an absolute source path without traversal.")
    if isinstance(parsed, PureWindowsPath):
        return "windows", str(parsed).casefold()
    return "posix", str(parsed)


def project_selected_cover_metadata(metadata: object) -> dict[str, object]:
    """Copy a complete valid saved set, or return no set for a legacy album.

    Invalid data raises rather than partially dropping items or presenting a
    fabricated primary-only selection. This does not infer manual provenance,
    verify filesystem/library membership, resolve candidates, or perform I/O.
    """
    if not isinstance(metadata, Mapping):
        # Legacy JSONB metadata was not constrained to objects. Like the
        # existing SQL field reads, those values have no selected-cover list.
        return {}
    if "selected_covers" not in metadata:
        return {}
    items = metadata["selected_covers"]
    revision = metadata.get("selected_covers_revision")
    if not isinstance(items, list) or not 1 <= len(items) <= 3:
        raise ValueError("A saved cover selection must contain one to three references.")
    if type(revision) is not int or revision < 0:
        raise ValueError("A saved cover selection requires a nonnegative revision.")

    selected = []
    ids = set()
    sources = set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Each saved cover reference must be an object.")
        selection_id = _text(item.get("selection_id"), nonempty=True)
        kind = item.get("kind")
        if kind == "local":
            if set(item) - _LOCAL_FIELDS:
                raise ValueError("Unsupported local cover reference fields.")
            source = (kind, _local_identity(item.get("path")))
        elif kind == "remote":
            if set(item) - _REMOTE_FIELDS:
                raise ValueError("Unsupported remote cover reference fields.")
            source = (kind, _remote_identity(item.get("url")))
            for field, value in item.items():
                if field == "candidate_generation":
                    if isinstance(value, str):
                        try:
                            UUID(_text(value, nonempty=True))
                        except ValueError as exc:
                            raise ValueError("Cover candidate generation must be a UUID or legacy integer.") from exc
                    elif type(value) is not int or value < 0:
                        raise ValueError("Invalid cover candidate generation.")
                elif field in _INTEGER_FIELDS:
                    if type(value) is not int or value < 0:
                        raise ValueError("Cover dimensions and candidate generation must be nonnegative integers.")
                else:
                    _text(value)
                if field in {"thumbnail_url", "album_url"} and value:
                    _remote_identity(value)
            if "art_kind" in item and item["art_kind"] not in {"cover", "other"}:
                raise ValueError("The saved remote reference is not selectable artwork.")
        else:
            raise ValueError("Unsupported cover reference kind.")
        if selection_id in ids or source in sources:
            raise ValueError("Saved cover references and selection IDs must be unique.")
        ids.add(selection_id)
        sources.add(source)
        selected.append(dict(item))

    result = {"selected_covers": selected, "selected_covers_revision": revision}
    if "selected_covers_last_request" in metadata:
        request = metadata["selected_covers_last_request"]
        if not isinstance(request, dict) or set(request) != {"mutation_id", "request_hash"}:
            raise ValueError("Invalid saved cover request metadata.")
        try:
            UUID(_text(request["mutation_id"], nonempty=True))
        except ValueError as exc:
            raise ValueError("Invalid saved cover mutation ID.") from exc
        if not re.fullmatch(r"[0-9a-f]{64}", _text(request["request_hash"])):
            raise ValueError("Invalid saved cover request hash.")
        result["selected_covers_last_request"] = dict(request)
    return result
