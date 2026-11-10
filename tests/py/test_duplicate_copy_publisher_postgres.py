"""Real targeted publisher SQL, on a bounded synthetic PostgreSQL schema.

No persistence/publisher helper is mocked. Only explicitly owned generated media
and the guarded database fixture are used. This is not HTTP/UI qualification.
"""
from itertools import permutations
import json
import re
from pathlib import Path
import pytest
from test_duplicate_copy_retirement_postgres import (
    retirement_database, inventory, no_external_transports, _missing, _active_projection,
)
from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations/postgres"

@pytest.fixture(scope="module")
def publisher_schema(retirement_database):
    with retirement_database() as db:
        for table in ("local_artists", "local_albums", "local_tracks", "local_track_files"):
            db.execute(f"create sequence library.fixture_{table}_ids start 1000")
            db.execute(f"alter table library.{table} alter column id set default nextval('library.fixture_{table}_ids')")
            db.execute(f"grant usage,select on sequence library.fixture_{table}_ids to album_haven_app")
        db.execute("""
          alter table library.local_artists add metadata jsonb not null default '{}', add last_seen_at timestamptz;
          alter table library.local_albums add last_seen_at timestamptz, add semantic_identity_discriminator text not null default '';
          alter table library.local_tracks add artist_id bigint references library.local_artists, add last_seen_at timestamptz;
          alter table library.local_track_files add relative_path text;
          create unique index on library.local_artists(library_id,artist_key);
          create unique index on library.local_albums(library_id,album_key);
          create unique index on library.local_tracks(library_id,track_key);
          alter table library.local_album_featured_artists add id bigint generated always as identity primary key, add featured_kind text, add metadata jsonb not null default '{}', add last_seen_at timestamptz;
          grant usage,select on sequence library.local_album_featured_artists_id_seq to album_haven_app;
          create unique index on library.local_album_featured_artists(library_id,album_id,artist_id,featured_kind);
          create table library.separate_releases(library_id bigint, release_key text);
          grant select on library.separate_releases to album_haven_app;
        """)
        db.execute("create table app.accounts(id bigint primary key)")
        baseline = next(MIGRATIONS.glob("0001_*.sql")).read_text()
        for table in ("track_preferences", "saved_loops"):
            definition = re.search(r"create table if not exists app\." + table + r" \(.*?\n\);", baseline, re.S).group()
            db.execute(definition)
        for prefix in ("0015", "0016", "0021", "0023", "0025", "0026", "0084", "0086", "0104"):
            db.execute(next(MIGRATIONS.glob(prefix + "_*.sql")).read_text())
    return retirement_database

@pytest.fixture
def published_inventory(publisher_schema, inventory):
    def seed(*, distinct=False):
        s = inventory(distinct=True)
        with s.connect() as db:
            db.execute("insert into app.accounts values (7) on conflict do nothing")
            if not distinct:
                db.execute("update library.local_tracks set album_id=1")
                db.execute("delete from library.fixture_user_album_relations where album_id<>1")
                db.execute("delete from library.local_albums where id<>1")
                db.execute("update library.local_albums set album_key='artist::release' where id=1")
            for i, path in s.paths.items():
                db.execute("update library.local_tracks set track_key=%s,artist_id=1 where id=%s", (str(path), 10+i))
                db.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,file_entry}', (metadata #> '{scan_cache,file_entry}') || %s::jsonb) where id=%s", (json.dumps({"mtime":path.stat().st_mtime,"size":path.stat().st_size}),100+i))
            db.execute("insert into app.album_ratings(account_id,library_id,album_key,rating,provenance) select 7,1,album_key,9,'user' from library.local_albums")
            for i, path in s.paths.items():
                db.execute("insert into app.track_preferences(account_id,library_id,track_id,track_key,rating,love_tier) values (7,1,%s,%s,5,'favorite')", (10+i,str(path)))
                db.execute("insert into app.saved_loops(account_id,library_id,track_id,loop_key,source_private_path,start_seconds,end_seconds) values (7,1,%s,%s,%s,1,2)", (10+i,f"loop-{i}",str(path)))
        return s
    return seed


def _publisher(s, *, lose_commit_ack=False):
    def connect(url):
        db = s.connect()
        db.execute("set role album_haven_app")
        if not lose_commit_ack:
            return db
        class LostCommitAcknowledgment:
            def __enter__(self):
                db.__enter__()
                return self
            def __exit__(self, *args):
                return db.__exit__(*args)
            def __getattr__(self, name):
                return getattr(db, name)
            def commit(self):
                db.commit()
                raise ConnectionError("synthetic lost commit acknowledgment")
        return LostCommitAcknowledgment()
    return PostgresScanCacheAdapter({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/owned"}, connect=connect)


@pytest.mark.parametrize("distinct", [False, True], ids=["shared-album", "retained-distinct-albums"])
@pytest.mark.parametrize("order", list(permutations((1,2,3))))
def test_full_publisher_three_two_one(published_inventory, order, distinct):
    s = published_inventory(distinct=distinct)
    original = s.state()
    original_users = _user_state(s)
    previous_generation = _publication_state(s)["gallery"][0]["generation"]
    adapter = _publisher(s)
    for expected, selected in zip((2,1), order[:2]):
        confirmation = s.confirmation(selected, order[-1])
        s.paths[selected].unlink()
        result = adapter.persist_targeted_inventory_mutation(root_id=f"root-{selected}", active_file_entries={}, confirmed_duplicate_removal=confirmation)
        assert result["retired_file_count"] == 1
        assert result["inventory_mutation_revision"] == 3 - expected
        after = s.state()
        assert len(after["local_track_files"]) == expected
        remaining_ids = {row["id"] for row in after["local_track_files"]}
        assert after["local_track_files"] == [row for row in original["local_track_files"] if row["id"] in remaining_ids]
        assert after["local_tracks"] == original["local_tracks"]
        identity_fields = ("id", "library_id", "artist_id", "album_key", "title", "release_year", "cover_path")
        assert [tuple(r[k] for k in identity_fields) for r in after["local_albums"]] == [tuple(r[k] for k in identity_fields) for r in original["local_albums"]]
        assert _user_state(s) == original_users
        publication = _publication_state(s)
        assert publication["gallery"][0]["generation"] > previous_generation
        previous_generation = publication["gallery"][0]["generation"]
        assert publication["search"]
        assert {r["canonical_artist_name"] for r in publication["search"]} == {"Artist"}
        metadata = publication["library"][0]["metadata"]["scan_cache"]
        assert metadata["relation_projection"]["status"] == "ready"
        assert metadata["relation_views"]
        assert len(after["local_track_waveform_peaks"]) == expected
        assert after["fixture_user_album_relations"] == original["fixture_user_album_relations"]
        assert {r["id"] for r in after["local_albums"]} == {r["id"] for r in original["local_albums"]}
        assert {r["id"] for r in after["local_tracks"]} == {r["id"] for r in original["local_tracks"]}
        assert _missing(s.connect) == []
        projected = _active_projection(s.connect)
        assert projected
        from music_app.services import library_browse_postgres as browse
        for album in projected:
            assert album["has_duplicate_files"] is (expected > 1)
            assert ("Duplicate files" in browse._problematic_album_summary_payload(album)["problem_reasons"]) is (expected > 1)
        assert adapter.persist_targeted_inventory_mutation(root_id=f"root-{selected}", active_file_entries={}, confirmed_duplicate_removal=confirmation)["retired_file_count"] == 0
        assert s.state() == after
        assert _publication_state(s) == publication
        assert _user_state(s) == original_users


def _user_state(s):
    with s.connect() as db:
        return {table: db.execute(f"select * from app.{table} order by id").fetchall()
                for table in ("album_ratings", "track_preferences", "saved_loops")}


def _publication_state(s):
    with s.connect() as db:
        return {name: db.execute(f"select * from library.{table} order by 1").fetchall()
                for name, table in (("library", "libraries"), ("gallery", "gallery_projection_state"),
                                    ("search", "local_artist_search_projection"), ("family", "local_artist_family_links"))}


def test_full_publisher_later_sql_failure_rolls_back(published_inventory):
    s = published_inventory()
    confirmation = s.confirmation()
    s.paths[1].unlink()
    before = s.state(), _user_state(s), _publication_state(s)
    with s.connect() as db:
        db.execute("""create function library.fixture_reject_publication() returns trigger language plpgsql as $$
            begin raise exception 'synthetic late publication failure'; end $$;
            create trigger fixture_reject_publication before insert on library.local_artist_search_projection
            for each statement execute function library.fixture_reject_publication();""")
    try:
        import psycopg
        with pytest.raises(psycopg.errors.RaiseException, match="synthetic late publication failure"):
            _publisher(s).persist_targeted_inventory_mutation(root_id="root-1",active_file_entries={},confirmed_duplicate_removal=confirmation)
        assert (s.state(), _user_state(s), _publication_state(s)) == before
    finally:
        with s.connect() as db:
            db.execute("drop trigger fixture_reject_publication on library.local_artist_search_projection; drop function library.fixture_reject_publication()")


def test_full_publisher_lost_commit_ack_replay(published_inventory):
    s = published_inventory()
    confirmation = s.confirmation()
    s.paths[1].unlink()
    with pytest.raises(ConnectionError, match="lost commit acknowledgment"):
        _publisher(s,lose_commit_ack=True).persist_targeted_inventory_mutation(root_id="root-1",active_file_entries={},confirmed_duplicate_removal=confirmation)
    committed = s.state(), _user_state(s), _publication_state(s)
    assert len(committed[0]["local_track_files"]) == 2
    assert _publisher(s).persist_targeted_inventory_mutation(root_id="root-1",active_file_entries={},confirmed_duplicate_removal=confirmation)["retired_file_count"] == 0
    assert (s.state(), _user_state(s), _publication_state(s)) == committed


def test_full_publisher_replay_does_not_retire_recreated_id(published_inventory):
    s = published_inventory()
    confirmation = s.confirmation()
    s.paths[1].unlink()
    adapter = _publisher(s)
    adapter.persist_targeted_inventory_mutation(root_id="root-1",active_file_entries={},confirmed_duplicate_removal=confirmation)
    s.paths[1].write_bytes(b"new recreated copy")
    with s.connect() as db:
        db.execute("""insert into library.local_track_files(id,track_id,library_root_id,private_path,modified_at,file_size_bytes,last_seen_at,metadata)
            select 999,11,1,%s,modified_at,file_size_bytes,last_seen_at,metadata from library.local_track_files where id=103""", (str(s.paths[1]),))
    recreated = s.state(), _user_state(s), _publication_state(s)
    result = adapter.persist_targeted_inventory_mutation(root_id="root-1",active_file_entries={},confirmed_duplicate_removal=confirmation)
    assert result["retired_file_count"] == 0
    assert (s.state(), _user_state(s), _publication_state(s)) == recreated


def test_full_publisher_does_not_suppress_unrelated_missing(published_inventory):
    s = published_inventory(distinct=True)
    confirmation = s.confirmation()
    s.paths[1].unlink()
    with s.connect() as db:
        db.execute("update library.local_albums set title='Unrelated absence' where id=2")
        db.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where id=102")
    missing = _missing(s.connect)
    assert [row["key"] for row in missing] == ["artist::release::2"]
    _publisher(s).persist_targeted_inventory_mutation(root_id="root-1",active_file_entries={},confirmed_duplicate_removal=confirmation)
    assert _missing(s.connect) == missing


def test_full_publisher_role_cannot_directly_delete(published_inventory):
    import psycopg
    s = published_inventory()
    before = s.state()
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with s.connect() as db:
            db.execute("set local role album_haven_app")
            db.execute("delete from library.local_track_files where id=101")
    assert s.state() == before


@pytest.mark.parametrize("race", ["survivor-removed", "selected-recreated"])
def test_full_publisher_late_filesystem_race_rolls_back(published_inventory, monkeypatch, race):
    from music_app.services import scan_cache_persistence as persistence
    from music_app.services.duplicate_copy_retirement import DuplicateCopyRetirementConflict
    s = published_inventory()
    confirmation = s.confirmation()
    s.paths[1].unlink()
    before = s.state(), _user_state(s), _publication_state(s)
    original = persistence._commit_structural_relation_projection
    def finalizer(*args, **kwargs):
        result = original(*args, **kwargs)
        if race == "survivor-removed":
            s.paths[3].unlink()
        else:
            s.paths[1].write_bytes(b"new unrelated generation")
        return result
    monkeypatch.setattr(persistence, "_commit_structural_relation_projection", finalizer)
    with pytest.raises(DuplicateCopyRetirementConflict):
        _publisher(s).persist_targeted_inventory_mutation(root_id="root-1",active_file_entries={},confirmed_duplicate_removal=confirmation)
    assert (s.state(), _user_state(s), _publication_state(s)) == before


@pytest.mark.parametrize("ordered", [False, True], ids=["manual", "ordered-manual"])
def test_full_publisher_preserves_cover_authority(published_inventory, ordered):
    s = published_inventory()
    front, rear = (s.roots[3] / name for name in ("front.jpg", "rear.jpg"))
    front.write_bytes(b"synthetic front")
    rear.write_bytes(b"synthetic rear")
    authority = {"cover_selection_origin": "user", "cover_selection_provenance": "explicit",
                 "cover_revision": "fixture-cover-revision", "local_cover_width": 12, "local_cover_height": 12}
    ordered_fields = {
        "selected_covers": [{"selection_id": "front", "kind": "local", "path": str(front)},
                            {"selection_id": "rear", "kind": "local", "path": str(rear)}],
        "selected_covers_revision": 7,
        "selected_covers_last_request": {"mutation_id": "2cfe2385-c225-4501-9a71-3d7fc286b3d1", "request_hash": "a1" * 32},
    } if ordered else {}
    with s.connect() as db:
        db.execute("update library.local_albums set cover_path=%s,metadata=metadata || %s::jsonb", (str(front),json.dumps({**authority,**ordered_fields})))
        db.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,file_entry}', (metadata #> '{scan_cache,file_entry}') || %s::jsonb)", (json.dumps({**authority,"cover_path":str(front)}),))
    before, users = s.state(), _user_state(s)
    confirmation = s.confirmation()
    s.paths[1].unlink()
    _publisher(s).persist_targeted_inventory_mutation(root_id="root-1",active_file_entries={},confirmed_duplicate_removal=confirmation)
    after = s.state()
    album = after["local_albums"][0]
    assert album["cover_path"] == str(front)
    for key,value in {**authority,**ordered_fields}.items():
        assert album["metadata"][key] == value
    for row in after["local_track_files"]:
        original = next(r for r in before["local_track_files"] if r["id"] == row["id"])
        assert {k:v for k,v in row.items() if k != "metadata"} == {k:v for k,v in original.items() if k != "metadata"}
        entry = row["metadata"]["scan_cache"]["file_entry"]
        for key,value in {**authority,"cover_path":str(front)}.items():
            assert entry[key] == value
    assert _user_state(s) == users
    assert front.read_bytes() == b"synthetic front" and rear.read_bytes() == b"synthetic rear"
