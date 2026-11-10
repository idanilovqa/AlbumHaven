"""Short cover effects and shared physical-source ownership checks.

Preparation (provider requests, image decoding and candidate scoring) belongs
outside the transaction. Effects must compensate partial failures themselves
until they return their rollback handle. This is not crash-atomic media storage.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager, ExitStack
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path

from music_app.services.ordered_cover_references import (
    OrderedCoverSelectionConflict,
    project_selected_cover_metadata,
)


@contextmanager
def guarded_cover_transaction(transaction, commit_guard=None):
    """Execute SQL outside runtime locks; guard only this transaction's exit.

    Closing the explicit transaction context performs its commit, unlike calling
    connection.commit() inside psycopg's transaction() (which is prohibited).
    A stale guard must raise; unwinding the still-pending context rolls back.
    """
    with ExitStack() as pending:
        pending.enter_context(transaction)
        yield
        if commit_guard is not None:
            attempted = False
            committed = False

            def commit():
                nonlocal attempted, committed
                if attempted:
                    raise RuntimeError("Cover transaction commit was invoked more than once.")
                attempted = True
                pending.close()
                committed = True

            commit_guard(commit)
            if not committed:
                raise RuntimeError("Cover transaction guard did not commit.")


@dataclass
class CoverMutationEffect:
    selection: dict[str, object] | None = None
    value: object = None
    rollback: Callable[[], object] | None = None
    complete: Callable[[], object] | None = None
    ordered_selection: dict[str, object] | None = None


class CoverMutationFinalizationError(RuntimeError):
    """The database committed; restoring the old media would corrupt its state."""

    persisted = True

    def __init__(self, effect: CoverMutationEffect):
        super().__init__("Cover selection was persisted, but finalization failed. Reload the app.")
        self.effect = effect


class CoverMutationCommitUncertainError(RuntimeError):
    """The commit acknowledgement was lost; media must not be blindly restored."""

    persisted = None

    def __init__(self, effect: CoverMutationEffect):
        super().__init__("Cover save confirmation was interrupted. Reload to check the saved selection before retrying.")
        self.effect = effect


@dataclass(frozen=True)
class PreparedCoverTarget:
    """The pre-read state needed to compensate a prepared cover replacement."""

    path: Path
    stat: os.stat_result | None
    revision: str | None

    @classmethod
    def capture(cls, path: Path):
        try:
            stat = path.stat()
        except FileNotFoundError:
            return cls(path, None, None)
        revision = hashlib.sha256(path.read_bytes()).hexdigest()
        prepared = cls(path, stat, revision)
        prepared.revalidate()
        return prepared

    def revalidate(self):
        try:
            current = self.path.stat()
        except FileNotFoundError:
            current = None
        if self.stat is None and current is None:
            return
        if self.stat is None or current is None or any(
            getattr(current, field) != getattr(self.stat, field)
            for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
        ) or hashlib.sha256(self.path.read_bytes()).hexdigest() != self.revision:
            raise OrderedCoverSelectionConflict("The existing cover changed while artwork was prepared. Retry the selection.")

    def restore_compensated_timestamps(self):
        # Called only after a known-uncommitted media attempt, under source and
        # folder protection. Never overwrite bytes or restore timestamps on a
        # replacement that compensation did not restore to its original state.
        if self.stat is None:
            return
        try:
            current = self.path.stat()
        except FileNotFoundError:
            return
        if current.st_mtime_ns != self.stat.st_mtime_ns:
            return
        if hashlib.sha256(self.path.read_bytes()).hexdigest() == self.revision:
            os.utime(self.path, ns=(self.stat.st_atime_ns, self.stat.st_mtime_ns))


def cover_source_keys(path: Path) -> frozenset[str]:
    """Use filesystem identities, never library-prefixed or content-hash keys.

    Lexical keys protect replacements of a symlink itself; resolved keys protect
    aliases of its target. Inode keys also serialize existing hard-linked files.
    Missing files retain their path identity for unavailable saved references.
    """
    absolute = Path(os.path.abspath(path))
    resolved = absolute.resolve(strict=False)
    keys = {"path:" + os.path.normcase(str(item)) for item in (absolute, resolved)}
    try:
        stat = absolute.stat()
    except FileNotFoundError:
        pass
    else:
        keys.add(f"inode:{stat.st_dev}:{stat.st_ino}")
    return frozenset(keys)


def assert_ordered_sources_untouched(owners, affected_paths: tuple[Path, ...]) -> None:
    if not affected_paths:
        return
    affected_keys = set().union(*(cover_source_keys(path) for path in affected_paths))
    affected = tuple(path.resolve(strict=False) for path in affected_paths)
    conflict = "This image is selected by an album. Change its full cover selection before replacing or deleting it."
    for owner in owners:
        metadata = owner.get("metadata")
        if not isinstance(metadata, Mapping) or "selected_covers" not in metadata:
            continue
        primary = owner.get("cover_path")
        try:
            selection = project_selected_cover_metadata(metadata)
        except (ValueError, TypeError):
            # A malformed list cannot identify its sources reliably. Restrict
            # fail-closed fallback to its represented overlapping folders and
            # primary, rather than blocking every other album in the library.
            protected = [Path(primary)] if primary else []
            raw_selection = metadata.get("selected_covers")
            raw_items = raw_selection if isinstance(raw_selection, list) else [raw_selection]
            for item in raw_items:
                raw_path = item.get("path") if isinstance(item, Mapping) else item
                if isinstance(raw_path, str) and Path(raw_path).is_absolute():
                    protected.append(Path(raw_path))
            if any(cover_source_keys(path) & affected_keys for path in protected):
                raise OrderedCoverSelectionConflict(conflict)
            folders = [Path(path).resolve(strict=False).parent for path in owner.get("track_paths", ())]
            if any(
                path.is_relative_to(folder) or folder.is_relative_to(path.parent)
                for path in affected for folder in folders
            ):
                raise OrderedCoverSelectionConflict(conflict)
            continue
        protected = [Path(item["path"]) for item in selection["selected_covers"] if item["kind"] == "local"]
        if primary:
            protected.append(Path(primary))
        if any(cover_source_keys(path) & affected_keys for path in protected):
            raise OrderedCoverSelectionConflict(conflict)
