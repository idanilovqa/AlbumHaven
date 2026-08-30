do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant delete on table library.local_artist_family_links to album_haven_app';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    execute 'grant delete on table library.local_artist_family_links to album_haven_migrator';
  end if;
end $$;
