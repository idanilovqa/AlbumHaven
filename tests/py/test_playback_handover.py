"""Play here asks the playing client: who is asked, whose answer counts, and how long the press waits."""

import asyncio

from music_app.services.playback_handover import PlaybackHandoverHub

ACCOUNT = 7
LIBRARY = 3
HOLDER = "0c8f5a54-2d1e-4b7a-9a43-6f2d8b1c3e70"
TOKEN = "holder-token"
ANSWER = {"track": {"playbackRef": "opaque"}, "position": {"ms": 117_600, "durationMs": 195_000}}


class Socket:
    def __init__(self, fail=False):
        self.sent = []
        self.arrived = asyncio.Event()
        self.fail = fail

    async def send(self, event):
        if self.fail:
            raise ConnectionError()
        self.sent.append(event)
        self.arrived.set()

    async def request_id(self):
        await asyncio.wait_for(self.arrived.wait(), 1)
        return self.sent[0]["requestId"]


def accepts(token):
    return token == TOKEN


def answer(request_id, token=TOKEN):
    return {"type": "handover-answer", "requestId": request_id, "claimToken": token, **ANSWER}


def ask(hub, account=ACCOUNT, timeout=1.0):
    return hub.ask(account, LIBRARY, HOLDER, accepts=accepts, timeout=timeout)


def test_the_asked_socket_answers_with_the_song_and_place_and_is_sent_no_song_or_path():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send)
        asking = asyncio.create_task(ask(hub))
        request_id = await holder.request_id()
        assert holder.sent == [{"type": "handover", "requestId": request_id}]
        assert hub.answer(holder.send, answer(request_id))
        assert await asking == ANSWER

    asyncio.run(scenario())


def test_with_no_socket_of_the_holder_the_press_does_not_wait():
    async def scenario():
        hub = PlaybackHandoverHub()
        assert await asyncio.wait_for(ask(hub, timeout=30), 0.5) is None

    asyncio.run(scenario())


def test_the_same_client_id_of_another_account_is_never_asked():
    async def scenario():
        hub, stranger = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT + 1, HOLDER, stranger.send)
        assert await asyncio.wait_for(ask(hub, timeout=30), 0.5) is None
        assert stranger.sent == []

    asyncio.run(scenario())


def test_only_the_socket_that_was_asked_can_answer():
    async def scenario():
        hub, holder, other = PlaybackHandoverHub(), Socket(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send)
        hub.register(ACCOUNT, "6b1f2e0a-9c4d-4e53-8a77-2f0d9e8c1b22", other.send)
        asking = asyncio.create_task(ask(hub, timeout=0.2))
        request_id = await holder.request_id()
        assert not hub.answer(other.send, answer(request_id))
        assert not hub.silent(other.send, request_id)
        assert await asking is None
        assert other.sent == []

    asyncio.run(scenario())


def test_an_answer_without_the_holders_token_does_not_count():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send)
        asking = asyncio.create_task(ask(hub))
        request_id = await holder.request_id()
        assert not hub.answer(holder.send, answer(request_id, token="stale-token"))
        assert not asking.done()
        assert hub.answer(holder.send, answer(request_id))
        assert await asking == ANSWER

    asyncio.run(scenario())


def test_a_silent_holder_costs_no_more_than_the_limit_and_a_late_answer_changes_nothing():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send)
        assert await asyncio.wait_for(ask(hub, timeout=0.05), 1) is None
        assert not hub.answer(holder.send, answer(await holder.request_id()))

    asyncio.run(scenario())


def test_a_holder_whose_socket_closes_while_asked_ends_the_wait_at_once():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send)
        asking = asyncio.create_task(ask(hub, timeout=30))
        await holder.request_id()
        hub.unregister(holder.send)
        assert await asyncio.wait_for(asking, 0.5) is None

    asyncio.run(scenario())


def test_a_socket_that_cannot_be_written_ends_the_wait_at_once():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket(fail=True)
        hub.register(ACCOUNT, HOLDER, holder.send)
        assert await asyncio.wait_for(ask(hub, timeout=30), 0.5) is None

    asyncio.run(scenario())


def test_a_holder_with_nothing_sounding_says_so_and_ends_the_wait_at_once():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send)
        asking = asyncio.create_task(ask(hub, timeout=30))
        assert hub.silent(holder.send, await holder.request_id())
        assert await asyncio.wait_for(asking, 0.5) == {"track": None, "position": None}, "its word, not no answer"

    asyncio.run(scenario())


def test_a_holder_that_was_asked_and_did_not_answer_is_still_told_the_press_is_over():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send)
        assert await ask(hub, timeout=0.05) is None
        await hub.settled(ACCOUNT, LIBRARY, HOLDER)
        await asyncio.sleep(0.05)
        assert holder.sent[-1] == {"type": "handover-done", "requestId": holder.sent[0]["requestId"], "takenOver": False}

    asyncio.run(scenario())


def test_an_ask_still_waiting_to_be_written_at_the_limit_leaves_the_socket_working_and_stops_nobody():
    async def scenario():
        hub, holder, writing = PlaybackHandoverHub(), Socket(), asyncio.Lock()

        async def send(event):
            async with writing:
                await holder.send(event)

        hub.register(ACCOUNT, HOLDER, send)
        await writing.acquire()  # busy with audio
        assert await ask(hub, timeout=0.05) is None
        writing.release()
        await asyncio.sleep(0.05)
        assert holder.sent == [], "a press that is over stops nobody later"
        await send({"type": "audio"})
        assert holder.sent == [{"type": "audio"}]

    asyncio.run(scenario())


def test_two_presses_at_once_ask_the_holder_once():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send)
        presses = [asyncio.create_task(ask(hub)) for _ in range(2)]
        request_id = await holder.request_id()
        assert hub.answer(holder.send, answer(request_id))
        assert await asyncio.gather(*presses) == [ANSWER, ANSWER]
        assert len(holder.sent) == 1

    asyncio.run(scenario())


def test_the_newest_socket_of_a_client_is_the_one_asked():
    async def scenario():
        hub, old, new = PlaybackHandoverHub(), Socket(), Socket()
        hub.register(ACCOUNT, HOLDER, old.send)
        hub.register(ACCOUNT, HOLDER, new.send)
        hub.unregister(old.send)
        asking = asyncio.create_task(ask(hub))
        assert hub.answer(new.send, answer(await new.request_id()))
        assert await asking == ANSWER
        assert old.sent == []

    asyncio.run(scenario())


def test_the_client_that_just_paused_can_still_be_asked_briefly_and_only_in_its_account_and_library():
    now = [100.0]
    hub = PlaybackHandoverHub(clock=lambda: now[0])
    hub.remember_release(ACCOUNT, LIBRARY, HOLDER, b"digest")
    assert hub.released(ACCOUNT, LIBRARY) == (HOLDER, b"digest")
    assert hub.released(ACCOUNT + 1, LIBRARY) is None
    assert hub.released(ACCOUNT, LIBRARY + 1) is None
    now[0] += 16
    assert hub.released(ACCOUNT, LIBRARY) is None


def test_telling_the_holder_the_press_is_over_never_delays_the_press():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        busy = asyncio.Event()

        async def send(event):
            if event["type"] == "handover-done":
                await busy.wait()
            await holder.send(event)

        hub.register(ACCOUNT, HOLDER, send)
        asking = asyncio.create_task(ask(hub))
        hub.answer(send, answer(await holder.request_id()))
        await asking
        await asyncio.wait_for(hub.settled(ACCOUNT, LIBRARY, HOLDER), 0.2)
        busy.set()
        await asyncio.sleep(0.05)
        assert holder.sent[-1]["type"] == "handover-done"

    asyncio.run(scenario())


def test_a_handover_never_holds_one_database_connection_while_it_takes_another(monkeypatch):
    from contextlib import contextmanager
    from datetime import datetime, timezone

    from music_app.services import playback_claims_postgres

    depth = [0]
    deepest = [0]

    class Connection:
        def execute(self, *_args):
            return self

        def fetchone(self):
            return {"client_id": "taker", "track": {"playbackRef": "saved", "title": "", "artist": "", "album": ""}}

    @contextmanager
    def connect(_url):
        depth[0] += 1
        deepest[0] = max(deepest[0], depth[0])
        try:
            yield Connection()
        finally:
            depth[0] -= 1

    class References:
        def __init__(self, *_args, connect, **_kwargs):
            self._connect = connect

        def resolve_library_path(self, _actor, _reference):
            with self._connect(None):
                return "a-path"

    monkeypatch.setattr(playback_claims_postgres, "PlaybackReferenceService", References)
    monkeypatch.setattr(playback_claims_postgres, "require_playback_membership", lambda *_: (ACCOUNT, LIBRARY))
    claims = playback_claims_postgres.PostgresPlaybackClaims(
        {}, clock=lambda: datetime.now(timezone.utc), connect=connect)
    claims.hand_over(object(), client_id="6b1f2e0a-9c4d-4e53-8a77-2f0d9e8c1b22", client_surface="private_web",
                     observed={"client_id": HOLDER, "digest": b"held", "silent": True}, answer=None)
    assert deepest[0] == 1

def test_a_holder_stops_only_for_a_press_still_wanted_and_then_gets_time_to_fall_silent():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send)
        asking = asyncio.create_task(hub.ask(ACCOUNT, LIBRARY, HOLDER, accepts=accepts, timeout=0.2, stopping=2))
        request_id = await holder.request_id()
        assert hub.wanted(holder.send, request_id)
        await asyncio.sleep(0.4)
        assert holder.sent[-1] == {"type": "handover-stop", "requestId": request_id}
        assert not asking.done(), "told to stop, it is not abandoned while its output drains"
        assert hub.answer(holder.send, answer(request_id))
        assert await asking == ANSWER

    asyncio.run(scenario())


def test_a_holder_that_asks_too_late_is_never_told_to_stop():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send)
        assert await ask(hub, timeout=0.05) is None
        assert not hub.wanted(holder.send, await holder.request_id())
        await asyncio.sleep(0.05)
        assert [event["type"] for event in holder.sent] == ["handover"]

    asyncio.run(scenario())


def test_only_the_asked_socket_can_ask_whether_it_is_still_wanted():
    async def scenario():
        hub, holder, other = PlaybackHandoverHub(), Socket(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send)
        asking = asyncio.create_task(ask(hub, timeout=0.1))
        assert not hub.wanted(other.send, await holder.request_id())
        assert await asking is None
        assert other.sent == []

    asyncio.run(scenario())


def test_a_holder_told_to_stop_that_never_answers_is_no_proof():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send)
        asking = asyncio.create_task(hub.ask(ACCOUNT, LIBRARY, HOLDER, accepts=accepts, timeout=0.05, stopping=0.1))
        assert hub.wanted(holder.send, await holder.request_id())
        assert await asyncio.wait_for(asking, 1) is None

    asyncio.run(scenario())


# A plain press while another client of the account is paused with its claim: only that client's word that
# nothing of it sounds lets the press start. Its own Play inside the hold then sounds at once, with no request.
def yielded(hub, timeout=1.0):
    return hub.yielded(ACCOUNT, LIBRARY, HOLDER, timeout=timeout)


def test_a_paused_holder_that_says_it_is_silent_yields_and_is_asked_nothing_else():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send, yields=True)
        asking = asyncio.create_task(yielded(hub))
        request_id = await holder.request_id()
        assert holder.sent == [{"type": "handover-yield", "requestId": request_id}]
        assert hub.silent(holder.send, request_id)
        assert await asking is True
        await hub.settled(ACCOUNT, LIBRARY, HOLDER, taken=True)
        await asyncio.sleep(0)
        assert holder.sent[-1] == {"type": "handover-done", "requestId": request_id, "takenOver": True}

    asyncio.run(scenario())


def test_a_holder_that_plays_declines_and_the_press_is_refused_at_once():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send, yields=True)
        asking = asyncio.create_task(yielded(hub, timeout=30))
        assert hub.declined(holder.send, await holder.request_id())
        assert await asyncio.wait_for(asking, 0.5) is False

    asyncio.run(scenario())


def test_a_client_that_never_said_it_yields_is_never_asked_and_never_counts_as_silent():
    # An installed app of an older build does not know the question: its press elsewhere is refused as before.
    async def scenario():
        hub, old_app = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, old_app.send)
        assert await asyncio.wait_for(yielded(hub, timeout=30), 0.5) is False
        assert old_app.sent == []

    asyncio.run(scenario())


def test_no_socket_no_word_in_time_or_a_closed_socket_is_no_proof_of_silence():
    async def scenario():
        assert await asyncio.wait_for(yielded(PlaybackHandoverHub(), timeout=30), 0.5) is False
        quiet_hub, quiet = PlaybackHandoverHub(), Socket()
        quiet_hub.register(ACCOUNT, HOLDER, quiet.send, yields=True)
        assert await yielded(quiet_hub, timeout=0.05) is False
        closed_hub, closed = PlaybackHandoverHub(), Socket(fail=True)
        closed_hub.register(ACCOUNT, HOLDER, closed.send, yields=True)
        assert await asyncio.wait_for(yielded(closed_hub, timeout=30), 0.5) is False

    asyncio.run(scenario())


def test_a_yield_is_never_a_handover_its_holder_cannot_be_told_to_stop_or_answer_a_song():
    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send, yields=True)
        asking = asyncio.create_task(yielded(hub, timeout=0.1))
        request_id = await holder.request_id()
        assert not hub.wanted(holder.send, request_id)
        assert not hub.answer(holder.send, answer(request_id))
        assert await asking is False
        assert [event["type"] for event in holder.sent] == ["handover-yield"]

    asyncio.run(scenario())


def test_the_yield_messages_are_the_contract_the_web_and_the_phone_share():
    import json
    from pathlib import Path

    from music_app.routes import playback_stream_asgi

    contract = json.loads((Path(__file__).parents[1] / "fixtures" / "playback-handover-yield-v1.json").read_text())
    key, value = contract["socketQuery"].split("=")
    assert playback_stream_asgi._socket_yields(type("Socket", (), {"query_params": {key: value}})())
    assert not playback_stream_asgi._socket_yields(type("Socket", (), {"query_params": {}})())
    assert set(contract["silent"]) == set(contract["declined"]) == playback_stream_asgi._HANDOVER_REQUEST_KEYS
    assert contract["pausedRenewalState"] == "paused", "the state a renewal kept through a pause sends"

    async def scenario():
        hub, holder = PlaybackHandoverHub(), Socket()
        hub.register(ACCOUNT, HOLDER, holder.send, yields=True)
        asking = asyncio.create_task(yielded(hub))
        request_id = await holder.request_id()
        assert set(holder.sent[0]) == set(contract["ask"]) and holder.sent[0]["type"] == contract["ask"]["type"]
        assert hub.silent(holder.send, request_id)
        assert await asking is True
        await hub.settled(ACCOUNT, LIBRARY, HOLDER, taken=True)
        await asyncio.sleep(0)
        assert set(holder.sent[-1]) == set(contract["done"])

    asyncio.run(scenario())
