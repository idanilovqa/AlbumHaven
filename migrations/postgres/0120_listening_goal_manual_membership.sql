-- Retained admission facts and closed cycles remain immutable. No DELETE grants.

alter table app.listening_goal_albums add column current_position bigint
  check (current_position > 0);
update app.listening_goal_albums set current_position=original_position;
alter table app.listening_goal_albums add constraint listening_goal_active_album_position
  unique(account_id, goal_ref, current_position);

alter table app.listening_goal_assignments add column removed_at timestamptz
  check (isfinite(removed_at) and removed_at >= assigned_at);
-- Replace only the exact declared album/period unique constraint from 0118.
-- Retired assignments retain their IDs/order; a later Add creates a new one.
do $$ declare names text[]; begin
  select array_agg(c.conname) into names from pg_constraint c
    where c.conrelid='app.listening_goal_assignments'::regclass and c.contype='u'
    and array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum,n)
              join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
              order by k.n)=array['account_id','goal_ref','catalog_ref','period'];
  if coalesce(cardinality(names),0) <> 1 then
    raise exception 'Expected exact Goals assignment identity constraint';
  end if;
  execute format('alter table app.listening_goal_assignments drop constraint %I',names[1]);
end $$;
create unique index listening_goal_active_assignment_idx
  on app.listening_goal_assignments(account_id,goal_ref,catalog_ref,period)
  where removed_at is null;

alter table app.listening_goal_cycle_items add column removed_at timestamptz
  check (isfinite(removed_at));
alter table app.listening_goal_cycle_items add constraint listening_goal_removed_item_unmarked
  check (removed_at is null or manual_completed_at is null);

alter table app.listening_goal_operations drop constraint listening_goal_operations_action_check;
alter table app.listening_goal_operations add constraint listening_goal_operations_action_check
  check (action in ('add','reset','completion','remove'));

create function app.guard_listening_goal_album_order()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if (to_jsonb(NEW)-'current_position') is distinct from (to_jsonb(OLD)-'current_position') then
    raise exception using errcode='23514', constraint='listening_goal_admission_immutable',
      message='Goal admission metadata is retained';
  end if;
  -- Survivors are never reordered. Only removal or an appended reactivation is
  -- permitted; first admission order and facts never change.
  if OLD.current_position is not null and NEW.current_position is not null
      and OLD.current_position is distinct from NEW.current_position then
    raise exception using errcode='23514', constraint='listening_goal_active_order_immutable',
      message='Current Goal ordering may change only across removal';
  end if;
  return NEW;
end $$;
create trigger listening_goal_album_order_update before update on app.listening_goal_albums
  for each row execute function app.guard_listening_goal_album_order();

create function app.guard_listening_goal_assignment_retirement()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if TG_OP='INSERT' then
    if NEW.removed_at is not null then
      raise exception using errcode='23514', constraint='listening_goal_assignment_active',
        message='A Goal assignment must begin active';
    end if;
  elsif (to_jsonb(NEW)-'removed_at') is distinct from (to_jsonb(OLD)-'removed_at')
      or OLD.removed_at is not null or NEW.removed_at is null then
    raise exception using errcode='23514', constraint='listening_goal_assignment_retained',
      message='A Goal assignment may only be retired once';
  end if;
  return NEW;
end $$;
create trigger listening_goal_assignment_write before insert or update on app.listening_goal_assignments
  for each row execute function app.guard_listening_goal_assignment_retirement();

create or replace function app.guard_listening_goal_cycle_item()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare
  target_account bigint;
  target_goal uuid;
  target_cycle uuid;
  cycle_started timestamptz;
  cycle_closed timestamptz;
begin
  if TG_OP='UPDATE' then
    if (to_jsonb(NEW)-array['manual_completed_at','removed_at','position']) is distinct from
        (to_jsonb(OLD)-array['manual_completed_at','removed_at','position']) then
      raise exception using errcode='23514', constraint='listening_goal_item_identity_immutable',
        message='Goal cycle item identity is immutable';
    end if;
    if OLD.removed_at is not null then
      -- Same-cycle re-add reactivates this retained identity at the end. It must
      -- start unmarked; it cannot mutate another cycle or revive archived items.
      if NEW.removed_at is not null or NEW.position <= OLD.position or NEW.manual_completed_at is not null then
        raise exception using errcode='23514', constraint='listening_goal_item_reactivation',
          message='Re-added current items require fresh order and clear completion';
      end if;
    elsif NEW.position is distinct from OLD.position then
      raise exception using errcode='23514', constraint='listening_goal_item_order_immutable',
        message='Current item ordering is immutable until removal';
    end if;
  elsif TG_OP='INSERT' and NEW.removed_at is not null then
    raise exception using errcode='23514', constraint='listening_goal_item_active',
      message='A Goal cycle item must begin active';
  end if;
  if TG_OP='DELETE' then
    target_account:=OLD.account_id; target_goal:=OLD.goal_ref; target_cycle:=OLD.cycle_id;
  else
    target_account:=NEW.account_id; target_goal:=NEW.goal_ref; target_cycle:=NEW.cycle_id;
  end if;
  select started_at,closed_at into cycle_started,cycle_closed from app.listening_goal_cycles
    where account_id=target_account and goal_ref=target_goal and cycle_id=target_cycle for update;
  if not found or cycle_closed is not null then
    raise exception using errcode='23514', constraint='listening_goal_archive_items_immutable',
      message='Goal cycle membership requires a current owned cycle';
  end if;
  if TG_OP='DELETE' then return OLD; end if;
  if (NEW.manual_completed_at is not null and NEW.manual_completed_at < cycle_started)
      or (NEW.removed_at is not null and NEW.removed_at < cycle_started) then
    raise exception using errcode='23514', constraint='listening_goal_completion_bounds',
      message='Goal item change falls outside its cycle';
  end if;
  return NEW;
end $$;

revoke all on function app.guard_listening_goal_album_order(),
  app.guard_listening_goal_assignment_retirement() from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on function app.guard_listening_goal_album_order(),
      app.guard_listening_goal_assignment_retirement() from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    grant update(current_position) on app.listening_goal_albums to album_haven_app;
    grant update(removed_at) on app.listening_goal_assignments to album_haven_app;
    grant update(manual_completed_at,removed_at,position) on app.listening_goal_cycle_items to album_haven_app;
    grant execute on function app.guard_listening_goal_album_order(),
      app.guard_listening_goal_assignment_retirement() to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant execute on function app.guard_listening_goal_album_order(),
      app.guard_listening_goal_assignment_retirement() to album_haven_migrator;
  end if;
end $$;
