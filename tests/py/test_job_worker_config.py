from __future__ import annotations

import pytest

from config import build_worker_config
from music_app.jobs.worker import create_worker_pool


WORKER_URL = "postgresql://worker-role:private@db.example/album_haven"


def test_worker_config_has_approved_safe_defaults():
    config = build_worker_config({"ALBUM_HAVEN_WORKER_DATABASE_URL": WORKER_URL})

    assert config.database_url == WORKER_URL
    assert config.concurrency == 1
    assert config.lease_seconds == 300
    assert config.heartbeat_seconds == 30
    assert config.poll_seconds == 1
    assert config.max_idle_backoff_seconds == 5
    assert config.drain_seconds == 30


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("ALBUM_HAVEN_WORKER_CONCURRENCY", "0"),
        ("ALBUM_HAVEN_WORKER_CONCURRENCY", "9"),
        ("ALBUM_HAVEN_WORKER_LEASE_SECONDS", "0"),
        ("ALBUM_HAVEN_WORKER_LEASE_SECONDS", "86401"),
        ("ALBUM_HAVEN_WORKER_HEARTBEAT_SECONDS", "0"),
        ("ALBUM_HAVEN_WORKER_POLL_SECONDS", "0"),
        ("ALBUM_HAVEN_WORKER_MAX_IDLE_BACKOFF_SECONDS", "0"),
        ("ALBUM_HAVEN_WORKER_DRAIN_SECONDS", "-1"),
        ("ALBUM_HAVEN_WORKER_DRAIN_SECONDS", "301"),
        ("ALBUM_HAVEN_WORKER_CONCURRENCY", "not-an-integer"),
    ],
)
def test_worker_config_rejects_invalid_or_unbounded_values(name, value):
    with pytest.raises(ValueError):
        build_worker_config(
            {
                "ALBUM_HAVEN_WORKER_DATABASE_URL": WORKER_URL,
                name: value,
            }
        )


def test_worker_config_requires_a_dedicated_worker_database_url():
    with pytest.raises(ValueError, match="worker database URL"):
        build_worker_config(
            {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app-role@db/app"}
        )


def test_worker_config_accepts_approved_maximum_concurrency():
    config = build_worker_config(
        {
            "ALBUM_HAVEN_WORKER_DATABASE_URL": WORKER_URL,
            "ALBUM_HAVEN_WORKER_CONCURRENCY": "8",
        }
    )

    assert config.concurrency == 8


def test_worker_config_requires_heartbeat_no_greater_than_one_third_lease():
    with pytest.raises(ValueError, match="one third"):
        build_worker_config(
            {
                "ALBUM_HAVEN_WORKER_DATABASE_URL": WORKER_URL,
                "ALBUM_HAVEN_WORKER_LEASE_SECONDS": "60",
                "ALBUM_HAVEN_WORKER_HEARTBEAT_SECONDS": "21",
            }
        )


def test_worker_config_accepts_heartbeat_equal_to_one_third_lease():
    config = build_worker_config(
        {
            "ALBUM_HAVEN_WORKER_DATABASE_URL": WORKER_URL,
            "ALBUM_HAVEN_WORKER_LEASE_SECONDS": "60",
            "ALBUM_HAVEN_WORKER_HEARTBEAT_SECONDS": "20",
        }
    )

    assert config.heartbeat_seconds == 20


def test_worker_pool_uses_only_worker_url_and_bounded_size():
    calls = []

    class Pool:
        def __init__(self, *args, **kwargs):
            calls.append((args, kwargs))

    config = build_worker_config(
        {
            "ALBUM_HAVEN_WORKER_DATABASE_URL": WORKER_URL,
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app-role:do-not-use@db/app",
            "ALBUM_HAVEN_WORKER_CONCURRENCY": "4",
        }
    )

    create_worker_pool(config, pool_factory=Pool)

    assert len(calls) == 1
    args, kwargs = calls[0]
    supplied = " ".join(map(str, args)) + " " + " ".join(map(str, kwargs.values()))
    assert WORKER_URL in supplied
    assert "app-role" not in supplied
    assert kwargs["min_size"] == 1
    assert kwargs["max_size"] == 5
    assert 0 < kwargs["timeout"] <= 30
    assert kwargs["kwargs"]["row_factory"].__name__ == "dict_row"
