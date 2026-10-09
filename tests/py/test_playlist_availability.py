"""Independent conservative file-evidence contracts using synthetic paths only."""
from pathlib import Path
import stat
from types import SimpleNamespace

import pytest

from music_app.services import playlist_availability as availability
from tests.py.owned_playlist_testing import Connection, Step


@pytest.fixture
def evidence(tmp_path):
    root = tmp_path / "authorized-library"
    root.mkdir()
    return root, {
        "track_id": 11,
        "private_path": str(root / "missing.flac"),
        "root_path": str(root),
        "root_id": "synthetic-root",
        "root_active": True,
        "root_unhealthy": False,
        "scan_cache_stale": True,
        "stale_marked_at": "2026-10-08T20:00:00+00:00",
    }


def confirmed(root, records, **kwargs):
    return availability.files_confirmed_missing(
        records, config={}, authorized_root_paths=(root,), **kwargs
    )


def test_all_known_stale_files_need_live_missing_evidence(evidence):
    root, row = evidence
    second = {**row, "private_path": str(root / "second.flac")}
    assert confirmed(root, [row, second]) is True
    Path(second["private_path"]).write_bytes(b"synthetic")
    assert confirmed(root, [row, second]) is False


@pytest.mark.parametrize("patch", [
    {"scan_cache_stale": False}, {"scan_cache_stale": None}, {"scan_cache_stale": 1},
    {"root_active": False}, {"root_active": None}, {"root_active": 1},
    {"root_unhealthy": True}, {"root_unhealthy": None}, {"root_unhealthy": 0},
    {"root_id": None}, {"root_id": ""}, {"private_path": ""}, {"root_path": ""},
    {"stale_marked_at": None}, {"stale_marked_at": "not-a-date"},
    {"stale_marked_at": "2026-10-08T20:00:00"},
])
def test_incomplete_or_unhealthy_evidence_cannot_probe_files(evidence, patch):
    root, row = evidence
    probes = []
    assert confirmed(root, [{**row, **patch}], stat_path=probes.append) is False
    assert probes == []


def test_absent_records_and_no_authorized_roots_remain_unresolved(evidence):
    root, row = evidence
    assert confirmed(root, []) is False
    assert availability.files_confirmed_missing([row], config={}, authorized_root_paths=()) is False


@pytest.mark.parametrize("error", [FileNotFoundError, PermissionError, OSError])
def test_offline_or_denied_root_never_confirms_missing(evidence, error):
    root, row = evidence
    probes = []

    def probe(path):
        probes.append(path)
        raise error("synthetic root failure")

    assert confirmed(root, [row], stat_path=probe) is False
    assert probes == [root]


@pytest.mark.parametrize("error", [PermissionError, OSError, NotADirectoryError])
def test_failed_file_stat_is_not_missing(evidence, error):
    root, row = evidence

    def probe(path):
        if path == root:
            return SimpleNamespace(st_mode=stat.S_IFDIR)
        raise error("synthetic file failure")

    assert confirmed(root, [row], stat_path=probe) is False


def test_file_root_and_directory_replacing_track_remain_unresolved(evidence):
    root, row = evidence
    assert confirmed(root, [row], stat_path=lambda _: SimpleNamespace(st_mode=stat.S_IFREG)) is False
    Path(row["private_path"]).mkdir()
    assert confirmed(root, [row]) is False
    assert confirmed(root, [{**row, "private_path": str(root)}]) is False


def test_outside_path_and_symlink_escape_are_rejected_before_live_probe(evidence, tmp_path):
    root, row = evidence
    outside = tmp_path / "outside"
    outside.mkdir()
    link = root / "escape"
    link.symlink_to(outside, target_is_directory=True)
    for candidate in (outside / "absent.flac", link / "absent.flac", root / ".." / "absent.flac"):
        probes = []
        assert confirmed(root, [{**row, "private_path": str(candidate)}], stat_path=probes.append) is False
        assert probes == []


def test_file_must_belong_to_its_recorded_root_even_when_both_roots_authorized(evidence, tmp_path):
    root, row = evidence
    second = tmp_path / "another-authorized-root"
    second.mkdir()
    probes = []
    assert availability.files_confirmed_missing(
        [{**row, "private_path": str(second / "absent.flac")}], config={},
        authorized_root_paths=(root, second), stat_path=probes.append,
    ) is False
    assert probes == []


def test_sql_evidence_is_same_library_and_all_known_files_are_required(evidence):
    root, row = evidence
    records = [row, {**row, "track_id": 12}, {**row, "track_id": 12, "scan_cache_stale": False}]
    connection = Connection([Step("from library.local_tracks t", records,
        (73, [11, 12, 13]), clauses=(
            "left join library.library_roots r on r.id=f.library_root_id and r.library_id=t.library_id",
            "where t.library_id=%s and t.id=any(%s::bigint[])",
        ))])
    rows = {identity: {"availability": "unresolved", "title": str(identity)} for identity in (11, 12, 13)}
    rows[14] = {"availability": "local"}
    result = availability.confirm_missing_availability(connection, 73, rows, config={"synthetic": True})
    assert {key: value["availability"] for key, value in result.items()} == {
        11: "missing", 12: "unresolved", 13: "unresolved", 14: "local",
    }
    assert result[11] == {"availability": "missing", "title": "11"}
    connection.done()


def test_missing_evidence_lookup_is_skipped_without_config_or_candidates():
    connection = Connection()
    unresolved = {11: {"availability": "unresolved"}}
    assert availability.confirm_missing_availability(connection, 73, unresolved, config=None) == unresolved
    local = {11: {"availability": "local"}}
    assert availability.confirm_missing_availability(connection, 73, local, config={"synthetic": True}) == local
    connection.done()


def local_proof(connection,rows=None):
    return availability.confirmed_local_evidence(connection,73,rows or {11:{'availability':'local'}},config={})


def test_real_confined_file_proof_is_private_and_changes_on_replacement(evidence):
    root,row=evidence
    row={**row,'scan_cache_stale':False}
    path=Path(row['private_path']);path.write_bytes(b'first')
    first=local_proof(Connection([Step('from library.local_tracks t',[row])]))
    assert len(first[11])==64 and str(root) not in first[11]
    path.write_bytes(b'changed file')
    second=local_proof(Connection([Step('from library.local_tracks t',[row])]))
    assert first!=second
    path.unlink()
    assert local_proof(Connection([Step('from library.local_tracks t',[row])]))=={}


@pytest.mark.parametrize('patch',[{'root_id':None},{'root_unhealthy':True},{'root_active':False},
    {'scan_cache_stale':True},{'root_path':''},{'private_path':''}])
def test_positive_file_proof_does_not_probe_unknown_or_unhealthy_records(evidence,patch,monkeypatch):
    _,row=evidence
    probes=[]
    monkeypatch.setattr(availability,'resolve_configured_media_path',lambda *args,**kwargs:probes.append(args))
    assert local_proof(Connection([Step('from library.local_tracks t',[{**row,'scan_cache_stale':False,**patch}])]))=={}
    assert probes==[]


def test_no_positive_proof_from_metadata_or_directory(evidence):
    _,row=evidence
    row={**row,'scan_cache_stale':False}
    assert local_proof(Connection([Step('from library.local_tracks t',[row])]))=={}
    Path(row['private_path']).mkdir()
    assert local_proof(Connection([Step('from library.local_tracks t',[row])]))=={}
    assert local_proof(Connection(),{11:{'availability':'unresolved'}})=={}
