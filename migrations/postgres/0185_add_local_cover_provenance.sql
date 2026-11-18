-- Owner 2026-11-17: a cover downloaded from an online provider becomes an ordinary album file, so its
-- provider badge was lost. The provider is recorded per file when the save downloads it, and the album page
-- setting "Display provider badge for local covers" decides whether Album Details shows it.

create table if not exists library.local_cover_provenance (
    library_id bigint not null references library.libraries(id) on delete cascade,
    path text not null,
    source text not null,
    source_label text not null default '',
    lookup_task_id uuid,
    candidate_id text,
    created_at timestamptz not null default now(),
    primary key (library_id, path),
    constraint local_cover_provenance_path_check check (
        path = btrim(path) and char_length(path) between 1 and 4096
    ),
    constraint local_cover_provenance_source_check check (source ~ '^[a-z0-9_]{1,40}$'),
    constraint local_cover_provenance_label_check check (char_length(source_label) <= 120),
    constraint local_cover_provenance_candidate_check check (
        candidate_id is null or char_length(candidate_id) between 1 and 256
    )
);

revoke all on table library.local_cover_provenance from public;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
        grant select, insert, update, delete
        on table library.local_cover_provenance
        to album_haven_app;
    end if;
end;
$$;

-- The album page setting is a fourth, optional key of library_source_indicators: older saved settings
-- without it mean "on". The "keep one enabled" rule still covers only the three library-source choices.
alter table app.user_appearance_preferences
    drop constraint if exists user_appearance_library_source_indicators_check;

alter table app.user_appearance_preferences
    add constraint user_appearance_library_source_indicators_check check (
        jsonb_typeof(library_source_indicators) = 'object'
        and library_source_indicators ?& array['card_colors', 'hover_outline_colors', 'icons']
        and library_source_indicators
            - array['card_colors', 'hover_outline_colors', 'icons', 'local_cover_badges'] = '{}'::jsonb
        and jsonb_typeof(library_source_indicators -> 'card_colors') = 'boolean'
        and jsonb_typeof(library_source_indicators -> 'hover_outline_colors') = 'boolean'
        and jsonb_typeof(library_source_indicators -> 'icons') = 'boolean'
        and coalesce(jsonb_typeof(library_source_indicators -> 'local_cover_badges'), 'boolean') = 'boolean'
        and (library_source_indicators -> 'card_colors' = 'true'::jsonb
             or library_source_indicators -> 'hover_outline_colors' = 'true'::jsonb
             or library_source_indicators -> 'icons' = 'true'::jsonb)
    );
