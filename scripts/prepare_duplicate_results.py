"""Deploy step: fill the stored duplicate results (migration 0268) before the app serves.

Order: stop every writer, apply the migrations, run this, and start the new app only
after it exits 0. Use the same environment as the app's launcher.

    python scripts/prepare_duplicate_results.py            fill, or confirm, readiness
    python scripts/prepare_duplicate_results.py --check    read-only; exit 0 only when ready
    python scripts/prepare_duplicate_results.py --rebuild  fill again

Exit 0: ready. Exit 1: not ready, with one "NOT READY" line. (An app that refuses to
start exits 78 instead; see migrations/postgres/README.md.) Run it from its own terminal,
not inside the app's service or scheduled task, whose restart would stop it.

A rerun does not redo a ready fill. Use --rebuild when a version without these results
ran as a writer after they were filled (a rolled-back deploy): it clears the change
marks without updating them, so "ready" can no longer be trusted.
"""
from __future__ import annotations

import argparse
from collections.abc import Callable, Sequence
from pathlib import Path
import sys
from time import monotonic
from typing import Any, TextIO

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fill the stored duplicate results before the app serves.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="only report readiness; change nothing")
    mode.add_argument("--rebuild", action="store_true", help="fill again even if marked ready")
    return parser


def _build_repository() -> Any:
    from music_app import _build_runtime_config
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    return PostgresLibraryBrowseRepository(_build_runtime_config())


def main(
    argv: Sequence[str] | None = None,
    *,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    repository_factory: Callable[[], Any] = _build_repository,
) -> int:
    output = sys.stdout if stdout is None else stdout
    errors = sys.stderr if stderr is None else stderr
    arguments = _parser().parse_args(tuple(sys.argv[1:] if argv is None else argv))

    from music_app.services import problematic_index

    started = monotonic()

    def report(stage: str, done: int, total: int) -> None:
        print(f"{stage}: {done}/{total} ({monotonic() - started:.1f} s)", file=output, flush=True)

    try:
        repository = repository_factory()
        if not arguments.check:
            print("Preparing duplicate results; do not start the app yet.", file=output, flush=True)
            problematic_index.prepare_for_serving(
                repository, rebuild_duplicates=arguments.rebuild, report=report,
            )
        readiness = problematic_index.serving_readiness(repository)
    except problematic_index.PreparationError as error:
        print(f"NOT READY, do not start serving: {error}", file=errors)
        return 1
    except Exception as error:
        # A driver's message can quote the connection string: name the failure only.
        code = getattr(error, "sqlstate", None)
        detail = type(error).__name__ + (f" (SQLSTATE {code})" if code else "")
        print(f"NOT READY, do not start serving: {detail}", file=errors)
        return 1

    summary = " ".join(f"{name}={value}" for name, value in readiness.items())
    if readiness != {"problematic_index": "ready", "duplicate_results": "ready", "changed_albums_waiting": 0,
                     "changed_loose_groups_waiting": 0}:
        print(f"NOT READY, do not start serving: {summary}", file=errors)
        return 1
    print(f"READY {summary} elapsed_s={monotonic() - started:.1f}", file=output, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
