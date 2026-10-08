-- Root-setting saves replace the move-policy rows in the same transaction.
-- Upgraded databases that omitted 0020 need only this runtime DELETE grant.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant delete on table library.move_policy_settings to album_haven_app';
  end if;
end $$;
