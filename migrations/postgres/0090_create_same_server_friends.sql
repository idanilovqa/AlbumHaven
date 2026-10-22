-- The application must be stopped while defaults and relationship schema advance.
create table app.social_profiles (
  account_id bigint primary key references app.accounts(id) on delete cascade,
  account_ref uuid not null default gen_random_uuid() unique
);
insert into app.social_profiles(account_id) select id from app.accounts;
create function app.create_social_profile() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
  insert into app.social_profiles(account_id) values(new.id);
  return new;
end $$;
revoke all on function app.create_social_profile() from public;
create trigger account_social_profile after insert on app.accounts
  for each row execute function app.create_social_profile();

create table app.friend_policies (
  library_id bigint primary key references library.libraries(id) on delete cascade,
  auto_friend boolean not null default false,
  updated_by_account_id bigint references app.social_profiles(account_id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into app.friend_policies(library_id) select id from library.libraries;
create function app.create_friend_policy() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
  insert into app.friend_policies(library_id) values(new.id);
  return new;
end $$;
revoke all on function app.create_friend_policy() from public;
create trigger library_friend_policy after insert on library.libraries
  for each row execute function app.create_friend_policy();

create table app.friend_connections (
  library_id bigint not null references app.friend_policies(library_id) on delete cascade,
  low_account_id bigint not null references app.social_profiles(account_id) on delete cascade,
  high_account_id bigint not null references app.social_profiles(account_id) on delete cascade,
  requester_account_id bigint references app.social_profiles(account_id) on delete cascade,
  state text not null check (state in ('pending','accepted','declined','cancelled','removed')),
  origin text not null check (origin in ('request','automatic')),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (library_id, low_account_id, high_account_id),
  check (low_account_id < high_account_id),
  check (requester_account_id is null or requester_account_id in (low_account_id, high_account_id)),
  check ((origin = 'automatic' and requester_account_id is null and state in ('accepted','removed'))
      or (origin = 'request' and requester_account_id is not null))
);
create index friend_connections_high_account_idx
  on app.friend_connections (library_id, high_account_id, state, low_account_id);
create index friend_connections_low_account_idx
  on app.friend_connections (library_id, low_account_id, state, high_account_id);

create table app.friend_notifications (
  id bigint generated always as identity primary key,
  library_id bigint not null,
  low_account_id bigint not null,
  high_account_id bigint not null,
  connection_revision bigint not null,
  recipient_account_id bigint not null references app.social_profiles(account_id) on delete cascade,
  sender_account_id bigint not null references app.social_profiles(account_id) on delete cascade,
  kind text not null check (kind in ('friend_request','friend_accepted')),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  foreign key (library_id,low_account_id,high_account_id)
    references app.friend_connections(library_id,low_account_id,high_account_id) on delete cascade,
  unique (library_id,low_account_id,high_account_id,connection_revision,recipient_account_id,kind),
  check (recipient_account_id <> sender_account_id),
  check (recipient_account_id in (low_account_id,high_account_id)),
  check (sender_account_id in (low_account_id,high_account_id))
);
create index friend_notifications_recipient_idx
  on app.friend_notifications (library_id,recipient_account_id,id desc);

-- Only exact recorded standard assignments and the former uncustomized Listener
-- set receive defaults. Role names or membership alone never establish a match.
with role_grants(role_key, grants) as (
  values ('viewer', array['capability.view']::text[]),
      ('listener', array['capability.play','capability.view']::text[]),
      ('musician', array['capability.create_loop','capability.play','capability.practice','capability.view']::text[]),
      ('owner', array['capability.change_covers','capability.create_loop','capability.delete','capability.edit','capability.move','capability.play','capability.practice','capability.repair','capability.view','integration.foobar.read','integration.lastfm.manage','integration.lastfm.scrobbles.submit','integration.local_playlists.analyze','integration.local_playlists.import','integration.settings.read','library.discovery.lookup','library.discovery.preferences.manage','library.discovery.read','library.files.open_location','library.filesystem.browse','library.logs.export','library.logs.read','library.loops.delete','library.loops.reorder','library.notes.manage','library.opinions.read','library.playlists.access.manage','library.playlists.cover.manage','library.playlists.create','library.playlists.items.manage','library.playlists.manage','library.playlists.settings.manage','library.ratings.import','library.refresh','library.refresh.cancel','library.refresh.read','library.resources.read','library.settings.manage','library.settings.read','library.tasks.read','library.track_preferences.manage']::text[]),
      ('admin', array['capability.admin','capability.view']::text[])
), assignments as (
  select a.id as account_id,m.library_id,
    a.metadata -> 'library_access_assignments_v1' -> m.library_id::text as assignment,
    array(select c.capability_key from app.capabilities c
          where c.account_id=a.id and c.scope_kind='library' and c.scope_id=m.library_id
            and c.revoked_at is null order by c.capability_key) as grants
  from app.accounts a join library.library_memberships m on m.account_id=a.id
), standard as (
  select s.account_id,s.library_id from assignments s
  where s.assignment -> 'version' = '1'::jsonb
    and s.assignment -> 'capability_keys' = '[]'::jsonb
    and jsonb_typeof(s.assignment -> 'role_keys') = 'array'
    and s.assignment -> 'role_keys' <> '[]'::jsonb
    and not exists (select 1 from jsonb_array_elements_text(
      case when jsonb_typeof(s.assignment -> 'role_keys')='array'
           then s.assignment -> 'role_keys' else '[]'::jsonb end) r(key)
      where not exists (select 1 from role_grants p where p.role_key=r.key))
    and s.grants = array(select distinct unnest(p.grants) as key
        from role_grants p where (s.assignment -> 'role_keys') ? p.role_key order by key)
  union
  select account_id,library_id from assignments
  where assignment is null and grants = array[
      'library.browse.read','library.discovery.read','library.media.read',
      'library.playlists.create','library.resources.read']::text[]
  union
  select b.account_id,m.library_id from app.bootstrap_owners b
    join library.library_memberships m on m.account_id=b.account_id
    where b.owner_key='local-bootstrap-owner'
)
insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
select account_id,'capability.social','library',library_id from standard
on conflict (account_id,capability_key,scope_kind,scope_id) where revoked_at is null do nothing;

-- This invoker-rights function only adds absent pairs. A retained tombstone is
-- never overwritten by later activation, grants, membership, or policy changes.
create function app.sync_automatic_friends(selected_library bigint) returns void
language plpgsql set search_path = pg_catalog as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('album-haven-social:' || selected_library::text, 0));
  if not exists (select 1 from app.friend_policies
                 where library_id=selected_library and auto_friend) then return; end if;
  with eligible as (
    select a.id from app.accounts a
    join library.library_memberships m on m.account_id=a.id and m.library_id=selected_library
    where a.is_active and a.disabled_at is null and exists (
      select 1 from app.capabilities c where c.account_id=a.id
        and c.capability_key='capability.social' and c.revoked_at is null
        and ((c.scope_kind='library' and c.scope_id=selected_library)
          or (c.scope_kind='global' and c.scope_id is null))
    )
  )
  insert into app.friend_connections(library_id,low_account_id,high_account_id,state,origin)
  select selected_library,a.id,b.id,'accepted','automatic'
  from eligible a join eligible b on a.id < b.id
  order by a.id,b.id
  on conflict (library_id,low_account_id,high_account_id) do nothing;
end $$;

create function app.refresh_automatic_friends() returns trigger
language plpgsql set search_path = pg_catalog as $$
declare selected_library bigint; selected_account bigint;
begin
  if tg_table_name='accounts' then selected_account := new.id;
  else selected_account := new.account_id; end if;
  if tg_table_name='library_memberships' then
    if exists (
    select 1 from app.bootstrap_owners where account_id=selected_account and owner_key='local-bootstrap-owner'
  ) and not exists (
    select 1 from app.capabilities where account_id=selected_account and capability_key='capability.social'
      and ((scope_kind='library' and scope_id=new.library_id) or (scope_kind='global' and scope_id is null))
  ) then
    insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
    values(selected_account,'capability.social','library',new.library_id)
    on conflict (account_id,capability_key,scope_kind,scope_id) where revoked_at is null do nothing;
    end if;
  end if;
  for selected_library in
    select m.library_id from library.library_memberships m
    where m.account_id = selected_account
    order by m.library_id
  loop
    perform app.sync_automatic_friends(selected_library);
  end loop;
  return new;
end $$;
create trigger friend_membership_insert after insert on library.library_memberships
  for each row execute function app.refresh_automatic_friends();
create trigger friend_social_grant after insert or update on app.capabilities
  for each row when (new.capability_key='capability.social' and new.revoked_at is null)
  execute function app.refresh_automatic_friends();
create trigger friend_account_activation after update of is_active,disabled_at on app.accounts
  for each row when (new.is_active and new.disabled_at is null)
  execute function app.refresh_automatic_friends();

revoke all on function app.sync_automatic_friends(bigint) from public;
revoke all on function app.refresh_automatic_friends() from public;
revoke all on app.social_profiles,app.friend_connections,app.friend_policies,app.friend_notifications from public;
revoke all on sequence app.friend_notifications_id_seq from public;
do $$
declare role_name text;
begin
  foreach role_name in array array['album_haven_readonly','album_haven_app','album_haven_migrator'] loop
    if exists (select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on app.social_profiles,app.friend_connections,app.friend_policies,app.friend_notifications from %I',role_name);
      execute format('revoke all on sequence app.friend_notifications_id_seq from %I',role_name);
      execute format('revoke all on function app.sync_automatic_friends(bigint),app.refresh_automatic_friends(),app.create_social_profile(),app.create_friend_policy() from %I',role_name);
      if role_name <> 'album_haven_readonly' then
        execute format('grant select,insert on app.social_profiles to %I',role_name);
        execute format('grant select,insert,update on app.friend_connections,app.friend_policies,app.friend_notifications to %I',role_name);
        execute format('grant usage,select on sequence app.friend_notifications_id_seq to %I',role_name);
        execute format('grant execute on function app.sync_automatic_friends(bigint),app.refresh_automatic_friends(),app.create_social_profile(),app.create_friend_policy() to %I',role_name);
      end if;
    end if;
  end loop;
end $$;
