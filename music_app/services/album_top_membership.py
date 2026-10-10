"""Pure membership transitions over already-resolved catalog album records.

The caller owns resolver trust, authorization and persistence. These functions
only validate supplied snapshots and return detached results; they mint no IDs
or revisions and grant no media access.
"""

from __future__ import annotations

from copy import deepcopy


def _is_nonblank_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _is_resolved_record(record: object) -> bool:
    if not isinstance(record, dict):
        return False
    provenance = record.get("provenance")
    source = record.get("source")
    return (
        _is_nonblank_string(record.get("membership_id"))
        and _is_nonblank_string(record.get("catalog_album_id"))
        and record.get("resolution_status") == "resolved"
        and record.get("entity_kind") == "album"
        and isinstance(provenance, dict)
        and _is_nonblank_string(provenance.get("resolver"))
        and _is_nonblank_string(provenance.get("record_id"))
        and isinstance(source, dict)
        and _is_nonblank_string(source.get("occurrence_id"))
        and type(source.get("position")) is int
        and source["position"] >= 0
    )


def _is_exact_order(order: object, membership_ids: set[str]) -> bool:
    return (
        isinstance(order, list)
        and len(order) == len(membership_ids)
        and all(_is_nonblank_string(entry_id) for entry_id in order)
        and set(order) == membership_ids
    )


def _current_snapshot_error(
    *, members, curator_order, current_revision, expected_revision
) -> str:
    if not (
        _is_nonblank_string(current_revision)
        and _is_nonblank_string(expected_revision)
    ):
        return "invalid_revision"
    if current_revision != expected_revision:
        return "revision_conflict"
    if not isinstance(members, list):
        return "invalid_members"

    membership_ids = set()
    catalog_ids = set()
    for member in members:
        if not _is_resolved_record(member):
            return "invalid_members"
        membership_id = member["membership_id"]
        catalog_id = member["catalog_album_id"]
        if membership_id in membership_ids or catalog_id in catalog_ids:
            return "invalid_members"
        membership_ids.add(membership_id)
        catalog_ids.add(catalog_id)

    if not _is_exact_order(curator_order, membership_ids):
        return "invalid_curator_order"
    return ""


def _failure(reason: str) -> dict[str, object]:
    return {
        "status": "conflict" if reason == "revision_conflict" else "invalid",
        "reason": reason,
        "members": None,
        "curator_order": None,
        "duplicates": [],
    }


def append_resolved_albums(
    *, members, curator_order, incoming, current_revision, expected_revision
) -> dict[str, object]:
    """Append first catalog occurrences and retain every duplicate's evidence."""
    reason = _current_snapshot_error(
        members=members,
        curator_order=curator_order,
        current_revision=current_revision,
        expected_revision=expected_revision,
    )
    if reason:
        return _failure(reason)
    if not isinstance(incoming, list):
        return _failure("invalid_incoming")

    # Validate the whole batch before catalog dedupe can discard any occurrence.
    candidate_ids = {member["membership_id"] for member in members}
    for candidate in incoming:
        if not _is_resolved_record(candidate):
            return _failure("invalid_incoming")
        membership_id = candidate["membership_id"]
        if membership_id in candidate_ids:
            return _failure("invalid_incoming")
        candidate_ids.add(membership_id)

    winners = {
        member["catalog_album_id"]: (member["membership_id"], None)
        for member in members
    }
    result_members = [deepcopy(member) for member in members]
    result_order = list(curator_order)
    duplicates = []
    for index, candidate in enumerate(incoming):
        catalog_id = candidate["catalog_album_id"]
        if catalog_id in winners:
            winner_id, winner_index = winners[catalog_id]
            duplicates.append({
                "incoming_index": index,
                "occurrence": deepcopy(candidate),
                "winner_membership_id": winner_id,
                "winner_kind": "existing" if winner_index is None else "incoming",
                "winner_incoming_index": winner_index,
            })
        else:
            membership_id = candidate["membership_id"]
            winners[catalog_id] = (membership_id, index)
            result_members.append(deepcopy(candidate))
            result_order.append(membership_id)

    return {
        "status": "ok",
        "reason": "",
        "members": result_members,
        "curator_order": result_order,
        "duplicates": duplicates,
    }


def reorder_members(
    *, members, curator_order, ordered_membership_ids, current_revision, expected_revision
) -> dict[str, object]:
    """Return a new curator permutation without changing member admission order."""
    reason = _current_snapshot_error(
        members=members,
        curator_order=curator_order,
        current_revision=current_revision,
        expected_revision=expected_revision,
    )
    if reason:
        return _failure(reason)
    membership_ids = {member["membership_id"] for member in members}
    if not _is_exact_order(ordered_membership_ids, membership_ids):
        return _failure("invalid_order")

    return {
        "status": "ok",
        "reason": "",
        "members": [deepcopy(member) for member in members],
        "curator_order": list(ordered_membership_ids),
        "duplicates": [],
    }
