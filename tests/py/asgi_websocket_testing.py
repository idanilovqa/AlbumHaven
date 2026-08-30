from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
from typing import Any, AsyncIterator


class AsgiWebSocketSession:
    def __init__(
        self,
        app,
        path: str,
        *,
        origin: str | None,
        host: str,
        scheme: str,
    ) -> None:
        self._app = app
        self._path = path
        self._origin = origin
        self._host = host
        self._scheme = scheme
        self._incoming: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self._outgoing: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None
        self.accepted = False
        self.close_code: int | None = None

    async def connect(self) -> None:
        headers = [(b"host", self._host.encode("latin1"))]
        if self._origin is not None:
            headers.append((b"origin", self._origin.encode("latin1")))
        scope = {
            "type": "websocket",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "scheme": self._scheme,
            "path": self._path,
            "raw_path": self._path.encode("ascii"),
            "query_string": b"",
            "headers": headers,
            "client": ("testclient", 50000),
            "server": (self._host.split(":", 1)[0], 80),
            "subprotocols": [],
            "state": {},
        }

        async def receive() -> dict[str, object]:
            return await self._incoming.get()

        async def send(message: dict[str, object]) -> None:
            await self._outgoing.put(dict(message))

        self._task = asyncio.create_task(self._app(scope, receive, send))
        await self._incoming.put({"type": "websocket.connect"})
        handshake = await self.receive_message()
        if handshake["type"] == "websocket.accept":
            self.accepted = True
            return
        if handshake["type"] != "websocket.close":
            raise AssertionError(f"unexpected WebSocket handshake message: {handshake!r}")

    async def send_json(self, payload: Any) -> None:
        await self.send_text(json.dumps(payload, separators=(",", ":"), allow_nan=True))

    async def send_text(self, text: str) -> None:
        if not self.accepted or self.close_code is not None:
            raise AssertionError("cannot send text on a WebSocket that is not open")
        await self._incoming.put({"type": "websocket.receive", "text": text})

    async def send_bytes(self, data: bytes) -> None:
        if not self.accepted or self.close_code is not None:
            raise AssertionError("cannot send bytes on a WebSocket that is not open")
        await self._incoming.put({"type": "websocket.receive", "bytes": data})

    async def receive_message(self) -> dict[str, object]:
        message = await asyncio.wait_for(self._outgoing.get(), timeout=2)
        if message["type"] == "websocket.close":
            self.close_code = int(message.get("code", 1000))
        return message

    async def receive_json(self) -> Any:
        message = await self.receive_message()
        if message["type"] != "websocket.send" or "text" not in message:
            raise AssertionError(f"expected a JSON WebSocket message, got {message!r}")
        return json.loads(str(message["text"]))

    async def receive_bytes(self) -> bytes:
        message = await self.receive_message()
        if message["type"] != "websocket.send" or "bytes" not in message:
            raise AssertionError(f"expected a binary WebSocket message, got {message!r}")
        return bytes(message["bytes"])

    async def receive_close(self) -> int:
        if self.close_code is not None:
            return self.close_code
        message = await self.receive_message()
        if message["type"] != "websocket.close":
            raise AssertionError(f"expected WebSocket close, got {message!r}")
        assert self.close_code is not None
        return self.close_code

    async def disconnect(self, *, code: int = 1000) -> None:
        if self._task is None:
            return
        if not self._task.done():
            await self._incoming.put({"type": "websocket.disconnect", "code": code})
        await asyncio.wait_for(self._task, timeout=2)


@asynccontextmanager
async def websocket_session(
    app,
    path: str,
    *,
    origin: str | None = "http://testserver",
    host: str = "testserver",
    scheme: str = "http",
) -> AsyncIterator[AsgiWebSocketSession]:
    session = AsgiWebSocketSession(
        app,
        path,
        origin=origin,
        host=host,
        scheme=scheme,
    )
    await session.connect()
    try:
        yield session
    finally:
        await session.disconnect()
