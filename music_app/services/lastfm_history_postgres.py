"""Dedicated account-owned Last.fm import repository. Schema is docs-only.

No provider I/O inside transactions. Native/session/account authority is always
rechecked at commit. No Foobar tables and no personal-history DELETE statements.
"""
from collections import Counter
from dataclasses import asdict
from datetime import datetime, timezone
import json
from uuid import UUID, uuid4

from .lastfm import LastfmSession
from .lastfm_history_authority import current_lastfm_history_account_transaction
from .lastfm_history_model import HistoryStale, HistoryUnavailable, binding, multiset, tuple_digest
from .lastfm_history_reader import HistoryPage, parse_history_page


class HistoryStorageQuota(HistoryUnavailable):
    """Logical retained payload budget exhausted; no partial incoming write."""


class LastfmHistoryRepository:
    def __init__(self, config):
        self.url = str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        self.payload_quota=config.get('LASTFM_HISTORY_RETAINED_BYTES_LIMIT',2*1024*1024*1024)
        if type(self.payload_quota) is not int or not 1<=self.payload_quota<=9223372036854775807:
            raise HistoryUnavailable('History payload quota is invalid.')
        if not self.url:
            raise HistoryUnavailable('Last.fm history storage is unavailable.')

    def transaction(self, context, constraints=None):
        return current_lastfm_history_account_transaction(self.url, context, constraints=constraints)

    @staticmethod
    def _session(connection, account_id):
        # Actual credential owner; deliberately select no credential column. The
        # account lock is also taken by save_account_settings before reconnect.
        rows = connection.execute("""select s.provider_username,
            k.metadata->>'connected_at' as connected_at
            from integration.lastfm_settings s join integration.lastfm_sessions k
              on k.account_id=s.account_id and k.provider_username=s.provider_username
             and k.is_active
            where s.account_id=%s and k.session_key_encrypted is not null
            for share of s,k""", (account_id,)).fetchmany(2)
        if len(rows) != 1:
            raise HistoryStale('Last.fm connection is unavailable.')
        session = LastfmSession(rows[0]['provider_username'], '', rows[0]['connected_at'])
        binding(session)
        return session

    @staticmethod
    def _uuid(value):
        if type(value) is not str:
            raise HistoryStale('Invalid import cursor.')
        try:
            if str(UUID(value)) != value:
                raise ValueError()
        except (ValueError, AttributeError):
            raise HistoryStale('Invalid import cursor.') from None
        return value

    @staticmethod
    def _status(row, *, replay=False):
        return {'generation': str(row['id']), 'state': row['state'],
            'next_page': row['next_page'] if row['state'] == 'reading' else None,
            'reason': row['reason'], 'replay': replay}

    def _owned(self, connection, account_id, generation):
        row = connection.execute('select * from integration.lastfm_history_generations_v1 '
            'where id=%s and account_id=%s for update',
            (self._uuid(generation),account_id)).fetchone()
        if row is None:
            raise HistoryStale('Import is unavailable.')
        return row

    @staticmethod
    def _stop(connection, row, reason, *, state='uncertain'):
        connection.execute('update integration.lastfm_history_generations_v1 '
            'set state=%s,reason=%s,lease_token=null,lease_until=null where id=%s and account_id=%s',
            (state,reason,row['id'],row['account_id']))
        return {**row, 'state':state, 'reason':reason}

    def begin(self, context, *, range_start, range_end, constraints=None):
        now = int(datetime.now(timezone.utc).timestamp())
        if (any(type(v) is not int for v in (range_start,range_end))
                or not 0 <= range_start <= range_end <= now - 60
                or range_end - range_start > 2678400):
            raise HistoryStale('Choose a fixed historical range of at most 31 days.')
        with self.transaction(context, constraints) as (connection, live, _):
            account = live.actor.account_id
            session = self._session(connection,account)
            username, lineage = binding(session)
            count = connection.execute("select count(*) as count from integration.lastfm_history_generations_v1 "
                "where account_id=%s and state='reading'", (account,)).fetchone()['count']
            if count >= 4:
                raise HistoryStale('Finish or abandon an existing import first.')
            generation = str(uuid4())
            row = connection.execute('insert into integration.lastfm_history_generations_v1 '
                '(id,account_id,provider_username,connection_started_at,range_start,range_end) '
                'values(%s,%s,%s,%s,%s,%s) returning *',
                (generation,account,username,lineage,range_start,range_end)).fetchone()
            return self._status(row)

    def prepare(self, context, *, generation, expected_page, constraints=None, plan_ticket=None):
        if type(expected_page) is not int or not 1 <= expected_page <= 1000000000:
            raise HistoryStale('Invalid import page.')
        with self.transaction(context, constraints) as (connection, live, _):
            row = self._owned(connection,live.actor.account_id,generation)
            plans=connection.execute('select id,revision,state from integration.lastfm_history_backfill_v1 '
                'where account_id=%s and generation_id=%s for update',
                (live.actor.account_id,row['id'])).fetchall()
            if plans:
                if (len(plans)!=1 or type(plan_ticket) is not dict
                        or set(plan_ticket)!={'plan','revision','generation','page'}
                        or plan_ticket['plan']!=str(plans[0]['id'])
                        or type(plan_ticket['revision']) is not int
                        or plan_ticket['revision']!=plans[0]['revision']
                        or plans[0]['state']!='active'
                        or plan_ticket['generation']!=generation or type(plan_ticket['page']) is not int
                        or plan_ticket['page']!=expected_page):
                    raise HistoryStale('Use the current backfill plan revision.')
            elif plan_ticket is not None:
                raise HistoryStale('History plan generation changed.')
            dense=row.get('dense_second',False)
            if type(dense) is not bool or dense and row['range_start']!=row['range_end']:
                raise HistoryUnavailable('Invalid dense history generation.')
            if not dense and expected_page>100:
                raise HistoryStale('Invalid import page.')
            if expected_page < row['next_page'] or row['state'] != 'reading':
                return {'status':self._status(row,replay=expected_page < row['next_page'])}
            if expected_page != row['next_page']:
                raise HistoryStale('Import cursor changed.')
            session = self._session(connection,live.actor.account_id)
            if binding(session) != (row['provider_username'],row['connection_started_at']):
                row = self._stop(connection,row,'connection_changed',state='connection_changed')
                return {'status':self._status(row)}
            if row['lease_until'] is not None and row['lease_until'] > datetime.now(timezone.utc):
                raise HistoryStale('This page is already being read.')
            token = str(uuid4())
            connection.execute("update integration.lastfm_history_generations_v1 set lease_token=%s,"
                "lease_until=clock_timestamp()+interval '30 seconds' where id=%s and account_id=%s",
                (token,row['id'],row['account_id']))
            return {'generation':generation,'page':expected_page,'lease':token,
                'session':session,'range_start':row['range_start'],'range_end':row['range_end'],'dense_second':dense}

    def release(self, context, *, generation, lease, constraints=None):
        with self.transaction(context, constraints) as (connection, live, _):
            connection.execute('update integration.lastfm_history_generations_v1 '
                'set lease_token=null,lease_until=null where id=%s and account_id=%s and lease_token=%s',
                (self._uuid(generation),live.actor.account_id,self._uuid(lease)))

    def pending(self, context, *, constraints=None):
        from .lastfm_history_authority import current_lastfm_history_account_read_transaction
        with current_lastfm_history_account_read_transaction(self.url,context,
                constraints=constraints) as (connection,live,_):
            rows = connection.execute("select * from integration.lastfm_history_generations_v1 "
                "where account_id=%s and state='reading' and not exists "
                "(select 1 from integration.lastfm_history_backfill_v1 b where b.account_id=lastfm_history_generations_v1.account_id "
                "and b.generation_id=lastfm_history_generations_v1.id) order by created_at,id limit 5",
                (live.actor.account_id,)).fetchall()
            if len(rows)>4:
                raise HistoryUnavailable('Import admission bound was violated.')
            return {'generations':[{**self._status(row),'range_start':row['range_start'],
                'range_end':row['range_end']} for row in rows]}

    def abandon(self, context, *, generation, constraints=None):
        with self.transaction(context, constraints) as (connection, live, _):
            row = self._owned(connection,live.actor.account_id,generation)
            plan=connection.execute('select id from integration.lastfm_history_backfill_v1 '
                'where account_id=%s and generation_id=%s',
                (live.actor.account_id,row['id'])).fetchone()
            if plan is not None:raise HistoryStale('Pause the backfill plan instead.')
            if row['state'] == 'reading':
                row = self._stop(connection,row,'abandoned')
            return self._status(row)

    def _budget(self, connection, account_id):
        # Existing app-account lock serializes importer and settings/reconnect.
        # A dedicated column on the existing settings owner is constant-time;
        # reconnect's named-field upsert leaves this retained payload total intact.
        row=connection.execute('select history_retained_payload_bytes as used '
            'from integration.lastfm_settings where account_id=%s for update',
            (account_id,)).fetchone()
        if row is None or row['used'] is None or int(row['used'])<0:
            raise HistoryUnavailable('History payload accounting is unavailable.')
        return {'remaining':self.payload_quota-int(row['used']),'charged':0}

    @staticmethod
    def _charge(budget, amount):
        amount=int(amount)
        if amount<0 or amount>budget['remaining']:
            raise HistoryStorageQuota('Retained history storage quota reached.')
        budget['remaining']-=amount;budget['charged']+=amount

    def _store_page(self, connection, generation, page, budget, *, unusable=None):
        data=asdict(page);data.pop('raw_xml')
        if unusable is not None:data['unusable']=unusable
        stored=connection.execute('insert into integration.lastfm_history_pages_v1 '
            '(generation_id,page_number,digest,raw_xml,page_data) values(%s,%s,%s,%s,%s::jsonb) '
            "returning octet_length(convert_to(raw_xml,'UTF8'))+"
            "octet_length(convert_to(page_data::text,'UTF8')) as payload_bytes",
            (generation['id'],page.page,page.digest,page.raw_xml,json.dumps(data))).fetchone()
        self._charge(budget,stored['payload_bytes'])

    @staticmethod
    def _save_charge(connection, generation, budget):
        connection.execute('update integration.lastfm_history_generations_v1 '
            'set retained_payload_bytes=retained_payload_bytes+%s where id=%s and account_id=%s',
            (budget['charged'],generation['id'],generation['account_id']))
        updated=connection.execute('update integration.lastfm_settings '
            'set history_retained_payload_bytes=history_retained_payload_bytes+%s '
            'where account_id=%s returning account_id',
            (budget['charged'],generation['account_id'])).fetchone()
        if updated is None:raise HistoryUnavailable('History payload accounting is unavailable.')

    def retain_unusable_page(self, connection, generation, page, *, reason):
        # Called only after the actual owned lease and raw parser were checked.
        # A nested transaction is a SAVEPOINT under the current account lock.
        try:
            with connection.transaction():
                budget=self._budget(connection,generation['account_id'])
                self._store_page(connection,generation,page,budget,unusable=reason)
                self._save_charge(connection,generation,budget)
        except HistoryStorageQuota:
            return self._stop(connection,generation,'storage_quota')
        return self._stop(connection,generation,reason)

    def commit_page(self, context, *, request, page, constraints=None):
        if type(page) is not HistoryPage:
            raise HistoryUnavailable('Invalid provider page.')
        with self.transaction(context, constraints) as (connection, live, _):
            row = self._owned(connection,live.actor.account_id,request['generation'])
            if row['state'] != 'reading':
                return self._status(row)
            if str(row['lease_token']) != request['lease']:
                raise HistoryStale('Import read lease changed.')
            dense=row.get('dense_second',False)
            if (type(dense) is not bool or dense and row['range_start']!=row['range_end']
                    or request.get('dense_second',False) is not dense):
                raise HistoryStale('Dense import scope changed.')
            try:
                current_binding = binding(self._session(connection,live.actor.account_id))
            except HistoryStale:
                current_binding = None
            if current_binding != (row['provider_username'],row['connection_started_at']):
                return self._status(self._stop(connection,row,'connection_changed',state='connection_changed'))
            if (page.username != row['provider_username'] or page.page != row['next_page']
                    or request['page'] != page.page
                    or (request['range_start'],request['range_end']) != (row['range_start'],row['range_end'])):
                raise HistoryStale('Provider page scope changed.')
            checked = parse_history_page(page.raw_xml.encode('utf-8'),username=row['provider_username'],
                range_start=row['range_start'],range_end=row['range_end'],page=row['next_page'],allow_dense=dense)
            if checked != page:
                raise HistoryUnavailable('Provider page evidence is inconsistent.')
            try:
                with connection.transaction():
                    budget=self._budget(connection,row['account_id'])
                    self._store_page(connection,row,page,budget)
                    reason=None
                    if row['expected_pages'] is not None and (
                            row['expected_pages'] != page.total_pages or row['expected_total'] != page.total):
                        reason='pagination_changed'
                    # Only one adjacent normalized page is needed for order.
                    previous=connection.execute("select (page_data->>'observed_oldest')::bigint as oldest "
                        'from integration.lastfm_history_pages_v1 where generation_id=%s and page_number=%s',
                        (row['id'],page.page-1)).fetchone() if page.page>1 else None
                    if (previous and previous['oldest'] is not None and page.observed_newest is not None
                            and previous['oldest']<page.observed_newest):
                        reason=reason or 'page_order_changed'
                    final=page.page>=max(1,page.total_pages)
                    if final:
                        counts=connection.execute("select count(*) as pages,coalesce(sum((page_data->>'observed_count')::bigint),0) as observed "
                            'from integration.lastfm_history_pages_v1 where generation_id=%s',(row['id'],)).fetchone()
                        if counts['pages']!=page.page or counts['observed']!=page.total:
                            reason=reason or 'page_count_changed'
                    if final and reason is None:self._promote(connection,row,budget)
                    self._save_charge(connection,row,budget)
                    if reason is not None:
                        return self._status(self._stop(connection,row,reason))
                    row=connection.execute('update integration.lastfm_history_generations_v1 '
                        'set next_page=%s,expected_pages=%s,expected_total=%s,state=%s,'
                        'completed_at=case when %s then clock_timestamp() else null end,'
                        'lease_token=null,lease_until=null where id=%s and account_id=%s returning *',
                        (page.page+1,page.total_pages,page.total,'complete' if final else 'reading',
                         final,row['id'],row['account_id'])).fetchone()
            except HistoryStorageQuota:
                # SAVEPOINT rollback removes this page and every partial promotion
                # batch, not any previously committed observation or occurrence.
                row=self._stop(connection,row,'storage_quota')
            return self._status(row)

    def _store_summary(self, connection, generation, groups, budget):
        # Raw page evidence is authoritative. This derived exact-tuple summary
        # avoids re-aggregating every raw page when Home reads a timestamp bucket.
        records=[{'played_at':item['played_at'],
            'tuple_digest':tuple_digest((item['played_at'],item['artist'],item['track'],item['album'])),
            'artist':item['artist'],'track':item['track'],'album':item['album'],
            'occurrences':item['occurrences']} for item in groups]
        body=json.dumps(records)
        inserted=connection.execute("""insert into integration.lastfm_history_generation_tuples_v1 as stored
            (generation_id,played_at,tuple_digest,artist,track,album,occurrences)
            select %s,x.played_at,x.tuple_digest,x.artist,x.track,x.album,x.occurrences
            from jsonb_to_recordset(%s::jsonb) as x(played_at bigint,tuple_digest text,
                artist text,track text,album text,occurrences bigint)
            on conflict(generation_id,played_at,tuple_digest) do nothing
            returning octet_length(convert_to(to_jsonb(stored)::text,'UTF8')) as payload_bytes""",
            (generation['id'],body)).fetchall()
        self._charge(budget,sum(item['payload_bytes'] for item in inserted))
        actual=connection.execute("""select s.played_at,s.tuple_digest,s.artist,s.track,s.album,s.occurrences
            from integration.lastfm_history_generation_tuples_v1 s
            join jsonb_to_recordset(%s::jsonb) as x(played_at bigint,tuple_digest text)
              on s.played_at=x.played_at and s.tuple_digest=x.tuple_digest
            where s.generation_id=%s""",(body,generation['id'])).fetchall()
        expected={(r['played_at'],r['tuple_digest']):r for r in records}
        if (len(expected)!=len(records) or len(actual)!=len(records)
                or any(dict(r)!=expected.get((r['played_at'],r['tuple_digest'])) for r in actual)):
            raise HistoryUnavailable('History tuple summary identity conflict.')

    def _promote(self, connection, generation, budget):
        def store(batch):
            body=json.dumps(batch)
            inserted=connection.execute("""insert into integration.lastfm_history_occurrences_v1 as stored
                (account_id,provider_username,connection_started_at,played_at,tuple_digest,ordinal,
                 artist,track,album,first_generation,last_generation)
                select %s,%s,%s,x.played_at,x.tuple_digest,x.ordinal,x.artist,x.track,x.album,%s,%s
                from jsonb_to_recordset(%s::jsonb) as x(played_at bigint,tuple_digest text,ordinal bigint,
                    artist text,track text,album text)
                on conflict(account_id,provider_username,connection_started_at,played_at,tuple_digest,ordinal)
                do nothing
                returning octet_length(convert_to(to_jsonb(stored)::text,'UTF8')) as payload_bytes""",
                (generation['account_id'],generation['provider_username'],generation['connection_started_at'],
                 generation['id'],generation['id'],body)).fetchall()
            self._charge(budget,sum(item['payload_bytes'] for item in inserted))
            connection.execute("""update integration.lastfm_history_occurrences_v1 o set last_generation=%s
                from jsonb_to_recordset(%s::jsonb) as x(played_at bigint,tuple_digest text,ordinal bigint)
                where o.account_id=%s and o.provider_username=%s and o.connection_started_at=%s
                  and o.played_at=x.played_at and o.tuple_digest=x.tuple_digest and o.ordinal=x.ordinal""",
                (generation['id'],body,generation['account_id'],generation['provider_username'],generation['connection_started_at']))

        # SQL aggregates the fixed generation; a server-side cursor bounds Python
        # memory independently of its page count or a dense second's multiplicity.
        with connection.cursor(name='lastfm_promote_'+uuid4().hex) as cursor:
            cursor.execute("""select (x->>'timestamp')::bigint as played_at,x->>'artist' as artist,
                x->>'track' as track,x->>'album' as album,count(*) as occurrences
                from integration.lastfm_history_pages_v1 p,
                lateral jsonb_array_elements(p.page_data->'tracks') x
                where p.generation_id=%s
                group by (x->>'timestamp')::bigint,x->>'artist',x->>'track',x->>'album'
                order by (x->>'timestamp')::bigint,x->>'artist',x->>'track',x->>'album'""",(generation['id'],))
            batch=[]
            while True:
                groups=cursor.fetchmany(256)
                if not groups:break
                self._store_summary(connection,generation,groups,budget)
                for item in groups:
                    key=(item['played_at'],item['artist'],item['track'],item['album'])
                    digest=tuple_digest(key)
                    for ordinal in range(1,item['occurrences']+1):
                        batch.append({'played_at':key[0],'tuple_digest':digest,'ordinal':ordinal,
                            'artist':key[1],'track':key[2],'album':key[3]})
                        if len(batch)==256:store(batch);batch=[]
            if batch:store(batch)
        # Runs in the same page/promotion savepoint as completion. Even a genuine
        # empty generation receives this marker; absent summaries alone mean unknown.
        connection.execute('update integration.lastfm_history_generations_v1 '
            'set summary_complete=true where id=%s and account_id=%s',
            (generation['id'],generation['account_id']))

    def read_combined(self, context, *, range_start, range_end, allowed_actions_for_resource, constraints=None):
        """Bounded own-library combined view; never friend/Foobar/native import.

        This is a fresh, uncached read. The route must expose only the public DTO
        below, not native payloads, stored reply identities or raw XML pages.
        """
        from dataclasses import replace
        from .home_activity import ActivityScope, ActivityWindow, build_activity_projection
        from .home_activity_postgres import HomeActivityPostgresRepository, _LEDGER_READ
        from .policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints
        from .lastfm_history_model import reconcile_observed
        if (any(type(v) is not int for v in (range_start,range_end))
                or not 0 <= range_start <= range_end or range_end-range_start > 2678400
                or type(context.library_id) is not int or context.library_id <= 0):
            raise HistoryStale('Invalid combined history range.')
        target = replace(context,action='library.browse.read',resource=None,
            target_account_id=context.actor.account_id)
        effective = constraints(target) if callable(constraints) else constraints
        if effective is not None and type(effective) is not PolicyEvaluationConstraints:
            raise HistoryUnavailable('Policy is unavailable.')
        if not PolicyEvaluator().evaluate(target,constraints=effective).decision.allowed:
            raise HistoryStale('Library history is unavailable.')
        # Same account/session locks; the fixed read authority grants no writes.
        from .lastfm_history_authority import current_lastfm_history_account_read_transaction
        with current_lastfm_history_account_read_transaction(self.url,context,
                constraints=constraints) as (connection,live,_):
            account = live.actor.account_id
            scope = ActivityScope(account,live.actor.session_id,context.library_id)
            HomeActivityPostgresRepository._authority(connection,scope,datetime.now(timezone.utc))
            session = self._session(connection,account)
            username,lineage = binding(session)
            imported = connection.execute('select * from integration.lastfm_history_occurrences_v1 '
                'where account_id=%s and provider_username=%s and connection_started_at=%s '
                'and played_at between %s and %s order by played_at,tuple_digest,ordinal limit 20001',
                (account,username,lineage,range_start,range_end)).fetchall()
            start = datetime.fromtimestamp(range_start,timezone.utc)
            end = datetime.fromtimestamp(range_end+1,timezone.utc)
            native = connection.execute(_LEDGER_READ,(account,context.library_id,
                ['rendered_local_listen_session','runtime_listen_history_adapter','phase_6_json_file_backfill'],
                start,start,end,None,None,0,20001)).fetchall()
            if len(native)>20000:
                raise HistoryStale('Narrow the native history range.')
            projection = build_activity_projection(native,scope=scope,kind='listens',
                window=ActivityWindow(start,end,'UTC','Custom','Custom'),
                allowed_actions_for_resource=allowed_actions_for_resource,
                scrobble_connection_state='connected')
            allowed_ids = {event['event_id'] for event in projection.events}
            native = qualified_native_rows(native,projection)
            physical_rows = connection.execute('select id,device_id::text as device_id,'
                'session_id::text as session_id,source_entry_id from integration.listen_history '
                'where account_id=%s and library_id=%s and id=any(%s::bigint[])',
                (account,context.library_id,sorted(allowed_ids))).fetchall()
            physical = {row['id']:row for row in physical_rows}
            native = [{**row,**{key:physical.get(row['id'],{}).get(key)
                for key in ('device_id','session_id','source_entry_id')}} for row in native]
            generations = connection.execute('select * from integration.lastfm_history_generations_v1 '
                'where account_id=%s and provider_username=%s and connection_started_at=%s '
                'and range_start<=%s and range_end>=%s order by coalesce(completed_at,created_at) desc,id desc limit 101',
                (account,username,lineage,range_end,range_start)).fetchall()
            if len(imported)>20000 or len(native)>20000 or len(generations)>100:
                raise HistoryStale('Narrow the combined history range; this read exceeds its safe bound.')
            timestamps = {item['played_at'] for item in imported}
            needed = set()
            for timestamp in timestamps:
                completed = [item for item in generations if item['state']=='complete'
                    and item['range_start']<=timestamp<=item['range_end']]
                needed.update(str(item['id']) for item in completed[:2])
            if sum(item['expected_total'] or 0 for item in generations if str(item['id']) in needed)>40000:
                raise HistoryStale('Narrow the observation comparison range.')
            page_rows = connection.execute('select generation_id,page_data from integration.lastfm_history_pages_v1 '
                'where generation_id=any(%s::uuid[]) order by generation_id,page_number',
                (sorted(needed),)).fetchall()
            pages_by_generation = {}
            for item in page_rows:
                pages_by_generation.setdefault(str(item['generation_id']),[]).append(item['page_data'])
            counters = {key:multiset(pages) for key,pages in pages_by_generation.items()}
            retained = Counter((item['played_at'],item['artist'],item['track'],item['album']) for item in imported)
            timestamps = {key[0] for key in retained}
            uncertain = set()
            for timestamp in timestamps:
                covering = [item for item in generations if item['range_start']<=timestamp<=item['range_end']]
                complete = [item for item in covering if item['state']=='complete']
                if not complete or covering[0]['state']!='complete':
                    uncertain.add(timestamp)
                    continue
                current = Counter({key:count for key,count in counters.get(str(complete[0]['id']),{}).items()
                    if key[0]==timestamp})
                previous = Counter({key:count for key,count in counters.get(str(complete[1]['id']),{}).items()
                    if key[0]==timestamp}) if len(complete)>1 else current
                retained_bucket = Counter({key:count for key,count in retained.items() if key[0]==timestamp})
                if current != previous or current != retained_bucket:
                    uncertain.add(timestamp)
            result = reconcile_observed(native,imported,account_id=account,library_id=context.library_id,
                provider_username=username,connection_started_at=lineage,uncertain_timestamps=uncertain)
            # Durable native authority and request deployment/client constraints
            # are re-evaluated after reading before any DTO leaves the owner.
            HomeActivityPostgresRepository._authority(connection,scope,datetime.now(timezone.utc))
            effective = constraints(target) if callable(constraints) else constraints
            if not PolicyEvaluator().evaluate(target,constraints=effective).decision.allowed:
                raise HistoryStale('Library history changed.')
            final_projection = build_activity_projection(native,scope=scope,kind='listens',
                window=ActivityWindow(start,end,'UTC','Custom','Custom'),
                allowed_actions_for_resource=allowed_actions_for_resource,
                scrobble_connection_state='connected')
            if {event['event_id'] for event in final_projection.events} != allowed_ids:
                raise HistoryStale('History resource permissions changed.')
            result['coverage'] = observation_coverage(generations,range_start,range_end)
            return public_combined_view(result)


def public_combined_view(result):
    """No credential, path, raw provider XML or submission identity escapes."""
    from .home_activity import _display
    native = []
    public_ids = {}
    for row in result['native']:
        display = row.get('display')
        if type(display) is not dict:
            raise HistoryUnavailable('Authorized Home display is required.')
        public_ids[row['id']] = display['id']
        native.append({'id':display['id'], 'source':'in_app',
            'source_label':display['source_label'], 'played_at':display['last_listened_at'],
            'artist':display['artist'],'track':display['title'],'album':display['album_title']})
    remote = [{'key':[row['played_at'],row['tuple_digest'],row['ordinal']],
        'source':'lastfm_import','played_at':row['played_at'],'artist':_display(row['artist']),
        'track':_display(row['track']),'album':_display(row['album']),
        'uncertain':row['played_at'] in result['uncertain_timestamps']} for row in result['imported']]
    return {'native':native,'imported':remote,
        'links':[{**link,'native_id':public_ids[link['native_id']]} for link in result['links']],
        'combined_count':result['combined_count'],
        'uncertain_timestamps':result['uncertain_timestamps'],
        'correlation_label':'Exact observed-tuple match; not a provider event ID',
        'send_actions':[], 'coverage':result.get('coverage', {
            'state':'unknown','complete_history':False,'provider_snapshot_guaranteed':False})}


def observation_coverage(generations, start, end):
    completed = [row for row in generations if row['state']=='complete']
    cursor = start
    for left,right in sorted((max(start,row['range_start']),min(end,row['range_end'])) for row in completed):
        if left > cursor:
            break
        cursor = max(cursor,right+1)
    covered = cursor>end
    state = 'not_imported' if not generations else 'observed_range' if covered else 'partial'
    if generations and generations[0]['state']!='complete':
        state = 'reading' if generations[0]['state']=='reading' else 'uncertain'
    return {'requested_start':start,'requested_end':end,'state':state,
        'requested_range_has_completed_observations':covered,
        'complete_history':False,'provider_snapshot_guaranteed':False,
        'label':'Available observations only. Imported pages are not an immutable provider snapshot; '
            'missing or changed observations never delete personal history.'}


def qualified_native_rows(rows, projection):
    admitted = {event['event_id'] for event in projection.events}
    result = []
    for row in rows:
        if row['id'] not in admitted:
            continue
        metadata = row.get('metadata')
        payload = metadata.get('source_payload') if type(metadata) is dict else None
        result.append({**row,'payload':payload if type(payload) is dict else {},
            'display':projection.groups[f"listen:event:{row['id']}"]['row']})
    return result
