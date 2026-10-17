"""Actual-role support for retained Top transitions; no authority substitutes.

Only fixture-owned synthetic rows are seeded/cleaned with the migration role.
Runtime transitions use album_haven_app and the real SQL functions/counters.
"""
from uuid import uuid4
from contextlib import contextmanager

import pytest
from psycopg.types.json import Jsonb

from tests.py.remote_top_postgres_support import (
    CONTEXT, evidence, destination, payload, remote, runtime, sql_error, db, urls,
)

RETAIN = 'app.retain_top_remote_acquisition'
LOCK = 'app.lock_top_remote_admission'
READ = 'app.lock_top_remote_admission_for_read'
COPY = 'app.copy_top_remote_admission'
ATTACH = 'app.attach_top_remote_source'
CLEAR = 'app.clear_top_remote_source_for_local'
SOURCE_LOCK = 'app.lock_top_remote_membership_sources'
CONSUME = 'app.consume_top_remote_acquisitions'
CONSUMED_CREATE = 'app.read_top_remote_consumed_create'
SIGNATURES = {
    RETAIN: 'uuid,uuid,text,uuid,bigint,bigint,bigint,bigint,text,text,uuid,bigint,uuid',
    LOCK: 'uuid,text,uuid,bigint,bigint,bigint,uuid',
    READ: 'uuid,text,uuid,bigint,bigint,bigint,uuid',
    COPY: 'uuid,uuid,bigint,uuid,uuid,text,uuid,bigint,bigint,bigint,bigint,bigint,uuid',
    ATTACH: 'uuid,bigint,bigint,bigint,uuid,uuid,uuid,text',
    CLEAR: 'uuid,bigint,bigint,bigint,uuid,uuid,uuid,bigint,uuid',
}


# Existing six entrypoints remain exact; B adds only these fixed structural APIs.
B_SIGNATURES = {
    SOURCE_LOCK: 'bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,bigint,jsonb',
    CONSUME: 'bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,bigint,text,uuid,text,jsonb',
    CONSUMED_CREATE: 'uuid,bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,text,text,uuid',
}


def invoke(connection, function, args):
    return connection.execute('select ' + function + '(' + ','.join(['%s'] * len(args)) + ') as value', args).fetchone()['value']


class RetentionCase:
    def __init__(self, acquisition):
        self.remote = acquisition
        self.db = acquisition.db
        self.token = uuid4().hex
        self.mapped = []
        self.remote.facts = evidence(mbid=str(uuid4()))

    def top(self, actor=None):
        return self.db.service.execute(self.db.context(actor), self.db.create_command(refs=[]))

    def locks(self, connection, top, actor=None, *, pending=None, pending_budget=False):
        actor = actor or self.db.owner
        owner = connection.execute('select owner_account_id from app.album_lists where ref=%s', (top['top_ref'],)).fetchone()['owner_account_id']
        connection.execute('select id from app.accounts where id=any(%s) order by id for update',
                           (sorted({actor.account_id, owner}),)).fetchall()
        connection.execute('select id from app.account_sessions where id=%s for share', (actor.session_id,)).fetchone()
        connection.execute('select id from library.libraries where id=%s for share',
            (actor.current_library_id,)).fetchone()
        if pending is not None or pending_budget:
            connection.execute('select app.lock_top_remote_pending_actor(%s)', (actor.account_id,)).fetchone()
        connection.execute('select ref from app.album_lists where ref=%s for update', (top['top_ref'],)).fetchone()
        if pending is not None:
            target = pending['destination']
            source = connection.execute('select preparation_ref,attempt_ref from app.album_top_remote_acquisitions where ref=%s',
                (pending['acquisition_ref'],)).fetchone()
            # Binding discovery is not authority; the structural owner rechecks it.
            descriptor = {'acquisition_ref': pending['acquisition_ref'], 'evidence_version': pending['evidence_version'],
                'preparation_ref': str(source['preparation_ref']) if source['preparation_ref'] else None,
                'attempt_ref': str(source['attempt_ref']) if source['attempt_ref'] else None}
            args = [actor.current_library_id, actor.account_id, actor.session_id, CONTEXT, target['kind'],
                target.get('top_ref', target.get('draft_ref')), owner,
                int(target['revision']) if target['kind'] == 'top' else None,
                top['top_ref'], int(top['revision']), Jsonb([descriptor])]
            locked = invoke(connection, SOURCE_LOCK, args)
            assert len(locked) == 1 and locked[0]['acquisition_ref'] == pending['acquisition_ref']
        return owner

    def pending(self, top, *, kind='top', facts=None):
        self.remote.facts = facts or self.remote.facts
        target = destination(top) if kind == 'top' else destination()
        command = self.remote.prepare_v2(target, mbid=self.remote.facts.release_group_id)
        result = self.remote.acquire(command)
        return result

    def mapping(self, pending, catalog=None):
        catalog = catalog or self.db.album_refs[0]
        with self.db.connect() as connection:
            external = connection.execute('select external_id from app.album_top_remote_acquisitions where ref=%s',
                (pending['acquisition_ref'],)).fetchone()['external_id']
            connection.execute("""insert into catalog.release_group_provider_identities(provider,entity_kind,external_id,catalog_ref)
                values('musicbrainz','release-group',%s,%s) on conflict do nothing""", (external, catalog))
        self.mapped.append(external)
        return catalog

    def retain_args(self, top, pending, catalog, *, actor=None):
        actor = actor or self.db.owner
        target = pending['destination']
        with self.db.connect() as connection:
            owner = connection.execute('select owner_account_id from app.album_lists where ref=%s',
                (top['top_ref'],)).fetchone()['owner_account_id']
        return [str(uuid4()), pending['acquisition_ref'], pending['evidence_version'], top['top_ref'],
                actor.current_library_id, owner, actor.account_id, actor.session_id, CONTEXT,
                target['kind'], target.get('top_ref', target.get('draft_ref')),
                int(target['revision']) if target['kind'] == 'top' else int(top['revision']), catalog]

    def retain(self, top, pending, catalog):
        with runtime(self.db) as connection:
            self.locks(connection, top, pending=pending)
            return str(invoke(connection, RETAIN, self.retain_args(top, pending, catalog)))

    def member(self, top, catalog, admission, version):
        item = str(uuid4())
        with runtime(self.db) as connection:
            owner = self.locks(connection, top)
            connection.execute('''insert into app.album_list_items(ref,top_ref,library_id,catalog_ref,original_position,curator_position)
                values(%s,%s,%s,%s,1,1)''', (item, top['top_ref'], self.db.library, catalog))
            invoke(connection, ATTACH, [top['top_ref'], self.db.library, owner, int(top['revision']), item, catalog, admission, version])
        return item

    def row(self, admission):
        with self.db.connect() as connection:
            return connection.execute('select * from app.album_top_remote_admissions where ref=%s', (admission,)).fetchone()

    def counts(self, top=None):
        with self.db.connect() as connection:
            if top:
                row = connection.execute('select admission_count,facts_bytes from app.album_top_remote_retained_budgets where top_ref=%s',
                                         (top['top_ref'],)).fetchone()
            else:
                row = connection.execute('''select coalesce(sum(admission_count),0) as admission_count,
                    coalesce(sum(facts_bytes),0) as facts_bytes from app.album_top_remote_retained_budgets
                    where owner_account_id=%s''', (self.db.owner.account_id,)).fetchone()
            return row or {'admission_count': 0, 'facts_bytes': 0}

    def seed(self, top, count, *, fact_size=None, retired=False):
        """Seed real immutable history; the production AFTER INSERT trigger charges it.

        No counters, budget constants, or facts-byte results are patched. Every
        seeded admission has a distinct catalog and canonical external identity.
        """
        assert 1 <= count <= 20000
        token = uuid4().hex
        title, artist = 'Historical title', 'Historical artist'
        with self.db.connect() as connection:
            if fact_size is not None:
                title = '🌑' * min(1000, max(1, (fact_size - 256) // 4))
                base = connection.execute("""select app.top_remote_fact_bytes('musicbrainz','release-group',
                    %s,%s,'','2000','Album',%s) as bytes""", (str(uuid4()), title, 'e' * 64)).fetchone()['bytes']
                assert 1 <= fact_size - base <= 4000
                whole, remainder = divmod(fact_size - base, 4)
                artist = '🌑' * whole + 'x' * remainder
                assert len(title) <= 1000 and len(artist) <= 1000
            connection.execute("""insert into catalog.release_groups(ref,title,artist_display)
                select md5(%s||':catalog:'||g)::uuid,%s,'Synthetic retained history'
                from generate_series(1,%s) g""", (token, 'retention-' + self.token, count))
            connection.execute("""insert into app.album_top_remote_admissions(ref,top_ref,library_id,owner_account_id,catalog_ref,
                provider,entity_kind,external_id,evidence_version,title,artist_display,first_release_date,primary_type,
                initiating_actor_account_id,original_session_id,original_acquisition_ref,original_destination_kind,
                original_destination_ref,original_context_ref,acquired_at,admission_deadline,admitted_at,retired_at)
                select md5(%s||':ref:'||g)::uuid,%s,%s,%s,md5(%s||':catalog:'||g)::uuid,
                'musicbrainz','release-group',md5(%s||':external:'||g)::uuid::text,%s,%s,%s,'2000','Album',
                %s,%s,md5(%s||':acquisition:'||g)::uuid,'top',%s,%s,
                statement_timestamp()-interval '2 days',statement_timestamp()-interval '2 days'+interval '30 minutes',
                statement_timestamp()-interval '2 days'+interval '1 minute',
                case when %s then statement_timestamp()-interval '1 day' end
                from generate_series(1,%s) g""",
                (token, top['top_ref'], self.db.library, self.db.owner.account_id, token, token,
                 'e' * 64, title, artist, self.db.owner.account_id, self.db.owner.session_id, token,
                 top['top_ref'], CONTEXT, retired, count))
            row = connection.execute("""select *,app.top_remote_fact_bytes(provider,entity_kind,external_id,title,
                artist_display,first_release_date,primary_type,evidence_version) as measured_bytes
                from app.album_top_remote_admissions where ref=md5(%s||':ref:1')::uuid""", (token,)).fetchone()
            if fact_size is not None:
                assert row['measured_bytes'] == fact_size
            return row

    def seed_bytes(self, top, total, *, row_bytes=8000):
        assert total >= 512
        full, tail = divmod(total, row_bytes)
        if 0 < tail < 512:
            full -= 1
            self.seed(top, 1, fact_size=row_bytes - 512, retired=True)
            tail += 512
        if full:
            self.seed(top, full, fact_size=row_bytes, retired=True)
        if tail:
            self.seed(top, 1, fact_size=tail, retired=True)

    def local_source(self, catalog=None):
        catalog = catalog or self.db.album_refs[0]
        with self.db.connect() as connection:
            album = connection.execute('select local_album_id from library.catalog_album_links where library_id=%s and catalog_ref=%s',
                                       (self.db.library, catalog)).fetchone()['local_album_id']
            root_path = '/synthetic/' + uuid4().hex
            root = connection.execute("""insert into library.library_roots(library_id,root_path)
                values(%s,%s) returning id""", (self.db.library, root_path)).fetchone()['id']
            ref = str(uuid4())
            connection.execute("""insert into library.album_metadata_sources(ref,library_id,local_album_id,library_root_id,
                container_identity,path_flavor,capture_builder_version,state,title,artist,title_origin,artist_origin)
                values(%s,%s,%s,%s,%s,'posix',1,'active','Local title','Local artist','tag_metadata','tag_metadata')""",
                (ref, self.db.library, album, root, root_path + '/source/' + uuid4().hex))
        return album, ref


@contextmanager
def retention_case(remote):
    case = RetentionCase(remote)
    try:
        yield case
    finally:
        # Cleanup is limited to this fixture's actual synthetic library rows.
        with case.db.connect() as connection:
            assert connection.execute('select rolsuper from pg_roles where rolname=current_user').fetchone()['rolsuper'] is False
            connection.execute('alter table app.album_top_remote_admissions disable trigger top_remote_admission_immutable')
            connection.execute('delete from app.album_list_item_remote_sources where library_id=any(%s)', (case.db.library_ids,))
            connection.execute('delete from app.album_list_items where library_id=any(%s)', (case.db.library_ids,))
            connection.execute('delete from app.album_top_remote_admissions where library_id=any(%s)', (case.db.library_ids,))
            connection.execute('alter table app.album_top_remote_admissions enable trigger top_remote_admission_immutable')
            connection.execute('delete from app.album_top_remote_retained_budgets where library_id=any(%s)', (case.db.library_ids,))
            connection.execute('delete from catalog.release_group_provider_identities where external_id=any(%s)', (case.mapped,))
            connection.execute('delete from catalog.release_groups where title=%s', ('retention-' + case.token,))


@pytest.fixture
def retained(remote):
    with retention_case(remote) as case:
        yield case
