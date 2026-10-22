"""Dedicated bootstrap fixture. Source-only authored; never provisions or resets a DB."""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from functools import partial
import hashlib
import os
from psycopg.conninfo import conninfo_to_dict
from pathlib import Path
from threading import Lock
from uuid import UUID, uuid4
import wave

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest
from tests.e2e.support import isolatedPostgres
from tests.py.popularity_epoch_ledger import completed_epochs, remember_completed, validate_epochs
from tests.py.test_isolated_postgres_live import _dedicated_database_urls_or_skip
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.library_mix_inventory_postgres import inventory_revision, read_inventory
from music_app.services import library_mix_postgres as mixes
from music_app.services.library_roots import resolve_configured_media_path
from music_app.services.owned_playlists import BROWSE
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.popularity_observations_postgres import put_observation
from music_app.services.popularity_snapshots import PopularityObservation
from music_app.services.relation_projection_postgres import replace_relation_alias_endpoints_in_transaction

ACTIONS = (BROWSE,)


def bootstrap_social_baseline(connection, library, baseline=None):
    """Verify only the canonical trigger-created rows; never adopt or repair drift."""
    owners = connection.execute("""select a.id as account_id,a.account_kind,
        a.metadata as account_metadata,b.metadata as owner_metadata
        from app.bootstrap_owners b join app.accounts a on a.id=b.account_id
        join library.libraries l on l.owner_account_id=a.id
        where b.owner_key='local-bootstrap-owner' and l.id=%s
          and l.name='Local Library' and l.library_kind='local'""", (library,)).fetchall()
    source = {"source": "isolated_e2e_launcher"}
    if (type(library) is not int or library <= 0 or len(owners) != 1
            or type(owners[0]["account_id"]) is not int or owners[0]["account_id"] <= 0
            or owners[0]["account_kind"] != "bootstrap_owner"
            or owners[0]["account_metadata"] != source or owners[0]["owner_metadata"] != source):
        raise RuntimeError("Canonical social baseline owner differs.")
    owner = owners[0]["account_id"]
    profiles = connection.execute("""select to_jsonb(p) as data from app.social_profiles p
        where account_id=%s""", (owner,)).fetchall()
    policies = connection.execute("""select to_jsonb(p) as data,isfinite(updated_at) as finite
        from app.friend_policies p where library_id=%s""", (library,)).fetchall()
    if len(profiles) != 1 or len(policies) != 1:
        raise RuntimeError("Canonical trigger-created social rows are missing or duplicated.")
    profile, policy = profiles[0]["data"], policies[0]["data"]
    if (not isinstance(profile, dict) or set(profile) != {"account_id", "account_ref"}
            or type(profile["account_id"]) is not int or profile["account_id"] != owner
            or not isinstance(profile["account_ref"], str)):
        raise RuntimeError("Canonical social profile differs.")
    try:
        valid_ref = str(UUID(profile["account_ref"])) == profile["account_ref"]
    except (ValueError, AttributeError, TypeError):
        valid_ref = False
    if not valid_ref:
        raise RuntimeError("Canonical social profile UUID is invalid.")
    if (not isinstance(policy, dict)
            or set(policy) != {"library_id", "auto_friend", "updated_by_account_id", "updated_at"}
            or type(policy["library_id"]) is not int or policy["library_id"] != library
            or policy["auto_friend"] is not False or policy["updated_by_account_id"] is not None
            or policy["updated_at"] is None or policies[0]["finite"] is not True):
        raise RuntimeError("Canonical friend policy defaults differ.")
    current = {"profile": dict(profile), "policy": dict(policy)}
    if baseline is not None and current != baseline:
        raise RuntimeError("Canonical social baseline changed; quarantine required.")
    return current


def publish_stored(con, library, metadata):
    cache = metadata['scan_cache']
    con.execute('update library.libraries set metadata=%s where id=%s', (Jsonb(metadata), library))
    assert replace_relation_alias_endpoints_in_transaction(con, cache['relation_views'],
        metadata=cache['relation_projection'], relations_last_built=cache['relations_last_built'], stored=True) == 'ready'
    assert con.execute('select library.relation_alias_endpoints_ready(%s) as ready', (library,)).fetchone()['ready']


class BootstrapPopularityDatabase:
    def __init__(self, urls, media_root):
        self.app_url, self.setup_url = urls
        self.readonly_url = os.environ.get("ALBUM_HAVEN_POPULARITY_READONLY_DATABASE_URL", "")
        self.token = uuid4().hex
        self.now = datetime.now(timezone.utc)
        self.clock_time = self.now
        self.root_path = Path(media_root).resolve()
        self.library = None
        self.settings_id = None
        self.connections = []
        self.connection_lock = Lock()
        self.quarantine_reason = None
        self.accounts = []
        self.tracks = []
        self.owned_tracks = set()
        self.owned_overrides = set()
        self.artists = []
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
            self.epoch_identity = retained_database_identity(con)
            self.library, self.bootstrap_owner, self.baseline, self.epoch_baseline = preflight(
                con, self.app_url, self.app_connect, expected_identity=self.epoch_identity,
                epochs=completed_epochs(self.setup_url, self.epoch_identity), exact_epochs=True)
            self.social_baseline = bootstrap_social_baseline(con, self.library)
            validate_readonly_binding(self)
            self.refresh_baseline, self.clock_baseline = preserved_state(con, self.library)
            self.capture_budget_baseline = capture_budget_state(con)
            self.owner = self.member(con)
            self.root_id = con.execute("""insert into library.library_roots(library_id,root_path,metadata)
                values(%s,%s,%s) returning id""",
                (self.library, str(self.root_path), Jsonb({"root_id": self.token}))).fetchone()["id"]
            for group in range(2):
                artist = con.execute("""insert into library.local_artists(library_id,artist_key,name)
                    values(%s,%s,%s) returning id""",
                    (self.library, f"{self.token}:artist:{group}", f"Mix Artist {group}")).fetchone()["id"]
                self.artists.append(artist)
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
                    self.owned_tracks.add(track)
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
        from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
        from music_app.services.current_actor_postgres import PostgresCurrentActorResolver
        sessions = PostgresAuthSessionService(self.config, connect=self.app_connect, clock=lambda: self.clock_time)
        issued = sessions.issue_session(self.owner.account_id)
        self.owner = PostgresCurrentActorResolver(self.config, connect=self.app_connect,
            session_service=sessions).resolve(issued.raw_token)
        assert self.owner.is_authenticated and not self.owner.is_bootstrap_owner
        assert self.owner.account_id != self.bootstrap_owner
        assert self.owner.current_library_id == self.library
        assert any(r.library_id == self.library for r in self.owner.library_relationships)


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

    def quarantine(self, reason):
        # Never retain arbitrary exception text, SQL, URLs, tokens or labels.
        safe = reason if isinstance(reason, str) and reason in {
            'unsafe_worker', 'worker_drain_unproved', 'cleanup_unproved'} else 'unsafe_worker'
        with self.connection_lock:
            if self.quarantine_reason is None:
                self.quarantine_reason = safe

    def app_connect(self, url):
        with self.connection_lock:
            if self.quarantine_reason is not None:
                raise RuntimeError('Fixture quarantined: ' + self.quarantine_reason)
        con = psycopg.connect(url, row_factory=dict_row, connect_timeout=10,
            options='-c statement_timeout=15000 -c lock_timeout=10000')
        with self.connection_lock:
            # Quarantine may race a bounded connect; close rather than issue a lease.
            if self.quarantine_reason is not None:
                con.close()
                raise RuntimeError('Fixture quarantined: ' + self.quarantine_reason)
            self.connections.append(con)
        return con

    def connect(self):
        return self.app_connect(self.setup_url)

    def publish_aliases(self, con, aliases):
        from copy import deepcopy
        metadata = con.execute('select metadata from library.libraries where id=%s',
                               (self.library,)).fetchone()['metadata']
        metadata = deepcopy(metadata)
        groups = {}
        for alias, canonical in aliases.items():
            groups.setdefault(canonical, []).append(alias)
        metadata['scan_cache']['relation_views']['alias_to_canonical'] = dict(aliases)
        metadata['scan_cache']['relation_views']['canonical_to_aliases'] = groups
        publish_stored(con, self.library, metadata)

    def cleanup(self):
        # Reject unknown IDs before deleting recorded case-owned parents and
        # their FK descendants. Phantoms/large-universe inserts are recorded too.
        # Never invoke MixDatabase.cleanup, which deletes the library itself.
        with self.connection_lock:
            if self.quarantine_reason is not None:
                raise RuntimeError('Fixture quarantined: ' + self.quarantine_reason)
            opened = [con for con in self.connections if not con.closed]
        if opened:
            for con in opened:
                con.cancel()
            raise AssertionError('Open fixture connection: quarantine lane; cleanup prohibited')
        if self.library is None:
            return
        with self.connect() as con:
            bootstrap_social_baseline(con, self.library, self.social_baseline)
            current = bootstrap_identity(con)
            assert current == (self.library, self.bootstrap_owner)
            assert retained_database_identity(con) == self.epoch_identity, 'Retained database identity changed; quarantine'
            before_cleanup_epochs = read_retained_epochs(con, self.library,
                self.epoch_baseline, owned_accounts=self.accounts, allow_new=True)
            assert con.execute('select count(*) as n from library.libraries where id<>%s',
                               (self.library,)).fetchone()['n'] == 0, 'Foreign library residue prohibits cleanup'
            assert self.bootstrap_owner not in self.accounts
            other_accounts = {row['id'] for row in con.execute(
                'select id from app.accounts where id<>%s', (self.bootstrap_owner,)).fetchall()}
            assert other_accounts <= set(self.accounts), 'Unknown accounts prohibit cleanup'
            settings = con.execute('select id,library_id from library.library_root_settings').fetchall()
            expected_settings = [] if self.settings_id is None else [
                {'id':self.settings_id,'library_id':self.library}]
            assert settings == expected_settings, 'Settings absent/replaced/foreign: quarantine'
            files = con.execute("""select f.track_id,f.library_root_id,t.library_id
                from library.local_track_files f join library.local_tracks t on t.id=f.track_id""").fetchall()
            assert all(row['track_id'] in self.owned_tracks and row['library_id'] == self.library
                       and row['library_root_id'] in (None,self.root_id) for row in files), 'Foreign file ownership'
            refresh, clocks = preserved_state(con, self.library)
            assert capture_budget_state(con) == self.capture_budget_baseline, "Capture budget changed; quarantine"
            assert refresh == self.refresh_baseline, 'Refresh singleton changed; quarantine'
            assert all(clocks[name] >= value for name,value in self.clock_baseline.items())
            for table, owned in (('local_tracks',self.owned_tracks), ('local_albums',set(self.albums)),
                                 ('local_artists',set(self.artists)), ('library_roots',{self.root_id}),
                                 ('exception_overrides',self.owned_overrides)):
                actual = {row['id'] for row in con.execute('select id from library.' + table +
                    ' where library_id=%s', (self.library,)).fetchall()}
                assert actual <= owned, ('Unknown rows prohibit cleanup',table,actual-owned)
            con.execute('delete from library.exception_overrides where id=any(%s)', (list(self.owned_overrides),))
            con.execute('delete from library.local_tracks where id=any(%s)', (list(self.owned_tracks),))
            con.execute('delete from library.local_albums where id=any(%s)', (self.albums,))
            con.execute('delete from library.local_artists where id=any(%s)', (self.artists,))
            if self.settings_id is not None:
                removed = con.execute('delete from library.library_root_settings where id=%s and library_id=%s returning id',
                    (self.settings_id,self.library)).fetchall()
                assert removed == [{'id':self.settings_id}]
            con.execute('delete from library.library_roots where id=%s', (self.root_id,))
            for account in self.accounts:
                con.execute('delete from app.accounts where id=%s', (account,))
            keys = list(self.source_ids.values())
            if keys:
                con.execute("""update catalog.popularity_source_slots set current_revision=null
                    where provider='lastfm' and metric='overall_scrobbles' and source_entity_id=any(%s)""", (keys,))
                con.execute("""delete from catalog.popularity_source_observations
                    where provider='lastfm' and metric='overall_scrobbles' and source_entity_id=any(%s)""", (keys,))
                con.execute("""delete from catalog.popularity_source_slots
                    where provider='lastfm' and metric='overall_scrobbles' and source_entity_id=any(%s)""", (keys,))
        with self.app_connect(self.app_url) as con:
            assert bootstrap_identity(con) == (self.library,self.bootstrap_owner)
            bootstrap_social_baseline(con, self.library, self.social_baseline)
            assert retained_database_identity(con) == self.epoch_identity, 'Retained database identity changed; quarantine'
            publish_stored(con, self.library, self.baseline)
        with self.connect() as con:
            bootstrap_social_baseline(con, self.library, self.social_baseline)
            library, owner, metadata, self.completed_epochs = preflight(
                con, self.app_url, self.app_connect, epochs=before_cleanup_epochs,
                owned_accounts=self.accounts, allow_new_epochs=True,
                expected_identity=self.epoch_identity)
            assert (library, owner, metadata) == (self.library, self.bootstrap_owner, self.baseline)
            refresh, clocks = preserved_state(con, self.library)
            assert capture_budget_state(con) == self.capture_budget_baseline, "Capture budget changed; quarantine"
            assert refresh == self.refresh_baseline
            assert all(clocks[name] >= value for name,value in self.clock_baseline.items())


    def publish_completed_epochs(self):
        # Recheck live identity and exact final counters at the handoff boundary.
        # A mismatch must not overwrite the previously completed ledger record.
        with self.connect() as con:
            assert retained_database_identity(con) == self.epoch_identity, 'Retained database identity changed; quarantine'
            bootstrap_social_baseline(con, self.library, self.social_baseline)
            assert capture_budget_state(con) == self.capture_budget_baseline, "Capture budget changed; quarantine"
            epochs = read_retained_epochs(con, self.library, self.completed_epochs, exact=True)
        remember_completed(self.setup_url, self.epoch_identity, epochs)


def validate_readonly_binding(db):
    # No pgpass reads, credential copying, new roles, grants or SET ROLE.
    assert db.readonly_url, 'Explicit initialized readonly URL required'
    setup = conninfo_to_dict(db.setup_url)
    readonly = conninfo_to_dict(db.readonly_url)
    # The initializer exports a credential-free, exact same-job identity.
    assert set(readonly) == {'user', 'host', 'port', 'dbname'}
    assert all(readonly.get(k) == setup.get(k) for k in ('host', 'port', 'dbname'))
    assert readonly['user'] != setup['user']
    with db.app_connect(db.readonly_url) as con:
        identity = con.execute("""select current_database() as database,current_user as role,
            pg_has_role(current_user,'album_haven_readonly','USAGE') as readonly,
            pg_has_role(current_user,'album_haven_app','MEMBER') as app,
            pg_has_role(current_user,'album_haven_migrator','MEMBER') as migrator,
            not exists(select 1 from pg_roles where pg_has_role(current_user,oid,'MEMBER')
              and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) as safe""").fetchone()
        assert identity == {'database':setup['dbname'], 'role':readonly['user'],
                            'readonly':True, 'app':False, 'migrator':False, 'safe':True}
        assert bootstrap_identity(con) == (db.library, db.bootstrap_owner)
        for table in ('library.relation_alias_endpoint_publications','library.relation_alias_endpoints'):
            for privilege in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE'):
                actual = con.execute('select has_table_privilege(current_user,%s,%s) as allowed',
                                     (table,privilege)).fetchone()['allowed']
                assert actual is (privilege == 'SELECT')
        assert not con.execute("select has_function_privilege(current_user,'library.replace_relation_alias_endpoints(jsonb)','EXECUTE') as allowed").fetchone()['allowed']
        assert con.execute("select has_function_privilege(current_user,'library.relation_alias_endpoints_ready(bigint)','EXECUTE') as allowed").fetchone()['allowed']
        assert con.execute('select library.relation_alias_endpoints_ready(%s) as ready', (db.library,)).fetchone()['ready']


def bootstrap_identity(con):
    rows = con.execute("""select l.id, b.account_id from app.bootstrap_owners b
        join library.libraries l on l.owner_account_id=b.account_id
        where b.owner_key='local-bootstrap-owner' and l.name='Local Library'
        and l.library_kind='local'""").fetchall()
    assert len(rows) == 1, 'Require unique supported pre-provisioned bootstrap library'
    return rows[0]['id'], rows[0]['account_id']


def capture_budget_state(connection):
    """Only migration0142's untouched global zero-budget singleton is fresh."""
    rows = connection.execute("""select id,account_id,is_global,reserved_bytes,rate_tokens,
        rate_updated_at,isfinite(rate_updated_at) as finite
        from integration.playback_capture_budget""").fetchall()
    if (len(rows) != 1 or type(rows[0]["id"]) is not int or rows[0]["id"] <= 0
            or rows[0]["account_id"] is not None or rows[0]["is_global"] is not True
            or rows[0]["reserved_bytes"] != 0 or rows[0]["rate_tokens"] != 8
            or rows[0]["finite"] is not True):
        raise RuntimeError("Unexpected migration-owned capture budget singleton.")
    return dict(rows[0])


def preserved_state(con, library):
    refresh = con.execute("""select to_jsonb(s)::text as value, provider,lease_token,lease_until,
        isfinite(next_attempt_at) as finite from catalog.popularity_api_refresh_state s""").fetchall()
    assert len(refresh) == 1
    row = refresh[0]
    assert row['provider'] == 'lastfm' and row['lease_token'] is None and row['lease_until'] is None and row['finite']
    clocks = {}
    for name in ('gallery_projection_state','public_metadata_source_state'):
        rows = con.execute('select library_id,generation,last_invalidation_xid from library.'+name).fetchall()
        assert len(rows) == 1 and rows[0]['library_id'] == library
        assert rows[0]['generation'] >= 0 and rows[0]['last_invalidation_xid'] is not None
        clocks[name] = rows[0]['generation']
    return row['value'], clocks


def retained_database_identity(con):
    library, owner = bootstrap_identity(con)
    social = bootstrap_social_baseline(con, library)
    row = con.execute("""select current_database() as name,oid::bigint as oid
        from pg_database where datname=current_database()""").fetchone()
    assert row is not None and isinstance(row['name'], str) and row['name']
    assert type(row['oid']) is int and row['oid'] > 0
    return (row['name'], row['oid'], library, owner, social['profile']['account_ref'])


def read_retained_epochs(con, library, baseline, *, owned_accounts=(), allow_new=False, exact=False):
    rows = con.execute("""select library_id,account_id,revision,love_revision,album_taste_revision
        from app.activity_source_revisions""").fetchall()
    return validate_epochs(rows, library=library, baseline=baseline,
        owned_accounts=owned_accounts, allow_global=allow_new, exact=exact)


def preflight(con, app_url, connect, *, epochs=None, owned_accounts=(),
              allow_new_epochs=False, exact_epochs=False, expected_identity=None):
    isolatedPostgres._assert_connected_role(con, isolatedPostgres.SETUP_ROLE)
    if expected_identity is not None:
        assert retained_database_identity(con) == expected_identity, 'Retained database identity changed; quarantine'
    library, owner = bootstrap_identity(con)
    retained_epochs = read_retained_epochs(con, library, epochs or {},
        owned_accounts=owned_accounts, allow_new=allow_new_epochs, exact=exact_epochs)
    from psycopg import sql
    expected = {('app','activity_source_revisions'):len(retained_epochs),
                ('app','social_profiles'):1, ('app','friend_policies'):1,
                ('app','accounts'):1, ('app','bootstrap_owners'):1,
                ('library','libraries'):1, ('library','relation_alias_endpoint_publications'):1,
                ('library','gallery_projection_state'):1, ('library','public_metadata_source_state'):1,
                ('catalog','popularity_api_refresh_state'):1,
                ('integration','playback_capture_budget'):1}
    social = bootstrap_social_baseline(con, library)
    preserved_state(con, library)
    capture_budget_state(con)
    tables = con.execute("""select n.nspname as schema_name,c.relname as table_name
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=any(%s) and c.relkind in ('r','p')""",
        (['app','integration','library','ops','catalog'],)).fetchall()
    for row in tables:
        identity = row['schema_name'], row['table_name']
        if identity in isolatedPostgres._MIGRATION_OWNED_TABLES:
            continue
        count = con.execute(sql.SQL('select count(*) as n from {}.{}').format(
            sql.Identifier(identity[0]),sql.Identifier(identity[1]))).fetchone()['n']
        assert count == expected.get(identity,0), ('Unclean dedicated baseline', identity)
    migrations = Path(__file__).resolve().parents[2] / 'migrations' / 'postgres'
    applied = {r['migration_name']: r['checksum'] for r in con.execute(
        'select migration_name,checksum from ops.schema_migrations').fetchall()}
    expected = {path.name:hashlib.sha256(path.read_bytes()).hexdigest()
                for path in migrations.glob('*.sql') if path.is_file()}
    assert '0140_create_relation_alias_endpoints.sql' in expected
    assert applied == expected, 'Exact composed migration ledger required'
    for table in ('library.local_tracks','library.local_albums','library.local_artists',
                  'library.library_roots','library.library_root_settings',
                  'catalog.popularity_source_slots','catalog.popularity_source_observations'):
        assert con.execute('select count(*) as n from ' + table).fetchone()['n'] == 0, table
    assert con.execute('select count(*) as n from app.accounts where id<>%s', (owner,)).fetchone()['n'] == 0
    assert con.execute('select count(*) as n from app.account_sessions').fetchone()['n'] == 0
    assert con.execute('select count(*) as n from library.libraries').fetchone()['n'] == 1
    metadata = con.execute('select metadata from library.libraries where id=%s', (library,)).fetchone()['metadata']
    views = metadata['scan_cache']['relation_views']
    assert all(views[key] == {} for key in ('alias_to_canonical','canonical_to_aliases','family_to_artists','folder_related'))
    assert all(views[key] == [] for key in ('artists','artists_sidebar','sidebar_families'))
    with connect(app_url) as app:
        isolatedPostgres._assert_connected_role(app, isolatedPostgres.RUNTIME_ROLE)
        bootstrap_social_baseline(app, library, social)
        flags = app.execute("""select
            pg_has_role(current_user,'album_haven_app','USAGE') as app,
            not pg_has_role(current_user,'album_haven_migrator','MEMBER') as limited,
            not exists(select 1 from pg_roles where pg_has_role(current_user,oid,'MEMBER')
              and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) as safe""").fetchone()
        assert flags == {'app':True,'limited':True,'safe':True}
        for table in ('library.relation_alias_endpoints','library.relation_alias_endpoint_publications'):
            assert app.execute("select has_table_privilege(current_user,%s,'SELECT') as ok", (table,)).fetchone()['ok']
            for privilege in ('INSERT','UPDATE','DELETE','TRUNCATE'):
                assert not app.execute('select has_table_privilege(current_user,%s,%s) as ok', (table,privilege)).fetchone()['ok']
        for function in ('library.replace_relation_alias_endpoints(jsonb)', 'library.relation_alias_endpoints_ready(bigint)'):
            assert app.execute("select has_function_privilege(current_user,%s,'EXECUTE') as ok", (function,)).fetchone()['ok']
        assert app.execute('select library.relation_alias_endpoints_ready(%s) as ready', (library,)).fetchone()['ready']
    if expected_identity is not None:
        assert retained_database_identity(con) == expected_identity, 'Retained database identity changed; quarantine'
    return library, owner, metadata, retained_epochs


@contextmanager
def bootstrap_popularity_db(monkeypatch, tmp_path):
    # Covers the unchanged dedicated URL resolver's admission connections too.
    monkeypatch.setenv('PGCONNECT_TIMEOUT','10')
    monkeypatch.setenv('PGOPTIONS', os.environ.get('PGOPTIONS','') +
                      ' -c statement_timeout=15000 -c lock_timeout=10000')
    setup, app = _dedicated_database_urls_or_skip(monkeypatch)
    ownership = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=setup)
    ownership.acquire()
    db = BootstrapPopularityDatabase((app, setup), tmp_path)
    setup_complete = False
    try:
        db.setup()
        setup_complete = True
        yield db
    finally:
        # Failed setup/cleanup deliberately retains lock marker for quarantine.
        # No reset, migration, grant, schema/database creation/drop, or seeding here.
        db.cleanup()
        if setup_complete:
            # Publish provenance only after every cleanup/preflight check passed,
            # while still holding the existing exclusive database ownership lock.
            db.publish_completed_epochs()
            ownership.release()
