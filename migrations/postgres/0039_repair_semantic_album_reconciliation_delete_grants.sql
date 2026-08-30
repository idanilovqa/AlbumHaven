do $$
begin
  if exists (
    select 1
    from pg_roles
    where rolname = 'album_haven_app'
  ) then
    grant delete on table
      library.ignored_versions,
      library.manual_versions
    to album_haven_app;
  end if;
end $$;
