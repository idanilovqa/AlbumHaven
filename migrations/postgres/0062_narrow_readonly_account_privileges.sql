do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on table app.accounts from album_haven_readonly;
    grant select (
      id, display_name, account_kind, is_active,
      created_at, updated_at, disabled_at, disabled_reason
    ) on app.accounts to album_haven_readonly;
  end if;
end $$;
