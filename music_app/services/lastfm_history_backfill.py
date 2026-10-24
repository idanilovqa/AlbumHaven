"""Explicit finite-page All Time observation plan; never a scrobble sender."""
from datetime import timedelta
from uuid import uuid4

from .lastfm_history_authority import current_lastfm_history_account_read_transaction
from .lastfm_history_model import binding, HistoryStale, HistoryUnavailable
from .lastfm_history_postgres import LastfmHistoryRepository
from .lastfm_history_reader import read_history_page, HistoryRangeTooLarge, parse_history_page

WINDOW_SECONDS=2678400
MAX_FAILURES=4
_REASONS=frozenset({'paused','connection_changed','read_failed','range_split',
    'single_second_over_budget','dense_second','storage_quota','pagination_changed','page_order_changed',
    'page_count_changed','abandoned','uncertain_range'})


class LastfmHistoryBackfill:
    def __init__(self, config):
        self.config=config
        self.repository=LastfmHistoryRepository(config)

    @staticmethod
    def _status(row):
        result={key:(str(row[key]) if key=='id' else row[key].isoformat()
            if key=='next_allowed_at' else row[key]) for key in
            ('id','state','revision','upper_cut','cursor_end','window_seconds','completed_windows',
             'next_allowed_at')}
        reason=row.get('reason')
        result.update(reason=reason if reason in _REASONS else None if reason in (None,'') else 'uncertain_range',
            lower_bound=0,provider_snapshot_guaranteed=False,complete_history=False)
        return result

    def _owned(self, connection, account, plan):
        row=connection.execute('select * from integration.lastfm_history_backfill_v1 '
            'where id=%s and account_id=%s for update',(self.repository._uuid(plan),account)).fetchone()
        if row is None:raise HistoryStale('History plan is unavailable.')
        return row

    @staticmethod
    def _revision(value):
        if type(value) is not int or not 1<=value<9223372036854775807:
            raise HistoryStale('Invalid history plan revision.')

    @staticmethod
    def _set(connection,row,**values):
        # All column names originate in this owner, never in a request.
        columns=','.join(key+'=%s' for key in values)
        return connection.execute('update integration.lastfm_history_backfill_v1 set '+columns+
            ' where id=%s and account_id=%s returning *',
            (*values.values(),row['id'],row['account_id'])).fetchone()

    def _binding(self, connection, account, row):
        try:current=binding(self.repository._session(connection,account))
        except HistoryStale:current=None
        if current!=(row['provider_username'],row['connection_started_at']):
            if row['generation_id'] is not None:
                generation=self._generation(connection,account,row)
                if generation['state']=='reading':
                    self.repository._stop(connection,generation,'connection_changed',state='connection_changed')
            return self._set(connection,row,state='connection_changed',reason='connection_changed',
                revision=row['revision']+1)
        return row

    def _generation(self, connection, account, row):
        generation=self.repository._owned(connection,account,str(row['generation_id']))
        expected=(row['provider_username'],row['connection_started_at'],
            max(0,row['cursor_end']-row['window_seconds']+1),row['cursor_end'])
        actual=(generation['provider_username'],generation['connection_started_at'],
            generation['range_start'],generation['range_end'])
        if (actual!=expected or generation.get('dense_second',False) is not row.get('dense_second',False)
                or row.get('dense_second',False) and row['window_seconds']!=1):
            raise HistoryUnavailable('History plan generation binding is invalid.')
        return generation

    def _split(self, connection, row, generation, now):
        width=generation['range_end']-generation['range_start']+1
        return self._set(connection,row,generation_id=None,window_seconds=max(1,width//2),
            dense_second=width==1,state='active',
            reason='dense_second' if width==1 else 'range_split',
            next_allowed_at=max(row['next_allowed_at'],now+timedelta(seconds=2)))

    def begin(self, context, *, constraints=None):
        with self.repository.transaction(context,constraints) as (connection,live,now):
            username,lineage=binding(self.repository._session(connection,live.actor.account_id))
            stale=connection.execute("select * from integration.lastfm_history_backfill_v1 "
                "where account_id=%s and state in ('active','paused','blocked') "
                "and (provider_username,connection_started_at) is distinct from (%s,%s) for update",
                (live.actor.account_id,username,lineage)).fetchall()
            for old in stale:
                if old['generation_id'] is not None:
                    generation=self._generation(connection,live.actor.account_id,old)
                    if generation['state']=='reading':
                        self.repository._stop(connection,generation,'connection_changed',state='connection_changed')
                self._set(connection,old,state='connection_changed',reason='connection_changed',
                    revision=old['revision']+1)
            previous=connection.execute("select * from integration.lastfm_history_backfill_v1 "
                "where account_id=%s and provider_username=%s and connection_started_at=%s "
                "and state in ('active','paused','blocked') order by created_at desc,id desc limit 1 for update",
                (live.actor.account_id,username,lineage)).fetchone()
            if previous is not None:return self._status(previous)
            cut=int(now.timestamp())-60
            if cut<0:raise HistoryUnavailable('History clock is unavailable.')
            row=connection.execute('insert into integration.lastfm_history_backfill_v1 '
                '(id,account_id,provider_username,connection_started_at,upper_cut,cursor_end,next_allowed_at) '
                'values(%s,%s,%s,%s,%s,%s,%s) returning *',
                (str(uuid4()),live.actor.account_id,username,lineage,cut,cut,now)).fetchone()
            return self._status(row)

    def pending(self, context, *, constraints=None):
        with current_lastfm_history_account_read_transaction(self.repository.url,context,
                constraints=constraints) as (connection,live,_):
            rows=connection.execute('select * from integration.lastfm_history_backfill_v1 '
                "where account_id=%s order by (state in ('active','paused','blocked')) desc,created_at desc,id desc limit 5",
                (live.actor.account_id,)).fetchall()
            # Latest five plans is an explicit bounded recovery view, not history coverage.
            return {'plans':[self._status(row) for row in rows]}

    def control(self, context, *, plan, revision, resume, constraints=None):
        self._revision(revision)
        with self.repository.transaction(context,constraints) as (connection,live,now):
            row=self._owned(connection,live.actor.account_id,plan)
            if row['revision']!=revision:return self._status(row)
            row=self._binding(connection,live.actor.account_id,row)
            if row['state'] in ('connection_changed','observed'):return self._status(row)
            if resume:
                # Drift requires a new observation generation. Quota exhaustion is
                # different: its incoming page/promotion was fully rolled back, so
                # explicit resume retains the coherent committed cursor and pages.
                if row['generation_id'] is not None:
                    generation=self._generation(connection,live.actor.account_id,row)
                    if generation['state']=='uncertain' and generation['reason']=='range_too_large':
                        row=self._split(connection,row,generation,now)
                        return self._status(self._set(connection,row,revision=revision+1))
                    if generation['state']=='uncertain' and generation['reason']=='storage_quota':
                        # No quota increase is inferred. The next advance measures
                        # the current allowance again and may block here again.
                        self.repository._stop(connection,generation,'',state='reading')
                    elif generation['state'] in ('uncertain','connection_changed'):
                        row=self._set(connection,row,generation_id=None)
                if row['state']=='blocked' and row['reason']=='single_second_over_budget':
                    # Re-observation is explicit, but never widens/skips this bucket.
                    row=self._set(connection,row,window_seconds=1)
                row=self._set(connection,row,state='active',reason=None,failures=0,revision=revision+1)
            else:
                row=self._set(connection,row,state='paused',reason='paused',revision=revision+1)
            return self._status(row)

    def pause(self, context, **kwargs):return self.control(context,resume=False,**kwargs)
    def resume(self, context, **kwargs):return self.control(context,resume=True,**kwargs)

    def _reserve(self, context, *, plan, revision, constraints):
        self._revision(revision)
        with self.repository.transaction(context,constraints) as (connection,live,now):
            row=self._owned(connection,live.actor.account_id,plan)
            if row['revision']!=revision:return {'status':self._status(row)}
            row=self._binding(connection,live.actor.account_id,row)
            if row['state']!='active' or row['next_allowed_at']>now:
                return {'status':self._status(row)}
            generation=None
            if row['generation_id'] is not None:
                generation=self._generation(connection,live.actor.account_id,row)
                if generation['state']=='complete':
                    row=self._set(connection,row,cursor_end=generation['range_start']-1,
                        completed_windows=row['completed_windows']+1,generation_id=None,
                        window_seconds=WINDOW_SECONDS,dense_second=False,failures=0)
                    generation=None
                elif generation['state']!='reading':
                    if generation['state']=='uncertain' and generation['reason']=='range_too_large':
                        row=self._split(connection,row,generation,now)
                        row=self._set(connection,row,revision=revision+1)
                    else:
                        row=self._set(connection,row,state='blocked',reason=generation['reason'] or 'uncertain_range',
                            revision=revision+1)
                    return {'status':self._status(row)}
            if row['cursor_end']<0:
                row=self._set(connection,row,state='observed',reason=None,revision=revision+1)
                return {'status':self._status(row)}
            if generation is None:
                count=connection.execute("select count(*) as count from integration.lastfm_history_generations_v1 "
                    "where account_id=%s and state='reading'",(live.actor.account_id,)).fetchone()['count']
                if count>=4:raise HistoryStale('Finish another active range first.')
                start=max(0,row['cursor_end']-row['window_seconds']+1)
                generation=connection.execute('insert into integration.lastfm_history_generations_v1 '
                    '(id,account_id,provider_username,connection_started_at,range_start,range_end,dense_second) '
                    'values(%s,%s,%s,%s,%s,%s,%s) returning *',
                    (str(uuid4()),live.actor.account_id,row['provider_username'],row['connection_started_at'],start,row['cursor_end'],row.get('dense_second',False))).fetchone()
            row=self._set(connection,row,generation_id=generation['id'],revision=revision+1,
                next_allowed_at=now+timedelta(seconds=30),reason=None)
            return {'plan':str(row['id']),'revision':row['revision'],
                'generation':str(generation['id']),'page':generation['next_page']}

    def _record_oversized(self, context, ticket, request, evidence, *, constraints):
        # The generation lease, not a mutable UI plan revision, owns the reply.
        # Pause may stop future work but must not erase an already read page.
        with self.repository.transaction(context,constraints) as (connection,live,_):
            generation=self.repository._owned(connection,live.actor.account_id,ticket['generation'])
            if generation['state']!='reading':return
            if (request is None or request.get('generation')!=ticket['generation']
                    or request.get('page')!=ticket['page']
                    or generation['next_page']!=ticket['page']
                    or str(generation['lease_token'])!=request.get('lease')):
                raise HistoryStale('History lease changed.')
            if binding(self.repository._session(connection,live.actor.account_id)) != (
                    generation['provider_username'],generation['connection_started_at']):
                self.repository._stop(connection,generation,'connection_changed',state='connection_changed')
                return
            try:
                parse_history_page(evidence.raw_xml.encode(),username=generation['provider_username'],
                    range_start=generation['range_start'],range_end=generation['range_end'],page=ticket['page'])
            except HistoryRangeTooLarge as checked:
                if checked.evidence!=evidence.evidence:
                    raise HistoryUnavailable('Oversized evidence changed.')
            else:
                raise HistoryUnavailable('Oversized evidence is invalid.')
            self.repository.retain_unusable_page(connection,generation,evidence.evidence,reason='range_too_large')

    def _finish(self, context, ticket, *, failed=False, constraints=None):
        with self.repository.transaction(context,constraints) as (connection,live,now):
            row=self._owned(connection,live.actor.account_id,ticket['plan'])
            if row['revision']!=ticket['revision'] or str(row['generation_id'])!=ticket['generation']:
                return self._status(row)
            row=self._binding(connection,live.actor.account_id,row)
            if row['state']!='active':return self._status(row)
            generation=self._generation(connection,live.actor.account_id,row)
            # Committed generation truth wins over an uncertain transport return.
            if generation['state']=='complete':
                cursor=generation['range_start']-1
                row=self._set(connection,row,cursor_end=cursor,generation_id=None,
                    completed_windows=row['completed_windows']+1,window_seconds=WINDOW_SECONDS,dense_second=False,failures=0,
                    state='observed' if cursor<0 else 'active',reason=None,
                    next_allowed_at=now+timedelta(seconds=2))
            elif generation['state']=='uncertain' and generation['reason']=='range_too_large':
                row=self._split(connection,row,generation,now)
            elif generation['state']!='reading':
                row=self._set(connection,row,state='connection_changed' if generation['state']=='connection_changed' else 'blocked',
                    reason=generation['reason'] or 'uncertain_range',next_allowed_at=now+timedelta(seconds=2))
            elif failed:
                failures=row['failures']+1
                # A busy/uncertain lease is not released by another reservation;
                # do not let short backoff generate rapid retries against it.
                wait=max(now+timedelta(seconds=min(300,2**failures)),
                    generation['lease_until'] or now)
                row=self._set(connection,row,failures=failures,state='paused' if failures>=MAX_FAILURES else 'active',
                    reason='read_failed',next_allowed_at=wait)
            else:
                row=self._set(connection,row,failures=0,next_allowed_at=now+timedelta(seconds=2))
            return self._status(row)

    def advance(self, context, *, plan, revision, constraints=None):
        ticket=self._reserve(context,plan=plan,revision=revision,constraints=constraints)
        if 'status' in ticket:return ticket['status']
        request=None
        try:
            request=self.repository.prepare(context,generation=ticket['generation'],expected_page=ticket['page'],constraints=constraints,plan_ticket=ticket)
            if 'status' not in request:
                page=read_history_page(self.config,session=request['session'],range_start=request['range_start'],
                    range_end=request['range_end'],page=request['page'],allow_dense=request.get('dense_second',False))
                self.repository.commit_page(context,request=request,page=page,constraints=constraints)
        except HistoryRangeTooLarge as error:
            self._record_oversized(context,ticket,request,error,constraints=constraints)
            return self._finish(context,ticket,constraints=constraints)
        except Exception:
            if request is not None and 'lease' in request:
                try:self.repository.release(context,generation=ticket['generation'],lease=request['lease'],constraints=constraints)
                except Exception:pass
            # Never expose provider errors/credentials; preserve the durable cursor.
            return self._finish(context,ticket,failed=True,constraints=constraints)
        return self._finish(context,ticket,constraints=constraints)
