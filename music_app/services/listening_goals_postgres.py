"""Account-owned Goals; calendar transitions remain in listening_goals.

No library context, inventory identity, browser metadata or provider URLs are
admission authority. Provider IO happens outside the account transaction.
"""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
import secrets
from uuid import uuid4

from music_app.services import listening_goals as domain
from music_app.services.listening_goal_bonus_settings import (
    BonusSettingsCommand, normalize_bonus_settings, project_bonus_settings,
)
from music_app.services.listening_goal_bonus import BonusDrawCommand, normalize_bonus_draw
from music_app.services import listening_goal_bonus_postgres as bonus
from music_app.services import listening_goal_weekly_postgres as weekly_settings_store
from music_app.services.listening_goal_completion_postgres import propagate_goal_completion
from music_app.services import listening_goal_weekly_draw as weekly_draw
from music_app.services import listening_goal_rating_progress as rating_progress
from music_app.services.listening_goal_membership_sources import sync_sources
from music_app.services.listening_goal_transition import (
    GoalTransitionCommand, normalize_goal_transition, transition_goal_period,
)
from music_app.services.listening_goal_attention import (
    ACTION as ATTENTION_ACTION, GoalAttentionCommand, normalize_goal_attention, project_goal_attention,
)
from music_app.services.admin_authority import lock_admin_accounts
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session, RecentAuthenticationRequired
from music_app.services.current_actor import ActorState
from music_app.services.listening_goals_commands import GoalsError, normalize_goal_command, uuid_ref
from music_app.services.policy import PolicyContext
from music_app.services.policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints
from music_app.services.postgres_connections import pooled_connection
from music_app.services.remote_album_provider import fetch_release_group_evidence
from music_app.services.remote_album_search import (
    SEARCH_LIMIT, normalize_album_search, search_release_group_candidates,
)
from music_app.services.remote_album_evidence import canonical_release_group_id, RemoteAlbumEvidenceError, ReleaseGroupEvidence, validate_release_group_evidence
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
    def __init__(self, config, *, connect=None, clock=None, provider=None, user_agent=None, searcher=None, bonus_randbelow=None):
        self._url = str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        if not self._url:
            raise RuntimeError('Postgres configuration is required for Goals.')
        self._connect = connect or pooled_connection
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._provider = provider or fetch_release_group_evidence
        self._searcher = searcher or search_release_group_candidates
        self._bonus_randbelow = bonus_randbelow or secrets.randbelow
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

    @staticmethod
    def _attention(connection, account, now):
        aggregate = connection.execute('select ref,revision from app.listening_goals where account_id=%s',
                                       (account,)).fetchone()
        # The partial current-cycle index bounds this projection to four cycles.
        # Retained item counts never hydrate archived cycles or catalog metadata.
        ratings = rating_progress.storage_ready(connection)
        rating_join = "left join app.listening_goal_rating_progress rp on rp.account_id=i.account_id and rp.goal_ref=i.goal_ref and rp.cycle_id=i.cycle_id and rp.catalog_ref=i.catalog_ref and rp.membership_position=i.position" if ratings else ""
        completed = "coalesce(i.manual_completed_at,rp.rated_at)" if ratings else "i.manual_completed_at"
        rows = connection.execute(f"""select c.goal_ref,c.period,c.cycle_id,c.start_date,c.due_date,c.timezone_name,
            count(i.catalog_ref)::bigint as total,
            count({completed})::bigint as completed,
            exists(select 1 from app.listening_goal_attention_acknowledgments a
                where a.account_id=c.account_id and a.goal_ref=c.goal_ref and a.cycle_id=c.cycle_id
                  and a.kind='weekly_cycle_started') as acknowledged
            from app.listening_goal_cycles c
            left join app.listening_goal_cycle_items i on i.account_id=c.account_id
                and i.goal_ref=c.goal_ref and i.cycle_id=c.cycle_id and i.removed_at is null
            {rating_join}
            where c.account_id=%s and c.closed_at is null
            group by c.account_id,c.goal_ref,c.period,c.cycle_id,c.start_date,c.due_date,c.timezone_name
            order by c.period""", (account,)).fetchall()
        return project_goal_attention(aggregate, rows, now)

    def read_attention(self, context, *, constraints=None):
        with self._authorized(context, READ, constraints) as (connection, live, now):
            return self._attention(connection, live.actor.account_id, now)

    def acknowledge_attention(self, context, command, *, constraints=None):
        if not isinstance(command, GoalAttentionCommand):
            raise GoalsError('invalid_command')
        command = normalize_goal_attention(command.payload())
        with self._authorized(context, WRITE, constraints) as (connection, live, now):
            account = live.actor.account_id
            prior = bonus.replay(connection, account, live.actor.session_id, command)
            if prior is not None:
                return prior
            attention = self._attention(connection, account, now)
            if attention['weekly_event'] != command.event():
                raise GoalsError('attention_event_changed', 409)
            changed = not attention['weekly_acknowledged']
            if changed:
                connection.execute("""insert into app.listening_goal_attention_acknowledgments
                    (account_id,goal_ref,cycle_id,kind,acknowledged_at)
                    values(%s,%s,%s,'weekly_cycle_started',%s)""",
                    (account, command.goal_ref, command.cycle_id, now))
            receipt = {'ok': True, 'action': ATTENTION_ACTION, 'request_key': command.request_key,
                       'event': command.event(), 'changed': changed}
            connection.execute("""insert into app.listening_goal_operations
                (account_id,request_key,original_session_id,action,command_digest,receipt,committed_at)
                values(%s,%s,%s,%s,%s,%s::jsonb,%s)""",
                (account, command.request_key, live.actor.session_id, ATTENTION_ACTION,
                 command.digest, json.dumps(receipt), now))
            return receipt

    def transition(self, context, command, *, constraints=None):
        if not isinstance(command, GoalTransitionCommand):
            raise GoalsError('invalid_command')
        command = normalize_goal_transition(command.payload())
        with self._weekly_schema(), self._authorized(context, WRITE, constraints) as (connection, live, now):
            account = live.actor.account_id
            prior = bonus.replay(connection, account, live.actor.session_id, command)
            if prior is not None:
                return prior
            aggregate, before, _ = self._load(connection, account)
            revision = aggregate['revision'] if aggregate else 1
            if str(revision) != command.revision:
                raise GoalsError('revision_conflict', 409)
            settings = project_bonus_settings(connection.execute(
                'select * from app.listening_goal_bonus_settings where account_id=%s', (account,)).fetchone())
            if settings['settings_revision'] != command.settings_revision:
                raise GoalsError('settings_revision_conflict', 409)
            if command.period not in before['periods']:
                raise GoalsError('period_not_started', 409)
            if revision == BIGINT_MAX:
                raise GoalsError('revision_exhausted', 409)
            # Captured draw provenance, not album admission kind or client hints:
            # a MusicBrainz-admitted album may later have been a real bonus.
            selected_members = before['periods'][command.period]['current']['album_refs']
            origins = frozenset(str(row['catalog_ref']) for row in connection.execute(
                '''select distinct catalog_ref from app.listening_goal_bonus_draws
                    where account_id=%s and catalog_ref=any(%s::uuid[])''',
                (account,selected_members)).fetchall())
            captured = bonus.cycle_bonus(connection, account, before) if command.period == 'week' else None
            captured_ref = (str(captured['catalog_ref']) if captured
                and str(captured['catalog_ref']) in selected_members else None)
            weekly_captured = weekly_draw.cycle_draws(connection, account, command.expected_cycle_id) if command.period == 'week' else []
            rated_refs = frozenset(str(row['catalog_ref']) for row in connection.execute(
                '''select rp.catalog_ref from app.listening_goal_rating_progress rp
                    join app.listening_goal_cycle_items rs on rs.account_id=rp.account_id and rs.cycle_id=rp.cycle_id
                        and rs.catalog_ref=rp.catalog_ref and rs.position=rp.membership_position and rs.removed_at is null
                    where rp.account_id=%s and rp.cycle_id=%s''', (account, command.expected_cycle_id)).fetchall())
            origins = origins | frozenset(str(row['catalog_ref']) for row in weekly_captured)
            new_cycle = str(uuid4())
            after = transition_goal_period(before, period=command.period,
                expected_cycle_id=command.expected_cycle_id, new_cycle_id=new_cycle, occurred_at=now,
                timezone_name=command.timezone_name, viewer_ref=str(account), bonus_origin_refs=origins,
                captured_bonus_ref=captured_ref, unfinished_policy=settings['unfinished_policy'],
                rated_refs=rated_refs.intersection(selected_members))
            revision += 1
            self._persist(connection, account, before, after, evidence=None, now=now,
                          revision=revision, exists=True)
            members = after['periods'][command.period]['current']['album_refs']
            carried_bonus = command.period == 'week' and captured_ref in members
            if carried_bonus:
                connection.execute('''insert into app.listening_goal_bonus_draws
                    (account_id,goal_ref,cycle_id,catalog_ref,admission_ref,captured_at)
                    values(%s,%s,%s,%s,%s,%s)''',
                    (account,after['top_ref'],new_cycle,captured_ref,captured['admission_ref'],now))
            carried_weekly = [row for row in weekly_captured if str(row['catalog_ref']) in members]
            for slot, row in enumerate(carried_weekly):
                connection.execute('''insert into app.listening_goal_weekly_draws
                    (account_id,goal_ref,cycle_id,slot,catalog_ref,admission_ref,objective,allocation_cursor_used,captured_at)
                    select account_id,goal_ref,%s,%s,catalog_ref,admission_ref,objective,allocation_cursor_used,%s
                    from app.listening_goal_weekly_draws where account_id=%s and cycle_id=%s and slot=%s''',
                    (new_cycle,slot,now,account,command.expected_cycle_id,row['slot']))
            # Rollover archives marks; it is not an explicit Clear and must not
            # reset completed-source eligibility or mutate any other period.
            receipt = {'ok':True,'action':'transition','request_key':command.request_key,
                'changed':True,'reason':'','goal_ref':after['top_ref'],'revision':str(revision),
                'period':command.period,'previous_cycle_id':command.expected_cycle_id,
                'cycle_id':new_cycle,'settings_revision':command.settings_revision,
                'retained_count':len(members),'bonus_carried':carried_bonus}
            if command.period == 'week':
                receipt['manual_count'] = len(members) - int(carried_bonus) - len(carried_weekly)
                receipt['manual_limit'] = weekly_settings_store.read_settings(connection, account)['settings']['manual_count']
                receipt['weekly_suggestions_carried'] = len(carried_weekly)
                receipt['manual_slots_available'] = max(0, receipt['manual_limit'] - receipt['manual_count'])
                receipt['bonus_slot_available'] = not carried_bonus
            connection.execute('''insert into app.listening_goal_operations
                (account_id,request_key,original_session_id,action,command_digest,receipt,committed_at)
                values(%s,%s,%s,'transition',%s,%s::jsonb,%s)''',
                (account,command.request_key,live.actor.session_id,command.digest,json.dumps(receipt),now))
            return receipt

    def read_current_bonus(self, context, *, constraints=None):
        with self._authorized(context, READ, constraints) as (connection, live, _):
            _, state, _ = self._load(connection, live.actor.account_id)
            week = state['periods'].get('week')
            captured = bonus.cycle_bonus(connection, live.actor.account_id, state)
            ref = str(captured['catalog_ref']) if captured else None
            members = week['current']['album_refs'] if week else []
            return {'cycle_id': week['current']['cycle_id'] if week else None,
                    'bonus': {'catalog_ref': ref, 'present': ref in members} if captured else None,
                    'manual_count': len(members) - int(ref in members)}

    def draw_bonus(self, context, command, *, constraints=None):
        if not isinstance(command, BonusDrawCommand):
            raise GoalsError('invalid_command')
        command = normalize_bonus_draw(command.payload())
        # Receipt recovery is account-owned and survives loss of source library.
        # Close this transaction BEFORE opening the live-source transaction.
        with self._authorized(context, WRITE, constraints) as (connection, live, _):
            prior = bonus.replay(connection, live.actor.account_id, live.actor.session_id, command)
            if prior is not None:
                return prior
        with self._weekly_schema():
            return bonus.draw(self, context, command, constraints=constraints)

    @staticmethod
    @contextmanager
    def _weekly_schema():
        try:
            yield
        except Exception as error:
            if getattr(error, 'sqlstate', None) in {'42P01', '42703'}:
                raise GoalsError('weekly_settings_schema_unavailable', 503) from None
            raise

    def read_weekly_settings(self, context, *, constraints=None):
        # Account settings survive missing current-library access. Source options
        # remain unavailable rather than using cached authority or browser facts.
        with self._weekly_schema():
            with self._authorized(context, READ, constraints) as (connection, live, _):
                value = weekly_settings_store.read_settings(connection, live.actor.account_id)
            value.pop('allocation_cursor')
            value.update(genres=[], playthroughs=[])
            if context.actor.current_library_id is not None:
                try:
                    snapshot = weekly_settings_store.source_snapshot(self, context, constraints=constraints)
                    value.update(genres=snapshot['genres'], playthroughs=snapshot['playthroughs'])
                except GoalsError as error:
                    if error.code != 'source_context_unavailable':
                        raise
                    value['source_status'] = 'unavailable'
            return value

    def save_weekly_settings(self, context, command, *, constraints=None):
        with self._weekly_schema():
            return weekly_settings_store.save_settings(self, context, command, constraints=constraints)

    def draw_weekly_suggestions(self, context, command, *, constraints=None):
        with self._weekly_schema():
            return weekly_draw.draw(self, context, command, constraints=constraints)

    def preview_weekly_settings(self, context, settings, *, constraints=None):
        with self._weekly_schema():
            return weekly_settings_store.source_snapshot(self, context, settings=settings, constraints=constraints)

    def read_bonus_settings(self, context, *, constraints=None):
        with self._authorized(context, READ, constraints) as (connection, live, _):
            row = connection.execute('select * from app.listening_goal_bonus_settings where account_id=%s',
                                     (live.actor.account_id,)).fetchone()
            return project_bonus_settings(row)

    def save_bonus_settings(self, context, command, *, constraints=None):
        if not isinstance(command, BonusSettingsCommand):
            raise GoalsError('invalid_command')
        command = normalize_bonus_settings(command.payload())
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
            row = connection.execute('select * from app.listening_goal_bonus_settings where account_id=%s',
                                     (account,)).fetchone()
            before = project_bonus_settings(row)
            if before['settings_revision'] != command.settings_revision:
                raise GoalsError('settings_revision_conflict', 409)
            values = command.values()
            changed = any(before[key] != value for key, value in values.items())
            if changed:
                current = int(before['settings_revision'])
                if current == BIGINT_MAX:
                    raise GoalsError('revision_exhausted', 409)
                params = (current + 1, command.enabled, command.source_mode,
                          list(command.selected_top_refs), list(command.preferred_top_refs),
                          command.album_mode, command.unfinished_policy, now)
                if row is None:
                    connection.execute('''insert into app.listening_goal_bonus_settings
                        (account_id,revision,enabled,source_mode,selected_top_refs,preferred_top_refs,
                         album_mode,unfinished_policy,updated_at,created_at)
                        values(%s,%s,%s,%s,%s::uuid[],%s::uuid[],%s,%s,%s,%s)''',
                        (account, *params, now))
                else:
                    connection.execute('''update app.listening_goal_bonus_settings set
                        revision=%s,enabled=%s,source_mode=%s,selected_top_refs=%s::uuid[],
                        preferred_top_refs=%s::uuid[],album_mode=%s,unfinished_policy=%s,updated_at=%s
                        where account_id=%s''', (*params, account))
            after = connection.execute('select * from app.listening_goal_bonus_settings where account_id=%s',
                                       (account,)).fetchone()
            receipt = {'ok': True, 'action': 'bonus_settings', 'request_key': command.request_key,
                       'changed': changed, 'settings': project_bonus_settings(after)}
            connection.execute('''insert into app.listening_goal_operations
                (account_id,request_key,original_session_id,action,command_digest,receipt,committed_at)
                values(%s,%s,%s,'bonus_settings',%s,%s::jsonb,%s)''',
                (account, command.request_key, live.actor.session_id, command.digest, json.dumps(receipt), now))
            return receipt

    def search_candidates(self, context, title, artist, *, constraints=None, should_cancel=None):
        try:
            title, artist = normalize_album_search(title, artist)
        except RemoteAlbumEvidenceError as error:
            raise GoalsError(error.code, 400) from None
        with self._authorized(context, WRITE, constraints, should_cancel=should_cancel):
            pass
        try:
            candidates = self._searcher(title, artist, user_agent=self._user_agent,
                                       should_cancel=should_cancel)
        except RemoteAlbumEvidenceError as error:
            raise GoalsError(error.code, 503) from None
        if (type(candidates) is not tuple or len(candidates) > SEARCH_LIMIT
                or any(not isinstance(item, ReleaseGroupEvidence) for item in candidates)):
            raise GoalsError('invalid_provider_metadata', 503)
        # Network never holds account/session locks. Reauthorize after IO before
        # returning private preview data; search creates no durable evidence.
        with self._authorized(context, WRITE, constraints, should_cancel=should_cancel):
            return {'limit': SEARCH_LIMIT, 'candidates': [{
                'provider': 'musicbrainz', 'entity_kind': 'release-group',
                'release_group_id': item.release_group_id, 'title': item.title,
                'artist_display': item.artist_display, 'first_release_date': item.first_release_date,
                'primary_type': item.primary_type} for item in candidates]}

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
        try:
            validate_release_group_evidence(facts)
        except RemoteAlbumEvidenceError:
            raise GoalsError('invalid_provider_metadata', 503) from None
        if facts.release_group_id != ref:
            raise GoalsError('invalid_provider_metadata', 503)
        # Goals retains the v1 scalar projection, not credited artist identities.
        # Validate the complete provider evidence first, then bind the receipt to
        # exactly the facts that this repository stores and revalidates on add.
        evidence_version = _facts_version({
            'external_id': facts.release_group_id, 'title': facts.title,
            'artist_display': facts.artist_display,
            'first_release_date': facts.first_release_date, 'primary_type': facts.primary_type,
        })
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
                (evidence_ref, account, live.actor.session_id, facts.release_group_id, evidence_version,
                 facts.title, facts.artist_display, facts.first_release_date, facts.primary_type,
                 now, now + EVIDENCE_LIFETIME))
            if should_cancel is not None and should_cancel():
                raise GoalsError('provider_cancelled', 503)
            return {'evidence_ref': evidence_ref, 'evidence_version': evidence_version,
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
            order by current_position nulls last,original_position''', (account,)).fetchall()
        albums = [row for row in albums if row['current_position'] is not None]
        state['album_refs'] = [str(row['catalog_ref']) for row in albums]
        rows = connection.execute('''select * from app.listening_goal_assignments where account_id=%s and removed_at is null
            order by position''', (account,)).fetchall()
        state['assignments'] = [{'assignment_id': str(row['assignment_id']), 'album_ref': str(row['catalog_ref']),
            'period': row['period'], 'assigned_at': _iso(row['assigned_at'])} for row in rows]
        cycles = connection.execute('''select * from app.listening_goal_cycles where account_id=%s
            order by period,position''', (account,)).fetchall()
        items = connection.execute('''select * from app.listening_goal_cycle_items where account_id=%s and removed_at is null
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
            completion_modes = rating_progress.overlay(connection, live, periods, albums, constraints=constraints)
            if aggregate is None:
                for value in periods.values():
                    value['top_ref'] = None
            return {'goal_ref': str(aggregate['ref']) if aggregate else None,
                    'revision': str(aggregate['revision']) if aggregate else '1',
                    'periods': periods,
                    'allowed_actions': {'can_read': True, 'can_add': can_write, 'can_reset': can_write,
                                        'can_complete': can_write, 'can_remove': can_write},
                    'albums': [{'catalog_ref': str(row['catalog_ref']), 'title': row['title'],
                        'artist_display': row['artist_display'], 'first_release_date': row['first_release_date'],
                        'primary_type': row['primary_type'],
                        'completion_mode': completion_modes.get(str(row['catalog_ref']), 'manual')} for row in albums]}

    @staticmethod
    def _catalog(connection, evidence):
        from music_app.services.remote_album_catalog import (
            RemoteCatalogIdentityConflict, map_release_group_catalog,
        )
        try:
            return map_release_group_catalog(connection, evidence)
        except RemoteCatalogIdentityConflict:
            raise GoalsError('identity_conflict', 409) from None

    @staticmethod
    def _persist(connection, account, before, after, *, evidence, now, revision, exists, top_admission=None, weekly_admissions=()):
        ref = after['top_ref']
        if any(not isinstance(item, weekly_draw.WeeklyAdmission) for item in weekly_admissions):
            raise RuntimeError('Invalid typed weekly admissions.')
        admission_by_ref = {item.catalog_ref: item for item in weekly_admissions}
        if len(admission_by_ref) != len(weekly_admissions):
            raise RuntimeError('Duplicate weekly admission.')
        if not exists:
            connection.execute('''insert into app.listening_goals(account_id,ref,revision,created_at,updated_at)
                values(%s,%s,%s,%s,%s)''', (account, ref, revision, now, now))
        else:
            connection.execute('''update app.listening_goals set revision=%s,updated_at=%s
                where account_id=%s''', (revision, now, account))
        retained = connection.execute('''select catalog_ref,original_position,current_position
            from app.listening_goal_albums where account_id=%s and goal_ref=%s''', (account, ref)).fetchall()
        by_album = {str(row['catalog_ref']): row for row in retained}
        original_position = max((row['original_position'] for row in retained), default=0)
        current_position = max((row['current_position'] or 0 for row in retained), default=0)
        previous_albums = set(before['album_refs'])
        for album in previous_albums - set(after['album_refs']):
            connection.execute('''update app.listening_goal_albums set current_position=null
                where account_id=%s and goal_ref=%s and catalog_ref=%s''', (account, ref, album))
        for album in after['album_refs']:
            if album in previous_albums:
                continue
            current_position += 1
            if current_position > BIGINT_MAX:
                raise GoalsError('order_exhausted', 409)
            if album in by_album:
                if by_album[album]['current_position'] is not None:
                    raise RuntimeError('Retained Goal active order is inconsistent.')
                connection.execute('''update app.listening_goal_albums set current_position=%s
                    where account_id=%s and goal_ref=%s and catalog_ref=%s''',
                    (current_position, account, ref, album))
                continue
            weekly_admission = admission_by_ref.get(album)
            admission = weekly_admission or top_admission
            if weekly_admission is not None and (not isinstance(weekly_admission, weekly_draw.WeeklyAdmission)
                    or weekly_admission.catalog_ref != album or top_admission is not None or evidence is not None):
                raise RuntimeError('Invalid typed weekly admission.')
            if evidence is None and admission is None:
                raise RuntimeError('Goal album admission evidence is missing.')
            if top_admission is not None and (not isinstance(top_admission, bonus.TopAdmission)
                    or top_admission.catalog_ref != album or evidence is not None):
                raise RuntimeError('Invalid typed Top admission.')
            original_position += 1
            if original_position > BIGINT_MAX:
                raise GoalsError('order_exhausted', 409)
            connection.execute('''insert into app.listening_goal_albums
                (account_id,goal_ref,catalog_ref,original_position,current_position,title,artist_display,
                 first_release_date,primary_type,evidence_ref,evidence_version,admitted_at,admission_kind,top_admission_ref,weekly_admission_ref)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (account, ref, album, original_position, current_position,
                 admission.title if admission else evidence['title'],
                 admission.artist_display if admission else evidence['artist_display'],
                 admission.first_release_date if admission else evidence['first_release_date'],
                 admission.primary_type if admission else evidence['primary_type'],
                 None if admission else evidence['ref'], None if admission else evidence['evidence_version'], now,
                 'weekly' if weekly_admission else ('album_top' if top_admission else 'musicbrainz'),
                 top_admission.ref if top_admission else None, weekly_admission.ref if weekly_admission else None))
        previous_assignments = {row['assignment_id'] for row in before['assignments']}
        next_assignments = {row['assignment_id'] for row in after['assignments']}
        for assignment in previous_assignments - next_assignments:
            connection.execute('''update app.listening_goal_assignments set removed_at=%s
                where account_id=%s and goal_ref=%s and assignment_id=%s and removed_at is null''',
                (now, account, ref, assignment))
        assignment_position = connection.execute('''select coalesce(max(position),0) as position
            from app.listening_goal_assignments where account_id=%s and goal_ref=%s''',
            (account, ref)).fetchone()['position']
        for row in after['assignments']:
            if row['assignment_id'] not in previous_assignments:
                assignment_position += 1
                if assignment_position > BIGINT_MAX:
                    raise GoalsError('order_exhausted', 409)
                connection.execute('''insert into app.listening_goal_assignments
                    (assignment_id,account_id,goal_ref,catalog_ref,period,assigned_at,position)
                    values(%s,%s,%s,%s,%s,%s,%s)''', (row['assignment_id'], account, ref,
                        row['album_ref'], row['period'], row['assigned_at'], assignment_position))
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
                # Closed-cycle rows are immutable. Domain transitions may close
                # the former current cycle but never edit its members or marks.
                if 'closed_at' in cycle:
                    continue
                old_members = set(prior['album_refs']) if prior else set()
                members = set(cycle['album_refs'])
                for album in old_members - members:
                    connection.execute('''update app.listening_goal_cycle_items
                        set removed_at=%s,manual_completed_at=null
                        where account_id=%s and goal_ref=%s and cycle_id=%s and catalog_ref=%s
                          and removed_at is null''', (now, account, ref, cycle['cycle_id'], album))
                stored = connection.execute('''select catalog_ref,position,removed_at
                    from app.listening_goal_cycle_items
                    where account_id=%s and goal_ref=%s and cycle_id=%s''',
                    (account, ref, cycle['cycle_id'])).fetchall()
                by_member = {str(row['catalog_ref']): row for row in stored}
                member_position = max((row['position'] for row in stored), default=0)
                marks = cycle['completion'].get(str(account), {})
                old_marks = prior['completion'].get(str(account), {}) if prior else {}
                for album in cycle['album_refs']:
                    if album not in old_members:
                        member_position += 1
                        if member_position > BIGINT_MAX:
                            raise GoalsError('order_exhausted', 409)
                        if album in by_member:
                            if by_member[album]['removed_at'] is None:
                                raise RuntimeError('Retained Goal membership is inconsistent.')
                            connection.execute('''update app.listening_goal_cycle_items
                                set removed_at=null,position=%s,manual_completed_at=%s
                                where account_id=%s and goal_ref=%s and cycle_id=%s and catalog_ref=%s''',
                                (member_position, marks.get(album), account, ref, cycle['cycle_id'], album))
                        else:
                            connection.execute('''insert into app.listening_goal_cycle_items
                                (account_id,goal_ref,cycle_id,catalog_ref,position,manual_completed_at)
                                values(%s,%s,%s,%s,%s,%s)''',
                                (account, ref, cycle['cycle_id'], album, member_position, marks.get(album)))
                    elif marks.get(album) != old_marks.get(album):
                        connection.execute('''update app.listening_goal_cycle_items set manual_completed_at=%s
                            where account_id=%s and goal_ref=%s and cycle_id=%s and catalog_ref=%s
                              and removed_at is null''',
                            (marks.get(album), account, ref, cycle['cycle_id'], album))

        sync_sources(connection, account, before, after, weekly_admissions)

    def execute(self, context, command, *, constraints=None):
        # Revalidate a command at the write boundary; construction alone is not
        # authority and no caller-owned mutable object survives into the lock.
        command = normalize_goal_command(command.action, {**command.data, 'request_key': command.request_key})
        with self._weekly_schema(), self._authorized(context, WRITE, constraints) as (connection, live, now):
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
                captured_bonus = bonus.cycle_bonus(connection, account, before)
                bonus_ref = str(captured_bonus['catalog_ref']) if captured_bonus else None
                if command.data['period'] == 'week' and not duplicate and album != bonus_ref:
                    drawn_refs = {str(row['catalog_ref']) for row in weekly_draw.cycle_draws(
                        connection, account, weekly['current']['cycle_id'] if weekly else None)}
                    current_refs = [ref for ref in weekly['current']['album_refs']
                        if ref != bonus_ref and ref not in drawn_refs] if weekly else []
                    if weekly is not None and len(weekly['current']['album_refs']) >= 7:
                        raise GoalsError('weekly_capacity', 409)
                    with self._weekly_schema():
                        weekly_settings_store.require_manual_admission(connection, account, current_refs, album,
                            context=live, constraints=constraints, now=now)
                selected_period = before['periods'].get(command.data['period'])
                if (album == bonus_ref and selected_period is not None
                        and album in selected_period['current']['album_refs']):
                    # A captured bonus already present in the selection is not
                    # silently converted to another direct/manual assignment.
                    result = {'state': before, 'changed': False, 'reason': 'already_added'}
                else:
                    result = domain.add_goal(before, album_ref=album, period=command.data['period'],
                        assignment_id=str(uuid4()), occurred_at=now, timezone_name=command.data['timezone_name'],
                        cycle_ids={name: str(uuid4()) for name in domain.GOAL_PERIODS[
                            domain.GOAL_PERIODS.index(command.data['period']):]})
            elif command.action == 'reset':
                result = domain.reset_goal_period(before, period=command.data['period'],
                    expected_cycle_id=command.data['expected_cycle_id'], new_cycle_id=str(uuid4()),
                    occurred_at=now, timezone_name=command.data['timezone_name'])
            elif command.action == 'completion':
                album = command.data['catalog_ref']
                if command.data['completed'] and rating_progress.requires_rating(connection, live, album, command.data['expected_cycle_id'], constraints=constraints):
                    raise GoalsError('library_goal_rating_required', 409)
                result = domain.set_goal_completion(before, period=command.data['period'],
                    expected_cycle_id=command.data['expected_cycle_id'], album_ref=album,
                    viewer_ref=str(account), completed=command.data['completed'], occurred_at=now)
            elif command.action == 'remove':
                album = command.data['catalog_ref']
                result = domain.remove_goal_album(before, period=command.data['period'],
                    expected_cycle_id=command.data['expected_cycle_id'], album_ref=album)
            else:
                raise GoalsError('invalid_command', 400)
            propagated = []
            if command.action == 'completion' and command.data['completed'] and result['changed']:
                propagated = propagate_goal_completion(connection, live, album, command.request_key,
                    now, constraints=constraints)
            if result['changed']:
                if revision == BIGINT_MAX:
                    raise GoalsError('revision_exhausted', 409)
                revision += 1
                self._persist(connection, account, before, result['state'], evidence=evidence,
                              now=now, revision=revision, exists=aggregate is not None)
            bonus.sync_after_command(connection, account, before, result['state'], command, now)
            if command.action == 'reset' and command.data['period'] == 'week':
                weekly_draw.retain_after_reset(connection, account, before, result['state'], now)
            receipt = {'ok': True, 'action': command.action, 'request_key': command.request_key,
                       'changed': result['changed'], 'reason': result['reason'],
                       'goal_ref': result['state']['top_ref'] if aggregate or result['changed'] else None,
                       'revision': str(revision), 'period': command.data['period']}
            if propagated:
                receipt['top_completions'] = propagated
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
            ratings = rating_progress.storage_ready(connection)
            for cycle in cycles[:limit]:
                items = connection.execute('''select i.catalog_ref,i.manual_completed_at,a.title,a.artist_display,
                    a.first_release_date,a.primary_type from app.listening_goal_cycle_items i
                    join app.listening_goal_albums a on (a.account_id,a.goal_ref,a.catalog_ref)=
                        (i.account_id,i.goal_ref,i.catalog_ref)
                    where i.account_id=%s and i.cycle_id=%s and i.removed_at is null order by i.position''',
                    (account, cycle['cycle_id'])).fetchall()
                rated_rows = connection.execute('''select rp.catalog_ref,rp.rated_at from app.listening_goal_rating_progress rp
                    join app.listening_goal_cycle_items rs on rs.account_id=rp.account_id and rs.cycle_id=rp.cycle_id
                        and rs.catalog_ref=rp.catalog_ref and rs.position=rp.membership_position and rs.removed_at is null
                    where rp.account_id=%s and rp.cycle_id=%s''',(account,cycle['cycle_id'])).fetchall() if ratings else []
                rated = {str(row['catalog_ref']):_iso(row['rated_at']) for row in rated_rows}
                records.append({'cycle_id': str(cycle['cycle_id']), 'period': period,
                    'started_at': _iso(cycle['started_at']), 'closed_at': _iso(cycle['closed_at']),
                    'start_date': cycle['start_date'].isoformat(), 'due_date': cycle['due_date'].isoformat(),
                    'timezone_name': cycle['timezone_name'], 'albums': [{
                        'catalog_ref': str(item['catalog_ref']), 'title': item['title'],
                        'artist_display': item['artist_display'], 'first_release_date': item['first_release_date'],
                        'primary_type': item['primary_type'], 'manual_completed_at':
                            _iso(item['manual_completed_at']) if item['manual_completed_at'] else None,
                        'rated_at': rated.get(str(item['catalog_ref']))} for item in items]})
            return {'cycles': records, 'next_cursor': encode_social_cursor(
                cycles[limit - 1]['position'] if len(cycles) > limit else None, secret=cursor_secret, scope=scope)}
