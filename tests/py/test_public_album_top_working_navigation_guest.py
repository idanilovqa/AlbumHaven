"""Actual guest template composition exposes only a quiet share-key navigation action."""
import asyncio
import json
from urllib.parse import urlsplit

import pytest

from music_app.services.owned_album_tops import AlbumTopError
from tests.py.test_public_album_top_http import app_for, exchange, actor, ORIGIN, PATH, SHARE, ITEM
from tests.py.test_public_album_top_html import MetadataService, Page, html

WORKING_PATH = "/album-tops/public-link/" + SHARE


def same_origin(service=None, current=None):
    app = app_for(service or MetadataService(), current=current)
    app.state.auth_policy_config["public_base_url"] = ORIGIN
    return app


def working_links(body):
    return [link for link in Page(body).anchors if link["href"].startswith("/album-tops/public-link/")]


@pytest.mark.parametrize("suffix", ["", "/items/" + ITEM])
@pytest.mark.parametrize("current", [None, actor()])
def test_actual_guest_shared_link_is_small_secondary_and_only_carries_the_share_key(suffix, current):
    service = MetadataService(); app = same_origin(service, current)
    status, body, headers = html(app, path=PATH + suffix)
    assert status == 200 and len(service.calls) == 1
    links = working_links(body)
    assert len(links) == 1 and links[0]["href"] == WORKING_PATH
    assert "ui-button--small" in links[0]["class"] and "ui-button--secondary" in links[0]["class"]
    assert urlsplit(links[0]["href"]).netloc == "" and not urlsplit(links[0]["href"]).query
    assert b"Open in AlbumHaven" in body and b"may differ from this published snapshot" in body
    assert headers[b"cache-control"] == b"private, no-store" and headers[b"vary"] == b"Accept"
    payload = Page(body).payload
    assert set(payload) == {"kind", "share_ref", "item_ref", "limit", "data"}
    assert "top_ref" not in payload["data"] and "context_ref" not in payload["data"]
    assert b"private_ui_context" not in body and b"runtime-bundle" not in body


@pytest.mark.parametrize("base", [None, "", 7, "https://elsewhere.example.test", ORIGIN + "/mount",
    ORIGIN + "/", "https://PUBLIC.example.test", "https://user:pass@public.example.test", ORIGIN + "?x=1"])
def test_missing_distinct_or_noncanonical_private_base_has_clear_unavailable_explanation(base):
    service = MetadataService(); app = same_origin(service)
    if base is None:
        del app.state.auth_policy_config["public_base_url"]
    else:
        app.state.auth_policy_config["public_base_url"] = base
    status, body, _ = html(app)
    assert status == 200 and Page(body).payload is not None and len(service.calls) == 1
    assert not working_links(body) and b"Working Top navigation isn't available from this page." in body
    assert b"Open in AlbumHaven" not in body


def test_guest_metadata_and_json_stay_identical_across_actor_and_working_navigation_admission():
    service = MetadataService(); app = same_origin(service)
    anonymous = asyncio.run(exchange(app))[1]
    anon_payload = Page(html(app)[1]).payload
    app.state.current_actor_resolver.actor = actor()
    signed_in = asyncio.run(exchange(app))[1]
    member_payload = Page(html(app)[1]).payload
    del app.state.auth_policy_config["public_base_url"]
    unavailable_base = asyncio.run(exchange(app))[1]
    assert anonymous == signed_in == unavailable_base
    assert anon_payload == member_payload == Page(html(app)[1]).payload
    assert set(json.loads(anonymous)["data"]) == {"share_ref", "publication_ref", "publication_revision",
        "next_cursor", "allowed_actions", "title", "description", "items"}


@pytest.mark.parametrize("suffix", ["", "/items/" + ITEM])
def test_head_reauthorizes_same_navigation_representation_without_a_body(suffix):
    service = MetadataService(); app = same_origin(service)
    status, body, get_headers = html(app, path=PATH + suffix)
    head_status, head, headers = html(app, "HEAD", PATH + suffix)
    assert status == head_status == 200 and head == b"" and len(service.calls) == 2
    assert working_links(body)[0]["href"] == WORKING_PATH
    for name in [b"content-type", b"content-length", b"cache-control", b"vary", b"referrer-policy"]:
        assert headers[name] == get_headers[name]


def test_current_private_origin_change_while_public_read_finishes_omits_the_action():
    service = MetadataService(); app = same_origin(service)
    service.after = lambda: app.state.auth_policy_config.update(public_base_url="https://elsewhere.example.test")
    status, body, _ = html(app)
    assert status == 200 and Page(body).payload is not None and not working_links(body)
    assert b"Working Top navigation isn't available" in body


@pytest.mark.parametrize("status", [403, 404, 503])
def test_unavailable_publication_never_leaks_a_working_action(status):
    service = MetadataService(); service.error = AlbumTopError("unavailable", status)
    response, body, _ = html(same_origin(service))
    assert response == status and not working_links(body) and Page(body).payload is None
    assert b"Open in AlbumHaven" not in body


def test_complete_current_owned_router_inventory_includes_only_the_two_new_private_read_methods():
    # Additive characterization; the pinned historical nine-route inventory
    # remains untouched. The four already-published routes are explicit here.
    from music_app.routes.owned_album_tops_asgi import router
    from music_app.services.private_route_boundary import private_action_for_route, csrf_mode_for_route
    browse = "library.browse.read"
    create = "library.album_tops.create"
    access = "library.album_tops.access.manage"
    expected = {
        ("GET", "/album-tops"): browse,
        ("GET", "/album-tops/{top_ref}"): browse,
        ("GET", "/album-tops/edit-requests"): browse,
        ("GET", "/album-tops/{top_ref}/sharing"): browse,
        ("GET", "/album-tops/{top_ref}/access-grants"): access,
        ("GET", "/album-tops/{top_ref}/access-candidates"): access,
        ("POST", "/album-tops"): create,
        ("POST", "/album-tops/{top_ref}/{action}"): browse,
        ("POST", "/album-top-catalog/inventory"): create,
        ("POST", "/album-tops/{top_ref}/publication-preview"): access,
        ("GET", "/album-tops/{top_ref}/items/{item_ref}/publication-sources"): browse,
        ("POST", "/album-tops/{top_ref}/catalog/inventory"): browse,
        ("GET", "/album-top-catalog/search"): browse,
        ("GET", "/album-tops/public-link/{share_ref}"): browse,
        ("HEAD", "/album-tops/public-link/{share_ref}"): browse,
    }
    actual = {(method, route.path) for route in router.routes for method in route.methods}
    assert actual == set(expected)
    for (method, path), action in expected.items():
        assert private_action_for_route(method, path) == action
        assert csrf_mode_for_route(method, path) == ("none" if method in {"GET", "HEAD"} else "session_header")
