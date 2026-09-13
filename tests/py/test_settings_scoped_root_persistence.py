"""Actual root persistence isolation and unchanged offline-root contracts."""
import copy
from pathlib import Path
import pytest
from music_app.services.library_roots import load_library_root_settings, save_library_root_settings
from tests.py.test_settings_measured_listen_ledger import ledger


def payload(path):
    return {"main_library_roots": [{"id": "main", "path": str(path), "layout_mode": "artist"}],
            "hoarding_library_roots": [], "new_arrivals_roots": [], "move_policy": {}}


def test_scoped_root_save_read_never_uses_bootstrap_or_foreign_library(ledger, tmp_path):
    own = ledger["own"]["library_id"]
    other = ledger["other"]["library_id"]
    root = tmp_path / "main"; root.mkdir()
    config = ledger["config"]
    saved = save_library_root_settings(config, payload(root), library_id=own, media_host_library_id=own)
    before = copy.deepcopy(config)
    assert load_library_root_settings(config, library_id=own, media_host_library_id=own) == saved
    assert config == before
    with pytest.raises(ValueError):
        save_library_root_settings(config, payload(root), library_id=other, media_host_library_id=own)
    with ledger["connect"]() as connection:
        assert connection.execute("select 1 from library.library_root_settings where library_id=%s", (other,)).fetchone() is None
    assert config == before


def test_unchanged_offline_root_is_preserved_but_new_unavailable_root_is_rejected(ledger, tmp_path):
    own = ledger["own"]["library_id"]
    root = tmp_path / "nas"; root.mkdir()
    scope = {"library_id": own, "media_host_library_id": own}
    saved = save_library_root_settings(ledger["config"], payload(root), **scope)
    root.rmdir()
    assert save_library_root_settings(ledger["config"], saved, **scope) == saved
    with pytest.raises(ValueError):
        save_library_root_settings(ledger["config"], payload(tmp_path / "missing-new"), **scope)
    assert load_library_root_settings(ledger["config"], **scope) == saved


def test_scoped_root_save_retains_root_provenance_records(ledger, tmp_path):
    own = ledger["own"]["library_id"]
    root = tmp_path / "provenance"; root.mkdir()
    save_library_root_settings(ledger["config"], payload(root), library_id=own, media_host_library_id=own)
    with ledger["connect"]() as connection:
        records = connection.execute("""select p.source_family,p.source_payload from library.library_root_provenance p
            join library.library_roots r on r.id=p.library_root_id where r.library_id=%s""", (own,)).fetchall()
    assert len(records) == 1
    assert records[0]["source_family"] == "library_root_settings_runtime"
    assert records[0]["source_payload"]["root_id"] == "main"
