create table library.watcher_runtime_sessions (
  library_id bigint primary key references library.libraries(id) on delete cascade,
  session_token uuid not null,
  started_at timestamptz not null,
  constraint watcher_runtime_sessions_started_at_finite_chk
    check (started_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
);

create table library.watcher_runtime_session_participants (
  library_id bigint not null,
  root_id bigint not null,
  primary key (library_id, root_id),
  foreign key (library_id)
    references library.watcher_runtime_sessions(library_id) on delete cascade,
  foreign key (library_id, root_id) references library.library_roots(library_id, id) on delete restrict
);

create or replace function library.begin_watcher_runtime_session(
  p_library_id bigint,
  p_session_token uuid,
  p_logical_root_ids text[],
  p_started_at timestamptz
)
returns table (recovered_logical_root_id text)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_active_prior_logical_root_ids text[];
  v_chunk_start integer;
  v_requested_root_ids bigint[];
begin
  if p_library_id is null or p_library_id < 1
     or p_session_token is null
     or p_started_at is null or not pg_catalog.isfinite(p_started_at)
     or p_logical_root_ids is null
     or pg_catalog.cardinality(p_logical_root_ids) > 256
     or exists (
       select 1
       from pg_catalog.unnest(p_logical_root_ids) requested(logical_id)
       where requested.logical_id is null
          or pg_catalog.btrim(requested.logical_id) = ''
     )
     or (
       select count(*) <> count(distinct requested.logical_id)
       from pg_catalog.unnest(p_logical_root_ids) requested(logical_id)
     ) then
    raise exception 'watcher runtime session request is invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('album-haven:watcher:' || p_library_id::text, 0)
  );

  if not coalesce((
    select state.acceptance_enabled
    from library.watcher_runtime_state as state
    where state.singleton is true
  ), false) then
    raise exception 'watcher acceptance is disabled' using errcode = '55000';
  end if;

  select pg_catalog.array_agg(root.id order by root.id)
  into v_requested_root_ids
  from library.library_roots as root
  where root.library_id = p_library_id
    and root.is_active is true
    and root.metadata ->> 'root_id' = any(p_logical_root_ids);

  if coalesce(pg_catalog.cardinality(v_requested_root_ids), 0)
       <> pg_catalog.cardinality(p_logical_root_ids) then
    raise exception 'watcher runtime session root scope is invalid' using errcode = '22023';
  end if;

  if exists (
    select 1
    from library.watcher_runtime_session_participants as participant
    join library.library_roots as root
      on root.library_id = participant.library_id and root.id = participant.root_id
    where participant.library_id = p_library_id
      and root.is_active is true
      and (
        pg_catalog.jsonb_typeof(root.metadata -> 'root_id') <> 'string'
        or root.metadata ->> 'root_id' is null
        or pg_catalog.btrim(root.metadata ->> 'root_id') = ''
      )
  ) or (
    select count(*) <> count(distinct root.metadata ->> 'root_id')
    from library.watcher_runtime_session_participants as participant
    join library.library_roots as root
      on root.library_id = participant.library_id and root.id = participant.root_id
    where participant.library_id = p_library_id
      and root.is_active is true
  ) then
    raise exception 'watcher prior session root scope is invalid' using errcode = '22023';
  end if;

  select pg_catalog.array_agg(root.metadata ->> 'root_id' order by root.id)
  into v_active_prior_logical_root_ids
  from library.watcher_runtime_session_participants as participant
  join library.library_roots as root
    on root.library_id = participant.library_id and root.id = participant.root_id
  where participant.library_id = p_library_id
    and root.is_active is true;

  if coalesce(pg_catalog.cardinality(v_active_prior_logical_root_ids), 0) > 0 then
    for v_chunk_start in 1
      .. pg_catalog.cardinality(v_active_prior_logical_root_ids)
      by 256
    loop
      perform 1
      from library.mark_watcher_roots_dirty(
        p_library_id,
        v_active_prior_logical_root_ids[
          v_chunk_start:
          least(
            v_chunk_start + 255,
            pg_catalog.cardinality(v_active_prior_logical_root_ids)
          )
        ],
        'overflow',
        p_started_at
      );
    end loop;
  end if;

  delete from library.watcher_runtime_sessions
  where library_id = p_library_id;

  insert into library.watcher_runtime_sessions (
    library_id,
    session_token,
    started_at
  ) values (
    p_library_id,
    p_session_token,
    p_started_at
  );

  insert into library.watcher_runtime_session_participants (library_id, root_id)
  select p_library_id, requested.root_id
  from pg_catalog.unnest(coalesce(v_requested_root_ids, '{}'::bigint[])) requested(root_id)
  order by requested.root_id;

  return query
  select recovered.logical_id
  from pg_catalog.unnest(
    coalesce(v_active_prior_logical_root_ids, '{}'::text[])
  ) with ordinality recovered(logical_id, position)
  order by recovered.position;
end;
$$;

create or replace function library.expand_watcher_runtime_session_participants(
  p_library_id bigint,
  p_session_token uuid,
  p_logical_root_ids text[]
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_requested_root_ids bigint[];
begin
  if p_library_id is null or p_library_id < 1
     or p_session_token is null
     or p_logical_root_ids is null
     or pg_catalog.cardinality(p_logical_root_ids) > 256
     or exists (
       select 1
       from pg_catalog.unnest(p_logical_root_ids) requested(logical_id)
       where requested.logical_id is null
          or pg_catalog.btrim(requested.logical_id) = ''
     )
     or (
       select count(*) <> count(distinct requested.logical_id)
       from pg_catalog.unnest(p_logical_root_ids) requested(logical_id)
     ) then
    raise exception 'watcher runtime session request is invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('album-haven:watcher:' || p_library_id::text, 0)
  );

  if not exists (
    select 1
    from library.watcher_runtime_sessions
    where library_id = p_library_id and session_token = p_session_token
  ) then
    raise exception 'watcher runtime session was replaced' using errcode = '55000';
  end if;

  select pg_catalog.array_agg(root.id order by root.id)
  into v_requested_root_ids
  from library.library_roots as root
  where root.library_id = p_library_id
    and root.is_active is true
    and root.metadata ->> 'root_id' = any(p_logical_root_ids);

  if coalesce(pg_catalog.cardinality(v_requested_root_ids), 0)
       <> pg_catalog.cardinality(p_logical_root_ids) then
    raise exception 'watcher runtime session root scope is invalid' using errcode = '22023';
  end if;

  insert into library.watcher_runtime_session_participants (library_id, root_id)
  select p_library_id, requested.root_id
  from pg_catalog.unnest(coalesce(v_requested_root_ids, '{}'::bigint[])) requested(root_id)
  order by requested.root_id
  on conflict (library_id, root_id) do nothing;
end;
$$;

create or replace function library.set_watcher_runtime_session_participants(
  p_library_id bigint,
  p_session_token uuid,
  p_logical_root_ids text[]
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_requested_root_ids bigint[];
begin
  if p_library_id is null or p_library_id < 1
     or p_session_token is null
     or p_logical_root_ids is null
     or pg_catalog.cardinality(p_logical_root_ids) > 256
     or exists (
       select 1
       from pg_catalog.unnest(p_logical_root_ids) requested(logical_id)
       where requested.logical_id is null
          or pg_catalog.btrim(requested.logical_id) = ''
     )
     or (
       select count(*) <> count(distinct requested.logical_id)
       from pg_catalog.unnest(p_logical_root_ids) requested(logical_id)
     ) then
    raise exception 'watcher runtime session request is invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('album-haven:watcher:' || p_library_id::text, 0)
  );

  if not exists (
    select 1
    from library.watcher_runtime_sessions
    where library_id = p_library_id and session_token = p_session_token
  ) then
    raise exception 'watcher runtime session was replaced' using errcode = '55000';
  end if;

  select pg_catalog.array_agg(root.id order by root.id)
  into v_requested_root_ids
  from library.library_roots as root
  where root.library_id = p_library_id
    and root.is_active is true
    and root.metadata ->> 'root_id' = any(p_logical_root_ids);

  if coalesce(pg_catalog.cardinality(v_requested_root_ids), 0)
       <> pg_catalog.cardinality(p_logical_root_ids) then
    raise exception 'watcher runtime session root scope is invalid' using errcode = '22023';
  end if;

  delete from library.watcher_runtime_session_participants
  where library_id = p_library_id;

  insert into library.watcher_runtime_session_participants (library_id, root_id)
  select p_library_id, requested.root_id
  from pg_catalog.unnest(coalesce(v_requested_root_ids, '{}'::bigint[])) requested(root_id)
  order by requested.root_id;
end;
$$;

create or replace function library.finish_watcher_runtime_session(
  p_library_id bigint,
  p_session_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_library_id is null or p_library_id < 1 or p_session_token is null then
    raise exception 'watcher runtime session request is invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('album-haven:watcher:' || p_library_id::text, 0)
  );

  if not exists (
    select 1 from library.watcher_runtime_sessions where library_id = p_library_id
  ) then
    return false;
  end if;
  if not exists (
    select 1
    from library.watcher_runtime_sessions
    where library_id = p_library_id and session_token = p_session_token
  ) then
    raise exception 'watcher runtime session was replaced' using errcode = '55000';
  end if;

  delete from library.watcher_runtime_sessions
  where library_id = p_library_id and session_token = p_session_token;
  return found;
end;
$$;

revoke all on table library.watcher_runtime_sessions from public;
revoke all on table library.watcher_runtime_sessions from album_haven_app;
revoke all on table library.watcher_runtime_sessions from album_haven_worker;
revoke all on table library.watcher_runtime_sessions from album_haven_readonly;
revoke all on table library.watcher_runtime_session_participants from public;
revoke all on table library.watcher_runtime_session_participants from album_haven_app;
revoke all on table library.watcher_runtime_session_participants from album_haven_worker;
revoke all on table library.watcher_runtime_session_participants from album_haven_readonly;

revoke all on function library.begin_watcher_runtime_session(bigint,uuid,text[],timestamptz) from public;
revoke all on function library.begin_watcher_runtime_session(bigint,uuid,text[],timestamptz) from album_haven_app;
revoke all on function library.begin_watcher_runtime_session(bigint,uuid,text[],timestamptz) from album_haven_worker;
revoke all on function library.begin_watcher_runtime_session(bigint,uuid,text[],timestamptz) from album_haven_readonly;
grant execute on function library.begin_watcher_runtime_session(bigint,uuid,text[],timestamptz) to album_haven_app;

revoke all on function library.expand_watcher_runtime_session_participants(bigint,uuid,text[]) from public;
revoke all on function library.expand_watcher_runtime_session_participants(bigint,uuid,text[]) from album_haven_app;
revoke all on function library.expand_watcher_runtime_session_participants(bigint,uuid,text[]) from album_haven_worker;
revoke all on function library.expand_watcher_runtime_session_participants(bigint,uuid,text[]) from album_haven_readonly;
grant execute on function library.expand_watcher_runtime_session_participants(bigint,uuid,text[]) to album_haven_app;

revoke all on function library.set_watcher_runtime_session_participants(bigint,uuid,text[]) from public;
revoke all on function library.set_watcher_runtime_session_participants(bigint,uuid,text[]) from album_haven_app;
revoke all on function library.set_watcher_runtime_session_participants(bigint,uuid,text[]) from album_haven_worker;
revoke all on function library.set_watcher_runtime_session_participants(bigint,uuid,text[]) from album_haven_readonly;
grant execute on function library.set_watcher_runtime_session_participants(bigint,uuid,text[]) to album_haven_app;

revoke all on function library.finish_watcher_runtime_session(bigint,uuid) from public;
revoke all on function library.finish_watcher_runtime_session(bigint,uuid) from album_haven_app;
revoke all on function library.finish_watcher_runtime_session(bigint,uuid) from album_haven_worker;
revoke all on function library.finish_watcher_runtime_session(bigint,uuid) from album_haven_readonly;
grant execute on function library.finish_watcher_runtime_session(bigint,uuid) to album_haven_app;
