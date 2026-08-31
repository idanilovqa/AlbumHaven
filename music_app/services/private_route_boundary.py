"""Production perimeter that keeps the explicit authentication entrypoints public."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.routing import Match

from music_app.services.policy_asgi import require_action


_PUBLIC_AUTH_PATHS = frozenset({"/login", "/forgot-password", "/reset-password"})
_READ_METHODS = frozenset({"GET", "HEAD"})
_PRIVATE_ROUTE_ACTIONS = {
    ("POST", "/logout"): "auth.session.logout",
    ("GET", "/"): "app.shell.read",
    ("GET", "/news"): "app.shell.read",
    ("GET", "/bootstrap-data"): "app.bootstrap.read",
    ("GET", "/status"): "app.status.read",
    ("GET", "/view-data"): "library.browse.read",
    ("GET", "/home-data"): "library.browse.read",
    ("GET", "/album-details"): "library.browse.read",
    ("GET", "/utilities/problematic-files"): "library.problems.read",
    ("GET", "/utilities/problematic-files/detail"): "library.problems.read",
    ("GET", "/utilities/problematic-files/{album_key:path}"): "library.problems.read",
    ("GET", "/utilities/rules"): "library.rules.read",
    ("GET", "/utilities/log-history"): "library.logs.read",
    ("GET", "/utilities/loops"): "library.loops.read",
    ("GET", "/utilities/integrations"): "integration.settings.read",
    ("GET", "/utilities/integrations/foobar/help"): "integration.foobar.read",
    ("GET", "/utilities/integrations/foobar/assets/{asset_key}"): "integration.foobar.read",
    ("GET", "/album-opinions/{album_ref}/crowd"): "library.opinions.read",
    ("GET", "/people/{person_ref}"): "library.resources.read",
    ("GET", "/works/{work_ref}"): "library.resources.read",
    ("GET", "/soundtracks/{soundtrack_ref}"): "library.resources.read",
    ("GET", "/companies/{company_ref}"): "library.resources.read",
    ("GET", "/news-center/summary"): "library.discovery.read",
    ("GET", "/news-center/entries"): "library.discovery.read",
    ("GET", "/news-center/insights"): "library.discovery.read",
    ("GET", "/news-center/preferences"): "library.discovery.read",
    ("GET", "/discovery-lookups/recent"): "library.discovery.read",
    ("GET", "/discovery-lookups/{lookup_ref}"): "library.discovery.read",
    ("GET", "/virtual-artists/search"): "library.virtual_discography.read",
    ("GET", "/virtual-artists/recent"): "library.virtual_discography.read",
    ("GET", "/virtual-artists/{virtual_artist_ref}"): "library.virtual_discography.read",
    ("GET", "/virtual-releases/{virtual_release_ref}"): "library.virtual_discography.read",
    ("GET", "/track"): "library.media.read",
    ("GET", "/cover"): "library.media.read",
    ("GET", "/loops/media/{loop_id}"): "library.loops.media.read",
    ("GET", "/loops/pitch-preview/{preview_id}"): "library.loops.media.read",
    ("GET", "/utilities/cover-lookup/remote-image"): "library.covers.remote.read",
    ("GET", "/playback/waveform"): "library.media.read",
    ("POST", "/refresh-api"): "library.refresh",
    ("POST", "/cancel-refresh-api"): "library.refresh.cancel",
    ("GET", "/refresh"): "library.refresh.read",
    ("GET", "/library-settings"): "library.settings.read",
    ("POST", "/library-settings"): "library.settings.manage",
    ("POST", "/library-settings/import-album-ratings"): "library.ratings.import",
    ("POST", "/utilities/rules/version-exceptions/revert"): "library.rules.manage",
    ("POST", "/utilities/rules/problem-ignores/revert"): "library.rules.manage",
    ("POST", "/utilities/rules/problem-ignores"): "library.rules.manage",
    ("POST", "/versions/ignore"): "library.versions.manage",
    ("POST", "/versions/mark"): "library.versions.manage",
    ("POST", "/versions/unmark"): "library.versions.manage",
    ("POST", "/utilities/move-album"): "library.files.move",
    ("GET", "/utilities/save-task/{task_id}"): "library.tasks.read",
    ("POST", "/open-album-location"): "library.files.open_location",
    ("POST", "/utilities/repair-album"): "library.files.repair",
    ("POST", "/utilities/edit-tags"): "library.files.edit_tags",
    ("GET", "/utilities/cover-lookup/tasks"): "library.covers.tasks.read",
    ("POST", "/utilities/cover-lookup/tasks/clear-completed"): "library.covers.tasks.manage",
    ("POST", "/utilities/cover-lookup/task/{task_id}/clear"): "library.covers.tasks.manage",
    ("POST", "/utilities/cover-lookup/task/{task_id}/mark-action-taken"): "library.covers.tasks.manage",
    ("POST", "/utilities/cover-lookup/gallery"): "library.covers.lookup",
    ("POST", "/utilities/cover-lookup/gallery/mark-seen"): "library.covers.tasks.manage",
    ("POST", "/utilities/cover-lookup/start"): "library.covers.lookup",
    ("POST", "/utilities/cover-lookup/task/{task_id}/cancel"): "library.covers.lookup.cancel",
    ("POST", "/utilities/cover-lookup/local-select"): "library.covers.write",
    ("POST", "/utilities/cover-lookup/local-delete"): "library.covers.write",
    ("POST", "/utilities/cover-lookup/pasted-image-save"): "library.covers.write",
    ("POST", "/utilities/cover-lookup/save-remote"): "library.covers.write",
    ("POST", "/utilities/cover-lookup/add-remote"): "library.covers.write",
    ("POST", "/utilities/fetch-cover"): "library.covers.fetch",
    ("POST", "/utilities/fetch-covers-unsuccessful"): "library.covers.fetch",
    ("POST", "/utilities/cancel-cover-scan"): "library.covers.fetch.cancel",
    ("POST", "/utilities/imports/local-playlists/analyze"): "integration.local_playlists.analyze",
    ("POST", "/utilities/imports/local-playlists/import"): "integration.local_playlists.import",
    ("POST", "/utilities/integrations/lastfm"): "integration.lastfm.manage",
    ("POST", "/playback/session/now-playing"): "integration.lastfm.now_playing",
    ("POST", "/playback/session/scrobble"): "integration.lastfm.scrobble",
    ("POST", "/playback/session/complete"): "integration.lastfm.complete",
    ("POST", "/loops/create"): "library.loops.create",
    ("POST", "/loops/pitch-preview"): "library.loops.preview",
    ("POST", "/loops/delete"): "library.loops.delete",
    ("POST", "/loops/reorder"): "library.loops.reorder",
    ("POST", "/album-notes"): "library.notes.manage",
    ("PATCH", "/album-notes/{note_ref}"): "library.notes.manage",
    ("DELETE", "/album-notes/{note_ref}"): "library.notes.manage",
    ("POST", "/album-note-replies"): "library.notes.manage",
    ("PATCH", "/album-note-replies/{reply_ref}"): "library.notes.manage",
    ("DELETE", "/album-note-replies/{reply_ref}"): "library.notes.manage",
    ("POST", "/news-center/preferences"): "library.discovery.preferences.manage",
    ("POST", "/discovery-lookups"): "library.discovery.lookup",
    ("POST", "/virtual-artists"): "library.virtual_discography.create",
    ("POST", "/playlists"): "library.playlists.create",
    ("POST", "/playlists/derived-popular-tracks"): "library.playlists.create",
    ("PATCH", "/playlists/{playlist_ref}"): "library.playlists.manage",
    ("DELETE", "/playlists/{playlist_ref}"): "library.playlists.manage",
    ("POST", "/playlists/{playlist_ref}/items"): "library.playlists.items.manage",
    ("PATCH", "/playlists/{playlist_ref}/items/{playlist_item_ref}"): "library.playlists.items.manage",
    ("DELETE", "/playlists/{playlist_ref}/items/{playlist_item_ref}"): "library.playlists.items.manage",
    ("POST", "/playlists/{playlist_ref}/items/reorder"): "library.playlists.items.manage",
    ("PUT", "/playlists/{playlist_ref}/cover"): "library.playlists.cover.manage",
    ("DELETE", "/playlists/{playlist_ref}/cover"): "library.playlists.cover.manage",
    ("POST", "/playlists/{playlist_ref}/access-grants"): "library.playlists.access.manage",
    ("PATCH", "/playlists/{playlist_ref}/access-grants/{grant_ref}"): "library.playlists.access.manage",
    ("DELETE", "/playlists/{playlist_ref}/access-grants/{grant_ref}"): "library.playlists.access.manage",
    ("POST", "/playlists/{playlist_ref}/regenerate-derived-items"): "library.playlists.manage",
    ("POST", "/playlists/{playlist_ref}/default-sort"): "library.playlists.settings.manage",
    ("POST", "/playlists/{playlist_ref}/playback-settings"): "library.playlists.settings.manage",
    ("POST", "/track-preferences"): "library.track_preferences.manage",
}


def install_private_route_boundary(app: FastAPI) -> None:
    """Install the public health endpoint and default-private request boundary."""

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.middleware("http")
    async def require_private_authentication(request: Request, call_next):
        if _is_public(request.method, request.url.path):
            return await call_next(request)
        route_path = _matched_route_path(app, request)
        action = private_action_for_route(request.method, route_path) or "app.access"
        try:
            await require_action(action)(request)
        except HTTPException as exc:
            return JSONResponse(
                {"detail": exc.detail},
                status_code=exc.status_code,
                headers=exc.headers,
            )
        return await call_next(request)


def _is_public(method: str, path: str) -> bool:
    normalized_method = method.upper()
    if path in _PUBLIC_AUTH_PATHS:
        return normalized_method in {"GET", "HEAD", "POST"}
    if path in {"/health", "/favicon.ico"}:
        return normalized_method in _READ_METHODS
    if path == "/static" or path.startswith("/static/"):
        return normalized_method in _READ_METHODS
    return False


def private_action_for_route(method: str, route_path: str) -> str | None:
    return _PRIVATE_ROUTE_ACTIONS.get((str(method).upper(), str(route_path)))


def _matched_route_path(app: FastAPI, request: Request) -> str:
    for route in app.routes:
        match, _child_scope = route.matches(request.scope)
        if match is Match.FULL:
            return str(getattr(route, "path", request.url.path))
    return request.url.path
