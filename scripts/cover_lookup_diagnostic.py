from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _apply_isolated_environment() -> str:
    temp_root = tempfile.mkdtemp(prefix="album-haven-cover-lookup-diagnostic-")
    temp_root_path = Path(temp_root)
    os.environ["MUSIC_APP_DATA_DIR"] = str(temp_root_path / "data")
    os.environ["MUSIC_CACHE_PATH"] = str(temp_root_path / "data" / "library_cache.json")
    os.environ["MUSIC_COVER_CACHE_PATH"] = str(temp_root_path / "data" / "cover_search_cache.json")
    os.environ["MUSIC_LIBRARY_ROOTS_PATH"] = str(temp_root_path / "data" / "library_roots.json")
    return temp_root


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run a provider-focused real-network cover lookup diagnostic in an isolated temp sandbox "
            "without touching the app's normal data or caches."
        ),
    )
    parser.add_argument(
        "--provider-warning-ms",
        type=int,
        default=12000,
        help="Soft warning threshold for any single provider call.",
    )
    parser.add_argument(
        "--scenario-warning-ms",
        type=int,
        default=30000,
        help="Soft warning threshold for each scenario duration.",
    )
    parser.add_argument(
        "--total-warning-ms",
        type=int,
        default=45000,
        help="Soft warning threshold for the total multi-scenario diagnostic duration.",
    )
    parser.add_argument(
        "--html-output",
        default="",
        help="Optional path to write the HTML report to.",
    )
    parser.add_argument(
        "--scenario",
        action="append",
        default=[],
        help="Optional scenario id to run. Repeat to run multiple scenarios.",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Optional path to write the JSON report to.",
    )
    parser.add_argument(
        "--json-only",
        action="store_true",
        help="Print only the JSON report instead of the formatted summary plus JSON.",
    )
    return parser


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()
    isolated_root = _apply_isolated_environment()

    from config import Config
    from music_app.services.cover_lookup_diagnostics import (
        DEFAULT_DIAGNOSTIC_SCENARIOS,
        format_cover_lookup_diagnostic_report,
        render_cover_lookup_diagnostic_html,
        run_cover_lookup_diagnostic,
    )

    selected_scenarios = DEFAULT_DIAGNOSTIC_SCENARIOS
    requested_ids = {str(item or "").strip() for item in (args.scenario or []) if str(item or "").strip()}
    if requested_ids:
        selected_scenarios = [
            scenario
            for scenario in DEFAULT_DIAGNOSTIC_SCENARIOS
            if str(scenario.get("id") or "").strip() in requested_ids
        ]
        missing_ids = sorted(requested_ids - {str(scenario.get("id") or "").strip() for scenario in selected_scenarios})
        if missing_ids:
            parser.error(f"Unknown scenario id(s): {', '.join(missing_ids)}")

    report = run_cover_lookup_diagnostic(
        selected_scenarios,
        user_agent=str(Config.MUSICBRAINZ_USER_AGENT),
        provider_warning_ms=int(args.provider_warning_ms),
        scenario_warning_ms=int(args.scenario_warning_ms),
        total_warning_ms=int(args.total_warning_ms),
    )
    report["isolation"] = {
        "temp_root": isolated_root,
        "data_dir": str(Config.DATA_DIR),
        "cover_cache_path": str(Config.COVER_CACHE_PATH),
        "library_cache_path": str(Config.CACHE_PATH),
        "library_roots_path": str(Config.LIBRARY_ROOTS_PATH),
    }

    rendered_json = json.dumps(report, indent=2, ensure_ascii=False)
    rendered_html = render_cover_lookup_diagnostic_html(report)
    if args.output:
        output_path = Path(args.output).expanduser().resolve(strict=False)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered_json + "\n", encoding="utf-8")
    if args.html_output:
        html_output_path = Path(args.html_output).expanduser().resolve(strict=False)
        html_output_path.parent.mkdir(parents=True, exist_ok=True)
        html_output_path.write_text(rendered_html, encoding="utf-8")

    if args.json_only:
        print(rendered_json)
    else:
        print(format_cover_lookup_diagnostic_report(report))
        print("")
        if args.html_output:
            print(f"HTML Report: {str(Path(args.html_output).expanduser().resolve(strict=False))}")
            print("")
        print("JSON Report:")
        print(rendered_json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
