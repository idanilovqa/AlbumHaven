create table if not exists library.local_artist_family_links (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  artist_id bigint not null references library.local_artists(id) on delete cascade,
  related_artist_id bigint not null references library.local_artists(id) on delete cascade,
  relationship_weight smallint not null default 1,
  source_family text not null,
  source_ref text,
  metadata jsonb not null default '{}'::jsonb,
  constraint local_artist_family_links_not_self_check check (artist_id <> related_artist_id)
);

create index if not exists local_artist_family_links_library_id_idx
  on library.local_artist_family_links (library_id);

create index if not exists local_artist_family_links_artist_id_idx
  on library.local_artist_family_links (artist_id);

create index if not exists local_artist_family_links_related_artist_id_idx
  on library.local_artist_family_links (related_artist_id);

create index if not exists local_artist_family_links_library_artist_weight_idx
  on library.local_artist_family_links (library_id, artist_id, relationship_weight);

create index if not exists local_artist_family_links_library_related_artist_idx
  on library.local_artist_family_links (library_id, related_artist_id);

create unique index if not exists local_artist_family_links_identity_idx
  on library.local_artist_family_links (
    library_id,
    artist_id,
    related_artist_id,
    relationship_weight,
    source_family
  );

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    execute 'grant select on table library.local_artist_family_links to album_haven_readonly';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant select, insert, update on table library.local_artist_family_links to album_haven_app';
    execute 'grant usage, select on sequence library.local_artist_family_links_id_seq to album_haven_app';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    execute 'grant select, insert, update on table library.local_artist_family_links to album_haven_migrator';
    execute 'grant usage, select on sequence library.local_artist_family_links_id_seq to album_haven_migrator';
  end if;
end $$;
