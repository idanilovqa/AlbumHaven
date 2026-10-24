"""Windows no-replace handle rename and non-reparse pinned traversal.

No copy/delete fallback. Native Windows acceptance remains a separate check.
"""
from contextlib import ExitStack
import ctypes
from ctypes import wintypes
import os
from pathlib import Path

from music_app.services.duplicate_folder_files import DuplicateFolderError


class _Handles:
    def __init__(self, stack):
        self.stack = stack
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.create = self.kernel.CreateFileW
        self.create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                               wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        self.create.restype = wintypes.HANDLE
        self.close = self.kernel.CloseHandle
        self.close.argtypes, self.close.restype = [wintypes.HANDLE], wintypes.BOOL
        class Info(ctypes.Structure):
            _fields_ = [('attributes', wintypes.DWORD), ('created', wintypes.FILETIME),
                        ('accessed', wintypes.FILETIME), ('written', wintypes.FILETIME),
                        ('volume', wintypes.DWORD), ('size_high', wintypes.DWORD),
                        ('size_low', wintypes.DWORD), ('links', wintypes.DWORD),
                        ('index_high', wintypes.DWORD), ('index_low', wintypes.DWORD)]
        self.Info = Info
        self.get_info = self.kernel.GetFileInformationByHandle
        self.get_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(Info)]
        self.get_info.restype = wintypes.BOOL

    def leaf(self, path, *, directory=True, moving=False):
        handle = self.create(str(path), 0x80 | (0x10000 if moving else 0),
                             0x1 | 0x2, None, 3, 0x02000000 | 0x00200000, None)
        if handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        self.stack.callback(self.close, handle)
        info = self.Info()
        if not self.get_info(handle, ctypes.byref(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        if bool(info.attributes & 0x10) != directory or info.attributes & 0x400:
            raise DuplicateFolderError('linked_folder_content')
        if not directory and info.links != 1:
            raise DuplicateFolderError('linked_folder_content')
        return handle

    def chain(self, path, *, moving=False):
        if not path.drive or path.drive.startswith('\\\\'):
            raise DuplicateFolderError('safe_trash_unavailable', 503)
        result = None
        for index in range(1, len(path.parts) + 1):
            result = self.leaf(Path(*path.parts[:index]), moving=moving and index == len(path.parts))
        return result


def snapshot_windows(folder, admit, max_depth):
    # Ancestors remain open without DELETE sharing. Each child is pinned before
    # inspecting it or traversing its pathname, so a junction cannot be swapped
    # into the walk. No file bytes are read.
    with ExitStack() as stack:
        handles = _Handles(stack)
        handles.chain(folder)
        def walk(directory, relative, depth):
            if depth > max_depth:
                raise DuplicateFolderError('folder_too_large')
            admit(relative, os.stat(directory, follow_symlinks=False))
            with os.scandir(directory) as entries:
                for entry in entries:
                    child = Path(entry.path)
                    child_relative = entry.name if relative == '.' else str(Path(relative) / entry.name)
                    info = entry.stat(follow_symlinks=False)
                    is_directory = bool(getattr(info, 'st_file_attributes', 0) & 0x10)
                    with ExitStack() as child_stack:
                        child_handles = _Handles(child_stack)
                        child_handles.leaf(child, directory=is_directory)
                        pinned_info = os.stat(child, follow_symlinks=False)
                        if (info.st_dev, info.st_ino) != (pinned_info.st_dev, pinned_info.st_ino):
                            raise DuplicateFolderError('source_changed')
                        if is_directory:
                            walk(child, child_relative, depth + 1)
                        else:
                            admit(child_relative, pinned_info)
        walk(folder, '.', 0)


def move_no_replace_windows(source: Path, destination: Path, expected_identity):
    with ExitStack() as stack:
        handles = _Handles(stack)
        source_handle = handles.chain(source, moving=True)
        handles.chain(destination.parent)
        source_info = os.stat(source, follow_symlinks=False)
        if (source_info.st_dev, source_info.st_ino) != tuple(expected_identity):
            raise DuplicateFolderError('source_changed')
        if source_info.st_dev != os.stat(destination.parent, follow_symlinks=False).st_dev:
            raise DuplicateFolderError('trash_volume_mismatch')
        rename = handles.kernel.SetFileInformationByHandle
        rename.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        rename.restype = wintypes.BOOL
        class RenameInfo(ctypes.Structure):
            _fields_ = [('replace', wintypes.BOOLEAN), ('root', wintypes.HANDLE),
                        ('length', wintypes.DWORD), ('name', wintypes.WCHAR * 1)]
        encoded = str(destination).encode('utf-16-le')
        value = ctypes.create_string_buffer(RenameInfo.name.offset + len(encoded))
        header = ctypes.cast(value, ctypes.POINTER(RenameInfo)).contents
        header.replace, header.root, header.length = False, None, len(encoded)
        ctypes.memmove(ctypes.addressof(value) + RenameInfo.name.offset, encoded, len(encoded))
        if not rename(source_handle, 3, value, len(value)):
            error = ctypes.get_last_error()
            if error in (80, 183):
                raise DuplicateFolderError('destination_occupied')
            raise ctypes.WinError(error)
        moved = os.stat(destination, follow_symlinks=False)
        if (moved.st_dev, moved.st_ino) != tuple(expected_identity):
            raise DuplicateFolderError('outcome_needs_review')
