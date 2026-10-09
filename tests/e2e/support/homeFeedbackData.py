"""Pre-start synthetic Home data in normal product tables, never runtime state."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import time
from uuid import NAMESPACE_URL, uuid4, uuid5

from isolatedLibraryApp import generate_playback_start_fixture_audio


PASSWORD = "Home Feedback Synthetic Passphrase 2026!"
CASE_KEYS = tuple(f"FB{number:03}" for number in (*range(1, 11), 13))
RECENT_ORDER = ("opening", "second", "opening", "missing", "arrival", "twin")
# Same title, different canonical Album and Artist identities are intentional.
TRACK_SPECS = (
    ("opening", "Home Feedback Artist", "Home Feedback Album", "Opening Signal", 1, 440),
    ("second", "Home Feedback Artist", "Home Feedback Album", "Second Signal", 2, 550),
    ("missing", "Home Feedback Artist", "Home Feedback Album", "Missing Signal", 3, 660),
    ("arrival", "Home Feedback Artist", "Boundary Album", "Arrival Signal", 1, 770),
    ("twin", "Other Feedback Artist", "Home Feedback Album", "Different Identity Signal", 1, 880),
)


def _ref(label: str) -> str:
    return str(uuid5(NAMESPACE_URL, "album-haven:home-feedback:" + label))


def prepare_home_media(library_root: Path) -> dict[str, dict]:
    """Generate real decodable audio and matching tags before the first scan."""
    from mutagen.easyid3 import EasyID3
    from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION
    from PIL import Image

    inventory = {}
    for key, artist, album, title, number, frequency in TRACK_SPECS:
        track = generate_playback_start_fixture_audio(
            library_root, library_root / artist / album / f"{number:02} - {title}.mp3",
            duration_seconds=120, frequency_hz=frequency,
        ).resolve()
        tags = EasyID3()
        for field, value in {"artist": artist, "albumartist": artist, "album": album,
                             "title": title, "tracknumber": str(number),
                             "discnumber": "1", "date": "2026"}.items():
            tags[field] = value
        tags.save(track)
        cover = track.parent / "cover.png"
        if not cover.exists():
            Image.new("RGB", (64, 64), (40, frequency % 200, 140)).save(cover)
        stat = track.stat()
        inventory[str(track)] = {
            "path": str(track), "mtime": stat.st_mtime, "size": stat.st_size,
            "artist": artist, "album_artist": artist, "album": album, "title": title,
            "year": 2026, "release_date": "2026", "track_number": number,
            "disc_number": 1, "disc_number_raw": "1",
            "duration_seconds": 120, "duration_display": "2:00", "cover_path": str(cover),
            "library_root_id": "isolated-e2e-root", "library_root_category": "main_library",
            "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
        }
    return inventory


def persist_home_inventory(setup_database_url: str, library_root: Path, inventory: dict) -> None:
    """Record an ordinary scan, then an observed disappearance before ASGI starts."""
    from config import PERSISTENCE_BACKEND_POSTGRES
    from music_app.services.library_roots import library_root_cache_identity, save_library_root_settings
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

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
    adapter = PostgresScanCacheAdapter(config)
    identity = library_root_cache_identity(config)
    adapter.save_snapshot(config["CACHE_PATH"], inventory, identity, time.time(),
                          rebuild_relation_projection=True)
    missing_path = next(path for path, row in inventory.items() if row["title"] == "Missing Signal")
    Path(missing_path).unlink()
    active = {path: row for path, row in inventory.items() if path != missing_path}
    adapter.save_snapshot(config["CACHE_PATH"], active, identity, time.time(),
                          observed_library_root_ids={"isolated-e2e-root"},
                          rebuild_relation_projection=True)


def _account(connection, library_id: int, case_key: str, role: str, auth_config: dict) -> dict:
    from music_app.services.auth_passwords import hash_password
    from music_app.services.capability_assignments import build_assignment, store_assignment

    username = f"home-{case_key.lower()}-{role.lower()}"
    display_name = f"{case_key} {'Add Only' if role == 'addOnly' else role.title()}"
    email = username + "@example.test"
    credential = hash_password(PASSWORD, username=username, email=email,
                               breached_checker=lambda _password: False,
                               argon2=auth_config["argon2"], policy_version=auth_config["argon2_policy_version"])
    account_id = connection.execute("""insert into app.accounts
        (display_name,account_kind,username_display,username_normalized,contact_email,contact_email_normalized)
        values (%s,'managed_user',%s,%s,%s,%s) returning id""",
        (display_name, username, username, email, email)).fetchone()["id"]
    connection.execute("""insert into app.account_credentials
        (account_id,encoded_hash,hash_algorithm,hash_policy_version,credential_version,administrator_set)
        values(%s,%s,'argon2id',%s,1,false)""",
        (account_id, credential.encoded_hash, credential.policy_version))
    connection.execute("""insert into library.library_memberships
        (account_id,library_id,membership_role) values(%s,%s,'member')""", (account_id, library_id))
    extras = ["library.playlists.manage", "library.playlists.items.manage",
              "library.playlists.access.manage", "library.track_preferences.manage"]
    if role != "addOnly":
        extras.append("library.playlists.create")
    assignment = build_assignment(["listener"], extras)
    store_assignment(connection, account_id=account_id, library_id=library_id, assignment=assignment)
    for capability in assignment.effective_keys:
        connection.execute("""insert into app.capabilities
            (account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)""",
            (account_id, capability, library_id))
    connection.execute("insert into integration.lastfm_settings(account_id,timezone_name) values(%s,'UTC')",
                       (account_id,))
    account_ref = connection.execute("select account_ref from app.social_profiles where account_id=%s",
                                     (account_id,)).fetchone()["account_ref"]
    return {"id": account_id, "accountRef": str(account_ref), "username": username,
            "password": PASSWORD, "displayName": display_name, "libraryId": library_id}


def _playlist(connection, library_id: int, owner: dict, case_key: str, name: str,
              track_keys: tuple[str, ...], catalog: dict, *, shared=False) -> dict:
    playlist_ref = _ref(f"{case_key}:{name}")
    title = f"{case_key} {name} Playlist"
    connection.execute("""insert into app.playlists(ref,owner_account_id,library_id,title,visibility)
        values(%s,%s,%s,%s,%s)""",
        (playlist_ref, owner["id"], library_id, title, "server_shared" if shared else "private"))
    item_refs, track_ids, seen = [], [], set()
    for position, key in enumerate(track_keys, 1):
        track = catalog["tracks"][key]
        item_ref = _ref(f"{case_key}:{name}:{position}")
        # A saved explicit local match may resolve a formerly unidentified source
        # occurrence to the same file as another item. Musical-original uniqueness
        # remains intact; these are distinct persisted occurrence UUIDs.
        original_id = track["id"] if track["id"] not in seen else None
        seen.add(track["id"])
        connection.execute("""insert into app.playlist_items
            (ref,playlist_ref,library_id,position,original_local_track_id,local_track_id,
             title,artist,album_title,original_album_id,release_year,disc_number,track_number,
             duration_seconds,source_kind,source_label)
            values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,2026,1,%s,%s,%s,%s)""",
            (item_ref, playlist_ref, library_id, position, original_id, track["id"],
             track["title"], track["artist"], track["albumTitle"], track["albumId"],
             track["trackNumber"], track["durationSeconds"],
             "playlist" if original_id is None else "library",
             "Saved explicit local match" if original_id is None else "Library"))
        item_refs.append(item_ref)
        track_ids.append(track["id"])
    return {"id": playlist_ref, "ref": playlist_ref, "title": title, "revision": "1",
            "trackKeys": list(track_keys), "trackIds": track_ids, "itemRefs": item_refs}


def _history(connection, library_id: int, account: dict, catalog: dict, now: datetime) -> dict:
    ids = []
    for index, key in enumerate(RECENT_ORDER):
        track = catalog["tracks"][key]
        played_at = now - timedelta(minutes=2 + index)
        payload = {"title": track["title"], "artist": track["artist"], "album_artist": track["artist"],
                   "album": track["albumTitle"], "track_ref": track["path"], "path": track["path"],
                   "track_number": track["trackNumber"], "total_listened_seconds": 120,
                   "max_contiguous_seconds": 120}
        row = connection.execute("""insert into integration.listen_history
            (account_id,library_id,track_id,track_key,played_at,listen_source,source_family,source_entry_id,
             measurement_version,measured_listened_seconds,max_measured_contiguous_seconds,
             finalized,last_sequence,device_id,session_id,metadata)
            values(%s,%s,%s,%s,%s,'local','rendered_local_listen_session',%s,
                   'rendered-pcm-v1',120,120,true,1,%s,%s,%s::jsonb) returning id""",
            (account["id"], library_id, track["id"], track["key"], played_at, str(uuid4()),
             uuid4(), uuid4(), json.dumps({"source_payload": payload}))).fetchone()
        ids.append(row["id"])
    # An imported listen without canonical local identity must remain neutral.
    unknown = connection.execute("""insert into integration.listen_history
        (account_id,library_id,played_at,listen_source,source_family,source_entry_id,metadata)
        values(%s,%s,%s,'local','runtime_listen_history_adapter',%s,%s::jsonb) returning id""",
        (account["id"], library_id, now - timedelta(minutes=12), str(uuid4()),
         json.dumps({"source_payload": {"title": "Unknown Signal", "artist": "Unknown Artist",
                                      "album": "Unknown Album", "total_listened_seconds": 120,
                                      "max_contiguous_seconds": 120}}))).fetchone()
    return {"trackKeys": list(RECENT_ORDER), "eventIds": ids,
            "unknownEventId": unknown["id"], "unknownTitle": "Unknown Signal", "listenCount": len(ids) + 1}


def seed_home_feedback(setup_database_url: str) -> dict:
    """Build complete, independently owned cases once, while the app is stopped."""
    from config import build_auth_config
    from isolatedPostgres import _connect
    from music_app.services.playlist_creation_sources_postgres import inventory_rows

    auth_config = build_auth_config()
    now = datetime.now(timezone.utc)
    with _connect(setup_database_url) as connection:
        library_id = connection.execute("""select l.id from library.libraries l
            join app.bootstrap_owners b on b.account_id=l.owner_account_id
            where b.owner_key='local-bootstrap-owner' and l.library_kind='local'""").fetchone()["id"]
        rows = connection.execute("""select t.id,t.track_key,t.title,t.track_number,t.duration_seconds,
            t.album_id,t.artist_id,a.album_key,a.title as album_title,ar.name as artist,f.private_path,
            f.scan_cache_stale from library.local_tracks t
            join library.local_albums a on a.id=t.album_id
            join library.local_artists ar on ar.id=t.artist_id
            join library.local_track_files f on f.track_id=t.id
            where t.library_id=%s order by t.id""", (library_id,)).fetchall()
        catalog = {"tracks": {}, "albums": {}}
        for key, artist, album, title, number, _frequency in TRACK_SPECS:
            candidates = [row for row in rows if (row["artist"], row["album_title"], row["title"])
                          == (artist, album, title)]
            if len(candidates) != 1:
                raise RuntimeError(f"Home feedback inventory identity is ambiguous: {key}.")
            row = candidates[0]
            if row["scan_cache_stale"] != (key == "missing"):
                raise RuntimeError(f"Home feedback scan evidence is wrong: {key}.")
            catalog["tracks"][key] = {
                "id": row["id"], "key": row["track_key"], "path": row["private_path"],
                "title": title, "artist": artist, "albumTitle": album, "trackNumber": number,
                "albumId": row["album_id"], "albumKey": row["album_key"], "artistId": row["artist_id"],
                "inventoryTrackRef": f"inventory-track:{library_id}:{row['id']}",
                "durationSeconds": float(row["duration_seconds"]),
                "availability": "missing" if key == "missing" else "local",
            }
        availability = inventory_rows(connection, library_id, [track["id"] for track in catalog["tracks"].values()],
                                      config={"ALBUM_HAVEN_APP_DATABASE_URL": setup_database_url})
        for key, track in catalog["tracks"].items():
            if availability.get(track["id"], {}).get("availability") != track["availability"]:
                raise RuntimeError(f"Home feedback availability is not confirmed by normal source evidence: {key}.")
        for album_key, track_key in (("main", "opening"), ("boundary", "arrival"), ("twin", "twin")):
            track = catalog["tracks"][track_key]
            catalog["albums"][album_key] = {"id": track["albumId"], "key": track["albumKey"],
                "title": track["albumTitle"], "artist": track["artist"], "artistId": track["artistId"]}
        cases = {}
        for case_key in CASE_KEYS:
            actor = _account(connection, library_id, case_key, "actor", auth_config)
            friend = _account(connection, library_id, case_key, "friend", auth_config)
            connection.execute("""insert into app.friend_connections
                (library_id,low_account_id,high_account_id,requester_account_id,state,origin)
                values(%s,%s,%s,%s,'accepted','request')""",
                (library_id, min(actor["id"], friend["id"]), max(actor["id"], friend["id"]), actor["id"]))
            for account, rating, love, album_rating in ((actor, 2, "off", 3), (friend, 9, "obsessed", 8)):
                for key in ("opening", "second", "arrival", "twin"):
                    track = catalog["tracks"][key]
                    connection.execute("""insert into app.track_preferences
                        (account_id,library_id,track_id,track_key,rating,love_tier)
                        values(%s,%s,%s,%s,%s,%s)""",
                        (account["id"], library_id, track["id"], track["key"], rating, love))
                for album in catalog["albums"].values():
                    connection.execute("""insert into app.album_ratings(account_id,library_id,album_key,rating,provenance)
                        values(%s,%s,%s,%s,'synthetic_fixture')""", (account["id"], library_id, album["key"], album_rating))
            cases[case_key] = {
                "actor": actor, "friend": friend,
                "recent": _history(connection, library_id, actor, catalog, now),
                "friendRecent": _history(connection, library_id, friend, catalog, now),
                "taste": {"actor": {"rating": 2, "loveTier": "off", "albumRating": 3},
                          "friend": {"rating": 9, "loveTier": "obsessed", "albumRating": 8}},
                "playlists": {
                    "available": _playlist(connection, library_id, actor, case_key, "Available",
                                           ("opening", "second", "arrival"), catalog),
                    "missing": _playlist(connection, library_id, actor, case_key, "Missing",
                                         ("opening", "missing", "second"), catalog),
                    "duplicates": _playlist(connection, library_id, actor, case_key, "Duplicates",
                                            ("opening", "second", "opening"), catalog),
                    "friend": _playlist(connection, library_id, friend, case_key, "Friend",
                                        ("opening", "second", "missing"), catalog, shared=True),
                },
            }
        add_only = _account(connection, library_id, "FB010", "addOnly", auth_config)
        cases["FB010"]["addOnly"] = add_only
        cases["FB010"]["playlists"]["addOnly"] = _playlist(
            connection, library_id, add_only, "FB010", "Add Only", ("arrival",), catalog)
        cases["FB010"]["addOnlyRecent"] = _history(connection, library_id, add_only, catalog, now)
    return {"version": 1, "libraryId": library_id, "catalog": catalog, "cases": cases}
