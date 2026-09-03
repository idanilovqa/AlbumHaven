"""Account-owned waveform history accepts events, never a client history snapshot."""

import asyncio
import json
from pathlib import Path

import pytest
from starlette.requests import Request

from tests.py.asgi_testing import decode_json
from tests.py.test_account_appearance_asgi import _actor, _app, _request
from tests.py.test_appearance_preferences_postgres import Connection, _repository


LEGACY = {"main_surface_color": None, "panel_background_color": None}
FULL = {**LEGACY, "palette_id": None, "panel_index": 0, "player_override": None, "compact_player_style": "docked"}


@pytest.mark.parametrize("base", [LEGACY, FULL])
def test_optional_selection_events_normalize_without_changing_legacy_or_modern_shape(base):
    from music_app.services.appearance_preferences_postgres import normalize_appearance_preferences

    assert normalize_appearance_preferences(base) == base
    payload = {**base, "waveform_color_updates": ["#aabbcc", "#79b390"]}
    assert normalize_appearance_preferences(payload) == {
        **base, "waveform_color_updates": ["#AABBCC", "#79B390"],
    }
    assert normalize_appearance_preferences({**base, "waveform_color_updates": []}) == {
        **base, "waveform_color_updates": [],
    }


@pytest.mark.parametrize("updates", [
    None, "#79B390", {}, [None], [True], ["#123"],
    ["#79B390\n"], ["#79B390", "#79b390"],
    ["#000001", "#000002", "#000003", "#000004", "#000005", "#000006"],
])
def test_bad_or_ambiguous_selection_events_rejected_before_repository_access(updates):
    app, repository, _ = _app()
    status, headers, body = _request(app, "PUT", {**FULL, "waveform_color_updates": updates})
    assert status == 400
    assert decode_json(body) == {"error": "invalid_appearance"}
    assert "no-store" in headers["cache-control"]
    assert repository.writes == []


def test_client_cannot_replace_server_history_with_a_stale_snapshot():
    app, repository, _ = _app()
    status, _, _ = _request(app, "PUT", {**FULL, "waveform_recent_colors": []})
    assert status == 400
    assert repository.writes == []


def test_read_shape_expands_legacy_and_keeps_recent_history_separate_from_updates():
    from music_app.services.appearance_preferences_postgres import expand_appearance_preferences

    assert expand_appearance_preferences(LEGACY) == {**FULL, "waveform_recent_colors": []}
    assert expand_appearance_preferences({**FULL, "waveform_recent_colors": ["#79B390"]}) == {
        **FULL, "waveform_recent_colors": ["#79B390"],
    }
    assert "waveform_color_updates" not in expand_appearance_preferences({
        **FULL, "waveform_color_updates": ["#79B390"],
    })


def test_api_returns_authoritative_account_history_and_passes_only_selection_events_to_save():
    app, repository, resolver = _app()
    repository.rows[41] = {**FULL, "waveform_recent_colors": ["#79B390", "#DCEBE3"]}
    status, headers, body = _request(app)
    assert status == 200
    assert decode_json(body)["waveform_recent_colors"] == ["#79B390", "#DCEBE3"]
    assert "no-store" in headers["cache-control"]
    resolver.actor = _actor(52)
    assert decode_json(_request(app)[2])["waveform_recent_colors"] == []

    captured = []
    def save(*, account_id, preferences, client_profile):
        captured.append((account_id, client_profile, preferences))
        return {**FULL, "waveform_recent_colors": ["#AABBCC", "#79B390"]}
    repository.save_preferences = save
    status, _, body = _request(app, "PUT", {**FULL, "waveform_color_updates": ["#aabbcc"]})
    assert status == 200
    assert decode_json(body) == {**FULL, "waveform_recent_colors": ["#AABBCC", "#79B390"]}
    assert captured == [(52, "desktop", {**FULL, "waveform_color_updates": ["#AABBCC"]})]


def test_bootstrap_exposes_this_actor_history_and_failure_clears_it():
    from jinja2 import Environment, FileSystemLoader
    from music_app.routes.appearance_asgi import load_appearance_context

    app, repository, _ = _app()
    repository.rows[41] = {**FULL, "waveform_recent_colors": ["#79B390"]}
    request = Request({"type": "http", "app": app, "state": {"current_actor": _actor(41)}})
    context = asyncio.run(load_appearance_context(request))
    assert context["appearance_preferences"]["waveform_recent_colors"] == ["#79B390"]
    templates = Path(__file__).parents[2] / "music_app" / "templates"
    rendered = Environment(loader=FileSystemLoader(templates)).get_template(
        "partials/appearance-bootstrap.html"
    ).render(**context)
    bootstrap = json.loads(rendered.split('type="application/json">', 1)[1].split("</script>", 1)[0])
    assert bootstrap["waveform_recent_colors"] == ["#79B390"]
    repository.fail = True
    failed = asyncio.run(load_appearance_context(request))
    assert failed["appearance_load_error"] is True
    assert failed["appearance_preferences"]["waveform_recent_colors"] == []


def test_repository_returns_history_and_binds_events_in_one_atomic_owner_upsert():
    row = {**LEGACY, "palette_id": None, "panel_index": 0,
           "waveform_recent_colors": ["#AABBCC", "#79B390", "#DCEBE3"]}
    connection = Connection(row)
    result = _repository(connection).save_preferences(account_id=41, preferences={
        **FULL, "waveform_color_updates": ["#aabbcc"],
    })
    assert result == {**FULL, "waveform_recent_colors": row["waveform_recent_colors"]}
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    assert "on conflict (account_id, client_profile)" in sql
    assert "merge_waveform_recent_colors" in sql
    assert params[0] == 41
    assert ["#AABBCC"] in params


def test_invalid_repository_events_never_open_a_connection():
    from music_app.services.appearance_preferences_postgres import PostgresAppearancePreferencesRepository

    opened = []
    repository = PostgresAppearancePreferencesRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda url: opened.append(url),
    )
    with pytest.raises(ValueError):
        repository.save_preferences(account_id=41, preferences={**FULL, "waveform_color_updates": [None]})
    assert opened == []
