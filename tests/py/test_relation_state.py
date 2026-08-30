from __future__ import annotations

from types import SimpleNamespace

from music_app.services import relation_state


def test_refresh_relation_views_in_state_updates_progress_and_completion(monkeypatch):
    library_state = {
        "albums": [SimpleNamespace(key="album-1"), SimpleNamespace(key="album-2")],
        "relation_views": {},
        "relations_in_progress": False,
        "relations_processed": 0,
        "relations_total": 0,
        "relations_phase": "Idle",
        "relations_source": "unknown",
        "relations_last_built": 0.0,
    }
    build_calls = []

    def fake_build_relation_views(albums, config, progress_callback=None):
        build_calls.append((list(albums), dict(config)))
        assert progress_callback is not None
        progress_callback(1, 2, "Building Artist Family", "local")
        return {
            "artists": ["Mono"],
            "family_to_artists": {"Mono": ["Mono"]},
            "folder_related": {},
            "sidebar_families": ["Mono"],
        }

    monkeypatch.setattr(relation_state, "build_relation_views", fake_build_relation_views)

    relation_views = relation_state.refresh_relation_views_in_state(library_state, {"APP_NAME": "Album Haven"})

    assert build_calls == [([library_state["albums"][0], library_state["albums"][1]], {"APP_NAME": "Album Haven"})]
    assert relation_views["artists"] == ["Mono"]
    assert library_state["relation_views"] == relation_views
    assert library_state["relations_in_progress"] is False
    assert library_state["relations_processed"] == 2
    assert library_state["relations_total"] == 2
    assert library_state["relations_phase"] == "Artist Family ready"
    assert library_state["relations_source"] == "local"
    assert library_state["relations_last_built"] > 0


def test_ensure_relation_views_refreshes_only_when_missing(monkeypatch):
    refresh_calls = []

    def fake_refresh(library_state, config):
        refresh_calls.append((library_state, config))
        library_state["relation_views"] = {"artists": ["Mono"], "folder_related": {"Mono": {"Broadcast"}}}
        return library_state["relation_views"]

    monkeypatch.setattr(relation_state, "refresh_relation_views_in_state", fake_refresh)

    empty_state = {"albums": [], "relation_views": {}}
    missing_views_state = {"albums": [SimpleNamespace(key="album-1")], "relation_views": {}}
    partial_views_state = {"albums": [SimpleNamespace(key="album-1")], "relation_views": {"artists": ["Mono"], "folder_related": {}}}
    existing_views_state = {
        "albums": [SimpleNamespace(key="album-1")],
        "relation_views": {"artists": ["Mono"], "folder_related": {"Mono": {"Broadcast"}}},
    }

    assert relation_state.ensure_relation_views(empty_state, {"APP_NAME": "Album Haven"}) is False
    assert relation_state.ensure_relation_views(missing_views_state, {"APP_NAME": "Album Haven"}) is True
    assert relation_state.ensure_relation_views(partial_views_state, {"APP_NAME": "Album Haven"}) is True
    assert relation_state.ensure_relation_views(existing_views_state, {"APP_NAME": "Album Haven"}) is False
    assert refresh_calls == [
        (missing_views_state, {"APP_NAME": "Album Haven"}),
        (partial_views_state, {"APP_NAME": "Album Haven"}),
    ]


def test_empty_relation_views_matches_default_shape():
    assert relation_state.empty_relation_views() == {
        "artists": [],
        "family_to_artists": {},
        "folder_related": {},
        "sidebar_families": [],
    }
