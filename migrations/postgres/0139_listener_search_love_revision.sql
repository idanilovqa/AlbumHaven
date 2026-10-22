-- Independent Love evidence; do not change the historical activity revision.
alter table app.activity_source_revisions
  add column love_revision bigint not null default 0 check (love_revision >= 0);

create function app.bump_listener_search_love_revision(p_library bigint, p_account bigint)
returns void language plpgsql security definer set search_path = pg_catalog as $$
begin
  if p_library is null or p_library <= 0 or p_account is null or p_account <= 0
      or not exists (select 1 from library.libraries where id = p_library) then
    return;
  end if;
  insert into app.activity_source_revisions(library_id, account_id, love_revision)
  values (p_library, p_account, 1)
  on conflict (library_id, account_id) do update
    set love_revision = app.activity_source_revisions.love_revision + 1;
end $$;

create function app.invalidate_listener_search_love()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare
  old_library bigint; old_account bigint;
  new_library bigint; new_account bigint;
  affected record;
begin
  if TG_OP = 'UPDATE' and
      row(OLD.account_id, OLD.library_id, OLD.track_key, OLD.track_id, OLD.love_tier)
      is not distinct from
      row(NEW.account_id, NEW.library_id, NEW.track_key, NEW.track_id, NEW.love_tier) then
    return NEW;
  end if;
  if TG_OP != 'INSERT' then
    old_library := OLD.library_id; old_account := OLD.account_id;
  end if;
  if TG_OP != 'DELETE' then
    new_library := NEW.library_id; new_account := NEW.account_id;
  end if;
  for affected in
    select distinct scope.library_id, scope.account_id
    from (values (old_library, old_account), (new_library, new_account))
      as scope(library_id, account_id)
    where scope.library_id > 0 and scope.account_id > 0
    order by scope.library_id, scope.account_id
  loop
    perform app.bump_listener_search_love_revision(affected.library_id, affected.account_id);
  end loop;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end $$;

create trigger listener_search_love_change
after insert or update or delete on app.track_preferences
for each row execute function app.invalidate_listener_search_love();

revoke all on function app.bump_listener_search_love_revision(bigint,bigint),
  app.invalidate_listener_search_love() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on function app.bump_listener_search_love_revision(bigint,bigint),
      app.invalidate_listener_search_love() from album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on function app.bump_listener_search_love_revision(bigint,bigint),
      app.invalidate_listener_search_love() from album_haven_readonly;
  end if;
end $$;
