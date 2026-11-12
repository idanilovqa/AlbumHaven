"""Read-only, request-scoped presentation of already materialized copies."""

import base64
from collections.abc import Mapping
import hmac
import json
import math
from pathlib import PurePosixPath

from music_app.services.auth_tokens import keyed_bucket_digest


_COPY_REFERENCE_DOMAIN = "duplicate-copy-reference-v1"


class DuplicateCopyReferenceService:
    """Issue path-free references to an exact duplicate-copy path set."""

    def __init__(self, config: Mapping[str, object]):
        policy = config.get("hmac")
        secret = policy.get("secret") if isinstance(policy, Mapping) else None
        version = policy.get("key_version") if isinstance(policy, Mapping) else None
        if not isinstance(secret, str) or len(secret.encode("utf-8")) < 32 or type(version) is not int or version < 1:
            raise ValueError("Invalid duplicate-copy reference configuration")
        self._secret = secret.encode("utf-8")
        self._version = version

    @staticmethod
    def _value(*, library_id: int, album_key: str, paths: object) -> str:
        if type(library_id) is not int or library_id < 1 or not isinstance(album_key, str) or not 1 <= len(album_key) <= 2048:
            raise ValueError("Invalid duplicate-copy reference input")
        try:
            values = list(paths)
        except TypeError:
            raise ValueError("Invalid duplicate-copy reference input") from None
        if not 1 <= len(values) <= 1000 or any(not isinstance(path, str) or not 1 <= len(path) <= 32768 for path in values):
            raise ValueError("Invalid duplicate-copy reference input")
        normalized = [
            path.replace("\\", "/").casefold() if "\\" in path or (len(path) > 1 and path[1] == ":") else path
            for path in values
        ]
        return json.dumps([library_id, album_key, sorted(normalized)], ensure_ascii=False, separators=(",", ":"))

    def issue(self, *, library_id: int, album_key: str, paths: object) -> str:
        digest = keyed_bucket_digest(
            secret=self._secret,
            key_version=self._version,
            domain=_COPY_REFERENCE_DOMAIN,
            normalized_value=self._value(library_id=library_id, album_key=album_key, paths=paths),
        ).digest
        signature = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
        return f"dcr1.{self._version}.{signature}"

    def matches(self, token: object, *, library_id: int, album_key: str, paths: object) -> bool:
        if not isinstance(token, str) or len(token) > 128:
            return False
        try:
            prefix, version, signature = token.split(".")
            expected = self.issue(library_id=library_id, album_key=album_key, paths=paths)
            expected_prefix, expected_version, expected_signature = expected.split(".")
        except (TypeError, ValueError, UnicodeError):
            return False
        return prefix == expected_prefix and version == expected_version and hmac.compare_digest(signature, expected_signature)


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _basename(value: object) -> str:
    name = _text(value).replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    return "" if name in (".", "..") or (len(name) == 2 and name[1] == ":") else name


def _number(value: object, *, positive: bool = False) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return value if math.isfinite(value) and (value > 0 if positive else value >= 0) else None
    except OverflowError:
        return None


def _integer(value: object) -> int | None:
    return value if isinstance(value, int) and _number(value, positive=True) is not None else None


def project_duplicate_copy_review(
    sources: object,
    *,
    include_paths: bool,
    copy_reference=None,
) -> list[dict[str, object]]:
    """Allowlist scalar display data without changing sources or reading media.

    Copy numbers belong only to this response, never to a physical-file action.
    A file extension is a format label, not evidence of a codec or audio quality.
    """
    if not isinstance(sources, list):
        return []
    copies: list[dict[str, object]] = []
    for source in sources:
        if not isinstance(source, Mapping) or not isinstance(source.get("tracks"), list):
            continue
        tracks = []
        for track in source["tracks"]:
            if not isinstance(track, Mapping):
                continue
            path = _text(track.get("path"))
            file_name = _basename(path or track.get("file_name"))
            if not file_name:
                continue
            projected = {
                "title": _text(track.get("title")),
                "file_name": file_name,
                "track_number": _integer(track.get("track_number")),
                "disc_number": _integer(track.get("disc_number")),
                "artist": _text(track.get("artist")),
                "year": _integer(track.get("year")),
                "duration_seconds": _number(track.get("duration_seconds")),
                "format": PurePosixPath(file_name).suffix.lstrip(".").upper(),
                "codec": _text(track.get("codec")) or None,
                "bitrate": _number(track.get("bitrate"), positive=True),
                "sample_rate": _number(track.get("sample_rate"), positive=True),
                "bit_depth": _number(track.get("bit_depth"), positive=True),
            }
            if include_paths:
                projected["path"] = path
            tracks.append(projected)
        if not tracks:
            continue
        durations = [track["duration_seconds"] for track in tracks]
        folder_path = _text(source.get("folder_path"))
        copy = {
            "copy_number": len(copies) + 1,
            "folder_name": _basename(folder_path or source.get("folder_name")),
            "track_count": len(tracks),
            "total_duration_seconds": _number(sum(durations)) if all(value is not None for value in durations) else None,
            "tracks": tracks,
        }
        if include_paths:
            copy["folder_path"] = folder_path
        if copy_reference is not None:
            reference = copy_reference(source)
            if isinstance(reference, str) and reference:
                copy["copy_ref"] = reference
        copies.append(copy)
    return copies if len(copies) > 1 else []
