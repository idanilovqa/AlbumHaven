"""Bounded saved-cover presentation, with source access only at image load time."""
from __future__ import annotations

from urllib.parse import urlencode

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response

from music_app.services.ordered_cover_references import project_selected_cover_metadata
from music_app.services.policy import ResourceScope
from music_app.services.policy_asgi import allowed_actions_for_request, require_action


def _concrete_id(value: object) -> bool:
    return type(value) is int and 0 < value < 2**63


def project_ordered_covers_for_browse(
    metadata: object, *, album_id: object, library_id: object,
) -> dict[str, object]:
    """Project already-loaded metadata without resolving sources or permissions."""
    if not _concrete_id(album_id) or not _concrete_id(library_id):
        return {"selected_covers_loaded": False}
    try:
        selection = project_selected_cover_metadata(metadata)
    except ValueError:
        return {"selected_covers_loaded": False}
    return {
        "selected_covers": [
            {"selection_id": item["selection_id"], "kind": item["kind"]}
            for item in selection.get("selected_covers", [])
        ],
        "selected_covers_revision": selection.get("selected_covers_revision", 0),
        "selected_covers_library_id": library_id,
        "selected_covers_album_id": album_id,
        "selected_covers_loaded": True,
    }


def project_ordered_covers_for_request(request, payload: object) -> object:
    """Copy affected branches so shared browse caches never hold actor decisions.

    URLs contain only saved identities. Image requests independently reauthorize
    and resolve the current source; a URL is not a bearer grant or an image hash.
    """
    actions = allowed_actions_for_request(
        request, ("library.artwork.read", "library.covers.remote.read"),
    ).as_payload()
    library_id = request.state.current_actor.current_library_id

    def visit(value: object) -> object:
        if isinstance(value, list):
            nested = [visit(item) for item in value]
            return nested if any(a is not b for a, b in zip(nested, value)) else value
        if not isinstance(value, dict):
            return value
        copied = {key: visit(item) for key, item in value.items()}
        changed = any(copied[key] is not item for key, item in value.items())
        if value.get("selected_covers_loaded") is True:
            album_id = value.get("selected_covers_album_id")
            same_scope = (
                _concrete_id(library_id)
                and value.get("selected_covers_library_id") == library_id
                and _concrete_id(album_id) and value.get("album_id") == album_id
            )
            slots = []
            for item in value.get("selected_covers", []):
                slot = {"selection_id": item["selection_id"], "kind": item["kind"]}
                if (same_scope and actions.get("library.artwork.read") is True
                        and (item["kind"] == "local" or actions.get("library.covers.remote.read") is True)):
                    slot["image_url"] = "/cover?" + urlencode({
                        "library_id": library_id, "album_id": album_id,
                        "selection_id": item["selection_id"],
                    })
                else:
                    slot["unavailable"] = True
                slots.append(slot)
            copied["selected_covers"] = slots
            changed = True
        elif "album_artist" in value and "key" in value:
            # Transient/older projections are not evidence of a legacy singleton.
            copied["selected_covers_loaded"] = False
            changed = True
        return copied if changed else value

    return visit(payload)


async def selected_cover_artwork_response(request) -> Response:
    """Serve one saved source through the existing artwork authority, never paths."""
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
    from music_app.routes.api_cover_helpers import serialize_ordered_cover_selection_for_read
    from music_app.services.capability_artwork import render_browse_artwork
    from music_app.services.covers import normalize_cover_variant_size
    from music_app.services.cover_lookup_runtime import fetch_remote_cover_bytes
    from pathlib import Path

    missing = HTTPException(status_code=404, detail="Artwork not found.")
    query = request.query_params
    keys = ("library_id", "album_id", "selection_id")
    if (any(len(query.getlist(key)) != 1 for key in keys)
            or any(key in query for key in ("path", "loop_id", "url"))):
        raise missing
    ids = []
    for key in keys[:2]:
        text = query[key]
        if len(text) > 19 or not text.isascii() or not text.isdecimal() or not _concrete_id(int(text)):
            raise missing
        ids.append(int(text))
    library_id, album_id = ids
    selection_id = query["selection_id"]
    if (not selection_id or len(selection_id) > 256
            or selection_id != selection_id.strip()
            or any(ord(char) < 32 or ord(char) == 127 for char in selection_id)):
        raise missing
    resource = ResourceScope("album", str(album_id))
    await require_action("library.artwork.read", resource=resource, refresh_actor=True)(request)
    if request.state.current_actor.current_library_id != library_id:
        raise missing
    config = request.app.state.config
    try:
        context = await run_in_threadpool(
            PostgresLibraryBrowseRepository(config).load_selected_cover_artwork,
            album_id=album_id, library_id=library_id,
        )
        if (not context or context.get("album_id") != album_id
                or context.get("library_id") != library_id):
            raise missing
        selection = project_selected_cover_metadata(context.get("metadata"))
    except HTTPException:
        raise
    except ValueError:
        raise missing from None
    except Exception:
        raise HTTPException(status_code=503, detail="Artwork is temporarily unavailable.") from None
    item = next((item for item in selection.get("selected_covers", [])
                 if item["selection_id"] == selection_id), None)
    if item is None:
        raise missing
    await require_action("library.artwork.read", library_id=library_id,
                         resource=resource, refresh_actor=True)(request)
    if request.state.current_actor.current_library_id != library_id:
        raise missing
    if item["kind"] == "remote":
        await require_action("library.covers.remote.read", library_id=library_id, resource=resource)(request)
        payload, mime_type = await run_in_threadpool(fetch_remote_cover_bytes, item["url"], config=config)
        if payload is None:
            raise HTTPException(status_code=502, detail="Failed to load remote image.")
        return Response(payload, media_type=mime_type, headers={
            "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        })
    if not context.get("track_paths"):
        raise missing
    references = await run_in_threadpool(
        serialize_ordered_cover_selection_for_read, config, set(context["track_paths"]),
        selection, remote_read=False,
    )
    local = next(reference for reference in references if reference["selection_id"] == selection_id)
    if not local.get("path") or local.get("unavailable"):
        raise missing
    return await run_in_threadpool(
        render_browse_artwork, Path(local["path"]),
        max_edge=normalize_cover_variant_size(query.get("size")) or 2048,
    )
