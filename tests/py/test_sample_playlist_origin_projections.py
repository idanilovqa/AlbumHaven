"""Authoritative backend strings are emitted before JavaScript can round IDs."""
from uuid import uuid4

import pytest
from tests.py.test_owned_album_tops_postgres import db, urls, CURSOR_SECRET
from tests.py.test_album_top_publication_sources_postgres import choices
from tests.py.test_album_top_artist_scope_postgres import scoped_db, descriptor, search
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.owned_album_tops import AlbumTopError


@pytest.fixture
def bigint_album(db):
    identity = 9007199254740993 + db.library * 2
    assert 2**53 < identity < 2**63
    title = "Sample bigint " + uuid4().hex
    with db.connect() as con:
        artist = con.execute("select artist_id from library.local_albums where id=%s", (db.album_ids[0],)).fetchone()["artist_id"]
        con.execute("insert into library.local_albums(id,library_id,artist_id,album_key,title) overriding system value values(%s,%s,%s,%s,%s)",
                    (identity, db.library, artist, uuid4().hex, title))
    return identity, title


def test_picker_projects_exact_bigint_inventory_ref_without_retyping_legacy_number(db, bigint_album):
    identity, title = bigint_album
    rows = db.service.search_inventory_albums(db.context(), query=title, cursor_secret=CURSOR_SECRET)["albums"]
    assert len(rows) == 1 and rows[0]["local_album_id"] == identity
    assert rows[0]["inventory_album_ref"] == f"inventory-album:{db.library}:{identity}"
    assert type(rows[0]["local_album_id"]) is int and type(rows[0]["inventory_album_ref"]) is str
    assert int(float(identity)) != identity  # Legacy JavaScript Number would lose identity.


def test_admission_preserves_exact_legacy_catalog_response(db):
    identity = db.album_ids[0]
    assert 0 < identity < 2**53
    result = db.service.admit_inventory_album(db.context(), album_id=identity)
    assert result == {"album_ref": db.album_refs[0]}
    assert db.service.admit_inventory_album(db.context(), album_id=identity) == result


def test_denied_picker_album_does_not_emit_authoritative_ref(db, bigint_album):
    identity, title = bigint_album
    def constraints(ctx):
        return PolicyEvaluationConstraints(deployment_allowed=not (ctx.resource and ctx.resource.resource_kind == "album" and ctx.resource.resource_ref == str(identity)))
    assert db.service.search_inventory_albums(db.context(), query=title, cursor_secret=CURSOR_SECRET, constraints=constraints)["albums"] == []
    with pytest.raises(AlbumTopError): db.service.admit_inventory_album(db.context(), album_id=identity, constraints=constraints)


@pytest.mark.parametrize("mode", ["artist", "family"])
def test_artist_scoped_picker_uses_same_authoritative_string_projection(scoped_db, mode):
    database = scoped_db
    rows = search(database, scope=descriptor(database, mode), query="Same display title")["albums"]
    assert rows
    for row in rows:
        assert row["inventory_album_ref"] == f"inventory-album:{database.library}:{row['local_album_id']}"


def test_selected_edit_draft_gets_authoritative_ref_without_expanding_source_choice_dto(choices):
    from tests.py.test_album_top_publication_sources_postgres import read as read_choices
    from tests.py.test_album_top_collaboration_postgres import write
    database, top, items, sources, root = choices
    selected = [read_choices(choices, index=index)["sources"][0] for index in (0, 1)]
    assert all(set(row) == {"selected_local_album_id", "selected_source_ref", "title", "artist", "year"} for row in selected)
    selections = [{"album_ref": row["catalog_ref"], "item_ref": row["ref"],
        "selected_local_album_id": choice["selected_local_album_id"], "selected_source_ref": choice["selected_source_ref"]}
        for row, choice in zip(items, selected)]
    saved, _ = write(database, "save", top, items=selections)
    draft = database.read(saved)["edit_draft"]["items"]
    assert len(draft) == len(selections)
    for row, selection in zip(draft, selections):
        assert row["selected_local_album_id"] == selection["selected_local_album_id"]
        assert row["selected_source_ref"] == selection["selected_source_ref"]
        assert row["selected_inventory_album_ref"] == f"inventory-album:{database.library}:{selection['selected_local_album_id']}"


def test_selected_edit_draft_projects_exact_bigint_binding_independent_of_legacy_js_admission(db, bigint_album):
    """Python's existing selected-binding integer supports bigint; JS admission does not.

    Construct real inventory/source rows, then use the existing explicit binding
    Save. No unsafe number is sent through draft.select or an admission response.
    """
    from tests.py.test_album_top_collaboration_postgres import write
    from tests.py.test_album_top_owner_publication_postgres import configured
    identity, title = bigint_album
    configured(db)
    source = str(uuid4()); root_path = '/synthetic-bigint/' + db.token; container = root_path + '/copy'
    with db.connect() as con:
        root = con.execute("insert into library.library_roots(library_id,root_path,metadata) values(%s,%s,'{}') returning id",
                           (db.library, root_path)).fetchone()["id"]
        artist = con.execute("select artist_id from library.local_albums where id=%s", (identity,)).fetchone()["artist_id"]
        con.execute("insert into library.catalog_album_links(library_id,local_album_id,catalog_ref) values(%s,%s,%s)",
                    (db.library, identity, db.album_refs[0]))
        con.execute("""insert into library.album_metadata_sources
            (ref,library_id,local_album_id,library_root_id,container_identity,path_flavor,
             capture_builder_version,state,title,artist,year,title_origin,artist_origin)
            values(%s,%s,%s,%s,%s,'posix',1,'active',%s,'Synthetic artist',2000,'tag_metadata','tag_metadata')""",
            (source, db.library, identity, root, container, title))
        track = con.execute("""insert into library.local_tracks
            (library_id,artist_id,album_id,track_key,title,disc_number,track_number,duration_seconds,title_origin,artist_origin)
            values(%s,%s,%s,%s,'Track',1,1,180,'tag_metadata','tag_metadata') returning id""",
            (db.library, artist, identity, uuid4().hex)).fetchone()["id"]
        con.execute("""insert into library.local_track_files
            (track_id,library_root_id,private_path,content_signature,metadata_source_ref,metadata)
            values(%s,%s,%s,'synthetic',%s,'{}')""", (track, root, container + '/1.flac', source))
    top, _ = db.create(refs=db.album_refs[:1])
    item = db.read(top)["items"][0]
    saved, _ = write(db, "save", top, items=[{"album_ref": db.album_refs[0], "item_ref": item["ref"],
        "selected_local_album_id": identity, "selected_source_ref": source}])
    row, = db.read(saved)["edit_draft"]["items"]
    assert row["selected_local_album_id"] == identity and type(row["selected_local_album_id"]) is int
    assert row["selected_source_ref"] == source
    assert row["selected_inventory_album_ref"] == f"inventory-album:{db.library}:{identity}"
    assert type(row["selected_inventory_album_ref"]) is str and int(float(identity)) != identity
