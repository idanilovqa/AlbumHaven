create or replace function library.legacy_warning_json_string_internal(
  p_value text
)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  v_character text;
  v_codepoint integer;
  v_index integer;
  v_result text := '"';
begin
  for v_index in 1..pg_catalog.char_length(p_value) loop
    v_character := pg_catalog.substr(p_value, v_index, 1);
    v_codepoint := pg_catalog.ascii(v_character);
    v_result := v_result || case
      when v_character = '"' then E'\\"'
      when v_character = E'\\' then E'\\\\'
      when v_character = E'\b' then E'\\b'
      when v_character = E'\t' then E'\\t'
      when v_character = E'\n' then E'\\n'
      when v_character = E'\f' then E'\\f'
      when v_character = E'\r' then E'\\r'
      when v_codepoint < 32 then
        E'\\u' || pg_catalog.lpad(pg_catalog.to_hex(v_codepoint), 4, '0')
      when v_codepoint < 127 then v_character
      when v_codepoint <= 65535 then
        E'\\u' || pg_catalog.lpad(pg_catalog.to_hex(v_codepoint), 4, '0')
      else
        E'\\u' || pg_catalog.lpad(
          pg_catalog.to_hex(55296 + ((v_codepoint - 65536) >> 10)),
          4,
          '0'
        ) || E'\\u' || pg_catalog.lpad(
          pg_catalog.to_hex(56320 + ((v_codepoint - 65536) & 1023)),
          4,
          '0'
        )
    end;
  end loop;
  return v_result || '"';
end;
$$;

create or replace function library.legacy_warning_strip_internal(
  p_value text
)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select pg_catalog.btrim(
    p_value,
    E' \t\n\v\f\r'
      || pg_catalog.chr(28) || pg_catalog.chr(29)
      || pg_catalog.chr(30) || pg_catalog.chr(31)
      || pg_catalog.chr(133) || pg_catalog.chr(160)
      || pg_catalog.chr(5760)
      || pg_catalog.chr(8192) || pg_catalog.chr(8193)
      || pg_catalog.chr(8194) || pg_catalog.chr(8195)
      || pg_catalog.chr(8196) || pg_catalog.chr(8197)
      || pg_catalog.chr(8198) || pg_catalog.chr(8199)
      || pg_catalog.chr(8200) || pg_catalog.chr(8201)
      || pg_catalog.chr(8202)
      || pg_catalog.chr(8232) || pg_catalog.chr(8233)
      || pg_catalog.chr(8239) || pg_catalog.chr(8287)
      || pg_catalog.chr(12288)
  );
$$;

create or replace function library.load_library_warning_acknowledgement(
  p_library_id bigint,
  p_account_id bigint
)
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select coalesce(
    (
      select pg_catalog.min(incident.warning_token::text collate "C")
      from library.watcher_incidents as incident
      join library.watcher_incident_acknowledgements as acknowledgement
        on acknowledgement.incident_id = incident.incident_id
       and acknowledgement.library_id = incident.library_id
       and acknowledgement.account_id = p_account_id
      where incident.library_id = p_library_id
        and incident.resolved_at is null
    ),
    library_record.metadata #>> array[
      'watcher_warning_dismissals', p_account_id::text
    ]
  )
  from library.libraries as library_record
  join library.library_memberships as membership
    on membership.library_id = library_record.id
   and membership.account_id = p_account_id
  where library_record.id = p_library_id;
$$;

create or replace function library.acknowledge_library_warning(
  p_library_id bigint,
  p_account_id bigint,
  p_warning_token text,
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_metadata jsonb;
  v_health jsonb;
  v_current_token text;
begin
  if p_library_id is null
     or p_account_id is null
     or nullif(library.legacy_warning_strip_internal(p_warning_token), '') is null
     or p_now is null
     or not (
       pg_catalog.pg_input_is_valid(p_warning_token, 'uuid')
       or p_warning_token ~ '^[0-9a-f]{64}$'
     ) then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('album-haven:watcher:' || p_library_id::text, 0)
  );

  select library_record.metadata
    into v_metadata
  from library.libraries as library_record
  join library.library_memberships as membership
    on membership.library_id = library_record.id
   and membership.account_id = p_account_id
  where library_record.id = p_library_id
  for update of library_record;

  if not found then
    return false;
  end if;

  if pg_catalog.pg_input_is_valid(p_warning_token, 'uuid') then
    if library.acknowledge_watcher_incident(
      p_library_id,
      p_account_id,
      p_warning_token::uuid,
      p_now
    ) then
      return true;
    end if;
  end if;

  if exists (
    select 1
    from library.watcher_incidents as incident
    where incident.library_id = p_library_id
      and incident.resolved_at is null
  ) then
    return false;
  end if;

  v_health := coalesce(v_metadata -> 'library_watch_health', '{}'::jsonb);
  if pg_catalog.jsonb_typeof(v_health) <> 'object' then
    return false;
  end if;

  with visible_health as (
    select
      library.legacy_warning_strip_internal(health.key) as root_id,
      library.legacy_warning_strip_internal(
        coalesce(health.value ->> 'state', '')
      ) as state,
      library.legacy_warning_strip_internal(
        coalesce(health.value ->> 'detected_at', '')
      ) as detected_at,
      library.legacy_warning_strip_internal(
        coalesce(health.value ->> 'event_id', '')
      ) as event_id
    from pg_catalog.jsonb_each(v_health) as health(key, value)
    where pg_catalog.jsonb_typeof(health.value) = 'object'
  )
  select pg_catalog.min(nullif(visible.event_id, '') collate "C")
    into v_current_token
  from visible_health as visible
  where visible.root_id <> ''
    and visible.state in (
      'cross_root_uncertain',
      'overflow',
      'reconciliation_failed',
      'rollback_pending_work',
      'root_unavailable',
      'stable_write_unavailable'
    )
    and visible.detected_at <> '';

  if v_current_token is null then
    with visible_health as (
      select
        library.legacy_warning_strip_internal(health.key) as root_id,
        library.legacy_warning_strip_internal(
          coalesce(health.value ->> 'state', '')
        ) as state,
        library.legacy_warning_strip_internal(
          coalesce(health.value ->> 'detected_at', '')
        ) as detected_at,
        library.legacy_warning_strip_internal(
          coalesce(health.value ->> 'event_id', '')
        ) as event_id
      from pg_catalog.jsonb_each(v_health) as health(key, value)
      where pg_catalog.jsonb_typeof(health.value) = 'object'
    ), projected_health as (
      select
        'root_' || pg_catalog.substr(
          pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(visible.root_id, 'UTF8')),
            'hex'
          ),
          1,
          16
        ) as root_key,
        visible.state,
        visible.detected_at
      from visible_health as visible
      where visible.root_id <> ''
        and visible.state in (
          'cross_root_uncertain',
          'overflow',
          'reconciliation_failed',
          'rollback_pending_work',
          'root_unavailable',
          'stable_write_unavailable'
        )
        and visible.detected_at <> ''
        and visible.event_id = ''
    )
    select pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          '[' || pg_catalog.string_agg(
            '['
              || library.legacy_warning_json_string_internal(projected.root_key)
              || ',' || library.legacy_warning_json_string_internal(projected.state)
              || ',' || library.legacy_warning_json_string_internal(projected.detected_at)
              || ']',
            ',' order by
              projected.root_key collate "C",
              projected.state collate "C",
              projected.detected_at collate "C"
          ) || ']',
          'UTF8'
        )
      ),
      'hex'
    )
      into v_current_token
    from projected_health as projected;
  end if;

  if v_current_token is null or v_current_token <> p_warning_token then
    return false;
  end if;

  update library.libraries as library_record
  set metadata = pg_catalog.jsonb_set(
    coalesce(library_record.metadata, '{}'::jsonb),
    '{watcher_warning_dismissals}',
    coalesce(
      library_record.metadata -> 'watcher_warning_dismissals',
      '{}'::jsonb
    ) || pg_catalog.jsonb_build_object(p_account_id::text, p_warning_token),
    true
  )
  where library_record.id = p_library_id;

  return true;
end;
$$;

revoke all on function library.legacy_warning_json_string_internal(text)
  from public;
revoke all on function library.legacy_warning_strip_internal(text)
  from public;
revoke all on function library.load_library_warning_acknowledgement(bigint,bigint)
  from public;
revoke all on function library.acknowledge_library_warning(bigint,bigint,text,timestamptz)
  from public;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'album_haven_app') then
    revoke all on function library.legacy_warning_json_string_internal(text)
      from album_haven_app;
    revoke all on function library.legacy_warning_strip_internal(text)
      from album_haven_app;
    grant execute on function library.load_library_warning_acknowledgement(bigint,bigint)
      to album_haven_app;
    grant execute on function library.acknowledge_library_warning(bigint,bigint,text,timestamptz)
      to album_haven_app;
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'album_haven_worker') then
    revoke all on function library.legacy_warning_json_string_internal(text)
      from album_haven_worker;
    revoke all on function library.legacy_warning_strip_internal(text)
      from album_haven_worker;
    revoke all on function library.load_library_warning_acknowledgement(bigint,bigint)
      from album_haven_worker;
    revoke all on function library.acknowledge_library_warning(bigint,bigint,text,timestamptz)
      from album_haven_worker;
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'album_haven_readonly') then
    revoke all on function library.legacy_warning_json_string_internal(text)
      from album_haven_readonly;
    revoke all on function library.legacy_warning_strip_internal(text)
      from album_haven_readonly;
    revoke all on function library.load_library_warning_acknowledgement(bigint,bigint)
      from album_haven_readonly;
    revoke all on function library.acknowledge_library_warning(bigint,bigint,text,timestamptz)
      from album_haven_readonly;
  end if;
end;
$$;
