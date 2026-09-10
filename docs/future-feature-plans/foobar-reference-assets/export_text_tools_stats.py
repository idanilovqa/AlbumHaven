"""Convert a Foobar2000 Text Tools TSV export to JSON Lines."""

from __future__ import annotations

import argparse
import csv
import json
import os
import tempfile
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Text Tools tab-separated export")
    parser.add_argument("output", type=Path, help="new JSON Lines output path")
    return parser.parse_args()


def convert(source: Path, destination: Path) -> int:
    source = source.expanduser().resolve(strict=True)
    destination = destination.expanduser()
    destination = destination.parent.resolve(strict=False) / destination.name
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f"Output already exists: {destination}")
    if source == destination:
        raise ValueError("Input and output paths must differ.")

    destination.parent.mkdir(parents=True, exist_ok=True)
    row_count = 0
    with source.open("r", encoding="utf-8-sig", newline="") as input_stream:
        reader = csv.DictReader(input_stream, delimiter="\t", quoting=csv.QUOTE_NONE)
        if not reader.fieldnames or "path" not in reader.fieldnames:
            raise ValueError("Expected a tab-separated Text Tools export with a path column.")
        if any(not name for name in reader.fieldnames) or len(set(reader.fieldnames)) != len(reader.fieldnames):
            raise ValueError("Text Tools header columns must be nonempty and unique.")
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="\n", delete=False,
                dir=destination.parent, prefix=f".{destination.name}.", suffix=".tmp",
            ) as output_stream:
                temporary_path = Path(output_stream.name)
                for row in reader:
                    if None in row or any(value is None for value in row.values()):
                        raise ValueError(
                            f"Malformed Text Tools row {reader.line_num}: "
                            f"expected {len(reader.fieldnames)} columns."
                        )
                    record = {str(key): str(value or "") for key, value in row.items() if key}
                    output_stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
                    output_stream.write("\n")
                    row_count += 1
            # Linking publishes the complete file atomically and never replaces a winner.
            os.link(temporary_path, destination)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
    return row_count


def main() -> int:
    args = parse_args()
    rows = convert(args.input, args.output)
    print(f"Wrote {rows} row(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
