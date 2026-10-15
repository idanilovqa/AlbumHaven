"""Account-owned Goals; calendar transitions remain in listening_goals.

No library context, inventory identity, browser metadata or provider URLs are
admission authority. Provider IO happens outside the account transaction.
"""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
from uuid import uuid4

from music_app.services import listening_goals as domain
from music_app.services.admin_authority import lock_admin_accounts
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session, RecentAuthenticationRequired
from music_app.services.current_actor import ActorState
from music_app.services.listening_goals_commands import GoalsError, normalize_goal_command, uuid_ref
from music_app.services.policy import PolicyContext
from music_app.services.policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints
from music_app.services.postgres_connections import pooled_connection
from music_app.services.remote_album_provider import fetch_release_group_evidence
from music_app.services.remote_album_evidence import canonical_release_group_id, RemoteAlbumEvidenceError, ReleaseGroupEvidence
from music_app.services.social_cursors import encode_social_cursor, decode_social_cursor

READ = 'account.self.goals.read'
WRITE = 'account.self.goals.write'
EVIDENCE_LIFETIME = timedelta(minutes=30)
MAX_PENDING_EVIDENCE = 100
BIGINT_MAX = 9223372036854775807


def _iso(value):
    return value.astimezone(timezone.utc).isoformat()


def _facts_version(row):
    values = [1, 'musicbrainz', 'release-group', row['external_id'], row['title'],
              row['artist_display'], row['first_release_date'], row['primary_type']]
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


class PostgresListeningGoalsService:
    def __init__(self, config, *, connect=None, clock=None, provider=None, user_agent=None):
        self._url = str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        if not self._url:
            raise RuntimeError('Postgres configuration is required for Goals.')
        self._connect = connect or pooled_connection
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._provider = provider or fetch_release_group_evidence
        # Deployment composition supplies the same public product identifier as
        # existing MusicBrainz consumers. It is never copied from a request.
        self._user_agent = user_agent

    @staticmethod
    def _require(context, action, constraints):
        if not isinstance(context, PolicyContext):
            raise GoalsError('forbidden', 403)
        actor = context.actor
        if not actor.is_authenticated or any(type(v) is not int or v <= 0 for v in (actor.account_id, actor.session_id)):
            raise GoalsError('forbidden', 403)
        target = replace(context, action=action, target_account_id=actor.account_id,
                         library_id=None, resource=None)
        effective = constraints(target) if callable(constraints) else constraints
        if effective is not None and not isinstance(effective, PolicyEvaluationConstraints):
            raise RuntimeError('Goals policy constraints are invalid.')
        if not PolicyEvaluator().evaluate(target, constraints=effective).decision.allowed:
            raise GoalsError('forbidden', 403)
        return target

    @contextmanager
    def _authorized(self, context, action, constraints, *, should_cancel=None):
        context = self._require(context, action, constraints)
        try:
            with self._connect(self._url) as connection:
                connection.execute('set transaction isolation level read committed')
                actor = context.actor
                lock_admin_accounts(connection, actor.account_id, actor.account_id)
                row = connection.execute('select is_active,disabled_at from app.accounts where id=%s',
                                         (actor.account_id,)).fetchone()
                if row is None or row['is_active'] is not True or row['disabled_at'] is not None:
                    raise GoalsError('forbidden', 403)
                now = lock_current_actor_session(connection, actor_account_id=actor.account_id,
                    actor_session_id=actor.session_id, clock=self._clock)
                live = replace(context, actor=replace(actor, state=ActorState.ACTIVE, is_bootstrap_owner=False))
                self._require(live, action, constraints)
                yield connection, live, now
                self._require(live, action, constraints)
                lock_current_actor_session(connection, actor_account_id=actor.account_id,
                    actor_session_id=actor.session_id, clock=self._clock)
                # Evidence-only final fence: after all final authorization SQL,
                # before the connection context commits. An observed cancellation
                # rolls back; one arriving after this last sample may race commit
                # and cannot undo evidence that has already committed.
                if should_cancel is not None and should_cancel():
                    raise GoalsError('provider_cancelled', 503)
        except RecentAuthenticationRequired:
            raise GoalsError('forbidden', 403) from None
        except domain.GoalsDomainError as error:
            raise GoalsError(error.code, 409) from None
        except GoalsError:
            raise
        except Exception as error:
            if getattr(error, 'sqlstate', None) in {'23505', '23503', '40001', '40P01'}:
                raise GoalsError('concurrent_change', 409) from None
            raise

    def acquire_evidence(self, context, release_group_id, *, constraints=None, should_cancel=None):
        try:
            ref = canonical_release_group_id(release_group_id)
        except RemoteAlbumEvidenceError as error:
            raise GoalsError(error.code, 400) from None
        # A real live session check precedes external IO. Locks are released
        # before contacting MusicBrainz; authority is checked again afterwards.
        with self._authorized(context, WRITE, constraints):
            pass
        try:
            facts = self._provider(ref, user_agent=self._user_agent, should_cancel=should_cancel)
        except RemoteAlbumEvidenceError as error:
            raise GoalsError(error.code, 503) from None
        if not isinstance(facts, ReleaseGroupEvidence) or facts.release_group_id != ref:
            raise GoalsError('invalid_provider_metadata', 503)
        if should_cancel is not None and should_cancel():
            raise GoalsError('provider_cancelled', 503)
        with self._authorized(context, WRITE, constraints, should_cancel=should_cancel) as (connection, live, now):
            if should_cancel is not None and should_cancel():
                raise GoalsError('provider_cancelled', 503)
            account = live.actor.account_id
            count = connection.execute('''select count(*) as count from app.listening_goal_evidence
                where account_id=%s and expires_at>%s and revoked_at is null''', (account, now)).fetchone()['count']
            if count >= MAX_PENDING_EVIDENCE:
                raise GoalsError('evidence_limit', 429)
            evidence_ref = str(uuid4())
            connection.execute('''insert into app.listening_goal_evidence
                (ref,account_id,original_session_id,provider,entity_kind,external_id,evidence_version,
                 title,artist_display,first_release_date,primary_type,created_at,expires_at)
                values(%s,%s,%s,'musicbrainz','release-group',%s,%s,%s,%s,%s,%s,%s,%s)''',
                (evidence_ref, account, live.actor.session_id, facts.release_group_id, facts.digest,
                 facts.title, facts.artist_display, facts.first_release_date, facts.primary_type,
                 now, now + EVIDENCE_LIFETIME))
            if should_cancel is not None and should_cancel():
                raise GoalsError('provider_cancelled', 503)
            return {'evidence_ref': evidence_ref, 'evidence_version': facts.digest,
                    'expires_at': _iso(now + EVIDENCE_LIFETIME), 'album': {
                        'title': facts.title, 'artist_display': facts.artist_display,
                        'first_release_date': facts.first_release_date, 'primary_type': facts.primary_type}}

    @staticmethod
    def _load(connection, account):
        aggregate = connection.execute('select ref,revision from app.listening_goals where account_id=%s',
                                       (account,)).fetchone()
        state = domain.create_goal_state(top_ref=str(aggregate['ref']) if aggregate else str(uuid4()))
        if aggregate is None:
            return aggregate, state, []
        albums = connection.execute('''select * from app.listening_goal_albums where account_id=%s
            order by original_position''', (account,)).fetchall()
        state['album_refs'] = [str(row['catalog_ref']) for row in albums]
        rows = connection.execute('''select * from app.listening_goal_assignments where account_id=%s
            order by position''', (account,)).fetchall()
        state['assignments'] = [{'assignment_id': str(row['assignment_id']), 'album_ref': str(row['catalog_ref']),
            'period': row['period'], 'assigned_at': _iso(row['assigned_at'])} for row in rows]
        cycles = connection.execute('''select * from app.listening_goal_cycles where account_id=%s
            order by period,position''', (account,)).fetchall()
        items = connection.execute('''select * from app.listening_goal_cycle_items where account_id=%s
            order by cycle_id,position''', (account,)).fetchall()
        by_cycle = {}
        for row in items:
            by_cycle.setdefault(str(row['cycle_id']), []).append(row)
        for row in cycles:
            cycle_id = str(row['cycle_id'])
            members = by_cycle.get(cycle_id, [])
            marks = {str(item['catalog_ref']): _iso(item['manual_completed_at'])
                     for item in members if item['manual_completed_at'] is not None}
            cycle = {'cycle_id': cycle_id, 'started_at': _iso(row['started_at']),
                     'start_date': row['start_date'].isoformat(), 'due_date': row['due_date'].isoformat(),
                     'timezone_name': row['timezone_name'],
                     'album_refs': [str(item['catalog_ref']) for item in members],
                     'completion': {str(account): marks} if marks else {}}
            period = state['periods'].setdefault(row['period'], {'current': None, 'history': []})
            if row['closed_at'] is None:
                period['current'] = cycle
            else:
                cycle['closed_at'] = _iso(row['closed_at'])
                period['history'].append(cycle)
        # Validate authentic stored calendar/assignment invariants, not only the
        # visible selected period. A corrupt state must never be rewritten.
        domain.goal_period_view(state, period='week', viewer_ref=str(account))
        return aggregate, state, albums

    def read(self, context, *, constraints=None):
        with self._authorized(context, READ, constraints) as (connection, live, _):
            aggregate, state, albums = self._load(connection, live.actor.account_id)
            try:
                self._require(live, WRITE, constraints)
                can_write = True
            except GoalsError:
                can_write = False
            periods = {name: domain.goal_period_view(state, period=name,
                viewer_ref=str(live.actor.account_id)) for name in domain.GOAL_PERIODS}
            if aggregate is None:
                for value in periods.values():
                    value['top_ref'] = None
            return {'goal_ref': str(aggregate['ref']) if aggregate else None,
                    'revision': str(aggregate['revision']) if aggregate else '1',
                    'periods': periods,
                    'allowed_actions': {'can_read': True, 'can_add': can_write, 'can_reset': can_write},
                    'albums': [{'catalog_ref': str(row['catalog_ref']), 'title': row['title'],
                        'artist_display': row['artist_display'], 'first_release_date': row['first_release_date'],
                        'primary_type': row['primary_type']} for row in albums]}

    @staticmethod
    def _catalog(connection, evidence):
        identity = ('musicbrainz', 'release-group', evidence['external_id'])
        query = '''select catalog_ref from catalog.release_group_provider_identities
            where provider=%s and entity_kind=%s and external_id=%s'''
        row = connection.execute(query, identity).fetchone()
        if row:
            return str(row['catalog_ref'])
        candidate = str(uuid4())
        # A losing cross-account race rolls back its candidate catalog record;
        # it must not strand a catalog UUID or retry the whole Goal command.
        try:
            with connection.transaction():
                connection.execute('''insert into catalog.release_groups(ref,title,artist_display,release_year)
                    values(%s,%s,%s,%s)''', (candidate, evidence['title'], evidence['artist_display'],
                        int(evidence['first_release_date'][:4]) if evidence['first_release_date'] else None))
                connection.execute('''insert into catalog.release_group_provider_identities
                    (provider,entity_kind,external_id,catalog_ref) values(%s,%s,%s,%s)''', (*identity, candidate))
            return candidate
        except Exception as error:
            if getattr(error, 'sqlstate', None) != '23505':
                raise
            row = connection.execute(query, identity).fetchone()
            if row is None:
                raise GoalsError('identity_conflict', 409) from None
            return str(row['catalog_ref'])

    @staticmethod
    def _persist(connection, account, before, after, *, evidence, now, revision, exists):
        ref = after['top_ref']
        if not exists:
            connection.execute('''insert into app.listening_goals(account_id,ref,revision,created_at,updated_at)
                values(%s,%s,%s,%s,%s)''', (account, ref, revision, now, now))
        else:
            connection.execute('''update app.listening_goals set revision=%s,updated_at=%s
                where account_id=%s''', (revision, now, account))
        previous_albums = set(before['album_refs'])
        for position, album in enumerate(after['album_refs'], 1):
            if album in previous_albums:
                continue
            if evidence is None:
                raise RuntimeError('Goal album admission evidence is missing.')
            connection.execute('''insert into app.listening_goal_albums
                (account_id,goal_ref,catalog_ref,original_position,title,artist_display,
                 first_release_date,primary_type,evidence_ref,evidence_version,admitted_at)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (account, ref, album, position, evidence['title'], evidence['artist_display'],
                 evidence['first_release_date'], evidence['primary_type'], evidence['ref'],
                 evidence['evidence_version'], now))
        previous_assignments = {row['assignment_id'] for row in before['assignments']}
        for position, row in enumerate(after['assignments'], 1):
            if row['assignment_id'] not in previous_assignments:
                connection.execute('''insert into app.listening_goal_assignments
                    (assignment_id,account_id,goal_ref,catalog_ref,period,assigned_at,position)
                    values(%s,%s,%s,%s,%s,%s,%s)''', (row['assignment_id'], account, ref,
                        row['album_ref'], row['period'], row['assigned_at'], position))
        for period, value in after['periods'].items():
            old = before['periods'].get(period)
            previous = {cycle['cycle_id']: cycle for cycle in
                        ([*old['history'], old['current']] if old else [])}
            all_cycles = [*value['history'], value['current']]
            # Close the existing cycle before inserting a new current cycle.
            for cycle in value['history']:
                prior = previous.get(cycle['cycle_id'])
                if prior is not None and 'closed_at' not in prior:
                    connection.execute('''update app.listening_goal_cycles set closed_at=%s
                        where account_id=%s and cycle_id=%s and closed_at is null''',
                        (cycle['closed_at'], account, cycle['cycle_id']))
            for position, cycle in enumerate(all_cycles, 1):
                prior = previous.get(cycle['cycle_id'])
                if prior is None:
                    if 'closed_at' in cycle:
                        raise RuntimeError('Unexpected new archived Goal cycle.')
                    connection.execute('''insert into app.listening_goal_cycles
                        (cycle_id,account_id,goal_ref,period,position,started_at,start_date,due_date,timezone_name)
                        values(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                        (cycle['cycle_id'], account, ref, period, position, cycle['started_at'],
                         cycle['start_date'], cycle['due_date'], cycle['timezone_name']))
                old_members = set(prior['album_refs']) if prior else set()
                for member_position, album in enumerate(cycle['album_refs'], 1):
                    if album not in old_members:
                        connection.execute('''insert into app.listening_goal_cycle_items
                            (account_id,goal_ref,cycle_id,catalog_ref,position,manual_completed_at)
                            values(%s,%s,%s,%s,%s,%s)''', (account, ref, cycle['cycle_id'], album,
                                member_position, cycle['completion'].get(str(account), {}).get(album)))

    def execute(self, context, command, *, constraints=None):
        # Revalidate a command at the write boundary; construction alone is not
        # authority and no caller-owned mutable object survives into the lock.
        command = normalize_goal_command(command.action, {**command.data, 'request_key': command.request_key})
        with self._authorized(context, WRITE, constraints) as (connection, live, now):
            account = live.actor.account_id
            prior = connection.execute('''select original_session_id,command_digest,receipt
                from app.listening_goal_operations where account_id=%s and request_key=%s''',
                (account, command.request_key)).fetchone()
            if prior is not None:
                if prior['original_session_id'] != live.actor.session_id:
                    raise GoalsError('operation_unavailable', 404)
                if prior['command_digest'] != command.digest:
                    raise GoalsError('idempotency_key_reused', 409)
                return dict(prior['receipt'])
            aggregate, before, _ = self._load(connection, account)
            revision = aggregate['revision'] if aggregate else 1
            if command.data['revision'] != str(revision):
                raise GoalsError('revision_conflict', 409)
            evidence = None
            album = None
            if command.action == 'add':
                evidence = connection.execute('''select * from app.listening_goal_evidence
                    where ref=%s and account_id=%s for share''',
                    (command.data['evidence_ref'], account)).fetchone()
                if (evidence is None or evidence['evidence_version'] != command.data['evidence_version']
                        or evidence['expires_at'] <= now or evidence['revoked_at'] is not None
                        or evidence['provider'] != 'musicbrainz' or evidence['entity_kind'] != 'release-group'
                        or _facts_version(evidence) != evidence['evidence_version']):
                    raise GoalsError('evidence_unavailable', 409)
                album = self._catalog(connection, evidence)
                duplicate = any(row['album_ref'] == album and row['period'] == command.data['period']
                                for row in before['assignments'])
                weekly = before['periods'].get('week')
                if (command.data['period'] == 'week' and not duplicate and weekly is not None
                        and len(weekly['current']['album_refs']) >= 5):
                    raise GoalsError('weekly_capacity', 409)
                result = domain.add_goal(before, album_ref=album, period=command.data['period'],
                    assignment_id=str(uuid4()), occurred_at=now, timezone_name=command.data['timezone_name'],
                    cycle_ids={name: str(uuid4()) for name in domain.GOAL_PERIODS[
                        domain.GOAL_PERIODS.index(command.data['period']):]})
            else:
                result = domain.reset_goal_period(before, period=command.data['period'],
                    expected_cycle_id=command.data['expected_cycle_id'], new_cycle_id=str(uuid4()),
                    occurred_at=now, timezone_name=command.data['timezone_name'])
            if result['changed']:
                if revision == BIGINT_MAX:
                    raise GoalsError('revision_exhausted', 409)
                revision += 1
                self._persist(connection, account, before, result['state'], evidence=evidence,
                              now=now, revision=revision, exists=aggregate is not None)
            receipt = {'ok': True, 'action': command.action, 'request_key': command.request_key,
                       'changed': result['changed'], 'reason': result['reason'],
                       'goal_ref': result['state']['top_ref'] if aggregate or result['changed'] else None,
                       'revision': str(revision), 'period': command.data['period']}
            if album is not None:
                receipt['catalog_ref'] = album
            selected = result['state']['periods'].get(command.data['period'])
            receipt['cycle_id'] = selected['current']['cycle_id'] if selected else None
            connection.execute('''insert into app.listening_goal_operations
                (account_id,request_key,original_session_id,action,command_digest,receipt,committed_at)
                values(%s,%s,%s,%s,%s,%s::jsonb,%s)''',
                (account, command.request_key, live.actor.session_id, command.action,
                 command.digest, json.dumps(receipt), now))
            return receipt

    def read_operation(self, context, request_key, *, constraints=None):
        key = uuid_ref(request_key)
        with self._authorized(context, READ, constraints) as (connection, live, _):
            row = connection.execute('''select receipt from app.listening_goal_operations
                where account_id=%s and request_key=%s and original_session_id=%s''',
                (live.actor.account_id, key, live.actor.session_id)).fetchone()
            return {'status': 'committed', 'receipt': dict(row['receipt'])} if row else {'status': 'unknown'}

    def history(self, context, *, period, cursor_secret, cursor=None, limit=25, constraints=None):
        if period not in domain.GOAL_PERIODS or type(limit) is not int or not 1 <= limit <= 100:
            raise GoalsError('invalid_query', 400)
        with self._authorized(context, READ, constraints) as (connection, live, _):
            account = live.actor.account_id
            aggregate = connection.execute('select revision from app.listening_goals where account_id=%s',
                                           (account,)).fetchone()
            scope = ['goals-history-v1', account, live.actor.session_id, period,
                     str(aggregate['revision']) if aggregate else '1']
            try:
                after = decode_social_cursor(cursor, secret=cursor_secret, scope=scope)
            except ValueError:
                raise GoalsError('invalid_cursor', 400) from None
            cycles = connection.execute('''select * from app.listening_goal_cycles
                where account_id=%s and period=%s and closed_at is not null and position>%s
                order by position limit %s''', (account, period, after, limit + 1)).fetchall()
            records = []
            for cycle in cycles[:limit]:
                items = connection.execute('''select i.catalog_ref,i.manual_completed_at,a.title,a.artist_display,
                    a.first_release_date,a.primary_type from app.listening_goal_cycle_items i
                    join app.listening_goal_albums a on (a.account_id,a.goal_ref,a.catalog_ref)=
                        (i.account_id,i.goal_ref,i.catalog_ref)
                    where i.account_id=%s and i.cycle_id=%s order by i.position''',
                    (account, cycle['cycle_id'])).fetchall()
                records.append({'cycle_id': str(cycle['cycle_id']), 'period': period,
                    'started_at': _iso(cycle['started_at']), 'closed_at': _iso(cycle['closed_at']),
                    'start_date': cycle['start_date'].isoformat(), 'due_date': cycle['due_date'].isoformat(),
                    'timezone_name': cycle['timezone_name'], 'albums': [{
                        'catalog_ref': str(item['catalog_ref']), 'title': item['title'],
                        'artist_display': item['artist_display'], 'first_release_date': item['first_release_date'],
                        'primary_type': item['primary_type'], 'manual_completed_at':
                            _iso(item['manual_completed_at']) if item['manual_completed_at'] else None} for item in items]})
            return {'cycles': records, 'next_cursor': encode_social_cursor(
                cycles[limit - 1]['position'] if len(cycles) > limit else None, secret=cursor_secret, scope=scope)}
