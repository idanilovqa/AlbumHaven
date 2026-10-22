"""Guest HTML over the existing real publication/authority fixture, without browser boot."""
import asyncio
from urllib.parse import urlencode, urlsplit

import pytest

from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_public_album_top_http_postgres import db, urls, published, read
from tests.py.test_album_top_collaboration_postgres import write, member
from tests.py.test_public_album_top_html import html, Page


def share_path(top):
    return "/public/album-tops/" + top["publication"]["share_ref"]


def next_page(page):
    link = next(row["href"] for row in page.anchors if "cursor=" in row["href"])
    parsed = urlsplit(link)
    assert not parsed.scheme and not parsed.netloc
    return parsed.path, parsed.query.encode()


def test_real_gallery_and_item_html_follow_bounded_current_publication_pages(published):
    db, top, app, items = published
    path = share_path(top)
    status, body, headers = html(app, path=path, query=b"limit=1")
    assert status == 200 and headers[b"vary"] == b"Accept"
    page = Page(body); first = page.payload["data"]
    assert first["title"] == "Approved Top" and len(first["items"]) == 1 and first["next_cursor"]
    status, second_body, _ = html(app, path=next_page(page)[0], query=next_page(page)[1])
    second = Page(second_body).payload["data"]
    assert status == 200 and second["publication_ref"] == first["publication_ref"]
    assert second["items"][0]["curator_position"] == 2 and second["next_cursor"] is None
    item_path = first["items"][0]["details_path"]
    status, item_body, _ = html(app, path=item_path, query=b"limit=1")
    item_page = Page(item_body); detail = item_page.payload["data"]
    assert status == 200 and detail["track_count"] == 2 and len(detail["tracks"]) == 1
    assert detail["tracks"][0]["position"] == 1
    status, track_body, _ = html(app, path=next_page(item_page)[0], query=next_page(item_page)[1])
    tracks = Page(track_body).payload["data"]
    assert status == 200 and tracks["tracks"][0]["position"] == 2 and tracks["next_cursor"] is None
    for private in [b"/synthetic-public/", b"never-public", b"private_path", b"local_album_id", b"selected_source_ref",
                    b"media_url", b"play_count", b"context_ref", b"top_ref"]:
        assert private not in body + item_body + track_body


@pytest.mark.parametrize("denial", ["source", "owner", "link"])
def test_real_current_revocation_or_eligibility_denial_removes_html_metadata_and_head(published, denial):
    db, top, app, items = published
    path = share_path(top)
    status, body, _ = html(app, path=path)
    assert status == 200
    item_path = Page(body).payload["data"]["items"][0]["details_path"]
    if denial == "source":
        app.state.policy_constraint_resolver = lambda context: PolicyEvaluationConstraints(
            request_origin_allowed=not (context.resource is not None and context.resource.resource_kind == "album_metadata_source"))
    elif denial == "owner":
        with db.connect() as connection:
            connection.execute("update app.accounts set is_active=false where id=%s", (db.owner.account_id,))
    else:
        write(db, "revoke_external", top)
    for target in [path, item_path]:
        status, body, headers = html(app, path=target)
        assert status == 404 and Page(body).payload is None and b"Approved" not in body
        assert headers[b"cache-control"] == b"private, no-store"
        status, head, head_headers = html(app, "HEAD", target)
        assert status == 404 and head == b"" and head_headers[b"content-type"].startswith(b"text/html")


def test_real_republish_keeps_link_but_retires_old_cursor_without_snapshot_mixing(published):
    db, top, app, items = published
    path = share_path(top)
    status, body, _ = html(app, path=path, query=b"limit=1")
    assert status == 200
    first = Page(body).payload["data"]
    preview = db.service.publication_preview(db.context(), top_ref=top["top_ref"],
        payload={"revision": top["revision"], "items": items})
    saved, _ = write(db, "save", top, title="Republished Top", description="", items=items,
        evidence_revision=preview["evidence_revision"])
    assert share_path(saved) == path
    status, stale, _ = html(app, path=path, query=urlencode({"limit": 1, "cursor": first["next_cursor"]}).encode())
    stale_page = Page(stale)
    assert status == 400 and stale_page.payload is None and b"Approved Top" not in stale
    assert any(link["href"] == path + "?limit=1" for link in stale_page.anchors)
    status, fresh, _ = html(app, path=path)
    assert status == 200 and Page(fresh).payload["data"]["title"] == "Republished Top"
    assert Page(fresh).payload["data"]["publication_ref"] != first["publication_ref"]


def test_real_empty_publication_is_explicit_and_remains_an_authorized_html_page(published):
    db, top, app, items = published
    preview = db.service.publication_preview(db.context(), top_ref=top["top_ref"],
        payload={"revision": top["revision"], "items": []})
    saved, _ = write(db, "save", top, title="Explicitly empty Top", description="", items=[],
        evidence_revision=preview["evidence_revision"])
    status, body, _ = html(app, path=share_path(saved))
    assert status == 200
    value = Page(body).payload["data"]
    assert value["title"] == "Explicitly empty Top" and value["items"] == [] and value["next_cursor"] is None


def test_real_same_link_member_receives_identical_html_without_working_authority(published):
    db, top, app, items = published
    first = html(app, path=share_path(top))
    app.state.current_actor_resolver.actor = member(db)
    second = html(app, path=share_path(top))
    assert first == second and first[0] == 200
    _, json_value, _ = read(app, share_path(top))
    assert Page(first[1]).payload["data"] == json_value["data"]


def test_real_html_head_matches_get_and_conditional_headers_do_not_skip_current_checks(published):
    db, top, app, items = published
    path = share_path(top)
    status, body, headers = html(app, path=path)
    head_status, head, head_headers = html(app, "HEAD", path)
    assert status == head_status == 200 and head == b""
    assert headers[b"content-length"] == head_headers[b"content-length"] == str(len(body)).encode()
    write(db, "revoke_external", top)
    status, denied, _ = html(app, path=path, headers={"if-none-match": "*"})
    assert status == 404 and Page(denied).payload is None
