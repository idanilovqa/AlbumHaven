from types import SimpleNamespace
import json
import pytest
import config
from music_app.services import auth_bootstrap_postgres, auth_passwords
from tests.e2e.support import isolatedPostgres


@pytest.mark.parametrize("saved", [None, {"shellLayoutPreferences": {"artistTreeFolded": True}}, {"mobileGridColumns": 2}])
def test_expanded_artist_tree_seed_preserves_saved_account_preferences(monkeypatch, saved):
    calls = []
    rows = {} if saved is None else {42: saved.copy()}

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, sql, params):
            assert "on conflict (account_id, client_profile) do nothing" in sql
            assert "'web_desktop'" in sql
            calls.append((sql, params))
            rows.setdefault(params[0], json.loads(params[1]))

    monkeypatch.setattr(config, "build_auth_config", lambda: {"argon2": {}, "argon2_policy_version": 1})
    monkeypatch.setattr(auth_passwords, "hash_password", lambda *_args, **_kwargs: SimpleNamespace(encoded_hash="fixture", policy_version=1))
    monkeypatch.setattr(auth_bootstrap_postgres, "PostgresAuthBootstrapService", lambda _config: SimpleNamespace(
        reconcile_owner=lambda **_kwargs: SimpleNamespace(account_id=42)))
    monkeypatch.setattr(isolatedPostgres, "_connect", lambda _url: Connection())

    isolatedPostgres.provision_performance_auth_owner("owned-runtime")
    assert calls == []
    isolatedPostgres.provision_performance_auth_owner("owned-runtime", seed_expanded_artist_tree=True)
    assert rows[42] == (saved if saved is not None else {"shellLayoutPreferences": {
        "contextualPaneWidthPx": 320, "infoDrawerWidthPx": 360, "artistTreeFolded": False,
    }})
    # A normal subsequent boot must not overwrite the user's persisted collapse.
    rows[42] = {"shellLayoutPreferences": {"artistTreeFolded": True}, "mobileGridColumns": 3}
    isolatedPostgres.provision_performance_auth_owner("owned-runtime", seed_expanded_artist_tree=True)
    assert rows[42] == {"shellLayoutPreferences": {"artistTreeFolded": True}, "mobileGridColumns": 3}
    assert [params[0] for _, params in calls] == [42, 42]
