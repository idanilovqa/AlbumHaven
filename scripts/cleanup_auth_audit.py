"""Delete one bounded batch of expired security audit events."""

from __future__ import annotations

import argparse
from collections.abc import Callable, Mapping, Sequence
import os
from pathlib import Path
import sys
from typing import Any, TextIO


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    config_builder: Callable[[Mapping[str, str]], dict[str, Any]] | None = None,
    service_factory: Callable[[Mapping[str, object]], Any] | None = None,
) -> int:
    output = sys.stdout if stdout is None else stdout
    errors = sys.stderr if stderr is None else stderr
    environment = os.environ if environ is None else environ
    arguments = _parser().parse_args(tuple(sys.argv[1:] if argv is None else argv))

    if config_builder is None:
        from config import build_auth_config

        config_builder = build_auth_config
    try:
        config = dict(config_builder(environment))
        config["ALBUM_HAVEN_MIGRATOR_DATABASE_URL"] = str(
            environment.get("ALBUM_HAVEN_MIGRATOR_DATABASE_URL") or ""
        ).strip()
        if service_factory is None:
            from music_app.services.auth_audit_cleanup_postgres import (
                PostgresSecurityAuditCleanupService,
            )

            service_factory = PostgresSecurityAuditCleanupService
        service = service_factory(config)
    except Exception:
        print("Security audit cleanup configuration is invalid.", file=errors)
        return 2

    try:
        deleted = service.cleanup(batch_size=arguments.batch_size)
    except Exception:
        print("Security audit cleanup failed.", file=errors)
        return 1
    print(f"Deleted {deleted} security audit events.", file=output)
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Delete one bounded batch of security audit events past retention."
    )
    parser.add_argument(
        "--batch-size",
        type=_batch_size,
        default=1_000,
        metavar="1..10000",
        help="maximum rows to delete in this invocation (default: 1000)",
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
