from __future__ import annotations

from collections.abc import Callable, Collection, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
import hashlib
from pathlib import Path
import stat
from typing import ContextManager, Literal

from music_app.services.cover_workflow import _atomic_replace_file_bytes
from music_app.services.postgres_connections import cover_lock_connection


_COVER_LOCK_NAMESPACE = b"album-haven:cover-mutation:v1\0"


@dataclass(frozen=True, slots=True)
class CoverMutationIdentity:
    library_id: int
    local_album_id: int

    def __post_init__(self) -> None:
        if self.library_id < 0 or self.local_album_id < 0:
            raise ValueError("cover mutation identity values must be non-negative")


@dataclass(frozen=True, slots=True)
class CoverMutationBaseline:
    inventory_revision: int
    cover_mutation_revision: int
    selected_cover_revision: str | None
    selected_cover_path: str | None


@dataclass(frozen=True, slots=True)
class CoverArtifactIdentity:
    private_path: Path | None
    sha256: str | None
    post_write_exists: bool
    selected_cover_path: str | None
    promoted_cover_revision: str | None
    prior_cover_existed: bool
    prior_cover_bytes: bytes | None
    prior_cover_atime_ns: int | None = None
    prior_cover_mtime_ns: int | None = None
    local_cover_width: int | None = None
    local_cover_height: int | None = None

    def __post_init__(self) -> None:
        if self.private_path is None:
            if (
                self.post_write_exists
                or self.selected_cover_path is not None
                or self.prior_cover_existed
                or self.prior_cover_bytes is not None
                or self.prior_cover_atime_ns is not None
                or self.prior_cover_mtime_ns is not None
                or self.local_cover_width is not None
                or self.local_cover_height is not None
            ):
                raise ValueError(
                    "linked remote artifacts cannot carry local artifact identity"
                )
            if (self.sha256 is None) != (self.promoted_cover_revision is None):
                raise ValueError("linked remote digest and revision must be paired")
            if self.sha256 is not None and (
                len(self.sha256) != 64
                or any(character not in "0123456789abcdef" for character in self.sha256)
            ):
                raise ValueError("linked remote digest must be lowercase SHA256")
            return
        elif self.post_write_exists != (self.sha256 is not None):
            raise ValueError("local artifact existence and digest must agree")
        elif self.post_write_exists and (
            self.selected_cover_path is None or self.promoted_cover_revision is None
        ):
            raise ValueError("written local artifacts require a selected path and revision")
        elif not self.post_write_exists and (
            not self.prior_cover_existed or self.prior_cover_bytes is None
        ):
            raise ValueError("deleted artifacts require prior cover bytes")
        elif not self.post_write_exists and (
            (self.selected_cover_path is None)
            != (self.promoted_cover_revision is None)
        ):
            raise ValueError(
                "deleted artifacts require paired fallback selection fields"
            )
        if self.prior_cover_existed != (self.prior_cover_bytes is not None):
            raise ValueError("prior cover bytes must match prior cover existence")


@dataclass(frozen=True, slots=True)
class CoverMutationRequest:
    library_id: int
    track_paths: Sequence[str]
    album_root: Path
    selected_origin: Literal["user", "automatic"] | None
    clear_selection: bool
    remote_cover: Mapping[str, object] | None
    job_id: int | None
    attempt: int | None
    worker_id: str | None
    lease_token: str | None
    task_id: int | None
    checkpoint_revision: int | None
    explicit_selection: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.clear_selection, bool):
            raise TypeError("clear_selection must be a boolean")
        if not isinstance(self.explicit_selection, bool):
            raise TypeError("explicit_selection must be a boolean")
        claim = (
            self.job_id,
            self.attempt,
            self.worker_id,
            self.lease_token,
            self.task_id,
            self.checkpoint_revision,
        )
        if any(value is None for value in claim) != all(
            value is None for value in claim
        ):
            raise ValueError("durable cover claim fields must be all set or all null")


class CoverMutationStatus(StrEnum):
    COMMITTED = "committed"
    CANCELED = "canceled"
    AMBIGUOUS = "ambiguous"


CoverMutationConflictReason = Literal[
    "inventory_revision_conflict",
    "revision_conflict",
    "identity_conflict",
    "selection_conflict",
]


class CoverMutationConflict(RuntimeError):
    def __init__(self, reason_code: CoverMutationConflictReason) -> None:
        self.reason_code = reason_code
        super().__init__(reason_code)


class CoverMutationRetryRequired(RuntimeError):
    pass


class CommitOutcomeUnknown(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class CoverMutationOutcome:
    status: CoverMutationStatus
    cover_mutation_revision: int | None = None
    selected_cover_revision: str | None = None
    checkpoint: Literal[
        "authority_committed", "runtime_published", "publication_completed"
    ] | None = None
    library_id: int | None = None
    local_album_id: int | None = None
    task_id: int | None = None
    finalization_checkpoint_id: int | None = None
    finalization_checkpoint_revision: int | None = None


@dataclass(frozen=True, slots=True)
class CoverSelectionCommit:
    identity: CoverMutationIdentity
    track_paths: Sequence[str]
    expected_inventory_revision: int
    expected_cover_mutation_revision: int
    expected_selected_cover_revision: str | None
    selected_cover_path: str | None
    promoted_cover_revision: str | None
    selected_origin: Literal["user", "automatic"] | None
    clear_selection: bool
    remote_cover: Mapping[str, object] | None
    artifact_sha256: str | None
    observed_at: datetime
    job_id: int | None
    attempt: int | None
    worker_id: str | None
    lease_token: str | None
    task_id: int | None
    checkpoint_revision: int | None
    explicit_selection: bool = False
    local_cover_width: int | None = None
    local_cover_height: int | None = None

    def __post_init__(self) -> None:
        claim = (
            self.job_id,
            self.attempt,
            self.worker_id,
            self.lease_token,
            self.task_id,
            self.checkpoint_revision,
        )
        if any(value is None for value in claim) != all(
            value is None for value in claim
        ):
            raise ValueError("durable cover claim fields must be all set or all null")


@dataclass(frozen=True, slots=True)
class CoverMutationRecovery:
    identity: CoverMutationIdentity
    expected_inventory_revision: int
    expected_cover_mutation_revision: int
    expected_selected_cover_revision: str | None
    promoted_cover_revision: str | None
    artifact_sha256: str | None
    job_id: int
    attempt: int
    worker_id: str
    lease_token: str
    task_id: int
    checkpoint_revision: int
    observed_at: datetime


def cover_advisory_keys(identity: CoverMutationIdentity) -> tuple[int, int]:
    digest = hashlib.sha256(
        _COVER_LOCK_NAMESPACE
        + identity.library_id.to_bytes(8, "big", signed=False)
        + identity.local_album_id.to_bytes(8, "big", signed=False)
    ).digest()
    first, second = (
        int.from_bytes(digest[offset : offset + 4], "big", signed=True)
        for offset in (0, 4)
    )
    return first, second


def _unlock_result(row: object) -> bool:
    if row is None:
        return False
    try:
        return bool(row["pg_advisory_unlock"])  # type: ignore[index]
    except (KeyError, TypeError):
        return bool(row[0])  # type: ignore[index]


@contextmanager
def serialize_cover_mutation(
    *,
    config: Mapping[str, object],
    identity: CoverMutationIdentity,
    acquire_local_lock: Callable[[], ContextManager[None]],
):
    database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
    keys = cover_advisory_keys(identity)
    with cover_lock_connection(database_url) as connection:
        try:
            connection.execute("select pg_advisory_lock(%s, %s)", keys)
        except Exception:
            connection.close()
            raise
        try:
            with acquire_local_lock():
                yield
        finally:
            try:
                row = connection.execute(
                    "select pg_advisory_unlock(%s, %s)", keys
                ).fetchone()
                if not _unlock_result(row):
                    raise RuntimeError("cover advisory lock release was not confirmed")
            except Exception:
                connection.close()


def _baseline_changed(
    identity: CoverMutationIdentity,
    baseline: CoverMutationBaseline,
    locked_identity: CoverMutationIdentity,
    locked_baseline: CoverMutationBaseline,
) -> bool:
    return (
        locked_identity != identity
        or locked_baseline.inventory_revision != baseline.inventory_revision
        or locked_baseline.cover_mutation_revision != baseline.cover_mutation_revision
        or locked_baseline.selected_cover_revision != baseline.selected_cover_revision
    )


def execute_cover_mutation(
    *, request: CoverMutationRequest, dependencies
) -> CoverMutationOutcome:
    def compensate(
        baseline: CoverMutationBaseline,
        identity: CoverMutationIdentity,
        artifact: CoverArtifactIdentity,
    ) -> CoverMutationOutcome | None:
        try:
            dependencies.compensate(
                baseline=baseline,
                identity=identity,
                library_id=request.library_id,
                track_paths=request.track_paths,
                artifact=artifact,
            )
        except CommitOutcomeUnknown:
            return CoverMutationOutcome(status=CoverMutationStatus.AMBIGUOUS)
        return None

    for preparation_attempt in range(2):
        identity = dependencies.resolve_identity(
            library_id=request.library_id, track_paths=request.track_paths
        )
        baseline = dependencies.load_baseline(identity=identity)
        prepared = dependencies.prepare(request, baseline)
        needs_prewrite_cleanup = True
        try:
            with serialize_cover_mutation(
                config=dependencies.config,
                identity=identity,
                acquire_local_lock=lambda: dependencies.local_lock(request.album_root),
            ):
                locked_identity = dependencies.resolve_identity(
                    library_id=request.library_id, track_paths=request.track_paths
                )
                locked_baseline = dependencies.load_baseline(identity=locked_identity)
                if _baseline_changed(
                    identity, baseline, locked_identity, locked_baseline
                ):
                    needs_prewrite_cleanup = False
                    dependencies.cleanup_prepared(prepared)
                    if preparation_attempt == 0:
                        continue
                    raise CoverMutationRetryRequired(
                        "cover mutation baseline changed twice"
                    )
                if dependencies.should_cancel():
                    needs_prewrite_cleanup = False
                    dependencies.cleanup_prepared(prepared)
                    return CoverMutationOutcome(status=CoverMutationStatus.CANCELED)
                artifact = dependencies.write_artifact(prepared, locked_baseline)
                needs_prewrite_cleanup = False
                try:
                    canceled = dependencies.should_cancel()
                    if not canceled:
                        checkpoint_revision = request.checkpoint_revision
                        prepare_commit = getattr(dependencies, "prepare_commit", None)
                        if callable(prepare_commit):
                            checkpoint_revision = prepare_commit(artifact)
                            canceled = dependencies.should_cancel()
                    if not canceled:
                        clear_selection = request.clear_selection or (
                            artifact.selected_cover_path is None
                            and request.remote_cover is None
                        )
                        commit_request = CoverSelectionCommit(
                            identity=locked_identity,
                            track_paths=tuple(request.track_paths),
                            expected_inventory_revision=locked_baseline.inventory_revision,
                            expected_cover_mutation_revision=locked_baseline.cover_mutation_revision,
                            expected_selected_cover_revision=locked_baseline.selected_cover_revision,
                            selected_cover_path=artifact.selected_cover_path,
                            promoted_cover_revision=artifact.promoted_cover_revision,
                            selected_origin=(
                                None if clear_selection else request.selected_origin
                            ),
                            clear_selection=clear_selection,
                            remote_cover=request.remote_cover,
                            artifact_sha256=artifact.sha256,
                            observed_at=dependencies.clock(),
                            job_id=request.job_id,
                            attempt=request.attempt,
                            worker_id=request.worker_id,
                            lease_token=request.lease_token,
                            task_id=request.task_id,
                            checkpoint_revision=checkpoint_revision,
                            explicit_selection=(False if clear_selection else request.explicit_selection),
                            local_cover_width=artifact.local_cover_width,
                            local_cover_height=artifact.local_cover_height,
                        )
                except Exception:
                    failure = compensate(locked_baseline, locked_identity, artifact)
                    if failure is not None:
                        return failure
                    dependencies.cleanup_prepared(prepared)
                    raise
                if canceled:
                    failure = compensate(locked_baseline, locked_identity, artifact)
                    if failure is not None:
                        return failure
                    dependencies.cleanup_prepared(prepared)
                    return CoverMutationOutcome(status=CoverMutationStatus.CANCELED)
                try:
                    outcome = dependencies.commit(commit_request)
                except CoverMutationConflict as exc:
                    failure = compensate(locked_baseline, locked_identity, artifact)
                    if failure is not None:
                        return failure
                    dependencies.cleanup_prepared(prepared)
                    if preparation_attempt == 0:
                        continue
                    raise CoverMutationRetryRequired(exc.reason_code) from exc
                except CommitOutcomeUnknown:
                    try:
                        outcome = dependencies.recover(commit_request, artifact)
                    except Exception:
                        return CoverMutationOutcome(
                            status=CoverMutationStatus.AMBIGUOUS
                        )
                except Exception:
                    failure = compensate(locked_baseline, locked_identity, artifact)
                    if failure is not None:
                        return failure
                    dependencies.cleanup_prepared(prepared)
                    raise
                if outcome.status is CoverMutationStatus.CANCELED:
                    failure = compensate(locked_baseline, locked_identity, artifact)
                    if failure is not None:
                        return failure
                    dependencies.cleanup_prepared(prepared)
                    return outcome
                if outcome.status is CoverMutationStatus.AMBIGUOUS:
                    return outcome
                if outcome.status is CoverMutationStatus.COMMITTED:
                    assert (
                        outcome.cover_mutation_revision is not None
                        or outcome.finalization_checkpoint_revision is not None
                    )
                    publish_committed = getattr(
                        dependencies, "publish_committed", None
                    )
                    if callable(publish_committed):
                        publish_committed(outcome, artifact)
                    return outcome
                raise AssertionError(
                    f"unknown cover mutation outcome status: {outcome.status!r}"
                )
        except Exception:
            if needs_prewrite_cleanup:
                dependencies.cleanup_prepared(prepared)
            raise
    raise AssertionError("two-attempt cover mutation loop exhausted")


def compensate_if_still_owned(
    *,
    repository,
    baseline: CoverMutationBaseline,
    identity: CoverMutationIdentity,
    library_id: int,
    track_paths: Collection[str],
    artifact: CoverArtifactIdentity,
    restore_artifact: Callable[[CoverArtifactIdentity], None] | None = None,
) -> None:
    try:
        current_identity = repository.resolve_identity(
            library_id=library_id, track_paths=track_paths
        )
    except CommitOutcomeUnknown:
        raise
    except Exception as exc:
        raise CommitOutcomeUnknown(
            "cover identity could not be resolved before compensation"
        ) from exc
    if current_identity != identity:
        raise CommitOutcomeUnknown("cover identity changed before compensation")
    try:
        current = repository.load_baseline(identity=identity)
    except CommitOutcomeUnknown:
        raise
    except Exception as exc:
        raise CommitOutcomeUnknown(
            "cover authority could not be loaded before compensation"
        ) from exc
    try:
        authority_changed = (
            current.cover_mutation_revision != baseline.cover_mutation_revision
            or current.selected_cover_revision != baseline.selected_cover_revision
            or current.selected_cover_path != baseline.selected_cover_path
        )
    except CommitOutcomeUnknown:
        raise
    except Exception as exc:
        raise CommitOutcomeUnknown(
            "cover authority could not be verified before compensation"
        ) from exc
    if authority_changed:
        raise CommitOutcomeUnknown("cover authority advanced before compensation")
    if artifact.private_path is None:
        return
    try:
        path_stat = artifact.private_path.lstat()
    except FileNotFoundError:
        path_stat = None
    except CommitOutcomeUnknown:
        raise
    except Exception as exc:
        raise CommitOutcomeUnknown(
            "cover artifact path could not be inspected"
        ) from exc
    if path_stat is not None and not stat.S_ISREG(path_stat.st_mode):
        raise CommitOutcomeUnknown("cover artifact path is not a regular file")
    if artifact.post_write_exists:
        try:
            contents = (
                artifact.private_path.read_bytes() if path_stat is not None else None
            )
        except CommitOutcomeUnknown:
            raise
        except Exception as exc:
            raise CommitOutcomeUnknown(
                "promoted cover artifact could not be read"
            ) from exc
        if artifact.sha256 is None or contents is None:
            raise CommitOutcomeUnknown("promoted cover artifact disappeared")
        if hashlib.sha256(contents).hexdigest() != artifact.sha256:
            raise CommitOutcomeUnknown("promoted cover artifact identity changed")
    else:
        if path_stat is not None:
            raise CommitOutcomeUnknown(
                "deleted cover path was recreated before compensation"
            )
    try:
        if restore_artifact is not None:
            restore_artifact(artifact)
        elif artifact.prior_cover_existed:
            assert artifact.prior_cover_bytes is not None
            _atomic_replace_file_bytes(
                artifact.private_path,
                artifact.prior_cover_bytes,
                atime_ns=artifact.prior_cover_atime_ns,
                mtime_ns=artifact.prior_cover_mtime_ns,
            )
        else:
            artifact.private_path.unlink(missing_ok=True)
    except CommitOutcomeUnknown:
        raise
    except Exception as exc:
        raise CommitOutcomeUnknown("cover artifact compensation failed") from exc
