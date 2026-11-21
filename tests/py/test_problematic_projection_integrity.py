from datetime import datetime, timezone


def _reason_row(index: int, *, item_key: str | None = None):
    return {
        "fact_type": "reason",
        "item_key": item_key or f"item-{index:03d}",
        "normalized_reason": f"reason-{index:03d}",
        "display_reason": f"Reason {index:03d}",
        "category_reason": f"Category {index:03d}",
        "fact_kind": None,
        "semantic_child_identity": None,
        "normalized_text": None,
    }


def _search_row(index: int, *, item_key: str = "item-099"):
    return {
        "fact_type": "search",
        "item_key": item_key,
        "normalized_reason": None,
        "display_reason": None,
        "fact_kind": "track_title_search",
        "semantic_child_identity": f"chunk-{index:020d}",
        "normalized_text": f"normalized search chunk {index}",
    }


def _fingerprint(rows, helper_name):
    from music_app.services import problematic_projection_integrity as integrity

    value = 0
    helper = getattr(integrity, helper_name)
    for row in rows:
        if row["fact_type"] == "reason":
            values = (
                row["item_key"],
                row["normalized_reason"],
                row["display_reason"],
                row["category_reason"],
            )
        else:
            values = (
                row["item_key"],
                row["fact_kind"],
                row["semantic_child_identity"],
                row["normalized_text"],
            )
        value ^= helper(*values)
    return integrity._fingerprint_text(value)


class _Repository:
    def __init__(self, state, pages, *, reclaimed=False):
        self.state = state
        self.pages = list(pages)
        self.reclaimed = reclaimed
        self.reclaim_calls = []
        self.progress = []
        self.completed = []

    def reclaim_one_abandoned_build(self, *, now):
        self.reclaim_calls.append(now)
        return self.reclaimed

    def load_due_integrity_audit(self, *, now):
        return self.state

    def read_integrity_page(self, **kwargs):
        self.read_kwargs = kwargs
        return self.pages.pop(0)

    def persist_integrity_audit_progress(self, **kwargs):
        self.progress.append(kwargs)

    def complete_integrity_audit(self, **kwargs):
        self.completed.append(kwargs)
        return {"matched": True, "replacement_enqueued": False}


def _state(**overrides):
    state = {
        "library_id": 17,
        "revision": "rev-2",
        "audit_revision": "rev-2",
        "after_fact_type": "",
        "after_item_key": "",
        "after_identity_one": "",
        "after_identity_two": "",
        "after_identity_three": "",
        "item_count": 0,
        "last_counted_item_key": "",
        "reason_fact_count": 0,
        "reason_fingerprint": "0" * 256,
        "search_fact_count": 0,
        "search_fingerprint": "0" * 256,
        "audit_claim_token": "claim-1",
    }
    state.update(overrides)
    return state


def test_reconcile_due_pages_reason_and_search_facts_with_bounded_generic_cursor():
    from music_app.services.problematic_projection_integrity import (
        ProblematicProjectionIntegrityReconciler,
    )

    now = datetime(2026, 10, 28, tzinfo=timezone.utc)
    reason_rows = tuple(_reason_row(index) for index in range(99))
    search_rows = (_search_row(0),)
    rows = reason_rows + search_rows
    repository = _Repository(_state(), [rows])

    assert (
        ProblematicProjectionIntegrityReconciler(
            repository=repository
        ).reconcile_due(now=now, limit=100)
        == 1
    )

    assert repository.read_kwargs == {
        "library_id": 17,
        "revision": "rev-2",
        "after_fact_type": "",
        "after_item_key": "",
        "after_identity_one": "",
        "after_identity_two": "",
        "after_identity_three": "",
        "limit": 100,
    }
    assert repository.progress == [
        {
            "library_id": 17,
            "revision": "rev-2",
            "audit_claim_token": "claim-1",
            "expected_after_fact_type": "",
            "expected_after_item_key": "",
            "expected_after_identity_one": "",
            "expected_after_identity_two": "",
            "expected_after_identity_three": "",
            "expected_item_count": 0,
            "expected_reason_fact_count": 0,
            "expected_reason_fingerprint": "0" * 256,
            "expected_search_fact_count": 0,
            "expected_search_fingerprint": "0" * 256,
            "after_fact_type": "search",
            "after_item_key": "item-099",
            "after_identity_one": "track_title_search",
            "after_identity_two": "chunk-00000000000000000000",
            "after_identity_three": "",
            "item_count": 99,
            "last_counted_item_key": "item-098",
            "reason_fact_count": 99,
            "reason_fingerprint": _fingerprint(
                reason_rows, "_reason_fact_fingerprint"
            ),
            "search_fact_count": 1,
            "search_fingerprint": _fingerprint(
                search_rows, "_search_fact_fingerprint"
            ),
            "now": now,
        }
    ]
    assert repository.completed == []


def test_reconcile_due_resets_all_fact_state_for_new_revision_and_completes():
    from music_app.services.problematic_projection_integrity import (
        ProblematicProjectionIntegrityReconciler,
    )

    now = datetime(2026, 10, 28, tzinfo=timezone.utc)
    reason_rows = (_reason_row(0, item_key="new-item"),)
    search_rows = (_search_row(0, item_key="new-item"),)
    rows = reason_rows + search_rows
    repository = _Repository(
        _state(
            revision="rev-new",
            audit_revision="rev-old",
            after_fact_type="search",
            after_item_key="stale",
            after_identity_one="stale",
            after_identity_two="stale",
            after_identity_three="stale",
            item_count=41,
            last_counted_item_key="stale",
            reason_fact_count=41,
            reason_fingerprint="1" * 256,
            search_fact_count=41,
            search_fingerprint="1" * 256,
        ),
        [rows],
    )

    assert (
        ProblematicProjectionIntegrityReconciler(
            repository=repository
        ).reconcile_due(now=now, limit=100)
        == 1
    )

    assert repository.read_kwargs["after_fact_type"] == ""
    assert repository.completed == [
        {
            "library_id": 17,
            "revision": "rev-new",
            "audit_claim_token": "claim-1",
            "item_count": 1,
            "reason_fact_count": 1,
            "reason_fingerprint": _fingerprint(
                reason_rows, "_reason_fact_fingerprint"
            ),
            "search_fact_count": 1,
            "search_fingerprint": _fingerprint(
                search_rows, "_search_fact_fingerprint"
            ),
            "now": now,
        }
    ]


def test_reconcile_due_search_fingerprint_changes_for_text_or_identity_corruption():
    from music_app.services.problematic_projection_integrity import (
        ProblematicProjectionIntegrityReconciler,
    )

    now = datetime(2026, 10, 29, tzinfo=timezone.utc)

    def reconcile(row):
        repository = _Repository(_state(), [(row,)])
        assert (
            ProblematicProjectionIntegrityReconciler(
                repository=repository
            ).reconcile_due(now=now, limit=1)
            == 1
        )
        return repository.progress[0]

    baseline = reconcile(_search_row(0))
    changed_text = reconcile({**_search_row(0), "normalized_text": "changed"})
    changed_identity = reconcile(_search_row(1))

    assert baseline["search_fact_count"] == 1
    assert len(baseline["search_fingerprint"]) == 256
    assert baseline["search_fingerprint"] != changed_text["search_fingerprint"]
    assert baseline["search_fingerprint"] != changed_identity["search_fingerprint"]


def test_reconcile_due_reason_fingerprint_changes_for_category_only_corruption():
    from music_app.services.problematic_projection_integrity import (
        ProblematicProjectionIntegrityReconciler,
    )

    now = datetime(2026, 10, 29, tzinfo=timezone.utc)

    def reconcile(row):
        repository = _Repository(_state(), [(row,)])
        assert ProblematicProjectionIntegrityReconciler(
            repository=repository
        ).reconcile_due(now=now, limit=1) == 1
        return repository.progress[0]["reason_fingerprint"]

    baseline = reconcile(_reason_row(0))
    changed_category = reconcile(
        {**_reason_row(0), "category_reason": "Different category"}
    )

    assert baseline != changed_category


def test_reconcile_due_processes_at_most_one_due_library():
    from music_app.services.problematic_projection_integrity import (
        ProblematicProjectionIntegrityReconciler,
    )

    repository = _Repository(None, [])
    assert (
        ProblematicProjectionIntegrityReconciler(
            repository=repository
        ).reconcile_due(
            now=datetime(2026, 10, 28, tzinfo=timezone.utc),
            limit=100,
        )
        == 0
    )


def test_reconcile_due_reclaims_before_integrity_work():
    from music_app.services.problematic_projection_integrity import (
        ProblematicProjectionIntegrityReconciler,
    )

    now = datetime(2026, 10, 28, tzinfo=timezone.utc)
    repository = _Repository(_state(), [], reclaimed=True)
    assert (
        ProblematicProjectionIntegrityReconciler(
            repository=repository
        ).reconcile_due(now=now, limit=100)
        == 1
    )
    assert repository.reclaim_calls == [now]
    assert not hasattr(repository, "read_kwargs")
