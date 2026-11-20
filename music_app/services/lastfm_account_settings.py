"""Account-keyed access to the existing Last.fm credential tables."""
from collections.abc import Mapping
from uuid import uuid4
from music_app.services.lastfm_postgres import _settings_from_row, _jsonb, _text


def _owner(account_id):
    if type(account_id) is not int or account_id <= 0:
        raise ValueError("Authenticated Last.fm account is required")
    return account_id


_ACCOUNT_SETTINGS_SQL = """select s.account_id,s.provider_username,s.timezone_name,s.settings_payload,
    k.session_key_encrypted,k.metadata->>'connected_at' as connected_at
    from integration.lastfm_settings s left join integration.lastfm_sessions k
      on k.account_id=s.account_id and k.provider_username is not distinct from s.provider_username
      and k.is_active where s.account_id=any(%s)"""


def load_account_settings(adapter, account_id):
    owner = _owner(account_id)
    with adapter._connect_to_database() as connection:
        return load_settings_for_accounts(connection, [owner]).get(owner, {})


def load_settings_for_accounts(connection, account_ids):
    """Each listed account's saved settings, in one query on the caller's connection."""
    owners = sorted({_owner(account_id) for account_id in account_ids})
    if not owners:
        return {}
    rows = connection.execute(_ACCOUNT_SETTINGS_SQL, (owners,)).fetchall()
    return {row["account_id"]: _settings_from_row(row) for row in rows}


def save_account_settings(adapter, settings, account_id, *, reauthentication_context=None):
    owner = _owner(account_id)
    username = _text(settings.get("username")) or None
    key = _text(settings.get("session_key")) or None
    public = {name: value for name, value in settings.items() if name != "session_key"}
    context = None
    if reauthentication_context is not None:
        if not isinstance(reauthentication_context, Mapping) or not username or not key:
            raise ValueError("Successful Last.fm reconnect context is required")
        from music_app.services.lastfm_retry_jobs_postgres import _positive, _bounded, _nonnegative
        context = {
            "account_id": owner,
            "library_id": _positive("library_id", reauthentication_context.get("library_id")),
            "request_origin_ref": _bounded("request_origin_ref", reauthentication_context.get("request_origin_ref"), maximum=1024),
            "deployment_mode": _bounded("deployment_mode", reauthentication_context.get("deployment_mode"), maximum=128),
            "client_surface": _bounded("client_surface", reauthentication_context.get("client_surface"), maximum=128),
            "request_ref": _bounded("request_ref", reauthentication_context.get("request_ref") or uuid4().hex, maximum=128),
            "expected_generation": _nonnegative("expected_generation", reauthentication_context.get("expected_generation")),
        }
    with adapter._connect_to_database() as connection:
        connection.execute("select id from app.accounts where id=%s for update", (owner,))
        if context is not None:
            previous = connection.execute("""
                select session.provider_username, session.session_key_encrypted,
                       session.is_active, continuation.deployment_mode,
                       origin.client_surface_class
                  from integration.lastfm_reauthentication_continuations continuation
                  join app.request_origins origin on origin.id=continuation.request_origin_id
                  join integration.lastfm_sessions session on session.id=continuation.active_session_id
                 where continuation.account_id=%(account_id)s
                   and continuation.library_id=%(library_id)s
                   and continuation.last_request_ref=%(request_ref)s
                   and origin.origin_type || ':' || origin.origin_key=%(request_origin_ref)s
                """, context).fetchone()
            if previous is not None:
                if (not previous["is_active"] or previous["provider_username"] != username
                        or _settings_from_row(previous).get("session_key") != key
                        or previous["deployment_mode"] != context["deployment_mode"]
                        or previous["client_surface_class"] != context["client_surface"]):
                    raise ValueError("Last.fm reconnect request was already used with different credentials")
                return dict(settings)
            current = connection.execute("""
                select coalesce((select generation
                  from integration.lastfm_reauthentication_continuations
                 where account_id=%(account_id)s and library_id=%(library_id)s), 0) as generation
                """, context).fetchone()
            if current["generation"] != context["expected_generation"]:
                raise ValueError("Last.fm reconnect was superseded; authenticate again")
        connection.execute("""insert into integration.lastfm_settings(account_id,provider_username,timezone_name,settings_payload)
            values(%s,%s,%s,%s) on conflict(account_id) do update set provider_username=excluded.provider_username,
            timezone_name=excluded.timezone_name,settings_payload=excluded.settings_payload,updated_at=now()""",
            (owner,username,_text(settings.get("user_timezone")) or None,_jsonb({"source":"runtime_lastfm_settings_adapter","settings_payload":public})))
        connection.execute("update integration.lastfm_sessions set is_active=false,updated_at=now() where account_id=%s and is_active", (owner,))
        if username and key:
            session = connection.execute("""insert into integration.lastfm_sessions(account_id,provider_username,session_key_encrypted,is_active,metadata)
                values(%s,%s,%s,true,%s) on conflict(account_id,provider_username) do update
                set session_key_encrypted=excluded.session_key_encrypted,is_active=true,metadata=excluded.metadata,updated_at=now()
                returning id""",
                (owner,username,key,_jsonb({"source":"runtime_lastfm_settings_adapter","connected_at":_text(settings.get("connected_at")),"source_payload":public}))).fetchone()
            if context is not None:
                connection.execute("""
                    select integration.signal_lastfm_reauthentication(
                      %(account_id)s, %(library_id)s, %(active_session_id)s,
                      %(request_origin_ref)s, %(deployment_mode)s, %(client_surface)s,
                      %(request_ref)s, clock_timestamp(), %(expected_generation)s)
                    """, {**context, "active_session_id": session["id"]})
    return dict(settings)
