"""Production perimeter that keeps the explicit authentication entrypoints public."""

from __future__ import annotations

from collections.abc import Mapping
import hashlib
import hmac

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
from starlette.datastructures import QueryParams
from starlette.responses import Response
from starlette.routing import Match

from music_app.services.current_actor_asgi import current_actor_from_request
from music_app.services.policy_asgi import require_action
from music_app.services.policy import ResourceScope
from music_app.services.auth_session_csrf import issue_session_csrf, matches_session_csrf


_PUBLIC_AUTH_PATHS = frozenset(
    {"/login", "/forgot-password", "/reset-password", "/accept-invitation"}
)
_READ_METHODS = frozenset({"GET", "HEAD"})
_SESSION_COOKIE = "__Host-album_haven_session"
_SESSION_CSRF_COOKIE = "__Host-album_haven_csrf"
_SESSION_CSRF_HEADER = "x-album-haven-csrf"
def _foobar_response_protocol(path):
    if path=='/integrations/foobar/account/temporary-source/status':
        return 'foobar_temporary_source_v1'
    if path=='/integrations/foobar/account/maintenance':
        return 'foobar_account_maintenance_v1'
    if path=='/integrations/foobar/account/history/native/evidence':
        return 'foobar_account_track_evidence_v1'
    if path=='/integrations/foobar/account/enhanced/review':
        return 'foobar_enhanced_review_v1'
    if path=='/integrations/foobar/account/history/enhanced':
        return 'foobar_account_enhanced_history_v1'
    if path.startswith('/integrations/foobar/account/history/native/'):
        return 'foobar_account_history_native_v1'
    if path.startswith('/integrations/foobar/account/history/'):
        return 'foobar_account_history_v1'
    if path=='/integrations/foobar/account/job/list':
        return 'foobar_account_job_list_v1'
    if path.startswith('/integrations/foobar/account/review/'):
        return 'foobar_account_review_v4'
    if path.startswith('/integrations/foobar/account/job/'):
        return 'foobar_account_job_v3'
    return 'foobar_account_import_v4'


_FOOBAR_ACCOUNT_PATHS = frozenset({
    "/integrations/foobar/account/temporary-source/status",
    "/integrations/foobar/account/enhanced/review",
    "/integrations/foobar/account/history/enhanced",
    "/integrations/foobar/account/history/sources",
    "/integrations/foobar/account/history/list",
    "/integrations/foobar/account/job/list",
    "/integrations/foobar/account/ui/source",
    "/integrations/foobar/account/review/start", "/integrations/foobar/account/review/status",
    "/integrations/foobar/account/review/cancel",
    "/integrations/foobar/account/review/personal-changes",
    "/integrations/foobar/account/source", "/integrations/foobar/account/prepare",
    "/integrations/foobar/account/apply", "/integrations/foobar/account/status",
    "/integrations/foobar/account/job/start", "/integrations/foobar/account/job/resume",
    "/integrations/foobar/account/job/status", "/integrations/foobar/account/job/cancel",
    "/integrations/foobar/account/match-preview", "/integrations/foobar/account/match-apply",
})
_FOOBAR_NATIVE_PATHS = frozenset({
    "/integrations/foobar/account/maintenance",
    "/integrations/foobar/account/history/native/evidence",
    "/integrations/foobar/account/history/native/eligibility",
    "/integrations/foobar/account/history/native/play",
})
_FOOBAR_ERROR_PATHS = _FOOBAR_ACCOUNT_PATHS | _FOOBAR_NATIVE_PATHS
_LASTFM_HISTORY_PATHS = frozenset({"/home/activity/lastfm/import", "/home/activity/lastfm/combined"})
_PRIVATE_ROUTE_ACTIONS = {
    ("POST", "/integrations/foobar/account/temporary-source/status"): "account.self.foobar.write",
    ("POST", "/api/library/duplicate-folders/choices"): "library.inventory.manage",
    ("POST", "/api/library/duplicate-folders/preview"): "library.inventory.manage",
    ("POST", "/api/library/duplicate-folders/trash"): "library.inventory.manage",
    ("POST", "/api/library/duplicate-folders/reconcile"): "library.inventory.manage",
    ("POST", "/api/library/duplicate-folders/restore"): "library.inventory.manage",

    ("POST", "/integrations/foobar/account/maintenance"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/history/native/evidence"): "library.browse.read",
    ("POST", "/integrations/foobar/account/enhanced/review"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/history/native/eligibility"): "library.browse.read",
    ("POST", "/integrations/foobar/account/history/native/play"): "library.browse.read",
    ("GET", "/account/foobar-history"): "account.self.foobar.read",
    ("POST", "/integrations/foobar/account/history/sources"): "account.self.foobar.read",
    ("POST", "/integrations/foobar/account/history/list"): "account.self.foobar.read",
    ("POST", "/integrations/foobar/account/history/enhanced"): "account.self.foobar.read",
    ("GET", "/account/integrations/foobar"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/ui/source"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/review/start"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/review/status"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/review/cancel"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/review/personal-changes"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/job/start"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/job/list"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/job/resume"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/job/status"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/job/cancel"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/source"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/prepare"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/apply"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/status"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/match-preview"): "account.self.foobar.write",
    ("POST", "/integrations/foobar/account/match-apply"): "account.self.foobar.write",
    ("POST", "/home/activity/lastfm/import"): "account.self.lastfm.history.write",
    ("POST", "/home/activity/lastfm/combined"): "account.self.lastfm.history.read",
    ("POST", "/home/activity/scrobbles/retry"): "integration.lastfm.scrobbles.submit",
    ("GET", "/home/activity/now-playing"): "library.browse.read",
    ("POST", "/playback/session/presence-source"): "library.media.read",
    ("POST", "/playback/session/presence"): "library.browse.read",
    ("GET", "/friends"): "library.social.read",
    ("GET", "/friends/discover"): "library.social.read",
    ("GET", "/friends/notifications"): "library.social.read",
    ("POST", "/friends/notifications/{notification_id}/read"): "library.social.manage",
    ("GET", "/friends/{account_ref}"): "library.social.read",
    ("POST", "/friends/requests"): "library.social.manage",
    ("POST", "/friends/{account_ref}/{action}"): "library.social.manage",
    ("GET", "/friends/{account_ref}/taste"): "library.social.taste.read",
    ("GET", "/admin/friends-policy"): "accounts.read",
    ("PUT", "/admin/friends-policy"): "accounts.capabilities.manage",
    ("WEBSOCKET", "/playback/pcm"): "library.media.read",
    ("POST", "/logout"): "auth.session.logout",
    ("POST", "/admin/accounts"): "accounts.create",
    ("GET", "/admin/members"): "accounts.read",
    ("GET", "/admin/accounts/new"): "accounts.create",
    ("GET", "/admin/accounts/{account_id}"): "accounts.read",
    ("PATCH", "/admin/accounts/{account_id}"): "accounts.manage",
    ("POST", "/admin/accounts/{account_id}/sessions/revoke"): "accounts.sessions.revoke",
    ("POST", "/admin/accounts/{account_id}/welcome"): "accounts.welcome.send",
    ("POST", "/admin/accounts/{account_id}/password-reset"): "accounts.password_reset.send",
    ("POST", "/admin/accounts/{account_id}/invitation/copy"): "accounts.invitation.copy",
    ("POST", "/admin/accounts/{account_id}/invitation/send"): "accounts.invitation.send",
    ("POST", "/admin/reauthenticate"): "accounts.reauthenticate",
    ("GET", "/account"): "account.self.read",
    ("GET", "/account/playlist-preferences"): "account.self.playlist_preferences.read",
    ("PUT", "/account/playlist-preferences"): "account.self.playlist_preferences.write",
    ("GET", "/account/playlist-preferences/operations/{request_key}"): "account.self.playlist_preferences.read",
    ("GET", "/account/appearance"): "account.self.appearance.read",
    ("GET", "/account/layout-preferences"): "account.self.appearance.read",
    ("PUT", "/account/layout-preferences"): "account.self.appearance.write",
    ("PUT", "/account/appearance"): "account.self.appearance.write",
    ("GET", "/api/account/appearance/selection-accent"): "account.self.appearance.selection_accent.read",
    ("PUT", "/api/account/appearance/selection-accent"): "account.self.appearance.selection_accent.update",
    ("POST", "/account/password"): "account.self.password.change",
    ("POST", "/account/password-suggestion/dismiss"): "account.self.password_suggestion.dismiss",
    ("GET", "/"): "app.shell.read",
    ("GET", "/news"): "app.shell.read",
    ("GET", "/bootstrap-data"): "app.bootstrap.read",
    ("GET", "/status"): "app.status.read",
    ("POST", "/account/library-warning/dismiss"): "account.self.library_warning.dismiss",
    ("GET", "/view-data"): "library.browse.read",
    ("GET", "/home-data"): "library.browse.read",
    ("GET", "/home/activity"): "library.browse.read",
    ("POST", "/playlists/{playlist_ref}/native-queue"): "library.browse.read",
    ("GET", "/library/album-artwork/{album_ref}"): "library.artwork.read",
    ("POST", "/home/activity/native-target"): "library.browse.read",
    ("GET", "/playlists/{playlist_ref}/items/{item_ref}/native-target"): "library.browse.read",
    ("GET", "/friends/{account_ref}/activity"): "library.social.history.read",
    ("GET", "/friends/{account_ref}/comparison"): "library.social.history.read",
    ("GET", "/home/recent-albums"): "library.browse.read",
    ("GET", "/album-details"): "library.browse.read",
    ("GET", "/utilities/problematic-files"): "library.problems.read",
    ("GET", "/utilities/problematic-files/detail"): "library.problems.read",
    ("GET", "/utilities/problematic-files/{album_key:path}"): "library.problems.read",
    ("GET", "/utilities/rules"): "library.rules.read",
    ("GET", "/utilities/log-history"): "library.logs.read",
    ("POST", "/utilities/log-history/export"): "library.logs.export",
    ("GET", "/utilities/loops"): "library.loops.read",
    ("GET", "/utilities/integrations"): "integration.settings.read",
    ("GET", "/utilities/integrations/lastfm/scrobbles"): "integration.settings.read",
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
    ("GET", "/cover"): "library.artwork.read",
    ("GET", "/loops/media/{loop_id}"): "library.loops.media.read",
    ("GET", "/loops/pitch-preview/{preview_id}"): "library.loops.media.read",
    ("GET", "/utilities/cover-lookup/remote-image"): "library.covers.remote.read",
    ("GET", "/playback/waveform"): "library.media.read",
    ("POST", "/refresh-api"): "library.refresh",
    (
        "POST",
        "/api/library/albums/{album_key:path}/confirm-removal",
    ): "library.inventory.manage",
    ("POST", "/cancel-refresh-api"): "library.refresh.cancel",
    ("GET", "/refresh"): "library.refresh.read",
    ("GET", "/library-settings"): "library.settings.read",
    ("GET", "/library-settings/browse"): "library.filesystem.browse",
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
    ("POST", "/utilities/cover-lookup/local-delete"): "library.covers.delete",
    ("POST", "/utilities/cover-lookup/pasted-image-save"): "library.covers.upload",
    ("POST", "/utilities/cover-lookup/save-remote"): "library.covers.write",
    ("POST", "/utilities/cover-lookup/add-remote"): "library.covers.link",
    ("POST", "/utilities/fetch-cover"): "library.covers.fetch",
    ("POST", "/utilities/fetch-covers-unsuccessful"): "library.covers.fetch",
    ("POST", "/utilities/cancel-cover-scan"): "library.covers.fetch.cancel",
    ("POST", "/utilities/imports/local-playlists/analyze"): "integration.local_playlists.analyze",
    ("POST", "/utilities/imports/local-playlists/import"): "integration.local_playlists.import",
    ("POST", "/utilities/integrations/lastfm"): "integration.lastfm.manage",
    ("POST", "/utilities/integrations/lastfm/scrobbles/submit"): "integration.lastfm.scrobbles.submit",
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
    ("GET", "/playlists/destinations"): "library.browse.read",
    ("GET", "/playlists/creation-source/current"): "library.playlists.create",
    ("POST", "/playlists/creation-source/queue"): "library.browse.read",
    ("POST", "/playlists/creation-source/selection"): "library.playlists.create",
    ("POST", "/playlists/creation-source/match-candidates"): "library.playlists.create",
    ("POST", "/playlists/creation-source/accept-match"): "library.playlists.create",
    ("POST", "/playlists/creation-source/activity"): "library.playlists.create",
    ("GET", "/playlists/{playlist_ref}/missing-source"): "library.playlists.create",
    ("GET", "/playlists/creation-source/complete"): "library.playlists.create",
    ("GET", "/playlists/creation-source/entries"): "library.playlists.create",
    ("GET", "/playlists/operations/{request_key}"): "library.browse.read",
    ("POST", "/playlists/{playlist_ref}/items/remove"): "library.playlists.items.manage",
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
    ("GET", "/playlists/{playlist_ref}/access-grants"): "library.playlists.access.manage",
    ("GET", "/playlists/{playlist_ref}/access-candidates"): "library.playlists.access.manage",
    ("PATCH", "/playlists/{playlist_ref}/visibility"): "library.playlists.access.manage",
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
        try:
            return await _require_private_authentication(request, call_next)
        except Exception:
            if request.method == "POST" and request.url.path in _FOOBAR_ERROR_PATHS:
                return JSONResponse({"protocol": _foobar_response_protocol(request.url.path), "error": "unavailable"},
                    status_code=503, headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})
            if request.method == "POST" and request.url.path in _LASTFM_HISTORY_PATHS:
                return JSONResponse({"error": "lastfm_history_unavailable", "refresh_required": True},
                    status_code=503, headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})
            if request.method == "POST" and request.url.path == "/home/activity/scrobbles/retry":
                return JSONResponse({"error": "scrobble_outcome_unconfirmed", "refresh_required": True},
                    status_code=503, headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})
            raise

    async def _require_private_authentication(request: Request, call_next):
        _redact_lifecycle_link_query(request)
        if _is_public(request.method, request.url.path):
            return await call_next(request)
        route_path = _matched_route_path(app, request)
        action = private_action_for_route(request.method, route_path) or "app.access"
        if (request.method == "GET" and route_path == "/playback/waveform"
                and str(request.query_params.get("loop_id") or "").strip()):
            # The route resolves this resource through the actor's owned loops.
            action = "library.loops.media.read"
        preference_headers = (
            {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}
            if route_path in _FOOBAR_ERROR_PATHS else
            {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}
            if route_path == "/home/activity/scrobbles/retry" or route_path in _LASTFM_HISTORY_PATHS else
            {"Cache-Control": "private, no-store"}
            if route_path in {"/home/activity/now-playing", "/playback/session/presence-source", "/playback/session/presence", "/album-details", "/track-preferences", "/home/activity", "/home/activity/native-target", "/library/album-artwork/{album_ref}", "/playlists/{playlist_ref}/native-queue", "/playlists/{playlist_ref}/items/{item_ref}/native-target", "/admin/friends-policy", "/playlists/creation-source/match-candidates", "/playlists/creation-source/accept-match"} or route_path.startswith("/friends") else
            {"Cache-Control": "no-store, max-age=0"}
            if route_path in {"/account/appearance", "/account/layout-preferences", "/api/account/appearance/selection-accent"} else {}
        )
        await current_actor_from_request(request)
        resource = _private_resource(request, route_path)
        try:
            await require_action(action, resource=resource)(request)
            if route_path == '/utilities/log-history/export':
                await require_action('library.logs.read', resource=resource)(request)
            if route_path == "/cover":
                if request.query_params.get("loop_id"):
                    await require_action("library.loops.read", resource=resource)(request)
                from music_app.services.capability_artwork import browse_artwork_response

                artwork = await browse_artwork_response(request)
                if artwork is not None:
                    _refresh_session_csrf_cookie(request, artwork)
                    return artwork
        except HTTPException as exc:
            if request.method == "POST" and route_path in _FOOBAR_ERROR_PATHS:
                return JSONResponse({"protocol": _foobar_response_protocol(request.url.path),
                    "error": "authentication_required" if exc.status_code == 401 else "forbidden"},
                    status_code=exc.status_code, headers=preference_headers)
            if (
                exc.status_code == 401
                and request.method.upper() in _READ_METHODS
                and request.url.path == "/"
            ):
                return RedirectResponse("/login", status_code=303)
            if (
                exc.status_code == 403
                and request.method == "GET"
                and route_path in {"/admin/members", "/admin/accounts/new", "/admin/accounts/{account_id}"}
                and request.headers.get("sec-fetch-dest") == "document"
            ):
                # A denied browser page must remain readable. Fetch/API clients
                # retain the JSON error contract, and no admin handler is entered.
                return PlainTextResponse(
                    "Action not permitted.", status_code=403,
                    headers={**(exc.headers or {}), "Cache-Control": "no-store, max-age=0"},
                )
            return JSONResponse(
                {"detail": exc.detail},
                status_code=exc.status_code,
                headers={**(exc.headers or {}), **preference_headers},
            )
        csrf_mode = csrf_mode_for_route(request.method, route_path)
        if csrf_mode == "session_header" and not _valid_session_csrf(request):
            if request.method == "POST" and route_path in _FOOBAR_ERROR_PATHS:
                return JSONResponse({"protocol": _foobar_response_protocol(request.url.path), "error": "forbidden"},
                    status_code=403, headers=preference_headers)
            return JSONResponse(
                {"detail": "CSRF validation failed."},
                status_code=403,
                headers=preference_headers,
            )
        response = await call_next(request)
        if route_path in _FOOBAR_ERROR_PATHS:
            response.headers.update(preference_headers)
        if route_path == "/home/activity/scrobbles/retry" or route_path in _LASTFM_HISTORY_PATHS:
            response.headers.update(preference_headers)
        if route_path in {"/home/activity/now-playing", "/playback/session/presence-source", "/playback/session/presence", "/album-details", "/track-preferences", "/home/activity", "/home/activity/native-target", "/library/album-artwork/{album_ref}", "/playlists/{playlist_ref}/native-queue", "/playlists/{playlist_ref}/items/{item_ref}/native-target", "/admin/friends-policy", "/playlists/creation-source/match-candidates", "/playlists/creation-source/accept-match"} or route_path.startswith("/friends"):
            response.headers.update(preference_headers)
        if request.method.upper() in _READ_METHODS:
            _refresh_session_csrf_cookie(request, response)
        return response


def _refresh_session_csrf_cookie(request: Request, response: Response) -> None:
    raw_session = request.cookies.get(_SESSION_COOKIE)
    try:
        current = issue_session_csrf(
            raw_session,
            getattr(request.app.state, "auth_policy_config", {}),
        )
    except (TypeError, ValueError):
        return
    if request.cookies.get(_SESSION_CSRF_COOKIE) == current:
        return
    response.set_cookie(
        _SESSION_CSRF_COOKIE,
        current,
        httponly=False,
        secure=True,
        samesite="lax",
        path="/",
    )


def _redact_lifecycle_link_query(request: Request) -> None:
    prefixes = {
        "/reset-password": "password_reset_link",
        "/accept-invitation": "account_invitation_link",
    }
    scope = request.scope
    prefix = prefixes.get(scope.get("path"))
    if prefix is None:
        return
    raw_query = scope.get("query_string", b"")
    if not raw_query:
        return
    if str(scope.get("method") or "").upper() == "GET":
        query_params = QueryParams(raw_query.decode("latin-1"))
        pairs = list(query_params.multi_items())
        if prefix == "password_reset_link":
            request.state.password_reset_link_invalid_marker = pairs == [("invalid", "1")]
        setattr(
            request.state,
            f"{prefix}_query_valid",
            (
                len(pairs) == 2
                and sum(key == "purpose" for key, _value in pairs) == 1
                and sum(key == "token" for key, _value in pairs) == 1
            ),
        )
        setattr(request.state, f"{prefix}_purpose", query_params.get("purpose"))
        setattr(request.state, f"{prefix}_token", query_params.get("token"))
    scope["query_string"] = b""
    request.__dict__.pop("_url", None)
    request.__dict__.pop("_query_params", None)


def _is_public(method: str, path: str) -> bool:
    normalized_method = method.upper()
    if path == "/accept-invitation/continue":
        return normalized_method in {"GET", "HEAD"}
    if path in _PUBLIC_AUTH_PATHS:
        return normalized_method in {"GET", "HEAD", "POST"}
    if path in {"/health", "/favicon.ico"}:
        return normalized_method in _READ_METHODS
    if path == "/static" or path.startswith("/static/"):
        return normalized_method in _READ_METHODS
    return False


def private_action_for_route(method: str, route_path: str) -> str | None:
    return _PRIVATE_ROUTE_ACTIONS.get((str(method).upper(), str(route_path)))


def csrf_mode_for_route(method: str, route_path: str) -> str:
    normalized_method = str(method).upper()
    if normalized_method in _READ_METHODS or normalized_method in {"OPTIONS", "WEBSOCKET"}:
        return "none"
    if normalized_method == "POST" and route_path in {
        "/logout",
        "/account/password",
        "/account/password-suggestion/dismiss",
    }:
        return "route_form"
    return "session_header"


def _matched_route_path(app: FastAPI, request: Request) -> str:
    for route in app.routes:
        match, _child_scope = route.matches(request.scope)
        if match is Match.FULL:
            return str(getattr(route, "path", request.url.path))
    return request.url.path


def _private_resource(request: Request, route_path: str) -> ResourceScope | None:
    if route_path in {"/track", "/cover", "/playback/waveform"}:
        loop_id = str(request.query_params.get("loop_id") or "").strip()
        if loop_id:
            return ResourceScope("loop", _safe_reference(loop_id, request))
        private_path = str(request.query_params.get("path") or "").strip()
        if private_path:
            return ResourceScope("media", _privacy_reference(private_path, request))
    if route_path == "/loops/media/{loop_id}":
        return ResourceScope(
            "loop", _safe_reference(request.url.path.rsplit("/", 1)[-1], request)
        )
    if route_path == "/loops/pitch-preview/{preview_id}":
        return ResourceScope(
            "loop_preview",
            _safe_reference(request.url.path.rsplit("/", 1)[-1], request),
        )
    if route_path == "/utilities/cover-lookup/remote-image":
        remote_ref = str(request.query_params.get("url") or "").strip()
        if remote_ref:
            return ResourceScope("cover_candidate", _privacy_reference(remote_ref, request))
    return None


def _safe_reference(value: str, request: Request) -> str:
    try:
        return ResourceScope("loop", value).resource_ref
    except ValueError:
        return _privacy_reference(value, request)


def _privacy_reference(value: str, request: Request) -> str:
    config = getattr(request.app.state, "auth_policy_config", {})
    hmac_config = config.get("hmac") if isinstance(config, Mapping) else None
    secret = hmac_config.get("secret") if isinstance(hmac_config, Mapping) else None
    version = hmac_config.get("key_version") if isinstance(hmac_config, Mapping) else None
    if not isinstance(secret, str) or len(secret.encode("utf-8")) < 32:
        raise RuntimeError("Policy resource-key configuration is invalid.")
    digest = hmac.new(
        secret.encode("utf-8"),
        f"policy-resource\0{value}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"hmac:v{int(version or 1)}:{digest}"


def _valid_session_csrf(request: Request) -> bool:
    if not _same_origin(request):
        return False
    cookie_value = request.cookies.get(_SESSION_CSRF_COOKIE)
    header_value = request.headers.get(_SESSION_CSRF_HEADER)
    if not isinstance(cookie_value, str) or not isinstance(header_value, str):
        return False
    try:
        if not hmac.compare_digest(cookie_value, header_value):
            return False
    except TypeError:
        return False
    return matches_session_csrf(
        request.cookies.get(_SESSION_COOKIE),
        header_value,
        getattr(request.app.state, "auth_policy_config", {}),
    )


def _same_origin(request: Request) -> bool:
    supplied = request.headers.get("origin")
    if not supplied:
        referer = request.headers.get("referer")
        if not referer:
            return False
        supplied = referer.split("/", 3)[:3]
        supplied = "/".join(supplied)
    expected = f"{request.url.scheme}://{request.url.netloc}"
    config = getattr(request.app.state, "auth_policy_config", {})
    trusted = config.get("trusted_origins") if isinstance(config, Mapping) else None
    allowed = {expected}
    if isinstance(trusted, (tuple, list)):
        allowed.update(str(item) for item in trusted)
    return supplied in allowed
