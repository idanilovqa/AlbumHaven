"""Bounded integrity reconciliation for committed Problematic Files projections."""

from __future__ import annotations

import hashlib
from typing import Any, Mapping


class ProblematicProjectionIntegrityReconciler:
    """Advance at most one due projection audit by one bounded fact page."""

    def __init__(self, *, repository: Any) -> None:
        self._repository = repository

    def reconcile_due(self, *, now: object, limit: int) -> int:
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("integrity reconciliation limit must be between 1 and 100")
        if self._repository.reclaim_one_abandoned_build(now=now):
            return 1
        state = self._repository.load_due_integrity_audit(now=now)
        if state is None:
            return 0

        library_id = state["library_id"]
        revision = str(state["revision"])
        audit_claim_token = str(state["audit_claim_token"])
        same_revision = str(state.get("audit_revision") or "") == revision
        cursor = (
            str(state.get("after_fact_type") or "") if same_revision else "",
            str(state.get("after_item_key") or "") if same_revision else "",
            str(state.get("after_identity_one") or "") if same_revision else "",
            str(state.get("after_identity_two") or "") if same_revision else "",
            str(state.get("after_identity_three") or "") if same_revision else "",
        )
        expected_item_count = int(state.get("item_count") or 0) if same_revision else 0
        expected_reason_count = int(state.get("reason_fact_count") or 0) if same_revision else 0
        expected_reason_fingerprint = (
            _fingerprint_value(state.get("reason_fingerprint")) if same_revision else 0
        )
        expected_search_count = int(state.get("search_fact_count") or 0) if same_revision else 0
        expected_search_fingerprint = (
            _fingerprint_value(state.get("search_fingerprint")) if same_revision else 0
        )
        item_count = expected_item_count
        last_counted_item_key = (
            str(state.get("last_counted_item_key") or "") if same_revision else ""
        )
        reason_count = expected_reason_count
        reason_fingerprint = expected_reason_fingerprint
        search_count = expected_search_count
        search_fingerprint = expected_search_fingerprint

        rows = self._repository.read_integrity_page(
            library_id=library_id,
            revision=revision,
            after_fact_type=cursor[0],
            after_item_key=cursor[1],
            after_identity_one=cursor[2],
            after_identity_two=cursor[3],
            after_identity_three=cursor[4],
            limit=limit,
        )
        for row in rows:
            row_cursor = _integrity_row_cursor(row)
            if row_cursor <= cursor:
                raise ValueError(
                    f"integrity fact cursor did not advance: {row_cursor!r} <= {cursor!r}"
                )
            cursor = row_cursor
            if row_cursor[0] == "reason":
                item_key, normalized_reason, display_reason, category_reason = row_cursor[1:]
                if item_key != last_counted_item_key:
                    item_count += 1
                    last_counted_item_key = item_key
                reason_count += 1
                reason_fingerprint ^= _reason_fact_fingerprint(
                    item_key, normalized_reason, display_reason, category_reason
                )
            else:
                normalized_text = _required_text(row, "normalized_text")
                search_count += 1
                search_fingerprint ^= _search_fact_fingerprint(
                    row_cursor[1], row_cursor[2], row_cursor[3], normalized_text
                )

        if len(rows) == limit:
            self._repository.persist_integrity_audit_progress(
                library_id=library_id,
                revision=revision,
                audit_claim_token=audit_claim_token,
                expected_after_fact_type=(str(state.get("after_fact_type") or "") if same_revision else ""),
                expected_after_item_key=(str(state.get("after_item_key") or "") if same_revision else ""),
                expected_after_identity_one=(str(state.get("after_identity_one") or "") if same_revision else ""),
                expected_after_identity_two=(str(state.get("after_identity_two") or "") if same_revision else ""),
                expected_after_identity_three=(str(state.get("after_identity_three") or "") if same_revision else ""),
                expected_item_count=expected_item_count,
                expected_reason_fact_count=expected_reason_count,
                expected_reason_fingerprint=_fingerprint_text(expected_reason_fingerprint),
                expected_search_fact_count=expected_search_count,
                expected_search_fingerprint=_fingerprint_text(expected_search_fingerprint),
                after_fact_type=cursor[0],
                after_item_key=cursor[1],
                after_identity_one=cursor[2],
                after_identity_two=cursor[3],
                after_identity_three=cursor[4],
                item_count=item_count,
                last_counted_item_key=last_counted_item_key,
                reason_fact_count=reason_count,
                reason_fingerprint=_fingerprint_text(reason_fingerprint),
                search_fact_count=search_count,
                search_fingerprint=_fingerprint_text(search_fingerprint),
                now=now,
            )
        else:
            self._repository.complete_integrity_audit(
                library_id=library_id,
                revision=revision,
                audit_claim_token=audit_claim_token,
                item_count=item_count,
                reason_fact_count=reason_count,
                reason_fingerprint=_fingerprint_text(reason_fingerprint),
                search_fact_count=search_count,
                search_fingerprint=_fingerprint_text(search_fingerprint),
                now=now,
            )
        return 1


def _required_text(row: Mapping[str, object], field: str) -> str:
    value = row.get(field)
    if not isinstance(value, str) or not value:
        raise ValueError(f"integrity row invalid {field}")
    return value


def _integrity_row_cursor(row: Mapping[str, object]) -> tuple[str, str, str, str, str]:
    fact_type = _required_text(row, "fact_type")
    item_key = _required_text(row, "item_key")
    if fact_type == "reason":
        return (
            fact_type,
            item_key,
            _required_text(row, "normalized_reason"),
            _required_text(row, "display_reason"),
            _required_text(row, "category_reason"),
        )
    if fact_type == "search":
        return (
            fact_type,
            item_key,
            _required_text(row, "fact_kind"),
            _required_text(row, "semantic_child_identity"),
            "",
        )
    raise ValueError("integrity row invalid fact type")


def _fingerprint_value(value: object) -> int:
    text = str(value or "0" * 256)
    if len(text) != 256 or set(text) - {"0", "1"}:
        raise ValueError("integrity state invalid fingerprint")
    return int(text, 2)


def _fingerprint_text(value: int) -> str:
    return format(value, "0256b")


def _fact_fingerprint(*values: str) -> int:
    material = bytearray()
    for value in values:
        encoded = value.encode("utf-8")
        material.extend(str(len(encoded)).encode("ascii"))
        material.extend(b":")
        material.extend(encoded)
    return int.from_bytes(hashlib.sha256(material).digest(), "big")


def _reason_fact_fingerprint(
    item_key: str,
    normalized_reason: str,
    display_reason: str,
    category_reason: str,
) -> int:
    return _fact_fingerprint(
        item_key, normalized_reason, display_reason, category_reason
    )


def _search_fact_fingerprint(
    item_key: str,
    fact_kind: str,
    semantic_child_identity: str,
    normalized_text: str,
) -> int:
    return _fact_fingerprint(item_key, fact_kind, semantic_child_identity, normalized_text)


__all__ = ["ProblematicProjectionIntegrityReconciler"]
