from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import pytest

from music_app.services import log_history


REPO_ROOT = Path(__file__).resolve().parents[2]


def _reset_transient_store_if_available() -> None:
    reset = getattr(log_history, "_reset_log_history_for_tests", None)
    if callable(reset):
        reset()


@pytest.fixture(autouse=True)
def reset_transient_store():
    _reset_transient_store_if_available()
    yield
    _reset_transient_store_if_available()


def test_transient_store_exposes_private_reset_for_test_isolation():
    assert callable(getattr(log_history, "_reset_log_history_for_tests", None))


def test_transient_store_normalizes_and_retains_stable_identity_and_times(tmp_path):
    config = {"DATA_DIR": tmp_path}
    domain_time = datetime(2026, 7, 24, 12, 30, tzinfo=timezone.utc)
    original = {
        "id": "  stable-entry  ",
        "timestamp": domain_time,
        "action": "Refresh completed",
    }

    appended = log_history.append_log_history(config, original)
    first_snapshot = log_history.load_log_history(config)
    second_snapshot = log_history.load_log_history(config)

    assert original["id"] == "  stable-entry  "
    assert original["timestamp"] is domain_time
    assert appended == first_snapshot == second_snapshot
    assert first_snapshot[0]["id"] == "stable-entry"
    assert first_snapshot[0]["timestamp"] == domain_time.isoformat()
    recorded_at = first_snapshot[0]["recorded_at"]
    assert isinstance(recorded_at, str)
    assert datetime.fromisoformat(recorded_at).tzinfo is not None


def test_transient_store_generates_stable_identity_and_domain_time_once(tmp_path):
    config = {"DATA_DIR": tmp_path}

    appended = log_history.append_log_history(config, {"action": "Refresh started"})
    first_snapshot = log_history.load_log_history(config)
    second_snapshot = log_history.load_log_history(config)

    assert appended == first_snapshot == second_snapshot
    assert first_snapshot[0]["id"]
    assert datetime.fromisoformat(first_snapshot[0]["timestamp"]).tzinfo is not None
    assert datetime.fromisoformat(first_snapshot[0]["recorded_at"]).tzinfo is not None


def test_transient_store_deduplicates_by_id_with_newest_entry_winning(tmp_path):
    config = {"DATA_DIR": tmp_path}

    log_history.append_log_history(config, {"id": "same-entry", "action": "Older value"})
    items = log_history.append_log_history(
        config,
        {"id": "same-entry", "action": "Newest value"},
    )

    assert len(items) == 1
    assert items[0]["id"] == "same-entry"
    assert items[0]["action"] == "Newest value"


def test_transient_store_snapshot_revision_is_atomic_monotonic_and_resettable(tmp_path):
    config = {"DATA_DIR": tmp_path}

    initial_revision = log_history.load_log_history_revision(config)
    epoch, initial_counter = initial_revision.rsplit(":", 1)
    assert epoch
    assert initial_counter == "0"
    assert log_history.load_log_history_snapshot(config) == {
        "items": [],
        "revision": initial_revision,
    }

    log_history.append_log_history(
        config,
        {"id": "same-entry", "action": "Older value"},
    )
    first_snapshot = log_history.load_log_history_snapshot(config)

    log_history.append_log_history(
        config,
        {"id": "same-entry", "action": "Newest value"},
    )
    second_snapshot = log_history.load_log_history_snapshot(config)

    assert first_snapshot["revision"] == f"{epoch}:1"
    assert first_snapshot["items"][0]["action"] == "Older value"
    assert second_snapshot["revision"] == f"{epoch}:2"
    assert second_snapshot["items"][0]["action"] == "Newest value"
    assert log_history.load_log_history_revision(config) == f"{epoch}:2"

    log_history._reset_log_history_for_tests()

    assert log_history.load_log_history_revision(config) == f"{epoch}:0"
    assert log_history.load_log_history_snapshot(config) == {
        "items": [],
        "revision": f"{epoch}:0",
    }


def test_transient_store_keeps_newest_first_and_caps_at_250(tmp_path):
    config = {"DATA_DIR": tmp_path}

    for index in range(251):
        items = log_history.append_log_history(
            config,
            {"id": f"entry-{index}", "action": f"entry-{index}"},
        )

    assert len(items) == 250
    assert items[0]["id"] == "entry-250"
    assert items[-1]["id"] == "entry-1"


def test_transient_store_concurrent_appends_do_not_lose_entries(tmp_path):
    config = {"DATA_DIR": tmp_path}
    entry_count = 40

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(
            executor.map(
                lambda index: log_history.append_log_history(
                    config,
                    {"id": f"entry-{index}", "action": f"entry-{index}"},
                ),
                range(entry_count),
            )
        )

    items = log_history.load_log_history(config)

    assert len(items) == entry_count
    assert {item["id"] for item in items} == {
        f"entry-{index}" for index in range(entry_count)
    }


def test_transient_store_does_not_create_or_modify_files(tmp_path):
    config = {"DATA_DIR": tmp_path}
    sentinel = tmp_path / "existing.txt"
    sentinel.write_text("unchanged", encoding="utf-8")

    log_history.append_log_history(config, {"id": "entry-1", "action": "Refresh started"})
    assert log_history.load_log_history(config)[0]["id"] == "entry-1"

    assert sentinel.read_text(encoding="utf-8") == "unchanged"
    assert sorted(path.relative_to(tmp_path) for path in tmp_path.rglob("*")) == [
        Path("existing.txt")
    ]


def test_runtime_source_has_no_postgres_log_history_adapter_or_selection_path():
    adapter_path = REPO_ROOT / "music_app" / "services" / "log_history_postgres.py"
    forbidden_tokens = (
        "log_history_postgres",
        "PostgresLogHistoryAdapter",
        'select_runtime_persistence_adapter("log_history"',
    )
    offenders: dict[str, list[str]] = {}

    for source_path in sorted((REPO_ROOT / "music_app").rglob("*.py")):
        source = source_path.read_text(encoding="utf-8")
        matches = [token for token in forbidden_tokens if token in source]
        if matches:
            offenders[str(source_path.relative_to(REPO_ROOT))] = matches

    assert not adapter_path.exists()
    assert offenders == {}
