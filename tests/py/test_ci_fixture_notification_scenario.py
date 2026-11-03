import json

import pytest

from tests.py.test_ci_fixture_loader import _load_fixture_loader_module, _manifest


DATABASE_URL = "postgresql://album_haven_migrator_f_123@localhost/album_haven_ci_f_123"


def _scenario(tmp_path, *, refs=None, seed="scenarios/identity/cover_lookup_tasks.jsonl"):
    manifest = _manifest(assertions={"notificationIdentity": {"seed": seed, "taskCount": 1}})
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    path = tmp_path / seed
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"taskKey": "fixture-history", "album": "Historical", "trackRefs": refs or ["track-one"]}), encoding="utf-8")


@pytest.mark.parametrize("has_tracks", [True, False])
def test_scenario_resolves_portable_references_before_inserting_notifications(tmp_path, monkeypatch, has_tracks):
    loader = _load_fixture_loader_module()
    _scenario(tmp_path)
    operations = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, sql, params):
            operations.append((sql, params))
            self.rows = [(7,)] if "from library.libraries" in sql else (
                [("track-one", "/owned-fixture/one.mp3")] if "from library.local_tracks" in sql and has_tracks else []
            )
            return self

        def fetchall(self):
            return self.rows

    connection = Connection()
    identity_checks = []
    monkeypatch.setattr(loader, "validate_connected_identity", lambda conn, url: identity_checks.append((conn, url)))
    kwargs = dict(fixture_root=tmp_path, profile="functional-core", scenario="notificationIdentity",
                  database_url=DATABASE_URL, connect=lambda _url: connection)
    if has_tracks:
        loader.load_fixture_scenario(**kwargs)
        sql, params = operations[-1]
        assert "insert into ops.cover_lookup_tasks" in sql
        metadata = json.loads(params[-1])
        assert metadata["track_paths"] == ["/owned-fixture/one.mp3"]
        assert metadata["source_payload"]["track_paths"] == metadata["track_paths"]
        assert metadata["notification_action_taken"] is False
        assert metadata["source_payload"]["album_payload"]["key"] == "fixture-history-historical-album"
    else:
        with pytest.raises(ValueError, match="not fully loaded"):
            loader.load_fixture_scenario(**kwargs)
        assert not any("insert into" in sql for sql, _ in operations)
    assert identity_checks == [(connection, DATABASE_URL)]


@pytest.mark.parametrize("failure", ["production-database", "undeclared", "escaped-seed"])
def test_scenario_rejects_unsafe_or_undeclared_inputs_before_connecting(tmp_path, failure):
    loader = _load_fixture_loader_module()
    _scenario(tmp_path, seed="../outside/cover_lookup_tasks.jsonl" if failure == "escaped-seed" else "scenarios/identity/cover_lookup_tasks.jsonl")
    with pytest.raises(ValueError):
        loader.load_fixture_scenario(
            fixture_root=tmp_path, profile="functional-core",
            scenario="unknown" if failure == "undeclared" else "notificationIdentity",
            database_url="postgresql://postgres@localhost/album_haven_core" if failure == "production-database" else DATABASE_URL,
            connect=lambda _url: pytest.fail("unsafe fixture connection"),
        )
