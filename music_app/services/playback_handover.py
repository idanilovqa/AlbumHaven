"""Play here asks the playing client, over its playback socket, what sounds and where."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
import time
from uuid import uuid4

# A client that paused can still be asked this long: the other tab may show Play here until its next read.
RELEASED_HOLDER_SECONDS = 15

Send = Callable[[dict], Awaitable[None]]


@dataclass(eq=False)
class _Ask:
    key: tuple[int, int, str]
    send: Send
    accepts: Callable[[object], bool]
    answered: asyncio.Future
    request_id: str = field(default_factory=lambda: str(uuid4()))
    waiting: int = 0


class PlaybackHandoverHub:
    """This process's client sockets by account; it holds nothing once they close or the press settles."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._sockets: dict[tuple[int, str], list[Send]] = {}
        self._asks: dict[tuple[int, int, str], _Ask] = {}
        self._released: dict[tuple[int, int], tuple[float, str, bytes]] = {}
        self._asked: dict[tuple[int, int, str], tuple[Send, str]] = {}
        self._telling: set[asyncio.Task] = set()

    def register(self, account_id: int, client_id: str, send: Send) -> None:
        self._sockets.setdefault((account_id, client_id), []).append(send)

    def unregister(self, send: Send) -> None:
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
                ask.answered.set_result(None)

    async def ask(
        self,
        account_id: int,
        library_id: int,
        client_id: str,
        *,
        accepts: Callable[[object], bool],
        timeout: float,
    ) -> dict | None:
        """The holder's track and position, or None: no socket, it said it is silent, no valid answer,
        or none within [timeout].
        """
        key = (account_id, library_id, client_id)
        ask = self._asks.get(key)
        sending = None
        if ask is None:
            sockets = self._sockets.get((account_id, client_id))
            if not sockets:
                return None
            ask = _Ask(key, sockets[-1], accepts, asyncio.get_running_loop().create_future())
            self._asks[key] = ask
            # The socket may be busy with audio: writing to it is inside the limit too.
            sending = asyncio.create_task(self._send(ask))
        ask.waiting += 1
        try:
            await asyncio.wait({ask.answered}, timeout=timeout)
            return ask.answered.result() if ask.answered.done() else None
        finally:
            ask.waiting -= 1
            if not ask.waiting:
                del self._asks[key]
            if sending is not None and not sending.done():
                # A press that is over stops nobody later. Cancelling leaves the socket whole: a frame is
                # handed to the transport in one piece, and only the waits around that can be interrupted.
                sending.cancel()

    async def _send(self, ask: _Ask) -> None:
        self._asked[ask.key] = (ask.send, ask.request_id)
        try:
            await ask.send({"type": "handover", "requestId": ask.request_id})
        except Exception:  # A socket that cannot be written is a holder that cannot answer.
            if not ask.answered.done():
                ask.answered.set_result(None)

    def answer(self, send: Send, message: dict) -> bool:
        for ask in self._asks.values():
            if ask.send != send or ask.request_id != message.get("requestId"):
                continue
            if ask.answered.done() or not ask.accepts(message.get("claimToken")):
                return False
            ask.answered.set_result({"track": message.get("track"), "position": message.get("position")})
            return True
        return False

    def silent(self, send: Send, request_id: object) -> bool:
        """The asked socket's client has nothing sounding and nothing to hand on."""
        for ask in self._asks.values():
            if ask.send == send and ask.request_id == request_id and not ask.answered.done():
                ask.answered.set_result(None)
                return True
        return False

    async def settled(self, account_id: int, library_id: int, client_id: str) -> None:
        """Tells a holder that was asked that the press is over, so it shows who plays now."""
        asked = self._asked.pop((account_id, library_id, client_id), None)
        if asked is None:
            return
        send, request_id = asked
        # Its socket may be busy with audio: the press never waits to tell it.
        telling = asyncio.create_task(self._tell(send, {"type": "handover-done", "requestId": request_id}))
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
