do $$
begin
  if exists (
    select 1
    from pg_roles
    where rolname = 'album_haven_app'
  ) then
    grant delete on table library.ignored_repairs to album_haven_app;
  end if;
end $$;
