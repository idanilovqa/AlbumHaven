"""Account-owned Playlist order memory; repeat state stays with the live queue."""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
import json

from music_app.services.admin_authority import lock_admin_accounts
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session, RecentAuthenticationRequired
from music_app.services.current_actor import ActorState
from music_app.services.owned_playlists import PlaylistCommand, PlaylistError, uuid_ref, playlist_revision
from music_app.services.policy import PolicyContext
from music_app.services.policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints
from music_app.services.postgres_connections import pooled_connection

PREFERENCE_READ="account.self.playlist_preferences.read"
PREFERENCE_WRITE="account.self.playlist_preferences.write"


def normalize_preference_command(payload):
    fields={"remember_order_mode","last_order_mode"}
    if not isinstance(payload,dict) or set(payload)-fields-{"revision","request_key"} or not fields.intersection(payload):
        raise PlaylistError("invalid_command")
    key=uuid_ref(payload.get("request_key"))
    data={"revision":playlist_revision(payload.get("revision"))}
    if "remember_order_mode" in payload:
        if type(payload["remember_order_mode"]) is not bool:
            raise PlaylistError("invalid_command")
        data["remember_order_mode"]=payload["remember_order_mode"]
    if "last_order_mode" in payload:
        if payload["last_order_mode"] not in ("regular","shuffle"):
            raise PlaylistError("invalid_command")
        data["last_order_mode"]=payload["last_order_mode"]
    return PlaylistCommand("playlist_preferences",None,key,data)


def preference_projection(row):
    remember=row["remember_order_mode"] if row else True
    mode=row["last_order_mode"] if row else "regular"
    return {"remember_order_mode":remember,"last_order_mode":mode,
            "effective_order_mode":mode if remember else "regular",
            "revision":str(row["revision"]) if row else "1"}


class PostgresPlaylistPreferencesService:
    def __init__(self,config,*,connect=None,clock=None):
        self._url=str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        if not self._url:
            raise RuntimeError("Postgres configuration is required for Playlist preferences.")
        self._connect=connect or pooled_connection
        self._clock=clock or (lambda:datetime.now(timezone.utc))

    @staticmethod
    def _require(context,action,constraints):
        if not isinstance(context,PolicyContext):
            raise PlaylistError("forbidden",403)
        actor=context.actor
        if not actor.is_authenticated or any(type(value) is not int or value<=0 for value in (actor.account_id,actor.session_id)):
            raise PlaylistError("forbidden",403)
        target=replace(context,action=action,target_account_id=actor.account_id,library_id=None,resource=None)
        effective=constraints(target) if callable(constraints) else constraints
        if effective is not None and not isinstance(effective,PolicyEvaluationConstraints):
            raise RuntimeError("Playlist preference constraints are invalid.")
        if not PolicyEvaluator().evaluate(target,constraints=effective).decision.allowed:
            raise PlaylistError("forbidden",403)
        return target

    @contextmanager
    def _authorized(self,context,action,constraints):
        context=self._require(context,action,constraints)
        try:
            with self._connect(self._url) as connection:
                connection.execute("set transaction isolation level read committed")
                actor=context.actor
                lock_admin_accounts(connection,actor.account_id,actor.account_id)
                row=connection.execute("select is_active,disabled_at from app.accounts where id=%s",(actor.account_id,)).fetchone()
                if row is None or row["is_active"] is not True or row["disabled_at"] is not None:
                    raise PlaylistError("forbidden",403)
                lock_current_actor_session(connection,actor_account_id=actor.account_id,actor_session_id=actor.session_id,clock=self._clock)
                live=replace(context,actor=replace(actor,state=ActorState.ACTIVE,is_bootstrap_owner=False))
                self._require(live,action,constraints)
                yield connection,live
                # Reads and no-ops are checked as carefully as changed writes.
                lock_current_actor_session(connection,actor_account_id=actor.account_id,actor_session_id=actor.session_id,clock=self._clock)
        except RecentAuthenticationRequired:
            raise PlaylistError("forbidden",403) from None
        except PlaylistError:
            raise
        except Exception as error:
            if getattr(error,"sqlstate",None) in {"23505","23503","40001","40P01"}:
                raise PlaylistError("concurrent_change",409) from None
            raise

    @staticmethod
    def _read(connection,account_id):
        return connection.execute("""select remember_order_mode,last_order_mode,revision
            from app.user_playlist_playback_preferences where account_id=%s""",(account_id,)).fetchone()

    def read(self,context,*,constraints=None):
        with self._authorized(context,PREFERENCE_READ,constraints) as (connection,live):
            return {"preferences":preference_projection(self._read(connection,live.actor.account_id))}

    def execute(self,context,command,*,constraints=None):
        if not isinstance(command,PlaylistCommand) or not isinstance(command.data,dict) or command.action!="playlist_preferences" or command.playlist_ref is not None:
            raise PlaylistError("invalid_command")
        command=normalize_preference_command({**command.data,"request_key":command.request_key})
        with self._authorized(context,PREFERENCE_WRITE,constraints) as (connection,live):
            account=live.actor.account_id
            prior=connection.execute("""select original_session_id,command_digest,receipt
                from app.playlist_preference_operations where account_id=%s and request_key=%s""",
                (account,command.request_key)).fetchone()
            if prior is not None:
                if prior["original_session_id"]!=live.actor.session_id:
                    raise PlaylistError("operation_unavailable",404)
                if prior["command_digest"]!=command.digest:
                    raise PlaylistError("idempotency_key_reused",409)
                return dict(prior["receipt"])
            previous=preference_projection(self._read(connection,account))
            if command.data["revision"]!=previous["revision"]:
                raise PlaylistError("revision_conflict",409)
            remember=command.data.get("remember_order_mode",previous["remember_order_mode"])
            if "last_order_mode" in command.data and not remember:
                raise PlaylistError("order_memory_disabled",409)
            mode=command.data.get("last_order_mode",previous["last_order_mode"])
            changed=(remember,mode)!=(previous["remember_order_mode"],previous["last_order_mode"])
            revision=int(previous["revision"])+int(changed)
            if changed:
                connection.execute("""insert into app.user_playlist_playback_preferences
                    (account_id,remember_order_mode,last_order_mode,revision) values (%s,%s,%s,%s)
                    on conflict(account_id) do update set remember_order_mode=excluded.remember_order_mode,
                      last_order_mode=excluded.last_order_mode,revision=excluded.revision,updated_at=now()""",
                    (account,remember,mode,revision))
            receipt={"ok":True,"action":"playlist_preferences","request_key":command.request_key,"changed":changed,
                "preferences":preference_projection({"remember_order_mode":remember,"last_order_mode":mode,"revision":revision})}
            connection.execute("""insert into app.playlist_preference_operations
                (account_id,request_key,original_session_id,command_digest,receipt) values (%s,%s,%s,%s,%s::jsonb)""",
                (account,command.request_key,live.actor.session_id,command.digest,json.dumps(receipt)))
            return receipt

    def read_operation(self,context,request_key,*,constraints=None):
        key=uuid_ref(request_key)
        with self._authorized(context,PREFERENCE_READ,constraints) as (connection,live):
            row=connection.execute("""select receipt from app.playlist_preference_operations
                where account_id=%s and request_key=%s and original_session_id=%s""",
                (live.actor.account_id,key,live.actor.session_id)).fetchone()
            return {"status":"committed","receipt":dict(row["receipt"])} if row else {"status":"unknown"}
