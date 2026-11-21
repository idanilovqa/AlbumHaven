"""Account-keyed access to the existing Last.fm credential tables."""
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


def save_account_settings(adapter, settings, account_id):
    owner = _owner(account_id)
    username = _text(settings.get("username")) or None
    key = _text(settings.get("session_key")) or None
    public = {name: value for name, value in settings.items() if name != "session_key"}
    with adapter._connect_to_database() as connection:
        connection.execute("select id from app.accounts where id=%s for update", (owner,))
        connection.execute("""insert into integration.lastfm_settings(account_id,provider_username,timezone_name,settings_payload)
            values(%s,%s,%s,%s) on conflict(account_id) do update set provider_username=excluded.provider_username,
            timezone_name=excluded.timezone_name,settings_payload=excluded.settings_payload,updated_at=now()""",
            (owner,username,_text(settings.get("user_timezone")) or None,_jsonb({"source":"runtime_lastfm_settings_adapter","settings_payload":public})))
        connection.execute("update integration.lastfm_sessions set is_active=false,updated_at=now() where account_id=%s and is_active", (owner,))
        if username and key:
            connection.execute("""insert into integration.lastfm_sessions(account_id,provider_username,session_key_encrypted,is_active,metadata)
                values(%s,%s,%s,true,%s) on conflict(account_id,provider_username) do update
                set session_key_encrypted=excluded.session_key_encrypted,is_active=true,metadata=excluded.metadata,updated_at=now()""",
                (owner,username,key,_jsonb({"source":"runtime_lastfm_settings_adapter","connected_at":_text(settings.get("connected_at")),"source_payload":public})))
    return dict(settings)
