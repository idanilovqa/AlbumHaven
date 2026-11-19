"""Server-sent live library change events for the signed-in reader."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from music_app.services.current_actor_asgi import current_actor_from_request
from music_app.services.library_change_broker import stream_library_changes
from music_app.services.policy_asgi import require_action

LIBRARY_EVENTS_PATH = "/api/live/library-events"

router = APIRouter()


def _cursor(request: Request) -> int:
    """The reader's last revision; an absent or malformed cursor asks for a resync."""
    raw = request.headers.get("last-event-id") or request.query_params.get("since") or ""
    return int(raw) if raw.isdigit() else -1


@router.get(LIBRARY_EVENTS_PATH)
async def library_events(request: Request):
    broker = getattr(request.app.state, "library_change_broker", None)
    repository = getattr(request.app.state, "library_change_repository", None)
    if broker is None or repository is None or broker.head is None:
        return JSONResponse({"ok": False, "error": "Live updates are unavailable."}, status_code=503)
    actor = await current_actor_from_request(request)
    library_id, account_id = actor.current_library_id, actor.account_id

    async def read_page(cursor: int):
        return await run_in_threadpool(
            repository.read_since, library_id=library_id, account_id=account_id, since=cursor,
        )

    async def authorized() -> bool:
        try:
            await require_action("library.browse.read", refresh_actor=True)(request)
        except HTTPException:
            return False
        return True

    async def frames():
        with broker.subscribe() as wait_for_change:
            async for frame in stream_library_changes(
                since=_cursor(request),
                read_page=read_page,
                wait_for_change=wait_for_change,
                authorized=authorized,
                is_disconnected=request.is_disconnected,
                closing=lambda: broker.closing,
            ):
                yield frame

    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
