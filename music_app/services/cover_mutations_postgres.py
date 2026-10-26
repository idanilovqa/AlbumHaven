"""PostgreSQL authority for coordinated cover mutations."""

from __future__ import annotations

from collections.abc import Callable, Collection, Mapping
from datetime import datetime
from typing import Any

try:  # pragma: no cover - driver availability is environment-specific.
    import psycopg
    from psycopg import InterfaceError, OperationalError
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover
    psycopg = None
    InterfaceError = OperationalError = None
    dict_row = Jsonb = None

from music_app.services.cover_mutation_coordinator import (
    CommitOutcomeUnknown,
    CoverMutationBaseline,
    CoverMutationConflict,
    CoverMutationIdentity,
    CoverMutationOutcome,
    CoverMutationRecovery,
    CoverMutationRetryRequired,
    CoverMutationStatus,
    CoverSelectionCommit,
)


_CONNECTION_ERRORS = tuple(
    error for error in (OperationalError, InterfaceError) if error is not None
)
_UNKNOWN_COMMIT_SQLSTATES = {"57P01", "57P02"}
_CONFLICT_REASONS = {
    "inventory_revision_conflict",
    "revision_conflict",
    "identity_conflict",
    "selection_conflict",
}


def _commit_connection_lost(error: BaseException) -> bool:
    sqlstate = getattr(error, "sqlstate", None)
    return (
        sqlstate is None
        or str(sqlstate).startswith("08")
        or sqlstate in _UNKNOWN_COMMIT_SQLSTATES
    )


def _default_connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for cover mutation persistence")
    return psycopg.connect(database_url, row_factory=dict_row)


def _mapping(row: object) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}  # type: ignore[index]
    return {}


def _positive_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _nonnegative_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    return value


def _optional_nonnegative_int(value: object, name: str) -> int | None:
    return None if value is None else _nonnegative_int(value, name)


def _required_text(value: object, name: str, *, maximum: int = 512) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    normalized = value.strip()
    if not normalized or len(normalized) > maximum:
        raise ValueError(f"{name} must be a bounded nonblank string")
    return normalized


def _optional_text(value: object, name: str) -> str | None:
    return None if value is None else _required_text(value, name)


def _database_optional_text(value: object, name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    return value.strip() or None


def _aware_datetime(value: object, name: str) -> datetime:
    if (
        not isinstance(value, datetime)
        or value.tzinfo is None
        or value.utcoffset() is None
    ):
        raise ValueError(f"{name} must be timezone-aware")
    return value


def _sha256(value: object, name: str, *, required: bool) -> str | None:
    if value is None and not required:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"{name} must be a lowercase SHA-256 digest")
    return value


def _identity(value: object) -> CoverMutationIdentity:
    if not isinstance(value, CoverMutationIdentity):
        raise TypeError("identity must be a cover mutation identity")
    return CoverMutationIdentity(
        library_id=_positive_int(value.library_id, "library_id"),
        local_album_id=_positive_int(value.local_album_id, "local_album_id"),
    )


def _track_paths(values: object) -> list[str]:
    if isinstance(values, (str, bytes)) or not isinstance(values, Collection):
        raise TypeError("track_paths must be a collection")
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            raise TypeError("track_paths must contain strings")
        path = value.strip()
        if not path:
            raise ValueError("track_paths must contain nonblank paths")
        if path not in seen:
            normalized.append(path)
            seen.add(path)
    if not normalized:
        raise ValueError("track_paths must not be empty")
    return normalized


def _claim_fields(
    *,
    job_id: object,
    attempt: object,
    worker_id: object,
    lease_token: object,
    task_id: object,
    checkpoint_revision: object,
    required: bool,
) -> dict[str, object]:
    values = (job_id, attempt, worker_id, lease_token, task_id, checkpoint_revision)
    if not required and all(value is None for value in values):
        return {
            "job_id": None,
            "attempt": None,
            "worker_id": None,
            "lease_token": None,
            "task_id": None,
            "checkpoint_revision": None,
        }
    if any(value is None for value in values):
        raise ValueError("durable cover claim fields must be all set or all null")
    return {
        "job_id": _positive_int(job_id, "job_id"),
        "attempt": _positive_int(attempt, "attempt"),
        "worker_id": _required_text(worker_id, "worker_id"),
        "lease_token": _required_text(lease_token, "lease_token"),
        "task_id": _positive_int(task_id, "task_id"),
        "checkpoint_revision": _nonnegative_int(
            checkpoint_revision, "checkpoint_revision"
        ),
    }


def _json_value(value: Mapping[str, object] | None) -> object:
    if value is None:
        return None
    payload = dict(value)
    return Jsonb(payload) if Jsonb is not None else payload


class PostgresCoverMutationRepository:
    def __init__(
        self,
        *,
        database_url: str,
        connect_to_database: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = _required_text(database_url, "database_url", maximum=8192)
        self._connect_to_database = connect_to_database or _default_connect

    @staticmethod
    def _set_timeout(connection: Any) -> None:
        connection.execute("SET LOCAL statement_timeout = '15s'")

    def current_library_revision(self, *, library_id: int) -> int:
        parameters = {"library_id": _positive_int(library_id, "library_id")}
        with self._connect_to_database(self._database_url) as connection:
            self._set_timeout(connection)
            row = connection.execute(
                "select library.read_cover_mutation_revision(%(library_id)s) as revision",
                parameters,
            ).fetchone()
        payload = _mapping(row)
        if not payload:
            raise ValueError("cover revision query returned no row")
        return _nonnegative_int(payload.get("revision"), "revision")

    def resolve_identity(
        self, *, library_id: int, track_paths: Collection[str]
    ) -> CoverMutationIdentity:
        requested_library_id = _positive_int(library_id, "library_id")
        parameters = {
            "library_id": requested_library_id,
            "track_paths": _track_paths(track_paths),
        }
        with self._connect_to_database(self._database_url) as connection:
            self._set_timeout(connection)
            rows = connection.execute(
                """
                select *
                from library.resolve_cover_mutation_identity(
                    %(library_id)s,
                    %(track_paths)s::text[]
                )
                """,
                parameters,
            ).fetchall()
        if len(rows) != 1:
            raise CoverMutationRetryRequired("cover album identity no longer resolves")
        payload = _mapping(rows[0])
        resolved_library_id = _positive_int(payload.get("library_id"), "library_id")
        if resolved_library_id != requested_library_id:
            raise ValueError("resolved cover identity belongs to a different library")
        return CoverMutationIdentity(
            library_id=resolved_library_id,
            local_album_id=_positive_int(
                payload.get("local_album_id"), "local_album_id"
            ),
        )

    def load_baseline(self, *, identity: CoverMutationIdentity) -> CoverMutationBaseline:
        validated_identity = _identity(identity)
        parameters = {
            "library_id": validated_identity.library_id,
            "album_id": validated_identity.local_album_id,
        }
        with self._connect_to_database(self._database_url) as connection:
            self._set_timeout(connection)
            row = connection.execute(
                """
                select
                    coalesce(
                        nullif(library_row.metadata ->> 'inventory_mutation_revision', '')::bigint,
                        0
                    ) as inventory_revision,
                    coalesce(state.cover_mutation_revision, 0) as cover_mutation_revision,
                    nullif(album.metadata ->> 'cover_revision', '') as selected_cover_revision,
                    nullif(album.cover_path, '') as selected_cover_path
                from library.libraries library_row
                join library.local_albums album
                  on album.library_id = library_row.id
                 and album.id = %(album_id)s
                left join library.cover_mutation_state state
                  on state.library_id = library_row.id
                where library_row.id = %(library_id)s
                """,
                parameters,
            ).fetchone()
        payload = _mapping(row)
        if not payload:
            raise CoverMutationRetryRequired("cover album identity no longer exists")
        return CoverMutationBaseline(
            inventory_revision=_nonnegative_int(
                payload.get("inventory_revision"), "inventory_revision"
            ),
            cover_mutation_revision=_nonnegative_int(
                payload.get("cover_mutation_revision"), "cover_mutation_revision"
            ),
            selected_cover_revision=_database_optional_text(
                payload.get("selected_cover_revision"), "selected_cover_revision"
            ),
            selected_cover_path=_database_optional_text(
                payload.get("selected_cover_path"), "selected_cover_path"
            ),
        )

    def commit_selection(self, *, request: CoverSelectionCommit) -> CoverMutationOutcome:
        parameters = self._commit_parameters(request)
        connection = self._connect_to_database(self._database_url)
        may_have_committed = False
        outcome_unknown = False
        try:
            with connection:
                self._set_timeout(connection)
                may_have_committed = True
                row = connection.execute(
                    """
                    select *
                    from library.commit_cover_selection(
                        %(library_id)s,
                        %(album_id)s,
                        %(track_paths)s::text[],
                        %(expected_inventory_revision)s,
                        %(expected_cover_mutation_revision)s,
                        %(expected_selected_cover_revision)s,
                        %(selected_cover_path)s,
                        %(promoted_cover_revision)s,
                        %(selected_origin)s,
                        %(clear_selection)s,
                        %(remote_cover)s::jsonb,
                        %(artifact_sha256)s,
                        %(job_id)s,
                        %(attempt)s,
                        %(worker_id)s,
                        %(lease_token)s,
                        %(task_id)s,
                        %(checkpoint_revision)s,
                        %(observed_at)s
                    )
                    """,
                    parameters,
                ).fetchone()
        except _CONNECTION_ERRORS as exc:
            if not may_have_committed or not _commit_connection_lost(exc):
                raise
            outcome_unknown = True
        if outcome_unknown:
            raise CommitOutcomeUnknown("cover mutation commit outcome is unknown")
        return self._commit_outcome(request, row)

    def recover_ambiguous(
        self, *, request: CoverMutationRecovery
    ) -> CoverMutationOutcome:
        parameters = self._recovery_parameters(request)
        with self._connect_to_database(self._database_url) as connection:
            self._set_timeout(connection)
            row = connection.execute(
                """
                select *
                from library.recover_cover_mutation(
                    %(library_id)s,
                    %(album_id)s,
                    %(expected_inventory_revision)s,
                    %(expected_cover_mutation_revision)s,
                    %(expected_selected_cover_revision)s,
                    %(promoted_cover_revision)s,
                    %(artifact_sha256)s,
                    %(job_id)s,
                    %(attempt)s,
                    %(worker_id)s,
                    %(lease_token)s,
                    %(task_id)s,
                    %(checkpoint_revision)s,
                    %(observed_at)s
                )
                """,
                parameters,
            ).fetchone()
        return self._recovery_outcome(request, row)

    @staticmethod
    def _commit_parameters(request: CoverSelectionCommit) -> dict[str, object]:
        if not isinstance(request, CoverSelectionCommit):
            raise TypeError("request must be a cover selection commit")
        identity = _identity(request.identity)
        track_paths = _track_paths(request.track_paths)
        expected_selected_cover_revision = _optional_text(
            request.expected_selected_cover_revision,
            "expected_selected_cover_revision",
        )
        selected_cover_path = _optional_text(
            request.selected_cover_path, "selected_cover_path"
        )
        promoted_cover_revision = _optional_text(
            request.promoted_cover_revision, "promoted_cover_revision"
        )
        selected_origin = _optional_text(request.selected_origin, "selected_origin")
        if selected_origin not in (None, "user", "automatic"):
            raise ValueError("selected_origin must be user or automatic")
        if not isinstance(request.clear_selection, bool):
            raise TypeError("clear_selection must be a boolean")
        if request.remote_cover is not None and not isinstance(
            request.remote_cover, Mapping
        ):
            raise TypeError("remote_cover must be an object")
        if request.clear_selection:
            if any(
                value is not None
                for value in (
                    selected_cover_path,
                    promoted_cover_revision,
                    selected_origin,
                    request.remote_cover,
                )
            ):
                raise ValueError("clear selection cannot carry replacement state")
        else:
            if promoted_cover_revision is None or selected_origin is None:
                raise ValueError("replacement selection requires revision and origin")
            if request.remote_cover is None and selected_cover_path is None:
                raise ValueError("local replacement requires selected cover path")
            if request.remote_cover is not None and selected_cover_path is not None:
                raise ValueError("remote replacement cannot carry a local cover path")
        claim = _claim_fields(
            job_id=request.job_id,
            attempt=request.attempt,
            worker_id=request.worker_id,
            lease_token=request.lease_token,
            task_id=request.task_id,
            checkpoint_revision=request.checkpoint_revision,
            required=False,
        )
        artifact_sha256 = _sha256(
            request.artifact_sha256,
            "artifact_sha256",
            required=claim["job_id"] is not None,
        )
        return {
            "library_id": identity.library_id,
            "album_id": identity.local_album_id,
            "track_paths": track_paths,
            "expected_inventory_revision": _nonnegative_int(
                request.expected_inventory_revision, "expected_inventory_revision"
            ),
            "expected_cover_mutation_revision": _nonnegative_int(
                request.expected_cover_mutation_revision,
                "expected_cover_mutation_revision",
            ),
            "expected_selected_cover_revision": expected_selected_cover_revision,
            "selected_cover_path": selected_cover_path,
            "promoted_cover_revision": promoted_cover_revision,
            "selected_origin": selected_origin,
            "clear_selection": request.clear_selection,
            "remote_cover": _json_value(request.remote_cover),
            "artifact_sha256": artifact_sha256,
            **claim,
            "observed_at": _aware_datetime(request.observed_at, "observed_at"),
        }

    @staticmethod
    def _recovery_parameters(request: CoverMutationRecovery) -> dict[str, object]:
        if not isinstance(request, CoverMutationRecovery):
            raise TypeError("request must be a cover mutation recovery")
        identity = _identity(request.identity)
        claim = _claim_fields(
            job_id=request.job_id,
            attempt=request.attempt,
            worker_id=request.worker_id,
            lease_token=request.lease_token,
            task_id=request.task_id,
            checkpoint_revision=request.checkpoint_revision,
            required=True,
        )
        return {
            "library_id": identity.library_id,
            "album_id": identity.local_album_id,
            "expected_inventory_revision": _nonnegative_int(
                request.expected_inventory_revision, "expected_inventory_revision"
            ),
            "expected_cover_mutation_revision": _nonnegative_int(
                request.expected_cover_mutation_revision,
                "expected_cover_mutation_revision",
            ),
            "expected_selected_cover_revision": _optional_text(
                request.expected_selected_cover_revision,
                "expected_selected_cover_revision",
            ),
            "promoted_cover_revision": _required_text(
                request.promoted_cover_revision, "promoted_cover_revision"
            ),
            "artifact_sha256": _sha256(
                request.artifact_sha256, "artifact_sha256", required=True
            ),
            **claim,
            "observed_at": _aware_datetime(request.observed_at, "observed_at"),
        }

    @staticmethod
    def _commit_outcome(
        request: CoverSelectionCommit, row: object
    ) -> CoverMutationOutcome:
        payload = _mapping(row)
        if not payload:
            raise ValueError("cover mutation commit returned no row")
        committed = payload.get("committed")
        if not isinstance(committed, bool):
            raise TypeError("committed must be a boolean")
        reason = _required_text(payload.get("reason_code"), "reason_code")
        checkpoint_id = payload.get("finalization_checkpoint_id")
        checkpoint_revision = payload.get("finalization_checkpoint_revision")
        revision = _optional_nonnegative_int(
            payload.get("cover_mutation_revision"), "cover_mutation_revision"
        )
        if committed and reason in {"committed", "no_change"}:
            if revision is None:
                raise ValueError("committed cover mutation requires authority revision")
            durable = request.job_id is not None
            if durable:
                outcome_checkpoint_id = _positive_int(
                    checkpoint_id, "finalization_checkpoint_id"
                )
                outcome_checkpoint_revision = _nonnegative_int(
                    checkpoint_revision, "finalization_checkpoint_revision"
                )
            else:
                if checkpoint_id is not None or checkpoint_revision is not None:
                    raise ValueError("non-durable commit returned checkpoint evidence")
                outcome_checkpoint_id = outcome_checkpoint_revision = None
            return CoverMutationOutcome(
                status=CoverMutationStatus.COMMITTED,
                cover_mutation_revision=revision,
                selected_cover_revision=request.promoted_cover_revision,
                checkpoint="authority_committed" if durable else None,
                library_id=request.identity.library_id if durable else None,
                local_album_id=request.identity.local_album_id if durable else None,
                task_id=request.task_id if durable else None,
                finalization_checkpoint_id=outcome_checkpoint_id,
                finalization_checkpoint_revision=outcome_checkpoint_revision,
            )
        if checkpoint_id is not None or checkpoint_revision is not None:
            raise ValueError("uncommitted cover mutation returned checkpoint evidence")
        if not committed and reason in {"canceled", "lease_lost"}:
            return CoverMutationOutcome(
                status=CoverMutationStatus.CANCELED,
                cover_mutation_revision=revision,
            )
        if not committed and reason in _CONFLICT_REASONS:
            raise CoverMutationConflict(reason)  # type: ignore[arg-type]
        raise ValueError("invalid cover mutation commit result")

    @staticmethod
    def _recovery_outcome(
        request: CoverMutationRecovery, row: object
    ) -> CoverMutationOutcome:
        payload = _mapping(row)
        if not payload:
            raise ValueError("cover mutation recovery returned no row")
        action = _required_text(payload.get("recovery_action"), "recovery_action")
        revision = _nonnegative_int(
            payload.get("cover_mutation_revision"), "cover_mutation_revision"
        )
        selected_revision = _database_optional_text(
            payload.get("selected_cover_revision"), "selected_cover_revision"
        )
        checkpoint_id = payload.get("finalization_checkpoint_id")
        checkpoint_revision = payload.get("finalization_checkpoint_revision")
        if action == "committed":
            status = CoverMutationStatus.COMMITTED
        elif action == "compensate":
            status = CoverMutationStatus.CANCELED
        elif action == "ambiguous":
            status = CoverMutationStatus.AMBIGUOUS
        else:
            raise ValueError("invalid cover mutation recovery result")

        if (checkpoint_id is None) != (checkpoint_revision is None):
            raise ValueError("recovery checkpoint evidence must be paired")
        if checkpoint_id is None:
            if action != "ambiguous":
                raise ValueError("decisive recovery requires checkpoint evidence")
            outcome_checkpoint_id = outcome_checkpoint_revision = None
        else:
            outcome_checkpoint_id = _positive_int(
                checkpoint_id, "finalization_checkpoint_id"
            )
            outcome_checkpoint_revision = _nonnegative_int(
                checkpoint_revision, "finalization_checkpoint_revision"
            )
        return CoverMutationOutcome(
            status=status,
            cover_mutation_revision=revision,
            selected_cover_revision=selected_revision,
            checkpoint="authority_committed" if action == "committed" else None,
            library_id=(
                request.identity.library_id
                if outcome_checkpoint_id is not None
                else None
            ),
            local_album_id=(
                request.identity.local_album_id
                if outcome_checkpoint_id is not None
                else None
            ),
            task_id=request.task_id if outcome_checkpoint_id is not None else None,
            finalization_checkpoint_id=outcome_checkpoint_id,
            finalization_checkpoint_revision=outcome_checkpoint_revision,
        )
