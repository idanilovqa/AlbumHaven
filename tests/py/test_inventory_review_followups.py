"""Real persistence checks for complete targeted album aggregates."""

from pathlib import Path

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory


@pytest.mark.parametrize("retag", ["edition", "separated_year", "ordinary_year"])
def test_targeted_external_identity_retag_matches_full_scan(watcher_repair_inventory, retag):
    from music_app.services.library import build_albums_from_file_cache

    fixture = watcher_repair_inventory
    changed = {**fixture.entry("Owner/Changed/song.flac"), "year": 2000}
    retained = {**fixture.entry("Owner/Retained/song.flac"), "year": 2000}
    separate_keys = {"owner::repair album"} if retag == "separated_year" else set()
    if separate_keys:
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            connection.execute("""
                insert into library.separate_releases (library_id, release_key, metadata)
                select id, 'owner::repair album', '{"source":"owner"}'::jsonb
                from library.libraries where library_kind = 'local' and name = 'Local Library'
            """)
    previous = {item["path"]: item for item in (changed, retained)}
    initial_albums = build_albums_from_file_cache(previous, separate_keys)
    assert len(initial_albums) == 1
    initial_album_key = initial_albums[0].key
    fixture.adapter.save_snapshot(
        Path("unused-watcher-identity.json"), previous, "watcher-identity", 1.0,
        separate_release_keys=separate_keys, observed_library_root_ids={"repair-main"},
    )
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        established_album_id = connection.execute(
            "select id from library.local_albums where album_key = %s",
            (initial_album_key,),
        ).fetchone()["id"]
    replacement = {**changed, **({"edition": "Deluxe"} if retag == "edition" else {"year": 2001})}
    expected_albums = build_albums_from_file_cache(
        {**previous, changed["path"]: replacement}, separate_keys,
    )
    expected_membership = {str(track.path): album.key for album in expected_albums for track in album.tracks}
    fixture.adapter.persist_targeted_inventory_mutation(
        root_id="repair-main", active_file_entries={changed["path"]: replacement},
    )
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        rows = connection.execute("""
            select file.private_path, album.id as album_id, album.album_key,
                   album.release_year, album.metadata
            from library.local_track_files file
            join library.local_tracks track on track.id = file.track_id
            join library.local_albums album on album.id = track.album_id
            where file.scan_cache_stale is false order by file.private_path
        """).fetchall()
        repair_album_ids = {
            row["id"] for row in connection.execute("""
                select id from library.local_albums
                where lower(btrim(title)) = 'repair album'
            """).fetchall()
        }
    assert {row["private_path"]: row["album_key"] for row in rows} == expected_membership
    by_key = {album.key: album for album in expected_albums}
    for row in rows:
        assert row["metadata"].get("edition") == by_key[row["album_key"]].edition
    if retag == "separated_year":
        assert {row["release_year"] for row in rows} == {2000, 2001}
    if retag in {"separated_year", "ordinary_year"}:
        resulting_album_ids = {row["album_id"] for row in rows}
        assert established_album_id in resulting_album_ids
        assert len(resulting_album_ids) == 2
        assert repair_album_ids == resulting_album_ids


@pytest.mark.parametrize("other_root", [False, True])
@pytest.mark.parametrize("origin", ["automatic", "user"])
@pytest.mark.parametrize("operation", ["retag", "delete_cover_member"])
def test_targeted_automatic_cover_uses_complete_retained_membership(
    watcher_repair_inventory, other_root, origin, operation,
):
    fixture = watcher_repair_inventory
    changed = fixture.entry("Owner/Changed/song.flac")
    covered = fixture.entry("Owner/Covered/song.flac", root=int(other_root))
    automatic_cover = Path(covered["path"]).with_name("cover.png")
    automatic_cover.write_bytes(b"scoped artwork fixture")
    covered.update(cover_path=str(automatic_cover), cover_revision="automatic-revision",
                   cover_selection_origin="automatic", local_cover_width=600, local_cover_height=600)
    fixture.seed(changed, covered)
    user_cover = automatic_cover.with_name("selected.png")
    user_cover.write_bytes(b"scoped selected artwork")
    if origin == "user":
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            connection.execute("""
                update library.local_albums set cover_path = %s,
                  metadata = metadata || '{"cover_selection_origin":"user","cover_revision":"user-revision","local_cover_width":900,"local_cover_height":800}'::jsonb
                where album_key = 'owner::repair album'
            """, (str(user_cover),))
    if operation == "delete_cover_member":
        Path(covered["path"]).unlink()
        fixture.adapter.persist_targeted_inventory_mutation(
            root_id=fixture.roots[int(other_root)]["id"], active_file_entries={}, deleted_paths=(covered["path"],),
        )
    else:
        fixture.adapter.persist_targeted_inventory_mutation(
            root_id="repair-main", active_file_entries={changed["path"]: {**changed, "title": "Corrected"}},
        )
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        album = connection.execute("""
            select cover_path, metadata from library.local_albums where album_key = 'owner::repair album'
        """).fetchone()
    expected = str(user_cover) if origin == "user" else str(automatic_cover) if operation == "retag" else None
    assert album["cover_path"] == expected
    if expected is not None:
        assert album["metadata"]["cover_selection_origin"] == origin
        assert album["metadata"]["cover_revision"] == f"{origin}-revision"
        assert album["metadata"]["local_cover_width"] == (900 if origin == "user" else 600)
        assert album["metadata"]["local_cover_height"] == (800 if origin == "user" else 600)
    else:
        assert album["metadata"].get("cover_revision") is None
        assert album["metadata"].get("local_cover_width") is None
        assert album["metadata"].get("local_cover_height") is None


@pytest.mark.parametrize("other_root", [False, True])
@pytest.mark.parametrize("mutation", ["retag", "delete"])
def test_targeted_album_metadata_uses_every_retained_member(watcher_repair_inventory, other_root, mutation):
    fixture = watcher_repair_inventory
    changed = fixture.entry("Owner/First/song.flac", artist="Owner feat. Old Guest")
    retained = fixture.entry("Owner/Other/song.flac", root=int(other_root), artist="Owner feat. Retained Guest")
    unrelated = fixture.entry("Other/Unrelated/song.flac", artist="Owner feat. Unrelated Guest", album="Unrelated")
    fixture.seed(changed, retained, unrelated)

    def albums():
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            return {row["album_key"]: row for row in connection.execute(
                "select album_key, artist_id, metadata from library.local_albums order by album_key"
            ).fetchall()}

    before = albums()
    replacement = {**changed, "artist": "Owner feat. New Guest"}
    fixture.adapter.persist_targeted_inventory_mutation(
        root_id="repair-main",
        active_file_entries={changed["path"]: replacement} if mutation == "retag" else {},
        deleted_paths=(changed["path"],) if mutation == "delete" else (),
    )
    after = albums()
    album = after["owner::repair album"]
    expected_artists = {"Retained Guest", "New Guest"} if mutation == "retag" else {"Retained Guest"}
    assert album["metadata"]["artists"] == ["Owner"]
    assert set(album["metadata"]["featured_artists"]) == expected_artists
    categories = {"hoard"} if other_root and mutation == "delete" else {"main_library", "hoard"} if other_root else {"main_library"}
    assert set(album["metadata"]["root_provenance"]["categories"]) == categories
    assert album["artist_id"] == before["owner::repair album"]["artist_id"]
    assert after["owner::unrelated"] == before["owner::unrelated"]


@pytest.mark.parametrize("stage_first_track", [False, True])
def test_targeted_additions_publish_tagged_or_inferred_album_artist_identity(
    watcher_repair_inventory,
    stage_first_track,
):
    fixture = watcher_repair_inventory
    additions = [
        (
            "Various Artists/Rain Man",
            "Rain Man",
            "Various Artists",
            ("Belle Stars", "Watcher Compilation Performer"),
        ),
        ("!Air/Collation Air", "Watcher Collation Air", "!Air", ("!Air",)),
        (
            "I'm with Her/Collation Apostrophe",
            "Watcher Collation Apostrophe",
            "I'm with Her",
            ("I'm with Her",),
        ),
        ("IZZ/Collation IZZ", "Watcher Collation IZZ", "IZZ", ("IZZ",)),
        (
            "'Til Tuesday/Collation Til",
            "Watcher Collation Til",
            "'Til Tuesday",
            ("'Til Tuesday",),
        ),
        (
            "Jordsjø and Breidablik/Joint Credit",
            "Watcher Joint Credit Release",
            "Jordsjø / Breidablik",
            ("Jordsjø", "Breidablik"),
        ),
    ]

    for addition_index, (folder, album, album_artist, track_artists) in enumerate(
        additions
    ):
        entries = []
        for index, track_artist in enumerate(track_artists, start=1):
            entry = fixture.entry(
                f"{folder}/{index:02}.flac",
                artist=track_artist,
                album=album,
            )
            entry["album_artist"] = album_artist
            entry["track_number"] = index
            entries.append(entry)
        if stage_first_track and addition_index == 0:
            fixture.adapter.persist_targeted_inventory_mutation(
                root_id="repair-main",
                active_file_entries={entries[0]["path"]: entries[0]},
            )
        fixture.adapter.persist_targeted_inventory_mutation(
            root_id="repair-main",
            active_file_entries={entry["path"]: entry for entry in entries},
        )

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        albums = connection.execute(
            """
            select album.title, album.metadata, owner.name as owner_name,
                   array_agg(distinct featured_artist.name order by featured_artist.name)
                     filter (where featured.featured_kind = 'featured_track_artist')
                     as featured_names
            from library.local_albums album
            left join library.local_artists owner on owner.id = album.artist_id
            left join library.local_album_featured_artists featured
              on featured.album_id = album.id
            left join library.local_artists featured_artist
              on featured_artist.id = featured.artist_id
            where exists (
              select 1
              from library.local_tracks track
              join library.local_track_files file on file.track_id = track.id
              where track.album_id = album.id and file.scan_cache_stale is false
            )
            group by album.id, owner.name
            order by album.title
            """
        ).fetchall()

    by_title = {row["title"]: row for row in albums}
    assert set(by_title) == {album for _folder, album, _owner, _artists in additions}
    assert by_title["Rain Man"]["owner_name"] is None
    assert by_title["Rain Man"]["metadata"]["album_artist"] == "Various Artists"
    assert set(by_title["Rain Man"]["featured_names"]) == {
        "Belle Stars",
        "Watcher Compilation Performer",
    }
    for _folder, album, album_artist, _track_artists in additions[1:5]:
        assert by_title[album]["owner_name"] == album_artist
    assert by_title["Watcher Joint Credit Release"]["owner_name"] is None
    assert set(by_title["Watcher Joint Credit Release"]["featured_names"]) == {
        "Breidablik",
        "Jordsjø",
    }


@pytest.mark.parametrize("owned_directory_name", [
    "watcher-reconciliation",
    "gallery-native-response-overlap",
])
@pytest.mark.parametrize("mixed_album", [False, True])
def test_watcher_cleanup_removes_all_owned_albums_or_refuses_mixed_ownership(
    watcher_repair_inventory,
    mixed_album,
    owned_directory_name,
):
    from pathlib import Path
    from tests.e2e.support import watcherFixture

    fixture = watcher_repair_inventory
    owned = fixture.entry(f"cases/{owned_directory_name}/Owner/Target/song.flac", album="Target")
    sibling = fixture.entry(f"cases/{owned_directory_name}/Owner/Sibling/song.flac", album="Sibling")
    outside = fixture.entry("cases/watcher-reconciliation-other/Owner/Outside/song.flac", album="Target" if mixed_album else "Outside")
    fixture.seed(owned, sibling, outside)
    owned_root = Path(fixture.roots[0]["path"]) / "cases" / owned_directory_name
    for item in (owned, sibling):
        Path(item["path"]).unlink()

    def inventory():
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            return connection.execute("select private_path, metadata from library.local_track_files order by private_path").fetchall()

    before = inventory()
    if mixed_album:
        with pytest.raises(RuntimeError, match="outside"):
            watcherFixture.remove_watched_inventory(owned_root)
        assert inventory() == before, "the entire cleanup must roll back before mutating mixed ownership"
    else:
        watcherFixture.remove_watched_inventory(owned_root)
        assert [row["private_path"] for row in inventory()] == [outside["path"]]
        assert Path(outside["path"]).exists(), "prefix collision is outside fixture ownership"
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            assert [row["album_key"] for row in connection.execute("select album_key from library.local_albums").fetchall()] == ["owner::outside"]
            revision = connection.execute("select metadata ->> 'inventory_mutation_revision' as revision from library.libraries where library_kind = 'local'").fetchone()["revision"]
        watcherFixture.remove_watched_inventory(owned_root)
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            assert connection.execute("select metadata ->> 'inventory_mutation_revision' as revision from library.libraries where library_kind = 'local'").fetchone()["revision"] == revision


def test_watcher_cleanup_accepts_exact_response_overlap_owner_before_database_access(monkeypatch, tmp_path):
    from tests.e2e.support import watcherFixture

    owned_root = tmp_path / "cases" / "gallery-native-response-overlap"
    owned_root.mkdir(parents=True)

    def accepted_owner():
        raise RuntimeError("accepted response-overlap owner")

    monkeypatch.setattr(isolatedPostgres, "resolve_isolated_database_urls", accepted_owner)

    with pytest.raises(RuntimeError, match="accepted response-overlap owner"):
        watcherFixture.remove_watched_inventory(owned_root)
