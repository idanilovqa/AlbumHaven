from __future__ import annotations

from datetime import datetime, timedelta, timezone

from music_app.services import virtual_artist_snapshots as snapshot_module


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


def _config_with_store() -> tuple[dict[str, object], InMemoryVirtualArtistSnapshotStore]:
    store = InMemoryVirtualArtistSnapshotStore()
    return {"VIRTUAL_ARTIST_SNAPSHOT_STORE": store}, store


def test_virtual_artist_snapshots_do_not_import_json_file_runtime_helpers():
    assert "json_files" not in snapshot_module.__dict__
    assert not hasattr(snapshot_module, "_virtual_artist_snapshots_path")
    assert not hasattr(snapshot_module, "_virtual_artist_recent_lookups_path")


def test_virtual_artist_snapshot_missing_store_fails_loudly():
    config = {}

    try:
        snapshot_module.read_virtual_artist_snapshot(
            config,
            "virtual-artist-missing",
        )
    except RuntimeError as exc:
        assert str(exc) == (
            "Virtual artist snapshot runtime persistence is Postgres-only."
        )
    else:
        raise AssertionError("missing virtual artist snapshot store did not fail")


def test_virtual_artist_snapshot_empty_store_fails_closed():
    config, _store = _config_with_store()
    assert snapshot_module.read_virtual_artist_snapshot(
        config,
        "virtual-artist-missing",
    ) == {
        "ok": False,
        "status": "missing",
    }
    assert snapshot_module.list_recent_virtual_artist_lookups(
        config,
        actor_key="visitor-a",
    ) == []


def test_virtual_artist_snapshot_round_trip_is_fresh_and_postgres_backed(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)

    config, _store = _config_with_store()
    created = snapshot_module.create_virtual_artist_snapshot(
        config,
        {
            "candidate_ref": "musicbrainz:artist:artist-1",
            "display_name": "Mono",
            "sort_name": "Mono",
            "disambiguation_text": "Group | Japan",
            "release_scope": "live",
        },
        actor_key="visitor-a",
    )

    assert created == {
        "ok": True,
        "virtual_artist_ref": created["virtual_artist_ref"],
        "created_at": "2026-06-22T12:00:00Z",
        "expires_at": "2026-07-06T12:00:00Z",
        "freshness_state": "fresh",
        "refresh_state": "not_needed",
        "default_release_scope": "live",
        "artist_summary": {
            "display_name": "Mono",
            "sort_name": "Mono",
            "disambiguation_text": "Group | Japan",
        },
        "source_provenance": {
            "provider": "musicbrainz",
            "provider_artist_id": "artist-1",
            "candidate_ref": "musicbrainz:artist:artist-1",
            "capture_mode": "candidate_search_selection",
        },
    }

    loaded = snapshot_module.read_virtual_artist_snapshot(
        config,
        created["virtual_artist_ref"],
    )

    assert loaded == {
        "ok": True,
        "status": "found",
        **created,
    }


def test_virtual_artist_snapshot_round_trip_becomes_stale_before_expiry(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    config, _store = _config_with_store()

    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    created = snapshot_module.create_virtual_artist_snapshot(
        config,
        {
            "candidate_ref": "musicbrainz:artist:artist-2",
            "display_name": "Boris",
        },
        actor_key="visitor-a",
    )

    monkeypatch.setattr(
        snapshot_module,
        "_utc_now",
        lambda: base_now + timedelta(days=8),
    )
    loaded = snapshot_module.read_virtual_artist_snapshot(
        config,
        created["virtual_artist_ref"],
    )

    assert loaded["ok"] is True
    assert loaded["status"] == "found"
    assert loaded["freshness_state"] == "stale"
    assert loaded["refresh_state"] == "fast_first_refresh_later"
    assert loaded["expires_at"] == "2026-07-06T12:00:00Z"


def test_virtual_artist_snapshot_read_expires_and_is_removed(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    config, _store = _config_with_store()

    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    created = snapshot_module.create_virtual_artist_snapshot(
        config,
        {
            "candidate_ref": "musicbrainz:artist:artist-3",
            "display_name": "Jesu",
        },
        actor_key="visitor-a",
    )

    monkeypatch.setattr(
        snapshot_module,
        "_utc_now",
        lambda: base_now + timedelta(days=15),
    )
    expired = snapshot_module.read_virtual_artist_snapshot(
        config,
        created["virtual_artist_ref"],
    )
    missing = snapshot_module.read_virtual_artist_snapshot(
        config,
        created["virtual_artist_ref"],
    )

    assert expired == {
        "ok": False,
        "status": "expired",
        "virtual_artist_ref": created["virtual_artist_ref"],
        "expires_at": "2026-07-06T12:00:00Z",
        "freshness_state": "expired",
        "refresh_state": "requires_new_lookup",
    }
    assert missing == {
        "ok": False,
        "status": "missing",
    }


def test_virtual_artist_snapshot_submit_rejects_invalid_candidate_refs():
    payload = snapshot_module.create_virtual_artist_snapshot(
        {},
        {
            "candidate_ref": "discogs:artist:123",
            "display_name": "Mono",
        },
        actor_key="visitor-a",
    )

    assert payload == {
        "ok": False,
        "error": (
            "Virtual Discography submit requires a MusicBrainz artist "
            "candidate_ref from /virtual-artists/search."
        ),
        "status_code": 400,
    }


def test_virtual_artist_snapshot_submit_rejects_empty_musicbrainz_artist_ids():
    payload = snapshot_module.create_virtual_artist_snapshot(
        {},
        {
            "candidate_ref": "musicbrainz:artist:   ",
            "display_name": "Mono",
        },
        actor_key="visitor-a",
    )

    assert payload == {
        "ok": False,
        "error": (
            "Virtual Discography submit requires a MusicBrainz artist "
            "candidate_ref from /virtual-artists/search."
        ),
        "status_code": 400,
    }


def test_virtual_artist_snapshot_create_records_recent_lookup_row(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    config, _store = _config_with_store()

    created = snapshot_module.create_virtual_artist_snapshot(
        config,
        {
            "candidate_ref": "musicbrainz:artist:artist-4",
            "display_name": "Massive Attack",
            "release_scope": "all",
        },
        actor_key="visitor-a",
    )

    recent = snapshot_module.list_recent_virtual_artist_lookups(
        config,
        actor_key="visitor-a",
    )

    assert recent == [
        {
            "virtual_artist_ref": created["virtual_artist_ref"],
            "artist_summary": {
                "display_name": "Massive Attack",
                "sort_name": "Massive Attack",
                "disambiguation_text": None,
            },
            "active_release_scope": "all",
            "active_release_scope_label": "All Release Types",
            "freshness_state": "fresh",
            "refresh_state": "not_needed",
            "created_at": "2026-06-22T12:00:00Z",
            "expires_at": "2026-07-06T12:00:00Z",
            "read_route": (
                f"/virtual-artists/{created['virtual_artist_ref']}"
                "?release_scope=all"
            ),
        }
    ]


def test_virtual_artist_recent_lookups_drop_expired_snapshot_refs(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    config, _store = _config_with_store()

    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    created = snapshot_module.create_virtual_artist_snapshot(
        config,
        {
            "candidate_ref": "musicbrainz:artist:artist-5",
            "display_name": "Bark Psychosis",
        },
        actor_key="visitor-a",
    )

    monkeypatch.setattr(
        snapshot_module,
        "_utc_now",
        lambda: base_now + timedelta(days=15),
    )
    recent = snapshot_module.list_recent_virtual_artist_lookups(
        config,
        actor_key="visitor-a",
    )

    assert recent == []
    assert snapshot_module.read_virtual_artist_snapshot(
        config,
        created["virtual_artist_ref"],
    ) == {
        "ok": False,
        "status": "missing",
    }


def test_virtual_artist_recent_lookups_are_scoped_per_actor_key(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    config, _store = _config_with_store()

    first = snapshot_module.create_virtual_artist_snapshot(
        config,
        {
            "candidate_ref": "musicbrainz:artist:artist-6",
            "display_name": "Mono",
            "release_scope": "studio_ep",
        },
        actor_key="visitor-a",
    )
    second = snapshot_module.create_virtual_artist_snapshot(
        config,
        {
            "candidate_ref": "musicbrainz:artist:artist-7",
            "display_name": "Boris",
            "release_scope": "live",
        },
        actor_key="visitor-b",
    )

    assert snapshot_module.list_recent_virtual_artist_lookups(
        config,
        actor_key="visitor-a",
    ) == [
        {
            "virtual_artist_ref": first["virtual_artist_ref"],
            "artist_summary": {
                "display_name": "Mono",
                "sort_name": "Mono",
                "disambiguation_text": None,
            },
            "active_release_scope": "studio_ep",
            "active_release_scope_label": "Studio & EP",
            "freshness_state": "fresh",
            "refresh_state": "not_needed",
            "created_at": "2026-06-22T12:00:00Z",
            "expires_at": "2026-07-06T12:00:00Z",
            "read_route": (
                f"/virtual-artists/{first['virtual_artist_ref']}"
                "?release_scope=studio_ep"
            ),
        }
    ]
    assert snapshot_module.list_recent_virtual_artist_lookups(
        config,
        actor_key="visitor-b",
    ) == [
        {
            "virtual_artist_ref": second["virtual_artist_ref"],
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
                f"/virtual-artists/{second['virtual_artist_ref']}"
                "?release_scope=live"
            ),
        }
    ]


def test_virtual_artist_recent_lookups_cap_reopen_rows_per_actor(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    config, _store = _config_with_store()

    for index in range(27):
        snapshot_module.create_virtual_artist_snapshot(
            config,
            {
                "candidate_ref": f"musicbrainz:artist:artist-{index}",
                "display_name": f"Artist {index}",
            },
            actor_key="visitor-a",
        )

    recent = snapshot_module.list_recent_virtual_artist_lookups(
        config,
        actor_key="visitor-a",
    )

    assert len(recent) == 25
    assert recent[0]["artist_summary"]["display_name"] == "Artist 26"
    assert recent[-1]["artist_summary"]["display_name"] == "Artist 2"


def test_virtual_artist_recent_lookups_cap_does_not_drop_other_actors(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    config, _store = _config_with_store()

    other_actor = snapshot_module.create_virtual_artist_snapshot(
        config,
        {
            "candidate_ref": "musicbrainz:artist:other-actor",
            "display_name": "Other Actor Artist",
        },
        actor_key="visitor-b",
    )
    for index in range(27):
        snapshot_module.create_virtual_artist_snapshot(
            config,
            {
                "candidate_ref": f"musicbrainz:artist:artist-{index}",
                "display_name": f"Artist {index}",
            },
            actor_key="visitor-a",
        )

    assert len(
        snapshot_module.list_recent_virtual_artist_lookups(
            config,
            actor_key="visitor-a",
        )
    ) == 25
    assert snapshot_module.list_recent_virtual_artist_lookups(
        config,
        actor_key="visitor-b",
    ) == [
        {
            "virtual_artist_ref": other_actor["virtual_artist_ref"],
            "artist_summary": {
                "display_name": "Other Actor Artist",
                "sort_name": "Other Actor Artist",
                "disambiguation_text": None,
            },
            "active_release_scope": "studio_ep",
            "active_release_scope_label": "Studio & EP",
            "freshness_state": "fresh",
            "refresh_state": "not_needed",
            "created_at": "2026-06-22T12:00:00Z",
            "expires_at": "2026-07-06T12:00:00Z",
            "read_route": (
                f"/virtual-artists/{other_actor['virtual_artist_ref']}"
                "?release_scope=studio_ep"
            ),
        }
    ]
