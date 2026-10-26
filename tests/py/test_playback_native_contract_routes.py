"""Native playback mutations share the authenticated browser security boundary."""

import asyncio
import hashlib

import pytest

from music_app.routes import playback_control_asgi
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.current_actor import CurrentActor
from tests.py.asgi_testing import decode_json, run_asgi_request
from tests.py.test_playback_stream_asgi import decoder_factory, media_path, open_command, playback_app
from tests.py.asgi_websocket_testing import websocket_session


@pytest.mark.parametrize("method,path", [
    ("POST", "/playback/refs"),
    ("GET", "/playback/state"),
    ("PUT", "/playback/state"),
    ("DELETE", "/playback/state"),
    ("POST", "/playback/state/handoff"),
])
def test_native_playback_contract_requires_authentication(playback_app, method, path):
    class AnonymousResolver:
        def resolve(self, _token):
            return CurrentActor.anonymous()

    playback_app.state.current_actor_resolver = AnonymousResolver()
    status, _, _ = run_asgi_request(playback_app, method, path, json_body={})
    assert status == 401


@pytest.mark.parametrize("method,path", [
    ("POST", "/playback/refs"),
    ("PUT", "/playback/state"),
    ("DELETE", "/playback/state"),
])
def test_native_playback_mutation_rejects_foreign_origin(playback_app, method, path):
    status, _, _ = run_asgi_request(
        playback_app, method, path, json_body={},
        headers={"origin": "https://foreign.example"},
    )
    assert status == 403


def test_short_listen_stages_reload_handoff_without_completion(playback_app, monkeypatch):
    calls = []
    playback_app.state.auth_policy_config["trusted_origins"] = ["http://testserver"]

    class Claims:
        def __init__(self, _config):
            pass

        def stage_handoff(self, actor, **kwargs):
            calls.append((actor, kwargs))
            return {
                "protocol": 1,
                "staged": True,
                "expiresAt": "2026-10-25T12:00:15+00:00",
            }

    monkeypatch.setattr(playback_control_asgi, "PostgresPlaybackClaims", Claims)
    client_id = "11111111-1111-4111-8111-111111111111"
    handoff_id = "22222222-2222-4222-8222-222222222222"
    csrf = issue_session_csrf("s" * 43, playback_app.state.auth_policy_config)
    status, _, body = run_asgi_request(
        playback_app,
        "POST",
        "/playback/state/handoff",
        json_body={
            "protocol": 1,
            "clientId": client_id,
            "claimToken": "p" * 43,
            "handoff": {"id": handoff_id, "token": "h" * 43},
            "completion": None,
            "csrf_token": csrf,
        },
    )

    assert status == 200, decode_json(body)
    assert decode_json(body) == {
        "protocol": 1,
        "staged": True,
        "expiresAt": "2026-10-25T12:00:15+00:00",
    }
    assert len(calls) == 1
    _, kwargs = calls[0]
    assert kwargs == {
        "client_id": client_id,
        "claim_token": "p" * 43,
        "handoff_id": handoff_id,
        "handoff_token": "h" * 43,
        "completion_digest": hashlib.sha256(
            b"album-haven:playback-handoff-completion:v1:null"
        ).digest(),
        "persist_completion": None,
    }


@pytest.mark.parametrize(
    ("csrf_case", "origin", "expected_status", "expected_calls"),
    [
        ("valid", "http://testserver", 200, 1),
        ("missing", "http://testserver", 400, 0),
        ("wrong", "http://testserver", 400, 0),
        ("valid", "https://foreign.example", 400, 0),
    ],
    ids=["matching-body-token", "missing-body-token", "wrong-body-token", "cross-origin"],
)
def test_handoff_beacon_uses_route_owned_body_csrf(
    playback_app, monkeypatch, csrf_case, origin, expected_status, expected_calls
):
    calls = []
    playback_app.state.auth_policy_config["trusted_origins"] = ["http://testserver"]

    class Claims:
        def __init__(self, _config):
            pass

        def stage_handoff(self, actor, **kwargs):
            calls.append((actor, kwargs))
            return {"protocol": 1, "staged": True, "expiresAt": "2026-10-25T12:00:15+00:00"}

    monkeypatch.setattr(playback_control_asgi, "PostgresPlaybackClaims", Claims)
    session = "s" * 43
    csrf = issue_session_csrf(session, playback_app.state.auth_policy_config)
    body = {
        "protocol": 1,
        "clientId": "11111111-1111-4111-8111-111111111111",
        "claimToken": "p" * 43,
        "handoff": {
            "id": "22222222-2222-4222-8222-222222222222",
            "token": "h" * 43,
        },
        "completion": None,
    }
    if csrf_case != "missing":
        body["csrf_token"] = csrf if csrf_case == "valid" else "wrong-token"

    status, _, _ = run_asgi_request(
        playback_app,
        "POST",
        "/playback/state/handoff",
        json_body=body,
        headers={
            "cookie": (
                f"__Host-album_haven_session={session}; "
                f"__Host-album_haven_csrf={csrf}"
            ),
            "origin": origin,
            "x-album-haven-csrf": "",
        },
    )

    assert status == expected_status
    assert len(calls) == expected_calls


@pytest.mark.parametrize("tracks", [[], [
    {"clientKey": str(index), "path": "/private/library/song.flac"}
    for index in range(101)
]])
def test_reference_batch_requires_one_to_one_hundred_tracks(playback_app, tracks):
    status, _, body = run_asgi_request(
        playback_app, "POST", "/playback/refs",
        json_body={"protocol": 1, "tracks": tracks},
    )
    assert status == 400
    assert "/private/library" not in body.decode()
    assert "tracks" not in decode_json(body)


@pytest.mark.parametrize("protocol", [None, 0, 2, True, "1"])
def test_reference_batch_rejects_unsupported_protocol(playback_app, protocol):
    status, _, _ = run_asgi_request(
        playback_app, "POST", "/playback/refs",
        json_body={"protocol": protocol, "tracks": [
            {"clientKey": "queue-item", "path": "/private/library/song.flac"},
        ]},
    )
    assert status == 400


@pytest.mark.parametrize("client_surface", [[], {}], ids=["array", "object"])
def test_claim_rejects_unhashable_client_surface(playback_app, client_surface):
    status, _, _ = run_asgi_request(
        playback_app, "PUT", "/playback/state",
        json_body={"protocol": 1, "clientId": "11111111-1111-4111-8111-111111111111", "clientSurface": client_surface,
                   "state": "playing", "track": {"playbackRef": "invalid-reference"}},
    )
    assert status == 400


@pytest.mark.parametrize("endpoint", ["now-playing", "scrobble", "complete"])
def test_playback_effect_requires_claim_before_provider_or_ledger_write(playback_app, monkeypatch, endpoint):
    from music_app.routes import api_wave_b_asgi_routes as routes

    calls = []
    monkeypatch.setattr(routes, "get_saved_lastfm_session", lambda *args, **kwargs: {"key": "test-session"})
    monkeypatch.setattr(routes, "update_now_playing", lambda *args, **kwargs: calls.append(args))
    monkeypatch.setattr(routes, "record_playback_session_complete", lambda *args, **kwargs: (calls.append(args) or {"ok": True}, 200))
    status, _, _ = run_asgi_request(
        playback_app, "POST", "/playback/session/" + endpoint,
        json_body={"artist": "Artist", "track": "Track", "album": "Album", "duration": 60,
                   "measurement_version": "rendered-pcm-v1"},
    )
    assert status == 403
    assert calls == []


@pytest.mark.parametrize("both", [True, False], ids=["both-identities", "neither-identity"])
def test_pcm_open_requires_exactly_one_media_identity(playback_app, media_path, decoder_factory, both):
    command = open_command(media_path)
    if both:
        command["playbackRef"] = "opaque-reference"
    else:
        command.pop("path")

    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await socket.send_json(command)
            assert await socket.receive_close() in {4400, 4404}

    asyncio.run(scenario())
    assert decoder_factory.instances == []


def test_pcm_invalid_reference_never_reaches_decoder_or_leaks_path(playback_app, media_path, decoder_factory, caplog):
    command = open_command(media_path)
    command.pop("path")
    command["playbackRef"] = str(media_path)

    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await socket.send_json(command)
            assert await socket.receive_close() == 4404

    asyncio.run(scenario())
    assert decoder_factory.instances == []
    assert str(media_path) not in caplog.text


def test_pcm_decoder_failure_does_not_echo_private_path(playback_app, media_path, decoder_factory, caplog):
    async def fail_read(**_kwargs):
        raise RuntimeError("decoder could not read " + str(media_path))

    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await socket.send_json(open_command(media_path))
            assert (await socket.receive_json())["type"] == "metadata"
            decoder_factory.instances[0].read_credited_frames = fail_read
            await socket.send_json({"type": "credit", "generation": 1, "streamId": 1, "frames": 1})
            error = await socket.receive_json()
            assert error["type"] == "error"
            assert str(media_path) not in str(error)

    asyncio.run(scenario())
    assert str(media_path) not in caplog.text
