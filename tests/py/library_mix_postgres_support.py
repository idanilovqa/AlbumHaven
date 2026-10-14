"""Uniquely owned normal-table data for the real Library Mix SQL boundary.

No app bootstrap, import replacement, synthetic connection, provider request or
test-only runtime table. The runner supplies a separately migrated disposable DB.
"""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from functools import partial
import hashlib
import os
from pathlib import Path
from uuid import uuid4
import wave

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest

from tests.e2e.support import isolatedPostgres

from music_app.services.current_actor import (
    ActorState, CapabilityGrant, CurrentActor, LibraryRelationship,
)
from music_app.services.library_mix_inventory_postgres import inventory_revision, read_inventory
from music_app.services import library_mix_postgres as mixes
from music_app.services.library_roots import resolve_configured_media_path
from music_app.services.owned_playlists import (
    ACCESS, BROWSE, CREATE, ITEMS, MANAGE, SETTINGS, normalize_playlist_command,
)
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.popularity_observations_postgres import put_observation
from music_app.services.popularity_snapshots import PopularityObservation


MEDIA = "library.media.read"
ACTIONS = (BROWSE, CREATE, MANAGE, ITEMS, ACCESS, SETTINGS)


@pytest.fixture(scope="session")
def mix_urls():
    # Reuse the repository's loopback/password-free/job-suffix admission, but
    # keep these uniquely owned rows on CI's separate persistent-contract DB.
    setup, app = isolatedPostgres.resolve_isolated_database_urls({
        isolatedPostgres.SETUP_DATABASE_ENV: os.environ.get("DATABASE_MIGRATOR_URL", ""),
        isolatedPostgres.RUNTIME_DATABASE_ENV:
            os.environ.get("ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL", ""),
    })
    pgpass = os.environ.get("PGPASSFILE", "")
    assert pgpass and Path(pgpass).is_file(), "The standard fixture PGPASSFILE is required"
    with psycopg.connect(app, row_factory=dict_row) as con:
        isolatedPostgres._assert_connected_role(con, isolatedPostgres.RUNTIME_ROLE)
        role = con.execute("""select
            pg_has_role(current_user, 'album_haven_app', 'USAGE') as inherits_app,
            not pg_has_role(current_user, 'album_haven_migrator', 'MEMBER') as not_migrator,
            not exists (select 1 from pg_roles
                where pg_has_role(current_user, oid, 'MEMBER')
                  and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)
            ) as no_elevated_role""").fetchone()
        assert role == {"inherits_app": True, "not_migrator": True, "no_elevated_role": True}, \
            "Runtime must inherit the minimum-privilege app role without elevated authority"
    isolatedPostgres.assert_runtime_grants(app)
    with psycopg.connect(setup, row_factory=dict_row) as con:
        isolatedPostgres._assert_connected_role(con, isolatedPostgres.SETUP_ROLE)
        for table in (
            "app.playlist_library_mixes", "app.playlist_creation_sources",
            "app.playlist_items", "app.playlist_operations",
            "library.track_popularity_mapping_versions", "library.track_popularity_mapping_slots",
            "catalog.popularity_source_slots", "catalog.popularity_source_observations",
            "library.popularity_refresh_jobs",
        ):
            assert con.execute("select to_regclass(%s) as name", (table,)).fetchone()["name"], table
    return app, setup


class MixDatabase:
    def __init__(self, urls, media_root):
        self.app_url, self.setup_url = urls
        self.token = uuid4().hex
        self.now = datetime.now(timezone.utc)
        self.clock_time = self.now
        self.root_path = Path(media_root).resolve()
        self.library = None
        self.accounts = []
        self.tracks = []
        self.recordings = {}
        self.source_ids = {}
        self.counts = {}
        self.artist_mbids = [str(uuid4()), str(uuid4())]
        self.albums = []
        self.config = {"ALBUM_HAVEN_APP_DATABASE_URL": self.app_url}
        # The real confinement function accepts explicit roots through its
        # existing interface; no filesystem or app-owned API is mocked.
        self.media_resolver = partial(resolve_configured_media_path,
                                      configured_root_paths=(self.root_path,))
        self.service = PostgresOwnedPlaylistsService(
            self.config, connect=self.app_connect, clock=lambda: self.clock_time)

    @staticmethod
    def app_connect(url):
        return psycopg.connect(url, row_factory=dict_row)

    def connect(self):
        return psycopg.connect(self.setup_url, row_factory=dict_row)

    def actor(self, con):
        name = "mix-" + uuid4().hex
        account = con.execute("""insert into app.accounts(display_name,account_kind,
            username_display,username_normalized,contact_email,contact_email_normalized)
            values(%s,'managed_user',%s,%s,%s,%s) returning id""",
            (name, name, name, name + "@example.test", name + "@example.test")).fetchone()["id"]
        self.accounts.append(account)
        session = con.execute("""insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,%s,%s,%s,%s,%s) returning id""", (
                account, hashlib.sha256(uuid4().bytes).digest(), self.now, self.now, self.now,
                self.now + timedelta(hours=3), self.now + timedelta(days=1))).fetchone()["id"]
        return CurrentActor(state=ActorState.ACTIVE, account_id=account, session_id=session,
                            authenticated_at=self.now)

    def member(self, con, *, actions=ACTIONS):
        actor = self.actor(con)
        con.execute("""insert into library.library_memberships
            (account_id,library_id,membership_role) values(%s,%s,'member')""",
            (actor.account_id, self.library))
        for action in actions:
            con.execute("""insert into app.capabilities
                (account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)""",
                (actor.account_id, action, self.library))
        return replace(actor, current_library_id=self.library,
            library_relationships=(LibraryRelationship(self.library, "member", False),),
            capability_grants=tuple(CapabilityGrant(action, "library", self.library) for action in actions))

    def context(self, actor=None):
        return PolicyContext.build(actor=actor or self.owner, action=BROWSE, library_id=self.library,
            deployment_mode="self_hosted", request_origin=RequestOrigin("network", "synthetic:mix"),
            client_surface_class="private_web")

    def setup(self):
        with self.connect() as con:
            primary = self.actor(con)
            self.library = con.execute("""insert into library.libraries(owner_account_id,name)
                values(%s,%s) returning id""", (primary.account_id, "Mix " + self.token)).fetchone()["id"]
            self.owner = self.member(con)
            self.root_id = con.execute("""insert into library.library_roots(library_id,root_path,metadata)
                values(%s,%s,%s) returning id""",
                (self.library, str(self.root_path), Jsonb({"root_id": self.token}))).fetchone()["id"]
            for group in range(2):
                artist = con.execute("""insert into library.local_artists(library_id,artist_key,name)
                    values(%s,%s,%s) returning id""",
                    (self.library, f"{self.token}:artist:{group}", f"Mix Artist {group}")).fetchone()["id"]
                album = con.execute("""insert into library.local_albums
                    (library_id,artist_id,album_key,title,release_year)
                    values(%s,%s,%s,%s,2000) returning id""",
                    (self.library, artist, f"{self.token}:album:{group}", f"Mix Album {group}")).fetchone()["id"]
                self.albums.append(album)
                for number in range(3):
                    index = group * 3 + number
                    recording = str(uuid4())
                    path = self.root_path / f"{index}.wav"
                    with wave.open(str(path), "wb") as audio:
                        audio.setnchannels(1)
                        audio.setsampwidth(2)
                        audio.setframerate(8000)
                        audio.writeframes(b"\x00\x00" * 800)
                    track = con.execute("""insert into library.local_tracks
                        (library_id,artist_id,album_id,track_key,title,disc_number,track_number,duration_seconds)
                        values(%s,%s,%s,%s,%s,1,%s,180) returning id""",
                        (self.library, artist, album, f"{self.token}:{index}", f"Mix Track {index}", number + 1)).fetchone()["id"]
                    tags = {"musicbrainz_recording_id": recording,
                            "musicbrainz_artist_ids": [self.artist_mbids[group]],
                            "musicbrainz_album_artist_ids": [self.artist_mbids[group]]}
                    con.execute("""insert into library.local_track_files
                        (track_id,library_root_id,private_path,content_signature,metadata)
                        values(%s,%s,%s,'original',%s)""",
                        (track, self.root_id, str(path), Jsonb({"scan_cache": {"file_entry": tags}})))
                    self.tracks.append(track)
                    self.recordings[track] = recording
                    self.source_ids[track] = f"fixture:{self.token}:{index}"
            rows = read_inventory(con, self.library)
            for row in rows:
                track = row["original_local_track_id"]
                index = self.tracks.index(track)
                revision = str(uuid4())
                fingerprint = inventory_revision(row)
                con.execute("""insert into library.track_popularity_mapping_versions
                    (track_id,revision,inventory_revision,recording_mbid,artist_mbid,source_entity_id,mapped_at)
                    values(%s,%s,%s,%s,%s,%s,%s)""", (
                        track, revision, fingerprint, self.recordings[track],
                        self.artist_mbids[index // 3], self.source_ids[track], self.now))
                con.execute("""insert into library.track_popularity_mapping_slots
                    (track_id,current_revision,checked_inventory_revision,last_result,last_attempt_at)
                    values(%s,%s,%s,'ready',%s)""", (track, revision, fingerprint, self.now))
                self.observe(con, track, (300, 200, 100, 90, 80, 70)[index])

    def observe(self, con, track, count, *, state="resolved"):
        # A later accepted source revision simulates an already-completed
        # provider refresh, wholly outside the request under test.
        self.now += timedelta(microseconds=1)
        status, _ = put_observation(con, PopularityObservation(
            "lastfm", "overall_scrobbles", self.source_ids[track], str(uuid4()),
            self.now, self.now, count, state))
        assert status == "accepted"
        self.counts[track] = count

    def rebind_mappings(self, con, track_ids):
        """Append setup evidence after changing this test's physical tag rows."""
        for row in read_inventory(con, self.library, track_ids=track_ids):
            revision = str(uuid4())
            fingerprint = inventory_revision(row)
            con.execute("""insert into library.track_popularity_mapping_versions
                (track_id,revision,inventory_revision,recording_mbid,artist_mbid,source_entity_id,mapped_at)
                select track_id,%s,%s,recording_mbid,artist_mbid,source_entity_id,%s
                from library.track_popularity_mapping_versions where track_id=%s and revision=%s""",
                (revision, fingerprint, self.now, row["original_local_track_id"], row["mapping_revision"]))
            con.execute("""update library.track_popularity_mapping_slots
                set current_revision=%s,checked_inventory_revision=%s where track_id=%s""",
                (revision, fingerprint, row["original_local_track_id"]))

    def capture(self, *, auto=True, per=2, basis="per_album", actor=None, constraints=None):
        return mixes.capture(self.service, self.context(actor), {
            "selection_basis": basis, "songs_per_group": per, "auto_update": auto,
            "playback_order": "regular"}, constraints=constraints)["data"]

    def create_command(self, source, **changes):
        body = {"request_key": str(uuid4()), "source_protocol": source["source_protocol"],
                "mode": "ordinary", "source": source["source"], "title": "Saved Library Mix",
                "entry_refs": [row["entry_ref"] for row in source["entries"]], **changes}
        return normalize_playlist_command("create", body)

    def save(self, source=None, *, auto=True, per=2, **changes):
        source = source if source is not None else self.capture(auto=auto, per=per)
        command = self.create_command(source, **changes)
        return self.service.execute(self.context(), command), command, source

    def mutate(self, receipt, action, *, actor=None, **changes):
        command = normalize_playlist_command(action, {
            "request_key": str(uuid4()), "revision": receipt["revision"], **changes},
            playlist_ref=receipt["playlist_id"])
        return self.service.execute(self.context(actor), command)

    def state(self, ref):
        with self.connect() as con:
            playlist = dict(con.execute("select * from app.playlists where ref=%s", (ref,)).fetchone())
            items = [dict(row) for row in con.execute("""select * from app.playlist_items
                where playlist_ref=%s order by position""", (ref,)).fetchall()]
            recipe = con.execute("select * from app.playlist_library_mixes where playlist_ref=%s", (ref,)).fetchone()
            return playlist, items, dict(recipe) if recipe else None

    def total(self, table):
        assert table in {"playlists", "playlist_items", "playlist_operations", "playlist_library_mixes"}
        with self.connect() as con:
            return con.execute(f"select count(*) as n from app.{table} where library_id=%s",
                               (self.library,)).fetchone()["n"]

    def queue(self, source, *, refs=None, actor=None, constraints=None):
        entries = [row["entry_ref"] for row in source["entries"]] if refs is None else refs
        return mixes.native_queue(self.service, self.context(actor), {
            "source_ref": source["source"]["ref"], "source_revision": source["source"]["revision"],
            "entry_refs": entries, "starting_entry_ref": entries[0]},
            constraints=constraints, media_resolver=self.media_resolver)

    def cleanup(self):
        with self.connect() as con:
            if self.library is not None:
                con.execute("delete from app.playlist_operations where library_id=%s", (self.library,))
                con.execute("delete from app.playlists where library_id=%s", (self.library,))
                con.execute("delete from library.libraries where id=%s", (self.library,))
            for account in self.accounts:
                con.execute("delete from app.accounts where id=%s", (account,))
            keys = list(self.source_ids.values())
            if keys:
                con.execute("""update catalog.popularity_source_slots set current_revision=null
                    where provider='lastfm' and metric='overall_scrobbles' and source_entity_id=any(%s)""", (keys,))
                con.execute("""delete from catalog.popularity_source_observations
                    where provider='lastfm' and metric='overall_scrobbles' and source_entity_id=any(%s)""", (keys,))
                con.execute("""delete from catalog.popularity_source_slots
                    where provider='lastfm' and metric='overall_scrobbles' and source_entity_id=any(%s)""", (keys,))


@pytest.fixture
def mix_db(mix_urls, tmp_path):
    database = MixDatabase(mix_urls, tmp_path)
    try:
        database.setup()
        yield database
    finally:
        database.cleanup()
