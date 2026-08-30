do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant delete on table library.local_album_featured_artists to album_haven_app';
  end if;
end $$;
