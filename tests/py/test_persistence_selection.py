from __future__ import annotations

import pytest

from config import PERSISTENCE_SEAM_IDS
from music_app.services.persistence_selection import (
    AVAILABLE_RUNTIME_PERSISTENCE_BACKENDS,
    select_runtime_persistence_adapter,
)


def test_postgres_only_runtime_does_not_register_file_backends_by_default():
    assert all(
        "file" not in available_backends
        for available_backends in AVAILABLE_RUNTIME_PERSISTENCE_BACKENDS.values()
    )


def test_postgres_only_runtime_rejects_unavailable_postgres_adapter():
    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            "listen_history",
            {"PERSISTENCE_BACKENDS": {"listen_history": "postgres"}},
            available_backends={"listen_history": {"file"}},
        )


def test_default_runtime_persistence_selection_raises_when_postgres_adapter_is_unavailable():
    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            "listen_history",
            {"PERSISTENCE_BACKENDS": {"listen_history": "postgres"}},
        )


def test_runtime_persistence_selection_rejects_file_backend_request():
    with pytest.raises(ValueError, match="Postgres-only"):
        select_runtime_persistence_adapter(
            "listen_history",
            {"PERSISTENCE_BACKENDS": {"listen_history": "file"}},
        )


def test_postgres_request_uses_postgres_when_adapter_is_registered():
    selection = select_runtime_persistence_adapter(
        "listen_history",
        {"PERSISTENCE_BACKENDS": {"listen_history": "postgres"}},
        available_backends={"listen_history": {"postgres"}},
    )

    assert selection.requested_backend == "postgres"
    assert selection.effective_backend == "postgres"
    assert selection.fallback_reason == ""


def test_postgres_request_uses_postgres_when_file_is_also_injected_as_available():
    selection = select_runtime_persistence_adapter(
        "listen_history",
        {"PERSISTENCE_BACKENDS": {"listen_history": "postgres"}},
        available_backends={"listen_history": {"file", "postgres"}},
    )

    assert selection.requested_backend == "postgres"
    assert selection.effective_backend == "postgres"
    assert selection.fallback_reason == ""


def test_track_preferences_postgres_request_uses_postgres_when_runtime_adapter_is_usable(monkeypatch):
    monkeypatch.setattr("music_app.services.track_preferences_postgres.psycopg", object())

    selection = select_runtime_persistence_adapter(
        "track_preferences",
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "PERSISTENCE_BACKENDS": {"track_preferences": "postgres"},
        },
    )

    assert selection.requested_backend == "postgres"
    assert selection.effective_backend == "postgres"
    assert selection.fallback_reason == ""


def test_track_preferences_postgres_request_raises_when_driver_is_unavailable(
    monkeypatch,
):
    monkeypatch.setattr("music_app.services.track_preferences_postgres.psycopg", None)

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            "track_preferences",
            {
                "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
                "PERSISTENCE_BACKENDS": {"track_preferences": "postgres"},
            },
        )


def test_library_browse_postgres_request_uses_postgres_when_runtime_adapter_is_usable(monkeypatch):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakePsycopg())

    selection = select_runtime_persistence_adapter(
        "library_browse",
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "PERSISTENCE_BACKENDS": {"library_browse": "postgres"},
        },
    )

    assert selection.requested_backend == "postgres"
    assert selection.effective_backend == "postgres"
    assert selection.fallback_reason == ""


def test_library_browse_postgres_request_raises_when_driver_is_unavailable(
    monkeypatch,
):
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", None)

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            "library_browse",
            {
                "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
                "PERSISTENCE_BACKENDS": {"library_browse": "postgres"},
            },
        )


def test_library_browse_postgres_request_raises_when_database_url_is_missing(
    monkeypatch,
):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", FakePsycopg())

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            "library_browse",
            {"PERSISTENCE_BACKENDS": {"library_browse": "postgres"}},
        )


def test_library_roots_postgres_request_uses_postgres_when_runtime_adapter_is_usable(monkeypatch):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr("music_app.services.library_roots_postgres.psycopg", FakePsycopg())

    selection = select_runtime_persistence_adapter(
        "library_roots",
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "PERSISTENCE_BACKENDS": {"library_roots": "postgres"},
        },
    )

    assert selection.requested_backend == "postgres"
    assert selection.effective_backend == "postgres"
    assert selection.fallback_reason == ""


def test_library_roots_postgres_request_raises_when_driver_is_unavailable(
    monkeypatch,
):
    monkeypatch.setattr("music_app.services.library_roots_postgres.psycopg", None)

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            "library_roots",
            {
                "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
                "PERSISTENCE_BACKENDS": {"library_roots": "postgres"},
            },
        )


def test_library_roots_postgres_request_raises_when_database_url_is_missing(
    monkeypatch,
):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr("music_app.services.library_roots_postgres.psycopg", FakePsycopg())

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            "library_roots",
            {"PERSISTENCE_BACKENDS": {"library_roots": "postgres"}},
        )


def test_cover_lookup_tasks_postgres_request_uses_postgres_when_runtime_adapter_is_usable(
    monkeypatch,
):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr("music_app.services.cover_lookup_tasks_postgres.psycopg", FakePsycopg())

    selection = select_runtime_persistence_adapter(
        "cover_lookup_tasks",
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "PERSISTENCE_BACKENDS": {"cover_lookup_tasks": "postgres"},
        },
    )

    assert selection.requested_backend == "postgres"
    assert selection.effective_backend == "postgres"
    assert selection.fallback_reason == ""


def test_cover_lookup_tasks_postgres_request_raises_when_driver_is_unavailable(
    monkeypatch,
):
    monkeypatch.setattr("music_app.services.cover_lookup_tasks_postgres.psycopg", None)

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            "cover_lookup_tasks",
            {
                "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
                "PERSISTENCE_BACKENDS": {"cover_lookup_tasks": "postgres"},
            },
        )


def test_scan_cache_postgres_request_uses_postgres_when_runtime_adapter_is_usable(monkeypatch):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr("music_app.services.scan_cache_persistence.psycopg", FakePsycopg())

    selection = select_runtime_persistence_adapter(
        "scan_cache",
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "PERSISTENCE_BACKENDS": {"scan_cache": "postgres"},
        },
    )

    assert selection.requested_backend == "postgres"
    assert selection.effective_backend == "postgres"
    assert selection.fallback_reason == ""


def test_scan_cache_postgres_request_raises_when_driver_is_unavailable(
    monkeypatch,
):
    monkeypatch.setattr("music_app.services.scan_cache_persistence.psycopg", None)

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            "scan_cache",
            {
                "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
                "PERSISTENCE_BACKENDS": {"scan_cache": "postgres"},
            },
        )


def test_saved_loops_postgres_request_uses_postgres_when_runtime_adapter_is_usable(monkeypatch):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr("music_app.services.saved_loops_postgres.psycopg", FakePsycopg())

    selection = select_runtime_persistence_adapter(
        "saved_loops",
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "PERSISTENCE_BACKENDS": {"saved_loops": "postgres"},
        },
    )

    assert selection.requested_backend == "postgres"
    assert selection.effective_backend == "postgres"
    assert selection.fallback_reason == ""


def test_saved_loops_postgres_request_raises_when_driver_is_unavailable(
    monkeypatch,
):
    monkeypatch.setattr("music_app.services.saved_loops_postgres.psycopg", None)

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            "saved_loops",
            {
                "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
                "PERSISTENCE_BACKENDS": {"saved_loops": "postgres"},
            },
        )


def test_discovery_center_preferences_postgres_request_uses_postgres_when_runtime_adapter_is_usable(
    monkeypatch,
):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr(
        "music_app.services.discovery_center_preferences_postgres.psycopg",
        FakePsycopg(),
    )

    selection = select_runtime_persistence_adapter(
        "discovery_center_preferences",
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "PERSISTENCE_BACKENDS": {"discovery_center_preferences": "postgres"},
        },
    )

    assert selection.requested_backend == "postgres"
    assert selection.effective_backend == "postgres"
    assert selection.fallback_reason == ""


def test_discovery_center_preferences_postgres_request_raises_when_driver_is_unavailable(
    monkeypatch,
):
    monkeypatch.setattr(
        "music_app.services.discovery_center_preferences_postgres.psycopg",
        None,
    )

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            "discovery_center_preferences",
            {
                "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
                "PERSISTENCE_BACKENDS": {"discovery_center_preferences": "postgres"},
            },
        )


@pytest.mark.parametrize(
    ("seam_id", "module_path"),
    [
        ("lastfm_settings", "music_app.services.lastfm_postgres"),
        ("lastfm_sync_state", "music_app.services.lastfm_postgres"),
        ("listen_history", "music_app.services.listen_history_postgres"),
    ],
)
def test_lastfm_listen_postgres_request_uses_postgres_when_runtime_adapter_is_usable(
    seam_id,
    module_path,
    monkeypatch,
):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr(f"{module_path}.psycopg", FakePsycopg())

    selection = select_runtime_persistence_adapter(
        seam_id,
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "PERSISTENCE_BACKENDS": {seam_id: "postgres"},
        },
    )

    assert selection.requested_backend == "postgres"
    assert selection.effective_backend == "postgres"
    assert selection.fallback_reason == ""


@pytest.mark.parametrize(
    ("seam_id", "module_path"),
    [
        ("lastfm_settings", "music_app.services.lastfm_postgres"),
        ("lastfm_sync_state", "music_app.services.lastfm_postgres"),
        ("listen_history", "music_app.services.listen_history_postgres"),
    ],
)
def test_lastfm_listen_postgres_request_raises_when_driver_is_unavailable(
    seam_id,
    module_path,
    monkeypatch,
):
    monkeypatch.setattr(f"{module_path}.psycopg", None)

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            seam_id,
            {
                "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
                "PERSISTENCE_BACKENDS": {seam_id: "postgres"},
            },
        )


@pytest.mark.parametrize(
    "seam_id",
    [
        "ignored_versions",
        "ignored_repairs",
        "manual_versions",
        "separate_releases",
        "exception_overrides",
    ],
)
def test_rule_state_postgres_request_uses_postgres_when_runtime_adapter_is_usable(
    seam_id,
    monkeypatch,
):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakePsycopg())

    selection = select_runtime_persistence_adapter(
        seam_id,
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "PERSISTENCE_BACKENDS": {seam_id: "postgres"},
        },
    )

    assert selection.requested_backend == "postgres"
    assert selection.effective_backend == "postgres"
    assert selection.fallback_reason == ""


@pytest.mark.parametrize(
    "seam_id",
    [
        "ignored_versions",
        "ignored_repairs",
        "manual_versions",
        "separate_releases",
        "exception_overrides",
    ],
)
def test_rule_state_postgres_request_raises_when_driver_is_unavailable(
    seam_id,
    monkeypatch,
):
    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", None)

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            seam_id,
            {
                "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
                "PERSISTENCE_BACKENDS": {seam_id: "postgres"},
            },
        )


@pytest.mark.parametrize(
    "seam_id",
    [
        "ignored_versions",
        "ignored_repairs",
        "manual_versions",
        "separate_releases",
        "exception_overrides",
    ],
)
def test_rule_state_postgres_request_raises_when_database_url_is_missing(
    seam_id,
    monkeypatch,
):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakePsycopg())

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            seam_id,
            {"PERSISTENCE_BACKENDS": {seam_id: "postgres"}},
        )


def test_every_configured_seam_has_no_default_file_adapter_registered():
    for seam_id in PERSISTENCE_SEAM_IDS:
        assert "file" not in AVAILABLE_RUNTIME_PERSISTENCE_BACKENDS[seam_id]


def test_runtime_persistence_selection_rejects_unknown_seam():
    with pytest.raises(ValueError, match="unknown-seam"):
        select_runtime_persistence_adapter(
            "unknown-seam",
            {"PERSISTENCE_BACKENDS": {}},
        )


def test_runtime_persistence_selection_rejects_unregistered_requested_backend():
    with pytest.raises(ValueError, match="ALBUM_HAVEN_PERSISTENCE_LISTEN_HISTORY"):
        select_runtime_persistence_adapter(
            "listen_history",
            {"PERSISTENCE_BACKENDS": {"listen_history": "sqlite"}},
        )


@pytest.mark.parametrize(
    ("available_backends", "message"),
    [
        ([], "available_backends must be a mapping"),
        ({"unknown-seam": {"postgres"}}, "Unknown persistence seam: unknown-seam"),
        ({"listen_history": "postgres"}, "Backends for listen_history must be a collection"),
        ({"listen_history": {"sqlite"}}, "Unsupported persistence backend for listen_history"),
    ],
)
def test_runtime_persistence_selection_rejects_available_backend_normalization_errors(
    available_backends,
    message,
):
    with pytest.raises(ValueError, match=message):
        select_runtime_persistence_adapter(
            "listen_history",
            {"PERSISTENCE_BACKENDS": {"listen_history": "postgres"}},
            available_backends=available_backends,
        )


def test_runtime_persistence_selection_raises_when_registered_backend_set_is_empty():
    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter(
            "listen_history",
            {"PERSISTENCE_BACKENDS": {"listen_history": "postgres"}},
            available_backends={"listen_history": set()},
        )
