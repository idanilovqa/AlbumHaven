-- Independent explicit album taste; preserve old ratings, metadata and grants.
alter table app.album_ratings
  add column favorite boolean default null,
  add column preference_revision bigint not null default 1 check (preference_revision >= 1);

-- Independent monotonic evidence. Historical revision and love_revision unchanged.
alter table app.activity_source_revisions
  add column album_taste_revision bigint not null default 0 check (album_taste_revision >= 0);

create function app.bump_home_album_taste_revision(p_library bigint, p_account bigint)
returns void language plpgsql security definer set search_path = pg_catalog as $$
begin
  if p_library is null or p_library <= 0 or p_account is null or p_account <= 0
      or not exists (select 1 from library.libraries where id = p_library)
      or not exists (select 1 from app.accounts where id = p_account) then
    return;
  end if;
  insert into app.activity_source_revisions(library_id, account_id, album_taste_revision)
  values (p_library, p_account, 1)
  on conflict (library_id, account_id) do update
    set album_taste_revision = app.activity_source_revisions.album_taste_revision + 1;
end $$;

create function app.invalidate_home_album_taste()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare
  old_library bigint; old_account bigint;
  new_library bigint; new_account bigint;
  affected record;
begin
  if TG_OP = 'UPDATE' and
      row(OLD.account_id, OLD.library_id, OLD.album_key, OLD.rating,
          OLD.favorite, OLD.preference_revision) is not distinct from
      row(NEW.account_id, NEW.library_id, NEW.album_key, NEW.rating,
          NEW.favorite, NEW.preference_revision) then
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
    perform app.bump_home_album_taste_revision(affected.library_id, affected.account_id);
  end loop;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end $$;

create trigger home_album_taste_change
after insert or update or delete on app.album_ratings
for each row execute function app.invalidate_home_album_taste();

revoke all on function app.bump_home_album_taste_revision(bigint,bigint),
  app.invalidate_home_album_taste() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on function app.bump_home_album_taste_revision(bigint,bigint),
      app.invalidate_home_album_taste() from album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on function app.bump_home_album_taste_revision(bigint,bigint),
      app.invalidate_home_album_taste() from album_haven_readonly;
  end if;
end $$;
