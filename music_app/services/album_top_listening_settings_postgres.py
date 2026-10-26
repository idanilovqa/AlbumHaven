"""Session-checked account target storage, independent of library/Top membership."""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone

from music_app.services.admin_authority import lock_admin_accounts
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session, RecentAuthenticationRequired
from music_app.services.current_actor import ActorState
from music_app.services.policy import PolicyContext
from music_app.services.policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints
from music_app.services.postgres_connections import pooled_connection
from music_app.services.album_top_listening_settings import (
    ListeningSettingsError, ListeningSettingsCommand, MAX_REVISION, normalize_settings, project_settings,
)

READ = 'account.self.album_top_listening_settings.read'
WRITE = 'account.self.album_top_listening_settings.write'


class PostgresAlbumTopListeningSettings:
    def __init__(self, config, *, connect=None, clock=None):
        self._url = str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        if not self._url:
            raise RuntimeError('Postgres configuration is required for listening settings.')
        self._connect = connect or pooled_connection
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    @staticmethod
    def _require(context, action, constraints):
        if not isinstance(context, PolicyContext):
            raise ListeningSettingsError('forbidden', 403)
        actor = context.actor
        if not actor.is_authenticated or any(type(v) is not int or v <= 0 for v in (actor.account_id, actor.session_id)):
            raise ListeningSettingsError('forbidden', 403)
        target = replace(context, action=action, target_account_id=actor.account_id, library_id=None, resource=None)
        effective = constraints(target) if callable(constraints) else constraints
        if effective is not None and not isinstance(effective, PolicyEvaluationConstraints):
            raise RuntimeError('Invalid listening settings policy constraints.')
        if not PolicyEvaluator().evaluate(target, constraints=effective).decision.allowed:
            raise ListeningSettingsError('forbidden', 403)
        return target

    @contextmanager
    def _authorized(self, context, action, constraints):
        context = self._require(context, action, constraints)
        try:
            with self._connect(self._url) as connection:
                connection.execute('set transaction isolation level read committed')
                actor = context.actor
                # Same ordered lock as account revocation and Goals. Serializes
                # concurrent first saves as well as writes to an existing row.
                lock_admin_accounts(connection, actor.account_id, actor.account_id)
                row = connection.execute('select is_active,disabled_at from app.accounts where id=%s',
                                         (actor.account_id,)).fetchone()
                if row is None or row['is_active'] is not True or row['disabled_at'] is not None:
                    raise ListeningSettingsError('forbidden', 403)
                now = lock_current_actor_session(connection, actor_account_id=actor.account_id,
                    actor_session_id=actor.session_id, clock=self._clock)
                live = replace(context, actor=replace(actor, state=ActorState.ACTIVE, is_bootstrap_owner=False))
                self._require(live, action, constraints)
                yield connection, live.actor.account_id, now
                self._require(live, action, constraints)
                lock_current_actor_session(connection, actor_account_id=actor.account_id,
                    actor_session_id=actor.session_id, clock=self._clock)
        except RecentAuthenticationRequired:
            raise ListeningSettingsError('forbidden', 403) from None
        except ListeningSettingsError:
            raise
        except Exception as error:
            if getattr(error, 'sqlstate', None) in {'23505', '23503', '40001', '40P01'}:
                raise ListeningSettingsError('concurrent_change', 409) from None
            raise

    @staticmethod
    def _load(connection, account):
        return connection.execute('select completed_target,revision from app.album_top_listening_settings where account_id=%s',
                                  (account,)).fetchone()

    def read(self, context, *, constraints=None):
        with self._authorized(context, READ, constraints) as (connection, account, _):
            return project_settings(self._load(connection, account))

    def save(self, context, command, *, constraints=None):
        if not isinstance(command, ListeningSettingsCommand):
            raise ListeningSettingsError('invalid_command')
        command = normalize_settings(command.payload())
        with self._authorized(context, WRITE, constraints) as (connection, account, now):
            row = self._load(connection, account)
            before = project_settings(row)
            if before['settings_revision'] != command.settings_revision:
                raise ListeningSettingsError('settings_revision_conflict', 409)
            if row is not None and before['completed_target'] == command.completed_target:
                return before
            current = int(before['settings_revision'])
            if current == MAX_REVISION:
                raise ListeningSettingsError('revision_exhausted', 409)
            if row is None:
                connection.execute('''insert into app.album_top_listening_settings
                    (account_id,completed_target,revision,created_at,updated_at) values(%s,%s,%s,%s,%s)''',
                    (account, command.completed_target, current + 1, now, now))
            else:
                connection.execute('''update app.album_top_listening_settings
                    set completed_target=%s,revision=%s,updated_at=greatest(updated_at,%s) where account_id=%s''',
                    (command.completed_target, current + 1, now, account))
            return project_settings(self._load(connection, account))
