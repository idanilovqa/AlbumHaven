"""Split the Python suite into parallel CI shards by measured file time.

Each shard collects the whole suite and keeps only the test files assigned to
it, so every shard computes the same assignment and no file runs twice or
not at all. Files never move between shards mid-file, which keeps module
fixtures to one setup per run.

Refresh the weights from a complete run's JUnit report with
``python tests/py/pytest_shards.py <pytest-results.xml>``.
"""
from __future__ import annotations

import json
import statistics
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from collections.abc import Iterable, Mapping
from pathlib import Path

SHARD_ENV = "ALBUM_HAVEN_PYTEST_SHARD"
WEIGHTS_PATH = Path(__file__).resolve().parents[1] / "ci" / "pytest-shard-weights.json"


def parse_shard(selection: str) -> tuple[int, int]:
    """``"2/3"`` -> ``(2, 3)``."""
    try:
        index, count = (int(part) for part in selection.split("/"))
    except ValueError:
        raise ValueError(f"{SHARD_ENV} must look like 2/3, got {selection!r}") from None
    if not 1 <= index <= count:
        raise ValueError(f"{SHARD_ENV} must name a shard from 1 to {count}, got {selection!r}")
    return index, count


def shard_owners(files: Iterable[str], weights: Mapping[str, float], count: int) -> dict[str, int]:
    """Assign each file to a shard number, heaviest file first onto the lightest shard.

    A file missing from ``weights`` (a new one) weighs the median file.
    """
    default = statistics.median(weights.values()) if weights else 1.0
    loads = [0.0] * count
    owners: dict[str, int] = {}
    for name in sorted(set(files), key=lambda file: (-weights.get(file, default), file)):
        shard = loads.index(min(loads))
        owners[name] = shard + 1
        loads[shard] += weights.get(name, default)
    return owners


def load_weights() -> dict[str, float]:
    return json.loads(WEIGHTS_PATH.read_text(encoding="utf-8"))


def junit_file_seconds(junit_path: Path) -> dict[str, float]:
    """Seconds per test file, from a pytest JUnit report of the complete suite."""
    seconds: Counter[str] = Counter()
    for case in ET.parse(junit_path).getroot().iter("testcase"):
        file = "/".join(case.get("classname", "").split(".")[:3]) + ".py"
        seconds[file] += float(case.get("time") or 0)
    return {file: round(value, 1) for file, value in sorted(seconds.items())}


if __name__ == "__main__":
    WEIGHTS_PATH.write_text(
        json.dumps(junit_file_seconds(Path(sys.argv[1])), indent=2) + "\n",
        encoding="utf-8",
    )
