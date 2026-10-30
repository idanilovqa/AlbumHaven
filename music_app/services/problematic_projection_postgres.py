"""Data contracts for durable Problematic Files projection builds."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping, TypeAlias
from uuid import UUID

from music_app.services.problematic_files_projection import (
    normalize_problematic_search_query,
    normalize_problematic_text,
)

try:  # pragma: no cover - optional outside PostgreSQL runtime.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


ProblematicProjectionIdentity: TypeAlias = int | str
ProblematicProjectionGroupKey: TypeAlias = tuple[str, ProblematicProjectionIdentity]
ProblematicProjectionSourceCursor: TypeAlias = tuple[
    str,
    ProblematicProjectionIdentity,
    str,
    ProblematicProjectionIdentity,
]
ProblematicProjectionPosition: TypeAlias = str

_CLAIM_FUNCTION_PARAMETERS = (
    ("job_id", "bigint"),
    ("attempt", "integer"),
    ("worker_id", "text"),
    ("lease_token", "text"),
)
_BUILD_FUNCTION_PARAMETERS = (
    ("library_id", "bigint"),
    ("source_generation", "bigint"),
    ("rebuild_epoch", "bigint"),
    ("revision", "uuid"),
)
_PROJECTION_FUNCTION_PARAMETERS: Mapping[str, tuple[tuple[str, str], ...]] = {
    "enqueue_problematic_projection_rebuild": (
        ("library_id", "bigint"), ("requested_by", "text"),
    ),
    "prepare_claimed_problematic_projection": (
        *_CLAIM_FUNCTION_PARAMETERS, ("observed_at", "timestamptz"),
    ),
    "validate_claimed_problematic_projection": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("observed_at", "timestamptz"),
    ),
    "load_claimed_problematic_projection_source": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("limit", "integer"), ("child_limit", "integer"),
        ("observed_at", "timestamptz"),
    ),
    "stage_claimed_problematic_projection_source": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("group_kind", "text"), ("group_identity", "text"),
        ("source_kind", "text"), ("source_identity", "text"),
        ("child_kind", "text"), ("child_identity", "text"),
        ("rows", "jsonb"), ("complete", "boolean"),
        ("observed_at", "timestamptz"),
    ),
    "load_claimed_problematic_projection_staged_group": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("group_kind", "text"), ("group_identity", "text"),
        ("after_stage_id", "bigint"), ("limit", "integer"),
        ("observed_at", "timestamptz"),
    ),
    "load_claimed_problematic_projection_group_accumulator": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("group_kind", "text"), ("group_identity", "text"),
        ("observed_at", "timestamptz"),
    ),
    "advance_claimed_problematic_projection_group_accumulator": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("group_kind", "text"), ("group_identity", "text"),
        ("expected_after_stage_id", "bigint"), ("after_stage_id", "bigint"),
        ("next_batch_index", "integer"), ("row_count", "bigint"),
        ("observed_at", "timestamptz"),
    ),
    "checkpoint_claimed_problematic_projection_group_facts": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("group_kind", "text"), ("group_identity", "text"),
        ("expected_after_stage_id", "bigint"), ("entries", "jsonb"),
        ("next_batch_index", "integer"), ("row_count", "bigint"),
        ("observed_at", "timestamptz"),
    ),
    "load_claimed_problematic_projection_group_facts": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("group_kind", "text"), ("group_identity", "text"),
        ("after_projection_id", "text"), ("after_fact_kind", "text"),
        ("after_semantic_child_identity", "text"), ("limit", "integer"),
        ("observed_at", "timestamptz"),
    ),
    "stage_claimed_problematic_projection_items": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("group_kind", "text"), ("group_identity", "text"),
        ("items", "jsonb"), ("batch_index", "integer"),
        ("observed_at", "timestamptz"),
    ),
    "stage_claimed_problematic_projection_reason_facts": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("group_kind", "text"), ("group_identity", "text"),
        ("facts", "jsonb"), ("observed_at", "timestamptz"),
    ),
    "stage_claimed_problematic_projection_search_facts": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("group_kind", "text"), ("group_identity", "text"),
        ("after_projection_id", "text"), ("after_fact_kind", "text"),
        ("after_semantic_child_identity", "text"), ("limit", "integer"),
        ("observed_at", "timestamptz"),
    ),
    "complete_claimed_problematic_projection_group": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("group_kind", "text"), ("group_identity", "text"),
        ("source_kind", "text"), ("source_identity", "text"),
        ("child_kind", "text"), ("child_identity", "text"),
        ("observed_at", "timestamptz"),
    ),
    "publish_claimed_problematic_projection": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("observed_at", "timestamptz"),
    ),
    "fail_claimed_problematic_projection": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("reason_code", "text"), ("observed_at", "timestamptz"),
    ),
    "cleanup_claimed_problematic_projection": (
        *_CLAIM_FUNCTION_PARAMETERS, *_BUILD_FUNCTION_PARAMETERS,
        ("observed_at", "timestamptz"),
    ),
    "reclaim_one_abandoned_problematic_projection": (
        ("observed_at", "timestamptz"),
    ),
    "load_due_problematic_projection_integrity_audit": (
        ("observed_at", "timestamptz"),
    ),
    "advance_problematic_projection_integrity_audit": (
        ("library_id", "bigint"), ("revision", "uuid"),
        ("audit_claim_token", "uuid"), ("expected_after_fact_type", "text"),
        ("expected_after_item_key", "text"),
        ("expected_after_identity_one", "text"),
        ("expected_after_identity_two", "text"),
        ("expected_after_identity_three", "text"),
        ("expected_item_count", "integer"),
        ("expected_reason_fact_count", "bigint"),
        ("expected_reason_fingerprint", "bit(256)"),
        ("expected_search_fact_count", "bigint"),
        ("expected_search_fingerprint", "bit(256)"),
        ("after_fact_type", "text"), ("after_item_key", "text"),
        ("after_identity_one", "text"), ("after_identity_two", "text"),
        ("after_identity_three", "text"),
        ("item_count", "integer"), ("last_counted_item_key", "text"),
        ("reason_fact_count", "bigint"), ("reason_fingerprint", "bit(256)"),
        ("search_fact_count", "bigint"), ("search_fingerprint", "bit(256)"),
        ("observed_at", "timestamptz"),
    ),
    "load_problematic_projection_integrity_page": (
        ("library_id", "bigint"), ("revision", "uuid"),
        ("after_fact_type", "text"), ("after_item_key", "text"),
        ("after_identity_one", "text"), ("after_identity_two", "text"),
        ("after_identity_three", "text"),
        ("limit", "integer"),
    ),
    "complete_problematic_projection_integrity_audit": (
        ("library_id", "bigint"), ("revision", "uuid"),
        ("audit_claim_token", "uuid"), ("item_count", "integer"),
        ("reason_fact_count", "bigint"), ("reason_fingerprint", "bit(256)"),
        ("search_fact_count", "bigint"), ("search_fingerprint", "bit(256)"),
        ("observed_at", "timestamptz"),
    ),
}

_PROJECTION_FUNCTION_RETURN_COLUMNS: Mapping[str, tuple[str, ...]] = {
    "enqueue_problematic_projection_rebuild": ("job_id", "rebuild_epoch", "created"),
    "prepare_claimed_problematic_projection": (
        "library_id",
        "source_generation",
        "rebuild_epoch",
        "revision",
        "group_kind",
        "group_identity",
        "source_kind",
        "source_identity",
        "child_kind",
        "child_identity",
        "committed",
    ),
    "validate_claimed_problematic_projection": ("valid",),
    "load_claimed_problematic_projection_source": (
        "group_kind",
        "group_identity",
        "source_kind",
        "source_identity",
        "child_kind",
        "child_identity",
        "rows",
        "group_complete",
        "page_complete",
    ),
    "stage_claimed_problematic_projection_source": (),
    "load_claimed_problematic_projection_staged_group": ("stage_id", "payload"),
    "load_claimed_problematic_projection_group_accumulator": (
        "after_stage_id", "next_batch_index", "row_count", "source_complete",
    ),
    "advance_claimed_problematic_projection_group_accumulator": ("advanced",),
    "checkpoint_claimed_problematic_projection_group_facts": (
        "after_stage_id", "next_batch_index", "row_count", "source_complete",
    ),
    "load_claimed_problematic_projection_group_facts": (
        "stage_id", "projection_id", "fact_kind",
        "semantic_child_identity", "fact_value",
    ),
    "stage_claimed_problematic_projection_items": (),
    "stage_claimed_problematic_projection_reason_facts": (),
    "stage_claimed_problematic_projection_search_facts": (
        "after_projection_id", "after_fact_kind",
        "after_semantic_child_identity", "staged_count", "complete",
    ),
    "complete_claimed_problematic_projection_group": (),
    "publish_claimed_problematic_projection": ("published",),
    "fail_claimed_problematic_projection": (),
    "cleanup_claimed_problematic_projection": ("deleted_count",),
    "reclaim_one_abandoned_problematic_projection": ("reclaimed",),
    "load_due_problematic_projection_integrity_audit": (
        "library_id",
        "revision",
        "audit_revision",
        "after_fact_type",
        "after_item_key",
        "after_identity_one",
        "after_identity_two",
        "after_identity_three",
        "item_count",
        "last_counted_item_key",
        "reason_fact_count",
        "reason_fingerprint",
        "search_fact_count",
        "search_fingerprint",
        "audit_claim_token",
    ),
    "advance_problematic_projection_integrity_audit": ("advanced",),
    "load_problematic_projection_integrity_page": (
        "fact_type", "item_key", "normalized_reason", "display_reason",
        "category_reason",
        "fact_kind", "semantic_child_identity", "normalized_text",
    ),
    "complete_problematic_projection_integrity_audit": (),
}

_PROJECTION_FUNCTION_SUCCESS_KEYS: Mapping[str, str] = {
    "stage_claimed_problematic_projection_source": "accepted",
    "advance_claimed_problematic_projection_group_accumulator": "advanced",
    "stage_claimed_problematic_projection_items": "accepted",
    "stage_claimed_problematic_projection_reason_facts": "accepted",
    "complete_claimed_problematic_projection_group": "accepted",
    "fail_claimed_problematic_projection": "recorded",
}

_PROBLEMATIC_PROJECTION_CURSOR_VERSION = 3
_PROBLEMATIC_PROJECTION_CURSOR_MAX_LENGTH = 4096
_PROBLEMATIC_PROJECTION_ITEM_KEY_MAX_BYTES = 256
_PROBLEMATIC_PROJECTION_SORT_TEXT_MAX_BYTES = 512
_URLSAFE_BASE64_CHARACTERS = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
)
_PROBLEMATIC_PROJECTION_SOURCE_RELATION = "ops.problematic_projection_source_rows"
_NUMERIC_PROJECTION_IDENTITY_KINDS = frozenset(
    ("album", "missing_album", "loose_source", "file")
)


class ProblematicProjectionError(Exception):
    """Base class for expected durable-projection failures."""


class ProblematicProjectionStorageError(ProblematicProjectionError):
    """A transient repository operation failed."""


class ProblematicProjectionIntegrityError(ProblematicProjectionError):
    """Persisted or loaded projection state violated its closed contract."""


class ProblematicProjectionCursorError(ProblematicProjectionError, ValueError):
    """A durable projection page cursor is invalid or out of scope."""


@dataclass(frozen=True)
class ProblematicProjectionBuild:
    library_id: int
    source_generation: int
    rebuild_epoch: int
    revision: str
    source_cursor: ProblematicProjectionSourceCursor | None
    source_group_key: ProblematicProjectionGroupKey | None = None
    committed: bool = False


@dataclass(frozen=True)
class ProblematicProjectionGroupAccumulator:
    after_stage_id: int
    next_batch_index: int
    row_count: int
    source_complete: bool = True


@dataclass(frozen=True)
class ProblematicProjectionSourceChunk:
    group_key: ProblematicProjectionGroupKey
    cursor: ProblematicProjectionSourceCursor
    rows: tuple[Mapping[str, Any], ...]
    complete: bool


@dataclass(frozen=True)
class ProblematicProjectionSourcePage:
    chunks: tuple[ProblematicProjectionSourceChunk, ...]
    complete: bool


@dataclass(frozen=True)
class ProblematicProjectionPageCursor:
    library_id: int
    revision: str
    query: str
    reasons: tuple[str, ...]
    sort: str
    total: int
    anchor_item_key: str


@dataclass(frozen=True)
class ProblematicProjectionReadPage:
    revision: str
    total: int
    reason_facets: Mapping[str, int]
    items: tuple[Mapping[str, Any], ...]
    next_cursor: str | None


@dataclass(frozen=True)
class ProblematicProjectionCursorExpired:
    requested_revision: str
    current_revision: str


def _normalize_cursor_scope(
    *,
    library_id: object,
    revision: object,
    query: object,
    reasons: object,
    sort: object,
    allow_pending_revision: bool = False,
) -> tuple[int, str, str, tuple[str, ...], str]:
    if (
        isinstance(library_id, bool)
        or not isinstance(library_id, int)
        or library_id <= 0
    ):
        raise ProblematicProjectionCursorError("invalid projection cursor scope")
    if not isinstance(revision, str) or not revision.strip():
        raise ProblematicProjectionCursorError("invalid projection cursor scope")
    normalized_revision = revision.strip()
    if normalized_revision == "pending":
        if not allow_pending_revision:
            raise ProblematicProjectionCursorError("invalid projection cursor scope")
    else:
        try:
            normalized_revision = str(UUID(normalized_revision))
        except (TypeError, ValueError) as exc:
            raise ProblematicProjectionCursorError(
                "invalid projection cursor scope"
            ) from exc
    if not isinstance(query, str) or not isinstance(sort, str) or not sort.strip():
        raise ProblematicProjectionCursorError("invalid projection cursor scope")
    if not isinstance(reasons, (list, tuple)) or not all(
        isinstance(reason, str) for reason in reasons
    ):
        raise ProblematicProjectionCursorError("invalid projection cursor scope")
    normalized_reasons = tuple(
        sorted(
            {
            normalize_problematic_text(reason)
                for reason in reasons
            }
            - {""}
        )
    )
    try:
        normalized_query = normalize_problematic_search_query(query)
    except (TypeError, ValueError) as exc:
        raise ProblematicProjectionCursorError(
            "invalid projection cursor scope"
        ) from exc
    return (
        library_id,
        normalized_revision,
        normalized_query,
        normalized_reasons,
        " ".join(sort.split()).casefold(),
    )


def _cursor_filter_digest(
    query: str,
    reasons: tuple[str, ...],
    sort: str,
) -> str:
    payload = json.dumps(
        [query, list(reasons), sort],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _validate_cursor_anchor(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode("utf-8")) > _PROBLEMATIC_PROJECTION_ITEM_KEY_MAX_BYTES
    ):
        raise ProblematicProjectionCursorError("invalid projection cursor anchor")
    return value


def encode_problematic_projection_page_cursor(
    *,
    library_id: int,
    revision: str,
    query: str,
    reasons: list[str] | tuple[str, ...],
    sort: str,
    total: int,
    anchor_item_key: str,
) -> str:
    scope = _normalize_cursor_scope(
        library_id=library_id,
        revision=revision,
        query=query,
        reasons=reasons,
        sort=sort,
    )
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        raise ProblematicProjectionCursorError("invalid projection cursor total")
    validated_anchor = _validate_cursor_anchor(anchor_item_key)
    payload = [
        _PROBLEMATIC_PROJECTION_CURSOR_VERSION,
        scope[0],
        scope[1],
        _cursor_filter_digest(scope[2], scope[3], scope[4]),
        total,
        validated_anchor,
    ]
    token = base64.urlsafe_b64encode(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")
    if len(token) > _PROBLEMATIC_PROJECTION_CURSOR_MAX_LENGTH:
        raise ProblematicProjectionCursorError("projection cursor is too long")
    return token


def decode_problematic_projection_page_cursor(
    token: object,
    *,
    library_id: int,
    revision: str,
    query: str,
    reasons: list[str] | tuple[str, ...],
    sort: str,
) -> ProblematicProjectionPageCursor:
    expected_scope = _normalize_cursor_scope(
        library_id=library_id,
        revision=revision,
        query=query,
        reasons=reasons,
        sort=sort,
    )
    if (
        not isinstance(token, str)
        or not token
        or len(token) > _PROBLEMATIC_PROJECTION_CURSOR_MAX_LENGTH
        or any(character not in _URLSAFE_BASE64_CHARACTERS for character in token)
    ):
        raise ProblematicProjectionCursorError("invalid projection cursor")
    try:
        payload = json.loads(
            base64.b64decode(
                token + "=" * (-len(token) % 4),
                altchars=b"-_",
                validate=True,
            ).decode("utf-8")
        )
    except (binascii.Error, json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise ProblematicProjectionCursorError("invalid projection cursor") from exc
    if (
        not isinstance(payload, list)
        or len(payload) != 6
        or type(payload[0]) is not int
        or payload[0] != _PROBLEMATIC_PROJECTION_CURSOR_VERSION
        or not isinstance(payload[3], str)
        or not isinstance(payload[5], str)
    ):
        raise ProblematicProjectionCursorError("invalid projection cursor")
    if (
        payload[1] != expected_scope[0]
        or payload[2] != expected_scope[1]
        or payload[3]
        != _cursor_filter_digest(
            expected_scope[2], expected_scope[3], expected_scope[4]
        )
    ):
        raise ProblematicProjectionCursorError("projection cursor scope changed")
    total = payload[4]
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        raise ProblematicProjectionCursorError("invalid projection cursor total")
    anchor_item_key = _validate_cursor_anchor(payload[5])
    return ProblematicProjectionPageCursor(
        library_id=expected_scope[0],
        revision=expected_scope[1],
        query=expected_scope[2],
        reasons=expected_scope[3],
        sort=expected_scope[4],
        total=total,
        anchor_item_key=anchor_item_key,
    )


def _default_connect(database_url: str) -> Any:
    if psycopg is None:  # pragma: no cover - guarded by runtime dependency.
        raise RuntimeError("psycopg is required for Problematic Files projection")
    return psycopg.connect(database_url, row_factory=dict_row, connect_timeout=2)


def _row_mapping(row: object) -> dict[str, Any]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    raise ProblematicProjectionIntegrityError("projection row is not a mapping")


def _positive_integer(name: str, value: object) -> int:
    if type(value) is not int or value < 1:
        raise ProblematicProjectionIntegrityError(f"invalid {name}")
    return value


def _nonnegative_integer(name: str, value: object) -> int:
    if type(value) is not int or value < 0:
        raise ProblematicProjectionIntegrityError(f"invalid {name}")
    return value


def _nonempty_text(name: str, value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProblematicProjectionIntegrityError(f"invalid {name}")
    return value.strip()


def _reason_fingerprint(value: object) -> str:
    normalized = str(value or "")
    if len(normalized) != 256 or set(normalized) - {"0", "1"}:
        raise ProblematicProjectionIntegrityError("invalid reason fingerprint")
    return normalized


def _database_uuid_text(name: str, value: object) -> str:
    try:
        return str(UUID(str(value)))
    except (AttributeError, TypeError, ValueError):
        raise ProblematicProjectionIntegrityError(f"invalid {name}") from None


def _projection_function_call_sql(
    function_name: str,
    parameter_names: tuple[str, ...],
    *,
    success_key: str | None = None,
) -> str:
    expected = _PROJECTION_FUNCTION_PARAMETERS.get(function_name)
    return_columns = _PROJECTION_FUNCTION_RETURN_COLUMNS.get(function_name)
    if (
        expected is None
        or return_columns is None
        or parameter_names != tuple(name for name, _ in expected)
    ):
        raise ProblematicProjectionIntegrityError(
            "invalid projection function call signature"
        )
    expected_success_key = _PROJECTION_FUNCTION_SUCCESS_KEYS.get(function_name)
    if success_key is not None and success_key != expected_success_key:
        raise ProblematicProjectionIntegrityError(
            "invalid projection function success alias"
        )
    arguments = ", ".join(
        f"%({name})s::{parameter_type}" for name, parameter_type in expected
    )
    select_clause = f"select true as {success_key} from" if success_key else "select * from"
    return f"{select_clause} ops.{function_name}({arguments})"


class _StorageConnection:
    def __init__(self, connection: Any) -> None:
        self._connection = connection

    def __enter__(self) -> Any:
        try:
            enter = getattr(self._connection, "__enter__", None)
            return enter() if callable(enter) else self._connection
        except ProblematicProjectionError:
            raise
        except Exception as exc:
            raise ProblematicProjectionStorageError(
                "problematic projection transaction failed"
            ) from exc

    def __exit__(self, exc_type, exc, traceback) -> object:
        try:
            exit_connection = getattr(self._connection, "__exit__", None)
            return exit_connection(exc_type, exc, traceback) if callable(exit_connection) else False
        except ProblematicProjectionError:
            raise
        except Exception as failure:
            raise ProblematicProjectionStorageError(
                "problematic projection transaction failed"
            ) from failure


def _claim_parameters(claim: object) -> dict[str, object]:
    return {
        "job_id": _positive_integer("job id", getattr(claim, "job_id", None)),
        "attempt": _positive_integer("attempt", getattr(claim, "attempt", None)),
        "worker_id": _nonempty_text("worker id", getattr(claim, "worker_id", None)),
        "lease_token": _nonempty_text("lease token", getattr(claim, "lease_token", None)),
    }


def _build_parameters(build: ProblematicProjectionBuild) -> dict[str, object]:
    return {
        "library_id": _positive_integer("library id", build.library_id),
        "source_generation": _nonnegative_integer("source generation", build.source_generation),
        "rebuild_epoch": _nonnegative_integer("rebuild epoch", build.rebuild_epoch),
        "revision": _nonempty_text("revision", build.revision),
    }


def _validate_limit(name: str, value: object, maximum: int) -> int:
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError(f"{name} must be between 1 and {maximum}")
    return value


def _validate_persisted_item_contract(item: Mapping[str, Any]) -> None:
    limits = {
        "item_key": _PROBLEMATIC_PROJECTION_ITEM_KEY_MAX_BYTES,
        "sort_title": _PROBLEMATIC_PROJECTION_SORT_TEXT_MAX_BYTES,
        "sort_artist": _PROBLEMATIC_PROJECTION_SORT_TEXT_MAX_BYTES,
        "sort_year": 64,
        "sort_album_key": _PROBLEMATIC_PROJECTION_SORT_TEXT_MAX_BYTES,
    }
    for field, maximum in limits.items():
        value = item.get(field)
        if not isinstance(value, str) or (field == "item_key" and not value):
            raise ProblematicProjectionIntegrityError(
                f"invalid projected item {field}"
            )
        if len(value.encode("utf-8")) > maximum:
            raise ProblematicProjectionIntegrityError(
                f"projected item {field} exceeds storage limit"
            )


def _normalize_projection_identity(
    kind: str,
    value: object,
) -> ProblematicProjectionIdentity:
    if kind in _NUMERIC_PROJECTION_IDENTITY_KINDS:
        if type(value) is int:
            identity = value
        elif isinstance(value, str) and value.isdecimal():
            identity = int(value)
        else:
            raise ProblematicProjectionIntegrityError("invalid projection identity")
        if identity <= 0:
            raise ProblematicProjectionIntegrityError("invalid projection identity")
        return identity
    if not isinstance(value, str) or not value:
        raise ProblematicProjectionIntegrityError("invalid projection identity")
    return value


def _validate_group_key(value: object) -> ProblematicProjectionGroupKey:
    if (
        not isinstance(value, tuple)
        or len(value) != 2
        or not isinstance(value[0], str)
        or not value[0]
    ):
        raise ProblematicProjectionIntegrityError("invalid projection group key")
    return value[0], _normalize_projection_identity(value[0], value[1])


def _validate_source_cursor(value: object) -> ProblematicProjectionSourceCursor:
    if not isinstance(value, tuple) or len(value) != 4:
        raise ProblematicProjectionIntegrityError("invalid projection source cursor")
    group = _validate_group_key((value[0], value[1]))
    child = _validate_group_key((value[2], value[3]))
    return group[0], group[1], child[0], child[1]


def _group_cursor_parameters(
    group_key: ProblematicProjectionGroupKey,
    source_cursor: ProblematicProjectionSourceCursor,
) -> dict[str, object]:
    group_kind, group_identity = _validate_group_key(group_key)
    source_kind, source_identity, child_kind, child_identity = _validate_source_cursor(source_cursor)
    if (group_kind, group_identity) != (source_kind, source_identity):
        raise ProblematicProjectionIntegrityError("source cursor group mismatch")
    return {
        "group_kind": group_kind,
        "group_identity": group_identity,
        "source_kind": source_kind,
        "source_identity": source_identity,
        "child_kind": child_kind,
        "child_identity": child_identity,
    }


def _decode_page_cursor_for_scope(
    token: str,
    *,
    library_id: int,
    query: str,
    reasons: Iterable[str],
    sort: str,
) -> ProblematicProjectionPageCursor:
    if (
        not isinstance(token, str)
        or not token
        or len(token) > _PROBLEMATIC_PROJECTION_CURSOR_MAX_LENGTH
        or any(character not in _URLSAFE_BASE64_CHARACTERS for character in token)
    ):
        raise ProblematicProjectionCursorError("invalid projection cursor")
    try:
        payload = json.loads(
            base64.b64decode(
                token + "=" * (-len(token) % 4),
                altchars=b"-_",
                validate=True,
            ).decode("utf-8")
        )
        revision = payload[2]
    except (binascii.Error, json.JSONDecodeError, UnicodeDecodeError, ValueError,
            TypeError, IndexError) as exc:
        raise ProblematicProjectionCursorError("invalid projection cursor") from exc
    return decode_problematic_projection_page_cursor(
        token,
        library_id=library_id,
        revision=revision,
        query=query,
        reasons=tuple(reasons),
        sort=sort,
    )


class PostgresProblematicProjectionRepository:
    """Claim-fenced storage and indexed reads for durable PF projections."""

    def __init__(
        self,
        *,
        database_url: str,
        connect_to_database: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = _nonempty_text("database url", database_url)
        self._connect_to_database = connect_to_database or _default_connect

    def _connect(self) -> Any:
        try:
            return _StorageConnection(self._connect_to_database(self._database_url))
        except ProblematicProjectionError:
            raise
        except Exception as exc:
            raise ProblematicProjectionStorageError(
                "problematic projection connection failed"
            ) from exc

    @staticmethod
    def _one(connection: Any, sql: str, params: Mapping[str, object]) -> dict[str, Any] | None:
        try:
            row = connection.execute(sql, params).fetchone()
        except ProblematicProjectionError:
            raise
        except Exception as exc:
            raise ProblematicProjectionStorageError(
                "problematic projection operation failed"
            ) from exc
        return None if row is None else _row_mapping(row)

    @staticmethod
    def _all(connection: Any, sql: str, params: Mapping[str, object]) -> list[dict[str, Any]]:
        try:
            rows = connection.execute(sql, params).fetchall()
        except ProblematicProjectionError:
            raise
        except Exception as exc:
            raise ProblematicProjectionStorageError(
                "problematic projection operation failed"
            ) from exc
        return [_row_mapping(row) for row in rows]

    def resolve_bootstrap_library_id(self) -> int:
        sql = "select * from ops.resolve_problematic_projection_library()"
        with self._connect() as connection:
            rows = self._all(connection, sql, {})
        if len(rows) != 1:
            raise ProblematicProjectionIntegrityError(
                "canonical bootstrap library is missing or ambiguous"
            )
        return _positive_integer("library id", rows[0].get("library_id"))

    def enqueue_rebuild(self, *, library_id: int, requested_by: str) -> dict[str, object]:
        params = {
            "library_id": _positive_integer("library id", library_id),
            "requested_by": _nonempty_text("requested by", requested_by),
        }
        with self._connect() as connection:
            row = self._one(
                connection,
                _projection_function_call_sql(
                    "enqueue_problematic_projection_rebuild",
                    ("library_id", "requested_by"),
                ),
                params,
            )
        if row is None:
            raise ProblematicProjectionIntegrityError("projection enqueue was rejected")
        return {
            "job_id": _positive_integer("job id", row.get("job_id")),
            "rebuild_epoch": _nonnegative_integer(
                "rebuild epoch", row.get("rebuild_epoch")
            ),
            "created": row.get("created") is True,
        }

    def prepare_claimed_build(self, *, claim: object, now: object) -> ProblematicProjectionBuild:
        params = {**_claim_parameters(claim), "observed_at": now}
        with self._connect() as connection:
            row = self._one(
                connection,
                _projection_function_call_sql(
                    "prepare_claimed_problematic_projection",
                    ("job_id", "attempt", "worker_id", "lease_token", "observed_at"),
                ),
                params,
            )
        if row is None:
            raise ProblematicProjectionIntegrityError("claimed projection build unavailable")
        source_values = (
            row.get("source_kind"), row.get("source_identity"),
            row.get("child_kind"), row.get("child_identity"),
        )
        source_cursor = _validate_source_cursor(source_values) if any(
            value is not None for value in source_values
        ) else None
        group_values = (row.get("group_kind"), row.get("group_identity"))
        group_key = _validate_group_key(group_values) if any(
            value is not None for value in group_values
        ) else None
        committed = row.get("committed") is True or (
            "committed" not in row
            and group_key is None
            and source_cursor is not None
        )
        if source_cursor is not None and group_key != source_cursor[:2] and not committed:
            raise ProblematicProjectionIntegrityError(
                "persisted projection build group is inconsistent"
            )
        return ProblematicProjectionBuild(
            library_id=_positive_integer("library id", row.get("library_id")),
            source_generation=_nonnegative_integer("source generation", row.get("source_generation")),
            rebuild_epoch=_nonnegative_integer("rebuild epoch", row.get("rebuild_epoch")),
            revision=_database_uuid_text("revision", row.get("revision")),
            source_cursor=source_cursor,
            source_group_key=group_key,
            committed=committed,
        )

    def validate_claimed_build(
        self, *, claim: object, build: ProblematicProjectionBuild, now: object
    ) -> bool:
        params = {**_claim_parameters(claim), **_build_parameters(build), "observed_at": now}
        with self._connect() as connection:
            row = self._one(
                connection,
                _projection_function_call_sql(
                    "validate_claimed_problematic_projection",
                    (
                        "job_id", "attempt", "worker_id", "lease_token", "library_id",
                        "source_generation", "rebuild_epoch", "revision", "observed_at",
                    ),
                ),
                params,
            )
        return bool(row and row.get("valid") is True)

    def load_claimed_source_page(
        self, *, claim: object, build: ProblematicProjectionBuild,
        limit: int, child_limit: int, now: object,
    ) -> ProblematicProjectionSourcePage:
        _validate_limit("source page limit", limit, 100)
        _validate_limit("source child limit", child_limit, 100)
        params = {
            **_claim_parameters(claim), **_build_parameters(build),
            "limit": limit, "child_limit": child_limit, "observed_at": now,
        }
        with self._connect() as connection:
            rows = self._all(
                connection,
                _projection_function_call_sql(
                    "load_claimed_problematic_projection_source",
                    (
                        "job_id", "attempt", "worker_id", "lease_token", "library_id",
                        "source_generation", "rebuild_epoch", "revision", "limit",
                        "child_limit", "observed_at",
                    ),
                ),
                params,
            )
        if len(rows) > 100:
            raise ProblematicProjectionIntegrityError(
                "projection source page exceeds hard limit 100"
            )
        chunks = []
        page_complete = False
        for row in rows:
            if row.get("group_kind") is None and row.get("page_complete") is True:
                page_complete = True
                continue
            payload_rows = row.get("rows")
            if not isinstance(payload_rows, list):
                raise ProblematicProjectionIntegrityError("invalid source rows")
            chunks.append(ProblematicProjectionSourceChunk(
                group_key=_validate_group_key((row.get("group_kind"), row.get("group_identity"))),
                cursor=_validate_source_cursor((
                    row.get("source_kind"), row.get("source_identity"),
                    row.get("child_kind"), row.get("child_identity"),
                )),
                rows=tuple(_row_mapping(value) for value in payload_rows),
                complete=row.get("group_complete") is True,
            ))
            page_complete = page_complete or row.get("page_complete") is True
        return ProblematicProjectionSourcePage(tuple(chunks), page_complete)

    def stage_claimed_source_chunk(
        self, *, claim: object, build: ProblematicProjectionBuild,
        group_key: ProblematicProjectionGroupKey,
        source_cursor: ProblematicProjectionSourceCursor,
        rows: Iterable[Mapping[str, Any]], complete: bool, now: object
    ) -> ProblematicProjectionGroupAccumulator:
        params = {
            **_claim_parameters(claim), **_build_parameters(build),
            **_group_cursor_parameters(group_key, source_cursor),
            "rows": json.dumps([dict(row) for row in rows], ensure_ascii=True),
            "complete": bool(complete), "observed_at": now,
        }
        self._require_accepted(
            "stage_claimed_problematic_projection_source",
            params,
            (
                "job_id", "attempt", "worker_id", "lease_token", "library_id",
                "source_generation", "rebuild_epoch", "revision", "group_kind",
                "group_identity", "source_kind", "source_identity", "child_kind",
                "child_identity", "rows", "complete", "observed_at",
            ),
        )

    def iter_claimed_source_group_rows(
        self, *, claim: object, build: ProblematicProjectionBuild,
        group_key: ProblematicProjectionGroupKey, batch_limit: int, now: object
    ):
        for _stage_id, payload in self.iter_claimed_source_group_entries(
            claim=claim,
            build=build,
            group_key=group_key,
            after_stage_id=0,
            batch_limit=batch_limit,
            now=now,
        ):
            yield payload

    def iter_claimed_source_group_entries(
        self, *, claim: object, build: ProblematicProjectionBuild,
        group_key: ProblematicProjectionGroupKey, after_stage_id: int,
        batch_limit: int, now: object
    ):
        _validate_limit("staged group batch limit", batch_limit, 100)
        group_kind, group_identity = _validate_group_key(group_key)
        after_stage_id = _nonnegative_integer("staged group cursor", after_stage_id)
        with self._connect() as connection:
            while True:
                params = {
                    **_claim_parameters(claim), **_build_parameters(build),
                    "group_kind": group_kind, "group_identity": group_identity,
                    "after_stage_id": after_stage_id, "limit": batch_limit,
                    "observed_at": now,
                }
                rows = self._all(
                    connection,
                    _projection_function_call_sql(
                        "load_claimed_problematic_projection_staged_group",
                        (
                            "job_id", "attempt", "worker_id", "lease_token",
                            "library_id", "source_generation", "rebuild_epoch",
                            "revision", "group_kind", "group_identity",
                            "after_stage_id", "limit", "observed_at",
                        ),
                    ),
                    params,
                )
                if not rows:
                    return
                for row in rows:
                    stage_id = _positive_integer("stage id", row.get("stage_id"))
                    if stage_id <= after_stage_id:
                        raise ProblematicProjectionIntegrityError("staged source order regressed")
                    payload = row.get("payload")
                    if not isinstance(payload, Mapping):
                        raise ProblematicProjectionIntegrityError("invalid staged source payload")
                    after_stage_id = stage_id
                    yield stage_id, dict(payload)
                if len(rows) < batch_limit:
                    return

    def load_claimed_group_accumulator(
        self, *, claim: object, build: ProblematicProjectionBuild,
        group_key: ProblematicProjectionGroupKey, now: object
    ) -> ProblematicProjectionGroupAccumulator:
        group_kind, group_identity = _validate_group_key(group_key)
        params = {
            **_claim_parameters(claim), **_build_parameters(build),
            "group_kind": group_kind, "group_identity": group_identity,
            "observed_at": now,
        }
        with self._connect() as connection:
            row = self._one(
                connection,
                _projection_function_call_sql(
                    "load_claimed_problematic_projection_group_accumulator",
                    (
                        "job_id", "attempt", "worker_id", "lease_token",
                        "library_id", "source_generation", "rebuild_epoch",
                        "revision", "group_kind", "group_identity", "observed_at",
                    ),
                ),
                params,
            )
        if row is None:
            raise ProblematicProjectionIntegrityError(
                "claimed projection accumulator unavailable"
            )
        return ProblematicProjectionGroupAccumulator(
            after_stage_id=_nonnegative_integer(
                "accumulator stage id", row.get("after_stage_id")
            ),
            next_batch_index=_nonnegative_integer(
                "accumulator batch index", row.get("next_batch_index")
            ),
            row_count=_nonnegative_integer(
                "accumulator row count", row.get("row_count")
            ),
            source_complete=row.get("source_complete") is not False,
        )

    def advance_claimed_group_accumulator(
        self, *, claim: object, build: ProblematicProjectionBuild,
        group_key: ProblematicProjectionGroupKey, expected_after_stage_id: int,
        after_stage_id: int, next_batch_index: int, row_count: int, now: object
    ) -> None:
        group_kind, group_identity = _validate_group_key(group_key)
        params = {
            **_claim_parameters(claim), **_build_parameters(build),
            "group_kind": group_kind, "group_identity": group_identity,
            "expected_after_stage_id": _nonnegative_integer(
                "expected accumulator stage id", expected_after_stage_id
            ),
            "after_stage_id": _nonnegative_integer(
                "accumulator stage id", after_stage_id
            ),
            "next_batch_index": _nonnegative_integer(
                "accumulator batch index", next_batch_index
            ),
            "row_count": _nonnegative_integer("accumulator row count", row_count),
            "observed_at": now,
        }
        self._require_accepted(
            "advance_claimed_problematic_projection_group_accumulator",
            params,
            (
                "job_id", "attempt", "worker_id", "lease_token", "library_id",
                "source_generation", "rebuild_epoch", "revision", "group_kind",
                "group_identity", "expected_after_stage_id", "after_stage_id",
                "next_batch_index", "row_count", "observed_at",
            ),
            "advanced",
        )
        return ProblematicProjectionGroupAccumulator(
            after_stage_id=after_stage_id,
            next_batch_index=next_batch_index,
            row_count=row_count,
        )

    def checkpoint_claimed_group_facts(
        self, *, claim: object, build: ProblematicProjectionBuild,
        group_key: ProblematicProjectionGroupKey, expected_after_stage_id: int,
        entries: Iterable[tuple[int, str, Mapping[str, Any]]],
        next_batch_index: int, row_count: int, now: object,
    ) -> ProblematicProjectionGroupAccumulator:
        group_kind, group_identity = _validate_group_key(group_key)
        serialized_entries = [
            {
                "stage_id": _positive_integer("fact stage id", stage_id),
                "fact_kind": _nonempty_text("fact kind", fact_kind),
                "projection_id": _nonempty_text(
                    "fact projection id", fact_value.get("projection_id")
                ),
                "semantic_child_identity": _nonempty_text(
                    "fact semantic child identity",
                    fact_value.get("semantic_child_identity"),
                ),
                "fact_value": dict(fact_value),
            }
            for stage_id, fact_kind, fact_value in entries
        ]
        if not serialized_entries or len(serialized_entries) > 100:
            raise ValueError("fact checkpoint must contain 1..100 entries")
        params = {
            **_claim_parameters(claim), **_build_parameters(build),
            "group_kind": group_kind, "group_identity": group_identity,
            "expected_after_stage_id": _nonnegative_integer(
                "expected fact stage id", expected_after_stage_id
            ),
            "entries": json.dumps(serialized_entries, ensure_ascii=True),
            "next_batch_index": _nonnegative_integer(
                "fact batch index", next_batch_index
            ),
            "row_count": _nonnegative_integer("fact row count", row_count),
            "observed_at": now,
        }
        with self._connect() as connection:
            row = self._one(
                connection,
                _projection_function_call_sql(
                    "checkpoint_claimed_problematic_projection_group_facts",
                    (
                        "job_id", "attempt", "worker_id", "lease_token",
                        "library_id", "source_generation", "rebuild_epoch",
                        "revision", "group_kind", "group_identity",
                        "expected_after_stage_id", "entries", "next_batch_index",
                        "row_count", "observed_at",
                    ),
                ),
                params,
            )
        if row is None:
            raise ProblematicProjectionIntegrityError("fact checkpoint rejected")
        return ProblematicProjectionGroupAccumulator(
            after_stage_id=_nonnegative_integer(
                "fact stage id", row.get("after_stage_id")
            ),
            next_batch_index=_nonnegative_integer(
                "fact batch index", row.get("next_batch_index")
            ),
            row_count=_nonnegative_integer("fact row count", row.get("row_count")),
            source_complete=row.get("source_complete") is True,
        )

    def iter_claimed_group_facts(
        self, *, claim: object, build: ProblematicProjectionBuild,
        group_key: ProblematicProjectionGroupKey, after_stage_id: int,
        batch_limit: int, now: object,
    ):
        _validate_limit("group fact batch limit", batch_limit, 100)
        group_kind, group_identity = _validate_group_key(group_key)
        if _nonnegative_integer("group fact cursor", after_stage_id) != 0:
            raise ValueError("group fact reads start at the semantic keyset origin")
        cursor = ("", "", "")
        with self._connect() as connection:
            while True:
                params = {
                    **_claim_parameters(claim), **_build_parameters(build),
                    "group_kind": group_kind, "group_identity": group_identity,
                    "after_projection_id": cursor[0],
                    "after_fact_kind": cursor[1],
                    "after_semantic_child_identity": cursor[2],
                    "limit": batch_limit,
                    "observed_at": now,
                }
                rows = self._all(
                    connection,
                    _projection_function_call_sql(
                        "load_claimed_problematic_projection_group_facts",
                        (
                            "job_id", "attempt", "worker_id", "lease_token",
                            "library_id", "source_generation", "rebuild_epoch",
                            "revision", "group_kind", "group_identity",
                            "after_projection_id", "after_fact_kind",
                            "after_semantic_child_identity", "limit",
                            "observed_at",
                        ),
                    ),
                    params,
                )
                if not rows:
                    return
                for row in rows:
                    stage_id = _positive_integer("fact stage id", row.get("stage_id"))
                    projection_id = _nonempty_text(
                        "fact projection id", row.get("projection_id")
                    )
                    fact_kind = _nonempty_text("fact kind", row.get("fact_kind"))
                    semantic_child_identity = _nonempty_text(
                        "fact semantic child identity",
                        row.get("semantic_child_identity"),
                    )
                    fact_value = row.get("fact_value")
                    next_cursor = (
                        projection_id,
                        fact_kind,
                        semantic_child_identity,
                    )
                    if next_cursor <= cursor or not isinstance(fact_value, Mapping):
                        raise ProblematicProjectionIntegrityError("invalid group fact")
                    cursor = next_cursor
                    yield stage_id, fact_kind, dict(fact_value)
                if len(rows) < batch_limit:
                    return

    def stage_claimed_items(
        self, *, claim: object, build: ProblematicProjectionBuild,
        group_key: ProblematicProjectionGroupKey,
        items: Iterable[Mapping[str, Any]], batch_index: int, now: object
    ) -> None:
        group_kind, group_identity = _validate_group_key(group_key)
        item_batch = [dict(item) for item in items]
        for item in item_batch:
            _validate_persisted_item_contract(item)
        params = {
            **_claim_parameters(claim), **_build_parameters(build),
            "group_kind": group_kind, "group_identity": group_identity,
            "items": json.dumps(item_batch, ensure_ascii=True),
            "batch_index": _nonnegative_integer("batch index", batch_index),
            "observed_at": now,
        }
        self._require_accepted(
            "stage_claimed_problematic_projection_items",
            params,
            (
                "job_id", "attempt", "worker_id", "lease_token", "library_id",
                "source_generation", "rebuild_epoch", "revision", "group_kind",
                "group_identity", "items", "batch_index", "observed_at",
            ),
        )

    def stage_claimed_reason_facts(
        self,
        *,
        claim: object,
        build: ProblematicProjectionBuild,
        group_key: ProblematicProjectionGroupKey,
        facts: Iterable[object],
        now: object,
    ) -> None:
        batch = tuple(facts)
        if not 1 <= len(batch) <= 100:
            raise ValueError("reason fact batch must contain between 1 and 100 facts")
        group_kind, group_identity = _validate_group_key(group_key)
        params = {
            **_claim_parameters(claim),
            **_build_parameters(build),
            "group_kind": group_kind,
            "group_identity": str(group_identity),
            "facts": json.dumps(
                [
                    {
                        "item_key": getattr(fact, "item_key"),
                        "normalized_reason": getattr(fact, "normalized_reason"),
                        "display_reason": getattr(fact, "display_reason"),
                    "category_reason": _nonempty_text(
                        "category reason", getattr(fact, "category_reason")
                    ),
                    }
                    for fact in batch
                ],
                ensure_ascii=True,
            ),
            "observed_at": now,
        }
        self._require_accepted(
            "stage_claimed_problematic_projection_reason_facts",
            params,
            (
                "job_id", "attempt", "worker_id", "lease_token", "library_id",
                "source_generation", "rebuild_epoch", "revision", "group_kind",
                "group_identity", "facts", "observed_at",
            ),
        )

    def stage_claimed_search_facts(
        self,
        *,
        claim: object,
        build: ProblematicProjectionBuild,
        group_key: ProblematicProjectionGroupKey,
        after_projection_id: str,
        after_fact_kind: str,
        after_semantic_child_identity: str,
        limit: int,
        now: object,
    ) -> tuple[str, str, str, int, bool]:
        group_kind, group_identity = _validate_group_key(group_key)
        params = {
            **_claim_parameters(claim),
            **_build_parameters(build),
            "group_kind": group_kind,
            "group_identity": str(group_identity),
            "after_projection_id": str(after_projection_id),
            "after_fact_kind": str(after_fact_kind),
            "after_semantic_child_identity": str(after_semantic_child_identity),
            "limit": _validate_limit("search fact batch", limit, 100),
            "observed_at": now,
        }
        with self._connect() as connection:
            row = self._one(
                connection,
                _projection_function_call_sql(
                    "stage_claimed_problematic_projection_search_facts",
                    (
                        "job_id", "attempt", "worker_id", "lease_token",
                        "library_id", "source_generation", "rebuild_epoch",
                        "revision", "group_kind", "group_identity",
                        "after_projection_id", "after_fact_kind",
                        "after_semantic_child_identity", "limit", "observed_at",
                    ),
                ),
                params,
            )
        if row is None or type(row.get("complete")) is not bool:
            raise ProblematicProjectionIntegrityError(
                "claimed search fact staging rejected"
            )
        cursor = tuple(
            row.get(name)
            for name in (
                "after_projection_id",
                "after_fact_kind",
                "after_semantic_child_identity",
            )
        )
        if not all(isinstance(value, str) for value in cursor):
            raise ProblematicProjectionIntegrityError(
                "invalid claimed search fact staging cursor"
            )
        staged_count = _nonnegative_integer(
            "staged search fact count", row.get("staged_count")
        )
        if staged_count > limit:
            raise ProblematicProjectionIntegrityError(
                "claimed search fact staging exceeded batch limit"
            )
        return cursor[0], cursor[1], cursor[2], staged_count, row["complete"]

    def complete_claimed_source_group(
        self, *, claim: object, build: ProblematicProjectionBuild,
        group_key: ProblematicProjectionGroupKey,
        source_cursor: ProblematicProjectionSourceCursor, now: object
    ) -> None:
        params = {
            **_claim_parameters(claim), **_build_parameters(build),
            **_group_cursor_parameters(group_key, source_cursor),
            "observed_at": now,
        }
        self._require_accepted(
            "complete_claimed_problematic_projection_group",
            params,
            (
                "job_id", "attempt", "worker_id", "lease_token", "library_id",
                "source_generation", "rebuild_epoch", "revision", "group_kind",
                "group_identity", "source_kind", "source_identity", "child_kind",
                "child_identity", "observed_at",
            ),
        )

    def publish_claimed_snapshot(
        self, *, claim: object, build: ProblematicProjectionBuild, now: object
    ) -> bool:
        params = {**_claim_parameters(claim), **_build_parameters(build), "observed_at": now}
        with self._connect() as connection:
            row = self._one(
                connection,
                _projection_function_call_sql(
                    "publish_claimed_problematic_projection",
                    (
                        "job_id", "attempt", "worker_id", "lease_token", "library_id",
                        "source_generation", "rebuild_epoch", "revision", "observed_at",
                    ),
                ),
                params,
            )
        return bool(row and row.get("published") is True)

    def record_claimed_terminal_failure(
        self, *, claim: object, build: ProblematicProjectionBuild | None,
        reason_code: str, now: object
    ) -> None:
        params = {
            **_claim_parameters(claim),
            **(_build_parameters(build) if build is not None else {
                "library_id": getattr(claim, "library_id", None),
                "source_generation": None, "rebuild_epoch": None, "revision": None,
            }),
            "reason_code": _nonempty_text("failure reason", reason_code),
            "observed_at": now,
        }
        self._require_accepted(
            "fail_claimed_problematic_projection",
            params,
            (
                "job_id", "attempt", "worker_id", "lease_token", "library_id",
                "source_generation", "rebuild_epoch", "revision", "reason_code",
                "observed_at",
            ),
            "recorded",
        )

    def cleanup_claimed_build(
        self, *, claim: object, build: ProblematicProjectionBuild, now: object
    ) -> int:
        params = {**_claim_parameters(claim), **_build_parameters(build), "observed_at": now}
        with self._connect() as connection:
            row = self._one(
                connection,
                _projection_function_call_sql(
                    "cleanup_claimed_problematic_projection",
                    (
                        "job_id", "attempt", "worker_id", "lease_token", "library_id",
                        "source_generation", "rebuild_epoch", "revision", "observed_at",
                    ),
                ),
                params,
            )
        if row is None:
            raise ProblematicProjectionIntegrityError("projection cleanup was rejected")
        return _nonnegative_integer("deleted count", row.get("deleted_count"))

    def cancel_claimed_build(
        self,
        *,
        claim: object,
        build: ProblematicProjectionBuild,
        reason_code: str,
        now: object,
    ) -> int:
        _nonempty_text("cancellation reason", reason_code)
        return self.cleanup_claimed_build(claim=claim, build=build, now=now)

    def reclaim_one_abandoned_build(self, *, now: object) -> bool:
        with self._connect() as connection:
            row = self._one(
                connection,
                _projection_function_call_sql(
                    "reclaim_one_abandoned_problematic_projection",
                    ("observed_at",),
                ),
                {"observed_at": now},
            )
        return bool(row and row.get("reclaimed") is True)

    def load_due_integrity_audit(self, *, now: object) -> dict[str, object] | None:
        with self._connect() as connection:
            row = self._one(
                connection,
                _projection_function_call_sql(
                    "load_due_problematic_projection_integrity_audit",
                    ("observed_at",),
                ),
                {"observed_at": now},
            )
        return row

    def persist_integrity_audit_progress(
        self,
        *,
        library_id: int,
        revision: str,
        audit_claim_token: str,
        expected_after_fact_type: str,
        expected_after_item_key: str,
        expected_after_identity_one: str,
        expected_after_identity_two: str,
        expected_after_identity_three: str,
        expected_item_count: int,
        expected_reason_fact_count: int,
        expected_reason_fingerprint: str,
        expected_search_fact_count: int,
        expected_search_fingerprint: str,
        after_fact_type: str,
        after_item_key: str,
        after_identity_one: str,
        after_identity_two: str,
        after_identity_three: str,
        item_count: int,
        last_counted_item_key: str,
        reason_fact_count: int,
        reason_fingerprint: str,
        search_fact_count: int,
        search_fingerprint: str,
        now: object,
    ) -> None:
        params = {
            "library_id": _positive_integer("library id", library_id),
            "revision": _nonempty_text("revision", revision),
            "audit_claim_token": _nonempty_text(
                "audit claim token", audit_claim_token
            ),
            "expected_after_fact_type": str(expected_after_fact_type or "") or None,
            "expected_after_item_key": str(expected_after_item_key or "") or None,
            "expected_after_identity_one": str(expected_after_identity_one or "") or None,
            "expected_after_identity_two": str(expected_after_identity_two or "") or None,
            "expected_after_identity_three": (
                str(expected_after_identity_three or "") or None
            ),
            "expected_item_count": _nonnegative_integer(
                "expected item count", expected_item_count
            ),
            "expected_reason_fact_count": _nonnegative_integer(
                "expected reason fact count", expected_reason_fact_count
            ),
            "expected_reason_fingerprint": _reason_fingerprint(
                expected_reason_fingerprint
            ),
            "expected_search_fact_count": _nonnegative_integer(
                "expected search fact count", expected_search_fact_count
            ),
            "expected_search_fingerprint": _reason_fingerprint(
                expected_search_fingerprint
            ),
            "after_fact_type": _nonempty_text("fact type", after_fact_type),
            "after_item_key": _nonempty_text("item key", after_item_key),
            "after_identity_one": _nonempty_text("identity one", after_identity_one),
            "after_identity_two": _nonempty_text("identity two", after_identity_two),
            "after_identity_three": str(after_identity_three or "") or None,
            "item_count": _nonnegative_integer("item count", item_count),
            "last_counted_item_key": _nonempty_text(
                "last counted item key", last_counted_item_key
            ),
            "reason_fact_count": _nonnegative_integer(
                "reason fact count", reason_fact_count
            ),
            "reason_fingerprint": _reason_fingerprint(reason_fingerprint),
            "search_fact_count": _nonnegative_integer(
                "search fact count", search_fact_count
            ),
            "search_fingerprint": _reason_fingerprint(search_fingerprint),
            "observed_at": now,
        }
        with self._connect() as connection:
            row = self._one(
                connection,
                _projection_function_call_sql(
                    "advance_problematic_projection_integrity_audit",
                    (
                        "library_id", "revision", "audit_claim_token",
                        "expected_after_fact_type", "expected_after_item_key",
                        "expected_after_identity_one", "expected_after_identity_two",
                        "expected_after_identity_three",
                        "expected_item_count",
                        "expected_reason_fact_count", "expected_reason_fingerprint",
                        "expected_search_fact_count", "expected_search_fingerprint",
                        "after_fact_type", "after_item_key", "after_identity_one",
                        "after_identity_two", "after_identity_three", "item_count",
                        "last_counted_item_key", "reason_fact_count",
                        "reason_fingerprint", "search_fact_count",
                        "search_fingerprint", "observed_at",
                    ),
                ),
                params,
            )
        if row is None or row.get("advanced") is not True:
            raise ProblematicProjectionIntegrityError(
                "integrity audit progress was rejected"
            )

    def read_integrity_page(
        self, *, library_id: int, revision: str, after_fact_type: str,
        after_item_key: str, after_identity_one: str,
        after_identity_two: str, after_identity_three: str, limit: int
    ) -> tuple[Mapping[str, Any], ...]:
        _validate_limit("integrity page limit", limit, 100)
        params = {
            "library_id": _positive_integer("library id", library_id),
            "revision": _nonempty_text("revision", revision),
            "after_fact_type": str(after_fact_type or ""),
            "after_item_key": str(after_item_key or ""),
            "after_identity_one": str(after_identity_one or ""),
            "after_identity_two": str(after_identity_two or ""),
            "after_identity_three": str(after_identity_three or ""),
            "limit": limit,
        }
        with self._connect() as connection:
            rows = self._all(
                connection,
                _projection_function_call_sql(
                    "load_problematic_projection_integrity_page",
                    (
                        "library_id", "revision", "after_fact_type",
                        "after_item_key", "after_identity_one",
                        "after_identity_two", "after_identity_three", "limit",
                    ),
                ),
                params,
            )
        return tuple(rows)

    def complete_integrity_audit(
        self, *, library_id: int, revision: str, audit_claim_token: str,
        item_count: int,
        reason_fact_count: int, reason_fingerprint: str,
        search_fact_count: int, search_fingerprint: str, now: object
    ) -> dict[str, object]:
        params = {
            "library_id": _positive_integer("library id", library_id),
            "revision": _nonempty_text("revision", revision),
            "audit_claim_token": _nonempty_text(
                "audit claim token", audit_claim_token
            ),
            "item_count": _nonnegative_integer("item count", item_count),
            "reason_fact_count": _nonnegative_integer(
                "reason fact count", reason_fact_count
            ),
            "reason_fingerprint": _reason_fingerprint(reason_fingerprint),
            "search_fact_count": _nonnegative_integer(
                "search fact count", search_fact_count
            ),
            "search_fingerprint": _reason_fingerprint(search_fingerprint),
            "observed_at": now,
        }
        with self._connect() as connection:
            row = self._one(
                connection,
                _projection_function_call_sql(
                    "complete_problematic_projection_integrity_audit",
                    (
                        "library_id", "revision", "audit_claim_token", "item_count",
                        "reason_fact_count", "reason_fingerprint",
                        "search_fact_count", "search_fingerprint", "observed_at",
                    ),
                ),
                params,
            )
        if row is None:
            raise ProblematicProjectionIntegrityError("integrity audit was rejected")
        return row

    def _require_accepted(
        self,
        function_name: str,
        params: Mapping[str, object],
        parameter_order: tuple[str, ...],
        key: str = "accepted",
    ) -> None:
        with self._connect() as connection:
            row = self._one(
                connection,
                _projection_function_call_sql(
                    function_name,
                    parameter_order,
                    success_key=key,
                ),
                params,
            )
        if not row or row.get(key) is not True:
            raise ProblematicProjectionIntegrityError("claimed projection write rejected")

    def read_page(
        self, *, library_id: int, limit: int, query: str = "",
        reasons: Iterable[str] = (), sort: str = "album", cursor: str | None = None
    ) -> ProblematicProjectionReadPage | ProblematicProjectionCursorExpired:
        _validate_limit("projection page limit", limit, 200)
        normalized_scope = _normalize_cursor_scope(
            library_id=library_id, revision="pending", query=query,
            reasons=tuple(reasons), sort=sort, allow_pending_revision=True,
        )
        if normalized_scope[4] != "album":
            raise ProblematicProjectionCursorError("unsupported projection sort")
        decoded = None
        if cursor is not None:
            decoded = _decode_page_cursor_for_scope(
                cursor, library_id=normalized_scope[0], query=normalized_scope[2],
                reasons=normalized_scope[3], sort=normalized_scope[4],
            )
        params = {
            "library_id": normalized_scope[0],
            "revision": decoded.revision if decoded else None,
            "query": normalized_scope[2],
            "query_pattern": "%" + _escape_like_pattern(normalized_scope[2]) + "%",
            "reasons": list(normalized_scope[3]),
            "anchor_item_key": decoded.anchor_item_key if decoded else None,
            "has_position": decoded is not None,
            "include_filtered_total": decoded is None,
            "carried_total": decoded.total if decoded else None,
            "fetch_limit": limit + 1,
        }
        with self._connect() as connection:
            rows = self._all(connection, _read_page_sql(), params)
        if rows and rows[0].get("cursor_expired") is True:
            if decoded is None:
                raise ProblematicProjectionIntegrityError("first projection page expired")
            return ProblematicProjectionCursorExpired(
                requested_revision=decoded.revision,
                current_revision=_database_uuid_text(
                    "current revision", rows[0].get("current_revision")
                ),
            )
        if rows and rows[0].get("anchor_missing") is True:
            raise ProblematicProjectionCursorError(
                "projection cursor anchor is missing"
            )
        if not rows:
            raise ProblematicProjectionIntegrityError("projection snapshot unavailable")
        header = rows[0]
        revision = _database_uuid_text("revision", header.get("revision"))
        if decoded is not None and revision != decoded.revision:
            return ProblematicProjectionCursorExpired(decoded.revision, revision)
        total_value = decoded.total if decoded else header.get("filtered_total")
        total = _nonnegative_integer("filtered total", total_value)
        facets = header.get("reason_facets")
        if not isinstance(facets, Mapping):
            raise ProblematicProjectionIntegrityError("invalid reason facets")
        normalized_facets = {
            _nonempty_text("reason facet", key): _nonnegative_integer(
                "reason facet count", value
            )
            for key, value in facets.items()
        }
        item_rows = [row for row in rows if row.get("item_key") is not None]
        visible_rows = item_rows[:limit]
        items = []
        for row in visible_rows:
            summary = row.get("summary")
            if not isinstance(summary, Mapping):
                raise ProblematicProjectionIntegrityError("invalid projected summary")
            items.append(dict(summary))
        next_cursor = None
        if visible_rows and len(item_rows) > limit:
            last = visible_rows[-1]
            next_cursor = encode_problematic_projection_page_cursor(
                library_id=normalized_scope[0], revision=revision,
                query=normalized_scope[2], reasons=normalized_scope[3],
                sort=normalized_scope[4], total=total,
                anchor_item_key=_nonempty_text("item key", last.get("item_key")),
            )
        return ProblematicProjectionReadPage(
            revision=revision, total=total, reason_facets=normalized_facets,
            items=tuple(items), next_cursor=next_cursor,
        )


def _read_page_sql() -> str:
    return """
        with header as (
            select projection_header.revision,
                   projection_header.total as committed_total,
                   projection_header.reason_facets,
                   (%(revision)s is not null and projection_header.revision is null)
                       as cursor_expired,
                   state.committed_revision as current_revision
            from ops.problematic_projection_state state
            join ops.problematic_projection_headers committed_header
              on committed_header.library_id = state.library_id
             and committed_header.revision = state.committed_revision
             and committed_header.verified
             and committed_header.total = state.committed_total
             and committed_header.item_count = committed_header.total
             and committed_header.reason_facets = state.reason_facets
             and committed_header.source_generation = state.source_generation
            left join ops.problematic_projection_headers projection_header
              on projection_header.library_id = state.library_id
             and projection_header.revision =
                 coalesce(%(revision)s, state.committed_revision)
             and projection_header.verified
             and projection_header.item_count = projection_header.total
            where state.library_id = %(library_id)s
              and state.verified
        ), anchor as materialized (
            select item.sort_title, item.sort_artist, item.sort_year,
                   item.sort_album_key, item.item_key
            from ops.problematic_projection_items item
            join header on item.revision = header.revision
            where %(has_position)s
              and item.library_id = %(library_id)s
              and item.item_key = %(anchor_item_key)s
        ), search_candidates as materialized (
            select item.library_id, item.revision, item.item_key
            from ops.problematic_projection_items item
            join header on item.revision = header.revision
            where %(query)s <> ''
              and item.library_id = %(library_id)s
              and item.search_text like %(query_pattern)s escape '\\'
            union
            select search_fact.library_id, search_fact.revision,
                   search_fact.item_key
            from ops.problematic_projection_search_facts search_fact
            join header on search_fact.revision = header.revision
            where %(query)s <> ''
              and search_fact.library_id = %(library_id)s
              and search_fact.normalized_text like %(query_pattern)s escape '\\'
        ), filtered as not materialized (
            select item.*
            from ops.problematic_projection_items item
            join header on header.revision = item.revision
            left join search_candidates searched
              on searched.library_id = item.library_id
             and searched.revision = item.revision
             and searched.item_key = item.item_key
            where item.library_id = %(library_id)s
              and (%(query)s = '' or searched.item_key is not null)
        and (cardinality(%(reasons)s::text[]) = 0 or exists (
          select 1
          from ops.problematic_projection_reason_facts reason_fact
          where reason_fact.library_id = item.library_id
            and reason_fact.revision = item.revision
            and reason_fact.item_key = item.item_key
            and reason_fact.normalized_reason = any (%(reasons)s::text[])
        ))
              and (not %(has_position)s or exists (
                   select 1 from anchor
                   where (item.sort_title, item.sort_artist, item.sort_year,
                          item.sort_album_key, item.item_key) >
                         (anchor.sort_title, anchor.sort_artist,
                          anchor.sort_year, anchor.sort_album_key,
                          anchor.item_key)))
        ), page as (
            select item.*
            from header
            join lateral (
                select candidate.*
                from ops.problematic_projection_items candidate
                left join search_candidates searched
                  on searched.library_id = candidate.library_id
                 and searched.revision = candidate.revision
                 and searched.item_key = candidate.item_key
                where candidate.library_id = %(library_id)s
                  and candidate.revision = header.revision
                  and (%(query)s = '' or searched.item_key is not null)
              and (cardinality(%(reasons)s::text[]) = 0 or exists (
                select 1
                from ops.problematic_projection_reason_facts reason_fact
                where reason_fact.library_id = candidate.library_id
                  and reason_fact.revision = candidate.revision
                  and reason_fact.item_key = candidate.item_key
                and reason_fact.normalized_reason = any (%(reasons)s::text[])
              ))
                  and (not %(has_position)s or exists (
                       select 1 from anchor
                       where (candidate.sort_title, candidate.sort_artist,
                              candidate.sort_year, candidate.sort_album_key,
                              candidate.item_key) >
                             (anchor.sort_title, anchor.sort_artist,
                              anchor.sort_year, anchor.sort_album_key,
                              anchor.item_key)))
                order by candidate.sort_title, candidate.sort_artist,
                         candidate.sort_year, candidate.sort_album_key,
                         candidate.item_key
                limit %(fetch_limit)s
            ) item on not header.cursor_expired
        )
        select header.revision, header.committed_total, header.reason_facets,
               header.cursor_expired, header.current_revision,
               (%(has_position)s and not exists (select 1 from anchor))
                   as anchor_missing,
               case when %(include_filtered_total)s
                    then (select count(*) from filtered)
                    else %(carried_total)s end as filtered_total,
               page.item_key, page.sort_title, page.sort_artist, page.sort_year,
               page.sort_album_key, page.summary
        from header
        left join page on true
        order by page.sort_title, page.sort_artist, page.sort_year,
                 page.sort_album_key, page.item_key
    """


def _source_page_plan_sql() -> str:
    return f"""
        select source.group_kind, source.group_identity,
               source.source_kind, source.source_identity,
               source.child_kind, source.child_identity
        from {_PROBLEMATIC_PROJECTION_SOURCE_RELATION} source
        where source.library_id = %(library_id)s
          and (source.group_kind, source.group_identity,
               source.source_kind, source.source_identity,
               source.child_kind, source.child_identity) >
              (%(group_kind)s, %(group_identity)s,
               %(source_kind)s, %(source_identity)s,
               %(child_kind)s, %(child_identity)s)
        order by source.group_kind, source.group_identity,
                 source.source_kind, source.source_identity,
                 source.child_kind, source.child_identity
        limit least(%(limit)s, 100)
    """


def _escape_like_pattern(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


__all__ = [
    "ProblematicProjectionBuild",
    "ProblematicProjectionCursorError",
    "ProblematicProjectionCursorExpired",
    "ProblematicProjectionError",
    "ProblematicProjectionGroupAccumulator",
    "ProblematicProjectionGroupKey",
    "ProblematicProjectionIdentity",
    "ProblematicProjectionIntegrityError",
    "ProblematicProjectionPageCursor",
    "ProblematicProjectionReadPage",
    "ProblematicProjectionPosition",
    "ProblematicProjectionSourceChunk",
    "ProblematicProjectionSourceCursor",
    "ProblematicProjectionSourcePage",
    "ProblematicProjectionStorageError",
    "PostgresProblematicProjectionRepository",
    "decode_problematic_projection_page_cursor",
    "encode_problematic_projection_page_cursor",
]
