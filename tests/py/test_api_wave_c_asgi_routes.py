from __future__ import annotations

from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from typing import Any

import pytest
from fastapi import FastAPI

from tests.py.asgi_testing import create_test_asgi_app
from tests.py.asgi_testing import decode_json as _decode_json
from tests.py.asgi_testing import collect_route_paths as _collect_route_paths
from tests.py.asgi_testing import run_asgi_request as _run_asgi_request
from tests.py.asgi_testing import runtime_app_from_asgi_app


@pytest.fixture
def app(tmp_path, monkeypatch):
    return runtime_app_from_asgi_app(create_test_asgi_app(tmp_path, monkeypatch))


class _FakeVirtualReleaseCursor:
    def __init__(self, rows: list[dict[str, object]] | None = None) -> None:
        self._rows = rows or []

    def fetchall(self) -> list[dict[str, object]]:
        return list(self._rows)

    def fetchone(self) -> dict[str, object] | None:
        return self._rows[0] if self._rows else None


class _FakeVirtualReleasePostgresConnection:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, object]] = {}

    def __enter__(self) -> "_FakeVirtualReleasePostgresConnection":
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        return None

    def execute(
        self,
        sql: str,
        params: tuple[object, ...] = (),
    ) -> _FakeVirtualReleaseCursor:
        normalized_sql = " ".join(sql.lower().split())
        if "bootstrap_context_ready" in normalized_sql:
            return _FakeVirtualReleaseCursor([{"bootstrap_context_ready": 1}])
        if "select ops.virtual_release_snapshots" in normalized_sql:
            return _FakeVirtualReleaseCursor(
                [
                    dict(row)
                    for row in self.rows.values()
                    if not isinstance(row.get("metadata"), dict)
                    or not row["metadata"].get("purged_at")
                ]
            )
        if "insert into ops.virtual_release_snapshots" in normalized_sql:
            (
                virtual_release_ref,
                title,
                artist_credit,
                release_kind,
                release_date,
                release_date_precision,
                source_attributions,
                source_provenance,
                created_at,
                expires_at,
                last_enriched_at,
                metadata,
            ) = params
            self.rows[str(virtual_release_ref)] = {
                "virtual_release_ref": virtual_release_ref,
                "title": title,
                "artist_credit": artist_credit,
                "release_kind": release_kind,
                "release_date": release_date,
                "release_date_precision": release_date_precision,
                "source_attributions": source_attributions,
                "source_provenance": source_provenance,
                "created_at": created_at,
                "expires_at": expires_at,
                "last_enriched_at": last_enriched_at,
                "metadata": metadata,
            }
            return _FakeVirtualReleaseCursor([{"saved": 1}])
        if "jsonb_set" in normalized_sql:
            purged_at, virtual_release_ref = params
            row = self.rows[str(virtual_release_ref)]
            metadata = row.get("metadata")
            row["metadata"] = dict(metadata) if isinstance(metadata, dict) else {}
            row["metadata"]["purged_at"] = purged_at
            return _FakeVirtualReleaseCursor([{"purged": 1}])
        raise AssertionError(f"Unexpected SQL: {sql}")


def _select_fake_virtual_release_postgres(app: Any, monkeypatch: Any) -> None:
    from music_app.services import virtual_release_snapshots as snapshot_module

    connection = _FakeVirtualReleasePostgresConnection()
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    monkeypatch.setattr(snapshot_module, "psycopg", object())
    monkeypatch.setattr(snapshot_module, "Jsonb", None)
    monkeypatch.setattr(snapshot_module, "_connect", lambda database_url: connection)


class InMemoryVirtualArtistSnapshotStore:
    def __init__(self) -> None:
        self.snapshot_rows = []
        self.recent_lookup_rows = []

    def load_snapshot_rows(self):
        return [dict(row) for row in self.snapshot_rows]

    def save_snapshot_rows(self, rows):
        self.snapshot_rows = [dict(row) for row in rows]

    def load_recent_lookup_rows(self):
        return [dict(row) for row in self.recent_lookup_rows]

    def save_recent_lookup_rows(self, rows):
        self.recent_lookup_rows = [dict(row) for row in rows]


class InMemoryDiscoveryLookupSnapshotStore:
    def __init__(self) -> None:
        self.snapshot_rows = []

    def load_snapshot_rows(self):
        return [dict(row) for row in self.snapshot_rows]

    def save_snapshot_rows(self, rows):
        self.snapshot_rows = [dict(row) for row in rows]


class InMemoryDiscoveryCenterPreferencesAdapter:
    payload = None

    def __init__(self, config):
        self.config = config

    def load_preferences(self):
        return dict(self.payload or {})

    def save_preferences(self, payload):
        self.__class__.payload = dict(payload or {})
        return dict(self.payload or {})


@pytest.fixture(autouse=True)
def virtual_artist_snapshot_store(app, monkeypatch):
    from music_app.services import discovery_center_read_seams

    class FakePsycopg:
        def connect(self):
            raise AssertionError("availability should not open a database connection")

    app.config["VIRTUAL_ARTIST_SNAPSHOT_STORE"] = InMemoryVirtualArtistSnapshotStore()
    app.config["DISCOVERY_LOOKUP_SNAPSHOT_STORE"] = InMemoryDiscoveryLookupSnapshotStore()
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    InMemoryDiscoveryCenterPreferencesAdapter.payload = None
    monkeypatch.setattr(
        "music_app.services.discovery_center_preferences_postgres.psycopg",
        FakePsycopg(),
    )
    monkeypatch.setattr(
        discovery_center_read_seams,
        "DiscoveryCenterPreferencesPostgresAdapter",
        InMemoryDiscoveryCenterPreferencesAdapter,
    )


def _make_wave_c_app(flask_app):
    from music_app.routes.api_wave_c_asgi_routes import router

    asgi_app = FastAPI()
    asgi_app.state.config = flask_app.config
    asgi_app.include_router(router)
    return asgi_app


def test_asgi_wave_c_routes_register_natively(asgi_app):
    from music_app.routes import api_wave_c_asgi_routes as asgi_routes

    assert not hasattr(asgi_routes, "_flask_app")
    route_paths = _collect_route_paths(asgi_app)
    for route_path in (
        "/news-center/summary",
        "/news-center/entries",
        "/news-center/insights",
        "/news-center/preferences",
        "/discovery-lookups",
        "/discovery-lookups/recent",
        "/discovery-lookups/{lookup_ref}",
        "/virtual-artists/search",
        "/virtual-artists",
        "/virtual-artists/recent",
        "/virtual-artists/{virtual_artist_ref}",
        "/virtual-releases/{virtual_release_ref}",
    ):
        assert route_path in route_paths


def _cookie_header(headers: dict[str, str]) -> str:
    cookie = SimpleCookie()
    cookie.load(headers["set-cookie"])
    return "; ".join(f"{key}={morsel.value}" for key, morsel in cookie.items())


def test_asgi_discovery_routes_preserve_preferences_lookup_and_recent_contracts(app):
    asgi_app = _make_wave_c_app(app)

    preferences_status, _preferences_headers, preferences_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/news-center/preferences",
        json_body={
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
        },
    )
    followup_status, _followup_headers, followup_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/news-center/preferences",
    )
    lookup_status, _lookup_headers, lookup_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/discovery-lookups",
        json_body={
            "result_kind": "tracks",
            "genre_query": "shoegaze",
            "track_result_mode": "artist_capped",
            "max_tracks_per_artist": 2,
            "exclude_local_library": True,
        },
    )
    lookup_payload = _decode_json(lookup_body)
    lookup_ref = lookup_payload["lookup_ref"]
    detail_status, _detail_headers, detail_body = _run_asgi_request(
        asgi_app,
        "GET",
        f"/discovery-lookups/{lookup_ref}",
    )
    missing_status, _missing_headers, missing_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/discovery-lookups/not-real",
    )
    recent_status, _recent_headers, recent_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/discovery-lookups/recent",
    )

    preferences_payload = _decode_json(preferences_body)
    assert preferences_status == 200
    assert preferences_payload["preference_scope"] == "local_first_single_viewer"
    assert preferences_payload["source_toggles"] == {
        "release": False,
        "suggestion": True,
        "research": False,
    }
    assert followup_status == 200
    assert _decode_json(followup_body) == preferences_payload
    assert lookup_status == 201
    assert lookup_payload["status"] == "pending_source_integration"
    assert lookup_payload["request"]["genre_query"] == "shoegaze"
    assert lookup_payload["route_family"] == {
        "create": "/discovery-lookups",
        "detail": f"/discovery-lookups/{lookup_ref}",
        "recent": "/discovery-lookups/recent",
    }
    assert detail_status == 200
    assert _decode_json(detail_body) == lookup_payload
    assert missing_status == 404
    assert _decode_json(missing_body) == {
        "ok": False,
        "error": "Discovery lookup not found",
    }
    assert recent_status == 200
    assert _decode_json(recent_body)["lookups"] == [
        {
            "lookup_ref": lookup_ref,
            "detail_route": f"/discovery-lookups/{lookup_ref}",
            "result_kind": "tracks",
            "genre_query": "shoegaze",
            "status": "pending_source_integration",
            "created_at": lookup_payload["created_at"],
        }
    ]


def test_asgi_discovery_routes_preserve_summary_entries_and_insights_contracts(app):
    asgi_app = _make_wave_c_app(app)

    summary_status, _summary_headers, summary_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/news-center/summary",
    )
    entries_status, _entries_headers, entries_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/news-center/entries",
        query={"tab": "unknown", "source": "bogus"},
    )
    insights_status, _insights_headers, insights_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/news-center/insights",
        query={"window": "bogus"},
    )

    summary_payload = _decode_json(summary_body)
    assert summary_status == 200
    assert summary_payload["page_route"] == "/news"
    assert summary_payload["badge"] == {
        "kind": "discovery_center",
        "unseen_count": 0,
        "has_unseen": False,
        "unseen_entry_refs": [],
    }
    assert summary_payload["drawer_preview"]["content_kind"] == (
        "discovery_center_preview"
    )
    assert summary_payload["drawer_preview"]["footer_cta"] == {
        "href": "/news?tab=inbox",
        "label": "Open Discovery Center",
    }
    assert summary_payload["entry_contract"]["view_states"] == [
        "unseen",
        "seen",
        "cleared",
    ]
    assert summary_payload["entry_contract"]["entry_kinds"] == [
        "release",
        "suggestion",
        "research",
    ]

    entries_payload = _decode_json(entries_body)
    assert entries_status == 200
    assert entries_payload["page_kind"] == "discovery_center_entries"
    assert entries_payload["active_tab"] == "inbox"
    assert entries_payload["active_source"] == "all"
    assert entries_payload["supported_tabs"] == ["inbox", "history", "insights"]
    assert entries_payload["supported_sources"] == [
        "all",
        "release",
        "suggestion",
        "research",
    ]
    assert entries_payload["entries"] == []

    insights_payload = _decode_json(insights_body)
    assert insights_status == 200
    assert insights_payload["page_kind"] == "discovery_center_insights"
    assert insights_payload["active_window"] == "month"
    assert insights_payload["supported_windows"] == [
        "week",
        "month",
        "6_months",
        "year",
        "lifetime",
    ]
    assert insights_payload["cards"] == []


def test_asgi_discovery_lookup_snapshots_are_compact_and_capped(app):
    asgi_app = _make_wave_c_app(app)

    created_lookup_refs = []
    for index in range(27):
        create_status, _create_headers, create_body = _run_asgi_request(
            asgi_app,
            "POST",
            "/discovery-lookups",
            json_body={
                "result_kind": "tracks",
                "genre_query": f"genre-{index}",
            },
        )
        assert create_status == 201
        created_lookup_refs.append(_decode_json(create_body)["lookup_ref"])

    lookup_store = app.config["DISCOVERY_LOOKUP_SNAPSHOT_STORE"]
    assert len(lookup_store.snapshot_rows) == 25
    assert set(lookup_store.snapshot_rows[0]) == {
        "lookup_ref",
        "created_at",
        "status",
        "request",
        "results",
    }
    assert lookup_store.snapshot_rows[0]["lookup_ref"] == created_lookup_refs[-1]
    assert lookup_store.snapshot_rows[-1]["lookup_ref"] == created_lookup_refs[2]

    recent_status, _recent_headers, recent_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/discovery-lookups/recent",
    )
    recent_payload = _decode_json(recent_body)
    assert recent_status == 200
    assert len(recent_payload["lookups"]) == 25
    assert recent_payload["lookups"][0]["lookup_ref"] == created_lookup_refs[-1]
    assert recent_payload["lookups"][-1]["lookup_ref"] == created_lookup_refs[2]

    dropped_status, _dropped_headers, dropped_body = _run_asgi_request(
        asgi_app,
        "GET",
        f"/discovery-lookups/{created_lookup_refs[0]}",
    )
    oldest_retained_status, _oldest_retained_headers, oldest_retained_body = _run_asgi_request(
        asgi_app,
        "GET",
        f"/discovery-lookups/{created_lookup_refs[2]}",
    )
    retained_status, _retained_headers, retained_body = _run_asgi_request(
        asgi_app,
        "GET",
        f"/discovery-lookups/{created_lookup_refs[-1]}",
    )
    assert dropped_status == 404
    assert _decode_json(dropped_body) == {
        "ok": False,
        "error": "Discovery lookup not found",
    }
    assert oldest_retained_status == 200
    assert _decode_json(oldest_retained_body)["route_family"]["detail"] == (
        f"/discovery-lookups/{created_lookup_refs[2]}"
    )
    assert retained_status == 200
    assert _decode_json(retained_body)["route_family"]["detail"] == (
        f"/discovery-lookups/{created_lookup_refs[-1]}"
    )


def test_asgi_virtual_artist_routes_preserve_search_create_cookie_read_and_recent(
    app,
    monkeypatch,
):
    from music_app.services import virtual_artist_snapshots as snapshot_module
    from music_app.routes import api_wave_c_asgi_routes as asgi_routes

    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    monkeypatch.setattr(
        asgi_routes,
        "search_virtual_artist_candidates",
        lambda query: {
            "ok": True,
            "query": str(query or ""),
            "provider_state": {
                "provider": "musicbrainz",
                "query_performed": True,
                "status": "network",
                "cache_hit": False,
            },
            "candidate_contract": {
                "identity_field": "candidate_ref",
                "submit_route": "/virtual-artists",
                "display_name_field": "display_name",
                "disambiguation_text_field": "disambiguation_text",
                "provider_artist_id_field": "provider_artist_id",
            },
            "candidates": [
                {
                    "candidate_ref": "musicbrainz:artist:artist-1",
                    "provider": "musicbrainz",
                    "provider_artist_id": "artist-1",
                    "display_name": "Mono",
                    "sort_name": "Mono",
                    "disambiguation_text": "Group | Japan",
                    "match_score": 100,
                },
            ],
        },
    )
    asgi_app = _make_wave_c_app(app)

    search_status, _search_headers, search_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/virtual-artists/search",
        query={"q": "mono"},
    )
    create_status, create_headers, create_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/virtual-artists",
        json_body={
            "candidate_ref": "musicbrainz:artist:artist-1",
            "display_name": "Mono",
            "disambiguation_text": "Group | Japan",
            "release_scope": "live",
        },
    )
    cookie_header = _cookie_header(create_headers)
    created = _decode_json(create_body)
    read_status, _read_headers, read_body = _run_asgi_request(
        asgi_app,
        "GET",
        f"/virtual-artists/{created['virtual_artist_ref']}",
        query={
            "release_scope": "others",
            "page_mode": "gallery",
            "family_display": "chronological",
            "gallery_display": "covers",
            "gallery_scale_percent": "120",
            "timeline_at": "2001-01-01",
        },
        headers={"cookie": cookie_header},
    )
    recent_status, _recent_headers, recent_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/virtual-artists/recent",
        headers={"cookie": cookie_header},
    )

    search_payload = _decode_json(search_body)
    read_payload = _decode_json(read_body)
    recent_payload = _decode_json(recent_body)
    assert search_status == 200
    assert search_payload == {
        "ok": True,
        "transport": "remote_discovery",
        "route_family": "/virtual-artists",
        "response_kind": "virtual_artist_candidates",
        "query": "mono",
        "provider_state": {
            "provider": "musicbrainz",
            "query_performed": True,
            "status": "network",
            "cache_hit": False,
        },
        "candidate_contract": {
            "identity_field": "candidate_ref",
            "submit_route": "/virtual-artists",
            "display_name_field": "display_name",
            "disambiguation_text_field": "disambiguation_text",
            "provider_artist_id_field": "provider_artist_id",
        },
        "candidates": [
            {
                "candidate_ref": "musicbrainz:artist:artist-1",
                "provider": "musicbrainz",
                "provider_artist_id": "artist-1",
                "display_name": "Mono",
                "sort_name": "Mono",
                "disambiguation_text": "Group | Japan",
                "match_score": 100,
            },
        ],
    }
    assert create_status == 201
    assert "album_haven_virtual_artist_recent_actor=" in create_headers["set-cookie"]
    assert "httponly" in create_headers["set-cookie"].lower()
    assert "samesite=lax" in create_headers["set-cookie"].lower()
    assert created["active_release_scope"] == "live"
    assert created["read_route"] == (
        f"/virtual-artists/{created['virtual_artist_ref']}?release_scope=live"
    )
    assert read_status == 200
    assert read_payload["virtual_artist_ref"] == created["virtual_artist_ref"]
    assert read_payload["active_release_scope"] == "others"
    assert read_payload["active_release_scope_label"] == "Other Types"
    assert read_payload["artist_page"]["active_page_mode"] == "gallery"
    assert read_payload["artist_page"]["family_display_mode"] == "chronological"
    assert read_payload["artist_page"]["gallery_display_mode"] == "covers"
    assert read_payload["artist_page"]["gallery_scale_percent"] == 120
    assert read_payload["artist_page"]["timeline_at"] == "2001-01-01"
    assert recent_status == 200
    assert recent_payload["recent_lookups"] == [
        {
            "virtual_artist_ref": created["virtual_artist_ref"],
            "artist_summary": {
                "display_name": "Mono",
                "sort_name": "Mono",
                "disambiguation_text": "Group | Japan",
            },
            "active_release_scope": "others",
            "active_release_scope_label": "Other Types",
            "freshness_state": "fresh",
            "refresh_state": "not_needed",
            "created_at": "2026-06-22T12:00:00Z",
            "expires_at": "2026-07-06T12:00:00Z",
            "read_route": (
                f"/virtual-artists/{created['virtual_artist_ref']}?release_scope=others"
            ),
        }
    ]


def test_asgi_virtual_discography_recent_route_keeps_stale_rows_but_drops_expired_snapshots(
    app,
    monkeypatch,
):
    from music_app.services import virtual_artist_snapshots as snapshot_module

    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    asgi_app = _make_wave_c_app(app)

    create_status, create_headers, create_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/virtual-artists",
        json_body={
            "candidate_ref": "musicbrainz:artist:artist-1",
            "display_name": "Mono",
        },
    )
    cookie_header = _cookie_header(create_headers)
    created = _decode_json(create_body)

    monkeypatch.setattr(
        snapshot_module,
        "_utc_now",
        lambda: base_now + timedelta(days=8),
    )
    stale_status, _stale_headers, stale_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/virtual-artists/recent",
        headers={"cookie": cookie_header},
    )

    monkeypatch.setattr(
        snapshot_module,
        "_utc_now",
        lambda: base_now + timedelta(days=15),
    )
    expired_status, _expired_headers, expired_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/virtual-artists/recent",
        headers={"cookie": cookie_header},
    )

    assert create_status == 201
    assert stale_status == 200
    assert _decode_json(stale_body)["recent_lookups"] == [
        {
            "virtual_artist_ref": created["virtual_artist_ref"],
            "artist_summary": {
                "display_name": "Mono",
                "sort_name": "Mono",
                "disambiguation_text": None,
            },
            "active_release_scope": "studio_ep",
            "active_release_scope_label": "Studio & EP",
            "freshness_state": "stale",
            "refresh_state": "fast_first_refresh_later",
            "created_at": "2026-06-22T12:00:00Z",
            "expires_at": "2026-07-06T12:00:00Z",
            "read_route": (
                f"/virtual-artists/{created['virtual_artist_ref']}"
                "?release_scope=studio_ep"
            ),
        }
    ]
    assert expired_status == 200
    assert _decode_json(expired_body)["recent_lookups"] == []


def test_asgi_virtual_discography_recent_route_isolated_per_client_session(
    app,
    monkeypatch,
):
    from music_app.services import virtual_artist_snapshots as snapshot_module

    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    asgi_app = _make_wave_c_app(app)

    first_status, first_headers, first_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/virtual-artists",
        json_body={
            "candidate_ref": "musicbrainz:artist:artist-1",
            "display_name": "Mono",
            "release_scope": "compilation",
        },
    )
    second_status, second_headers, second_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/virtual-artists",
        json_body={
            "candidate_ref": "musicbrainz:artist:artist-2",
            "display_name": "Boris",
            "release_scope": "live",
        },
    )
    first_created = _decode_json(first_body)
    second_created = _decode_json(second_body)

    first_recent_status, _first_recent_headers, first_recent_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/virtual-artists/recent",
        headers={"cookie": _cookie_header(first_headers)},
    )
    second_recent_status, _second_recent_headers, second_recent_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/virtual-artists/recent",
        headers={"cookie": _cookie_header(second_headers)},
    )

    assert first_status == 201
    assert second_status == 201
    assert first_recent_status == 200
    assert _decode_json(first_recent_body)["recent_lookups"] == [
        {
            "virtual_artist_ref": first_created["virtual_artist_ref"],
            "artist_summary": {
                "display_name": "Mono",
                "sort_name": "Mono",
                "disambiguation_text": None,
            },
            "active_release_scope": "compilation",
            "active_release_scope_label": "Compilation",
            "freshness_state": "fresh",
            "refresh_state": "not_needed",
            "created_at": "2026-06-22T12:00:00Z",
            "expires_at": "2026-07-06T12:00:00Z",
            "read_route": (
                f"/virtual-artists/{first_created['virtual_artist_ref']}"
                "?release_scope=compilation"
            ),
        }
    ]
    assert second_recent_status == 200
    assert _decode_json(second_recent_body)["recent_lookups"] == [
        {
            "virtual_artist_ref": second_created["virtual_artist_ref"],
            "artist_summary": {
                "display_name": "Boris",
                "sort_name": "Boris",
                "disambiguation_text": None,
            },
            "active_release_scope": "live",
            "active_release_scope_label": "Live",
            "freshness_state": "fresh",
            "refresh_state": "not_needed",
            "created_at": "2026-06-22T12:00:00Z",
            "expires_at": "2026-07-06T12:00:00Z",
            "read_route": (
                f"/virtual-artists/{second_created['virtual_artist_ref']}"
                "?release_scope=live"
            ),
        }
    ]


def test_asgi_virtual_artist_search_surfaces_provider_unavailability(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_c_asgi_routes as asgi_routes

    monkeypatch.setattr(
        asgi_routes,
        "search_virtual_artist_candidates",
        lambda query: {
            "ok": False,
            "error": "Virtual Discography candidate search is temporarily unavailable.",
            "query": str(query or ""),
            "provider_state": {
                "provider": "musicbrainz",
                "query_performed": True,
                "status": "blocked",
                "cache_hit": False,
                "blocked_reason": "http_503",
            },
            "candidate_contract": {
                "identity_field": "candidate_ref",
                "submit_route": "/virtual-artists",
                "display_name_field": "display_name",
                "disambiguation_text_field": "disambiguation_text",
                "provider_artist_id_field": "provider_artist_id",
            },
            "candidates": [],
        },
    )
    asgi_app = _make_wave_c_app(app)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/virtual-artists/search",
        query={"q": "mono"},
    )

    assert status == 503
    assert _decode_json(body) == {
        "ok": False,
        "error": "Virtual Discography candidate search is temporarily unavailable.",
        "transport": "remote_discovery",
        "route_family": "/virtual-artists",
        "response_kind": "virtual_artist_candidates",
        "query": "mono",
        "provider_state": {
            "provider": "musicbrainz",
            "query_performed": True,
            "status": "blocked",
            "cache_hit": False,
            "blocked_reason": "http_503",
        },
        "candidate_contract": {
            "identity_field": "candidate_ref",
            "submit_route": "/virtual-artists",
            "display_name_field": "display_name",
            "disambiguation_text_field": "disambiguation_text",
            "provider_artist_id_field": "provider_artist_id",
        },
        "candidates": [],
    }


def test_asgi_virtual_artist_and_release_routes_preserve_error_statuses(app, monkeypatch):
    from music_app.services import virtual_artist_snapshots as artist_snapshot_module
    from music_app.services import virtual_release_snapshots as release_snapshot_module

    _select_fake_virtual_release_postgres(app, monkeypatch)
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(artist_snapshot_module, "_utc_now", lambda: base_now)
    monkeypatch.setattr(release_snapshot_module, "_utc_now", lambda: base_now)
    asgi_app = _make_wave_c_app(app)

    artist_create_status, _artist_create_headers, artist_create_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/virtual-artists",
        json_body={
            "candidate_ref": "musicbrainz:artist:artist-1",
            "display_name": "Mono",
        },
    )
    artist_ref = _decode_json(artist_create_body)["virtual_artist_ref"]
    release_snapshot_module.create_virtual_release_snapshot(
        app.config,
        {
            "virtual_release_ref": "mb-release-group-123",
            "title": "Heligoland",
            "artist_credit": [{"name": "Massive Attack"}],
            "release_kind": "Album",
            "release_date": "2026-07-10",
            "release_date_precision": "day",
            "source_attributions": [
                {
                    "provider_key": "musicbrainz",
                    "provider_label": "MusicBrainz",
                    "source_url": "https://musicbrainz.org/release-group/rg-123",
                    "source_label": "Release group",
                }
            ],
            "source_provenance": {
                "provider": "musicbrainz",
                "provider_release_group_id": "rg-123",
                "provider_release_id": "rel-456",
                "capture_mode": "test_seed",
            },
        },
    )
    fresh_release_status, _fresh_release_headers, fresh_release_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/virtual-releases/mb-release-group-123",
    )
    monkeypatch.setattr(
        artist_snapshot_module,
        "_utc_now",
        lambda: base_now + timedelta(days=15),
    )
    monkeypatch.setattr(
        release_snapshot_module,
        "_utc_now",
        lambda: base_now + timedelta(days=15),
    )

    missing_artist_status, _missing_artist_headers, missing_artist_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/virtual-artists/not-real",
    )
    expired_artist_status, _expired_artist_headers, expired_artist_body = _run_asgi_request(
        asgi_app,
        "GET",
        f"/virtual-artists/{artist_ref}",
    )
    expired_release_status, _expired_release_headers, expired_release_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/virtual-releases/mb-release-group-123",
    )
    missing_release_status, _missing_release_headers, missing_release_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/virtual-releases/not-real",
    )

    assert artist_create_status == 201
    assert missing_artist_status == 404
    assert _decode_json(missing_artist_body)["error"] == "Virtual Discography snapshot was not found."
    assert fresh_release_status == 200
    fresh_release_payload = _decode_json(fresh_release_body)
    assert fresh_release_payload == {
        "ok": True,
        "transport": "remote_discovery",
        "route_family": "/virtual-releases",
        "response_kind": "virtual_release_page",
        "page_kind": "virtual_release",
        "virtual_release_ref": "mb-release-group-123",
        "created_at": "2026-06-22T12:00:00Z",
        "expires_at": "2026-07-06T12:00:00Z",
        "freshness_state": "fresh",
        "refresh_state": "not_needed",
        "virtual_release": {
            "page_kind": "virtual_release",
            "virtual_release_ref": "mb-release-group-123",
            "missing_from_library": {
                "state": "missing",
                "posture": "remote_only",
                "local_album_ref": None,
                "can_play_locally": False,
            },
            "title": "Heligoland",
            "artist_credit": [{"name": "Massive Attack"}],
            "release_kind": "Album",
            "release_date": "2026-07-10",
            "release_date_precision": "day",
            "release_timing_state": "upcoming",
            "countdown_target_at": "2026-07-10T00:00:00Z",
            "release_timing_contract": {
                "release_fields": [
                    "release_date",
                    "release_date_precision",
                    "release_timing_state",
                    "countdown_target_at",
                ],
                "optional_fields": ["countdown_target_at"],
                "viewer_local_fields": ["countdown_target_at"],
            },
            "remote_release_overlay_read_contract": {
                "supported_scopes": ["library_scoped", "user_scoped"],
                "scope_visibility": {
                    "library_scoped": {
                        "read_visibility": "shared_library_or_server_surface",
                        "precedence_rank": 1,
                    },
                    "user_scoped": {
                        "read_visibility": "viewer_private_surface",
                        "precedence_rank": 2,
                    },
                },
                "dedupe_policy": {
                    "logical_release_unit": "one_card_per_logical_remote_release",
                    "preferred_scope_order": ["library_scoped", "user_scoped"],
                    "collapse_to_local_album_when_available": True,
                },
                "canonical_truth_boundary": {
                    "canonical_album_card_source": "local_library_album",
                    "overlay_posture": "supplemental_remote_release_only",
                    "overlays_do_not_replace_canonical_album_identity": True,
                },
            },
            "source_attributions": [
                {
                    "provider_key": "musicbrainz",
                    "provider_label": "MusicBrainz",
                    "source_url": "https://musicbrainz.org/release-group/rg-123",
                    "source_label": "Release group",
                    "creator_name": None,
                    "license_label": None,
                    "license_url": None,
                    "attribution_text": None,
                }
            ],
            "source_provenance": {
                "provider": "musicbrainz",
                "provider_release_group_id": "rg-123",
                "provider_release_id": "rel-456",
                "capture_mode": "test_seed",
            },
            "freshness_state": "fresh",
            "last_enriched_at": "2026-06-22T12:00:00Z",
            "queued_refresh_state": "not_queued",
            "read_seam": {
                "source_kind": "virtual_release_snapshot",
                "visibility_scope": "viewer_safe",
                "read_mode": "cache_first",
                "request_fetch_policy": "never",
                "background_refresh_policy": "enqueue_only",
            },
            "visit_refresh": {
                "trigger": "page_visit",
                "enqueue_mode": "enqueue_only",
                "job_kind": "visit_deepen",
                "entity_kind": "virtual_release",
                "blocking": "never",
            },
            "gallery_bar": {
                "component_kind": "gallery_bar",
                "surface_family": "resource_page",
                "page_mode_query_parameter": "page_mode",
                "page_modes": ["info"],
                "default_page_mode": "info",
                "active_page_mode": "info",
                "info_drawer_toggle": {
                    "control_kind": "drawer_toggle",
                    "drawer_slot": "resource_page_info",
                },
            },
            "info_drawer": {
                "component_kind": "info_drawer",
                "surface_family": "resource_page",
                "drawer_slot": "resource_page_info",
                "placement": "right",
                "default_state": "closed",
                "content_kind": "virtual_release_detail_drawer",
            },
        },
    }
    assert "playback_context" not in fresh_release_payload["virtual_release"]
    assert "raw_file_path" not in fresh_release_payload["virtual_release"]
    assert expired_artist_status == 410
    assert _decode_json(expired_artist_body)["error"] == (
        "Virtual Discography snapshot expired and requires a new lookup."
    )
    assert missing_release_status == 404
    assert _decode_json(missing_release_body)["error"] == "Virtual release snapshot was not found."
    assert expired_release_status == 410
    assert _decode_json(expired_release_body)["error"] == (
        "Virtual release snapshot expired and requires a new lookup."
    )
