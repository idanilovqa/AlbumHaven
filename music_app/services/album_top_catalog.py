"""Immutable server-configured catalog evidence for manual Album Top selection.

This owner checks source availability, not create or media authority. It does
not allocate album IDs, fetch provider data, or persist any runtime state.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import hashlib
import json
from types import MappingProxyType

from music_app.services.current_actor import (
    ActorState,
    CurrentActor,
    LibraryRelationship,
)
from music_app.services.policy import PolicyContext


_REFERENCE_PREFIX = "manual-catalog:sha256:"
_RECORD_FIELDS = frozenset({
    "catalog_album_id", "resolution_status", "entity_kind", "provenance", "display",
})
_STATUSES = frozenset({"resolved", "unresolved", "ambiguous", "unsupported"})


def _is_text(value: object, *, nonblank: bool = False) -> bool:
    if type(value) is not str or (nonblank and not value.strip()):
        return False
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        return False
    return True


def _has_fields(value: object, fields: set[str] | frozenset[str]) -> bool:
    return (
        type(value) is dict
        and all(type(key) is str for key in value)
        and value.keys() == fields
    )


def _is_positive_id(value: object) -> bool:
    return type(value) is int and value > 0


def _copy_configured_record(record: object) -> dict:
    if not _has_fields(record, _RECORD_FIELDS):
        raise ValueError("Catalog record fields are invalid.")
    status = record["resolution_status"]
    if not _is_text(status) or status not in _STATUSES:
        raise ValueError("Catalog resolution status is invalid.")
    album_id = record["catalog_album_id"]
    if status == "resolved":
        if not _is_text(album_id, nonblank=True):
            raise ValueError("Resolved catalog album ID is invalid.")
    elif album_id is not None:
        raise ValueError("Unresolved catalog album ID must be null.")
    if not _is_text(record["entity_kind"], nonblank=True):
        raise ValueError("Catalog entity kind is invalid.")

    provenance = record["provenance"]
    if not _has_fields(provenance, {"resolver", "record_id"}) or not all(
        _is_text(value, nonblank=True) for value in provenance.values()
    ):
        raise ValueError("Catalog provenance is invalid.")
    display = record["display"]
    if not _has_fields(display, {"title", "artist", "notes"}):
        raise ValueError("Catalog display fields are invalid.")
    if any(
        display[field] is not None and not _is_text(display[field])
        for field in ("title", "artist")
    ):
        raise ValueError("Catalog display text is invalid.")
    notes = display["notes"]
    if type(notes) is not list or not all(_is_text(note) for note in notes):
        raise ValueError("Catalog display notes are invalid.")
    return {
        **record,
        "provenance": dict(provenance),
        "display": {**display, "notes": list(notes)},
    }


def _freeze_record(record: dict) -> Mapping:
    return MappingProxyType({
        **record,
        "provenance": MappingProxyType(record["provenance"]),
        "display": MappingProxyType({
            **record["display"],
            "notes": tuple(record["display"]["notes"]),
        }),
    })


def _valid_source_context(context: object) -> bool:
    if not isinstance(context, PolicyContext):
        return False
    actor = context.actor
    if not isinstance(actor, CurrentActor) or actor.state is not ActorState.ACTIVE:
        return False
    if not all(_is_positive_id(value) for value in (
        actor.account_id, actor.session_id, actor.current_library_id,
    )):
        return False
    if type(context.library_id) is not int or context.library_id != actor.current_library_id:
        return False
    if context.target_account_id is not None and (
        type(context.target_account_id) is not int
        or context.target_account_id != actor.account_id
    ):
        return False
    if not isinstance(actor.library_relationships, tuple):
        return False
    return any(
        isinstance(relationship, LibraryRelationship)
        and type(relationship.library_id) is int
        and relationship.library_id == actor.current_library_id
        for relationship in actor.library_relationships
    )


def _empty_result(status: str, reason: str) -> dict[str, object]:
    return {
        "status": status,
        "reason": reason,
        "snapshot_ref": None,
        "digest": None,
        "records": [],
    }


@dataclass(frozen=True, slots=True, init=False, repr=False, eq=False)
class ManualTopCatalog:
    """One detached immutable catalog configuration, with no replacement API."""

    _snapshots: Mapping
    _access: Mapping

    def __init__(self, *, snapshots, access) -> None:
        if type(snapshots) is not dict or type(access) is not dict:
            raise ValueError("Catalog snapshots and access must be dictionaries.")
        if not all(_is_text(ref, nonblank=True) for ref in snapshots):
            raise ValueError("Catalog snapshot reference is invalid.")
        if not all(_is_text(ref, nonblank=True) for ref in access):
            raise ValueError("Catalog access reference is invalid.")
        if snapshots.keys() != access.keys():
            raise ValueError("Catalog access must cover exactly the snapshots.")

        copied_snapshots = {}
        copied_access = {}
        for ref, snapshot in snapshots.items():
            if not _has_fields(snapshot, {"records"}):
                raise ValueError("Catalog snapshot fields are invalid.")
            records = snapshot["records"]
            if type(records) is not dict or not all(
                _is_text(record_ref, nonblank=True) for record_ref in records
            ):
                raise ValueError("Catalog record references are invalid.")
            copied_snapshots[ref] = {
                record_ref: _copy_configured_record(record)
                for record_ref, record in records.items()
            }

            source_access = access[ref]
            if not _has_fields(source_access, {"account_ids", "library_ids"}):
                raise ValueError("Catalog access fields are invalid.")
            if not all(
                type(ids) is frozenset and bool(ids)
                and all(_is_positive_id(value) for value in ids)
                for ids in source_access.values()
            ):
                raise ValueError("Catalog access IDs are invalid.")
            copied_access[ref] = MappingProxyType(dict(source_access))

        # Every configured shape and string is valid before serialization.
        frozen_snapshots = {}
        for ref, records in copied_snapshots.items():
            rows = [[record_ref, records[record_ref]] for record_ref in sorted(records)]
            content = json.dumps(
                [1, rows], ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8", errors="strict")
            digest = hashlib.sha256(content).hexdigest()
            if ref != _REFERENCE_PREFIX + digest:
                raise ValueError("Catalog snapshot reference does not match its content.")
            frozen_snapshots[ref] = MappingProxyType({
                record_ref: _freeze_record(record)
                for record_ref, record in records.items()
            })
        object.__setattr__(self, "_snapshots", MappingProxyType(frozen_snapshots))
        object.__setattr__(self, "_access", MappingProxyType(copied_access))

    def resolve_manual_selection(
        self, *, context, catalog_snapshot_ref, selected_record_refs
    ) -> dict[str, object]:
        """Resolve the complete ordered selection without granting create rights."""
        if type(selected_record_refs) is not list:
            return _empty_result("invalid", "invalid_selection")
        selected = tuple(selected_record_refs)
        if not all(_is_text(ref, nonblank=True) for ref in selected):
            return _empty_result("invalid", "invalid_selection")
        if not selected:
            if catalog_snapshot_ref is not None:
                return _empty_result("invalid", "invalid_selection")
            return _empty_result("ok", "")
        if not _is_text(catalog_snapshot_ref, nonblank=True):
            return _empty_result("invalid", "invalid_selection")
        if not _valid_source_context(context):
            return _empty_result("denied", "catalog_access_denied")

        records = self._snapshots.get(catalog_snapshot_ref)
        if records is None:
            return _empty_result("unavailable", "catalog_version_unavailable")
        source_access = self._access[catalog_snapshot_ref]
        if (
            context.actor.account_id not in source_access["account_ids"]
            or context.library_id not in source_access["library_ids"]
        ):
            return _empty_result("denied", "catalog_access_denied")
        for ref in selected:
            record = records.get(ref)
            if record is None or (
                record["resolution_status"] != "resolved"
                or record["entity_kind"] != "album"
            ):
                return _empty_result("unresolved", "catalog_selection_unresolved")

        # Copy each occurrence separately, including duplicate references.
        evidence = []
        for ref in selected:
            record = records[ref]
            evidence.append({
                "record_ref": ref,
                **record,
                "provenance": dict(record["provenance"]),
                "display": {
                    **record["display"],
                    "notes": list(record["display"]["notes"]),
                },
            })
        return {
            "status": "ok",
            "reason": "",
            "snapshot_ref": catalog_snapshot_ref,
            "digest": catalog_snapshot_ref[len(_REFERENCE_PREFIX):],
            "records": evidence,
        }
