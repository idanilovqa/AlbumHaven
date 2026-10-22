-- Stop the application while advancing this authority contract.
-- Preserve historical grants and every existing relationship. No eager sync.
-- These alternatives mirror grant_keys_for_action('library.browse.read'),
-- including coarse prerequisites and the retained Rules alias. Admin alone
-- does not imply View. Ordinary action grants never imply media authority.
create or replace function app.sync_automatic_friends(selected_library bigint) returns void
language plpgsql set search_path = pg_catalog as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('album-haven-social:' || selected_library::text, 0));
  if not exists (select 1 from app.friend_policies
                 where library_id=selected_library and auto_friend) then return; end if;
  with eligible as (
    select a.id from app.accounts a
    join library.library_memberships m on m.account_id=a.id and m.library_id=selected_library
    where a.is_active and a.disabled_at is null and (
      exists (select 1 from app.bootstrap_owners b where b.account_id=a.id
        and b.owner_key='local-bootstrap-owner')
      or exists (
        select 1 from app.capabilities c where c.account_id=a.id
          and c.capability_key in (
            'library.browse.read', 'capability.view', 'capability.social',
            'capability.play', 'capability.edit', 'capability.change_covers',
            'capability.delete', 'capability.create_loop', 'capability.practice',
            'capability.repair', 'capability.rules', 'capability.move'
          ) and c.revoked_at is null
          and ((c.scope_kind='library' and c.scope_id=selected_library)
            or (c.scope_kind='global' and c.scope_id is null))
      )
    )
  )
  insert into app.friend_connections(library_id,low_account_id,high_account_id,state,origin)
  select selected_library,a.id,b.id,'accepted','automatic'
  from eligible a join eligible b on a.id < b.id
  order by a.id,b.id
  on conflict (library_id,low_account_id,high_account_id) do nothing;
end $$;

-- Membership and account activation keep their existing trigger hooks.
-- Bootstrap ownership is itself durable authority; never synthesize a grant.
create or replace function app.refresh_automatic_friends() returns trigger
language plpgsql set search_path = pg_catalog as $$
declare selected_library bigint; selected_account bigint;
begin
  if tg_table_name='accounts' then selected_account := new.id;
  else selected_account := new.account_id; end if;
  for selected_library in
    select m.library_id from library.library_memberships m
    where m.account_id = selected_account
    order by m.library_id
  loop
    perform app.sync_automatic_friends(selected_library);
  end loop;
  return new;
end $$;

drop trigger friend_social_grant on app.capabilities;
create trigger friend_browse_grant after insert or update on app.capabilities
  for each row when (new.revoked_at is null and new.capability_key in (
    'library.browse.read', 'capability.view', 'capability.social',
    'capability.play', 'capability.edit', 'capability.change_covers',
    'capability.delete', 'capability.create_loop', 'capability.practice',
    'capability.repair', 'capability.rules', 'capability.move'
  )) execute function app.refresh_automatic_friends();

-- CREATE OR REPLACE preserves existing runtime grants and invoker rights.
revoke all on function app.sync_automatic_friends(bigint) from public;
revoke all on function app.refresh_automatic_friends() from public;
