"""Opt-in fresh-database pre-0132 transition fixture, separate from normal DB tests.

Root must provision a dedicated EMPTY synthetic database and its paired existing
non-superuser/inherited roles. This fixture never creates roles/databases, drops
schemas, widens grants, rewrites migration history or disables a trigger.
It installs exact checked-in migrations through 0131, permits old-writer seeds,
then installs exact 0132 and the separately approved 0133 on explicit requests.
The exact known following 0134, 0135, 0136, 0137 and 0138 are verified on disk but never applied here.
Each transition case requires its own root-supplied empty database invocation.
"""
from hashlib import sha256
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
from time import monotonic, sleep

import pytest
import psycopg

from tests.e2e.support import isolatedPostgres
from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.remote_preparation_postgres_support import PreparationCase
from tests.py.remote_top_postgres_support import CONTEXT, STORE_SQL, payload, runtime
from tests.py.test_owned_album_tops_postgres import Database


ROOT = Path(__file__).resolve().parents[2]
CUTOFF = "0132_private_top_remote_preparations.sql"
PREVIOUS = "0131_top_artwork_completion_alias.sql"
CONSUMPTION = "0133_private_top_remote_consumption.sql"
CUTOFF_SHA256 = "437d7cf3722e313b112106c0919d6a28403e2fa769daab9f735b6c59435ffdfb"
# Only this exact B migration belongs to the legacy transition apply list.
POST_CUTOFF = {CONSUMPTION: "c433536b1600e706dd61fcda3fec9b8936cdccd9f1cb1b23acddac410c8d76bc"}
# Exact reviewed repository tail, required on disk but never installed here.
KNOWN_FOLLOWING_TAIL = {
    "0134_private_top_artwork_draft_capture.sql": "a2226a26b9732d70a17af35d0054fba05e0306156dbed94d2c02e2b4c8c6c87e",
    "0135_public_metadata_file_invalidation.sql": "818a4734aa6717efd0ff1aae96e583b6b2f00a52424fcde94f8af38f0014adc5",
    "0136_private_top_remote_identity_lock.sql": "19725aee6086a1ec6cf66571c59a9259fd2687bed3677de8ea20be91fdd102b1",
    "0137_top_artwork_publication.sql": "fb301e4509495fec7b738cc71a6c5f8961e3d27a9a9efdae29dfe3f4010dda9c",
    "0138_artist_loved_playlists.sql": "e4bc755fc6b771c7739f1d57e21120b7464af717498286227299cd394982daf6",
}
INPUTS = {
    "0127_private_top_remote_acquisition.sql": "b849fdb42550fe549561c9199eb87a3af3622003edb187ec08128e28ada99d65",
    "0128_private_top_remote_membership.sql": "4b1147d3cc9e6d5071cb2867e496376361506c1ebba9143e36534dc84a34f639",
}


class CutoffCase(PreparationCase):
    def __init__(self, database, migration, prefix, post_cutoff):
        super().__init__(database)
        self.migration = migration
        self.cutover_applied = False
        self.consumption_applied = False
        self.prefix = prefix
        self.post_cutoff = post_cutoff
        self.phase_ledgers = []
        self.verify_ledger("pre_cutoff", prefix)

    def verify_ledger(self, phase, migrations):
        with self.db.connect() as connection:
            actual = connection.execute('select migration_name,checksum from ops.schema_migrations order by migration_name').fetchall()
        expected = [{'migration_name': path.name, 'checksum': sha256(path.read_bytes()).hexdigest()} for path in migrations]
        assert actual == expected, 'Exact reviewed transition phase ledger differs'
        self.phase_ledgers.append({'phase': phase, 'migrations': actual})
        return actual

    def apply_consumption(self):
        assert self.cutover_applied and not self.consumption_applied
        self.verify_ledger('before_consumption', [*self.prefix, self.migration])
        assert [path.name for path in self.post_cutoff] == list(POST_CUTOFF)
        for path in self.post_cutoff:
            assert sha256(path.read_bytes()).hexdigest() == POST_CUTOFF[path.name]
        isolatedPostgres.apply_migrations(self.db.setup_url, self.post_cutoff)
        self.consumption_applied = True
        self.verify_ledger('consumption', [*self.prefix, self.migration, *self.post_cutoff])

    def seed_old_command(self, command, *, actor=None, facts=None, context_ref=CONTEXT):
        """The actual old runtime writer, usable only before this fixture's cutoff."""
        assert not self.cutover_applied
        with runtime(self.db) as connection:
            assert_runtime_role(connection, self.db)
            result = connection.execute(STORE_SQL, self.store_args(command, actor=actor,
                facts=facts, context_ref=context_ref)).fetchone()['ref']
        return str(result)

    def seed_old_writer(self, count, *, actor=None):
        assert not self.cutover_applied
        assert 1 <= count <= 1000
        commands = []
        target = None
        with runtime(self.db) as connection:
            assert_runtime_role(connection, self.db)
            for index in range(count):
                if index % 90 == 0:
                    target = None
                command = payload(target)
                target = command["destination"]
                result = connection.execute(STORE_SQL, self.store_args(command, actor=actor)).fetchone()
                commands.append((command, str(result["ref"])))
        return commands

    def apply_cutoff(self):
        assert not self.cutover_applied
        isolatedPostgres.apply_migrations(self.db.setup_url, [self.migration])
        self.cutover_applied = True
        self.verify_ledger("cutoff", [*self.prefix, self.migration])
        with self.db.connect() as connection:
            actual = connection.execute("select checksum from ops.schema_migrations where migration_name=%s",
                (CUTOFF,)).fetchone()
            assert actual["checksum"] == sha256(self.migration.read_bytes()).hexdigest()

    def apply_with_old_writer_overlap(self):
        """Exercise actual old SQL already entered before replacement.

        If PostgreSQL retains a pending-table lock while compiling the old body,
        DDL must wait and that row commits before cutoff. Otherwise DDL can land
        while old code waits at its actor lock, and its late INSERT must fail the
        new unconditional guard. Both orderings are observed, never assumed.
        """
        assert not self.cutover_applied
        with self.db.connect() as connection:
            actor = self.db.member(connection, self.db.actor(connection), self.db.library)
        command = payload()
        args = self.store_args(command, actor=actor)
        def old_writer():
            with runtime(self.db) as connection:
                assert_runtime_role(connection, self.db)
                return connection.execute(STORE_SQL, args).fetchone()["ref"]
        with self.db.connect() as blocker:
            blocker.execute("select id from app.accounts where id=%s for update", (actor.account_id,)).fetchone()
            with ThreadPoolExecutor(max_workers=2) as pool:
                old = pool.submit(old_writer)
                stop = monotonic() + 5
                old_waiting = False
                while monotonic() < stop:
                    with runtime(self.db) as probe:
                        old_waiting = probe.execute("""select exists(select 1 from pg_stat_activity
                            where usename=current_user and pid<>pg_backend_pid() and wait_event_type='Lock'
                            and query like 'select app.store_top_remote_acquisition(%%') as waiting""").fetchone()["waiting"]
                    if old_waiting:
                        break
                    sleep(0.01)
                assert old_waiting, "Old SQL invocation did not reach its real account-lock wait"
                migration = pool.submit(self.apply_cutoff)
                ddl_waiting = False
                stop = monotonic() + 5
                while monotonic() < stop and not migration.done():
                    with self.db.connect() as probe:
                        ddl_waiting = probe.execute("""select exists(select 1 from pg_locks
                            where relation='app.album_top_remote_acquisitions'::regclass
                            and mode='AccessExclusiveLock' and not granted) as waiting""").fetchone()["waiting"]
                    if ddl_waiting:
                        break
                    sleep(0.01)
                assert migration.done() or ddl_waiting, "Cutoff neither landed nor reached its required DDL lock"
                if migration.done():
                    migration.result(timeout=5)
                    blocker.commit()
                    with pytest.raises(psycopg.Error) as caught:
                        old.result(timeout=5)
                    assert caught.value.diag.constraint_name == "top_remote_version_required"
                    inserted = False
                else:
                    blocker.commit()
                    ref = old.result(timeout=5)
                    assert str(ref) == args[0]
                    migration.result(timeout=5)
                    inserted = True
        with runtime(self.db) as connection:
            if inserted:
                assert str(connection.execute(STORE_SQL, args).fetchone()["ref"]) == args[0]
            else:
                assert connection.execute("select ref from app.album_top_remote_acquisitions where actor_account_id=%s and request_key=%s",
                    (actor.account_id, command["request_key"])).fetchone() is None
        return {"actor": actor, "committed_before_cutoff": inserted, "ddl_wait_observed": ddl_waiting}

    def close_transition(self):
        if not self.cutover_applied:
            self.apply_cutoff()
        # Retire all old pending selections through the production actor-local
        # 256-row discard owner before ordinary narrow C2 fixture cleanup.
        for actor_id in self.db.account_ids:
            with self.db.connect() as connection:
                library = connection.execute("select id from library.libraries where id=any(%s) order by id limit 1",
                    (self.db.library_ids,)).fetchone()["id"]
            while True:
                step = self.sql("maintain_top_remote_preparations", (actor_id, library, "discard_legacy"))
                assert step["inspected"] <= 256
                if not step["more_work"]:
                    break
        self.cleanup()
        self.db.close()


@pytest.fixture
def cutoff_transition():
    setup = os.environ.get("ALBUM_HAVEN_C2_CUTOFF_SETUP_DATABASE_URL", "")
    app = os.environ.get("ALBUM_HAVEN_C2_CUTOFF_DATABASE_URL", "")
    if not setup and not app:
        pytest.skip("Root-owned dedicated empty pre-cutoff database was not supplied; migration transition was not exercised")
    assert setup and app
    setup, app = isolatedPostgres.resolve_isolated_database_urls({
        isolatedPostgres.SETUP_DATABASE_ENV: setup,
        isolatedPostgres.RUNTIME_DATABASE_ENV: app,
    })
    migrations = sorted((ROOT / "migrations" / "postgres").glob("*.sql"))
    matches = [index for index, path in enumerate(migrations) if path.name == CUTOFF]
    assert len(matches) == 1, 'The exact reviewed A migration must occur once'
    index = matches[0]
    prefix, cutoff, tail = migrations[:index], migrations[index], migrations[index + 1:]
    assert prefix and prefix[-1].name == PREVIOUS
    assert sha256(cutoff.read_bytes()).hexdigest() == CUTOFF_SHA256
    expected_tail = {**POST_CUTOFF, **KNOWN_FOLLOWING_TAIL}
    assert [path.name for path in tail] == list(expected_tail), 'Re-review any unapproved post-A migration tail'
    for path in tail:
        assert sha256(path.read_bytes()).hexdigest() == expected_tail[path.name]
    # Exact full-tail validation above precedes slicing; only 0133 can enter the case.
    post_cutoff = tail[:len(POST_CUTOFF)]
    for name, checksum in INPUTS.items():
        assert sha256((ROOT / "migrations" / "postgres" / name).read_bytes()).hexdigest() == checksum
    with isolatedPostgres._connect(setup) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        identity = connection.execute("select current_database() as database_name,current_user as role_name,"
            "session_user as login,rolsuper from pg_roles where rolname=current_user").fetchone()
        assert identity == {"database_name": isolatedPostgres._database_name(setup),
            "role_name": isolatedPostgres._database_role(setup), "login": isolatedPostgres._database_role(setup),
            "rolsuper": False}
        assert connection.execute("select to_regclass('ops.schema_migrations') as ledger").fetchone()["ledger"] is None
        assert connection.execute("select to_regclass('app.accounts') as accounts").fetchone()["accounts"] is None
    # Runtime privileges must already be inherited. The fixture will not add them.
    database = Database((app, setup))
    with runtime(database) as connection:
        assert_runtime_role(connection, database)
    isolatedPostgres.apply_migrations(setup, prefix)
    with database.connect() as connection:
        ledger = connection.execute("select migration_name,checksum from ops.schema_migrations order by migration_name").fetchall()
        assert ledger[-1]["migration_name"] == PREVIOUS
        assert connection.execute("select to_regclass('app.album_top_remote_preparations') as relation").fetchone()["relation"] is None
        actor = database.actor(connection)
        database.library = database.library_for(connection, actor)
        database.owner = database.member(connection, actor, database.library)
    case = CutoffCase(database, cutoff, prefix, post_cutoff)
    try:
        yield case
    finally:
        case.close_transition()
