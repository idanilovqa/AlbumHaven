"""Pre-start synthetic native acceptance data, using ordinary product storage.

Only the isolated launcher calls these functions while ASGI is stopped. This
module never imports a pytest fixture, creates a session or contacts a provider.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from isolatedLibraryApp import generate_playback_start_fixture_audio


PASSWORD = "Native Acceptance Synthetic Passphrase 2026!"
CASE_KEYS = tuple(f"NA{number:03}" for number in range(1, 6))
TRACK_SPECS = (
    ("one", "first", "North", "First", "Signal One", 1, 440),
    ("two", "first", "North", "First", "Signal Two", 2, 550),
    ("quiet", "first", "North", "First", "Quiet", 3, 660),
    ("three", "second", "South", "Second", "Signal Three", 1, 770),
    ("four", "second", "South", "Second", "Signal Four", 2, 880),
    ("still", "second", "South", "Second", "Still", 3, 990),
)
GOAL_TABLES = (
    "listening_goals", "listening_goal_evidence", "listening_goal_albums",
    "listening_goal_assignments", "listening_goal_cycles", "listening_goal_cycle_items",
    "listening_goal_operations",
)


def _ref(case_key: str, kind: str, logical_key: str) -> str:
    return str(uuid5(NAMESPACE_URL,
                     f"album-haven:native-acceptance:v1:{case_key}:{kind}:{logical_key}"))


def _require(condition: bool, reason: str) -> None:
    if not condition:
        # Diagnostics deliberately exclude credentials, rows and local paths.
        raise RuntimeError("Native acceptance seed: " + reason)


def prepare_native_media(library_root: Path) -> dict[str, dict]:
    """Generate thirty readable, tagged tracks and ten local solid-color covers."""
    from mutagen.easyid3 import EasyID3
    from mutagen.mp3 import MP3
    from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION
    from PIL import Image

    inventory = {}
    for case_key in CASE_KEYS:
        for key, _album_key, direction, album_label, track_label, number, frequency in TRACK_SPECS:
            artist, album, title = (f"Native {case_key} {label}"
                                    for label in (direction, album_label, track_label))
            track = generate_playback_start_fixture_audio(
                library_root, library_root / artist / album / f"{number:02} - {title}.mp3",
                duration_seconds=120, frequency_hz=frequency,
            ).resolve()
            recording = _ref(case_key, "recording", key)
            artist_ref = _ref(case_key, "artist", direction)
            tags = EasyID3()
            for field, value in {
                "artist": artist, "albumartist": artist, "album": album, "title": title,
                "tracknumber": str(number), "discnumber": "1", "date": "2026", "genre": "jazz",
                "musicbrainz_trackid": recording, "musicbrainz_artistid": artist_ref,
                "musicbrainz_albumartistid": artist_ref,
            }.items():
                tags[field] = value
            tags.save(track)
            _require(119 <= MP3(track).info.length <= 122, "generated audio duration is invalid")
            cover = track.parent / "cover.png"
            if not cover.exists():
                Image.new("RGB", (64, 64), (40, frequency % 200, 140)).save(cover)
            stat = track.stat()
            inventory[str(track)] = {
                "path": str(track), "mtime": stat.st_mtime, "size": stat.st_size,
                "artist": artist, "album_artist": artist, "album": album, "title": title,
                "artist_origin": "tag_metadata", "title_origin": "tag_metadata",
                "album_origin": "tag_metadata", "album_artist_origin": "tag_metadata", "genre": "jazz",
                "year": 2026, "release_date": "2026", "track_number": number,
                "disc_number": 1, "disc_number_raw": "1", "duration_seconds": 120,
                "duration_display": "2:00", "cover_path": str(cover),
                "musicbrainz_recording_id": recording,
                "musicbrainz_artist_ids": [artist_ref],
                "musicbrainz_album_artist_ids": [artist_ref],
                "library_root_id": "isolated-e2e-root", "library_root_category": "main_library",
                "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
            }
    _require(len(inventory) == 30, "generated inventory cardinality is invalid")
    return inventory


def persist_native_inventory(setup_database_url: str, library_root: Path, inventory: dict) -> None:
    """Use the existing scan writer and its ordinary relation/alias publication."""
    from config import PERSISTENCE_BACKEND_POSTGRES
    from music_app.services.library_roots import library_root_cache_identity, save_library_root_settings
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    _require(len(inventory) == 30, "scan inventory cardinality is invalid")
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": setup_database_url, "MUSIC_DIR": library_root.resolve(),
        "CACHE_PATH": library_root.parent / "app-data" / "inert-library-cache.json",
        "LIBRARY_ROOTS_PATH": library_root.parent / "app-data" / "inert-library-roots.json",
        "PERSISTENCE_BACKENDS": {"library_roots": PERSISTENCE_BACKEND_POSTGRES,
                                 "scan_cache": PERSISTENCE_BACKEND_POSTGRES},
    }
    save_library_root_settings(config, {"main_library_roots": [{
        "id": "isolated-e2e-root", "path": str(library_root.resolve()), "layout_mode": "artist",
    }]})
    PostgresScanCacheAdapter(config).save_snapshot(
        config["CACHE_PATH"], inventory, library_root_cache_identity(config),
        datetime.now(timezone.utc).timestamp(), rebuild_relation_projection=True,
    )


def _account(connection, library_id: int, case_key: str, role: str, auth_config: dict) -> dict:
    from music_app.services.auth_passwords import hash_password
    from music_app.services.capability_assignments import build_assignment, store_assignment

    username = f"native-{case_key.lower()}-{role}"
    display_name = f"Native {case_key} {role.title()}"
    email = username + "@example.test"
    credential = hash_password(PASSWORD, username=username, email=email,
        breached_checker=lambda _password: False, argon2=auth_config["argon2"],
        policy_version=auth_config["argon2_policy_version"])
    account_id = connection.execute("""insert into app.accounts
        (display_name,account_kind,username_display,username_normalized,contact_email,contact_email_normalized)
        values(%s,'managed_user',%s,%s,%s,%s) returning id""",
        (display_name, username, username, email, email)).fetchone()["id"]
    connection.execute("""insert into app.account_credentials
        (account_id,encoded_hash,hash_algorithm,hash_policy_version,credential_version,administrator_set)
        values(%s,%s,'argon2id',%s,1,false)""",
        (account_id, credential.encoded_hash, credential.policy_version))
    connection.execute("""insert into library.library_memberships
        (account_id,library_id,membership_role) values(%s,%s,'member')""", (account_id, library_id))
    # View in the existing Listener preset supplies personal preference/Top
    # actions. Action identifiers are not assignable capability keys.
    assignment = build_assignment(["listener"], [])
    store_assignment(connection, account_id=account_id, library_id=library_id, assignment=assignment)
    for capability in assignment.effective_keys:
        connection.execute("""insert into app.capabilities
            (account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)""",
            (account_id, capability, library_id))
    connection.execute("insert into integration.lastfm_settings(account_id,timezone_name) values(%s,'UTC')",
                       (account_id,))
    profiles = connection.execute("select account_ref from app.social_profiles where account_id=%s",
                                  (account_id,)).fetchall()
    _require(len(profiles) == 1, "account has no unique social identity")
    return {"id": account_id, "accountRef": str(profiles[0]["account_ref"]),
            "username": username, "displayName": display_name}


def _history(connection, library_id: int, account: dict, case_key: str, catalog: dict, now) -> None:
    for index, key in enumerate(("one", "two", "three")):
        track = catalog["tracks"][key]
        payload = {"title": track["title"], "artist": track["artist"], "album_artist": track["artist"],
                   "album": track["albumTitle"], "track_ref": track["path"], "path": track["path"],
                   "track_number": track["trackNumber"], "total_listened_seconds": 120,
                   "max_contiguous_seconds": 120}
        event_key = account["username"] + ":" + key
        connection.execute("""insert into integration.listen_history
            (account_id,library_id,track_id,track_key,played_at,listen_source,source_family,source_entry_id,
             measurement_version,measured_listened_seconds,max_measured_contiguous_seconds,
             finalized,last_sequence,device_id,session_id,metadata)
            values(%s,%s,%s,%s,%s,'local','rendered_local_listen_session',%s,
                   'rendered-pcm-v1',120,120,true,1,%s,%s,%s::jsonb)""",
            (account["id"], library_id, track["id"], track["key"], now - timedelta(minutes=2 + index),
             _ref(case_key, "history", event_key), _ref(case_key, "device", account["username"]),
             _ref(case_key, "session", event_key), json.dumps({"source_payload": payload})))


def _top(connection, library_id: int, actor: dict, case_key: str, catalog: dict, now) -> dict:
    top_ref, title = _ref(case_key, "top", "ordered"), f"Native {case_key} Ordered Top"
    connection.execute("""insert into app.album_lists
        (ref,owner_account_id,library_id,title,description,visibility,revision,next_original_position,
         created_at,updated_at)
        values(%s,%s,%s,%s,'Synthetic native acceptance','private',1,3,%s,%s)""",
        (top_ref, actor["id"], library_id, title, now, now))
    for position, key in enumerate(("first", "second"), 1):
        connection.execute("""insert into app.album_list_items
            (ref,top_ref,library_id,catalog_ref,original_position,curator_position,created_at)
            values(%s,%s,%s,%s,%s,%s,%s)""",
            (_ref(case_key, "item", key), top_ref, library_id, catalog["albums"][key]["ref"],
             position, position, now))
    stored = connection.execute("""select owner_account_id,library_id,visibility,revision,next_original_position
        from app.album_lists where ref=%s""", (top_ref,)).fetchone()
    _require(stored == {"owner_account_id": actor["id"], "library_id": library_id,
                       "visibility": "private", "revision": 1, "next_original_position": 3},
             "Top ownership or initial revision is invalid")
    items = connection.execute("""select catalog_ref,original_position,curator_position
        from app.album_list_items where top_ref=%s order by curator_position""", (top_ref,)).fetchall()
    _require([(str(row["catalog_ref"]), row["original_position"], row["curator_position"]) for row in items]
             == [(catalog["albums"][key]["ref"], pos, pos) for pos, key in enumerate(("first", "second"), 1)],
             "Top item ordering is invalid")
    return {"ref": top_ref, "title": title}


def _popularity(connection, library_id: int, catalog: dict, now) -> None:
    from music_app.services.library_mix_inventory_postgres import (
        inventory_revision, local_identity, normalize_cached_inventory_row, read_inventory,
    )
    from music_app.services.popularity_observations_postgres import put_observation
    from music_app.services.popularity_snapshots import PopularityObservation

    tracks = catalog["tracks"]
    by_id = {track["id"]: key for key, track in tracks.items()}
    rows = read_inventory(connection, library_id, track_ids=list(by_id))
    _require(len(rows) == 6 and {row["original_local_track_id"] for row in rows} == set(by_id),
             "popularity inventory is incomplete")
    counts = dict(zip((row[0] for row in TRACK_SPECS), (300, 200, 100, 90, 80, 70)))
    # The final scan already stored paths/tags and published aliases. Nothing
    # below changes inventory evidence after these fingerprints are calculated.
    for row in rows:
        track_id = row["original_local_track_id"]
        key = by_id[track_id]
        recording, artist, reason = local_identity(row)
        direction = "North" if key in ("one", "two", "quiet") else "South"
        _require((recording, artist, reason) ==
                 (_ref("NA004", "recording", key), _ref("NA004", "artist", direction), None),
                 "popularity recording or artist attribution is invalid")
        fingerprint = inventory_revision(row)
        revision = _ref("NA004", "mapping", key)
        source = "fixture:native-acceptance:NA004:" + key
        connection.execute("""insert into library.track_popularity_mapping_versions
            (track_id,revision,inventory_revision,recording_mbid,artist_mbid,source_entity_id,mapped_at)
            values(%s,%s,%s,%s,%s,%s,%s)""",
            (track_id, revision, fingerprint, recording, artist, source, now))
        connection.execute("""insert into library.track_popularity_mapping_slots
            (track_id,current_revision,checked_inventory_revision,last_result,last_attempt_at)
            values(%s,%s,%s,'ready',%s)""", (track_id, revision, fingerprint, now))
        observation = PopularityObservation("lastfm", "overall_scrobbles", source,
            _ref("NA004", "provider", key), now, now, counts[key], "resolved")
        status, stored = put_observation(connection, observation)
        _require(status == "accepted" and stored == observation, "popularity observation was not appended")
    for row in read_inventory(connection, library_id, track_ids=list(by_id)):
        key = by_id[row["original_local_track_id"]]
        track, snapshot, reason = normalize_cached_inventory_row(row)
        _require(reason is None and track is not None and snapshot is not None
                 and row["mapped_inventory_revision"] == inventory_revision(row)
                 and row["checked_inventory_revision"] == inventory_revision(row)
                 and row["count"] == counts[key], "stored popularity evidence does not resolve")


def _baseline(connection) -> int:
    from isolatedPostgres import SETUP_ROLE, _assert_connected_role

    _assert_connected_role(connection, SETUP_ROLE)
    migrations = Path(__file__).resolve().parents[3] / "migrations" / "postgres"
    expected = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                for path in migrations.glob("*.sql") if path.is_file()}
    applied = {row["migration_name"]: row["checksum"] for row in connection.execute(
        "select migration_name,checksum from ops.schema_migrations").fetchall()}
    _require(bool(expected) and "0141_album_favorites.sql" in expected and applied == expected,
             "exact candidate migration ledger is required")
    libraries = connection.execute("""select l.id,b.account_id from library.libraries l
        join app.bootstrap_owners b on b.account_id=l.owner_account_id
        where b.owner_key='local-bootstrap-owner' and l.name='Local Library' and l.library_kind='local'""").fetchall()
    _require(len(libraries) == 1, "unique bootstrap library is required")
    library_id, bootstrap = libraries[0]["id"], libraries[0]["account_id"]
    _require(connection.execute("select count(*) as n from library.libraries").fetchone()["n"] == 1,
             "foreign library residue")
    _require(connection.execute("select count(*) as n from app.accounts where id<>%s",
                                (bootstrap,)).fetchone()["n"] == 0, "foreign account residue")
    for table in ("app.account_sessions", "app.album_ratings", "app.album_lists", "app.album_list_items",
                  "app.album_list_item_progress", "integration.listen_history", "catalog.release_groups",
                  "library.catalog_album_links", "library.track_popularity_mapping_versions",
                  "library.track_popularity_mapping_slots", "catalog.popularity_source_observations",
                  "catalog.popularity_source_slots", *("app." + table for table in GOAL_TABLES)):
        _require(connection.execute("select count(*) as n from " + table).fetchone()["n"] == 0,
                 "disposable seed baseline is not empty")
    _require(connection.execute("select library.relation_alias_endpoints_ready(%s) as ready",
                                (library_id,)).fetchone()["ready"] is True,
             "ordinary relation aliases are not ready")
    return library_id


def seed_native_acceptance(setup_database_url: str) -> dict:
    """Resolve actual persisted identities, seed five disjoint cases and verify."""
    from config import build_auth_config
    from isolatedPostgres import _connect
    from music_app.services.library_mix_inventory_postgres import local_identity, read_inventory
    from mutagen.mp3 import MP3

    now, auth_config = datetime.now(timezone.utc), build_auth_config()
    with _connect(setup_database_url) as connection:
        library_id = _baseline(connection)
        rows = connection.execute("""select t.id,t.track_key,t.title,t.track_number,t.duration_seconds,
            t.album_id,t.artist_id,a.album_key,a.title as album_title,ar.name as artist,f.private_path,
            f.scan_cache_stale,f.metadata#>>'{scan_cache,file_entry,genre}' as genre
            from library.local_tracks t
            join library.local_albums a on a.id=t.album_id and a.library_id=t.library_id
            join library.local_artists ar on ar.id=t.artist_id and ar.library_id=t.library_id
            join library.local_track_files f on f.track_id=t.id
            where t.library_id=%s order by t.id""", (library_id,)).fetchall()
        _require(len(rows) == 30 and len({row["id"] for row in rows}) == 30
                 and len({row["album_id"] for row in rows}) == 10
                 and len({row["artist_id"] for row in rows}) == 10,
                 "canonical inventory cardinality is invalid")
        evidence = {row["original_local_track_id"]: row for row in read_inventory(connection, library_id)}
        _require(set(evidence) == {row["id"] for row in rows}, "inventory evidence cardinality is invalid")
        cases, account_ids = {}, []
        for case_key in CASE_KEYS:
            catalog = {"tracks": {}, "albums": {}}
            for key, album_key, direction, album_label, track_label, number, _frequency in TRACK_SPECS:
                artist, album, title = (f"Native {case_key} {label}"
                                        for label in (direction, album_label, track_label))
                matches = [row for row in rows if (row["artist"], row["album_title"], row["title"])
                           == (artist, album, title)]
                _require(len(matches) == 1, case_key + " has ambiguous inventory identity")
                row = matches[0]
                facts = evidence[row["id"]]
                _require(not row["scan_cache_stale"] and facts["availability"] == "local"
                         and row["track_number"] == number and float(row["duration_seconds"]) == 120
                         and row["genre"] == "jazz",
                         case_key + " has unreadable inventory")
                with Path(row["private_path"]).open("rb") as audio:
                    _require(119 <= MP3(audio).info.length <= 122, case_key + " audio is unreadable")
                _require(local_identity(facts) == (_ref(case_key, "recording", key),
                         _ref(case_key, "artist", direction), None), case_key + " recording identity is invalid")
                _require(all(tags.get("recording") == _ref(case_key, "recording", key)
                             for tags in facts["file_tags"]), case_key + " recording tags are inconsistent")
                catalog["tracks"][key] = {"id": row["id"], "key": row["track_key"],
                    "path": row["private_path"], "title": title, "artist": artist,
                    "albumTitle": album, "trackNumber": number}
                _require(row["album_key"] == artist.lower() + "::" + album.lower(),
                         case_key + " has an unexpected public album key")
                album_data = {"id": row["album_id"], "key": row["album_key"],
                    "ref": _ref(case_key, "catalog", album_key), "title": album, "artist": artist}
                _require(album_key not in catalog["albums"] or catalog["albums"][album_key] == album_data,
                         case_key + " has inconsistent album parents")
                catalog["albums"][album_key] = album_data
            for album in catalog["albums"].values():
                connection.execute("""insert into catalog.release_groups
                    (ref,title,artist_display,release_year,created_at) values(%s,%s,%s,2026,%s)""",
                    (album["ref"], album["title"], album["artist"], now))
                connection.execute("""insert into library.catalog_album_links
                    (library_id,local_album_id,catalog_ref,admitted_at) values(%s,%s,%s,%s)""",
                    (library_id, album["id"], album["ref"], now))
            actor = _account(connection, library_id, case_key, "actor", auth_config)
            friend = _account(connection, library_id, case_key, "friend", auth_config)
            account_ids.extend((actor["id"], friend["id"]))
            connection.execute("""insert into app.friend_connections
                (library_id,low_account_id,high_account_id,requester_account_id,state,origin)
                values(%s,%s,%s,%s,'accepted','request')""",
                (library_id, min(actor["id"], friend["id"]), max(actor["id"], friend["id"]), actor["id"]))
            first = catalog["albums"]["first"]
            for account, rating, favorite in ((actor, 3, False), (friend, 8, True)):
                connection.execute("""insert into app.album_ratings
                    (account_id,library_id,album_key,rating,favorite,provenance,created_at,updated_at)
                    values(%s,%s,%s,%s,%s,'synthetic_fixture',%s,%s)""",
                    (account["id"], library_id, first["key"], rating, favorite, now, now))
                stored_taste = connection.execute("""select rating,favorite,preference_revision
                    from app.album_ratings where account_id=%s and library_id=%s and album_key=%s""",
                    (account["id"], library_id, first["key"])).fetchall()
                _require(stored_taste == [{"rating": rating, "favorite": favorite, "preference_revision": 1}],
                         case_key + " account taste ownership is invalid")
                if case_key == "NA001":
                    _history(connection, library_id, account, case_key, catalog, now)
                    history = connection.execute("""select track_id from integration.listen_history
                        where account_id=%s and library_id=%s order by played_at desc""",
                        (account["id"], library_id)).fetchall()
                    _require([row["track_id"] for row in history] ==
                             [catalog["tracks"][key]["id"] for key in ("one", "two", "three")],
                             case_key + " recent history ownership is invalid")
            public = {"caseKey": case_key,
                "friend": {"accountRef": friend["accountRef"], "displayName": friend["displayName"]},
                "catalog": {"albums": catalog["albums"],
                            "tracks": {key: {"title": track["title"]} for key, track in catalog["tracks"].items()}},
                "expected": {"actorRating": 3, "actorFavorite": False, "friendRating": 8,
                             "friendFavorite": True, "albumCount": 2, "trackCount": 6,
                             "historyCount": 3 if case_key == "NA001" else 0, "goalCount": 0}}
            if case_key in ("NA003", "NA005"):
                public["top"] = _top(connection, library_id, actor, case_key, catalog, now)
            if case_key == "NA004":
                _popularity(connection, library_id, catalog, now)
            cases[case_key] = {"actor": {"username": actor["username"], "password": PASSWORD}, "public": public}
        _require(len(set(account_ids)) == 10, "case accounts are not disjoint")
        expected_counts = {
            "app.account_credentials": 10, "app.album_ratings": 10, "app.friend_connections": 5,
            "app.album_lists": 2, "app.album_list_items": 4, "app.album_list_item_progress": 0,
            "integration.listen_history": 6, "catalog.release_groups": 10, "library.catalog_album_links": 10,
            "library.track_popularity_mapping_versions": 6, "library.track_popularity_mapping_slots": 6,
            "catalog.popularity_source_observations": 6, "catalog.popularity_source_slots": 6,
            **{"app." + table: 0 for table in GOAL_TABLES},
        }
        for table, expected in expected_counts.items():
            # Bootstrap credentials belong to the launcher, not this seed.
            clause = " where account_id=any(%s)" if table == "app.account_credentials" else ""
            params = (account_ids,) if clause else ()
            _require(connection.execute("select count(*) as n from " + table + clause, params).fetchone()["n"] == expected,
                     "final owned row cardinality is invalid")
        _require(connection.execute("""select count(*) as n from library.library_memberships
            where library_id=%s and account_id=any(%s)""", (library_id, account_ids)).fetchone()["n"] == 10,
                 "case membership ownership is invalid")
        _require(connection.execute("select library.relation_alias_endpoints_ready(%s) as ready",
                                    (library_id,)).fetchone()["ready"] is True, "final aliases are not ready")
    return {"scenario": "native-acceptance", "version": 1, "cases": cases}
