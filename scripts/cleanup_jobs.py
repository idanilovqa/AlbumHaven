"""Run one bounded batch of durable-job retention cleanup."""

from __future__ import annotations

import argparse
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
from typing import Any, TextIO


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


_COUNT_KEYS = (
    "transitions",
    "compacted_jobs",
    "tombstones",
    "worker_instances",
)


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    service_factory: Callable[[str], Any] | None = None,
) -> int:
    output = sys.stdout if stdout is None else stdout
    errors = sys.stderr if stderr is None else stderr
    environment = os.environ if environ is None else environ
    arguments = _parser().parse_args(tuple(sys.argv[1:] if argv is None else argv))

    try:
        database_url = str(
            environment.get("ALBUM_HAVEN_MIGRATOR_DATABASE_URL") or ""
        ).strip()
        if not database_url:
            raise ValueError("migrator database URL is required")
        if service_factory is None:
            from music_app.services.jobs.retention_postgres import (
                PostgresJobRetentionService,
            )

            service = PostgresJobRetentionService(database_url=database_url)
        else:
            service = service_factory(database_url)
    except Exception:
        print("Job retention cleanup configuration is invalid.", file=errors)
        return 2

    try:
        counts = service.cleanup(
            batch_size=arguments.batch_size,
            now=datetime.now(timezone.utc),
        )
        values = _validated_counts(counts)
    except Exception:
        print("Job retention cleanup failed.", file=errors)
        return 1

    print(
        " ".join(f"{key}={values[key]}" for key in _COUNT_KEYS),
        file=output,
    )
    return 0


def _validated_counts(value: object) -> dict[str, int]:
    if not isinstance(value, Mapping):
        raise ValueError("cleanup result is invalid")
    counts: dict[str, int] = {}
    for key in _COUNT_KEYS:
        count = value.get(key)
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError("cleanup result is invalid")
        counts[key] = count
    return counts


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run one bounded durable-job retention cleanup batch."
    )
    parser.add_argument(
        "--batch-size",
        type=_batch_size,
        default=1_000,
        metavar="1..10000",
        help="maximum rows per cleanup category (default: 1000)",
    )
    return parser


def _batch_size(value: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("batch size must be an integer") from None
    if not 1 <= parsed <= 10_000:
        raise argparse.ArgumentTypeError("batch size must be from 1 through 10000")
    return parsed


if __name__ == "__main__":
    raise SystemExit(main())
