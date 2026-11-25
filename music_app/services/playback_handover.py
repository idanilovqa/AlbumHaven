"""Play here asks the playing client, over its playback socket, to fall silent and say what sounded where.

A client that is there answers at once, so its word decides: a holder that plays is not stopped by a plain
press, and Play here waits for it to fall silent. A holder with no socket, or that says nothing at all in
time, is gone (a dead or unreachable device): the press starts without it, and if it was still playing
somewhere it stops once it reaches the server again. The holder first asks whether the press is still
wanted, so a press that is over stops nobody.
"""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
import time
from uuid import uuid4

# How long a holder told to stop has to fall silent and answer: its audio thread's acknowledgement (1 s),
# its output's drain and its song's reference.
STOPPING_SECONDS = 4
# A client that paused can still be asked this long: the other tab may show Play here until its next read.
RELEASED_HOLDER_SECONDS = 15

Send = Callable[[dict], Awaitable[None]]

# A holder that has no socket, or answered nothing in time: no device is there to play.
GONE = "gone"


@dataclass(eq=False)
class _Ask:
    key: tuple[int, int, str]
    send: Send
    accepts: Callable[[object], bool]
    answered: asyncio.Future
    wanted: asyncio.Future
    request_id: str = field(default_factory=lambda: str(uuid4()))
    # The holder said something about this ask, valid or not: it is there.
    heard: bool = False
    waiting: int = 0
    stop: asyncio.Task | None = None
    # "handover" for Play here; "handover-yield" asks a paused holder only whether nothing of it sounds.
    kind: str = "handover"


class PlaybackHandoverHub:
    """This process's client sockets by account; it holds nothing once they close or the press settles."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._sockets: dict[tuple[int, str], list[Send]] = {}
        # Sockets whose client said it answers a yield; an installed app of an older build never does.
        self._yielding: set[Send] = set()
        self._asks: dict[tuple[int, int, str], _Ask] = {}
        self._released: dict[tuple[int, int], tuple[float, str, bytes]] = {}
        self._asked: dict[tuple[int, int, str], tuple[Send, str]] = {}
        self._telling: set[asyncio.Task] = set()

    def register(self, account_id: int, client_id: str, send: Send, *, yields: bool = False) -> None:
        self._sockets.setdefault((account_id, client_id), []).append(send)
        if yields:
            self._yielding.add(send)

    def connected(self, account_id: int, client_id: str) -> bool:
        """Whether this client has a socket here: one with none plays nowhere a press could reach."""
        return bool(self._sockets.get((account_id, client_id)))

    def unregister(self, send: Send) -> None:
        self._yielding.discard(send)
        for key, sockets in list(self._sockets.items()):
            if send in sockets:
                sockets.remove(send)
                if not sockets:
                    del self._sockets[key]
        for key, (asked, _request_id) in list(self._asked.items()):
            if asked == send:
                del self._asked[key]
        for ask in self._asks.values():
            if ask.send == send and not ask.answered.done():
                ask.answered.set_result(GONE)

    async def ask(
        self,
        account_id: int,
        library_id: int,
        client_id: str,
        *,
        accepts: Callable[[object], bool],
        timeout: float,
        stopping: float = STOPPING_SECONDS,
    ) -> dict | str | None:
        """The holder's word that it is silent: its track and position, both None when it has none to hand
        on. [GONE] when it has no socket or says nothing at all within [timeout]. None when it is there but
        gives no valid word: within [timeout], or within [stopping] once told to stop.
        """
        key = (account_id, library_id, client_id)
        ask = self._asks.get(key)
        sending = None
        if ask is None:
            sockets = self._sockets.get((account_id, client_id))
            if not sockets:
                return GONE
            loop = asyncio.get_running_loop()
            ask = _Ask(key, sockets[-1], accepts, loop.create_future(), loop.create_future())
            self._asks[key] = ask
            # The socket may be busy with audio: writing to it is inside the limit too.
            sending = asyncio.create_task(self._send(ask))
        ask.waiting += 1
        try:
            await asyncio.wait({ask.answered, ask.wanted}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
            if ask.wanted.done() and not ask.answered.done():
                await asyncio.wait({ask.answered}, timeout=stopping)
            if ask.answered.done():
                return GONE if ask.answered.result() is GONE else ask.answered.result()
            return None if ask.wanted.done() or ask.heard else GONE
        finally:
            ask.waiting -= 1
            if not ask.waiting:
                del self._asks[key]
                if ask.stop is not None and not ask.stop.done():
                    ask.stop.cancel()
            if sending is not None and not sending.done():
                # A press that is over stops nobody later. Cancelling leaves the socket whole: a frame is
                # handed to the transport in one piece, and only the waits around that can be interrupted.
                sending.cancel()

    async def yielded(self, account_id: int, library_id: int, client_id: str, *, timeout: float) -> str:
        """Whether a plain press elsewhere may start over this holder. "silent": its word that nothing of it
        sounds, given from its output's real state as it drops its claim. "declined": it plays, is about to,
        or is being asked already; also a client that never said it answers this (an older installed app).
        [GONE]: no socket, or no word at all within [timeout].
        """
        key = (account_id, library_id, client_id)
        sockets = self._sockets.get((account_id, client_id), ())
        if not sockets:
            return GONE
        sockets = [send for send in sockets if send in self._yielding]
        if not sockets or key in self._asks:
            return "declined"
        loop = asyncio.get_running_loop()
        ask = _Ask(key, sockets[-1], lambda _token: False, loop.create_future(), loop.create_future(),
                   kind="handover-yield")
        self._asks[key] = ask
        ask.waiting = 1
        sending = asyncio.create_task(self._send(ask))
        try:
            await asyncio.wait({ask.answered}, timeout=timeout)
            if not ask.answered.done():
                return GONE
            result = ask.answered.result()
            return GONE if result is GONE else "declined" if result is None else "silent"
        finally:
            # A Play here pressed meanwhile waits on the same word.
            ask.waiting -= 1
            if not ask.waiting:
                del self._asks[key]
            if not sending.done():
                sending.cancel()

    async def _send(self, ask: _Ask) -> None:
        self._asked[ask.key] = (ask.send, ask.request_id)
        try:
            await ask.send({"type": ask.kind, "requestId": ask.request_id})
        except Exception:  # A socket that cannot be written is a holder that is gone.
            if not ask.answered.done():
                ask.answered.set_result(GONE)

    def declined(self, send: Send, request_id: object) -> bool:
        """The asked holder plays, or is about to: the press that asked it to yield is refused."""
        for ask in self._asks.values():
            if (ask.kind == "handover-yield" and ask.send == send and ask.request_id == request_id
                    and not ask.answered.done()):
                ask.answered.set_result(None)
                return True
        return False

    def wanted(self, send: Send, request_id: object) -> bool:
        """The holder's "still wanted?". Only a Play here that still waits tells it to stop."""
        for ask in self._asks.values():
            if (ask.kind == "handover" and ask.send == send and ask.request_id == request_id
                    and not ask.answered.done()):
                if not ask.wanted.done():
                    ask.wanted.set_result(True)
                    ask.stop = asyncio.create_task(self._stop(ask))
                return True
        return False

    async def _stop(self, ask: _Ask) -> None:
        try:
            await ask.send({"type": "handover-stop", "requestId": ask.request_id})
        except Exception:
            if not ask.answered.done():
                ask.answered.set_result(GONE)

    def answer(self, send: Send, message: dict) -> bool:
        for ask in self._asks.values():
            if ask.send != send or ask.request_id != message.get("requestId"):
                continue
            ask.heard = True
            if ask.answered.done() or not ask.accepts(message.get("claimToken")):
                return False
            ask.answered.set_result({"track": message.get("track"), "position": message.get("position")})
            return True
        return False

    def silent(self, send: Send, request_id: object) -> bool:
        """The asked socket's client has nothing sounding and nothing to hand on."""
        for ask in self._asks.values():
            if ask.send == send and ask.request_id == request_id and not ask.answered.done():
                ask.answered.set_result({"track": None, "position": None})
                return True
        return False

    async def settled(self, account_id: int, library_id: int, client_id: str, *, taken: bool = False) -> None:
        """Tells a holder that was asked that the press is over and whether it was taken over: else it plays on."""
        asked = self._asked.pop((account_id, library_id, client_id), None)
        if asked is None:
            return
        send, request_id = asked
        # Its socket may be busy with audio: the press never waits to tell it.
        telling = asyncio.create_task(
            self._tell(send, {"type": "handover-done", "requestId": request_id, "takenOver": taken}))
        self._telling.add(telling)
        telling.add_done_callback(self._telling.discard)

    def tell_others(self, account_id: int, client_id: str, event: dict) -> None:
        """Every other socket of [account_id] hears [event], such as a claim changing hands, so a paused
        device shows the other one playing at once instead of at its next read. Nobody waits for it."""
        mine = str(client_id or "").lower()
        for (account, other), sockets in list(self._sockets.items()):
            if account != account_id or other.lower() == mine:
                continue
            for send in list(sockets):
                telling = asyncio.create_task(self._tell(send, event))
                self._telling.add(telling)
                telling.add_done_callback(self._telling.discard)

    async def _tell(self, send: Send, event: dict) -> None:
        try:
            await asyncio.wait_for(send(event), timeout=1)
        except Exception:  # It learns at its next claim read instead.
            pass

    def remember_release(self, account_id: int, library_id: int, client_id: str, digest: bytes) -> None:
        now = self._clock()
        for key, (until, _client_id, _digest) in list(self._released.items()):
            if until <= now:
                del self._released[key]
        self._released[(account_id, library_id)] = (now + RELEASED_HOLDER_SECONDS, client_id, digest)

    def released(self, account_id: int, library_id: int) -> tuple[str, bytes] | None:
        """The client that released this account and library's claim moments ago, and its token's digest."""
        held = self._released.get((account_id, library_id))
        if held is None or held[0] <= self._clock():
            return None
        return held[1], held[2]
