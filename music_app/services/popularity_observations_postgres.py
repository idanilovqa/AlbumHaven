"""Transactional storage of normalized provider observations, without provider I/O.

Callers supply a non-autocommit connection with mapping rows and own the
transaction, including rollback and retry after database errors. Multi-source
writers must acquire slots in sorted SourceKey order and keep transactions short.
"""
from collections.abc import Iterable
from datetime import datetime, timezone

from music_app.services.popularity_snapshots import (
    PopularityObservation,
    reconcile_observation,
    validate_observation,
)

SourceKey = tuple[str, str, str]
_MAX_IDENTITY_BYTES = 512
_MAX_READ_KEYS = 1000


def _validate_identity(value: str) -> None:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise ValueError("Source identity and revision must be nonblank text without NUL")
    try:
        size = len(value.encode("utf-8"))
    except UnicodeEncodeError:
        raise ValueError("Source identity and revision must encode as UTF-8") from None
    if not 1 <= size <= _MAX_IDENTITY_BYTES:
        raise ValueError("Source identity and revision must fit 512 UTF-8 bytes")


def _validate_key(key: SourceKey) -> None:
    if (not isinstance(key, tuple) or len(key) != 3
            or not all(isinstance(part, str) for part in key)
            or key[:2] != ("lastfm", "overall_scrobbles")):
        raise ValueError("Expected a supported three-string source key")
    _validate_identity(key[2])


def _require_transaction(connection) -> None:
    if connection.autocommit:
        raise ValueError("Popularity storage requires a caller-owned transaction")


def _utc(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.utcoffset() is None:
        raise ValueError("Stored popularity timestamps must be timezone-aware")
    return value.astimezone(timezone.utc)


def _observation(row) -> PopularityObservation:
    value = PopularityObservation(
        provider=row["provider"], metric=row["metric"],
        source_entity_id=row["source_entity_id"], source_revision=row["source_revision"],
        observed_at=_utc(row["observed_at"]), imported_at=_utc(row["imported_at"]),
        count=row["count"], attribution_state=row["attribution_state"],
    )
    validate_observation(value)
    _validate_key((value.provider, value.metric, value.source_entity_id))
    _validate_identity(value.source_revision)
    return value


def put_observation(
    connection, incoming: PopularityObservation,
) -> tuple[str, PopularityObservation]:
    """Append an accepted revision and return the resulting current observation.

    Replays of any accepted revision retain ingestion provenance and never rewind
    the current pointer. Reusing a revision with different facts is a conflict.
    """
    validate_observation(incoming)
    key = (incoming.provider, incoming.metric, incoming.source_entity_id)
    _validate_key(key)
    _validate_identity(incoming.source_revision)
    _require_transaction(connection)

    connection.execute("""insert into catalog.popularity_source_slots
        (provider, metric, source_entity_id, current_revision)
        values (%s, %s, %s, null)
        on conflict (provider, metric, source_entity_id) do nothing""", key)
    slot = connection.execute("""select current_revision
        from catalog.popularity_source_slots
        where provider=%s and metric=%s and source_entity_id=%s
        for update""", key).fetchone()
    if slot is None:
        raise ValueError("Popularity source slot is missing after locking")
    current_revision = slot["current_revision"]
    if current_revision is not None:
        _validate_identity(current_revision)

    # A separate post-lock statement must see a writer that won while we waited.
    rows = connection.execute("""select provider, metric, source_entity_id,
        source_revision, observed_at, imported_at, count, attribution_state
        from catalog.popularity_source_observations
        where provider=%s and metric=%s and source_entity_id=%s
          and source_revision in (%s, %s)""",
        (*key, current_revision, incoming.source_revision)).fetchall()
    revisions = {}
    for row in rows:
        value = _observation(row)
        if ((value.provider, value.metric, value.source_entity_id) != key
                or value.source_revision not in (current_revision, incoming.source_revision)
                or value.source_revision in revisions):
            raise ValueError("Stored popularity revision does not match its source slot")
        revisions[value.source_revision] = value
    current = revisions.get(current_revision)
    if (current_revision is not None and current is None) or (
        current_revision is None and revisions
    ):
        raise ValueError("Stored popularity current pointer is inconsistent")

    previous = revisions.get(incoming.source_revision)
    if previous is not None:
        status, _ = reconcile_observation(previous, incoming)
        return status, current

    status, result = reconcile_observation(current, incoming)
    if status == "accepted":
        connection.execute("""insert into catalog.popularity_source_observations
            (provider, metric, source_entity_id, source_revision,
             observed_at, imported_at, count, attribution_state)
            values (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (*key, incoming.source_revision, incoming.observed_at,
             incoming.imported_at, incoming.count, incoming.attribution_state))
        connection.execute("""update catalog.popularity_source_slots
            set current_revision=%s
            where provider=%s and metric=%s and source_entity_id=%s""",
            (incoming.source_revision, *key))
    return status, result


def read_observations(
    connection, keys: Iterable[SourceKey],
) -> dict[SourceKey, PopularityObservation]:
    """Read at most 1,000 supplied keys in one statement snapshot, without locks.

    Duplicates count toward the input bound but not the query. Missing and empty
    slots are omitted; malformed stored observations raise instead of disappearing.
    """
    requested = {}
    for index, key in enumerate(keys):
        if index >= _MAX_READ_KEYS:
            raise ValueError("At most 1000 source keys may be read at once")
        _validate_key(key)
        requested[key] = None
    _require_transaction(connection)
    if not requested:
        return {}

    rows = connection.execute("""select o.provider, o.metric, o.source_entity_id,
        o.source_revision, o.observed_at, o.imported_at, o.count, o.attribution_state
        from unnest(%s::text[], %s::text[], %s::text[])
          as requested(provider, metric, source_entity_id)
        join catalog.popularity_source_slots s
          on s.provider=requested.provider and s.metric=requested.metric
         and s.source_entity_id=requested.source_entity_id
        join catalog.popularity_source_observations o
          on o.provider=s.provider and o.metric=s.metric
         and o.source_entity_id=s.source_entity_id and o.source_revision=s.current_revision""",
        ([key[0] for key in requested], [key[1] for key in requested],
         [key[2] for key in requested])).fetchall()
    result = {}
    for row in rows:
        value = _observation(row)
        key = (value.provider, value.metric, value.source_entity_id)
        if key not in requested or key in result:
            raise ValueError("Stored popularity observation does not match requested sources")
        result[key] = value
    return result
