-- The last complete Problematic Files list per library, so a restarted server
-- answers the first page and early searches at once (the cold candidate pass
-- is ~5 s on a 160k-file library) while the fresh list rebuilds. It is a cache
-- of derived output only: nothing user-owned is read, inferred or changed, and
-- the complete list always comes from a fresh build.
create table if not exists library.problematic_files_snapshots (
    library_id bigint primary key references library.libraries(id) on delete cascade,
    payload jsonb not null,
    built_at timestamptz not null default now()
);

do $$
begin
    if exists (select 1 from pg_roles where rolname='album_haven_app') then
        grant select, insert, update, delete on library.problematic_files_snapshots to album_haven_app;
    end if;
    if exists (select 1 from pg_roles where rolname='album_haven_readonly') then
        grant select on library.problematic_files_snapshots to album_haven_readonly;
    end if;
    if exists (select 1 from pg_roles where rolname='album_haven_migrator') then
        grant all privileges on library.problematic_files_snapshots to album_haven_migrator;
    end if;
end $$;
