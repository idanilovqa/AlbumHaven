"""The revocation command's input handling; its database writes are tested in test_android_artifacts.py."""

import io
import json

import pytest

from scripts import android_attestation_revocations as revocations

ENVIRON = {"ALBUM_HAVEN_MIGRATOR_DATABASE_URL": "postgresql://unused"}


def _no_database(_url):
    raise AssertionError("invalid input is refused before any database work")


@pytest.mark.parametrize(("value", "serial"), [("01F2E", "1f2e"), (" 0a ", "a"), ("000", "0"), ("ff", "ff")])
def test_serials_are_stored_the_way_the_server_formats_them(value, serial):
    assert revocations.normalize_serial(value) == serial


@pytest.mark.parametrize(
    "content",
    [None, "not json", "[]", '{"entries": 5}', '{"entries": "01F2E"}', '{"entries": null}', '{"entries": []}',
     '{"entries": {"not-hex": {}}}'],
    ids=["missing", "garbage", "not-an-object", "entries-not-an-object", "entries-a-string", "entries-null",
         "entries-empty-list", "serial-not-hex"],
)
def test_an_unreadable_status_list_changes_nothing(tmp_path, content):
    path = tmp_path / "status.json"
    if content is not None:
        path.write_text(content, encoding="utf-8")
    errors = io.StringIO()
    assert revocations.main(["import", "--file", str(path)], environ=ENVIRON, connect=_no_database,
                            stderr=errors) == 2
    assert errors.getvalue().startswith("Nothing changed:")


def test_a_status_list_keeps_each_reason_and_an_empty_list_is_valid(tmp_path):
    path = tmp_path / "status.json"
    path.write_text(json.dumps({"entries": {"0A": {"status": "REVOKED", "reason": "KEY_COMPROMISE"}, "B": "x"}}),
                    encoding="utf-8")
    assert revocations.read_status_list(str(path)) == {"a": "KEY_COMPROMISE", "b": ""}
    path.write_text('{"entries": {}}', encoding="utf-8")
    assert revocations.read_status_list(str(path)) == {}


@pytest.mark.parametrize("argv", [["add", "--serial", "xyz"], ["remove", "--serial", ""]])
def test_a_malformed_serial_is_refused(argv):
    assert revocations.main(argv, environ=ENVIRON, connect=_no_database, stderr=io.StringIO()) == 2


def test_the_command_needs_the_migrator_database():
    errors = io.StringIO()
    assert revocations.main(["add", "--serial", "a"], environ={}, connect=_no_database, stderr=errors) == 2
    assert "ALBUM_HAVEN_MIGRATOR_DATABASE_URL" in errors.getvalue()
