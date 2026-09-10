"""Raw Foobar Text Tools exports preserve literal metadata characters."""
import importlib.util
import json
from pathlib import Path
import pytest

MODULE_PATH = Path(__file__).resolve().parents[2] / "docs/future-feature-plans/foobar-reference-assets/export_text_tools_stats.py"
spec = importlib.util.spec_from_file_location("foobar_text_tools_export", MODULE_PATH)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


@pytest.mark.parametrize("header", ["path\ttitle\ttitle", "path\t\tartist"])
def test_text_tools_rejects_ambiguous_header_without_creating_output(tmp_path, header):
    source = tmp_path / "source.tsv"
    destination = tmp_path / "output.jsonl"
    source.write_text(header + "\ntrack.flac\tTitle\tArtist\n", encoding="utf-8")
    with pytest.raises(ValueError, match="header columns must be nonempty and unique"):
        helper.convert(source, destination)
    assert not destination.exists()

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


@pytest.mark.parametrize("record", ["Music/first.flac\tTitle\tArtist\textra", "Music/first.flac\tTitle"])
def test_text_tools_rejects_wrong_column_count_with_row_number(tmp_path, record):
    source = tmp_path / "source.tsv"
    destination = tmp_path / "output.jsonl"
    raw = "path\ttitle\tartist\n" + record + "\n"
    source.write_text(raw, encoding="utf-8")
    with pytest.raises(ValueError, match=r"row 2.*3 columns"):
        helper.convert(source, destination)
    assert source.read_text(encoding="utf-8") == raw
    assert not destination.exists() or destination.read_text(encoding="utf-8") == ""


def test_text_tools_accepts_explicit_empty_column(tmp_path):
    source = tmp_path / "source.tsv"
    destination = tmp_path / "output.jsonl"
    source.write_text("path\ttitle\tartist\nMusic/first.flac\tTitle\t\n", encoding="utf-8")
    assert helper.convert(source, destination) == 1
    assert json.loads(destination.read_text(encoding="utf-8")) == {
        "path": "Music/first.flac", "title": "Title", "artist": ""}


@pytest.mark.parametrize("malformed", ["bad.flac\tMissing", "bad.flac\tExtra\tArtist\tUnexpected"])
def test_text_tools_failed_conversion_removes_partial_output_and_allows_retry(tmp_path, malformed):
    source, destination = tmp_path / "source.tsv", tmp_path / "output.jsonl"
    valid = "path\ttitle\tartist\nvalid.flac\tValid\tArtist\n"
    source.write_text(valid + malformed + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match=r"row 3.*3 columns"):
        helper.convert(source, destination)
    assert not destination.exists(), "failed conversion must not publish a valid-looking prefix"
    assert {item.name for item in tmp_path.iterdir()} == {"source.tsv"}
    source.write_text(valid, encoding="utf-8")
    assert helper.convert(source, destination) == 1
    assert json.loads(destination.read_text(encoding="utf-8"))["title"] == "Valid"


@pytest.mark.parametrize("concurrent", [False, True])
def test_text_tools_never_overwrites_an_existing_or_racing_destination(tmp_path, monkeypatch, concurrent):
    source, destination = tmp_path / "source.tsv", tmp_path / "output.jsonl"
    source.write_text("path\ttitle\nvalid.flac\tValid\n", encoding="utf-8")
    preserved = b"another export must survive\n"
    original_exists = Path.exists
    raced = []
    if concurrent:
        def exists(candidate):
            if candidate == destination and not raced:
                raced.append(True)
                destination.write_bytes(preserved)
                return False  # Another producer won immediately after our absence check.
            return original_exists(candidate)
        monkeypatch.setattr(Path, "exists", exists)
    else:
        destination.write_bytes(preserved)
    with pytest.raises(FileExistsError):
        helper.convert(source, destination)
    assert destination.read_bytes() == preserved
    assert {item.name for item in tmp_path.iterdir()} == {"source.tsv", "output.jsonl"}
    assert bool(raced) is concurrent
