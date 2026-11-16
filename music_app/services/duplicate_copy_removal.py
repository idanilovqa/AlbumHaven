"""Confirmed whole-folder removal for one exact duplicate album copy."""

import hmac
from pathlib import Path
import shutil
from time import perf_counter
from uuid import uuid4

from music_app.services.duplicate_copy_preview import (
    DuplicateCopyPreviewConflict,
    DuplicateCopyPreviewService,
)
from music_app.services.duplicate_copy_retirement import (
    ConfirmedDuplicateCopyRemoval,
    DuplicateCopyRetirementConflict,
    PhysicalFileGeneration,
)
from music_app.services.save_tasks import (
    acquire_structural_tag_edit_reservation,
    structural_tag_edit_resource_keys,
)
from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter


class DuplicateCopyRemovalConflict(ValueError):
    """The confirmed copy changed before removal."""


class DuplicateCopyRemovalRecoveryError(RuntimeError):
    """The staged folder could not be restored after publication failed."""


class DuplicateCopyRemovalCleanupPending(RuntimeError):
    """Inventory retirement committed but staged-folder cleanup failed."""


def _conflict():
    raise DuplicateCopyRemovalConflict(
        "The selected copy inventory changed. Refresh the copies before continuing."
    )


def _generation(row):
    return PhysicalFileGeneration(
        file_id=row["id"],
        track_id=row["track_id"],
        root_id=row["library_root_id"],
        modified_at=row["modified_at"],
        file_size_bytes=row["file_size_bytes"],
        last_seen_at=row["last_seen_at"],
    )


class DuplicateCopyRemovalService:
    def __init__(
        self,
        config,
        *,
        connect=None,
        publisher=None,
        reservation_acquirer=None,
        remove_tree=None,
    ):
        self._preview = DuplicateCopyPreviewService(config, connect=connect)
        self._publisher = publisher or PostgresScanCacheAdapter(config)
        self._reservation_acquirer = (
            reservation_acquirer or acquire_structural_tag_edit_reservation
        )
        self._remove_tree = remove_tree or shutil.rmtree

    @staticmethod
    def _matches_confirmation(prepared, confirmation_ref):
        expected = prepared.payload["confirmation_ref"]
        return (
            isinstance(confirmation_ref, str)
            and len(confirmation_ref) <= 128
            and hmac.compare_digest(confirmation_ref, expected)
        )

    def _prepare(self, **values):
        try:
            return self._preview.prepare(**values)
        except DuplicateCopyPreviewConflict:
            _conflict()

    @staticmethod
    def _restore(source, staged, publication_error):
        if source.exists() or not staged.exists():
            raise DuplicateCopyRemovalRecoveryError(
                "Duplicate-copy publication failed and the album folder could not be restored."
            ) from publication_error
        try:
            staged.replace(source)
        except OSError as restore_error:
            raise DuplicateCopyRemovalRecoveryError(
                "Duplicate-copy publication failed and the album folder could not be restored."
            ) from restore_error

    def remove(self, *, library_id, album_key, copy_ref, confirmation_ref):
        preview_values = dict(
            library_id=library_id,
            album_key=album_key,
            copy_ref=copy_ref,
        )
        # Per-step timings for the owner's "why is it so slow" (2026-11-16); logged with the result.
        phase_ms = self.last_phase_ms = {}
        started = mark = perf_counter()

        def lap(name):
            nonlocal mark
            now = perf_counter()
            phase_ms[name] = round((now - mark) * 1000, 1)
            mark = now

        prepared = self._prepare(**preview_values)
        if not self._matches_confirmation(prepared, confirmation_ref):
            _conflict()
        lap("prepare")
        all_paths = {
            str(row["private_path"])
            for row in (*prepared.selected_rows, *prepared.survivor_rows)
        }
        reservation = self._reservation_acquirer(
            structural_tag_edit_resource_keys(album_key, all_paths)
        )
        if reservation is None:
            _conflict()
        lap("reserve")
        staged = None
        try:
            prepared = self._prepare(**preview_values)
            if not self._matches_confirmation(prepared, confirmation_ref):
                _conflict()
            lap("prepare_again")
            source = prepared.album_root
            staged = source.with_name(f".albumhaven-delete-{uuid4().hex}")
            if staged.exists() or not source.is_dir():
                _conflict()
            try:
                source.replace(staged)
            except OSError:
                _conflict()
            lap("stage_folder")
            confirmation = ConfirmedDuplicateCopyRemoval(
                library_id=library_id,
                selected_files=tuple(_generation(row) for row in prepared.selected_rows),
                survivor_files=tuple(_generation(row) for row in prepared.survivor_rows),
                physical_deletion_confirmed=True,
            )
            publication = dict(
                    root_id=prepared.configured_root_id,
                    active_file_entries={},
                    confirmed_duplicate_removal=confirmation,
                )
            try:
                result = self._publisher.persist_targeted_inventory_mutation(**publication)
            except DuplicateCopyRetirementConflict as publication_error:
                self._restore(source, staged, publication_error)
                _conflict()
            except Exception as publication_error:
                try:
                    result = self._publisher.persist_targeted_inventory_mutation(**publication)
                except DuplicateCopyRetirementConflict as retry_error:
                    self._restore(source, staged, retry_error)
                    _conflict()
                except BaseException as retry_error:
                    self._restore(source, staged, retry_error)
                    raise retry_error from publication_error
            except BaseException as publication_error:
                self._restore(source, staged, publication_error)
                raise
            lap("retire_rows")
            try:
                self._remove_tree(staged)
            except OSError as cleanup_error:
                raise DuplicateCopyRemovalCleanupPending(
                    "The duplicate copy was retired, but final folder cleanup is still pending."
                ) from cleanup_error
            lap("delete_folder")
            phase_ms["total"] = round((perf_counter() - started) * 1000, 1)
            return result
        finally:
            reservation.release()
