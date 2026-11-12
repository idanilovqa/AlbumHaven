"""Read-only, generation-bound previews for explicit duplicate-copy removal."""

import base64
from collections.abc import Mapping
from datetime import datetime
import json
from pathlib import Path
import stat

from music_app.services.album_local_membership import physical_album_root
from music_app.services.auth_tokens import keyed_bucket_digest
from music_app.services.duplicate_copy_review import DuplicateCopyReferenceService
from music_app.services.postgres_connections import pooled_connection


class DuplicateCopyPreviewConflict(ValueError):
    """The requested copy is unavailable or changed."""


def _conflict():
    raise DuplicateCopyPreviewConflict("The selected copy inventory changed. Refresh the copies before continuing.")


def _lstat(path: Path):
    try:
        result = path.lstat()
    except (OSError, ValueError):
        _conflict()
    if stat.S_ISLNK(result.st_mode) or getattr(result, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        _conflict()
    return result


class DuplicateCopyPreviewService:
    def __init__(self, config: Mapping[str, object], *, connect=None):
        self._database_url = config.get("ALBUM_HAVEN_APP_DATABASE_URL")
        self._connect = connect or pooled_connection
        self._references = DuplicateCopyReferenceService(config)
        policy = config.get("hmac")
        self._secret = policy["secret"].encode("utf-8")
        self._version = policy["key_version"]

    @staticmethod
    def _groups(rows):
        groups = {}
        for row in rows:
            try:
                if (
                    type(row["id"]) is not int
                    or type(row["track_id"]) is not int
                    or type(row["library_root_id"]) is not int
                    or not isinstance(row["private_path"], str)
                    or not isinstance(row["root_path"], str)
                    or not isinstance(row["modified_at"], datetime)
                    or not isinstance(row["last_seen_at"], datetime)
                    or row["modified_at"].utcoffset() is None
                    or row["last_seen_at"].utcoffset() is None
                    or type(row["file_size_bytes"]) is not int
                    or row["file_size_bytes"] < 0
                    or min(row["id"], row["track_id"], row["library_root_id"]) < 1
                    or row["is_active"] is not True
                    or row["scan_cache_stale"] is not False
                    or row["source"] != "runtime_scan_cache"
                    or not row["configured_root_id"]
                ):
                    _conflict()
                root = Path(row["root_path"])
                path = Path(row["private_path"])
                relative = path.relative_to(root)
                if not root.is_absolute() or not relative.parts or ".." in relative.parts:
                    _conflict()
                key = (row["library_root_id"], physical_album_root(row["private_path"]))
                groups.setdefault(key, []).append(row)
            except (KeyError, TypeError, ValueError):
                _conflict()
        return groups

    @staticmethod
    def _validate_indexed_file(row):
        root = Path(row["root_path"])
        path = Path(row["private_path"])
        try:
            relative = path.relative_to(root)
            root_stat = _lstat(root)
            actual = _lstat(path)
            if (
                not root.is_absolute()
                or not relative.parts
                or ".." in relative.parts
                or not stat.S_ISDIR(root_stat.st_mode)
                or root.resolve(strict=True) != root
                or not stat.S_ISREG(actual.st_mode)
                or path.resolve(strict=True) != path
                or actual.st_size != row["file_size_bytes"]
                or datetime.fromtimestamp(actual.st_mtime, row["modified_at"].tzinfo) != row["modified_at"]
            ):
                _conflict()
        except (OSError, RuntimeError, ValueError):
            _conflict()

    def _confirmation_ref(self, library_id, album_key, selected, survivors):
        def generation(role, row):
            return [
                role,
                row["id"],
                row["track_id"],
                row["library_root_id"],
                row["modified_at"].isoformat(),
                row["file_size_bytes"],
                row["last_seen_at"].isoformat(),
            ]

        value = json.dumps(
            [library_id, album_key, *[generation("selected", row) for row in selected],
             *[generation("survivor", row) for row in survivors]],
            separators=(",", ":"),
        )
        digest = keyed_bucket_digest(
            secret=self._secret,
            key_version=self._version,
            domain="duplicate-copy-confirmation-v1",
            normalized_value=value,
        ).digest
        return f"dcc1.{self._version}.{base64.urlsafe_b64encode(digest).decode('ascii').rstrip('=')}"

    @staticmethod
    def _inventory(selected):
        root = Path(selected[0]["root_path"])
        album_root = Path(physical_album_root(selected[0]["private_path"]))
        try:
            album_relative = album_root.relative_to(root)
        except ValueError:
            _conflict()
        if (
            not album_relative.parts
            or not stat.S_ISDIR(_lstat(root).st_mode)
            or not stat.S_ISDIR(_lstat(album_root).st_mode)
        ):
            _conflict()
        indexed = {Path(row["private_path"]) for row in selected}
        seen_indexed = set()
        other_files = 0
        try:
            entries = album_root.rglob("*")
            for entry in entries:
                actual = _lstat(entry)
                if stat.S_ISREG(actual.st_mode):
                    if entry in indexed:
                        row = next(row for row in selected if Path(row["private_path"]) == entry)
                        if actual.st_size != row["file_size_bytes"] or datetime.fromtimestamp(
                            actual.st_mtime,
                            row["modified_at"].tzinfo,
                        ) != row["modified_at"]:
                            _conflict()
                        seen_indexed.add(entry)
                    else:
                        other_files += 1
                elif not stat.S_ISDIR(actual.st_mode):
                    _conflict()
        except (OSError, RuntimeError, StopIteration, ValueError):
            _conflict()
        if seen_indexed != indexed:
            _conflict()
        return other_files

    def preview(self, *, library_id: int, album_key: str, copy_ref: str) -> dict[str, object]:
        if type(library_id) is not int or library_id < 1 or not isinstance(album_key, str) or not album_key:
            _conflict()
        with self._connect(self._database_url) as connection:
            rows = [dict(row) for row in connection.execute(
                """select files.id, files.track_id, files.library_root_id, files.private_path,
                          files.modified_at, files.file_size_bytes, files.last_seen_at,
                          files.scan_cache_stale,
                          files.metadata #>> '{scan_cache,source}' as source,
                          roots.root_path, roots.is_active,
                          roots.metadata ->> 'root_id' as configured_root_id
                   from library.local_track_files files
                   join library.local_tracks tracks on tracks.id = files.track_id
                   join library.local_albums albums on albums.id = tracks.album_id
                     and albums.library_id = tracks.library_id
                   join library.library_roots roots on roots.id = files.library_root_id
                     and roots.library_id = tracks.library_id
                   where tracks.library_id = %(library_id)s and albums.album_key = %(album_key)s
                   order by files.id limit 2001""",
                {"library_id": library_id, "album_key": album_key},
            ).fetchall()]
        if len(rows) > 2000:
            _conflict()
        groups = self._groups(rows)
        for row in rows:
            self._validate_indexed_file(row)
        matches = [group for group in groups.values() if self._references.matches(
            copy_ref,
            library_id=library_id,
            album_key=album_key,
            paths=[row["private_path"] for row in group],
        )]
        if len(groups) < 2 or len(matches) != 1:
            _conflict()
        selected = matches[0]
        survivors = [row for group in groups.values() if group is not selected for row in group]
        other_files = self._inventory(selected)
        return {
            "indexed_audio_file_count": len(selected),
            "other_file_count": other_files,
            "surviving_copy_count": len(groups) - 1,
            "confirmation_ref": self._confirmation_ref(library_id, album_key, selected, survivors),
        }
