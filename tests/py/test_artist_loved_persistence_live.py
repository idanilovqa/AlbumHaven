"""Artist Loved foundation against the normal fully migrated isolated database.

Uses the unchanged, uniquely owned Playlist fixture and its verified real app
role. These tests do not install migrations, repair schema, emulate connections,
or claim capture/save/refresh behavior before the typed service is implemented.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
from threading import Event
from time import monotonic, sleep
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest

from library_mix_postgres_support import mix_db, mix_urls, MEDIA
from music_app.services import artist_loved_playlists_postgres as loved
from music_app.services.capabilities import capability_keys_for_roles
from music_app.services.current_actor import CapabilityGrant
from music_app.services.owned_playlists import PlaylistError, normalize_playlist_command
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.playlist_native_targets import PlaylistNativeTargets
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.artist_loved_playlists import select_artist_loved_track_ids
from music_app.services.artist_family_postgres import (
    ArtistFamilyIdentityUnavailable, load_artist_family_identity_scope,
)
from music_app.services.library_inventory_postgres import local_inventory_identity_key
from music_app.services.relation_projection_postgres import RELATION_PROJECTION_BUILDER_VERSION
from music_app.services.track_preferences_postgres import load_track_preferences_on_connection


@pytest.fixture
def loved_db(mix_db):
    db = mix_db
    with db.connect() as con:
        # Missing/wrong 0138 is a failed full-schema prerequisite, never a
        # skipped assertion or a reason to alter a historical fixture's cutoff.
        migration = Path(__file__).resolve().parents[2] / "migrations" / "postgres" / "0138_artist_loved_playlists.sql"
        expected = sha256(migration.read_bytes()).hexdigest()
        assert con.execute("select checksum from ops.schema_migrations where migration_name=%s",
                           (migration.name,)).fetchone() == {"checksum": expected}
        con.execute("select playlist_ref from app.playlist_artist_loved_recipes limit 0")
        artists = con.execute("""select id,name,artist_key from library.local_artists
            where library_id=%s order by id""", (db.library,)).fetchall()
        db.artist_ids = [row["id"] for row in artists]
        db.artist_names = {row["id"]: row["name"] for row in artists}
        relation = {"alias_to_canonical": {}, "canonical_to_aliases": {},
                    "family_to_artists": {}, "folder_related": {},
                    "artists": [], "artists_sidebar": [], "sidebar_families": []}
        projection = {"status": "ready", "builder_version": RELATION_PROJECTION_BUILDER_VERSION,
                      "source_fingerprint": db.token, "built_from_fingerprint": db.token}
        con.execute("update library.libraries set metadata=%s where id=%s",
                    (Jsonb({"scan_cache": {"relation_views": relation,
                                          "relation_projection": projection}}), db.library))
        db.other = db.member(con)
        db.foreign_library = con.execute("""insert into library.libraries(owner_account_id,name)
            values(%s,%s) returning id""", (db.accounts[0], "Loved foreign " + db.token)).fetchone()["id"]
    try:
        yield db
    finally:
        with db.connect() as con:
            # The original fixture owns all accounts and its main library.
            # This extension owns only its extra library and related parents.
            con.execute("delete from app.playlists where library_id=%s", (db.foreign_library,))
            con.execute("delete from library.libraries where id=%s", (db.foreign_library,))


def parent(con, db, *, owner=None, library=None):
    ref = uuid4()
    con.execute("""insert into app.playlists(ref,owner_account_id,library_id,title)
        values(%s,%s,%s,'Artist Loves foundation')""",
        (ref, db.owner.account_id if owner is None else owner,
         db.library if library is None else library))
    return ref


def insert_recipe(con, db, ref, **changes):
    values = {"playlist_ref": ref, "library_id": db.library,
              "owner_account_id": db.owner.account_id, "recipe_version": 1,
              "root_artist_id": db.artist_ids[0], "scope_mode": "artist",
              "playback_order": "regular", "last_evaluated_at": db.now,
              "root_state": "present", "retired_at": None, **changes}
    con.execute("""insert into app.playlist_artist_loved_recipes
        (playlist_ref,library_id,owner_account_id,recipe_version,root_artist_id,
         scope_mode,playback_order,last_evaluated_at,root_state,retired_at)
        values(%(playlist_ref)s,%(library_id)s,%(owner_account_id)s,%(recipe_version)s,
         %(root_artist_id)s,%(scope_mode)s,%(playback_order)s,%(last_evaluated_at)s,
         %(root_state)s,%(retired_at)s)""", values)


def test_parent_owner_and_library_are_enforced_by_one_composite_foreign_key(loved_db):
    db = loved_db
    with db.connect() as con:
        ref = parent(con, db)
        for changes in ({"owner_account_id": db.other.account_id},
                        {"library_id": db.foreign_library},
                        {"playlist_ref": uuid4()}):
            with pytest.raises(psycopg.errors.ForeignKeyViolation):
                with con.transaction():
                    insert_recipe(con, db, ref, **changes)
        insert_recipe(con, db, ref)
        with pytest.raises(psycopg.errors.UniqueViolation):
            with con.transaction():
                insert_recipe(con, db, ref)
        # Prove the parent binding also prevents owner/library drift later.
        for column, value in (("owner_account_id", db.other.account_id),
                              ("library_id", db.foreign_library)):
            with pytest.raises(psycopg.errors.ForeignKeyViolation):
                with con.transaction():
                    con.execute(f"update app.playlists set {column}=%s where ref=%s", (value, ref))


def test_active_identity_is_exact_owner_library_root_and_mode_not_playback(loved_db):
    db = loved_db
    with db.connect() as con:
        first, duplicate = parent(con, db), parent(con, db)
        insert_recipe(con, db, first)
        for order in ("regular", "shuffle", "unplayed_first"):
            with pytest.raises(psycopg.errors.UniqueViolation):
                with con.transaction():
                    insert_recipe(con, db, duplicate, playback_order=order)
        variants = [
            (parent(con, db), {"scope_mode": "family"}),
            (parent(con, db), {"root_artist_id": db.artist_ids[1]}),
            (parent(con, db, owner=db.other.account_id), {"owner_account_id": db.other.account_id}),
            (parent(con, db, library=db.foreign_library), {"library_id": db.foreign_library}),
        ]
        for ref, changes in variants:
            insert_recipe(con, db, ref, **changes)
        assert con.execute("""select count(*) as n from app.playlist_artist_loved_recipes
            where library_id=any(%s) and retired_at is null""",
            ([db.library, db.foreign_library],)).fetchone()["n"] == 5


def test_soft_delete_retirement_releases_slot_without_rewriting_old_provenance(loved_db):
    db = loved_db
    with db.connect() as con:
        old, new = parent(con, db), parent(con, db)
        insert_recipe(con, db, old)
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        # This is the schema-level transaction the future mutation owner must
        # use, not a claim that its unimplemented soft-delete hook already runs.
        con.execute("update app.playlists set deleted_at=%s where ref=%s", (db.now, old))
        con.execute("update app.playlist_artist_loved_recipes set retired_at=%s where playlist_ref=%s",
                    (db.now, old))
        insert_recipe(con, db, new, playback_order="shuffle")
        with pytest.raises(psycopg.errors.UniqueViolation):
            with con.transaction():
                con.execute("update app.playlist_artist_loved_recipes set retired_at=null where playlist_ref=%s", (old,))
    with db.connect() as con:
        rows = con.execute("""select playlist_ref,root_artist_id,scope_mode,retired_at
            from app.playlist_artist_loved_recipes where playlist_ref=any(%s::uuid[])
            order by retired_at nulls first""", ([old, new],)).fetchall()
        assert rows == [
            {"playlist_ref": new, "root_artist_id": db.artist_ids[0], "scope_mode": "artist", "retired_at": None},
            {"playlist_ref": old, "root_artist_id": db.artist_ids[0], "scope_mode": "artist", "retired_at": db.now},
        ]


def test_inventory_deletion_retains_numeric_root_until_parent_is_deleted(loved_db):
    db = loved_db
    with db.connect() as con:
        ref = parent(con, db)
        insert_recipe(con, db, ref)
        original = con.execute("select name,artist_key from library.local_artists where id=%s",
                               (db.artist_ids[0],)).fetchone()
        con.execute("delete from library.local_artists where id=%s", (db.artist_ids[0],))
        replacement = con.execute("""insert into library.local_artists(library_id,name,artist_key)
            values(%s,%s,%s) returning id""",
            (db.library, original["name"], original["artist_key"])).fetchone()["id"]
        con.execute("""update app.playlist_artist_loved_recipes set root_state='root_missing'
            where playlist_ref=%s""", (ref,))
        row = con.execute("""select root_artist_id,root_state from app.playlist_artist_loved_recipes
            where playlist_ref=%s""", (ref,)).fetchone()
        assert row == {"root_artist_id": db.artist_ids[0], "root_state": "root_missing"}
        assert row["root_artist_id"] != replacement
        con.execute("delete from app.playlists where ref=%s", (ref,))
        assert con.execute("select count(*) as n from app.playlist_artist_loved_recipes where playlist_ref=%s",
                           (ref,)).fetchone()["n"] == 0


@pytest.mark.parametrize("field,bad", [
    ("recipe_version", 0), ("recipe_version", 2), ("root_artist_id", 0), ("root_artist_id", -1),
    ("scope_mode", "library"), ("scope_mode", "Artist"), ("playback_order", "popular_first"),
    ("root_state", "unavailable"), ("last_evaluated_at", "infinity"),
    ("last_evaluated_at", "-infinity"), ("retired_at", "infinity"),
])
def test_recipe_schema_rejects_invalid_durable_states(loved_db, field, bad):
    db = loved_db
    with db.connect() as con:
        ref = parent(con, db)
        with pytest.raises(psycopg.errors.CheckViolation):
            with con.transaction():
                insert_recipe(con, db, ref, **{field: bad})


@pytest.mark.parametrize("field", ["playlist_ref", "library_id", "owner_account_id", "recipe_version",
                                  "root_artist_id", "scope_mode", "playback_order",
                                  "last_evaluated_at", "root_state"])
def test_recipe_schema_requires_every_durable_identity_and_state_field(loved_db, field):
    db = loved_db
    with db.connect() as con:
        ref = parent(con, db)
        with pytest.raises(psycopg.errors.NotNullViolation):
            with con.transaction():
                insert_recipe(con, db, ref, **{field: None})


def test_actual_runtime_role_can_insert_refresh_retire_but_not_rewrite_identity(loved_db):
    db = loved_db
    with db.connect() as con:
        ref = parent(con, db)
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        # mix_urls verifies the real runtime role, no SET ROLE or fake grants.
        authority = con.execute("""select
            pg_has_role(current_user,'album_haven_app','USAGE') as app,
            pg_has_role(current_user,'album_haven_migrator','MEMBER') as migrator,
            exists(select 1 from pg_roles where pg_has_role(current_user,oid,'MEMBER')
                and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) as elevated""").fetchone()
        assert authority == {"app": True, "migrator": False, "elevated": False}
        insert_recipe(con, db, ref)
        for column in ("playlist_ref", "library_id", "owner_account_id", "recipe_version",
                       "root_artist_id", "scope_mode"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with con.transaction():
                    con.execute(f"update app.playlist_artist_loved_recipes set {column}={column} where playlist_ref=%s", (ref,))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with con.transaction():
                con.execute("delete from app.playlist_artist_loved_recipes where playlist_ref=%s", (ref,))
        con.execute("""update app.playlist_artist_loved_recipes set playback_order='unplayed_first',
            last_evaluated_at=%s,root_state='root_missing',retired_at=%s where playlist_ref=%s""",
            (db.now + timedelta(seconds=1), db.now, ref))
        actual = con.execute("""select playback_order,last_evaluated_at,root_state,retired_at
            from app.playlist_artist_loved_recipes where playlist_ref=%s""", (ref,)).fetchone()
        assert actual == {"playback_order": "unplayed_first", "last_evaluated_at": db.now + timedelta(seconds=1),
                          "root_state": "root_missing", "retired_at": db.now}
    with db.connect() as con:
        assert con.execute("""select has_table_privilege('album_haven_readonly',
            'app.playlist_artist_loved_recipes','SELECT') as allowed""").fetchone()["allowed"] is False
        public = con.execute("""select count(*) as n from pg_class c
            cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
            where c.oid='app.playlist_artist_loved_recipes'::regclass and a.grantee=0""").fetchone()
        assert public["n"] == 0


def test_new_source_protocol_keeps_library_kind_pairing(loved_db):
    db = loved_db
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        for kind, accepted in (("library", True), ("activity", False), ("playlist", False)):
            values = (uuid4(), uuid4(), db.owner.account_id, db.owner.session_id,
                      db.library, kind, db.now + timedelta(minutes=5))
            sql = """insert into app.playlist_creation_sources
                (ref,revision,actor_account_id,session_id,library_id,source_kind,
                 protocol,inventory_upper_id,expires_at)
                values(%s,%s,%s,%s,%s,%s,'artist_loved_selection_v1',0,%s)"""
            if accepted:
                con.execute(sql, values)
            else:
                with pytest.raises(psycopg.errors.CheckViolation):
                    with con.transaction():
                        con.execute(sql, values)


@pytest.mark.parametrize("kind,protocol", [
    ("library", "library_selection_v1"), ("library", "complete_inventory_selection_v1"),
    ("library", "library_mix_selection_v1"), ("library", "artist_popular_selection_v1"),
    ("activity", "complete_activity_selection_v1"), ("activity", "missing_activity_selection_v1"),
    ("playlist", "missing_playlist_selection_v1"),
])
def test_schema_retains_existing_source_protocol_pairs(loved_db, kind, protocol):
    db = loved_db
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        con.execute("""insert into app.playlist_creation_sources
            (ref,revision,actor_account_id,session_id,library_id,source_kind,
             protocol,inventory_upper_id,expires_at)
            values(%s,%s,%s,%s,%s,%s,%s,0,%s)""",
            (uuid4(), uuid4(), db.owner.account_id, db.owner.session_id, db.library,
             kind, protocol, db.now + timedelta(minutes=5)))


def test_loved_item_protocol_only_admits_library_origin(loved_db):
    db = loved_db
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        ref = parent(con, db)
        for kind in ("activity", "playlist"):
            with pytest.raises(psycopg.errors.CheckViolation):
                with con.transaction():
                    con.execute("""insert into app.playlist_items
                        (ref,playlist_ref,library_id,position,original_local_track_id,
                         local_track_id,source_kind,source_protocol)
                        values(%s,%s,%s,1,%s,%s,%s,'artist_loved_selection_v1')""",
                        (uuid4(), ref, db.library, db.tracks[0], db.tracks[0], kind))
        con.execute("""insert into app.playlist_items
            (ref,playlist_ref,library_id,position,original_local_track_id,
             local_track_id,source_kind,source_protocol)
            values(%s,%s,%s,1,%s,%s,'library','artist_loved_selection_v1')""",
            (uuid4(), ref, db.library, db.tracks[0], db.tracks[0]))
        assert con.execute("""select source_kind,source_protocol from app.playlist_items
            where playlist_ref=%s""", (ref,)).fetchone() == {
                "source_kind": "library", "source_protocol": "artist_loved_selection_v1"}


@pytest.mark.parametrize("kind,protocol", [
    ("library", None), ("activity", None), ("playlist", None),
    ("library", "library_selection_v1"), ("library", "complete_inventory_selection_v1"),
    ("library", "library_mix_selection_v1"), ("library", "artist_popular_selection_v1"),
    ("activity", "complete_activity_selection_v1"), ("activity", "missing_activity_selection_v1"),
    ("playlist", "missing_playlist_selection_v1"), ("playlist", "playlist_copy_v1"),
])
def test_schema_retains_existing_item_protocols_and_unknown_legacy_provenance(loved_db, kind, protocol):
    db = loved_db
    missing = protocol in ("missing_activity_selection_v1", "missing_playlist_selection_v1")
    receipt = [uuid4(), uuid4(), uuid4()] if missing else [None, None, None]
    lineage = Jsonb({"playlist_ref": str(uuid4()), "playlist_item_ref": str(uuid4()),
                     "playlist_revision": "1"}) if protocol == "playlist_copy_v1" else None
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        ref = parent(con, db)
        con.execute("""insert into app.playlist_items
            (ref,playlist_ref,library_id,position,original_local_track_id,local_track_id,
             source_kind,source_protocol,source_ref,source_entry_ref,source_revision,source_lineage)
            values(%s,%s,%s,1,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (uuid4(), ref, db.library, db.tracks[0], db.tracks[0], kind, protocol, *receipt, lineage))
        assert con.execute("select source_protocol from app.playlist_items where playlist_ref=%s",
                           (ref,)).fetchone()["source_protocol"] == protocol


def test_own_loved_and_obsessed_use_canonical_account_library_preference_owner(loved_db):
    db = loved_db
    with db.connect() as con:
        rows = con.execute("""select t.id,t.track_key,min(f.private_path) as path
            from library.local_tracks t join library.local_track_files f on f.track_id=t.id
            where t.library_id=%s group by t.id,t.track_key order by t.id""", (db.library,)).fetchall()
        for account, index, tier, rating, use_path in (
            (db.owner.account_id, 0, "loved", None, True),
            (db.owner.account_id, 1, "obsessed", None, False),
            (db.owner.account_id, 2, "off", 5, False),
            (db.other.account_id, 3, "obsessed", 5, False),
        ):
            row = rows[index]
            con.execute("""insert into app.track_preferences
                (account_id,library_id,track_key,rating,love_tier) values(%s,%s,%s,%s,%s)""",
                (account, db.library, row["path"] if use_path else row["track_key"], rating, tier))
        # Same request alias in another library and a legacy unscoped row must
        # not become the current actor's taste in this library.
        for library in (db.foreign_library, None):
            con.execute("""insert into app.track_preferences
                (account_id,library_id,track_key,love_tier) values(%s,%s,%s,'loved')""",
                (db.owner.account_id, library, rows[4]["track_key"]))
    refs = [value for row in rows for value in (row["track_key"], row["path"])]
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        canonical = load_track_preferences_on_connection(
            con, refs, account_id=db.owner.account_id, library_id=db.library)
        friend = load_track_preferences_on_connection(
            con, refs, account_id=db.other.account_id, library_id=db.library)
    own_tiers = {row["track_id"]: row["love_tier"] for row in canonical.values()}
    friend_tiers = {row["track_id"]: row["love_tier"] for row in friend.values()}
    inventory = [row["id"] for row in rows]
    assert select_artist_loved_track_ids(inventory, own_tiers) == tuple(db.tracks[:2])
    assert select_artist_loved_track_ids(inventory, friend_tiers) == (db.tracks[3],)
    assert canonical[rows[0]["path"]]["preference_id"] == canonical[rows[0]["track_key"]]["preference_id"]


def test_ambiguous_canonical_alias_history_is_excluded_without_new_favorites_authority(loved_db):
    db = loved_db
    with db.connect() as con:
        row = con.execute("""select t.track_key,min(f.private_path) as path
            from library.local_tracks t join library.local_track_files f on f.track_id=t.id
            where t.id=%s group by t.track_key""", (db.tracks[0],)).fetchone()
        for key in (row["track_key"], row["path"]):
            con.execute("""insert into app.track_preferences(account_id,library_id,track_key,love_tier)
                values(%s,%s,%s,'obsessed')""", (db.owner.account_id, db.library, key))
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        canonical = load_track_preferences_on_connection(
            con, [row["track_key"], row["path"]], account_id=db.owner.account_id, library_id=db.library)
    assert canonical == {}
    assert select_artist_loved_track_ids(db.tracks[:1], {}) == ()


def family_scope(con, db, *, root=None, mode="family", denied=(), checked=None):
    def readable(identity):
        if checked is not None:
            checked.append(identity)
        return identity not in denied
    return load_artist_family_identity_scope(
        con, library_id=db.library, root_artist_id=db.artist_ids[0] if root is None else root,
        scope_mode=mode, is_artist_readable=readable)


def add_family_link(con, db, root, related, *, source="folder_derived_runtime", weight=1):
    con.execute("""insert into library.local_artist_family_links
        (library_id,artist_id,related_artist_id,relationship_weight,source_family,source_ref)
        values(%s,%s,%s,%s,%s,'relation_views.folder_related')""",
        (db.library, root, related, weight, source))


def add_artist(con, db, name, *, library=None):
    return con.execute("""insert into library.local_artists(library_id,artist_key,name)
        values(%s,%s,%s) returning id""",
        (db.library if library is None else library, local_inventory_identity_key(name), name)).fetchone()["id"]


def set_aliases(con, db, aliases, canonical):
    con.execute("""update library.libraries set metadata=jsonb_set(jsonb_set(metadata,
        '{scan_cache,relation_views,alias_to_canonical}',%s),
        '{scan_cache,relation_views,canonical_to_aliases}',%s) where id=%s""",
        (Jsonb(aliases), Jsonb(canonical), db.library))


def test_family_reader_uses_exact_current_library_numeric_root_and_direct_link(loved_db):
    db = loved_db
    root, related = db.artist_ids
    with db.connect() as con:
        foreign = add_artist(con, db, db.artist_names[root], library=db.foreign_library)
        add_family_link(con, db, root, related)
        # Multiple projection evidence rows still denote one exact artist.
        add_family_link(con, db, root, related, source="fixture_second_projection", weight=2)
        # The historical relation table has separate artist foreign keys;
        # current-library admission must reject this cross-library endpoint.
        add_family_link(con, db, root, foreign)
    checked = []
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        assert family_scope(con, db, mode="artist") == ((root, "primary_credit"),)
        assert family_scope(con, db, checked=checked) == tuple(sorted(
            ((root, "primary_credit"), (related, "family_credit"))))
        assert family_scope(con, db, root=foreign) is None
        assert family_scope(con, db, root=2**63 - 1) is None
    assert {root, related}.issubset(checked)


def test_fresh_reader_observes_family_addition_and_removal_on_same_transaction(loved_db):
    db = loved_db
    root, related = db.artist_ids
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        first = family_scope(con, db)
        assert first == ((root, "primary_credit"),)
        with db.connect() as writer:
            add_family_link(writer, db, root, related)
        second = family_scope(con, db)
        assert second == tuple(sorted(((root, "primary_credit"), (related, "family_credit"))))
        with db.connect() as writer:
            writer.execute("delete from library.local_artist_family_links where library_id=%s", (db.library,))
        assert family_scope(con, db) == first
    assert second != first


def test_deleted_numeric_root_does_not_rebind_same_name_or_key(loved_db):
    db = loved_db
    root = db.artist_ids[0]
    with db.connect() as con:
        original = con.execute("select name,artist_key from library.local_artists where id=%s", (root,)).fetchone()
        con.execute("delete from library.local_artists where id=%s", (root,))
        replacement = con.execute("""insert into library.local_artists(library_id,name,artist_key)
            values(%s,%s,%s) returning id""",
            (db.library, original["name"], original["artist_key"])).fetchone()["id"]
        # Conclusive absence remains distinct even from an unusable projection.
        con.execute("update library.libraries set metadata='{}' where id=%s", (db.library,))
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        assert family_scope(con, db, root=root) is None
        with pytest.raises(ArtistFamilyIdentityUnavailable):
            family_scope(con, db, root=replacement)


def test_root_denial_is_not_empty_and_precedes_stale_projection(loved_db):
    db = loved_db
    with db.connect() as con:
        con.execute("update library.libraries set metadata='{}' where id=%s", (db.library,))
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        with pytest.raises(PermissionError):
            family_scope(con, db, denied=db.artist_ids)
        with pytest.raises(ArtistFamilyIdentityUnavailable):
            family_scope(con, db)


def test_denied_related_identity_is_excluded_and_every_returned_artist_is_checked(loved_db):
    db = loved_db
    root, related = db.artist_ids
    with db.connect() as con:
        add_family_link(con, db, root, related)
    checked = []
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        result = family_scope(con, db, denied=(related,), checked=checked)
    assert result == ((root, "primary_credit"),)
    assert root in checked and related in checked


def test_primary_aliases_are_exact_ids_and_family_overlap_keeps_primary_basis(loved_db):
    db = loved_db
    root, related = db.artist_ids
    name = db.artist_names[root]
    with db.connect() as con:
        alias_name = "Alias " + db.token
        alias = add_artist(con, db, alias_name)
        set_aliases(con, db, {alias_name: name}, {name: [name, alias_name]})
        add_family_link(con, db, root, alias)
        add_family_link(con, db, alias, related)
    expected_primary = ((root, "primary_credit"), (alias, "primary_credit"))
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        assert family_scope(con, db, mode="artist") == tuple(sorted(expected_primary))
        assert family_scope(con, db) == tuple(sorted((*expected_primary, (related, "family_credit"))))
        assert family_scope(con, db, mode="artist", denied=(alias,)) == ((root, "primary_credit"),)


def test_collaboration_root_stays_distinct_and_featured_alias_does_not_widen_family(loved_db):
    db = loved_db
    root = db.artist_ids[0]
    name = db.artist_names[root]
    with db.connect() as con:
        # Normalize this owned row's key so an erroneous canonical expansion
        # would visibly include it when selecting the collaboration root.
        con.execute("update library.local_artists set artist_key=%s where id=%s",
                    (local_inventory_identity_key(name), root))
        featured_name, collaboration_name = name + " feat. Guest", name + " & Guest"
        featured = add_artist(con, db, featured_name)
        collaboration = add_artist(con, db, collaboration_name)
        set_aliases(con, db, {featured_name: name, collaboration_name: name},
                    {name: [name, featured_name, collaboration_name]})
        add_family_link(con, db, root, featured)
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        assert family_scope(con, db, mode="artist") == ((root, "primary_credit"),)
        result = family_scope(con, db)
        assert featured not in dict(result)
        assert result == tuple(sorted(((root, "primary_credit"), (collaboration, "family_credit"))))
        assert family_scope(con, db, root=collaboration, mode="artist") == ((collaboration, "primary_credit"),)
        assert family_scope(con, db, root=collaboration) == ((collaboration, "primary_credit"),)


@pytest.mark.parametrize("kind", ["missing", "stale", "bad_canonical", "bad_alias_list", "ambiguous_alias"])
def test_unusable_relationship_projection_never_becomes_valid_empty_family(loved_db, kind):
    db = loved_db
    root_name = db.artist_names[db.artist_ids[0]]
    with db.connect() as con:
        if kind == "missing":
            con.execute("update library.libraries set metadata='{}' where id=%s", (db.library,))
        elif kind == "stale":
            con.execute("""update library.libraries set metadata=jsonb_set(metadata,
                '{scan_cache,relation_projection,built_from_fingerprint}',%s) where id=%s""",
                (Jsonb("old-" + db.token), db.library))
        elif kind == "bad_canonical":
            set_aliases(con, db, {root_name: []}, {})
        elif kind == "bad_alias_list":
            set_aliases(con, db, {}, {root_name: "not-an-array"})
        else:
            set_aliases(con, db, {root_name: "First Canonical", root_name.upper(): "Second Canonical"}, {})
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        with pytest.raises(ArtistFamilyIdentityUnavailable):
            family_scope(con, db)


@pytest.mark.parametrize("field,bad", [
    ("library_id", True), ("library_id", 0), ("library_id", "1"),
    ("root_artist_id", False), ("root_artist_id", -1), ("root_artist_id", "1"),
    ("root_artist_id", 2**63), ("scope_mode", "library"), ("is_artist_readable", None),
])
def test_family_reader_requires_normalized_identity_and_explicit_authority(loved_db, field, bad):
    db = loved_db
    values = {"library_id": db.library, "root_artist_id": db.artist_ids[0],
              "scope_mode": "artist", "is_artist_readable": lambda _identity: True, field: bad}
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        with pytest.raises(ValueError):
            load_artist_family_identity_scope(con, **values)


def test_family_reader_requires_caller_transaction_and_exact_true_authority(loved_db):
    db = loved_db
    with psycopg.connect(db.app_url, row_factory=dict_row, autocommit=True) as con:
        with pytest.raises(ValueError):
            family_scope(con, db)
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        with pytest.raises(PermissionError):
            load_artist_family_identity_scope(con, library_id=db.library,
                root_artist_id=db.artist_ids[0], scope_mode="artist",
                is_artist_readable=lambda _identity: 1)


def test_database_failure_is_not_reported_as_missing_root(loved_db):
    db = loved_db
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        con.close()
        with pytest.raises(psycopg.OperationalError):
            family_scope(con, db)


@pytest.mark.parametrize("expansion,mode", [("root", "artist"), ("root", "family"), ("related", "family")])
def test_ambiguous_expanded_alias_fails_before_returning_mixed_identity_scope(loved_db, expansion, mode):
    db = loved_db
    root, related = db.artist_ids
    canonical = db.artist_names[root if expansion == "root" else related]
    alias_name = "Expanded Alias " + db.token
    with db.connect() as con:
        add_artist(con, db, alias_name)
        set_aliases(con, db,
                    {alias_name: canonical, alias_name.lower(): "Conflicting Canonical " + db.token},
                    {canonical: [canonical, alias_name]})
        if expansion == "related":
            add_family_link(con, db, root, related)
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        with pytest.raises(ArtistFamilyIdentityUnavailable):
            family_scope(con, db, mode=mode)


@pytest.mark.parametrize("expansion,mode", [("root", "artist"), ("root", "family"), ("related", "family")])
@pytest.mark.parametrize("normalized_spelling", [False, True])
def test_expanded_alias_with_conflicting_forward_owner_is_unavailable(loved_db, expansion, mode, normalized_spelling):
    db = loved_db
    root, related = db.artist_ids
    canonical = db.artist_names[root if expansion == "root" else related]
    alias_name, other_name = "Expanded Alias " + db.token, "Other Canonical " + db.token
    with db.connect() as con:
        add_artist(con, db, alias_name)
        add_artist(con, db, other_name)
        forward_name = alias_name.lower() if normalized_spelling else alias_name
        set_aliases(con, db, {forward_name: other_name}, {canonical: [canonical, alias_name]})
        if expansion == "related":
            add_family_link(con, db, root, related)
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        with pytest.raises(ArtistFamilyIdentityUnavailable):
            family_scope(con, db, mode=mode)


@pytest.mark.parametrize("expansion", ["root", "related"])
def test_expanded_alias_without_forward_entry_remains_admitted(loved_db, expansion):
    db = loved_db
    root, related = db.artist_ids
    canonical = db.artist_names[root if expansion == "root" else related]
    alias_name = "Expanded Alias " + db.token
    with db.connect() as con:
        alias = add_artist(con, db, alias_name)
        set_aliases(con, db, {}, {canonical: [canonical, alias_name]})
        if expansion == "related":
            add_family_link(con, db, root, related)
    expected = {root: "primary_credit", alias: "primary_credit"}
    if expansion == "related":
        expected.update({related: "family_credit", alias: "family_credit"})
    with psycopg.connect(db.app_url, row_factory=dict_row) as con:
        assert family_scope(con, db) == tuple(sorted(expected.items()))


# Group 2: ordinary source/receipt/refresh ownership, with actual SQL authority.
@pytest.fixture
def loved_flow_db(loved_db):
    db = loved_db
    with db.connect() as con:
        for album, artist in zip(db.albums, db.artist_ids):
            con.execute("""insert into library.local_album_featured_artists
                (library_id,album_id,artist_id,featured_kind) values(%s,%s,%s,'owner')""",
                (db.library, album, artist))
    return db


def taste(db, indices, tier="loved", *, actor=None):
    """Write only this fixture's canonical scoped preference rows, no new store."""
    account = (actor or db.owner).account_id
    with db.connect() as con:
        for index in indices:
            key = con.execute("select track_key from library.local_tracks where id=%s",
                              (db.tracks[index],)).fetchone()["track_key"]
            row = con.execute("""select id from app.track_preferences
                where account_id=%s and library_id=%s and track_key=%s""",
                (account, db.library, key)).fetchone()
            if row is None:
                con.execute("""insert into app.track_preferences(account_id,library_id,track_key,love_tier)
                    values(%s,%s,%s,%s)""", (account, db.library, key, tier))
            else:
                con.execute("update app.track_preferences set love_tier=%s where id=%s", (tier, row["id"]))


def loved_capture(db, *, root=None, mode="artist", actor=None, service=None, constraints=None):
    return loved.capture(service or db.service, db.context(actor), {
        "version": 1, "root_artist_id": str(db.artist_ids[0] if root is None else root),
        "scope_mode": mode}, constraints=constraints)["data"]


def loved_read_source(db, source, *, actor=None, service=None, constraints=None):
    return loved.read_capture(service or db.service, db.context(actor), source["source"]["ref"],
        source["source"]["revision"], constraints=constraints)["data"]


def loved_queue(db, source, *, actor=None, service=None, refs=None, constraints=None):
    refs = [row["entry_ref"] for row in source["entries"]] if refs is None else refs
    return loved.native_queue(service or db.service, db.context(actor), {
        "source_ref": source["source"]["ref"], "source_revision": source["source"]["revision"],
        "entry_refs": refs, "starting_entry_ref": refs[0] if refs else str(uuid4())},
        constraints=constraints, media_resolver=db.media_resolver)


def loved_save(db, source=None, *, actor=None, **changes):
    source = source if source is not None else loved_capture(db, actor=actor)
    command = db.create_command(source, title="Artist Loves", **changes)
    return db.service.execute(db.context(actor), command), command, source


def source_track_ids(source):
    return [int(row["inventory_track_ref"].rsplit(":", 1)[1]) for row in source["entries"]]


def loved_state(db, ref):
    with db.connect() as con:
        playlist = dict(con.execute("select * from app.playlists where ref=%s", (ref,)).fetchone())
        items = con.execute("select * from app.playlist_items where playlist_ref=%s order by position", (ref,)).fetchall()
        recipe = con.execute("select * from app.playlist_artist_loved_recipes where playlist_ref=%s", (ref,)).fetchone()
    return playlist, items, recipe


def loved_counts(db):
    with db.connect() as con:
        return {table: con.execute(f"select count(*) as n from app.{table} where library_id=%s",
                                  (db.library,)).fetchone()["n"] for table in (
            "playlists", "playlist_items", "playlist_operations", "playlist_artist_loved_recipes",
            "playlist_creation_sources")}


def new_session(db):
    with db.connect() as con:
        session = con.execute("""insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,%s,%s,%s,%s,%s) returning id""", (
                db.owner.account_id, sha256(uuid4().bytes).digest(), db.now, db.now, db.now,
                db.now + timedelta(hours=3), db.now + timedelta(days=1))).fetchone()["id"]
    return replace(db.owner, session_id=session)


def add_media(db):
    with db.connect() as con:
        con.execute("""insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
            values(%s,%s,'library',%s)""", (db.owner.account_id, MEDIA, db.library))
    db.owner = replace(db.owner, capability_grants=(
        *db.owner.capability_grants, CapabilityGrant(MEDIA, "library", db.library)))


def deny_resource(kind, identity, *, action="library.browse.read"):
    def constraints(context):
        denied = (context.action == action and context.resource is not None
                  and context.resource.resource_kind == kind
                  and context.resource.resource_ref == str(identity))
        return PolicyEvaluationConstraints(deployment_allowed=not denied)
    return constraints


class ObservedSQL:
    """Transparent observer: PostgreSQL still executes every production statement."""
    def __init__(self, real, before=None, after=None):
        self.real, self.before, self.after = real, before, after
    def __getattr__(self, name):
        return getattr(self.real, name)
    def execute(self, sql, params=None):
        if self.before:
            self.before(self.real, str(sql), params)
        result = self.real.execute(sql, params)
        if self.after:
            self.after(self.real, str(sql), params)
        return result


def observing_service(db, *, before=None, after=None):
    @contextmanager
    def connect(url):
        # Bound failures, including failed barrier assertions, cannot leave a
        # waiting worker indefinitely holding the fixture's account lock.
        with psycopg.connect(url, row_factory=dict_row,
                options="-c lock_timeout=8000 -c statement_timeout=12000") as con:
            yield ObservedSQL(con, before, after)
    return PostgresOwnedPlaylistsService(db.config, connect=connect, clock=lambda: db.clock_time)


def test_capture_uses_own_combined_taste_and_never_popularity(loved_flow_db):
    db = loved_flow_db
    taste(db, [0, 3])
    taste(db, [1], "obsessed")
    taste(db, [2], actor=db.other)
    with db.connect() as con:
        add_family_link(con, db, *db.artist_ids)
    statements = []
    service = observing_service(db, before=lambda _con, sql, _params: statements.append(sql.lower()))
    source = loved_capture(db, mode="family", service=service)
    assert source_track_ids(source) == [db.tracks[i] for i in (0, 1, 3)]
    assert source["source_protocol"] == "artist_loved_selection_v1"
    assert source["artist_loved"] == {"version": 1, "source": "artist_loved",
        "root_artist_id": str(db.artist_ids[0]), "scope_mode": "family",
        "auto_update": True, "playback_order": "regular"}
    assert source["entries_complete"] is True and source["allowed_actions"]["can_use_for_playlist"] is True
    assert all(row["play_count"] == 0 for row in source["entries"])
    assert not any("popularity" in sql or "provider_mapping" in sql for sql in statements)
    assert any("app.track_preferences" in sql for sql in statements)
    assert loved_counts(db)["playlists"] == 0


def test_capture_snapshot_read_save_and_native_do_not_reselect_taste(loved_flow_db):
    db = loved_flow_db
    taste(db, [0, 1])
    add_media(db)
    source = loved_capture(db, mode="family")
    taste(db, [0], "off")
    taste(db, [2, 3])
    with db.connect() as con:
        add_family_link(con, db, *db.artist_ids)
    assert loved_read_source(db, source)["entries"] == source["entries"]
    queue = loved_queue(db, source)
    assert [row["playlist_item_id"] for row in queue["tracks"]] == [row["entry_ref"] for row in source["entries"]]
    receipt, _, _ = loved_save(db, source)
    assert receipt["creation_outcome"] == "created" and receipt["added_count"] == 2
    assert [row["local_track_id"] for row in loved_state(db, receipt["playlist_id"])[1]] == db.tracks[:2]
    detail = db.service.read(db.context(), playlist_ref=receipt["playlist_id"])["playlist_detail"]
    assert detail["artist_loved"]["refresh_status"] == "current"
    assert [row["local_track_id"] for row in loved_state(db, receipt["playlist_id"])[1]] == [db.tracks[i] for i in (1, 2, 3)]


def test_empty_capture_saves_dynamic_recipe_then_first_love_grows_same_playlist(loved_flow_db):
    db = loved_flow_db
    source = loved_capture(db)
    assert source["entries"] == [] and source["entries_complete"] is True
    assert source["allowed_actions"] == {"can_read": True, "can_use_for_playlist": True, "can_play": False}
    with pytest.raises(PlaylistError, match="invalid_command"):
        loved_queue(db, source)
    receipt, _, _ = loved_save(db, source)
    before = loved_state(db, receipt["playlist_id"])
    assert before[1] == [] and before[2]["root_artist_id"] == db.artist_ids[0]
    assert receipt["creation_outcome"] == "created" and receipt["added_count"] == 0
    taste(db, [1], "obsessed")
    detail = db.service.read(db.context(), playlist_ref=receipt["playlist_id"])["playlist_detail"]
    after = loved_state(db, receipt["playlist_id"])
    assert detail["playlist_kind"] == "artist_loved"
    assert detail["artist_loved"]["root_state"] == "present"
    assert [row["local_track_id"] for row in after[1]] == [db.tracks[1]]
    assert after[0]["ref"] == before[0]["ref"] and after[0]["revision"] == 2
    assert loved_counts(db)["playlists"] == loved_counts(db)["playlist_operations"] == 1


@pytest.mark.parametrize("tamper", ["subset", "reverse", "foreign", "revision", "protocol"])
def test_save_requires_exact_retained_snapshot(loved_flow_db, tamper):
    db = loved_flow_db
    taste(db, [0, 1])
    source, other = loved_capture(db), loved_capture(db)
    command = db.create_command(source)
    if tamper == "subset": command.data["entry_refs"].pop()
    elif tamper == "reverse": command.data["entry_refs"].reverse()
    elif tamper == "foreign": command.data["entry_refs"][0] = other["entries"][0]["entry_ref"]
    elif tamper == "revision": command.data["source"]["revision"] = str(uuid4())
    else: command.data["source_protocol"] = "library_selection_v1"
    before = loved_counts(db)
    with pytest.raises(PlaylistError, match="source_changed"):
        db.service.execute(db.context(), command)
    assert loved_counts(db) == before


@pytest.mark.parametrize("retirement", ["expired", "deleted"])
def test_exact_original_session_replay_precedes_family_taste_recipe_and_source(loved_flow_db, retirement):
    db = loved_flow_db
    taste(db, [0, 1])
    receipt, command, source = loved_save(db, loved_capture(db, mode="family"), mix_playback_order="unplayed_first")
    before = loved_state(db, receipt["playlist_id"])
    taste(db, [0, 1], "off")
    with db.connect() as con:
        add_family_link(con, db, *db.artist_ids)
        if retirement == "expired":
            con.execute("update app.playlist_creation_sources set expires_at=%s where ref=%s", (db.clock_time, source["source"]["ref"]))
        else:
            con.execute("delete from app.playlist_creation_sources where ref=%s", (source["source"]["ref"],))
        # Even an unusable projection cannot reinterpret a committed receipt.
        con.execute("""update library.libraries set metadata=jsonb_set(metadata,
            '{scan_cache,relation_projection,status}','\"stale\"') where id=%s""", (db.library,))
    statements = []
    service = observing_service(db, before=lambda _con, sql, _params: statements.append(sql.lower()))
    assert service.execute(db.context(), command) == receipt
    assert service.read_operation(db.context(), command.request_key) == {"status": "committed", "receipt": receipt}
    assert loved_state(db, receipt["playlist_id"]) == before
    # Operation recovery uses the same key/command, never a guessed new key.
    forbidden = ("app.playlist_creation_sources", "app.track_preferences", "local_artist_family_links", "app.playlist_artist_loved_recipes")
    assert not any(table in sql for sql in statements for table in forbidden)
    changed = deepcopy(command)
    changed.data["mix_playback_order"] = "shuffle"
    with pytest.raises(PlaylistError, match="idempotency_key_reused"):
        service.execute(db.context(), changed)


def test_new_session_cannot_replay_but_fresh_source_key_finds_business_duplicate(loved_flow_db):
    db = loved_flow_db
    taste(db, [0])
    original, command, source = loved_save(db, mix_playback_order="shuffle")
    before = loved_state(db, original["playlist_id"])
    actor = new_session(db)
    for call in (lambda: loved_read_source(db, source, actor=actor),
                 lambda: loved_queue(db, source, actor=actor),
                 lambda: db.service.execute(db.context(actor), db.create_command(source))):
        with pytest.raises(PlaylistError, match="source_unavailable"):
            call()
    with pytest.raises(PlaylistError, match="operation_unavailable"):
        db.service.execute(db.context(actor), command)
    assert db.service.read_operation(db.context(actor), command.request_key) == {"status": "unknown"}
    taste(db, [1])
    fresh = loved_capture(db, actor=actor)
    duplicate_command = db.create_command(fresh, title="Must not replace", mix_playback_order="regular")
    duplicate = db.service.execute(db.context(actor), duplicate_command)
    assert duplicate["playlist_id"] == original["playlist_id"]
    assert duplicate["creation_outcome"] == "existing" and duplicate["changed"] is False and duplicate["added_count"] == 0
    assert duplicate["request_key"] == duplicate_command.request_key != command.request_key
    assert loved_state(db, original["playlist_id"]) == before
    assert db.service.read_operation(db.context(actor), duplicate_command.request_key)["receipt"] == duplicate
    assert loved_counts(db)["playlists"] == 1 and loved_counts(db)["playlist_operations"] == 2


def test_duplicate_identity_separates_modes_and_owners_not_title_or_playback(loved_flow_db):
    db = loved_flow_db
    taste(db, [0])
    artist, _, _ = loved_save(db)
    duplicate, _, _ = loved_save(db, loved_capture(db), mix_playback_order="unplayed_first")
    family, _, _ = loved_save(db, loved_capture(db, mode="family"))
    other, _, _ = loved_save(db, loved_capture(db, actor=db.other), actor=db.other)
    assert duplicate["playlist_id"] == artist["playlist_id"] and duplicate["creation_outcome"] == "existing"
    assert len({artist["playlist_id"], family["playlist_id"], other["playlist_id"]}) == 3


def test_soft_delete_retires_slot_but_old_receipt_stays_historical(loved_flow_db):
    db = loved_flow_db
    taste(db, [0])
    original, command, _ = loved_save(db)
    deleted = db.mutate(original, "delete")
    old = loved_state(db, original["playlist_id"])
    assert deleted["deleted"] is True and old[2]["retired_at"] is not None
    fresh, _, _ = loved_save(db, loved_capture(db))
    assert fresh["creation_outcome"] == "created" and fresh["playlist_id"] != original["playlist_id"]
    current = loved_state(db, fresh["playlist_id"])
    assert db.service.execute(db.context(), command) == original
    assert db.service.read_operation(db.context(), command.request_key) == {"status": "committed", "receipt": original}
    assert loved_state(db, original["playlist_id"]) == old
    assert loved_state(db, fresh["playlist_id"]) == current
    assert loved_counts(db)["playlists"] == 2


def test_parallel_fresh_saves_serialize_without_duplicate_recipe_or_account_lock_bypass(loved_flow_db):
    db = loved_flow_db
    taste(db, [0, 1])
    sources = [loved_capture(db), loved_capture(db)]
    commands = [db.create_command(source) for source in sources]
    with ThreadPoolExecutor(max_workers=2) as pool:
        receipts = list(pool.map(lambda command: db.service.execute(db.context(), command), commands))
    assert receipts[0]["playlist_id"] == receipts[1]["playlist_id"]
    assert {row["creation_outcome"] for row in receipts} == {"created", "existing"}
    counts = loved_counts(db)
    assert counts["playlists"] == counts["playlist_artist_loved_recipes"] == 1
    assert counts["playlist_items"] == counts["playlist_operations"] == 2


def test_owner_refresh_preserves_retained_occurrences_and_noop_revision(loved_flow_db):
    db = loved_flow_db
    taste(db, [0, 1])
    receipt, _, source = loved_save(db)
    before = loved_state(db, receipt["playlist_id"])
    taste(db, [0], "off")
    taste(db, [2], "obsessed")
    with db.connect() as con:
        con.execute("delete from app.playlist_creation_sources where ref=%s", (source["source"]["ref"],))
    detail = db.service.read(db.context(), playlist_ref=receipt["playlist_id"])["playlist_detail"]
    after = loved_state(db, receipt["playlist_id"])
    assert detail["artist_loved"]["refresh_status"] == "current" and detail["revision"] == "2"
    assert [row["local_track_id"] for row in after[1]] == db.tracks[1:3]
    assert [row["position"] for row in after[1]] == [1, 2]
    assert after[1][0]["ref"] == before[1][1]["ref"]
    db.clock_time += timedelta(seconds=1)
    db.service.read(db.context(), playlist_ref=receipt["playlist_id"])
    noop = loved_state(db, receipt["playlist_id"])
    assert noop[0] == after[0] and noop[1] == after[1]
    assert noop[2]["last_evaluated_at"] > after[2]["last_evaluated_at"]
    assert loved_counts(db)["playlist_operations"] == 1


@pytest.mark.parametrize("access", ["shared", "editor"])
def test_directory_and_friend_detail_do_not_refresh_with_another_users_taste(loved_flow_db, access):
    db = loved_flow_db
    taste(db, [0])
    taste(db, [2], actor=db.other)
    receipt, _, _ = loved_save(db)
    receipt = (db.mutate(receipt, "visibility", visibility="server_shared") if access == "shared"
               else db.mutate(receipt, "grant_editor", account_id=db.other.account_id, role="editor"))
    before = loved_state(db, receipt["playlist_id"])
    taste(db, [1])
    db.service.read(db.context())
    detail = db.service.read(db.context(db.other), playlist_ref=receipt["playlist_id"])["playlist_detail"]
    assert detail["artist_loved"]["refresh_status"] == "owner_refresh_required"
    assert all(detail["allowed_actions"][key] is False for key in ("can_add", "can_remove", "can_reorder"))
    assert loved_state(db, receipt["playlist_id"]) == before
    db.service.read(db.context(), playlist_ref=receipt["playlist_id"])
    assert [row["local_track_id"] for row in loved_state(db, receipt["playlist_id"])[1]] == db.tracks[:2]


@pytest.mark.parametrize("action", ["add", "remove", "reorder", "save_order"])
def test_generated_membership_rejects_every_manual_entry_point(loved_flow_db, action):
    db = loved_flow_db
    taste(db, [0, 1])
    receipt, _, _ = loved_save(db)
    before = loved_state(db, receipt["playlist_id"])
    refs = [str(row["ref"]) for row in before[1]]
    data = {"add": {"track_refs": [f"inventory-track:{db.library}:{db.tracks[2]}"]},
        "remove": {"item_refs": refs[:1]}, "reorder": {"item_order": list(reversed(refs))},
        "save_order": {"title": "Must not commit", "item_order": refs}}[action]
    with pytest.raises(PlaylistError, match="artist_loved_membership_locked"):
        db.mutate(receipt, "save" if action == "save_order" else action, **data)
    assert loved_state(db, receipt["playlist_id"]) == before
    assert loved_counts(db)["playlist_operations"] == 1


def test_metadata_copy_and_existing_popular_receipts_keep_ordinary_contract(loved_flow_db):
    db = loved_flow_db
    taste(db, [0])
    receipt, _, _ = loved_save(db)
    before = loved_state(db, receipt["playlist_id"])
    renamed = db.mutate(receipt, "save", title="Renamed", description="Metadata only")
    assert "creation_outcome" not in renamed
    assert loved_state(db, receipt["playlist_id"])[1:] == before[1:]
    copied = db.mutate(renamed, "copy", title="Manual copy")
    assert "creation_outcome" not in copied and loved_state(db, copied["playlist_id"])[2] is None
    popular, _, _ = db.save(db.capture(auto=False))
    assert "creation_outcome" not in popular


def test_saved_absent_root_empties_once_and_never_rebinds_same_name(loved_flow_db):
    db = loved_flow_db
    taste(db, [0])
    receipt, _, _ = loved_save(db)
    with db.connect() as con:
        old = con.execute("select name,artist_key from library.local_artists where id=%s", (db.artist_ids[0],)).fetchone()
        con.execute("delete from library.local_artists where id=%s", (db.artist_ids[0],))
        replacement = con.execute("insert into library.local_artists(library_id,name,artist_key) values(%s,%s,%s) returning id",
            (db.library, old["name"], old["artist_key"])).fetchone()["id"]
        con.execute("""insert into library.local_album_featured_artists(library_id,album_id,artist_id,featured_kind)
            values(%s,%s,%s,'owner')""", (db.library, db.albums[1], replacement))
    taste(db, [3])
    detail = db.service.read(db.context(), playlist_ref=receipt["playlist_id"])["playlist_detail"]
    after = loved_state(db, receipt["playlist_id"])
    assert after[1] == [] and after[0]["revision"] == 2
    assert detail["artist_loved"]["root_state"] == "root_missing"
    assert detail["artist_loved"]["refresh_status"] == "current"
    assert after[2]["root_artist_id"] == db.artist_ids[0] != replacement
    db.clock_time += timedelta(seconds=1)
    db.service.read(db.context(), playlist_ref=receipt["playlist_id"])
    assert loved_state(db, receipt["playlist_id"])[0] == after[0]
    with pytest.raises(PlaylistError, match="source_unavailable"):
        loved_capture(db)


@pytest.mark.parametrize("failure", ["stale_projection", "denied_root", "sql_after_items", "sql_timeout_after_items"])
def test_failed_refresh_preserves_all_saved_rows_and_never_reports_empty_current(loved_flow_db, failure):
    db = loved_flow_db
    taste(db, [0])
    receipt, _, _ = loved_save(db)
    before = loved_state(db, receipt["playlist_id"])
    taste(db, [0], "off")
    taste(db, [1])
    constraints, service = None, db.service
    if failure == "stale_projection":
        with db.connect() as con:
            con.execute("""update library.libraries set metadata=jsonb_set(metadata,
                '{scan_cache,relation_projection,status}','\"stale\"') where id=%s""", (db.library,))
    elif failure == "denied_root":
        constraints = deny_resource("artist", db.artist_ids[0])
    else:
        def fail(con, sql, _params):
            if "update app.playlists set revision=revision+1" in sql:
                if failure == "sql_timeout_after_items":
                    con.execute("set local statement_timeout='1ms'")
                    con.execute("select pg_sleep(0.05)")
                else:
                    con.execute("select 1/0")
        service = observing_service(db, after=fail)
    if failure == "denied_root":
        with pytest.raises(PlaylistError, match="source_unavailable"):
            loved.refresh_owned(service, db.context(), receipt["playlist_id"], constraints=constraints)
    elif failure == "sql_after_items":
        with pytest.raises(psycopg.errors.DivisionByZero):
            loved.refresh_owned(service, db.context(), receipt["playlist_id"])
    else:
        assert loved.refresh_owned(service, db.context(), receipt["playlist_id"]) == {"refresh_status": "unavailable"}
    assert loved_state(db, receipt["playlist_id"]) == before
    assert loved_counts(db)["playlist_operations"] == 1


def test_actual_viewer_scoped_grants_allow_save_not_native_media(loved_flow_db):
    db = loved_flow_db
    with db.connect() as con:
        viewer = db.member(con, actions=capability_keys_for_roles(("viewer",)))
    assert all(grant.scope_kind == "library" and grant.scope_id == db.library for grant in viewer.capability_grants)
    taste(db, [0], actor=viewer)
    source = loved_capture(db, actor=viewer)
    assert source["allowed_actions"]["can_use_for_playlist"] is True
    assert source["allowed_actions"]["can_play"] is False
    receipt, _, _ = loved_save(db, source, actor=viewer)
    with pytest.raises(PlaylistError, match="item_unavailable"):
        loved_queue(db, source, actor=viewer)
    items = loved_state(db, receipt["playlist_id"])[1]
    refs = [str(row["ref"]) for row in items]
    targets = PlaylistNativeTargets(db.config, playlists=db.service, media_resolver=db.media_resolver)
    with pytest.raises(PlaylistError, match="item_unavailable"):
        targets.queue(db.context(viewer), playlist_ref=receipt["playlist_id"], revision=receipt["revision"],
                      item_refs=refs, starting_item_ref=refs[0])


def test_real_temporary_and_saved_native_queue_use_current_media_and_own_counts(loved_flow_db):
    db = loved_flow_db
    taste(db, [0, 1])
    add_media(db)
    source = loved_capture(db)
    with db.connect() as con:
        con.execute("""insert into integration.listen_history
            (account_id,library_id,track_id,track_key,played_at,source_family,source_entry_id,scrobble_status)
            values(%s,%s,%s,%s,%s,'runtime_listen_history_adapter',%s,'scrobbled')""",
            (db.other.account_id, db.library, db.tracks[0], f"{db.token}:0", db.now, uuid4().hex))
    refs = [row["entry_ref"] for row in reversed(source["entries"])]
    queue = loved_queue(db, source, refs=refs)
    assert [row["playlist_item_id"] for row in queue["tracks"]] == refs
    assert all(row["play_count"] == 0 for row in queue["tracks"])
    assert all(row["native_target"]["playlist_item_id"] == row["playlist_item_id"] for row in queue["tracks"])
    receipt, _, _ = loved_save(db, source)
    saved_refs = [str(row["ref"]) for row in reversed(loved_state(db, receipt["playlist_id"])[1])]
    targets = PlaylistNativeTargets(db.config, playlists=db.service, media_resolver=db.media_resolver)
    saved = targets.queue(db.context(), playlist_ref=receipt["playlist_id"], revision=receipt["revision"],
                         item_refs=saved_refs, starting_item_ref=saved_refs[0])
    assert [row["playlist_item_id"] for row in saved["tracks"]] == saved_refs
    assert all(row["play_count"] == 0 for row in saved["tracks"])
    denied = deny_resource("track", db.tracks[0], action=MEDIA)
    partial = loved_queue(db, source, refs=refs, constraints=denied)
    assert partial["unavailable_item_refs"] == [source["entries"][0]["entry_ref"]]
    assert len(partial["tracks"]) == 1
    with pytest.raises(PlaylistError, match="item_unavailable"):
        loved_queue(db, source, constraints=denied)
    # Retain the stale actor grant intentionally; the real transaction reloads.
    with db.connect() as con:
        con.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s",
                    (db.owner.account_id, MEDIA))
    for call in (lambda: loved_queue(db, source), lambda: targets.queue(db.context(),
            playlist_ref=receipt["playlist_id"], revision=receipt["revision"], item_refs=saved_refs,
            starting_item_ref=saved_refs[0])):
        with pytest.raises(PlaylistError, match="item_unavailable"):
            call()


def blocked_operation(db, lock_sql, lock_params, operation, change):
    """Two real connections: verify pg_locks waiting before committing change.

The service keeps all real account/session/inventory/parent locks. The observer
only publishes its backend PID, so reaching Python code is not the race proof.
"""
    connected = Event()
    worker = {}
    def observe(con, _sql, _params):
        worker["pid"] = con.info.backend_pid
        connected.set()
    service = observing_service(db, before=observe)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.connect() as blocker:
            blocker.execute("set local statement_timeout='7s'")
            blocker.execute(lock_sql, lock_params).fetchall()
            future = pool.submit(operation, service)
            try:
                assert connected.wait(3), "Worker did not open its actual app-role connection"
                deadline = monotonic() + 5
                while monotonic() < deadline:
                    waiting = blocker.execute("""select exists(select 1 from pg_locks
                        where pid=%s and not granted) as waiting""", (worker["pid"],)).fetchone()["waiting"]
                    if waiting:
                        break
                    assert not future.done(), "Worker finished before the intended database wait"
                    sleep(0.01)
                else:
                    pytest.fail("No actual PostgreSQL row-lock wait observed")
                change(blocker)
            finally:
                blocker.commit()
        return future.result(timeout=15)


@pytest.mark.parametrize("phase", ["capture", "read", "save", "queue", "refresh"])
@pytest.mark.parametrize("change", ["add", "remove"])
def test_family_vector_is_reread_after_real_inventory_wait(loved_flow_db, phase, change):
    db = loved_flow_db
    taste(db, [0, 3])
    add_media(db)
    if change == "remove":
        with db.connect() as con:
            add_family_link(con, db, *db.artist_ids)
    source = loved_capture(db, mode="family")
    receipt = loved_save(db, source)[0] if phase == "refresh" else None
    before = loved_state(db, receipt["playlist_id"]) if receipt else loved_counts(db)
    command = db.create_command(source)
    operations = {
        "capture": lambda service: loved_capture(db, mode="family", service=service),
        "read": lambda service: loved_read_source(db, source, service=service),
        "save": lambda service: service.execute(db.context(), command),
        "queue": lambda service: loved_queue(db, source, service=service),
        "refresh": lambda service: loved.refresh_owned(service, db.context(), receipt["playlist_id"]),
    }
    def mutate(con):
        if change == "add":
            add_family_link(con, db, *db.artist_ids)
        else:
            con.execute("delete from library.local_artist_family_links where library_id=%s and artist_id=%s",
                        (db.library, db.artist_ids[0]))
    def run():
        return blocked_operation(db, "select id from library.local_tracks where id=%s for update",
                                 (db.tracks[0],), operations[phase], mutate)
    if phase == "refresh":
        assert run() == {"refresh_status": "unavailable"}
        assert loved_state(db, receipt["playlist_id"]) == before
    else:
        with pytest.raises(PlaylistError, match="source_changed"):
            run()
        assert loved_counts(db) == before
    # A subsequent explicit evaluation sees the fresh complete vector.
    expected = [db.tracks[0], db.tracks[3]] if change == "add" else [db.tracks[0]]
    assert source_track_ids(loved_capture(db, mode="family")) == expected


@pytest.mark.parametrize("phase", ["duplicate", "refresh"])
@pytest.mark.parametrize("change", ["add", "remove"])
def test_family_vector_is_reread_after_real_playlist_parent_wait(loved_flow_db, phase, change):
    db = loved_flow_db
    taste(db, [0, 3])
    if change == "remove":
        with db.connect() as con:
            add_family_link(con, db, *db.artist_ids)
    source = loved_capture(db, mode="family")
    receipt, _, _ = loved_save(db, source)
    before, counts = loved_state(db, receipt["playlist_id"]), loved_counts(db)
    command = db.create_command(loved_capture(db, mode="family"))
    def mutate(con):
        if change == "add": add_family_link(con, db, *db.artist_ids)
        else:
            con.execute("delete from library.local_artist_family_links where library_id=%s and artist_id=%s",
                        (db.library, db.artist_ids[0]))
    operation = (lambda service: service.execute(db.context(), command)) if phase == "duplicate" else (
        lambda service: loved.refresh_owned(service, db.context(), receipt["playlist_id"]))
    def run():
        return blocked_operation(db, "select ref from app.playlists where ref=%s for update",
                                 (receipt["playlist_id"],), operation, mutate)
    if phase == "duplicate":
        with pytest.raises(PlaylistError, match="source_changed"):
            run()
    else:
        assert run() == {"refresh_status": "unavailable"}
    assert loved_state(db, receipt["playlist_id"]) == before
    assert loved_counts(db)["playlist_operations"] == counts["playlist_operations"]


@pytest.mark.parametrize("phase", ["capture", "refresh"])
def test_original_root_disappearance_during_inventory_wait_is_not_rebound(loved_flow_db, phase):
    db = loved_flow_db
    taste(db, [0])
    receipt = loved_save(db)[0] if phase == "refresh" else None
    original = db.artist_ids[0]
    counts = loved_counts(db)
    def disappear(con):
        row = con.execute("select name,artist_key from library.local_artists where id=%s", (original,)).fetchone()
        # The blocker owns the FIRST inventory row; the worker has acquired no
        # conflicting inventory/artist parent locks yet. FK changes are real.
        con.execute("delete from library.local_artists where id=%s", (original,))
        replacement = con.execute("insert into library.local_artists(library_id,name,artist_key) values(%s,%s,%s) returning id",
                                 (db.library, row["name"], row["artist_key"])).fetchone()["id"]
        assert replacement != original
    operation = (lambda service: loved_capture(db, service=service)) if phase == "capture" else (
        lambda service: loved.refresh_owned(service, db.context(), receipt["playlist_id"]))
    def run():
        return blocked_operation(db, "select id from library.local_tracks where id=%s for update",
                                 (db.tracks[0],), operation, disappear)
    if phase == "capture":
        with pytest.raises(PlaylistError, match="source_unavailable"):
            run()
        assert loved_counts(db) == counts
    else:
        assert run() == {"refresh_status": "current"}
        state = loved_state(db, receipt["playlist_id"])
        assert state[1] == [] and state[0]["revision"] == 2
        assert state[2]["root_state"] == "root_missing" and state[2]["root_artist_id"] == original


def test_canonical_taste_change_during_parent_wait_preserves_prior_saved_membership(loved_flow_db):
    from music_app.services.track_preferences_postgres import PostgresTrackPreferencesStore
    db = loved_flow_db
    taste(db, [0])
    receipt, _, _ = loved_save(db)
    before = loved_state(db, receipt["playlist_id"])
    taste(db, [1])
    def change_taste(_blocker):
        # Use the canonical writer with its own actual runtime connection.
        # Playlist account serialization is untouched; it is not this writer's
        # taste lock. The UPDATE must commit while the evaluator waits on parent.
        store = PostgresTrackPreferencesStore(db.config, connect=lambda url:
            psycopg.connect(url, row_factory=dict_row, options="-c lock_timeout=5000 -c statement_timeout=7000"))
        store.patch_preference(f"{db.token}:1", {"love_tier": "off"},
            account_id=db.owner.account_id, library_id=db.library, expected_track_id=db.tracks[1])
    result = blocked_operation(db, "select ref from app.playlists where ref=%s for update",
        (receipt["playlist_id"],),
        lambda service: loved.refresh_owned(service, db.context(), receipt["playlist_id"]), change_taste)
    assert result == {"refresh_status": "unavailable"}
    assert loved_state(db, receipt["playlist_id"]) == before
    assert loved.refresh_owned(db.service, db.context(), receipt["playlist_id"]) == {"refresh_status": "current"}
    assert loved_state(db, receipt["playlist_id"])[1] == before[1]


@pytest.mark.parametrize("change", ["browse_grant", "session_revocation", "membership", "account_disabled"])
@pytest.mark.parametrize("phase", ["capture", "save", "queue", "refresh"])
def test_real_authority_change_while_waiting_for_account_lock_reloads_stale_actor(loved_flow_db, change, phase):
    db = loved_flow_db
    taste(db, [0])
    add_media(db)
    source = loved_capture(db)
    receipt = loved_save(db, source)[0] if phase == "refresh" else None
    before = loved_state(db, receipt["playlist_id"]) if receipt else loved_counts(db)
    command = db.create_command(source)
    def revoke(con):
        if change == "browse_grant":
            con.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key='library.browse.read'",
                        (db.owner.account_id,))
        elif change == "session_revocation":
            con.execute("update app.account_sessions set revoked_at=now() where id=%s", (db.owner.session_id,))
        elif change == "membership":
            con.execute("delete from library.library_memberships where account_id=%s and library_id=%s",
                        (db.owner.account_id, db.library))
        else:
            con.execute("update app.accounts set is_active=false,disabled_at=now() where id=%s", (db.owner.account_id,))
    operations = {"capture": lambda service: loved_capture(db, service=service),
        "save": lambda service: service.execute(db.context(), command),
        "queue": lambda service: loved_queue(db, source, service=service),
        "refresh": lambda service: loved.refresh_owned(service, db.context(), receipt["playlist_id"])}
    with pytest.raises(PlaylistError, match="forbidden"):
        blocked_operation(db, "select id from app.accounts where id=%s for update",
                          (db.owner.account_id,), operations[phase], revoke)
    assert (loved_state(db, receipt["playlist_id"]) if receipt else loved_counts(db)) == before


@pytest.mark.parametrize("phase", ["read", "save", "queue"])
def test_source_deadline_is_checked_after_real_inventory_wait(loved_flow_db, phase):
    db = loved_flow_db
    taste(db, [0])
    add_media(db)
    source = loved_capture(db)
    before = loved_counts(db)
    command = db.create_command(source)
    operations = {"read": lambda service: loved_read_source(db, source, service=service),
        "save": lambda service: service.execute(db.context(), command),
        "queue": lambda service: loved_queue(db, source, service=service)}
    def expire(_con): db.clock_time += timedelta(minutes=31)
    with pytest.raises(PlaylistError, match="source_expired"):
        blocked_operation(db, "select id from library.local_tracks where id=%s for update",
                          (db.tracks[0],), operations[phase], expire)
    assert loved_counts(db) == before


@pytest.mark.parametrize("phase", ["capture", "save", "queue", "refresh"])
@pytest.mark.parametrize("change", ["session_time", "policy"])
def test_final_session_and_policy_fence_after_inventory_wait(loved_flow_db, phase, change):
    db = loved_flow_db
    taste(db, [0])
    add_media(db)
    source = loved_capture(db)
    receipt = loved_save(db, source)[0] if phase == "refresh" else None
    before = loved_state(db, receipt["playlist_id"]) if receipt else loved_counts(db)
    command = db.create_command(source)
    blocked = {"value": False}
    def constraints(_context):
        return PolicyEvaluationConstraints(deployment_allowed=not blocked["value"])
    def expire(_con):
        if change == "session_time": db.clock_time += timedelta(hours=4)
        else: blocked["value"] = True
    operations = {
        "capture": lambda service: loved_capture(db, service=service, constraints=constraints),
        "save": lambda service: service.execute(db.context(), command, constraints=constraints),
        "queue": lambda service: loved_queue(db, source, service=service, constraints=constraints),
        "refresh": lambda service: loved.refresh_owned(service, db.context(), receipt["playlist_id"], constraints=constraints)}
    with pytest.raises(PlaylistError) as failure:
        blocked_operation(db, "select id from library.local_tracks where id=%s for update",
                          (db.tracks[0],), operations[phase], expire)
    assert failure.value.code == ("forbidden" if change == "session_time" else "source_unavailable")
    assert (loved_state(db, receipt["playlist_id"]) if receipt else loved_counts(db)) == before


def test_refresh_and_metadata_writer_preserve_real_account_serialization_and_revision(loved_flow_db):
    db = loved_flow_db
    taste(db, [0])
    receipt, _, _ = loved_save(db)
    taste(db, [1])
    command = normalize_playlist_command("save", {"revision": receipt["revision"],
        "request_key": str(uuid4()), "title": "Concurrent rename"}, playlist_ref=receipt["playlist_id"])
    # A parent wait establishes the refresh's account-lock ownership. Start
    # the metadata command only after observing that real wait.
    pending = {}
    with ThreadPoolExecutor(max_workers=1) as second:
        def start_rename(_con):
            pending["future"] = second.submit(db.service.execute, db.context(), command)
        result = blocked_operation(db, "select ref from app.playlists where ref=%s for update",
            (receipt["playlist_id"],), lambda service: loved.refresh_owned(service, db.context(), receipt["playlist_id"]), start_rename)
        assert result == {"refresh_status": "current"}
        with pytest.raises(PlaylistError, match="revision_conflict"):
            pending["future"].result(timeout=15)
    state = loved_state(db, receipt["playlist_id"])
    assert state[0]["title"] == "Artist Loves" and state[0]["revision"] == 2
    assert [row["local_track_id"] for row in state[1]] == db.tracks[:2]
    assert loved_counts(db)["playlist_operations"] == 1


def test_real_5000_capture_and_save_then_5001_rejects_without_truncating_or_replacing(loved_flow_db):
    db = loved_flow_db
    # 4,998 additional distinct inventory tracks plus two baseline loves.
    # Real small WAV files retain the same active-root/path eligibility seam.
    audio = (db.root_path / "0.wav").read_bytes()
    for index in range(4998):
        (db.root_path / f"loved-limit-{index}.wav").write_bytes(audio)
    with db.connect() as con:
        extra = con.execute("""insert into library.local_tracks
            (library_id,artist_id,album_id,track_key,title,disc_number,track_number,duration_seconds)
            select %s,%s,%s,%s || ':limit:' || n,'Loved Limit ' || n,1,n+4,1
            from generate_series(0,4997) n returning id,track_key,track_number""",
            (db.library, db.artist_ids[0], db.albums[0], db.token)).fetchall()
        with con.cursor() as cursor:
            cursor.executemany("""insert into library.local_track_files
                (track_id,library_root_id,private_path,content_signature)
                values(%s,%s,%s,'loved-limit-fixture')""", [
                (row["id"], db.root_id, str(db.root_path / f'loved-limit-{row["track_number"] - 4}.wav')) for row in extra])
            cursor.executemany("""insert into app.track_preferences
                (account_id,library_id,track_key,love_tier) values(%s,%s,%s,'loved')""",
                [(db.owner.account_id, db.library, row["track_key"]) for row in extra])
    taste(db, [0, 1])
    source = loved_capture(db)
    identities = source_track_ids(source)
    assert len(identities) == len(set(identities)) == 5000
    assert set(identities) == {db.tracks[0], db.tracks[1], *(row["id"] for row in extra)}
    receipt, _, _ = loved_save(db, source)
    before, counts = loved_state(db, receipt["playlist_id"]), loved_counts(db)
    taste(db, [2], "obsessed")
    with pytest.raises(PlaylistError, match="artist_loved_too_large"):
        loved_capture(db)
    assert loved_counts(db) == counts
    assert loved.refresh_owned(db.service, db.context(), receipt["playlist_id"]) == {"refresh_status": "too_large"}
    assert loved_state(db, receipt["playlist_id"]) == before


@pytest.mark.parametrize("failure", ["missing", "foreign_root", "denied_root", "stale_projection"])
def test_new_invalid_root_is_never_successful_empty_capture(loved_flow_db, failure):
    db = loved_flow_db
    root, constraints = db.artist_ids[0], None
    with db.connect() as con:
        if failure == "missing":
            con.execute("delete from library.local_artists where id=%s", (root,))
        elif failure == "foreign_root":
            root = add_artist(con, db, "Foreign Loves Root", library=db.foreign_library)
        elif failure == "stale_projection":
            con.execute("""update library.libraries set metadata=jsonb_set(metadata,
                '{scan_cache,relation_projection,status}','\"stale\"') where id=%s""", (db.library,))
    if failure == "denied_root": constraints = deny_resource("artist", root)
    before = loved_counts(db)
    code = "artist_loved_unavailable" if failure == "stale_projection" else "source_unavailable"
    with pytest.raises(PlaylistError, match=code):
        loved_capture(db, root=root, constraints=constraints)
    assert loved_counts(db) == before


@pytest.mark.parametrize("kind", ["artist", "album", "track"])
def test_family_capture_excludes_unreadable_related_resources(loved_flow_db, kind):
    db = loved_flow_db
    taste(db, [0, 3, 4])
    with db.connect() as con: add_family_link(con, db, *db.artist_ids)
    identity = {"artist": db.artist_ids[1], "album": db.albums[1], "track": db.tracks[3]}[kind]
    source = loved_capture(db, mode="family", constraints=deny_resource(kind, identity))
    assert source_track_ids(source) == ([db.tracks[0], db.tracks[4]] if kind == "track" else [db.tracks[0]])


@pytest.mark.parametrize("change", ["file_replaced", "track_deleted", "family_removed", "source_deleted"])
def test_stale_snapshot_never_commits_partial_saved_rows(loved_flow_db, change):
    db = loved_flow_db
    taste(db, [0, 3])
    with db.connect() as con: add_family_link(con, db, *db.artist_ids)
    source = loved_capture(db, mode="family")
    with db.connect() as con:
        if change == "file_replaced":
            con.execute("update library.local_track_files set content_signature='replacement' where track_id=%s", (db.tracks[0],))
        elif change == "track_deleted": con.execute("delete from library.local_tracks where id=%s", (db.tracks[0],))
        elif change == "family_removed":
            con.execute("delete from library.local_artist_family_links where library_id=%s and artist_id=%s", (db.library, db.artist_ids[0]))
        else: con.execute("delete from app.playlist_creation_sources where ref=%s", (source["source"]["ref"],))
    before = loved_counts(db)
    for call in (lambda: loved_read_source(db, source), lambda: loved_save(db, source)):
        with pytest.raises(PlaylistError, match="source_unavailable" if change == "source_deleted" else "source_changed"):
            call()
    assert loved_counts(db) == before


def test_queue_requires_full_set_but_permits_only_a_permutation(loved_flow_db):
    db = loved_flow_db
    taste(db, [0, 1])
    add_media(db)
    source = loved_capture(db)
    refs = [row["entry_ref"] for row in source["entries"]]
    for invalid in (refs[:1], [str(uuid4()), refs[1]]):
        with pytest.raises(PlaylistError, match="source_changed"):
            loved_queue(db, source, refs=invalid)
    assert [row["playlist_item_id"] for row in loved_queue(db, source, refs=refs[::-1])["tracks"]] == refs[::-1]
    assert loved_counts(db)["playlist_operations"] == loved_counts(db)["playlists"] == 0


@pytest.mark.parametrize("phase", ["capture", "save"])
def test_real_database_failure_after_insert_rolls_back_entire_new_operation(loved_flow_db, phase):
    db = loved_flow_db
    taste(db, [0])
    source = loved_capture(db) if phase == "save" else None
    before = loved_counts(db)
    hit = []
    def fail(con, sql, _params):
        marker = "update app.playlist_creation_sources" if phase == "capture" else "insert into app.playlist_artist_loved_recipes"
        if marker in sql.lower():
            hit.append(sql)
            con.execute("select 1/0")
    service = observing_service(db, after=fail)
    with pytest.raises(psycopg.errors.DivisionByZero):
        if phase == "capture": loved_capture(db, service=service)
        else: service.execute(db.context(), db.create_command(source))
    assert len(hit) == 1
    assert loved_counts(db) == before


def test_parallel_identical_key_returns_one_exact_receipt(loved_flow_db):
    db = loved_flow_db
    taste(db, [0])
    command = db.create_command(loved_capture(db))
    with ThreadPoolExecutor(max_workers=2) as pool:
        receipts = list(pool.map(lambda _index: db.service.execute(db.context(), command), range(2)))
    assert receipts[0] == receipts[1] and receipts[0]["creation_outcome"] == "created"
    counts = loved_counts(db)
    assert counts["playlists"] == counts["playlist_items"] == counts["playlist_operations"] == counts["playlist_artist_loved_recipes"] == 1


@pytest.mark.parametrize("phase", ["read", "save", "queue"])
def test_other_actor_cannot_use_current_users_source(loved_flow_db, phase):
    db = loved_flow_db
    taste(db, [0])
    source = loved_capture(db)
    before = loved_counts(db)
    calls = {"read": lambda: loved_read_source(db, source, actor=db.other),
        "save": lambda: loved_save(db, source, actor=db.other),
        "queue": lambda: loved_queue(db, source, actor=db.other)}
    with pytest.raises(PlaylistError, match="source_unavailable"):
        calls[phase]()
    assert loved_counts(db) == before


@pytest.mark.parametrize("change", ["source_time", "playlist_policy"])
def test_duplicate_final_fence_after_parent_wait_cannot_commit_receipt(loved_flow_db, change):
    db = loved_flow_db
    taste(db, [0])
    receipt, _, _ = loved_save(db)
    command = db.create_command(loved_capture(db))
    before, counts = loved_state(db, receipt["playlist_id"]), loved_counts(db)
    denied = {"value": False}
    def constraints(context):
        blocked = denied["value"] and context.resource is not None and context.resource.resource_kind == "playlist"
        return PolicyEvaluationConstraints(deployment_allowed=not blocked)
    def change_after_wait(_con):
        if change == "source_time": db.clock_time += timedelta(minutes=31)
        else: denied["value"] = True
    with pytest.raises(PlaylistError, match="source_expired" if change == "source_time" else "forbidden"):
        blocked_operation(db, "select ref from app.playlists where ref=%s for update",
            (receipt["playlist_id"],), lambda service: service.execute(db.context(), command, constraints=constraints), change_after_wait)
    assert loved_state(db, receipt["playlist_id"]) == before
    assert loved_counts(db) == counts


def test_real_media_grant_revocation_during_account_wait_denies_native_target(loved_flow_db):
    db = loved_flow_db
    taste(db, [0])
    add_media(db)
    source = loved_capture(db)
    before = loved_counts(db)
    def revoke(con):
        con.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s",
                    (db.owner.account_id, MEDIA))
    with pytest.raises(PlaylistError, match="item_unavailable"):
        blocked_operation(db, "select id from app.accounts where id=%s for update", (db.owner.account_id,),
            lambda service: loved_queue(db, source, service=service), revoke)
    assert loved_counts(db) == before
