do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    grant usage on schema app, library to album_haven_worker;
    revoke select on table app.accounts from album_haven_worker;
    revoke select on table app.bootstrap_owners from album_haven_worker;
    revoke select on table library.libraries from album_haven_worker;
    revoke select on table library.library_memberships from album_haven_worker;
    revoke select on table app.capabilities from album_haven_worker;
    revoke select on table app.request_origins from album_haven_worker;
    grant select (id, is_active, disabled_at)
      on table app.accounts to album_haven_worker;
    grant select (account_id, owner_key)
      on table app.bootstrap_owners to album_haven_worker;
    grant select (id, owner_account_id)
      on table library.libraries to album_haven_worker;
    grant select (library_id, account_id, membership_role)
      on table library.library_memberships to album_haven_worker;
    grant select (
      account_id, capability_key, scope_kind, scope_id, revoked_at
    ) on table app.capabilities to album_haven_worker;
    grant select (
      id, account_id, client_surface_class, origin_type
    ) on table app.request_origins to album_haven_worker;
  end if;
end $$;
