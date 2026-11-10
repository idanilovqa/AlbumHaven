-- Cover saves counted outside library.libraries. The old counter lives in that
-- row's metadata next to the whole scan cache (over 1 MB on a 160k-file
-- library), so every cover save rewrote all of it and fired its two triggers:
-- ~200 ms of a ~300 ms save. New writers count here; readers add this to the
-- legacy metadata counter, which older builds still increment, so neither kind
-- of cover save is ever missed. Rows start at zero: nothing is inferred from
-- existing data and the legacy counter is left untouched.
create table if not exists library.cover_mutation_revisions (
    library_id bigint primary key references library.libraries(id) on delete cascade,
    cover_mutation_revision bigint not null default 0 check (cover_mutation_revision >= 0)
);

do $$
begin
    if exists (select 1 from pg_roles where rolname='album_haven_app') then
        grant select, insert, update on library.cover_mutation_revisions to album_haven_app;
    end if;
    if exists (select 1 from pg_roles where rolname='album_haven_readonly') then
        grant select on library.cover_mutation_revisions to album_haven_readonly;
    end if;
    if exists (select 1 from pg_roles where rolname='album_haven_migrator') then
        grant all privileges on library.cover_mutation_revisions to album_haven_migrator;
    end if;
end $$;
