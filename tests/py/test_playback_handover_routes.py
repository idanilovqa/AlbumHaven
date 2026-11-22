"""Play here end to end through the real routes: the taker's press, the holder's socket and its answer."""

import asyncio

import pytest

from music_app.services.playback_references import PlaybackContractError
from tests.py.asgi_testing import decode_json, run_asgi_request_async
from tests.py.asgi_websocket_testing import websocket_session
from tests.py.test_playback_stream_asgi import playback_app  # noqa: F401

HOLDER = "0c8f5a54-2d1e-4b7a-9a43-6f2d8b1c3e70"
TAKER = "6b1f2e0a-9c4d-4e53-8a77-2f0d9e8c1b22"
SOUNDING = {"playbackRef": "sounding", "title": "Old", "artist": "A", "album": "B", "artworkUrl": None}
PLACE = {"ms": 117_600, "durationMs": 195_000}
SAVED = {"track": {**SOUNDING, "playbackRef": "saved"}, "position": {"ms": 5_000, "durationMs": 195_000}}


class Claims:
    """The claim service as the routes use it: one live claim of the holder."""

    replaced: list = []

    def __init__(self, _config):
        pass

    def holder(self, actor):
        return {"account_id": actor.account_id, "library_id": 1, "client_id": HOLDER, "digest": b"held"}

    def get(self, actor, client_id):
        return {"protocol": 1, "is_playing_elsewhere": False}

    def holds(self, holder, token):
        return token == "holder-token" and holder["digest"] == b"held"

    def hand_over(self, actor, *, client_id, client_surface, observed, answer):
        Claims.replaced.append({"client_id": client_id, "observed": observed, "answer": answer})
        chosen = answer or SAVED
        return {"protocol": 1, "claimToken": "taker-token", "confirmed": answer is not None,
                "track": chosen["track"], "position": chosen["position"], "path": "opened-as-the-browse-names-it"}


@pytest.fixture
def handover_app(playback_app, monkeypatch):  # noqa: F811
    from music_app.routes import playback_control_asgi, playback_stream_asgi

    async def no_scrobbling(_request):
        return {}

    Claims.replaced = []
    monkeypatch.setattr(playback_control_asgi, "PostgresPlaybackClaims", Claims)
    monkeypatch.setattr(playback_control_asgi, "_scrobbling_status", no_scrobbling)
    monkeypatch.setattr(playback_control_asgi, "HANDOVER_ANSWER_SECONDS", 0.8)
    assert playback_stream_asgi
    return playback_app


def press(app):
    return run_asgi_request_async(app, "PUT", "/playback/state", json_body={
        "protocol": 1, "state": "playing", "clientId": TAKER, "clientSurface": "private_web",
        "takeover": True, "confirm": True,
    })


def test_play_here_starts_where_the_holder_says_not_where_it_last_saved(handover_app):
    async def scenario():
        async with websocket_session(handover_app, f"/playback/pcm?client_id={HOLDER}") as holder:
            pressing = asyncio.create_task(press(handover_app))
            asked = await holder.receive_json()
            assert set(asked) == {"type", "requestId"} and asked["type"] == "handover"
            await holder.send_json({"type": "handover-answer", "requestId": asked["requestId"],
                                    "claimToken": "holder-token", "track": SOUNDING, "position": PLACE})
            status, _, body = await pressing
            assert status == 200
            answer = decode_json(body)
            assert (answer["confirmed"], answer["track"], answer["position"]) == (True, SOUNDING, PLACE)
            assert Claims.replaced[0]["observed"]["digest"] == b"held"
            assert await holder.receive_json() == {"type": "handover-done", "requestId": asked["requestId"]}

    asyncio.run(scenario())


def test_play_here_with_no_socket_of_the_holder_uses_the_saved_place_without_waiting(handover_app, monkeypatch):
    from music_app.routes import playback_control_asgi

    monkeypatch.setattr(playback_control_asgi, "HANDOVER_ANSWER_SECONDS", 30)

    async def scenario():
        status, _, body = await asyncio.wait_for(press(handover_app), 5)
        assert status == 200
        answer = decode_json(body)
        assert (answer["confirmed"], answer["position"]) == (False, SAVED["position"])

    asyncio.run(scenario())


def test_an_answer_with_another_token_is_ignored_and_the_saved_place_is_used(handover_app):
    async def scenario():
        async with websocket_session(handover_app, f"/playback/pcm?client_id={HOLDER}") as holder:
            pressing = asyncio.create_task(press(handover_app))
            asked = await holder.receive_json()
            await holder.send_json({"type": "handover-answer", "requestId": asked["requestId"],
                                    "claimToken": "stale", "track": SOUNDING, "position": PLACE})
            status, _, body = await pressing
            assert status == 200 and decode_json(body)["confirmed"] is False
            assert Claims.replaced[0]["answer"] is None

    asyncio.run(scenario())


def test_a_holder_that_did_not_answer_is_told_at_once_that_the_press_is_over(handover_app):
    async def scenario():
        async with websocket_session(handover_app, f"/playback/pcm?client_id={HOLDER}") as holder:
            pressing = asyncio.create_task(press(handover_app))
            asked = await holder.receive_json()
            status, _, body = await pressing
            assert status == 200 and decode_json(body)["confirmed"] is False
            # It learns now that another client plays, not at its next renewal.
            assert await holder.receive_json() == {"type": "handover-done", "requestId": asked["requestId"]}

    asyncio.run(scenario())


def test_a_holder_with_nothing_sounding_gives_way_at_the_saved_place(handover_app):
    async def scenario():
        async with websocket_session(handover_app, f"/playback/pcm?client_id={HOLDER}") as holder:
            pressing = asyncio.create_task(press(handover_app))
            asked = await holder.receive_json()
            await holder.send_json({"type": "handover-silent", "requestId": asked["requestId"]})
            status, _, body = await pressing
            assert status == 200
            assert (decode_json(body)["confirmed"], decode_json(body)["position"]) == (False, SAVED["position"])

    asyncio.run(scenario())


def test_a_claim_taken_by_a_third_client_meanwhile_is_refused(handover_app, monkeypatch):
    def lost(self, *_args, **_kwargs):
        raise PlaybackContractError(409)

    monkeypatch.setattr(Claims, "hand_over", lost)

    async def scenario():
        status, _, _ = await press(handover_app)
        assert status == 409

    asyncio.run(scenario())


def test_a_socket_naming_no_valid_client_still_plays_and_is_never_asked(handover_app):
    async def scenario():
        async with websocket_session(handover_app, "/playback/pcm?client_id=not-a-uuid") as socket:
            assert socket.accepted
            status, _, body = await press(handover_app)
            assert status == 200 and decode_json(body)["confirmed"] is False

    asyncio.run(scenario())


def test_play_here_on_a_tab_that_just_paused_starts_at_its_paused_place(handover_app, monkeypatch):
    def nobody(self, actor):
        return {"account_id": actor.account_id, "library_id": 1, "client_id": None, "digest": None}

    def release(self, actor, *, client_id, claim_token):
        return {"account_id": actor.account_id, "library_id": 1, "client_id": client_id, "digest": b"held"}

    monkeypatch.setattr(Claims, "holder", nobody)
    monkeypatch.setattr(Claims, "release", release, raising=False)

    async def scenario():
        async with websocket_session(handover_app, f"/playback/pcm?client_id={HOLDER}") as holder:
            status, _, _ = await run_asgi_request_async(handover_app, "DELETE", "/playback/state", json_body={
                "protocol": 1, "clientId": HOLDER, "claimToken": "holder-token"})
            assert status == 200
            pressing = asyncio.create_task(press(handover_app))
            asked = await holder.receive_json()
            await holder.send_json({"type": "handover-answer", "requestId": asked["requestId"],
                                    "claimToken": "holder-token", "track": SOUNDING, "position": PLACE})
            status, _, body = await pressing
            assert status == 200
            answer = decode_json(body)
            assert (answer["confirmed"], answer["position"]) == (True, PLACE)
            assert Claims.replaced[0]["observed"]["client_id"] == HOLDER

    asyncio.run(scenario())


def test_a_malformed_press_is_refused_before_the_playing_tab_is_asked_to_stop(handover_app):
    async def scenario():
        async with websocket_session(handover_app, f"/playback/pcm?client_id={HOLDER}") as holder:
            status, _, _ = await run_asgi_request_async(handover_app, "PUT", "/playback/state", json_body={
                "protocol": 1, "state": "playing", "clientId": "not-a-uuid", "clientSurface": "private_web",
                "takeover": True, "confirm": True,
            })
            assert status == 400
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(holder.receive_json(), 0.2)

    asyncio.run(scenario())
