from __future__ import annotations

import logging
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import app_logging, log_history


REPO_ROOT = Path(__file__).resolve().parents[2]


def _reset_transient_store_if_available() -> None:
    reset = getattr(log_history, "_reset_log_history_for_tests", None)
    if callable(reset):
        reset()


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
        PermissionError("transient feed unavailable password=hunter2"),
        RuntimeError("transient feed serializer failed token=secret-token"),
    ],
    ids=["permission-error", "unexpected-error"],
)
def test_log_app_event_keeps_primary_event_when_transient_feed_append_fails(
    monkeypatch,
    caplog,
    history_error,
):
    logger = logging.getLogger("tests.app_logging.transient_feed_failure")
    config = {
        "DATABASE_URL": "postgresql://album_haven:do-not-leak@example.test/album_haven",
    }

    def fail_transient_feed_append(_config, _payload):
        raise history_error

    monkeypatch.setattr(app_logging, "append_log_history", fail_transient_feed_append)

    with caplog.at_level(logging.INFO):
        app_logging.log_app_event(
            config,
            logger,
            "Library indexing failed",
            level="error",
            history=True,
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


def test_log_app_event_history_uses_transient_feed_without_filesystem(tmp_path):
    _reset_transient_store_if_available()
    logger = logging.getLogger("tests.app_logging.transient_history")
    config = {"DATA_DIR": tmp_path}

    app_logging.log_app_event(
        config,
        logger,
        "Library indexing completed",
        history=True,
        scan_id="scan-local",
    )

    try:
        items = log_history.load_log_history(config)
        assert items[0]["action"] == "Library indexing completed"
        assert items[0]["scan_id"] == "scan-local"
        assert not list(tmp_path.rglob("*"))
    finally:
        _reset_transient_store_if_available()


def test_production_python_surface_has_no_emit_to_file_routing_hint():
    offenders: list[str] = []

    for source_path in sorted((REPO_ROOT / "music_app").rglob("*.py")):
        if "emit_to_file" in source_path.read_text(encoding="utf-8"):
            offenders.append(str(source_path.relative_to(REPO_ROOT)))

    assert offenders == []
