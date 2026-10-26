"""Recoverable, no-replace folder moves. Never copies or permanently deletes."""
from contextlib import ExitStack
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

MAX_ENTRIES = 4096
MAX_DEPTH = 16
MAX_SNAPSHOT_BYTES = 512 * 1024


class DuplicateFolderError(ValueError):
    def __init__(self, code, status=409):
        super().__init__(code)
        self.code, self.status = code, status


def _parts(path):
    value = Path(path)
    if not value.is_absolute() or '..' in value.parts or '\x00' in str(value):
        raise DuplicateFolderError('invalid_folder')
    return value


def _normal(info):
    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise DuplicateFolderError('linked_folder_content')
    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
        raise DuplicateFolderError('special_folder_content')
    if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
        raise DuplicateFolderError('linked_folder_content')
    return [info.st_dev, info.st_ino, info.st_size if stat.S_ISREG(info.st_mode) else 0,
            info.st_mtime_ns if stat.S_ISREG(info.st_mode) else 0,
            info.st_ctime_ns if stat.S_ISREG(info.st_mode) else 0,
            'file' if stat.S_ISREG(info.st_mode) else 'directory']


def snapshot(folder, *, expected_music, music_extensions):
    """Bounded complete folder preview, rejecting other/unindexed music and links."""
    folder = _parts(folder)
    expected = {str(Path(p).relative_to(folder)) for p in expected_music}
    if not expected:
        raise DuplicateFolderError('empty_source')
    rows, found = [], set()
    serialized_rows_bytes = 2
    def admit(relative, info):
        nonlocal serialized_rows_bytes
        mark = _normal(info)
        if len(rows) >= MAX_ENTRIES:
            raise DuplicateFolderError('folder_too_large')
        if mark[-1] == 'file' and Path(relative).suffix.casefold() in music_extensions:
            if relative not in expected:
                raise DuplicateFolderError('mixed_folder_content')
            found.add(relative)
        row = [relative, *mark]
        serialized_rows_bytes += len(json.dumps(row, separators=(',', ':')).encode('utf-8')) + bool(rows)
        if serialized_rows_bytes > MAX_SNAPSHOT_BYTES:
            raise DuplicateFolderError('snapshot_metadata_too_large')
        rows.append(row)
        return mark
    if os.name == 'posix':
        with ExitStack() as stack:
            root_fd = _posix_parent(stack, folder)
            def walk(fd, relative, depth):
                if depth > MAX_DEPTH:
                    raise DuplicateFolderError('folder_too_large')
                admit(relative, os.fstat(fd))
                with os.scandir(fd) as entries:
                    for entry in entries:
                        name = entry.name
                        child_relative = name if relative == '.' else str(Path(relative) / name)
                        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                        mark = _normal(info)
                        if mark[-1] == 'directory':
                            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
                            child = os.open(name, flags, dir_fd=fd)
                            try:
                                actual = os.fstat(child)
                                if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
                                    raise DuplicateFolderError('source_changed')
                                walk(child, child_relative, depth + 1)
                            finally:
                                os.close(child)
                        else:
                            admit(child_relative, info)
            walk(root_fd, '.', 0)
    elif os.name == 'nt':
        from music_app.services.duplicate_folder_windows import snapshot_windows
        snapshot_windows(folder, admit, MAX_DEPTH)
    else:
        raise DuplicateFolderError('safe_trash_unavailable', 503)
    if found != expected:
        raise DuplicateFolderError('source_changed')
    rows.sort(key=lambda row: row[0])
    result = {'digest': hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest(),
            'entries': rows, 'file_count': sum(row[-1] == 'file' for row in rows)}
    if len(json.dumps(result, separators=(',', ':')).encode('utf-8')) > MAX_SNAPSHOT_BYTES:
        raise DuplicateFolderError('snapshot_metadata_too_large')
    return result


def _posix_parent(stack, path):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open('/', flags)
    stack.callback(os.close, fd)
    for part in path.parts[1:]:
        fd = os.open(part, flags, dir_fd=fd)
        stack.callback(os.close, fd)
    return fd


def _linux_move(source, destination, expected_identity):
    # renameat2(RENAME_NOREPLACE) is atomic and never silently replaces a folder.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    if rename is None:
        raise DuplicateFolderError('safe_trash_unavailable', 503)
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    with ExitStack() as stack:
        src = _posix_parent(stack, source.parent)
        dst = _posix_parent(stack, destination.parent)
        source_info = os.stat(source.name, dir_fd=src, follow_symlinks=False)
        if (source_info.st_dev, source_info.st_ino) != tuple(expected_identity):
            raise DuplicateFolderError('source_changed')
        if _normal(source_info)[-1] != 'directory':
            raise DuplicateFolderError('invalid_folder')
        if source_info.st_dev != os.fstat(dst).st_dev:
            raise DuplicateFolderError('trash_volume_mismatch')
        if rename(src, os.fsencode(source.name), dst, os.fsencode(destination.name), 1) != 0:
            value = ctypes.get_errno()
            if value in (errno.EEXIST, errno.ENOTEMPTY):
                raise DuplicateFolderError('destination_occupied')
            raise OSError(value, os.strerror(value))
        moved = os.stat(destination.name, dir_fd=dst, follow_symlinks=False)
        if (moved.st_dev, moved.st_ino) != tuple(expected_identity):
            raise DuplicateFolderError('outcome_needs_review')
        os.fsync(src)
        os.fsync(dst)


def move_no_replace(source, destination, *, expected_identity):
    source, destination = _parts(source), _parts(destination)
    if source == destination or source in destination.parents or destination in source.parents:
        raise DuplicateFolderError('overlapping_folders')
    if sys.platform == 'linux':
        return _linux_move(source, destination, expected_identity)
    if os.name == 'nt':
        from music_app.services.duplicate_folder_windows import move_no_replace_windows
        return move_no_replace_windows(source, destination, expected_identity)
    raise DuplicateFolderError('safe_trash_unavailable', 503)
