-- Account preferences confer no Top access and never bind Goals to a library.
create function app.listening_goal_bonus_refs_valid(refs uuid[])
returns boolean language sql immutable security invoker set search_path=pg_catalog as $$
  select coalesce(array_ndims(refs),1)=1 and cardinality(refs)<=100
    and array_position(refs,null) is null
    and not ('00000000-0000-0000-0000-000000000000'::uuid=any(refs))
    and cardinality(refs)=(select count(distinct value) from unnest(refs) value)
$$;

create table app.listening_goal_bonus_settings (
  account_id bigint primary key references app.accounts(id) on delete restrict,
  revision bigint not null check (revision > 0),
  enabled boolean not null,
  source_mode text not null check (source_mode in ('all_active','selected')),
  selected_top_refs uuid[] not null check (app.listening_goal_bonus_refs_valid(selected_top_refs)),
  preferred_top_refs uuid[] not null check (app.listening_goal_bonus_refs_valid(preferred_top_refs)),
  album_mode text not null check (album_mode in ('next','random')),
  unfinished_policy text not null check (unfinished_policy in ('carry','larger_period')),
  created_at timestamptz not null check (isfinite(created_at)),
  updated_at timestamptz not null check (isfinite(updated_at) and updated_at>=created_at),
  check ((source_mode='all_active' and cardinality(selected_top_refs)=0)
    or (source_mode='selected' and preferred_top_refs <@ selected_top_refs))
);
-- Deliberately no library/Top FK: unavailable source intentions remain editable;
-- only a separately authorized draw can turn a source into Goal membership.
create function app.guard_listening_goal_bonus_settings()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if NEW.account_id is distinct from OLD.account_id
      or NEW.created_at is distinct from OLD.created_at
      or NEW.revision::numeric <> OLD.revision::numeric + 1
      or NEW.updated_at < OLD.updated_at then
    raise exception using errcode='23514',constraint='listening_goal_bonus_settings_revision',
      message='Bonus settings identity and revision transition is invalid';
  end if;
  return NEW;
end $$;
create trigger listening_goal_bonus_settings_update before update on app.listening_goal_bonus_settings
  for each row execute function app.guard_listening_goal_bonus_settings();

alter table app.listening_goal_operations drop constraint listening_goal_operations_action_check;
alter table app.listening_goal_operations add constraint listening_goal_operations_action_check
  check (action in ('add','reset','completion','remove','bonus_settings'));

revoke all on app.listening_goal_bonus_settings from public;
revoke all on function app.listening_goal_bonus_refs_valid(uuid[]),
  app.guard_listening_goal_bonus_settings() from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.listening_goal_bonus_settings from album_haven_readonly;
    revoke all on function app.listening_goal_bonus_refs_valid(uuid[]),
      app.guard_listening_goal_bonus_settings() from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.listening_goal_bonus_settings from album_haven_app;
    revoke all on function app.listening_goal_bonus_refs_valid(uuid[]),
      app.guard_listening_goal_bonus_settings() from album_haven_app;
    grant select,insert on app.listening_goal_bonus_settings to album_haven_app;
    grant update(revision,enabled,source_mode,selected_top_refs,preferred_top_refs,
      album_mode,unfinished_policy,updated_at) on app.listening_goal_bonus_settings to album_haven_app;
    grant execute on function app.listening_goal_bonus_refs_valid(uuid[]),
      app.guard_listening_goal_bonus_settings() to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.listening_goal_bonus_settings to album_haven_migrator;
    grant execute on function app.listening_goal_bonus_refs_valid(uuid[]),
      app.guard_listening_goal_bonus_settings() to album_haven_migrator;
  end if;
end $$;
-- No DELETE or aggregate/admission/history UPDATE privilege is added.
