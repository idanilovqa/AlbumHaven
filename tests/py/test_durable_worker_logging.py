from __future__ import annotations

import json
import logging

import pytest


def test_durable_pipeline_logger_drops_private_legacy_fields(caplog):
    from music_app.jobs.safe_logging import DurablePipelineLogger

    caplog.set_level(logging.INFO)
    secret_path = "C:/private-fixtures/Artist/Album/01.flac"
    secret_url = "https://provider.invalid/private-token/cover.jpg"
    secret_error = "provider payload private-token"
    logger = DurablePipelineLogger(
        logging.getLogger("test.durable.safe.cover"), domain="cover"
    )

    logger.log(
        logging.INFO,
        json.dumps(
            {
                "action": "Cover lookup task started",
                "artist": "Private Artist",
                "album": "Private Album",
                "track_count": 3,
                "remote_url": secret_url,
            }
        ),
    )
    logger.warning("Cover refresh failed path=%s error=%r", secret_path, secret_error)
    logger.verbose("Cover candidate url=%s", secret_url)
    try:
        raise RuntimeError(secret_error)
    except RuntimeError:
        logger.exception("Cover provider failed url=%s", secret_url)

    messages = [record.getMessage() for record in caplog.records]
    combined = "\n".join(messages)
    assert "durable_cover_pipeline_event" in combined
    assert "lookup_started" in combined
    assert '"track_count": 3' in combined
    assert secret_path not in combined
    assert secret_url not in combined
    assert secret_error not in combined
    assert "Private Artist" not in combined
    assert "Private Album" not in combined


def test_worker_process_boundary_sanitizes_module_global_provider_logs(caplog):
    from music_app.jobs.safe_logging import install_durable_worker_logging_boundary

    caplog.set_level(logging.INFO)
    secret_path = "C:/private-fixtures/Artist/Album/01.flac"
    secret_url = "https://provider.invalid/private-token/cover.jpg"
    previous_factory = install_durable_worker_logging_boundary()
    try:
        logging.getLogger("music_app.services.cover_provider_runtime").error(
            "Provider failed artist=%s path=%s url=%s",
            "Private Artist",
            secret_path,
            secret_url,
            exc_info=RuntimeError("private provider payload"),
        )
        logging.getLogger("music_app.services.cover_refresh_execution").warning(
            "Refresh failed sample=%r", [secret_path]
        )
    finally:
        logging.setLogRecordFactory(previous_factory)

    combined = "\n".join(record.getMessage() for record in caplog.records)
    assert combined.count("durable_legacy_pipeline_event") == 2
    assert secret_path not in combined
    assert secret_url not in combined
    assert "Private Artist" not in combined
    assert "private provider payload" not in combined


@pytest.mark.parametrize(
    ("logger_name", "expected_group"),
    (
        ("music_app.services.watcher_recovery_postgres", "scan"),
        ("music_app.services.cover_provider_runtime", "cover"),
        ("music_app.services.album_cover", "cover"),
        ("third_party.discovery", "dependency"),
    ),
)
def test_worker_process_boundary_classifies_semantic_logger_tokens(
    caplog,
    logger_name,
    expected_group,
):
    from music_app.jobs.safe_logging import install_durable_worker_logging_boundary

    caplog.set_level(logging.ERROR)
    previous_factory = install_durable_worker_logging_boundary()
    try:
        logging.getLogger(logger_name).error("private payload")
    finally:
        logging.setLogRecordFactory(previous_factory)

    assert caplog.records[-1].getMessage() == (
        f"durable_legacy_pipeline_event logger_group={expected_group} level=error"
    )


def test_worker_process_boundary_sanitizes_watcher_incident_payloads(caplog):
    from music_app.jobs.safe_logging import install_durable_worker_logging_boundary

    caplog.set_level(logging.ERROR)
    secret_path = "C:/private-fixtures/Account/Library/secret.flac"
    warning_token = "e13136be-bf78-450a-b4a5-d2d6a55f3330"
    exception_text = "OperationalError(password=private-token)"
    previous_factory = install_durable_worker_logging_boundary()
    try:
        try:
            raise RuntimeError(exception_text)
        except RuntimeError:
            logging.getLogger("music_app.services.watcher_recovery_postgres").exception(
                "Watcher failure account=%s library=%s path=%s token=%s",
                "Private Account",
                "Private Library",
                secret_path,
                warning_token,
            )
    finally:
        logging.setLogRecordFactory(previous_factory)

    combined = "\n".join(record.getMessage() for record in caplog.records)
    assert "durable_legacy_pipeline_event" in combined
    assert "logger_group=scan" in combined
    for private_value in (
        secret_path,
        warning_token,
        exception_text,
        "Private Account",
        "Private Library",
    ):
        assert private_value not in combined


def test_durable_scan_file_history_uses_closed_reason_without_private_fields(monkeypatch):
    from music_app.services import state

    events = []
    monkeypatch.setattr(
        state,
        "log_app_event",
        lambda config, logger, action, **fields: events.append((action, fields)),
    )
    record = state._bounded_file_error_history_recorder(
        {"DURABLE_WORKER_SAFE_LOGGING": True},
        object(),
        scan_generation=7,
    )

    record(
        "Library metadata read failed",
        path="C:/private-fixtures/Artist/Album/01.flac",
        error="provider payload private-token",
        error_type="PrivateProviderFailure",
    )

    assert events == [
        (
            "Durable library file error",
            {
                "level": "error",
                "history": True,
                "history_scope": None,
                "scan_generation": 7,
                "reason_code": "metadata_read_failed",
            },
        )
    ]


def test_durable_scan_failure_history_store_never_receives_exception_or_path(monkeypatch):
    from music_app.services import app_logging, scan_state

    history_payloads = []
    history_scopes = []

    def append_history(_config, payload, *, scope):
        history_payloads.append(payload)
        history_scopes.append(scope)

    monkeypatch.setattr(
        app_logging,
        "append_log_history",
        append_history,
    )

    scan_state._log_scan_history_failure(
        {"DURABLE_WORKER_SAFE_LOGGING": True},
        logging.getLogger("test.durable.scan.history"),
        legacy_action="Library indexing failed",
        reason_code="indexing_failed",
        scan_generation=9,
        error="C:/private-fixtures/Artist/Album/01.flac private-token",
        scan_phase="indexing C:/private-fixtures",
    )

    assert history_payloads == [
        {
            "action": "Durable library scan failed",
            "reason_code": "indexing_failed",
            "scan_generation": 9,
            "level": "error",
        }
    ]
    assert history_scopes == [None]
