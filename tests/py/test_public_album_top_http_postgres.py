"""Actual middleware, immutable metadata capture/seals and public SQL reads."""
import asyncio
import json
from uuid import uuid4

import pytest

from music_app.services.public_album_tops_postgres import PostgresPublicAlbumTopsService
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_owned_album_tops_postgres import db, urls
from tests.py.test_album_top_collaboration_postgres import write, member
from tests.py.test_album_top_owner_publication_postgres import configured
from tests.py.test_public_album_top_http import app_for, exchange, ORIGIN


@pytest.fixture
def published(db):
    configured(db)
    # Cleanup is registered by the fixture's finally before any presentation is
    # admitted. Remove only this fixture's Top/publication and catalog versions;
    # the existing Database owner then retires its library/accounts normally.
    try:
        sources = []
        with db.connect() as connection:
            root = connection.execute("""insert into library.library_roots(library_id,root_path,metadata)
                values(%s,%s,'{}') returning id""", (db.library, "/synthetic-public/" + db.token)).fetchone()["id"]
            for number, album in enumerate(db.album_ids[:2]):
                source = str(uuid4())
                container = f"/synthetic-public/{db.token}/album-{number}"
                artist = connection.execute("select artist_id from library.local_albums where id=%s", (album,)).fetchone()["artist_id"]
                connection.execute("""insert into library.album_metadata_sources
                    (ref,library_id,local_album_id,library_root_id,container_identity,path_flavor,
                     capture_builder_version,state,title,artist,year,title_origin,artist_origin)
                    values(%s,%s,%s,%s,%s,'posix',1,'active',%s,'Approved Artist',2000,'tag_metadata','tag_metadata')""",
                    (source, db.library, album, root, container, f"Approved Album {number}"))
                for position in range(1, 3):
                    track = connection.execute("""insert into library.local_tracks
                        (library_id,artist_id,album_id,track_key,title,disc_number,track_number,duration_seconds,title_origin,artist_origin)
                        values(%s,%s,%s,%s,%s,1,%s,180,'tag_metadata','tag_metadata') returning id""",
                        (db.library, artist, album, f"{db.token}:{number}:{position}",
                         f"Approved Track {number}-{position}", position)).fetchone()["id"]
                    connection.execute("""insert into library.local_track_files
                        (track_id,library_root_id,private_path,content_signature,metadata_source_ref,metadata)
                        values(%s,%s,%s,'synthetic',%s,'{"private_sentinel":"never-public"}')""",
                        (track, root, f"{container}/{position}.flac", source))
                sources.append(source)
        top, _ = db.create(refs=db.album_refs[:2])
        rows = db.read(top)["items"]
        items = [{"album_ref": row["catalog_ref"], "item_ref": row["ref"],
                  "selected_local_album_id": album, "selected_source_ref": source}
                 for row, album, source in zip(rows, db.album_ids, sources)]
        preview = db.service.publication_preview(db.context(), top_ref=top["top_ref"],
            payload={"revision": top["revision"], "items": items})
        top, command = write(db, "enable_external", top, title="Approved Top", description="Public description",
            items=items, evidence_revision=preview["evidence_revision"])
        public = PostgresPublicAlbumTopsService(db.service._config, connect=db.service._connect)
        app = app_for(public)
        app.state.config = db.service._config
        yield db, top, app, items
    finally:
        with db.connect() as connection:
            connection.execute("delete from app.album_list_operations where library_id=%s", (db.library,))
            connection.execute("delete from app.album_lists where library_id=%s", (db.library,))
            connection.execute("delete from catalog.album_presentation_versions where catalog_ref=any(%s::uuid[])", (db.album_refs,))


def read(app, path, **options):
    status, body, headers = asyncio.run(exchange(app, path=path, **options))
    return status, json.loads(body) if body else None, headers


def test_guest_top_and_track_pages_are_positive_metadata_only_with_bound_cursors(published):
    db, top, app, items = published
    path = "/public/album-tops/" + top["publication"]["share_ref"]
    status, value, headers = read(app, path, query=b"limit=1")
    assert status == 200 and headers[b"cache-control"] == b"private, no-store"
    first = value["data"]
    assert set(first) == {"share_ref", "publication_ref", "publication_revision", "next_cursor",
                          "allowed_actions", "title", "description", "items"}
    assert first["title"] == "Approved Top" and len(first["items"]) == 1 and first["next_cursor"]
    album = first["items"][0]
    assert set(album) == {"item_ref", "original_position", "curator_position", "album_ref", "presentation_ref",
                          "title", "artist", "year", "artwork_ref", "details_path"}
    assert album["artwork_ref"] is None and album["details_path"] == path + "/items/" + album["item_ref"]
    from urllib.parse import urlencode
    status, second, _ = read(app, path, query=urlencode({"limit": "1", "cursor": first["next_cursor"]}).encode())
    assert status == 200 and second["data"]["items"][0]["item_ref"] != album["item_ref"]
    assert second["data"]["next_cursor"] is None
    status, detail, _ = read(app, album["details_path"], query=b"limit=1")
    assert status == 200
    detail = detail["data"]
    assert set(detail) == {"share_ref", "publication_ref", "publication_revision", "next_cursor",
                           "allowed_actions", "item", "tracks", "track_count"}
    assert detail["track_count"] == 2 and len(detail["tracks"]) == 1 and detail["next_cursor"]
    assert set(detail["tracks"][0]) == {"track_ref", "position", "title", "artist", "duration_ms"}
    assert detail["allowed_actions"] == {"can_read": True, "can_open_item": True}
    serialized = json.dumps([first, second, detail])
    for private in ("/synthetic-public/", "never-public", "private_path", "play_count", "progress", "playable", "media_url"):
        assert private not in serialized
    status, invalid, _ = read(app, album["details_path"],
        query=urlencode({"limit": "1", "cursor": first["next_cursor"]}).encode())
    assert status == 400 and invalid["error"] == "invalid_cursor"
    status, head, _ = read(app, album["details_path"], method="HEAD")
    assert status == 200 and head is None


def test_same_link_unrelated_signed_in_actor_gets_only_the_identical_public_snapshot(published):
    db, top, app, items = published
    path = "/public/album-tops/" + top["publication"]["share_ref"]
    status, guest, _ = read(app, path)
    assert status == 200
    app.state.current_actor_resolver.actor = member(db)
    status, member_view, _ = read(app, path)
    assert status == 200 and member_view == guest
    assert "context_ref" not in member_view and "private_navigation_target" not in member_view["data"]


def test_revoke_and_owner_source_denial_fail_closed_without_private_fallback(published):
    db, top, app, items = published
    path = "/public/album-tops/" + top["publication"]["share_ref"]
    app.state.policy_constraint_resolver = lambda context: PolicyEvaluationConstraints(
        request_origin_allowed=not (context.resource is not None and context.resource.resource_kind == "album_metadata_source"))
    status, value, _ = read(app, path)
    assert status == 404 and value == {"ok": False, "error": "unavailable"}
    app.state.policy_constraint_resolver = None
    revoked, _ = write(db, "revoke_external", top)
    status, value, _ = read(app, path)
    assert status == 404 and value == {"ok": False, "error": "unavailable"}
    status, value, _ = read(app, path, method="HEAD")
    assert status == 404 and value is None


def test_publication_swap_invalidates_previous_cursor_without_changing_external_link(published):
    db, top, app, items = published
    path = "/public/album-tops/" + top["publication"]["share_ref"]
    status, first, _ = read(app, path, query=b"limit=1")
    assert status == 200
    preview = db.service.publication_preview(db.context(), top_ref=top["top_ref"],
        payload={"revision": top["revision"], "items": items})
    saved, _ = write(db, "save", top, title="New approved title", description="", items=items,
        evidence_revision=preview["evidence_revision"])
    assert saved["publication"]["share_ref"] == top["publication"]["share_ref"]
    from urllib.parse import urlencode
    status, stale, _ = read(app, path, query=urlencode({"limit": "1", "cursor": first["data"]["next_cursor"]}).encode())
    assert status == 400 and stale["error"] == "invalid_cursor"
    status, current, _ = read(app, path)
    assert status == 200 and current["data"]["title"] == "New approved title"
