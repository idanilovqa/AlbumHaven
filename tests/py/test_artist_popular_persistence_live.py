"""Scoped generated sources through real PostgreSQL and existing Playlist owner."""
from copy import deepcopy
from dataclasses import replace
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest

from library_mix_postgres_support import mix_db, mix_urls, MEDIA, ACTIONS
from music_app.services import library_mix_postgres as mixes
from music_app.services.current_actor import CapabilityGrant
from music_app.services.metadata import NON_ALBUM_EXCEPTION_VALUES
from music_app.services.owned_playlists import ARTIST_MIX_PROTOCOL, PlaylistError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.relation_projection_postgres import RELATION_PROJECTION_BUILDER_VERSION


@pytest.fixture
def artist_db(mix_db):
    db = mix_db
    with db.connect() as con:
        for table in ("app.playlist_library_mix_artists", "app.playlist_library_mix_albums"):
            assert con.execute("select to_regclass(%s) as name", (table,)).fetchone()["name"], table
        facts = con.execute("select id,artist_id from library.local_albums where library_id=%s order by id",
                            (db.library,)).fetchall()
        db.artist_ids = [row["artist_id"] for row in facts]
        for row in facts:
            con.execute("""insert into library.local_album_featured_artists
                (library_id,album_id,artist_id,featured_kind) values(%s,%s,%s,'owner')""",
                (db.library, row["id"], row["artist_id"]))
        # Actual cached relation rows, with the real freshness contract.
        relation = {"alias_to_canonical": {}, "canonical_to_aliases": {},
                    "family_to_artists": {}, "folder_related": {},
                    "artists": [], "artists_sidebar": [], "sidebar_families": []}
        metadata = {"status": "ready", "builder_version": RELATION_PROJECTION_BUILDER_VERSION,
                    "source_fingerprint": db.token, "built_from_fingerprint": db.token}
        con.execute("""update library.libraries set metadata=%s where id=%s""",
                    (Jsonb({"scan_cache": {"relation_views": relation, "relation_projection": metadata}}), db.library))
    return db


def scope(db, *, groups=(0,), basis="primary_credit", albums=None):
    return {"kind": "selected_artists",
            "categories": ["main_library", "new_arrivals", "hoard"], "album_types": ["studio", "ep"],
            "artist_ids": [str(db.artist_ids[index]) for index in groups],
            "memberships": [{"artist_id": str(db.artist_ids[index]), "basis": basis} for index in groups],
            "album_order": [str(value) for value in (albums if albums is not None else [db.albums[index] for index in groups])]}


def options(*, auto=False, count=2):
    return {"selection_basis": "per_album", "songs_per_group": count,
            "auto_update": auto, "playback_order": "regular"}


def capture(db, *, selected=None, auto=False, count=2, constraints=None):
    return mixes.capture(db.service, db.context(),
        {"scope": scope(db) if selected is None else selected, "recipe": options(auto=auto, count=count)},
        protocol=ARTIST_MIX_PROTOCOL, constraints=constraints)["data"]


def ids(source):
    return [int(row["inventory_track_ref"].rsplit(":", 1)[1]) for row in source["entries"]]


def read(db, source, **kwargs):
    return mixes.read_capture(db.service, db.context(), source["source"]["ref"],
        source["source"]["revision"], protocol=ARTIST_MIX_PROTOCOL, **kwargs)["data"]


def queue(db, source, *, refs=None, constraints=None):
    refs = refs if refs is not None else [row["entry_ref"] for row in source["entries"]]
    return mixes.native_queue(db.service, db.context(), {
        "source_ref": source["source"]["ref"], "source_revision": source["source"]["revision"],
        "entry_refs": refs, "starting_entry_ref": refs[0]}, protocol=ARTIST_MIX_PROTOCOL,
        constraints=constraints, media_resolver=db.media_resolver)


def test_viewer_without_media_can_capture_and_save_exact_artist_selection(artist_db):
    db = artist_db
    source = capture(db)
    assert ids(source) == db.tracks[:2]
    assert source["source_protocol"] == ARTIST_MIX_PROTOCOL
    assert source["library_mix"]["version"] == 2
    assert source["library_mix"]["scope"] == scope(db)
    assert all(row["allowed_actions"]["can_play"] is False for row in source["entries"])
    assert source["allowed_actions"]["can_use_for_playlist"] is True
    assert source["allowed_actions"]["can_play"] is False
    receipt, command, _ = db.save(source)
    assert [row["local_track_id"] for row in db.state(receipt["playlist_id"])[1]] == db.tracks[:2]
    assert db.service.execute(db.context(), command) == receipt
    assert db.total("playlists") == db.total("playlist_operations") == db.total("playlist_library_mixes") == 1
    with pytest.raises(PlaylistError, match="item_unavailable"):
        queue(db, source)


def test_media_denial_does_not_consume_a_different_metadata_quota(artist_db):
    db = artist_db
    with db.connect() as con:
        con.execute("""insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
            values(%s,%s,'library',%s)""", (db.owner.account_id, MEDIA, db.library))
    db.owner = replace(db.owner, capability_grants=(*db.owner.capability_grants,
                      CapabilityGrant(MEDIA, "library", db.library)))
    def constraints(context):
        denied = context.action == MEDIA and context.resource is not None and context.resource.resource_ref == str(db.tracks[0])
        return PolicyEvaluationConstraints(deployment_allowed=not denied)
    source = capture(db, constraints=constraints)
    assert ids(source) == db.tracks[:2]
    assert source["entries"][0]["allowed_actions"]["can_play"] is False
    assert source["entries"][1]["allowed_actions"]["can_play"] is True
    refs = [row["entry_ref"] for row in reversed(source["entries"])]
    played = queue(db, source, refs=refs, constraints=constraints)
    assert [row["playlist_item_id"] for row in played["tracks"]] == refs[:1]
    assert played["unavailable_item_refs"] == refs[1:]
    assert read(db, source)["entries"] != []
    assert ids(read(db, source)) == db.tracks[:2]


def test_unavailable_local_file_is_excluded_before_quota(artist_db):
    db = artist_db
    with db.connect() as con:
        con.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where track_id=%s", (db.tracks[0],))
    source = capture(db)
    assert ids(source) == db.tracks[1:3]


def test_explicit_empty_album_snapshot_never_widens(artist_db):
    db = artist_db
    source = capture(db, selected=scope(db, albums=[]))
    assert source["entries"] == []
    assert source["library_mix"]["scope"]["album_order"] == []


def test_album_from_another_artist_is_not_admitted_by_request_order(artist_db):
    with pytest.raises(PlaylistError, match="source_changed"):
        capture(artist_db, selected=scope(artist_db, albums=[artist_db.albums[1]]))
    assert artist_db.total("playlists") == 0


def test_regeneration_is_bound_to_prior_album_scope_and_returns_new_receipt(artist_db):
    db = artist_db
    first = capture(db)
    second = mixes.regenerate(db.service, db.context(), {
        "source_ref": first["source"]["ref"], "source_revision": first["source"]["revision"],
        "recipe": options(count=3)})["data"]
    assert ids(second) == db.tracks[:3]
    assert second["library_mix"]["scope"] == first["library_mix"]["scope"]
    assert second["source"]["ref"] != first["source"]["ref"]
    assert ids(read(db, first)) == db.tracks[:2]
    assert db.total("playlists") == db.total("playlist_operations") == 0
    with pytest.raises(PlaylistError, match="invalid_command"):
        mixes.regenerate(db.service, db.context(), {
            "source_ref": first["source"]["ref"], "source_revision": first["source"]["revision"],
            "recipe": options(), "scope": scope(db, groups=(1,))})


@pytest.mark.parametrize("auto", [False, True])
def test_fixed_or_explicit_dynamic_mode_preserves_exact_artist_set(artist_db, auto):
    db = artist_db
    source = capture(db, auto=auto)
    receipt, _, _ = db.save(source)
    before = db.state(receipt["playlist_id"])
    with db.connect() as con:
        db.observe(con, db.tracks[2], 999)
        db.observe(con, db.tracks[3], 9999)
    detail = db.service.read(db.context(), playlist_ref=receipt["playlist_id"])["playlist_detail"]
    after = db.state(receipt["playlist_id"])
    assert [row["local_track_id"] for row in after[1]] == ([db.tracks[2], db.tracks[0]] if auto else db.tracks[:2])
    assert detail["library_mix"]["scope"] == scope(db)
    assert after[0]["revision"] == before[0]["revision"] + int(auto)
    assert db.tracks[3] not in [row["local_track_id"] for row in after[1]]


def test_deleted_artist_keeps_provenance_and_does_not_rebind_same_name(artist_db):
    db = artist_db
    receipt, _, _ = db.save(capture(db, auto=True))
    with db.connect() as con:
        old = con.execute("select name,artist_key from library.local_artists where id=%s", (db.artist_ids[0],)).fetchone()
        con.execute("delete from library.local_artists where id=%s", (db.artist_ids[0],))
        replacement = con.execute("""insert into library.local_artists(library_id,name,artist_key)
            values(%s,%s,%s) returning id""", (db.library, old["name"], old["artist_key"])).fetchone()["id"]
        con.execute("""insert into library.local_album_featured_artists
            (library_id,album_id,artist_id,featured_kind) values(%s,%s,%s,'owner')""",
            (db.library, db.albums[1], replacement))
    detail = db.service.read(db.context(), playlist_ref=receipt["playlist_id"])["playlist_detail"]
    assert db.state(receipt["playlist_id"])[1] == []
    assert detail["library_mix"]["scope"]["artist_ids"] == [str(db.artist_ids[0])]
    assert str(replacement) not in detail["library_mix"]["scope"]["artist_ids"]


def test_family_credit_rejects_featured_track_only_membership(artist_db):
    db = artist_db
    with db.connect() as con:
        con.execute("update library.local_album_featured_artists set featured_kind='featured_track_artist' where library_id=%s and artist_id=%s",
                    (db.library, db.artist_ids[0]))
    with pytest.raises(PlaylistError, match="source_changed"):
        capture(db, selected=scope(db, basis="family_credit"))
    assert ids(capture(db)) == db.tracks[:2]


def test_source_protocol_cannot_be_reinterpreted_as_whole_library(artist_db):
    db = artist_db
    source = capture(db)
    with pytest.raises(PlaylistError, match="source_changed"):
        mixes.read_capture(db.service, db.context(), source["source"]["ref"], source["source"]["revision"])
    changed = deepcopy(db.create_command(source))
    changed.data["source_protocol"] = "library_mix_selection_v1"
    with pytest.raises(PlaylistError, match="source_changed"):
        db.service.execute(db.context(), changed)
    assert db.total("playlists") == db.total("playlist_operations") == 0


def test_unknown_artist_and_stale_alias_projection_fail_closed(artist_db):
    db = artist_db
    selected = scope(db)
    selected["artist_ids"] = [str(2**63 - 1)]
    selected["memberships"][0]["artist_id"] = selected["artist_ids"][0]
    with pytest.raises(PlaylistError, match="source_changed"):
        capture(db, selected=selected)
    with db.connect() as con:
        con.execute("update library.libraries set metadata='{}' where id=%s", (db.library,))
    with pytest.raises(PlaylistError, match="library_mix_unavailable"):
        capture(db)
    assert db.total("playlists") == 0


def test_scope_children_share_single_recipe_parent_and_survive_inventory_deletion(artist_db):
    db = artist_db
    receipt, _, _ = db.save(capture(db))
    with db.connect() as con:
        ref = receipt["playlist_id"]
        artists = con.execute("select * from app.playlist_library_mix_artists where playlist_ref=%s", (ref,)).fetchall()
        albums = con.execute("select * from app.playlist_library_mix_albums where playlist_ref=%s", (ref,)).fetchall()
        assert [row["original_artist_id"] for row in artists] == db.artist_ids[:1]
        assert [row["original_album_id"] for row in albums] == db.albums[:1]
        with pytest.raises(psycopg.errors.CheckViolation):
            with con.transaction():
                con.execute("update app.playlist_library_mixes set recipe_version=1 where playlist_ref=%s", (ref,))
        with pytest.raises(psycopg.errors.UniqueViolation):
            with con.transaction():
                con.execute("insert into app.playlist_library_mixes select * from app.playlist_library_mixes where playlist_ref=%s", (ref,))
        con.execute("delete from library.local_albums where id=%s", (db.albums[0],))
        assert con.execute("select original_album_id from app.playlist_library_mix_albums where playlist_ref=%s", (ref,)).fetchone()["original_album_id"] == db.albums[0]
        con.execute("delete from app.playlists where ref=%s", (ref,))
        for table in ("playlist_library_mix_artists", "playlist_library_mix_albums"):
            assert con.execute(f"select count(*) as n from app.{table} where playlist_ref=%s", (ref,)).fetchone()["n"] == 0


@pytest.mark.parametrize("field", ["categories", "album_types"])
def test_empty_retained_filter_cannot_widen_dynamic_selection(artist_db, field):
    db = artist_db
    selected = scope(db, albums=[])
    selected[field] = []
    source = capture(db, selected=selected, auto=True)
    assert source["entries"] == []
    assert source["library_mix"]["scope"][field] == []


def test_exception_overridden_track_is_excluded_before_popularity_quota(artist_db):
    db = artist_db
    with db.connect() as con:
        con.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
            '{scan_cache,file_entry,exception_type}', %s) where track_id=%s""",
            (Jsonb(next(iter(NON_ALBUM_EXCEPTION_VALUES))), db.tracks[0]))
    assert ids(capture(db)) == db.tracks[1:3]


def test_dynamic_retains_category_and_type_intent_and_unchanged_refresh_is_stable(artist_db):
    db = artist_db
    selected = scope(db)
    selected["categories"] = ["main_library"]
    receipt, _, _ = db.save(capture(db, selected=selected, auto=True))
    before = db.state(receipt["playlist_id"])
    db.service.read(db.context(), playlist_ref=receipt["playlist_id"])
    unchanged = db.state(receipt["playlist_id"])
    assert unchanged[0]["revision"] == before[0]["revision"]
    assert unchanged[1] == before[1]
    with db.connect() as con:
        con.execute("""update library.local_albums set metadata=metadata || %s where id=%s""",
            (Jsonb({"root_provenance": {"categories": ["hoard"], "primary_category": "hoard"}}), db.albums[0]))
    detail = db.service.read(db.context(), playlist_ref=receipt["playlist_id"])["playlist_detail"]
    assert db.state(receipt["playlist_id"])[1] == []
    assert detail["library_mix"]["scope"]["categories"] == ["main_library"]
    with db.connect() as con:
        con.execute("""update library.local_albums set metadata=metadata || %s where id=%s""",
            (Jsonb({"root_provenance": {"categories": ["main_library"]}, "is_compilation": True}), db.albums[0]))
    db.service.read(db.context(), playlist_ref=receipt["playlist_id"])
    assert db.state(receipt["playlist_id"])[1] == []
    with db.connect() as con:
        con.execute("""update library.local_albums set metadata=metadata || '{"is_compilation":false}' where id=%s""", (db.albums[0],))
    db.service.read(db.context(), playlist_ref=receipt["playlist_id"])
    assert [row["local_track_id"] for row in db.state(receipt["playlist_id"])[1]] == db.tracks[:2]


@pytest.mark.parametrize("kind", ["artist", "album", "track"])
def test_browse_denied_scope_members_do_not_enter_quota(artist_db, kind):
    db = artist_db
    identity = {"artist": db.artist_ids[0], "album": db.albums[0], "track": db.tracks[0]}[kind]
    def constraints(context):
        denied = (context.action == "library.browse.read" and context.resource is not None
                  and context.resource.resource_kind == kind
                  and context.resource.resource_ref == str(identity))
        return PolicyEvaluationConstraints(deployment_allowed=not denied)
    if kind == "artist":
        with pytest.raises(PlaylistError, match="source_unavailable"):
            capture(db, constraints=constraints)
    elif kind == "album":
        with pytest.raises(PlaylistError, match="source_changed"):
            capture(db, constraints=constraints)
    else:
        assert ids(capture(db, constraints=constraints)) == db.tracks[1:3]
    assert db.total("playlists") == 0


def test_dynamic_can_admit_new_album_only_with_retained_artist_membership(artist_db):
    db = artist_db
    fixed, _, _ = db.save(capture(db, auto=False))
    dynamic, _, _ = db.save(capture(db, auto=True))
    with db.connect() as con:
        con.execute("""insert into library.local_album_featured_artists
            (library_id,album_id,artist_id,featured_kind) values(%s,%s,%s,'owner')""",
            (db.library, db.albums[1], db.artist_ids[0]))
    db.service.read(db.context(), playlist_ref=fixed["playlist_id"])
    db.service.read(db.context(), playlist_ref=dynamic["playlist_id"])
    assert [row["local_track_id"] for row in db.state(fixed["playlist_id"])[1]] == db.tracks[:2]
    assert [row["local_track_id"] for row in db.state(dynamic["playlist_id"])[1]] == [*db.tracks[:2], *db.tracks[3:5]]


@pytest.mark.parametrize("change", ["track_album", "credit_role", "receipt_expiry"])
def test_blocked_inventory_revalidates_changed_scope_before_source_publication(artist_db, change):
    from concurrent.futures import ThreadPoolExecutor
    from contextlib import contextmanager
    from threading import Event
    from psycopg.rows import dict_row
    from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
    db = artist_db
    original = capture(db) if change == "receipt_expiry" else None
    reached = Event()
    class ObservedConnection:
        def __init__(self, real): self.real = real
        def __getattr__(self, name): return getattr(self.real, name)
        def execute(self, sql, params=None):
            if "select id from library.local_tracks" in sql and "for update" in sql:
                reached.set()
            return self.real.execute(sql, params)
    @contextmanager
    def connect(url):
        with psycopg.connect(url, row_factory=dict_row) as connection:
            connection.execute("set local lock_timeout='8s'")
            connection.execute("set local statement_timeout='12s'")
            yield ObservedConnection(connection)
    service = PostgresOwnedPlaylistsService(db.config, connect=connect, clock=lambda: db.clock_time)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.connect() as blocker:
            blocker.execute("set local lock_timeout='8s'")
            blocker.execute("set local statement_timeout='12s'")
            blocker.execute("select id from library.local_tracks where id=%s for update", (db.tracks[0],))
            if original:
                future = pool.submit(mixes.regenerate, service, db.context(), {
                    "source_ref": original["source"]["ref"], "source_revision": original["source"]["revision"],
                    "recipe": options(count=3)})
            else:
                future = pool.submit(mixes.capture, service, db.context(),
                    {"scope": scope(db, basis="family_credit"), "recipe": options()}, protocol=ARTIST_MIX_PROTOCOL)
            try:
                assert reached.wait(10), "Capture did not reach the real inventory lock"
                if change == "track_album":
                    blocker.execute("update library.local_tracks set album_id=%s where id=%s", (db.albums[1], db.tracks[0]))
                elif change == "receipt_expiry":
                    from datetime import timedelta
                    db.clock_time += timedelta(minutes=31)
                else:
                    blocker.execute("""update library.local_album_featured_artists set featured_kind='featured_track_artist'
                        where library_id=%s and artist_id=%s""", (db.library, db.artist_ids[0]))
            finally:
                blocker.commit()
        with pytest.raises(PlaylistError, match="library_mix_unavailable|source_changed|source_expired"):
            future.result(timeout=15)
    assert db.total("playlists") == db.total("playlist_operations") == 0


def test_other_library_artist_and_album_ids_are_never_rebound(artist_db):
    db = artist_db
    with db.connect() as con:
        actor = db.actor(con)
        foreign_library = con.execute("insert into library.libraries(owner_account_id,name) values(%s,%s) returning id",
            (actor.account_id, 'Other ' + db.token)).fetchone()["id"]
        artist = con.execute("insert into library.local_artists(library_id,artist_key,name) values(%s,%s,%s) returning id",
            (foreign_library, db.token, 'Mix Artist 0')).fetchone()["id"]
        album = con.execute("insert into library.local_albums(library_id,artist_id,album_key,title) values(%s,%s,%s,%s) returning id",
            (foreign_library, artist, db.token, 'Mix Album 0')).fetchone()["id"]
    try:
        value = scope(db)
        value["artist_ids"] = [str(artist)]
        value["memberships"][0]["artist_id"] = str(artist)
        with pytest.raises(PlaylistError, match="source_changed|source_unavailable"):
            capture(db, selected=value)
        with pytest.raises(PlaylistError, match="source_changed"):
            capture(db, selected=scope(db, albums=[album]))
        assert db.total("playlists") == 0
    finally:
        with db.connect() as con:
            con.execute("delete from library.libraries where id=%s", (foreign_library,))


@pytest.mark.parametrize("shared", [False, True])
def test_family_scope_matches_actual_full_grouping_owner_with_aliases(artist_db, shared):
    from music_app.services.library_browse_postgres import _selected_artist_family_groups_from_preview_rows
    db = artist_db
    with db.connect() as con:
        names = {row['id']: row['name'] for row in con.execute(
            'select id,name from library.local_artists where library_id=%s', (db.library,)).fetchall()}
        first, second = names[db.artist_ids[0]], names[db.artist_ids[1]]
        display = first + ' & ' + second
        metadata = {'album_artist': display if shared else first,
                    'artists': [first, second] if shared else [first], 'is_compilation': False}
        con.execute('update library.local_albums set metadata=%s where id=%s', (Jsonb(metadata), db.albums[0]))
        con.execute("""update library.libraries set metadata=jsonb_set(jsonb_set(metadata,
            '{scan_cache,relation_views,alias_to_canonical}',%s),
            '{scan_cache,relation_views,canonical_to_aliases}',%s) where id=%s""",
            (Jsonb({display: first}), Jsonb({first: [display]}), db.library))
        fact = con.execute('''select id as album_id,album_key,title as album_title,
            release_year as album_release_year,metadata as album_metadata
            from library.local_albums where id=%s''', (db.albums[0],)).fetchone()
    expected = _selected_artist_family_groups_from_preview_rows([first], [{**fact, 'artist_name': first}],
        alias_to_canonical={display: first}, canonical_to_aliases={first: [display]})
    expected_ids = [album['album_id'] for group in expected for album in group['albums']]
    if db.albums[0] in expected_ids:
        actual = capture(db, selected=scope(db, basis='family_credit'))
        assert actual['library_mix']['scope']['album_order'] == [str(db.albums[0])]
    else:
        with pytest.raises(PlaylistError, match='source_changed'):
            capture(db, selected=scope(db, basis='family_credit'))
    assert db.total('playlists') == 0


def test_scope_constraints_and_runtime_privileges(artist_db):
    from psycopg.rows import dict_row
    db = artist_db
    receipt, _, _ = db.save(capture(db))
    ref = receipt['playlist_id']
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        assert con.execute('select count(*) as n from app.playlist_library_mix_artists where playlist_ref=%s', (ref,)).fetchone()['n'] == 1
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with con.transaction():
                con.execute("update app.playlist_library_mix_artists set membership_basis='primary_credit' where playlist_ref=%s", (ref,))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with con.transaction():
                con.execute("update app.playlist_library_mix_albums set source_position=source_position where playlist_ref=%s", (ref,))
        with pytest.raises(psycopg.errors.CheckViolation):
            with con.transaction():
                con.execute("update app.playlist_library_mixes set artist_categories=array['unknown'] where playlist_ref=%s", (ref,))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with con.transaction():
                con.execute('delete from app.playlist_library_mix_artists where playlist_ref=%s', (ref,))
    with db.connect() as con:
        with pytest.raises(psycopg.errors.CheckViolation):
            with con.transaction():
                con.execute("update app.playlist_library_mix_artists set membership_basis='all_credits' where playlist_ref=%s", (ref,))
        with pytest.raises(psycopg.errors.CheckViolation):
            with con.transaction():
                con.execute('delete from app.playlist_library_mix_artists where playlist_ref=%s', (ref,))
                con.execute('set constraints all immediate')
        assert con.execute('select count(*) as n from app.playlist_library_mix_artists where playlist_ref=%s', (ref,)).fetchone()['n'] == 1


def actual_artist_browse_rows(connection, db, *, preview=False):
    from music_app.services.library_browse_postgres import _selected_artist_sql, _selected_artist_preview_sql
    sql = _selected_artist_preview_sql() if preview else _selected_artist_sql()
    # Exercise the unchanged production bootstrap lookup. Fixture changes live
    # only in a rolled-back savepoint, preserving any preexisting bootstrap row
    # and this test's earlier track/file mutations in the enclosing transaction.
    before = connection.execute(
        "select * from app.bootstrap_owners where owner_key='local-bootstrap-owner'"
    ).fetchall()
    library = connection.execute(
        "select owner_account_id,name,library_kind from library.libraries where id=%s",
        (db.library,),
    ).fetchone()
    assert library is not None
    with connection.transaction(force_rollback=True):
        connection.execute("set local lock_timeout='8s'")
        connection.execute("set local statement_timeout='12s'")
        connection.execute(
            "update library.libraries set name='Local Library',library_kind='local' where id=%s",
            (db.library,),
        )
        connection.execute(
            """insert into app.bootstrap_owners(owner_key,account_id)
               values('local-bootstrap-owner',%s)
               on conflict(owner_key) do update set account_id=excluded.account_id""",
            (library['owner_account_id'],),
        )
        key = connection.execute(
            'select artist_key from library.local_artists where id=%s and library_id=%s',
            (db.artist_ids[0], db.library),
        ).fetchone()['artist_key']
        rows = connection.execute(sql, {
            'artist_keys': [key], 'category_count': 0, 'visible_categories': [],
        }).fetchall()
    assert connection.execute(
        "select * from app.bootstrap_owners where owner_key='local-bootstrap-owner'"
    ).fetchall() == before
    assert connection.execute(
        "select owner_account_id,name,library_kind from library.libraries where id=%s",
        (db.library,),
    ).fetchone() == library
    return rows


@pytest.mark.parametrize('category', ['new_arrivals', 'hoard'])
@pytest.mark.parametrize('excluded_leading', [False, True])
def test_actual_file_category_fallback_agrees_across_full_preview_and_source(artist_db, category, excluded_leading):
    from music_app.services.library_browse_postgres import (
        _selected_artist_album_payloads, _root_album_browse_album_payloads, _popular_album_category_sql,
    )
    db = artist_db
    with db.connect() as con:
        con.execute("update library.local_track_files set metadata=metadata || %s where track_id=any(%s::bigint[])",
            (Jsonb({'library_root_category': category}), db.tracks[:3]))
        if excluded_leading:
            con.execute("""update library.local_track_files set metadata=jsonb_set(metadata ||
                '{"library_root_category":"main_library"}', '{scan_cache,file_entry,exception_type}', %s)
                where track_id=%s""", (Jsonb(next(iter(NON_ALBUM_EXCEPTION_VALUES))), db.tracks[0]))
        full_rows = actual_artist_browse_rows(con, db)
        preview_rows = actual_artist_browse_rows(con, db, preview=True)
    full = _selected_artist_album_payloads(full_rows, 'Mix Artist 0')
    preview = _root_album_browse_album_payloads(preview_rows, 'Mix Artist 0', include_artist_members=True)
    assert full[0]['root_provenance']['categories'] == preview[0]['root_provenance']['categories'] == [category]
    selected = scope(db)
    selected['categories'] = [category]
    source = capture(db, selected=selected, auto=True)
    assert ids(source) == (db.tracks[1:3] if excluded_leading else db.tracks[:2])
    receipt, _, _ = db.save(source)
    detail = db.service.read(db.context(), playlist_ref=receipt['playlist_id'])['playlist_detail']
    assert [row['local_track_id'] for row in db.state(receipt['playlist_id'])[1]] == ids(source)
    assert detail['library_mix']['scope']['categories'] == [category]



def test_valid_fixed_album_with_no_available_tracks_contributes_none(artist_db):
    db = artist_db
    with db.connect() as con:
        con.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where track_id=any(%s::bigint[])", (db.tracks[:3],))
    from music_app.services.library_browse_postgres import _selected_artist_album_payloads
    with db.connect() as con:
        visible = _selected_artist_album_payloads(actual_artist_browse_rows(con, db), 'Mix Artist 0')
    assert visible and visible[0]['album_id'] == db.albums[0]
    empty = capture(db)
    assert empty['entries'] == []
    assert empty['library_mix']['scope']['album_order'] == [str(db.albums[0])]
    combined = capture(db, selected=scope(db, groups=(0, 1)))
    assert ids(combined) == db.tracks[3:5]
    assert combined['library_mix']['scope']['album_order'] == [str(value) for value in db.albums]
    assert db.total('playlists') == 0


def test_deleted_fixed_album_fails_membership_even_when_another_album_survives(artist_db):
    db = artist_db
    selected = scope(db, groups=(0, 1))
    with db.connect() as con:
        con.execute('delete from library.local_albums where id=%s', (db.albums[0],))
    with pytest.raises(PlaylistError, match='source_changed'):
        capture(db, selected=selected)
    assert db.total('playlists') == 0


@pytest.mark.parametrize('excluded_first_file', [False, True])
def test_file_category_tie_breaker_uses_first_eligible_file_id(artist_db, excluded_first_file):
    import shutil
    from music_app.services.library_browse_postgres import _popular_album_category_sql
    db = artist_db
    with db.connect() as con:
        first = con.execute('select * from library.local_track_files where track_id=%s order by id limit 1', (db.tracks[0],)).fetchone()
        duplicate_path = str(db.root_path / 'category-duplicate.wav')
        shutil.copyfile(first['private_path'], duplicate_path)
        duplicate = con.execute('''insert into library.local_track_files
            (track_id,library_root_id,private_path,content_signature,metadata)
            values(%s,%s,%s,'category-duplicate',%s) returning id''',
            (db.tracks[0], db.root_id, duplicate_path, Jsonb({**first['metadata'], 'library_root_category': 'new_arrivals'}))).fetchone()['id']
        con.execute("update library.local_track_files set metadata=metadata || '{\"library_root_category\":\"hoard\"}' where id=%s", (first['id'],))
        if excluded_first_file:
            con.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,file_entry,exception_type}',%s) where id=%s",
                        (Jsonb(next(iter(NON_ALBUM_EXCEPTION_VALUES))), first['id']))
        category = con.execute(f'''select {_popular_album_category_sql('a.library_id', 'a.id')} as category
            from library.local_albums a where a.library_id=%s and a.id=%s''', (db.library, db.albums[0])).fetchone()['category']
        assert first['id'] < duplicate
        assert category == ('new_arrivals' if excluded_first_file else 'hoard')



def test_actual_browse_and_scoped_category_resolve_path_override_before_track_override(artist_db):
    from music_app.services.library_browse_postgres import (
        _selected_artist_album_payloads, _root_album_browse_album_payloads,
    )
    db = artist_db
    with db.connect() as con:
        con.execute("update library.local_track_files set metadata=metadata || '{\"library_root_category\":\"new_arrivals\"}' where track_id=any(%s::bigint[])", (db.tracks[:3],))
        first = con.execute("update library.local_track_files set metadata=metadata || '{\"library_root_category\":\"hoard\"}' where track_id=%s returning private_path", (db.tracks[0],)).fetchone()
        con.execute('insert into library.exception_overrides(library_id,track_id,override_payload) values(%s,%s,%s)',
                    (db.library, db.tracks[0], Jsonb({'exception_type': next(iter(NON_ALBUM_EXCEPTION_VALUES))})))
        for permit_path, expected in [(False, 'new_arrivals'), (True, 'hoard')]:
            if permit_path:
                con.execute('insert into library.exception_overrides(library_id,track_key,override_payload) values(%s,%s,%s)',
                            (db.library, first['private_path'], Jsonb({'exception_type': ''})))
            full = _selected_artist_album_payloads(actual_artist_browse_rows(con, db), 'Mix Artist 0')
            preview = _root_album_browse_album_payloads(actual_artist_browse_rows(con, db, preview=True), 'Mix Artist 0')
            assert full[0]['root_provenance']['categories'] == preview[0]['root_provenance']['categories'] == [expected]
    selected = scope(db)
    selected['categories'] = ['hoard']
    assert ids(capture(db, selected=selected)) == db.tracks[:2]
