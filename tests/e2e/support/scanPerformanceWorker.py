"""Separate-process durable worker entry point for scan performance tests."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def run_scan_performance_worker(stop_event: Any, diagnostic_path: str = "") -> None:
    from config import build_worker_config
    from scripts.run_jobs_worker import _build_worker

    def record_diagnostic(message: str) -> None:
        if diagnostic_path:
            Path(diagnostic_path).write_text(message, encoding="utf-8")

    worker = _build_worker(
        build_worker_config(),
        full_scan_log_event=record_diagnostic,
    )
    try:
        worker.run(stop_event)
    finally:
        worker.close()
