from __future__ import annotations

import json
import logging


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
                "scan_generation": 7,
                "reason_code": "metadata_read_failed",
            },
        )
    ]


def test_durable_scan_failure_history_store_never_receives_exception_or_path(monkeypatch):
    from music_app.services import app_logging, scan_state

    history_payloads = []
    monkeypatch.setattr(
        app_logging,
        "append_log_history",
        lambda _config, payload: history_payloads.append(payload),
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
        }
    ]
