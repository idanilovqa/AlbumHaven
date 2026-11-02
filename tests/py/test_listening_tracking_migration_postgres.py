"""Atomic normal-install tracking delivery on a fresh owned pre-0169 cohort.

Every case rolls back transactional rows/DDL. Fixture identity sequences consume
values until this exclusively owned disposable database is destroyed; they are
never reset to simulate rollback. Historical SQL is a separate checksum-bound oracle.
These cases do not qualify browser rendering or activate tracking flags.
"""
import hashlib
import os
from uuid import uuid4

import pytest

from tests.py.listening_tracking_migration_support import (
    ROOT, NAME, TABLES, NEW_TABLES, COHORTS, proposal_inputs, pre0169_connection,
    bind_runner, run_migration, install_oracle, finish_oracle, catalog,
    semantic_catalog, rows_snapshot, sequence_state, flush_deferred, assert_adoption_rejection,
)


@pytest.fixture(scope='module')
def proposals():
    return proposal_inputs(os.environ)


@pytest.fixture
def db(monkeypatch):
    # Absence is RED, not a skipped live test.
    assert (ROOT / 'migrations/postgres' / NAME).is_file(), NAME
    with pre0169_connection(os.environ) as (connection, ownership):
        bind_runner(monkeypatch, connection)
        yield connection, ownership


def run(db):
    c, _ = db
    flush_deferred(c)
    before = ledger(c)
    old_sequences = sequence_state(c)
    run_migration(*db)
    after = ledger(c)
    assert [row for row in after if row['migration_name'] != NAME] == [row for row in before if row['migration_name'] != NAME]
    candidate = [row for row in after if row['migration_name'] == NAME]
    assert len(candidate) == 1
    assert candidate[0]['checksum'] == hashlib.sha256((ROOT/'migrations/postgres'/NAME).read_bytes()).hexdigest()
    old_candidate = [row for row in before if row['migration_name'] == NAME]
    if old_candidate:
        assert candidate == old_candidate
    else:
        assert len(after) == len(before) + 1
    new_sequences = sequence_state(c)
    assert all(new_sequences.get(key) == value for key, value in old_sequences.items())


def expected_final(c, proposals, cohort=None):
    c.execute('savepoint independent_tracking_oracle')
    if cohort is None:
        install_oracle(c, proposals)
    else:
        finish_oracle(c, proposals, cohort)
    expected = semantic_catalog(catalog(c))
    c.execute('rollback to savepoint independent_tracking_oracle')
    c.execute('release savepoint independent_tracking_oracle')
    return expected


def ledger(c):
    return c.execute('select * from ops.schema_migrations order by migration_name').fetchall()


def seed_v1(c):
    """Uniquely owned predecessor data; uses no app bypass or real library."""
    from psycopg.types.json import Jsonb
    token = 'tracking-migration-' + uuid4().hex
    account = c.execute("""insert into app.accounts(display_name,account_kind,username_display,
        username_normalized,contact_email,contact_email_normalized)
        values(%s,'managed_user',%s,%s,%s,%s) returning id""",
        (token, token, token, token+'@example.test', token+'@example.test')).fetchone()['id']
    library = c.execute('insert into library.libraries(owner_account_id,name) values(%s,%s) returning id',
                        (account, token)).fetchone()['id']
    album = c.execute("insert into library.local_albums(library_id,album_key,title) values(%s,%s,'Retained') returning id",
                      (library, token)).fetchone()['id']
    track = c.execute("insert into library.local_tracks(library_id,album_id,track_key,title) values(%s,%s,%s,'Retained') returning id",
                      (library, album, token)).fetchone()['id']
    budget = c.execute('insert into integration.playback_capture_budget(account_id,reserved_bytes) values(%s,448) returning id',
                       (account,)).fetchone()['id']
    c.execute('update integration.playback_capture_budget set reserved_bytes=reserved_bytes+448 where is_global')
    session = c.execute("""insert into integration.playback_capture_session
        (account_id,library_id,auth_session_guard,device_uuid,capture_uuid,evidence_version,
         original_track_id,original_file_id,original_root_id,original_album_id,live_track_id,live_album_id,
         admitted_at,last_activity_at,reservation_bytes,account_budget_id)
        values(%s,%s,%s,%s,%s,'app-rendered-position-v1',%s,123,456,%s,%s,%s,now(),now(),256,%s)
        returning id""", (account, library, token, uuid4(), uuid4(), track, album, track, album, budget)).fetchone()['id']
    receipt = {'sequence': 1, 'digest': 'a'*64, 'accepted_known_frames': 0,
               'accepted_lost_frames': 0, 'terminal': False}
    c.execute("""insert into integration.playback_capture_checkpoint
        (session_id,sequence,digest,evidence,accepted_at,known_frames,lost_frames,terminal,
         receipt_status,receipt_body,reservation_bytes,account_budget_id)
        values(%s,1,%s,%s,now(),0,0,false,200,%s,192,%s)""",
        (session, 'a'*64, Jsonb({'runs': [], 'anchors': [], 'gaps': [], 'terminal': False,
                              'terminal_reason': None}), Jsonb(receipt), budget))
    c.execute("insert into app.album_ratings(account_id,library_id,album_key,rating,provenance) values(%s,%s,%s,4,'manual')",
              (account, library, token))
    flush_deferred(c)
    return dict(account=account, library=library, album=album, track=track, budget=budget, session=session)


def seed_retained_v2_graph(c, ownership):
    """Build real writer/selection rows inside this case's owned transaction.

    Existing fixture data and payload builders are reused. Only connection
    ownership is adapted: nested contexts create savepoints, never commit or
    close the outer connection, and no second connection can miss these rows.
    """
    from contextlib import contextmanager
    from music_app.services import playback_edition_selection as selection
    from music_app.services.private_library_authority import current_library_transaction
    from tests.py.test_playback_capture_postgres import CaptureDatabase
    from tests.py.test_playback_capture_v2_writer_postgres import _data, _write, _gap

    @contextmanager
    def connect(_url=None):
        with c.transaction():
            yield c

    fixture = CaptureDatabase((ownership['app'], ownership['setup']))
    fixture.connect = lambda: connect()
    fixture.connector = lambda **_kwargs: connect
    fixture.setup()
    with current_library_transaction(fixture.app_url, fixture.context, connect=connect,
            clock=lambda: fixture.now, inventory_publication_first=True) as (connection, live, now):
        album = connection.execute('select id,album_key from library.local_albums where id=%s',
                                   (fixture.album,)).fetchone()
        tracks = connection.execute('select id,album_id,track_key,disc_number,track_number from library.local_tracks where album_id=%s',
                                    (fixture.album,)).fetchall()
        prepared = selection.prepare_edition_selection(live, album, tracks)
        assert prepared is not None
        item = str(uuid4())
        result = selection.persist_top_selections(connection, live,
            [(item, str(uuid4()), prepared)], top_ref=str(uuid4()), revision='1', now=now)
        assert item in result
    payload = _data(fixture)
    payload['edition_selection_ref'] = result[item]['selection_ref']
    payload['evidence']['gaps'] = [_gap()]
    receipt = _write(fixture, payload, connect=connect)
    assert receipt['accepted_known_frames'] == 2 and receipt['accepted_lost_frames'] == 1
    flush_deferred(c)
    for name in ('playback_capture_owner', 'playback_capture_history_revision',
                 'playback_edition_selection', 'playback_edition_capture'):
        assert c.execute('select count(*) as n from integration.' + name + ' where account_id=%s',
                         (fixture.account,)).fetchone()['n'] == 1
    counts = c.execute("""select count(distinct r.id) as runs,count(distinct loss.id) as losses
        from integration.playback_capture_session p
        join integration.playback_capture_checkpoint cp on cp.session_id=p.id
        join integration.playback_capture_run r on r.checkpoint_id=cp.id
        join integration.playback_capture_loss loss on loss.checkpoint_id=cp.id
        where p.account_id=%s""", (fixture.account,)).fetchone()
    assert counts == {'runs': 1, 'losses': 1}
    # The genuine writer deliberately sets scoped shorter SQL limits. Restore
    # this reviewed migration fixture's limits after its completed operation.
    c.execute("set local statement_timeout='10000ms'")
    c.execute("set local lock_timeout='1000ms'")
    return fixture


def test_normal_install_matches_independent_schema_and_repeat_skips(db, proposals):
    c, _ = db
    expected = expected_final(c, proposals)
    run(db)
    assert semantic_catalog(catalog(c)) == expected
    assert all(c.execute('select to_regclass(%s) as r', (name,)).fetchone()['r'] for name in NEW_TABLES)
    before = (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c))
    run(db)
    assert (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c)) == before
    assert c.execute('select checksum from ops.schema_migrations where migration_name=%s', (NAME,)).fetchone()['checksum'] == hashlib.sha256((ROOT/'migrations/postgres'/NAME).read_bytes()).hexdigest()


def test_populated_v1_upgrade_preserves_receipts_rows_and_budget(db, proposals):
    c, _ = db
    seed_v1(c)
    before = rows_snapshot(c)
    expected = expected_final(c, proposals)
    run(db)
    after = rows_snapshot(c)
    assert semantic_catalog(catalog(c)) == expected
    # New nullable/version columns must not rewrite existing information.
    for name, old_rows in before.items():
        new_rows = after[name]
        assert len(new_rows) == len(old_rows)
        for old, new in zip(old_rows, new_rows):
            assert {key: new['row'][key] for key in old['row']} == old['row'], name
    assert all(r['row']['native_rating_intent_at'] is None for r in after['app.album_ratings'])


def seed_adopted_nonnull_baselines(c, ids):
    """Pre-existing explicit intent is retained, not relabeled as unknown."""
    top, item, release = uuid4(), uuid4(), uuid4()
    c.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'owner')",
              (ids['account'], ids['library']))
    c.execute("insert into catalog.release_groups(ref,title,artist_display) values(%s,'Adopted','Synthetic')", (release,))
    c.execute("insert into app.album_lists(ref,owner_account_id,library_id,title) values(%s,%s,%s,'Adopted Top')",
              (top, ids['account'], ids['library']))
    c.execute("""insert into app.album_list_items
        (ref,top_ref,library_id,catalog_ref,original_position,curator_position,listening_baseline_at)
        values(%s,%s,%s,%s,1,1,'2020-01-02 03:04:05+00')""",
              (item, top, ids['library'], release))
    c.execute("""insert into app.album_list_item_progress
        (account_id,library_id,top_ref,catalog_ref,revision,manual_completed_at,
         listening_item_ref,listening_baseline_at)
        values(%s,%s,%s,%s,7,'2020-02-03 04:05:06+00',%s,'2020-01-03 04:05:06+00')""",
              (ids['account'], ids['library'], top, release, item))
    c.execute("""update app.album_ratings set native_rating_intent_at='2020-01-04 05:06:07+00'
        where account_id=%s and library_id=%s""", (ids['account'], ids['library']))
    assert c.execute('select native_rating_intent_at is not null as present from app.album_ratings where account_id=%s',
                     (ids['account'],)).fetchone()['present']
    flush_deferred(c)


@pytest.mark.parametrize('cohort', tuple(COHORTS))
def test_exact_private_cohorts_adopt_without_rewriting_rows_or_table_ownership(db, proposals, cohort):
    c, ownership = db
    ids = seed_v1(c)
    install_oracle(c, proposals, cohort)
    seed_adopted_nonnull_baselines(c, ids)
    seed_retained_v2_graph(c, ownership)
    c.execute('update integration.playback_capture_budget set reserved_bytes=reserved_bytes+2560 where id=%s or is_global', (ids['budget'],))
    c.execute("""insert into integration.playback_album_metrics_state
        (account_id,original_library_id,original_album_id,state_revision,state,updated_at,reservation_bytes,account_budget_id)
        values(%s,%s,%s,7,'{}'::jsonb,now(),2048,%s)""",
        (ids['account'], ids['library'], ids['album'], ids['budget']))
    c.execute("""insert into integration.playback_decoder_observation
        (account_id,observation_ref,auth_session_guard,original_library_id,original_track_id,original_file_id,original_root_id,
         generation,stream_id,source_base48,inventory_source_revision,observed_at,reservation_bytes,account_budget_id)
        values(%s,%s,'synthetic',%s,%s,123,456,1,1,0,%s,now(),512,%s)""",
        (ids['account'], uuid4(), ids['library'], ids['track'], 'c'*64, ids['budget']))
    c.execute('insert into app.album_top_listening_settings(account_id,completed_target,revision,created_at,updated_at) values(%s,5,7,now(),now())', (ids['account'],))
    flush_deferred(c)
    before_rows = rows_snapshot(c)
    before_sequences = sequence_state(c)
    before = catalog(c)
    expected = expected_final(c, proposals, cohort)
    run(db)
    after = catalog(c)
    assert semantic_catalog(after) == expected
    assert rows_snapshot(c) == before_rows
    assert sequence_state(c) == before_sequences
    for category in ('relations', 'columns', 'functions', 'sequences', 'indexes', 'triggers', 'policies', 'default_acls'):
        assert after[category] == before[category], category
    # Only the coordinate constraints may be replaced while upgrading an
    # admitted older cohort; the final cohort must preserve even their OIDs.
    if cohort == 'converted':
        assert after['constraints'] == before['constraints']


MALFORMED = {
    'column': 'alter table integration.playback_album_metrics_state add column unapproved text',
    'constraint': 'alter table integration.playback_decoder_observation drop constraint playback_decoder_observation_flac441_swr48_v1',
    'index': 'drop index integration.playback_capture_owner_local_metrics_page',
    'trigger': 'alter table integration.playback_decoder_observation disable trigger playback_decoder_observation_immutable',
    'index-definition': 'drop index integration.playback_capture_owner_local_metrics_page; create index playback_capture_owner_local_metrics_page on integration.playback_capture_owner(id,account_id,library_id)',
    'trigger-arguments': "drop trigger playback_decoder_observation_immutable on integration.playback_decoder_observation; create trigger playback_decoder_observation_immutable before insert or update on integration.playback_decoder_observation for each row execute function integration.playback_decoder_observation_guard('unapproved')",
    'function': "alter function integration.playback_decoder_observation_guard() set search_path=public",
    'acl': 'revoke update on integration.playback_album_metrics_state from album_haven_app',
    'deferrability': 'alter table integration.playback_edition_capture alter constraint playback_edition_capture_selection deferrable initially deferred',
    'rls': 'alter table integration.playback_album_metrics_state enable row level security',
}


@pytest.mark.parametrize('kind', tuple(MALFORMED))
def test_malformed_private_catalog_is_rejected_atomically_not_repaired(db, proposals, kind):
    import psycopg
    c, _ = db
    install_oracle(c, proposals)
    c.execute(MALFORMED[kind])
    before = (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c))
    with pytest.raises(psycopg.Error) as error:
        run(db)
    assert_adoption_rejection(error.value)
    assert (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c)) == before


def test_partial_private_install_rejected_before_any_candidate_mutation(db, proposals):
    import psycopg
    c, _ = db
    c.execute(proposals['position-v2'])
    before = (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c))
    with pytest.raises(psycopg.Error) as error:
        run(db)
    assert_adoption_rejection(error.value)
    assert (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c)) == before


def test_same_name_incompatible_relation_rejected_not_replaced(db):
    import psycopg
    c, _ = db
    c.execute('create table integration.playback_album_metrics_state(unapproved text)')
    before = (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c))
    with pytest.raises(psycopg.Error) as error:
        run(db)
    assert_adoption_rejection(error.value)
    assert (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c)) == before


def test_ledger_insert_failure_rolls_back_real_schema_ddl(db):
    import psycopg
    c, _ = db
    c.execute("""create function pg_temp.reject_tracking_ledger() returns trigger
        language plpgsql as $$ begin
          if NEW.migration_name='0169_install_listening_tracking_storage.sql' then
            raise exception 'tracking fixture ledger rejection' using errcode='23514';
          end if; return NEW;
        end $$""")
    c.execute('create trigger tracking_fixture_ledger_rejection before insert on ops.schema_migrations for each row execute function pg_temp.reject_tracking_ledger()')
    before = (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c))
    with pytest.raises(psycopg.errors.CheckViolation, match='tracking fixture ledger rejection'):
        run(db)
    assert (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c)) == before


def test_effective_runtime_rights_preserve_no_delete_and_invoker_security(db):
    c, ownership = db
    run(db)
    for table in NEW_TABLES:
        value = c.execute("""select has_table_privilege(%s,%s,'SELECT') as s,
            has_table_privilege(%s,%s,'INSERT') as i,has_table_privilege(%s,%s,'DELETE') as d""",
            (ownership['app_role'], table)*3).fetchone()
        assert value == {'s': True, 'i': True, 'd': False}, table
    assert c.execute("select has_table_privilege(%s,'integration.playback_album_metrics_state','UPDATE') as u",
                     (ownership['app_role'],)).fetchone()['u']
    assert not c.execute("select pg_has_role(%s,'album_haven_migrator','MEMBER') as m",
                         (ownership['app_role'],)).fetchone()['m']
    assert all(not row['prosecdef'] for row in catalog(c)['functions'])
    # The settings table intentionally grants narrow column UPDATE, not blanket UPDATE.
    assert not c.execute("select has_table_privilege(%s,'app.album_top_listening_settings','UPDATE') as u",
                         (ownership['app_role'],)).fetchone()['u']
    for column in ('completed_target', 'revision', 'updated_at'):
        assert c.execute("select has_column_privilege(%s,'app.album_top_listening_settings',%s,'UPDATE') as u",
                         (ownership['app_role'], column)).fetchone()['u']



def retained_media_authority(c, ownership, ids):
    """Real stale-context authority, using this case's single owned transaction."""
    from contextlib import contextmanager
    from datetime import datetime, timedelta, timezone
    from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
    from music_app.services.policy import PolicyContext, RequestOrigin
    from music_app.services.private_library_authority import current_library_transaction, require_private_action

    now = datetime.now(timezone.utc)
    session = c.execute("""insert into app.account_sessions(account_id,session_token_hash,
        created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
        values(%s,%s,%s,%s,%s,%s,%s) returning id""",
        (ids['account'], hashlib.sha256(uuid4().bytes).digest(), now, now, now,
         now + timedelta(days=1), now + timedelta(days=1))).fetchone()['id']
    c.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'owner')",
              (ids['account'], ids['library']))
    actions = ('library.browse.read', 'library.media.read')
    for action in actions:
        c.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",
                  (ids['account'], action, ids['library']))
    actor = CurrentActor(state=ActorState.ACTIVE, account_id=ids['account'], session_id=session,
        authenticated_at=now, current_library_id=ids['library'],
        library_relationships=(LibraryRelationship(ids['library'], 'owner', True),),
        capability_grants=tuple(CapabilityGrant(action, 'library', ids['library']) for action in actions))
    context = PolicyContext.build(actor=actor, action='library.media.read', library_id=ids['library'],
        deployment_mode='self_hosted', request_origin=RequestOrigin('network', 'synthetic:migration'),
        client_surface_class='private_web')

    @contextmanager
    def connect(_url):
        with c.transaction():
            yield c

    def check():
        with current_library_transaction(ownership['app'], context, connect=connect,
                clock=lambda: now) as (_, live, _):
            require_private_action(live, 'library.media.read')
    return check


def test_library_removal_preserves_history_and_charges_without_live_media(db):
    from music_app.services.private_library_authority import PrivateLibraryAuthorityError
    c, ownership = db
    ids = seed_v1(c)
    run(db)
    check_media_authority = retained_media_authority(c, ownership, ids)
    check_media_authority()
    before = rows_snapshot(c)
    with c.transaction():
        c.execute('delete from library.libraries where id=%s', (ids['library'],))
        flush_deferred(c)
    after = rows_snapshot(c)
    old = next(r['row'] for r in before['integration.playback_capture_session'] if r['row']['id'] == ids['session'])
    new = next(r['row'] for r in after['integration.playback_capture_session'] if r['row']['id'] == ids['session'])
    assert new['live_track_id'] is None and new['live_album_id'] is None
    assert {k: v for k, v in new.items() if k not in ('live_track_id', 'live_album_id')} == {k: v for k, v in old.items() if k not in ('live_track_id', 'live_album_id')}
    assert after['integration.playback_capture_checkpoint'] == before['integration.playback_capture_checkpoint']
    assert after['integration.playback_capture_budget'] == before['integration.playback_capture_budget']
    assert c.execute('select id from library.local_tracks where id=%s', (ids['track'],)).fetchone() is None
    assert c.execute('select id from library.libraries where id=%s', (ids['library'],)).fetchone() is None
    with pytest.raises(PrivateLibraryAuthorityError):
        check_media_authority()


@pytest.mark.parametrize('basis,start,accepted', [
    ('decoded-output-zero', 0, True), ('decoded-output-zero', 1, False),
    ('decoded-output-local', 1, True), ('decoded-output-local', 0, False),
    ('decoded-output-absolute-wav48', 1, True), ('decoded-output-absolute-wav48', 0, False),
    ('decoded-output-absolute-flac48', 0, True),
    ('decoded-output-flac441-swr48-v1', 0, True),
    ('decoded-output-flac441-swr48-v1', 137438953471, True),
    ('decoded-output-flac441-swr48-v1', 137438953472, False),
    ('decoded-output-flac441-swr48-v1', -1, False), ('unapproved-basis', 0, False),
])
def test_coordinate_bases_accept_only_reviewed_boundaries(db, basis, start, accepted):
    import psycopg
    c, _ = db
    ids = seed_v1(c)
    run(db)
    def insert():
        c.execute('update integration.playback_capture_budget set reserved_bytes=reserved_bytes+512 where id=%s or is_global', (ids['budget'],))
        c.execute("""insert into integration.playback_decoder_observation
          (account_id,observation_ref,auth_session_guard,original_library_id,
           original_track_id,original_file_id,original_root_id,generation,stream_id,
           source_base48,coordinate_basis,requested_start48,inventory_source_revision,
           observed_at,reservation_bytes,account_budget_id)
          values(%s,%s,'synthetic',%s,%s,123,456,1,1,0,%s,%s,%s,now(),512,%s)""",
          (ids['account'], uuid4(), ids['library'], ids['track'], basis, start, 'b'*64, ids['budget']))
    if accepted:
        with c.transaction(): insert()
        assert c.execute('select count(*) as n from integration.playback_decoder_observation where account_id=%s and coordinate_basis=%s and requested_start48=%s',
                         (ids['account'], basis, start)).fetchone()['n'] == 1
    else:
        before = rows_snapshot(c)
        with pytest.raises(psycopg.errors.CheckViolation):
            with c.transaction(): insert()
        assert rows_snapshot(c) == before


def test_old_membership_baseline_stays_unknown_new_insert_gets_server_time(db):
    c, _ = db
    ids = seed_v1(c)
    top, old_item, old_catalog = uuid4(), uuid4(), uuid4()
    c.execute("insert into catalog.release_groups(ref,title,artist_display) values(%s,'Old','Synthetic')", (old_catalog,))
    c.execute("insert into app.album_lists(ref,owner_account_id,library_id,title) values(%s,%s,%s,'Owned Top')",
              (top, ids['account'], ids['library']))
    c.execute('insert into app.album_list_items(ref,top_ref,library_id,catalog_ref,original_position,curator_position) values(%s,%s,%s,%s,1,1)',
              (old_item, top, ids['library'], old_catalog))
    run(db)
    assert c.execute('select listening_baseline_at from app.album_list_items where ref=%s', (old_item,)).fetchone()['listening_baseline_at'] is None
    assert c.execute('select native_rating_intent_at from app.album_ratings where account_id=%s', (ids['account'],)).fetchone()['native_rating_intent_at'] is None
    new_item, new_catalog = uuid4(), uuid4()
    c.execute("insert into catalog.release_groups(ref,title,artist_display) values(%s,'New','Synthetic')", (new_catalog,))
    lower = c.execute('select clock_timestamp() as t').fetchone()['t']
    c.execute('insert into app.album_list_items(ref,top_ref,library_id,catalog_ref,original_position,curator_position) values(%s,%s,%s,%s,2,2)',
              (new_item, top, ids['library'], new_catalog))
    upper = c.execute('select clock_timestamp() as t').fetchone()['t']
    baseline = c.execute('select listening_baseline_at from app.album_list_items where ref=%s', (new_item,)).fetchone()['listening_baseline_at']
    assert lower <= baseline <= upper
    run(db)
    assert c.execute('select listening_baseline_at from app.album_list_items where ref=%s', (old_item,)).fetchone()['listening_baseline_at'] is None
    assert c.execute('select listening_baseline_at from app.album_list_items where ref=%s', (new_item,)).fetchone()['listening_baseline_at'] == baseline


def test_not_valid_constraint_is_not_adopted_as_exact_private_schema(db, proposals):
    import psycopg
    c, _ = db
    install_oracle(c, proposals)
    # Same expression/name but NOT VALID is a materially different catalog.
    c.execute('alter table integration.playback_decoder_observation drop constraint playback_decoder_observation_flac441_swr48_v1')
    c.execute("""alter table integration.playback_decoder_observation add constraint playback_decoder_observation_flac441_swr48_v1
        check (coordinate_basis <> 'decoded-output-flac441-swr48-v1'
        or (requested_start48>=0 and requested_start48<137438953472)) not valid""")
    before = (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c))
    with pytest.raises(psycopg.Error) as error: run(db)
    assert_adoption_rejection(error.value)
    assert (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c)) == before


def test_normal_migration_preserves_account_anonymization_and_global_charge(db):
    c, _ = db
    ids = seed_v1(c)
    run(db)
    before = c.execute('select reserved_bytes from integration.playback_capture_budget where is_global').fetchone()['reserved_bytes']
    with c.transaction():
        c.execute('delete from app.accounts where id=%s', (ids['account'],))
        flush_deferred(c)
    assert c.execute('select reserved_bytes from integration.playback_capture_budget where is_global').fetchone()['reserved_bytes'] == before
    row = c.execute('select * from integration.playback_capture_session where id=%s', (ids['session'],)).fetchone()
    assert row is not None
    assert all(row[key] is None for key in ('account_id', 'auth_session_guard', 'device_uuid', 'capture_uuid', 'v1_session_uuid', 'account_budget_id'))
    assert row['original_album_id'] == ids['album'] and row['original_track_id'] == ids['track']
    checkpoint = c.execute('select * from integration.playback_capture_checkpoint where session_id=%s', (ids['session'],)).fetchone()
    assert checkpoint['account_budget_id'] is None
    assert set(checkpoint['receipt_body']) == {'sequence', 'digest', 'accepted_known_frames', 'accepted_lost_frames', 'terminal'}


def test_recorded_wrong_checksum_is_not_adopted_as_success(db):
    c, _ = db
    c.execute('insert into ops.schema_migrations(migration_name,checksum) values(%s,%s)', (NAME, '0'*64))
    before = (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c))
    with pytest.raises(RuntimeError, match='checksum'): run(db)
    assert (catalog(c), rows_snapshot(c), ledger(c), sequence_state(c)) == before
