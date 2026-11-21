from __future__ import annotations

import logging
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import app_logging, log_history


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_configure_app_logging_is_console_only_and_creates_no_log_directory(tmp_path):
    app = SimpleNamespace(
        config={"DATA_DIR": tmp_path},
        logger=logging.getLogger("tests.app_logging.console_only"),
    )
    root_logger = logging.getLogger()
    original_handlers = list(root_logger.handlers)
    root_logger.handlers = []

    try:
        app_logging.configure_app_logging(app)

        assert len(root_logger.handlers) == 1
        assert isinstance(root_logger.handlers[0], logging.StreamHandler)
        assert not isinstance(root_logger.handlers[0], TimedRotatingFileHandler)
        assert not any(hasattr(handler, "baseFilename") for handler in root_logger.handlers)
        assert not (tmp_path / "logs").exists()
        assert app.logger.propagate is True
    finally:
        for handler in root_logger.handlers:
            if handler not in original_handlers:
                handler.close()
        root_logger.handlers = original_handlers


@pytest.mark.parametrize(
    "history_error",
    [
        PermissionError("history database unavailable password=hunter2"),
        RuntimeError("history serializer failed token=secret-token"),
    ],
    ids=["permission-error", "unexpected-error"],
)
def test_log_app_event_keeps_primary_event_when_scoped_history_append_fails(
    monkeypatch,
    caplog,
    history_error,
):
    logger = logging.getLogger("tests.app_logging.transient_feed_failure")
    config = {
        "DATABASE_URL": "postgresql://album_haven:do-not-leak@example.test/album_haven",
    }

    def fail_transient_feed_append(_config, _payload, *, scope):
        assert scope.library_id == 9
        raise history_error

    monkeypatch.setattr(app_logging, "append_log_history", fail_transient_feed_append)

    with caplog.at_level(logging.INFO):
        app_logging.log_app_event(
            config,
            logger,
            "Library indexing failed",
            level="error",
            history=True,
            history_scope=log_history.HistoryScope(library_id=9),
            scan_id="scan-14",
        )

    primary_records = [
        record
        for record in caplog.records
        if record.name == logger.name and record.levelno == logging.ERROR
    ]
    assert len(primary_records) == 1
    assert primary_records[0].getMessage() == (
        '{"action": "Library indexing failed", "scan_id": "scan-14"}'
    )

    warning_records = [
        record
        for record in caplog.records
        if record.name == app_logging.__name__ and record.levelno == logging.WARNING
    ]
    assert len(warning_records) == 1
    warning_message = warning_records[0].getMessage()
    assert "log history" in warning_message.lower()
    assert "Library indexing failed" in warning_message
    assert type(history_error).__name__ in warning_message
    assert config["DATABASE_URL"] not in warning_message
    assert "do-not-leak" not in warning_message
    assert "hunter2" not in warning_message
    assert "secret-token" not in warning_message


def test_log_app_event_history_forwards_scope_without_filesystem(tmp_path, monkeypatch):
    logger = logging.getLogger("tests.app_logging.scoped_history")
    config = {"DATA_DIR": tmp_path}
    scope = log_history.HistoryScope(library_id=9)
    captured = []
    monkeypatch.setattr(app_logging, "append_log_history",
                        lambda config, payload, *, scope: captured.append((dict(payload), scope)))
    app_logging.log_app_event(config, logger, "Library indexing completed",
                              history=True, history_scope=scope, scan_id="scan-local")
    assert captured == [({"action": "Library indexing completed", "scan_id": "scan-local", "level": "info"}, scope)]
    assert not list(tmp_path.rglob("*"))


def test_production_python_surface_has_no_emit_to_file_routing_hint():
    offenders: list[str] = []

    for source_path in sorted((REPO_ROOT / "music_app").rglob("*.py")):
        if "emit_to_file" in source_path.read_text(encoding="utf-8"):
            offenders.append(str(source_path.relative_to(REPO_ROOT)))

    assert offenders == []


def test_provider_events_reach_the_application_log_but_never_open_log_history(monkeypatch, caplog):
    """Cover provider searches log per query, candidate and probe; a pasted
    album link's expansion runs them once per URL. Each history write opens a
    database connection, so provider events never write history."""
    import logging

    from music_app.services import app_logging, cover_manual_links, cover_provider_runtime

    writes = []
    monkeypatch.setattr(app_logging, "append_log_history", lambda *args, **kwargs: writes.append(args))
    logger = logging.getLogger("provider-events-test")
    with caplog.at_level(logging.INFO, logger="provider-events-test"):
        for index in range(50):
            cover_provider_runtime.log_provider_event({"DATA_DIR": "unused"}, logger, "Probe rejected candidate", level="info", index=index)
    assert writes == []
    assert len([record for record in caplog.records if "Probe rejected candidate" in record.getMessage()]) == 50
    # The pasted-link expansion hands the provider helpers this logger.
    assert "cover_provider_runtime.log_provider_event" in __import__("inspect").getsource(cover_manual_links)
