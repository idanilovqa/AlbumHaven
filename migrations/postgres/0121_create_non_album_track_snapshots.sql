-- Derived Loose Tracks payload; no user-owned value is inferred or changed.
create table if not exists library.non_album_track_snapshots (
  library_id bigint primary key references library.libraries(id) on delete cascade,
  payload jsonb not null,
  built_at timestamptz not null default now()
);

do $$
begin
  if pg_catalog.to_regrole('album_haven_app') is not null then
    grant select, insert, update, delete on library.non_album_track_snapshots to album_haven_app;
  end if;
  if pg_catalog.to_regrole('album_haven_readonly') is not null then
    grant select on library.non_album_track_snapshots to album_haven_readonly;
  end if;
  if pg_catalog.to_regrole('album_haven_migrator') is not null then
    grant all privileges on library.non_album_track_snapshots to album_haven_migrator;
  end if;
end $$;
