"""Raw Foobar Text Tools exports preserve literal metadata characters."""
import importlib.util
import json
from pathlib import Path
import pytest

MODULE_PATH = Path(__file__).resolve().parents[2] / "docs/future-feature-plans/foobar-reference-assets/export_text_tools_stats.py"
spec = importlib.util.spec_from_file_location("foobar_text_tools_export", MODULE_PATH)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

@pytest.mark.parametrize("title", ['"Heroes"', '"unfinished title'])
def test_text_tools_raw_tsv_preserves_literal_quotes_and_record_boundaries(tmp_path, title):
    source = tmp_path / "source.tsv"
    destination = tmp_path / "output.jsonl"
    raw = f"path\ttitle\tartist\nMusic/first.flac\t{title}\tArtist\nMusic/second.flac\tNext\tOther\n"
    source.write_text(raw, encoding="utf-8")
    assert helper.convert(source, destination) == 2
    rows = [json.loads(line) for line in destination.read_text(encoding="utf-8").splitlines()]
    assert rows == [{"path": "Music/first.flac", "title": title, "artist": "Artist"},
                    {"path": "Music/second.flac", "title": "Next", "artist": "Other"}]
    assert source.read_text(encoding="utf-8") == raw