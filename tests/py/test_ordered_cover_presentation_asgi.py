"""Real ASGI policy and image rendering with synthetic persistence transports.

No policy/evaluator, source-scope, or image-rendering helpers are replaced.
These tests are not a database/session integration or browser acceptance gate.
"""
import asyncio
from copy import deepcopy
from io import BytesIO
import json
from types import SimpleNamespace
from urllib.parse import parse_qs, urlencode, urlsplit

from fastapi import FastAPI
from PIL import Image, PngImagePlugin
import pytest
from starlette.responses import Response

from music_app.routes import api_read_asgi_routes as read_routes, api_wave_d_asgi_routes as edit_routes
from music_app.services import cover_lookup_runtime
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
from music_app.services.private_route_boundary import install_private_route_boundary
from tests.py.cover_unit_safety import cover_unit_transports  # noqa: F401


def actor(*grants, library_id=23):
    return CurrentActor(state=ActorState.ACTIVE, account_id=7, session_id=11, username_display="viewer",
        current_library_id=library_id, library_relationships=(LibraryRelationship(library_id, "member", False),),
        capability_grants=tuple(CapabilityGrant(grant, "library", library_id) for grant in grants))


async def http_get(app, url):
    target = urlsplit(url)
    messages = []
    sent = False
    complete = asyncio.Event()
    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await complete.wait()
        return {"type": "http.disconnect"}
    async def send(message):
        messages.append(message)
        if message["type"] == "http.response.body" and not message.get("more_body", False):
            complete.set()
    await app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET",
        "scheme": "https", "path": target.path, "raw_path": target.path.encode(),
        "query_string": target.query.encode(), "headers": [(b"host", b"music.test"),
        (b"cookie", b"__Host-album_haven_session=synthetic")],
        "client": ("203.0.113.8", 50000), "server": ("music.test", 443)}, receive, send)
    start = next(item for item in messages if item["type"] == "http.response.start")
    body = b"".join(item.get("body", b"") for item in messages if item["type"] == "http.response.body")
    return start["status"], dict(start["headers"]), body


@pytest.fixture
def api(monkeypatch, tmp_path):
    root = tmp_path / "library"
    album = root / "release"
    album.mkdir(parents=True)
    track = album / "song.flac"
    track.write_bytes(b"synthetic-track")
    cover = album / "front.png"
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("private", "PRIVATE_IMAGE_METADATA")
    Image.new("RGB", (40, 30), "red").save(cover, pnginfo=metadata)
    with cover.open("ab") as stream:
        stream.write(b"PRIVATE_APPENDED_AUDIO")
    outside = root / "other-release" / "cover.png"
    outside.parent.mkdir()
    Image.new("RGB", (40, 30), "blue").save(outside)
    foreign = tmp_path / "unconfigured.png"
    Image.new("RGB", (40, 30), "green").save(foreign)
    calls = []
    state = SimpleNamespace(user=actor("capability.view"), after_read=None)
    class Resolver:
        def resolve(self, token):
            calls.append(("actor", token))
            return state.user
    context = {"album_id": 72, "library_id": 23, "album_key": "artist::release", "track_paths": [str(track)]}
    saved = {"selected_covers_revision": 7, "selected_covers": [
        {"selection_id": "front", "kind": "local", "path": str(cover)},
        {"selection_id": "remote", "kind": "remote", "url": "https://covers.example.test/PRIVATE_SOURCE.png",
         "source": "PRIVATE_PROVIDER", "candidate_id": "PRIVATE_CANDIDATE"}],
        "selected_covers_last_request": {"mutation_id": "93c9e45b-022e-4336-8e11-32f155591b74", "request_hash": "a" * 64}}
    def load_artwork(self, **kwargs):
        calls.append(("artwork", kwargs))
        if state.after_read is not None:
            state.user = state.after_read
        return {"album_id": context["album_id"], "library_id": context["library_id"],
                "metadata": deepcopy(saved), "track_paths": list(context["track_paths"])}
    monkeypatch.setattr(PostgresLibraryBrowseRepository, "load_selected_cover_artwork", load_artwork, raising=False)
    monkeypatch.setattr(PostgresLibraryRootSettingsStore, "load_settings",
                        lambda self, **kwargs: {"main_library_roots": [{"path": str(root)}]})
    def fetch(url, **kwargs):
        calls.append(("remote", url))
        return b"synthetic-remote-image", "image/png"
    monkeypatch.setattr(cover_lookup_runtime, "fetch_remote_cover_bytes", fetch)
    browse_album = {"album_id": 72, "key": "artist::release", "album_artist": "Artist", "name": "Release", "tracks": [],
        "selected_covers": [{"selection_id": "front", "kind": "local"}, {"selection_id": "remote", "kind": "remote"}],
        "selected_covers_revision": 7, "selected_covers_library_id": 23, "selected_covers_album_id": 72, "selected_covers_loaded": True}
    class BrowseRepository:
        def __init__(self, config):
            pass
        def build_album_detail_payload_by_id(self, album_id, **kwargs):
            calls.append(("detail", album_id))
            if state.after_read is not None:
                state.user = state.after_read
            return browse_album
    monkeypatch.setattr(read_routes, "PostgresLibraryBrowseRepository", BrowseRepository)
    app = FastAPI()
    app.state.current_actor_resolver = Resolver()
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted", "MUSICBRAINZ_USER_AGENT": "synthetic-tests",
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/selected_presentation_test",
        "PERSISTENCE_BACKENDS": {"library_browse": "postgres"}, "_library_root_paths_snapshot": (root,)}
    app.state.auth_policy_config = {"hmac": {"secret": "synthetic-policy-key-at-least-32-characters", "key_version": 1}}
    app.state.library_state = {}
    install_private_route_boundary(app)
    app.include_router(read_routes.router)
    app.include_router(edit_routes.router)
    @app.get("/cover")
    async def raw_cover():
        calls.append(("raw-fallback", None))
        return Response(b"PRIVATE_RAW_FALLBACK", media_type="application/octet-stream")
    def request(target=None, **selectors):
        if target is None:
            target = "/cover?" + urlencode({"library_id": 23, "album_id": 72, "selection_id": "front", **selectors})
        return asyncio.run(http_get(app, target))
    return SimpleNamespace(app=app, state=state, context=context, saved=saved, browse_album=browse_album,
                           calls=calls, cover=cover, outside=outside, foreign=foreign, request=request)


def test_view_preset_reads_selected_local_pixels_without_lookup_paths_or_media(api):
    before = api.cover.read_bytes()
    status, headers, body = api.request()
    assert status == 200
    assert headers[b"content-type"].startswith(b"image/png")
    assert b"no-store" in headers[b"cache-control"]
    assert headers[b"x-content-type-options"] == b"nosniff"
    assert b"PRIVATE_" not in body
    with Image.open(BytesIO(body)) as image:
        assert image.size == (40, 30) and image.getpixel((0, 0)) == (255, 0, 0)
    assert api.cover.read_bytes() == before
    assert not any(name in {"remote", "raw-fallback"} for name, _ in api.calls)
    status, _, _ = api.request("/albums/72/selected-covers")
    assert status == 403, "Browse presentation must not broaden editor lookup authority"


@pytest.mark.parametrize("user,expected", [(CurrentActor.anonymous(), 401), (actor(), 403)])
def test_artwork_policy_denial_happens_before_storage_or_source_access(api, user, expected):
    api.state.user = user
    assert api.request()[0] == expected
    assert not any(name in {"resolve", "load", "artwork", "remote", "raw-fallback"} for name, _ in api.calls)


@pytest.mark.parametrize("query", [
    {"library_id": 99}, {"album_id": 99}, {"selection_id": "unknown"},
    {"library_id": ""}, {"album_id": ""}, {"selection_id": ""},
    {"album_id": "artist::release"}, {"album_id": "-1"},
])
def test_selected_image_rejects_wrong_or_incomplete_identity_without_fallback(api, query):
    status, _, body = api.request(**query)
    assert status == 404
    assert b"PRIVATE_" not in body
    assert not any(name in {"remote", "raw-fallback"} for name, _ in api.calls)


@pytest.mark.parametrize("source", ["missing", "other-album", "unconfigured", "not-image", "symlink"])
def test_local_reference_requires_configured_root_and_represented_album_and_valid_pixels(api, source):
    if source == "missing":
        api.cover.unlink()
    elif source == "other-album":
        api.saved["selected_covers"][0]["path"] = str(api.outside)
    elif source == "unconfigured":
        api.saved["selected_covers"][0]["path"] = str(api.foreign)
    elif source == "not-image":
        api.cover.write_bytes(b"PRIVATE_AUDIO_DISGUISED_AS_IMAGE")
    else:
        api.cover.unlink()
        api.cover.symlink_to(api.outside)
    status, _, body = api.request()
    assert status == 404
    assert b"PRIVATE_" not in body
    assert not any(name in {"remote", "raw-fallback"} for name, _ in api.calls)


def test_raw_media_grant_cannot_bypass_selected_source_scope(api):
    api.state.user = actor("capability.view", "library.media.read")
    api.saved["selected_covers"][0]["path"] = str(api.outside)
    assert api.request()[0] == 404
    assert not any(name == "raw-fallback" for name, _ in api.calls)


def test_raw_media_grant_still_gets_sanitized_selected_image(api):
    api.state.user = actor("capability.view", "library.media.read")
    status, headers, body = api.request()
    assert status == 200 and b"PRIVATE_" not in body
    assert b"no-store" in headers[b"cache-control"]
    with Image.open(BytesIO(body)) as image:
        assert image.getpixel((0, 0)) == (255, 0, 0)
    assert not any(name == "raw-fallback" for name, _ in api.calls)


@pytest.mark.parametrize("extra", [{"path": "/private/submitted.png"}, {"loop_id": "loop"},
    {"url": "https://evil.example.test/submitted.png"}])
def test_ambiguous_selector_cannot_enter_any_source_loader(api, extra):
    api.state.user = actor("capability.view", "library.media.read", "library.covers.remote.read", "library.loops.read")
    status, _, body = api.request(**extra)
    assert status == 404 and b"PRIVATE_" not in body
    assert not any(name in {"load", "artwork", "remote", "raw-fallback"} for name, _ in api.calls)


@pytest.mark.parametrize("query", [
    "album_id=72&selection_id=front", "library_id=23&selection_id=front", "library_id=23&album_id=72",
    "library_id=23&album_id=72&selection_id=front&album_id=99",
    "library_id=23&album_id=72&selection_id=front&library_id=99",
    "library_id=23&album_id=72&selection_id=front&selection_id=remote",
])
def test_missing_or_duplicate_selector_keys_never_fall_through_raw_handler(api, query):
    api.state.user = actor("capability.view", "library.media.read")
    assert api.request("/cover?" + query)[0] == 404
    assert not any(name in {"load", "artwork", "remote", "raw-fallback"} for name, _ in api.calls)


def test_selector_never_substitutes_primary_for_legacy_list(api):
    api.saved.clear()
    api.saved["selected_cover_path"] = str(api.cover)
    assert api.request()[0] == 404


def test_corrupt_saved_list_cannot_render_valid_sibling_or_primary(api):
    api.saved["selected_covers"][1]["url"] = "file:///private/invalid.png"
    api.saved["selected_cover_path"] = str(api.cover)
    status, _, body = api.request()
    assert status == 404 and b"PRIVATE_" not in body
    assert not any(name in {"remote", "raw-fallback"} for name, _ in api.calls)


def test_other_library_context_cannot_authorize_matching_album_number(api):
    api.context["library_id"] = 99
    assert api.request()[0] == 404
    assert not any(name in {"load", "remote", "raw-fallback"} for name, _ in api.calls)


def test_remote_selector_requires_separate_grant_and_uses_only_saved_url(api):
    status, _, body = api.request(selection_id="remote")
    assert status == 403 and b"PRIVATE_" not in body
    assert not any(name == "remote" for name, _ in api.calls)
    api.state.user = actor("capability.view", "library.covers.remote.read")
    status, _, body = api.request(selection_id="remote")
    assert status == 200 and body == b"synthetic-remote-image"
    assert [value for name, value in api.calls if name == "remote"] == [api.saved["selected_covers"][1]["url"]]


def test_remote_grant_for_another_library_does_not_authorize_saved_source(api):
    viewer = actor("capability.view")
    from dataclasses import replace
    api.state.user = replace(viewer, capability_grants=viewer.capability_grants + (
        CapabilityGrant("library.covers.remote.read", "library", 99),))
    assert api.request(selection_id="remote")[0] == 403
    assert not any(name == "remote" for name, _ in api.calls)


def test_revoked_remote_grant_blocks_fetch_after_selection_load(api):
    api.state.user = actor("capability.view", "library.covers.remote.read")
    api.state.after_read = actor("capability.view")
    assert api.request(selection_id="remote")[0] == 403
    assert not any(name == "remote" for name, _ in api.calls)


def test_saved_remote_image_survives_missing_local_album_inventory(api):
    api.state.user = actor("capability.view", "library.covers.remote.read")
    api.context["track_paths"] = []
    status, _, body = api.request(selection_id="remote")
    assert status == 200 and body == b"synthetic-remote-image"
    assert [value for name, value in api.calls if name == "remote"] == [api.saved["selected_covers"][1]["url"]]


def test_saved_local_image_requires_active_represented_album_paths(api):
    api.context["track_paths"] = []
    status, _, body = api.request()
    assert status == 404 and b"PRIVATE_" not in body
    assert not any(name in {"remote", "raw-fallback"} for name, _ in api.calls)


@pytest.mark.parametrize("after", [actor(), actor("capability.view", library_id=99)])
def test_artwork_rechecks_current_actor_after_storage_read(api, after):
    api.state.after_read = after
    status, _, body = api.request()
    assert status in {403, 404}
    assert b"PRIVATE_" not in body
    assert not any(name in {"remote", "raw-fallback"} for name, _ in api.calls)


def test_detail_filters_remote_slot_without_mutating_repository_cache(api):
    before = deepcopy(api.browse_album)
    for remote_allowed in (False, True, False):
        api.state.user = actor("capability.view", *( ["library.covers.remote.read"] if remote_allowed else []))
        status, _, body = api.request("/album-details?album_id=72")
        assert status == 200
        album = json.loads(body)["album"]
        assert album["selected_covers_loaded"] is True
        assert album["selected_covers_revision"] == 7
        local, remote = album["selected_covers"]
        assert [local["selection_id"], remote["selection_id"]] == ["front", "remote"]
        target = urlsplit(local["image_url"])
        assert not target.netloc and target.path == "/cover"
        assert parse_qs(target.query) == {"library_id": ["23"], "album_id": ["72"], "selection_id": ["front"]}
        if remote_allowed:
            assert "image_url" in remote and not remote.get("unavailable", False)
        else:
            assert remote == {"selection_id": "remote", "kind": "remote", "unavailable": True}
        assert b"PRIVATE_" not in body
        assert api.browse_album == before


def test_detail_applies_fresh_remote_permission_after_repository_returns(api):
    api.state.user = actor("capability.view", "library.covers.remote.read")
    api.state.after_read = actor("capability.view")
    status, _, body = api.request("/album-details?album_id=72")
    assert status == 200
    assert json.loads(body)["album"]["selected_covers"][1] == {
        "selection_id": "remote", "kind": "remote", "unavailable": True}


@pytest.mark.parametrize("changed", [{"album_id": 99}, {"selected_covers_library_id": 99}])
def test_detail_cannot_retarget_saved_slots_when_outer_album_or_library_changes(api, changed):
    api.browse_album.update(changed)
    status, _, body = api.request("/album-details?album_id=72")
    assert status == 200
    album = json.loads(body)["album"]
    assert album["selected_covers_revision"] == 7
    assert [item["selection_id"] for item in album["selected_covers"]] == ["front", "remote"]
    assert all(item.get("unavailable") is True and "image_url" not in item for item in album["selected_covers"])


def test_opaque_selection_id_is_encoded_not_interpreted_as_extra_authority(api):
    identifier = "front&path=/private/canary.png#fragment"
    api.browse_album["selected_covers"][0]["selection_id"] = identifier
    api.saved["selected_covers"][0]["selection_id"] = identifier
    status, _, body = api.request("/album-details?album_id=72")
    assert status == 200
    url = json.loads(body)["album"]["selected_covers"][0]["image_url"]
    assert parse_qs(urlsplit(url).query) == {"album_id": ["72"], "library_id": ["23"], "selection_id": [identifier]}
    assert api.request(url)[0] == 200


@pytest.fixture
def root_browse_api(api, monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    # Keep the real root repository builder, row grouping, metadata projection,
    # router and policy. Replace only unrelated persistence read seams.
    repository = PostgresLibraryBrowseRepository(api.app.state.config, connect=lambda _: pytest.fail("No database permitted"))
    row = {"album_id": 72, "album_library_id": 23, "album_key": "artist::release", "album_title": "Release",
        "album_release_year": 2001, "album_cover_path": None, "track_count": 1,
        "artist_id": 90, "artist_name": "Artist", "artist_key": "artist", "featured_kind": "owner",
        "album_metadata": {"album_artist": "Artist", **deepcopy(api.saved)}}
    def rows(*args, **kwargs):
        api.calls.append(("root-rows", None))
        if api.state.after_read is not None:
            api.state.user = api.state.after_read
        return [deepcopy(row)]
    monkeypatch.setattr(repository, "_load_root_album_browse_rows", rows)
    monkeypatch.setattr(repository, "_load_relation_alias_maps",
                        lambda **kwargs: {"alias_to_canonical": {}, "canonical_to_aliases": {}})
    monkeypatch.setattr(repository._inventory_repository, "load_support_state",
                        lambda **kwargs: {"ignored_version_keys": [], "manual_version_links": []})
    monkeypatch.setattr(repository, "_load_missing_album_rows", lambda **kwargs: [])
    monkeypatch.setattr(repository, "_load_non_album_entries", lambda **kwargs: [])
    monkeypatch.setattr(repository, "_apply_private_album_rating_overlays", lambda *args, **kwargs: None)
    monkeypatch.setattr(repository, "_attach_duplicate_sources", lambda *args, **kwargs: None)
    monkeypatch.setattr(read_routes, "PostgresLibraryBrowseRepository", lambda config: repository)
    api.root_row = row
    return api


def test_root_view_data_projects_persisted_slots_through_real_row_and_read_owners(root_browse_api):
    api = root_browse_api
    before = deepcopy(api.root_row)
    for allowed in (False, True, False):
        api.state.user = actor("capability.view", *(["library.covers.remote.read"] if allowed else []))
        status, headers, body = api.request("/view-data?surface=albums&payload_tier=full")
        assert status == 200
        assert b"no-store" in headers[b"cache-control"]
        payload = json.loads(body)
        assert payload["album_count"] == 1
        album = payload["artist_groups"][0]["albums"][0]
        assert album["album_id"] == album["selected_covers_album_id"] == 72
        assert album["selected_covers_revision"] == 7 and album["selected_covers_loaded"] is True
        local, remote = album["selected_covers"]
        assert [local["selection_id"], remote["selection_id"]] == ["front", "remote"]
        assert parse_qs(urlsplit(local["image_url"]).query) == {
            "album_id": ["72"], "library_id": ["23"], "selection_id": ["front"]}
        assert ("image_url" in remote) is allowed
        assert bool(remote.get("unavailable")) is (not allowed)
        assert b"PRIVATE_" not in body and b"selected_covers_last_request" not in body
        assert api.root_row == before
    assert sum(name == "root-rows" for name, _ in api.calls) == 3
    assert not any(name in {"load", "remote", "raw-fallback"} for name, _ in api.calls)


def test_root_view_data_filters_remote_grant_revoked_during_read(root_browse_api):
    api = root_browse_api
    api.state.user = actor("capability.view", "library.covers.remote.read")
    api.state.after_read = actor("capability.view")
    status, _, body = api.request("/view-data?surface=albums&payload_tier=full")
    assert status == 200
    album = json.loads(body)["artist_groups"][0]["albums"][0]
    assert album["selected_covers"][1] == {"selection_id": "remote", "kind": "remote", "unavailable": True}


def test_root_view_data_does_not_hold_worker_token_while_refreshing_actor(root_browse_api):
    import anyio.to_thread

    async def run():
        limiter = anyio.to_thread.current_default_thread_limiter()
        previous = limiter.total_tokens
        limiter.total_tokens = 1
        task = asyncio.create_task(http_get(root_browse_api.app, "/view-data?surface=albums&payload_tier=full"))
        try:
            finished, _ = await asyncio.wait({task}, timeout=2)
            completed_without_extra_workers = bool(finished)
        finally:
            # Release starvation before awaiting cleanup; never leave a blocked
            # AnyIO worker behind even when the product fails this regression.
            limiter.total_tokens = previous
        status, _, body = await asyncio.wait_for(task, timeout=5)
        assert completed_without_extra_workers, "View response exhausted its worker pool while refreshing authorization"
        assert status == 200
        album = json.loads(body)["artist_groups"][0]["albums"][0]
        assert "image_url" in album["selected_covers"][0]
        assert album["selected_covers"][1].get("unavailable") is True

    asyncio.run(run())


@pytest.mark.parametrize("failure,expected", [
    ("malformed-selector", 404), ("unknown-selection", 404), ("wrong-library", 404),
    ("anonymous", 401), ("artwork-denied", 403), ("remote-denied", 403),
    ("storage-unavailable", 503), ("remote-unavailable", 502),
    ("missing-local", 404), ("invalid-local-image", 404), ("outside-album", 404),
])
def test_selected_artwork_errors_are_private_no_store_for_recovery_and_scope_changes(api, monkeypatch, failure, expected):
    selectors = {}
    if failure == "malformed-selector":
        selectors["selection_id"] = ""
    elif failure == "unknown-selection":
        selectors["selection_id"] = "not-selected"
    elif failure == "wrong-library":
        selectors["library_id"] = 99
    elif failure == "anonymous":
        api.state.user = CurrentActor.anonymous()
    elif failure == "artwork-denied":
        api.state.user = actor()
    elif failure == "remote-denied":
        selectors["selection_id"] = "remote"
    elif failure == "storage-unavailable":
        def unavailable(*args, **kwargs):
            raise RuntimeError("PRIVATE_STORAGE_FAILURE")
        monkeypatch.setattr(PostgresLibraryBrowseRepository, "load_selected_cover_artwork", unavailable)
    elif failure == "remote-unavailable":
        api.state.user = actor("capability.view", "library.covers.remote.read")
        selectors["selection_id"] = "remote"
        monkeypatch.setattr(cover_lookup_runtime, "fetch_remote_cover_bytes", lambda *args, **kwargs: (None, None))
    elif failure == "missing-local":
        api.cover.unlink()
    elif failure == "invalid-local-image":
        api.cover.write_bytes(b"PRIVATE_INVALID_IMAGE")
    else:
        api.saved["selected_covers"][0]["path"] = str(api.outside)

    status, headers, body = api.request(**selectors)
    assert status == expected
    assert b"PRIVATE_" not in body
    directives = {item.strip().lower() for item in headers.get(b"cache-control", b"").split(b",")}
    assert {b"private", b"no-store"} <= directives


@pytest.mark.parametrize("denied,expected", [(False, 404), (True, 403)])
def test_legacy_path_cover_error_policy_and_headers_remain_unchanged(api, denied, expected):
    if denied:
        api.state.user = actor()
    target = "/cover?" + urlencode({"path": str(api.cover.with_name("missing.png"))})
    status, headers, body = api.request(target)
    assert status == expected
    assert b"cache-control" not in headers
    assert json.loads(body)["detail"] == ("Action not permitted." if denied else "Artwork not found.")


@pytest.mark.parametrize("path", ["/account/appearance", "/account/layout-preferences", "/api/account/appearance/selection-accent"])
def test_existing_account_preference_error_cache_headers_are_preserved(api, path):
    async def preferences():
        return Response(b"unreachable")
    api.app.add_api_route(path, preferences, methods=["GET"])
    api.state.user = CurrentActor.anonymous()
    status, headers, body = api.request(path)
    assert status == 401
    assert headers[b"cache-control"] == b"no-store, max-age=0"
    assert json.loads(body) == {"detail": "Authentication required."}


def test_selected_artwork_error_keeps_existing_retry_header(api, monkeypatch):
    from fastapi import HTTPException

    api.state.user = actor("capability.view", "library.covers.remote.read")
    def throttled(*args, **kwargs):
        raise HTTPException(status_code=429, detail="Try again later.", headers={"Retry-After": "7"})
    monkeypatch.setattr(cover_lookup_runtime, "fetch_remote_cover_bytes", throttled)
    status, headers, body = api.request(selection_id="remote")
    assert status == 429 and json.loads(body) == {"detail": "Try again later."}
    assert headers[b"retry-after"] == b"7"
    assert {b"private", b"no-store"} <= {item.strip() for item in headers[b"cache-control"].split(b",")}
