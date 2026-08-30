from __future__ import annotations

import json

import pytest
from tests.py.asgi_testing import create_test_asgi_app, runtime_app_from_asgi_app
from tests.py.asgi_testing import query_args_from_url as _query_args_from_url

from music_app.services.discovery_center_read_seams import (
    build_discovery_center_page_payload,
    build_discovery_center_preferences_payload,
    build_discovery_lookup_payload,
    build_recent_discovery_lookup_payload,
    create_discovery_lookup_payload,
    save_discovery_center_preferences,
)
from music_app.services.view_payloads import build_news_payload


@pytest.fixture
def runtime_carrier(tmp_path, monkeypatch):
    return runtime_app_from_asgi_app(create_test_asgi_app(tmp_path, monkeypatch))


@pytest.fixture
def config(runtime_carrier):
    return runtime_carrier.config


@pytest.fixture
def logger(runtime_carrier):
    return runtime_carrier.logger


@pytest.fixture
def library_state(runtime_carrier):
    return runtime_carrier.library_state


class _FakeCursor:
    def __init__(self, rows=None):
        self._rows = list(rows or [])

    def fetchone(self):
        if not self._rows:
            return None
        return self._rows[0]

    def fetchall(self):
        return list(self._rows)


class _FakeDiscoveryPreferencesConnection:
    def __init__(self, *, rows=None, bootstrap_ready=True, upsert_returns=True):
        self.rows = list(rows or [])
        self.bootstrap_ready = bootstrap_ready
        self.upsert_returns = upsert_returns
        self.operations: list[dict[str, object]] = []
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.closed = True
        return False

    def execute(self, sql, params=None):
        self.operations.append({"sql": str(sql), "params": params})
        sql_text = str(sql).lower()
        if "bootstrap_context_ready" in sql_text:
            return _FakeCursor([{"bootstrap_context_ready": 1}] if self.bootstrap_ready else [])
        if "insert into app.user_discovery_preferences" in sql_text:
            return _FakeCursor([{"saved": 1}] if self.upsert_returns else [])
        if "from app.user_discovery_preferences" in sql_text:
            return _FakeCursor(self.rows)
        return _FakeCursor()


class _FakeDiscoveryLookupSnapshotStore:
    def __init__(self, rows=None):
        self.rows = [dict(row) for row in rows or []]
        self.load_calls = 0
        self.saved_rows: list[list[dict[str, object]]] = []

    def load_snapshot_rows(self):
        self.load_calls += 1
        return [dict(row) for row in self.rows]

    def save_snapshot_rows(self, rows):
        self.rows = [dict(row) for row in rows]
        self.saved_rows.append([dict(row) for row in rows])


def _jsonb_payload(value):
    return getattr(value, "obj", value)


def test_build_discovery_center_page_payload_normalizes_route_state():
    payload = build_discovery_center_page_payload(
        tab="bogus",
        source="made_up",
    )

    assert payload["page_kind"] == "discovery_center"
    assert payload["active_tab"] == "inbox"
    assert payload["active_source"] == "all"
    assert payload["supported_tabs"] == ["inbox", "history", "insights"]
    assert payload["supported_sources"] == ["all", "release", "suggestion", "research"]
    assert payload["entries_route"] == "/news-center/entries?tab=inbox&source=all"
    assert payload["summary_route"] == "/news-center/summary"
    assert payload["preferences_route"] == "/news-center/preferences"
    assert payload["lookup_create_route"] == "/discovery-lookups"
    assert payload["lookup_contract"] == {
        "route_family": "/discovery-lookups",
        "request_contract": {
            "supported_result_kinds": ["artists", "albums", "tracks"],
            "default_result_kind": "tracks",
            "supported_lookup_intents": [
                "auto",
                "generic_genre",
                "soundtrack_collection",
                "soundtrack_score",
                "anime_soundtrack",
            ],
            "default_lookup_intent": "auto",
            "supported_track_result_modes": ["raw_ranked", "artist_capped"],
            "default_track_result_mode": "raw_ranked",
            "supports_year_range": True,
            "supports_decade_filter": True,
            "supports_local_library_exclusion": True,
        },
        "result_contract": {
            "default_track_result_mode": "raw_ranked",
            "supported_track_result_modes": ["raw_ranked", "artist_capped"],
            "identity_fields": [
                "raw_name",
                "display_name",
                "normalized_name",
                "normalized_match_key",
            ],
            "transliteration_fields": ["transliteration_variants", "romanized_name"],
            "normalization_flag_field": "normalization_flags",
            "match_confidence_field": "match_confidence",
            "album_context_fields": [
                "album_title",
                "album_ref",
                "album_match_state",
                "album_resolution_reason",
            ],
            "local_library_state_fields": [
                "local_match_state",
                "excluded_by_local_library",
            ],
            "viewer_scope": "visitor_safe",
            "track_row_mode": "raw_ranked_discovery_rows",
            "playlist_equivalence": "not_playlist_items",
        },
        "normalization_contract": {
            "owner": "shared_title_normalization",
            "applies_to": [
                "remote_discovery",
                "artist_popularity",
                "lastfm_sync",
                "local_library_matching",
            ],
            "identity_fields": [
                "raw_name",
                "display_name",
                "normalized_name",
                "normalized_match_key",
            ],
            "preserved_variant_kinds": [
                "live",
                "demo",
                "acoustic",
                "instrumental",
                "karaoke",
            ],
            "packaging_noise_examples": [
                "remaster",
                "remastered",
                "deluxe edition",
                "bonus track",
                "mono",
                "stereo",
            ],
            "transliteration_overlay": {
                "artist_display": "always_when_trusted_and_cjk_only",
                "album_display": "global_setting_when_cjk_only",
                "track_display": "global_or_per_album_setting_when_cjk_only",
                "matching_query_modes": [
                    "raw_script",
                    "romanized",
                    "dual_query_when_confidence_is_weak",
                ],
            },
        },
    }


def test_create_discovery_lookup_payload_carries_cross_phase_lookup_and_normalization_contracts(
    config,
):
    config["DISCOVERY_LOOKUP_SNAPSHOT_STORE"] = _FakeDiscoveryLookupSnapshotStore()

    payload = create_discovery_lookup_payload(
        config,
        {
            "result_kind": "tracks",
            "genre_query": " anime ost ",
            "lookup_intent": "anime_soundtrack",
            "track_result_mode": "artist_capped",
            "max_tracks_per_artist": 2,
            "exclude_local_library": True,
            "year_from": "1999",
            "year_to": "2008",
            "decade": "2000s",
        },
    )

    assert payload["request"] == {
        "result_kind": "tracks",
        "genre_query": "anime ost",
        "lookup_intent": "anime_soundtrack",
        "track_result_mode": "artist_capped",
        "max_tracks_per_artist": 2,
        "exclude_local_library": True,
        "year_from": 1999,
        "year_to": 2008,
        "decade": "2000s",
    }
    assert payload["request_contract"]["default_lookup_intent"] == "auto"
    assert payload["request_contract"]["supported_lookup_intents"] == [
        "auto",
        "generic_genre",
        "soundtrack_collection",
        "soundtrack_score",
        "anime_soundtrack",
    ]
    assert payload["result_contract"]["viewer_scope"] == "visitor_safe"
    assert payload["result_contract"]["track_row_mode"] == "raw_ranked_discovery_rows"
    assert payload["normalization_contract"]["owner"] == "shared_title_normalization"
    assert payload["normalization_contract"]["transliteration_overlay"] == {
        "artist_display": "always_when_trusted_and_cjk_only",
        "album_display": "global_setting_when_cjk_only",
        "track_display": "global_or_per_album_setting_when_cjk_only",
        "matching_query_modes": [
            "raw_script",
            "romanized",
            "dual_query_when_confidence_is_weak",
        ],
    }


def test_discovery_center_preferences_selected_postgres_does_not_read_or_write_json(
    tmp_path,
    monkeypatch,
):
    config = {
        "DATA_DIR": tmp_path,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"discovery_center_preferences": "postgres"},
    }
    path = tmp_path / "discovery_center_preferences.json"
    path.write_text("{not-json", encoding="utf-8")

    monkeypatch.setattr(
        "music_app.services.discovery_center_preferences_postgres.psycopg",
        None,
    )

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        build_discovery_center_preferences_payload(config)
    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        save_discovery_center_preferences(
            config,
            {"delivery": {"toast_notifications_enabled": False}},
        )

    assert path.read_text(encoding="utf-8") == "{not-json"


def test_discovery_center_preferences_postgres_load_defaults_when_no_row_exists():
    from music_app.services.discovery_center_preferences_postgres import (
        DiscoveryCenterPreferencesPostgresAdapter,
    )

    connection = _FakeDiscoveryPreferencesConnection(rows=[])
    adapter = DiscoveryCenterPreferencesPostgresAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    payload = adapter.load_preferences()

    assert payload["source_toggles"] == {
        "release": True,
        "suggestion": True,
        "research": True,
    }
    assert payload["delivery"]["toast_notifications_enabled"] is True
    assert any("app.bootstrap_owners" in operation["sql"] for operation in connection.operations)
    assert connection.closed


def test_discovery_center_preferences_postgres_save_upserts_scoped_bootstrap_row():
    from music_app.services.discovery_center_preferences_postgres import (
        DiscoveryCenterPreferencesPostgresAdapter,
    )

    connection = _FakeDiscoveryPreferencesConnection()
    adapter = DiscoveryCenterPreferencesPostgresAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    saved = adapter.save_preferences(
        {
            "source_toggles": {"release": "false", "suggestion": True},
            "delivery": {"toast_notifications_enabled": "0"},
        }
    )

    insert_operation = next(
        operation
        for operation in connection.operations
        if "insert into app.user_discovery_preferences" in operation["sql"].lower()
    )
    assert saved["source_toggles"] == {
        "release": False,
        "suggestion": True,
        "research": True,
    }
    assert saved["delivery"]["toast_notifications_enabled"] is False
    assert "on conflict (account_id, preference_scope)" in insert_operation["sql"].lower()
    assert "app.bootstrap_owners" in insert_operation["sql"]
    assert insert_operation["params"][0] == "local_first_single_viewer"
    assert _jsonb_payload(insert_operation["params"][1])["source_toggles"]["release"] is False
    assert connection.closed


def test_discovery_center_preferences_postgres_raises_when_bootstrap_context_missing():
    from music_app.services.discovery_center_preferences_postgres import (
        DiscoveryCenterPreferencesPostgresAdapter,
    )

    connection = _FakeDiscoveryPreferencesConnection(bootstrap_ready=False)
    adapter = DiscoveryCenterPreferencesPostgresAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    with pytest.raises(RuntimeError, match="bootstrap local owner"):
        adapter.save_preferences({"source_toggles": {"release": False}})

    assert not any(
        "insert into app.user_discovery_preferences" in operation["sql"].lower()
        for operation in connection.operations
    )
    assert connection.closed


def test_selected_postgres_discovery_center_preferences_leave_stale_json_untouched(
    tmp_path,
    monkeypatch,
):
    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    monkeypatch.setattr(
        "music_app.services.discovery_center_preferences_postgres.psycopg",
        FakePsycopg(),
    )

    class FakePostgresPreferencesAdapter:
        saved_payload = None

        def __init__(self, config):
            self.config = config

        def load_preferences(self):
            return {
                "source_toggles": {
                    "release": False,
                    "suggestion": True,
                    "research": False,
                },
                "delivery": {
                    "toast_notifications_enabled": False,
                    "quiet_hours": {
                        "enabled": True,
                        "start": "23:00",
                        "end": "07:00",
                    },
                },
            }

        def save_preferences(self, payload):
            FakePostgresPreferencesAdapter.saved_payload = payload
            return {
                "source_toggles": {
                    "release": True,
                    "suggestion": False,
                    "research": True,
                },
                "delivery": {
                    "toast_notifications_enabled": False,
                    "quiet_hours": {
                        "enabled": False,
                        "start": "22:00",
                        "end": "08:00",
                    },
                },
            }

    monkeypatch.setattr(
        "music_app.services.discovery_center_read_seams.DiscoveryCenterPreferencesPostgresAdapter",
        FakePostgresPreferencesAdapter,
    )
    stale_path = tmp_path / "discovery_center_preferences.json"
    stale_path.write_text(
        json.dumps({"source_toggles": {"release": True}}),
        encoding="utf-8",
    )
    config = {
        "DATA_DIR": tmp_path,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"discovery_center_preferences": "postgres"},
    }

    loaded = build_discovery_center_preferences_payload(config)
    saved = save_discovery_center_preferences(
        config,
        {"source_toggles": {"suggestion": False}},
    )

    assert loaded["preference_scope"] == "local_first_single_viewer"
    assert loaded["supports_multi_user_persistence"] is False
    assert loaded["source_toggles"] == {
        "release": False,
        "suggestion": True,
        "research": False,
    }
    assert saved["source_toggles"] == {
        "release": True,
        "suggestion": False,
        "research": True,
    }
    assert FakePostgresPreferencesAdapter.saved_payload == {
        "source_toggles": {"suggestion": False}
    }
    assert json.loads(stale_path.read_text(encoding="utf-8")) == {
        "source_toggles": {"release": True}
    }


def test_discovery_center_preferences_and_lookup_snapshots_fail_loudly_when_postgres_unavailable(
    config,
    monkeypatch,
):
    config["PERSISTENCE_BACKENDS"] = {
        "discovery_center_preferences": "postgres",
        "discovery_lookup_snapshots": "postgres",
    }
    monkeypatch.setattr(
        "music_app.services.discovery_center_preferences_postgres.psycopg",
        None,
    )
    monkeypatch.setattr(
        "music_app.services.discovery_lookup_snapshots_postgres.psycopg",
        None,
    )

    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        save_discovery_center_preferences(
            config,
            {"source_toggles": {"release": False}},
        )
    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        create_discovery_lookup_payload(config, {"genre_query": "city pop"})

    assert not (config["DATA_DIR"] / "discovery_center_preferences.json").exists()
    assert not (config["DATA_DIR"] / "discovery_lookup_snapshots.json").exists()


def test_discovery_lookup_snapshots_use_store_and_cap_recent_rows(config):
    config["DISCOVERY_LOOKUP_SNAPSHOT_STORE"] = _FakeDiscoveryLookupSnapshotStore()
    lookup_path = config["DATA_DIR"] / "discovery_lookup_snapshots.json"
    lookup_path.write_text("{not-json", encoding="utf-8")

    assert build_discovery_lookup_payload(config, "missing") is None
    assert build_recent_discovery_lookup_payload(config) == {"lookups": []}

    refs = [
        create_discovery_lookup_payload(config, {"genre_query": f"genre-{index}"})[
            "lookup_ref"
        ]
        for index in range(27)
    ]

    recent_refs = [
        row["lookup_ref"]
        for row in build_recent_discovery_lookup_payload(config)["lookups"]
    ]
    assert len(recent_refs) == 25
    assert recent_refs[0] == refs[-1]
    assert recent_refs[-1] == refs[2]
    assert lookup_path.read_text(encoding="utf-8") == "{not-json"


def test_discovery_lookup_snapshot_store_preserves_detail_and_recent_payloads(config):
    config["DISCOVERY_LOOKUP_SNAPSHOT_STORE"] = _FakeDiscoveryLookupSnapshotStore(
        rows=[
            {
                "lookup_ref": "lookup-existing",
                "created_at": "2026-07-02T12:00:00+00:00",
                "status": "pending_source_integration",
                "request": {
                    "result_kind": "albums",
                    "genre_query": "city pop",
                },
                "results": [
                    {
                        "display_name": "Example Album",
                    }
                ],
            }
        ]
    )

    detail = build_discovery_lookup_payload(config, "lookup-existing")
    recent = build_recent_discovery_lookup_payload(config)

    assert detail is not None
    assert detail["lookup_ref"] == "lookup-existing"
    assert detail["results"] == [{"display_name": "Example Album"}]
    assert detail["route_family"]["detail"] == "/discovery-lookups/lookup-existing"
    assert recent == {
        "lookups": [
            {
                "lookup_ref": "lookup-existing",
                "detail_route": "/discovery-lookups/lookup-existing",
                "result_kind": "albums",
                "genre_query": "city pop",
                "status": "pending_source_integration",
                "created_at": "2026-07-02T12:00:00+00:00",
            }
        ]
    }


def test_build_news_payload_promotes_discovery_center_to_main_content(config, logger, library_state, monkeypatch):
    monkeypatch.setattr(
        "music_app.services.view_payloads.load_manual_version_links",
        lambda config: {},
    )
    monkeypatch.setattr(
        "music_app.services.view_payloads.load_ignored_version_keys",
        lambda config: set(),
    )
    monkeypatch.setattr(
        "music_app.services.view_payloads.get_primary_music_root",
        lambda config: config["MUSIC_DIR"],
    )
    monkeypatch.setattr(
        "music_app.services.view_payloads.build_recent_listen_payloads",
        lambda config, albums: {},
    )

    payload = build_news_payload(
        tab="history",
        source="suggestion",
        query_args=_query_args_from_url("/news?tab=history&source=suggestion"),
        config=config,
        logger=logger,
        library_state=library_state,
    )

    assert payload["surface"]["active"] == "home"
    assert payload["shell_layout"]["slots"]["main_content"] == {
        "surface_ref": "news",
        "content_kind": "discovery_center_page",
    }
    assert payload["discovery_center"]["active_tab"] == "history"
    assert payload["discovery_center"]["active_source"] == "suggestion"
    assert payload["discovery_center"]["page_route"] == "/news"
