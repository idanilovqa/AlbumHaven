do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant delete on table library.library_memberships to album_haven_app';
  end if;
end $$;
