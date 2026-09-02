"""Convert a Foobar2000 Text Tools TSV export to JSON Lines."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Text Tools tab-separated export")
    parser.add_argument("output", type=Path, help="new JSON Lines output path")
    return parser.parse_args()


def convert(source: Path, destination: Path) -> int:
    source = source.expanduser().resolve(strict=True)
    destination = destination.expanduser().resolve(strict=False)
    if destination.exists():
        raise FileExistsError(f"Output already exists: {destination}")
    if source == destination:
        raise ValueError("Input and output paths must differ.")

    destination.parent.mkdir(parents=True, exist_ok=True)
    row_count = 0
    with source.open("r", encoding="utf-8-sig", newline="") as input_stream:
        reader = csv.DictReader(input_stream, delimiter="\t")
        if not reader.fieldnames or "path" not in reader.fieldnames:
            raise ValueError("Expected a tab-separated Text Tools export with a path column.")
        with destination.open("x", encoding="utf-8", newline="\n") as output_stream:
            for row in reader:
                record = {str(key): str(value or "") for key, value in row.items() if key}
                output_stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
                output_stream.write("\n")
                row_count += 1
    return row_count


def main() -> int:
    args = parse_args()
    rows = convert(args.input, args.output)
    print(f"Wrote {rows} row(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
