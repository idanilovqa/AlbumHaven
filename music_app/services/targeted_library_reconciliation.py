"""Targeted media parsing and Postgres inventory publication."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any

from music_app.services.library_indexing import enrich_library_file_entry
from music_app.services.library_roots import get_library_roots
from music_app.services.metadata import read_metadata_for_file
from music_app.services.save_tasks import structural_tag_edit_resource_keys


@dataclass(frozen=True, slots=True)
class TargetedReconciliationResult:
    revision: int
    affected_album_keys: tuple[str, ...]
    health: str = "healthy"


class TargetedLibraryReconciler:
    """Parse only event-selected media and publish one atomic mutation."""

    def __init__(
        self,
        config: dict[str, object],
        *,
        repository: Any,
        root_definitions: Iterable[dict[str, object]] | None = None,
        metadata_reader: Callable[[Path], dict[str, object]] = read_metadata_for_file,
        exception_overrides: dict[str, object] | None = None,
        exception_overrides_provider: (
            Callable[[], dict[str, object]] | None
        ) = None,
        after_commit: Callable[[TargetedReconciliationResult], object] | None = None,
        reservation_acquirer: Callable[[set[str]], object] | None = None,
    ) -> None:
        self._config = config
        self._repository = repository
        self._roots = tuple(root_definitions or get_library_roots(config))
        self._roots_lock = Lock()
        self._metadata_reader = metadata_reader
        self._exception_overrides = dict(exception_overrides or {})
        self._exception_overrides_provider = exception_overrides_provider
        self._after_commit = after_commit
        self._reservation_acquirer = reservation_acquirer

    def replace_roots(self, roots: Iterable[dict[str, object]]) -> None:
        with self._roots_lock:
            self._roots = tuple(dict(root) for root in roots)

    def reconcile(
        self,
        request: object,
        *,
        root_healthy: bool = True,
    ) -> TargetedReconciliationResult:
        root_id = str(getattr(request, "root_id", "") or "").strip()
        with self._roots_lock:
            root_definitions = self._roots
        primary_root = self._root_by_id(root_id, root_definitions)
        if primary_root is None:
            return TargetedReconciliationResult(0, (), "invalid_path")

        supported_extensions = {
            str(extension).casefold()
            for extension in self._config.get("SUPPORTED_EXTENSIONS", ())
        }

        def is_supported_media(path: Path) -> bool:
            return not supported_extensions or path.suffix.casefold() in supported_extensions

        deleted_paths = tuple(
            path
            for path in (Path(value) for value in getattr(request, "deleted_paths", ()))
            if is_supported_media(path)
        )
        deleted_subtrees = tuple(
            Path(path) for path in getattr(request, "deleted_subtrees", ())
        )
        moves = tuple(getattr(request, "moves", ()) or ())
        if not root_healthy and (deleted_paths or deleted_subtrees or moves):
            return TargetedReconciliationResult(0, (), "root_unhealthy")

        active_targets: list[tuple[Path, dict[str, object]]] = []
        for path in getattr(request, "paths", ()) or ():
            candidate = Path(path)
            if not self._belongs_to_root(candidate, primary_root):
                return TargetedReconciliationResult(0, (), "invalid_path")
            if is_supported_media(candidate):
                active_targets.append((candidate, primary_root))
        if not all(self._belongs_to_root(path, primary_root) for path in deleted_paths):
            return TargetedReconciliationResult(0, (), "invalid_path")
        if not all(self._belongs_to_root(path, primary_root) for path in deleted_subtrees):
            return TargetedReconciliationResult(0, (), "invalid_path")

        normalized_moves: list[dict[str, object]] = []
        for move in moves:
            source = Path(getattr(move, "source"))
            destination = Path(getattr(move, "destination"))
            source_root_id = str(getattr(move, "source_root_id", root_id) or root_id)
            destination_root_id = str(
                getattr(move, "destination_root_id", root_id) or root_id
            )
            source_root = self._root_by_id(source_root_id, root_definitions)
            destination_root = self._root_by_id(destination_root_id, root_definitions)
            if (
                source_root is None
                or destination_root is None
                or not self._belongs_to_root(source, source_root)
                or not self._belongs_to_root(destination, destination_root)
            ):
                return TargetedReconciliationResult(0, (), "invalid_path")
            is_directory = bool(getattr(move, "is_directory", False))
            if is_directory:
                deleted_subtrees += (source,)
                for media_path in self._supported_media_descendants(destination):
                    active_targets.append((media_path, destination_root))
            else:
                if is_supported_media(source):
                    deleted_paths += (source,)
                if is_supported_media(destination):
                    active_targets.append((destination, destination_root))
                if not is_supported_media(source) and not is_supported_media(destination):
                    continue
            normalized_moves.append(
                {
                    "source_path": str(source),
                    "destination_path": str(destination),
                    "source_root_id": source_root_id,
                    "destination_root_id": destination_root_id,
                    **({"is_directory": True} if is_directory else {}),
                }
            )

        if not active_targets and not deleted_paths and not deleted_subtrees and not normalized_moves:
            return TargetedReconciliationResult(0, ())

        expanded_targets: list[tuple[Path, dict[str, object]]] = []
        for candidate, matched_root in active_targets:
            expanded_targets.append((candidate, matched_root))
            expanded_targets.extend(
                (sibling, matched_root)
                for sibling in self._supported_media_siblings(candidate)
                if self._belongs_to_root(sibling, matched_root)
            )
        active_targets = expanded_targets

        folder_cover_cache: dict[str, object] = {}
        cover_metadata_cache: dict[
            str,
            tuple[int | None, int | None, str | None, int | None, int | None],
        ] = {}
        active_by_path = {
            str(candidate.resolve(strict=False)): (
                candidate.resolve(strict=False),
                root,
            )
            for candidate, root in active_targets
        }
        reservation_paths = set(active_by_path)
        reservation_paths.update(str(path) for path in deleted_paths)
        for move in normalized_moves:
            reservation_paths.add(str(move["source_path"]))
            reservation_paths.add(str(move["destination_path"]))
        reservation = None
        if self._reservation_acquirer is not None and reservation_paths:
            reservation = self._reservation_acquirer(
                structural_tag_edit_resource_keys(None, reservation_paths)
            )
        try:
            exception_overrides = (
                dict(self._exception_overrides_provider() or {})
                if self._exception_overrides_provider is not None
                else self._exception_overrides
            )
            active_entries: dict[str, dict[str, object]] = {}
            for path, matched_root in sorted(
                active_by_path.values(),
                key=lambda item: str(item[0]).casefold(),
            ):
                entry = self._metadata_reader(path)
                enriched = enrich_library_file_entry(
                    entry,
                    path=path,
                    root_definition=matched_root,
                    image_extensions=set(self._config.get("IMAGE_EXTENSIONS") or set()),
                    exception_overrides=exception_overrides,
                    folder_cover_cache=folder_cover_cache,
                    cover_metadata_cache=cover_metadata_cache,
                )
                active_entries[str(path)] = enriched

            persisted = self._repository.persist_targeted_inventory_mutation(
                root_id=root_id,
                active_file_entries=active_entries,
                deleted_paths=tuple(dict.fromkeys(str(path) for path in deleted_paths)),
                deleted_subtrees=tuple(dict.fromkeys(str(path) for path in deleted_subtrees)),
                moves=tuple(normalized_moves),
            )
            result = TargetedReconciliationResult(
                int(persisted.get("inventory_mutation_revision") or 0),
                tuple(
                    sorted(
                        {
                            str(key)
                            for key in persisted.get("affected_album_keys", ())
                            if str(key)
                        }
                    )
                ),
            )
            if self._after_commit is not None:
                self._after_commit(result)
            return result
        finally:
            release = getattr(reservation, "release", None)
            if callable(release):
                release()

    def _root_by_id(
        self,
        root_id: str,
        root_definitions: tuple[dict[str, object], ...] | None = None,
    ) -> dict[str, object] | None:
        return next(
            (
                root
                for root in (self._roots if root_definitions is None else root_definitions)
                if str(root.get("id") or "").strip() == root_id
            ),
            None,
        )

    @staticmethod
    def _belongs_to_root(path: Path, root: dict[str, object]) -> bool:
        try:
            path.resolve(strict=False).relative_to(
                Path(str(root.get("path") or "")).resolve(strict=False)
            )
        except (OSError, ValueError):
            return False
        return True

    def _supported_media_descendants(self, directory: Path) -> tuple[Path, ...]:
        supported = {
            str(extension).casefold()
            for extension in self._config.get("SUPPORTED_EXTENSIONS", ())
        }
        if not supported or not directory.is_dir():
            return ()
        return tuple(
            path
            for path in directory.rglob("*")
            if path.is_file() and path.suffix.casefold() in supported
        )

    def _supported_media_siblings(self, path: Path) -> tuple[Path, ...]:
        supported = {
            str(extension).casefold()
            for extension in self._config.get("SUPPORTED_EXTENSIONS", ())
        }
        if not supported or not path.parent.is_dir():
            return ()
        return tuple(
            sibling
            for sibling in path.parent.iterdir()
            if sibling != path
            and sibling.is_file()
            and sibling.suffix.casefold() in supported
        )
