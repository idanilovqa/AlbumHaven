-- Reconcile duplicate persisted album identities created by structural tag
-- edits or scan publication. Explicitly separated releases remain untouched.
-- Migration execution holds the album table against concurrent writers while
-- the one-time all-library reconciliation is derived and applied.

lock table library.local_albums in share row exclusive mode;

drop table if exists pg_temp.semantic_album_candidates;
create temporary table semantic_album_candidates (
  redundant_album_id bigint primary key,
  canonical_album_id bigint not null,
  library_id bigint not null,
  redundant_album_key text not null,
  canonical_album_key text not null
) on commit drop;

insert into semantic_album_candidates (
  redundant_album_id,
  canonical_album_id,
  library_id,
  redundant_album_key,
  canonical_album_key
)
select
  ranked.album_id,
  ranked.canonical_album_id,
  ranked.library_id,
  ranked.album_key,
  ranked.canonical_album_key
from (
  select
    library.local_albums.id as album_id,
    library.local_albums.library_id,
    library.local_albums.album_key,
    min(library.local_albums.id) over (
      partition by
        library.local_albums.library_id,
        library.local_albums.artist_id,
        lower(btrim(library.local_albums.title)),
        library.local_albums.release_year,
        lower(
          btrim(
            coalesce(
              library.local_albums.metadata ->> 'edition',
              ''
            )
          )
        )
    ) as canonical_album_id,
    first_value(library.local_albums.album_key) over (
      partition by
        library.local_albums.library_id,
        library.local_albums.artist_id,
        lower(btrim(library.local_albums.title)),
        library.local_albums.release_year,
        lower(
          btrim(
            coalesce(
              library.local_albums.metadata ->> 'edition',
              ''
            )
          )
        )
      order by library.local_albums.id
    ) as canonical_album_key
  from library.local_albums
  left join library.local_artists
    on library.local_artists.id = library.local_albums.artist_id
   and library.local_artists.library_id = library.local_albums.library_id
  where nullif(btrim(library.local_albums.title), '') is not null
    and library.local_albums.artist_id is not null
    and not exists (
      select 1
      from library.separate_releases
      where library.separate_releases.library_id =
            library.local_albums.library_id
        and library.separate_releases.release_key = concat_ws(
              '::',
              lower(
                btrim(
                  coalesce(
                    nullif(
                      btrim(
                        library.local_albums.metadata ->> 'album_artist'
                      ),
                      ''
                    ),
                    library.local_artists.name,
                    ''
                  )
                )
              ),
              lower(btrim(library.local_albums.title)),
              nullif(
                lower(
                  btrim(
                    coalesce(
                      library.local_albums.metadata ->> 'edition',
                      ''
                    )
                  )
                ),
                ''
              )
            )
    )
) as ranked
where ranked.album_id <> ranked.canonical_album_id;

select library.local_albums.id
from library.local_albums
where library.local_albums.id in (
  select semantic_album_candidates.canonical_album_id
  from semantic_album_candidates
  union
  select semantic_album_candidates.redundant_album_id
  from semantic_album_candidates
)
order by library.local_albums.id
for update;

with semantic_album_members as (
  select distinct
    semantic_album_candidates.canonical_album_id,
    semantic_album_candidates.canonical_album_id as album_id
  from semantic_album_candidates
  union
  select
    semantic_album_candidates.canonical_album_id,
    semantic_album_candidates.redundant_album_id
  from semantic_album_candidates
),
metadata_candidates as (
  select
    semantic_album_members.canonical_album_id,
    semantic_album_members.album_id,
    metadata_entry.key,
    metadata_entry.value,
    case
      when metadata_entry.value = 'null'::jsonb then false
      when jsonb_typeof(metadata_entry.value) = 'string'
        then nullif(
          btrim(metadata_entry.value #>> '{}'),
          ''
        ) is not null
      when jsonb_typeof(metadata_entry.value) = 'array'
        then metadata_entry.value <> '[]'::jsonb
      when jsonb_typeof(metadata_entry.value) = 'object'
        then metadata_entry.value <> '{}'::jsonb
      else true
    end as metadata_value_is_meaningful
  from semantic_album_members
  join library.local_albums
    on library.local_albums.id = semantic_album_members.album_id
  cross join lateral jsonb_each(
    coalesce(library.local_albums.metadata, '{}'::jsonb)
  ) as metadata_entry
),
metadata_values as (
  select
    metadata_candidates.canonical_album_id,
    metadata_candidates.key,
    metadata_candidates.value,
    row_number() over (
      partition by
        metadata_candidates.canonical_album_id,
        metadata_candidates.key
      order by
        (
          metadata_candidates.album_id =
          metadata_candidates.canonical_album_id
          and metadata_value_is_meaningful
        ) desc,
        metadata_value_is_meaningful desc,
        (
          metadata_candidates.album_id =
          metadata_candidates.canonical_album_id
        ) desc,
        metadata_candidates.album_id
    ) as preference
  from metadata_candidates
),
merged_metadata as (
  select
    metadata_values.canonical_album_id,
    jsonb_object_agg(
      metadata_values.key,
      metadata_values.value
    ) as metadata
  from metadata_values
  where metadata_values.preference = 1
  group by metadata_values.canonical_album_id
),
merged_album_projection as (
  select
    semantic_album_members.canonical_album_id,
    (
      array_agg(
        nullif(btrim(library.local_albums.cover_path), '')
        order by
          (
            semantic_album_members.album_id =
            semantic_album_members.canonical_album_id
            and nullif(btrim(library.local_albums.cover_path), '') is not null
          ) desc,
          (
            nullif(btrim(library.local_albums.cover_path), '') is not null
          ) desc,
          semantic_album_members.album_id
      )
    )[1] as cover_path,
    min(library.local_albums.first_seen_at) as first_seen_at,
    max(library.local_albums.last_seen_at) as last_seen_at,
    (
      array_agg(
        semantic_album_members.album_id
        order by
          (library.local_albums.mbid is not null) desc,
          (
            library.local_albums.mbid_assertion_state <> 'unreviewed'
          ) desc,
          library.local_albums.evidence_confidence desc nulls last,
          (
            semantic_album_members.album_id =
            semantic_album_members.canonical_album_id
          ) desc,
          (library.local_albums.evidence_source is not null) desc,
          semantic_album_members.album_id
      )
    )[1] as best_evidence_album_id
  from semantic_album_members
  join library.local_albums
    on library.local_albums.id = semantic_album_members.album_id
  group by semantic_album_members.canonical_album_id
)
update library.local_albums
set
  cover_path = merged_album_projection.cover_path,
  first_seen_at = merged_album_projection.first_seen_at,
  last_seen_at = merged_album_projection.last_seen_at,
  mbid = best_evidence_album.mbid,
  mbid_assertion_state = best_evidence_album.mbid_assertion_state,
  evidence_source = best_evidence_album.evidence_source,
  evidence_confidence = best_evidence_album.evidence_confidence,
  mbid_assertion_migration_run_id =
    best_evidence_album.mbid_assertion_migration_run_id,
  mbid_assertion_scan_run_ref =
    best_evidence_album.mbid_assertion_scan_run_ref,
  metadata = coalesce(
    merged_metadata.metadata,
    library.local_albums.metadata
  )
from merged_album_projection
left join merged_metadata
  on merged_metadata.canonical_album_id =
     merged_album_projection.canonical_album_id
join library.local_albums as best_evidence_album
  on best_evidence_album.id =
     merged_album_projection.best_evidence_album_id
where library.local_albums.id =
      merged_album_projection.canonical_album_id;

insert into app.album_ratings (
  account_id,
  library_id,
  album_key,
  rating,
  provenance,
  created_at,
  updated_at,
  metadata
)
select distinct on (
  app.album_ratings.account_id,
  semantic_album_candidates.library_id,
  semantic_album_candidates.canonical_album_key
)
  app.album_ratings.account_id,
  semantic_album_candidates.library_id,
  semantic_album_candidates.canonical_album_key,
  app.album_ratings.rating,
  app.album_ratings.provenance,
  app.album_ratings.created_at,
  app.album_ratings.updated_at,
  app.album_ratings.metadata
from semantic_album_candidates
join app.album_ratings
  on app.album_ratings.library_id = semantic_album_candidates.library_id
 and app.album_ratings.album_key =
     semantic_album_candidates.redundant_album_key
order by
  app.album_ratings.account_id,
  semantic_album_candidates.library_id,
  semantic_album_candidates.canonical_album_key,
  (app.album_ratings.rating is not null) desc,
  app.album_ratings.updated_at desc,
  semantic_album_candidates.redundant_album_id
on conflict (account_id, library_id, album_key) do update
set
  rating = coalesce(app.album_ratings.rating, excluded.rating),
  provenance = case
    when app.album_ratings.rating is null and excluded.rating is not null
      then excluded.provenance
    else app.album_ratings.provenance
  end,
  created_at = least(app.album_ratings.created_at, excluded.created_at),
  updated_at = greatest(app.album_ratings.updated_at, excluded.updated_at),
  metadata = excluded.metadata || app.album_ratings.metadata;

delete from app.album_ratings
using semantic_album_candidates
where app.album_ratings.library_id = semantic_album_candidates.library_id
  and app.album_ratings.album_key =
      semantic_album_candidates.redundant_album_key;

insert into library.local_album_featured_artists (
  library_id,
  album_id,
  artist_id,
  featured_kind,
  first_seen_at,
  last_seen_at,
  metadata
)
select distinct on (
  library.local_album_featured_artists.library_id,
  semantic_album_candidates.canonical_album_id,
  library.local_album_featured_artists.artist_id,
  library.local_album_featured_artists.featured_kind
)
  library.local_album_featured_artists.library_id,
  semantic_album_candidates.canonical_album_id,
  library.local_album_featured_artists.artist_id,
  library.local_album_featured_artists.featured_kind,
  library.local_album_featured_artists.first_seen_at,
  library.local_album_featured_artists.last_seen_at,
  library.local_album_featured_artists.metadata
from semantic_album_candidates
join library.local_album_featured_artists
  on library.local_album_featured_artists.album_id =
     semantic_album_candidates.redundant_album_id
order by
  library.local_album_featured_artists.library_id,
  semantic_album_candidates.canonical_album_id,
  library.local_album_featured_artists.artist_id,
  library.local_album_featured_artists.featured_kind,
  library.local_album_featured_artists.last_seen_at desc,
  semantic_album_candidates.redundant_album_id
on conflict (library_id, album_id, artist_id, featured_kind) do update
set
  first_seen_at = least(
    library.local_album_featured_artists.first_seen_at,
    excluded.first_seen_at
  ),
  last_seen_at = greatest(
    library.local_album_featured_artists.last_seen_at,
    excluded.last_seen_at
  ),
  metadata = excluded.metadata
    || library.local_album_featured_artists.metadata;

delete from library.local_album_featured_artists
using semantic_album_candidates
where library.local_album_featured_artists.album_id =
      semantic_album_candidates.redundant_album_id;

update library.local_mbid_assertions
set
  album_id = semantic_album_candidates.canonical_album_id,
  target_key = case
    when library.local_mbid_assertions.target_kind = 'album'
      then semantic_album_candidates.canonical_album_key
    else library.local_mbid_assertions.target_key
  end
from semantic_album_candidates
where library.local_mbid_assertions.album_id =
      semantic_album_candidates.redundant_album_id;

insert into library.ignored_versions (
  library_id,
  version_key,
  created_at,
  metadata
)
select distinct on (
  library.ignored_versions.library_id,
  semantic_album_candidates.canonical_album_key
)
  library.ignored_versions.library_id,
  semantic_album_candidates.canonical_album_key,
  library.ignored_versions.created_at,
  library.ignored_versions.metadata
from semantic_album_candidates
join library.ignored_versions
  on library.ignored_versions.library_id =
     semantic_album_candidates.library_id
 and library.ignored_versions.version_key =
     semantic_album_candidates.redundant_album_key
order by
  library.ignored_versions.library_id,
  semantic_album_candidates.canonical_album_key,
  library.ignored_versions.created_at
on conflict (library_id, version_key) do update
set
  created_at = least(
    library.ignored_versions.created_at,
    excluded.created_at
  ),
  metadata = excluded.metadata || library.ignored_versions.metadata;

delete from library.ignored_versions
using semantic_album_candidates
where library.ignored_versions.library_id =
      semantic_album_candidates.library_id
  and library.ignored_versions.version_key =
      semantic_album_candidates.redundant_album_key;

insert into library.manual_versions (
  library_id,
  child_key,
  parent_key,
  created_at,
  updated_at,
  metadata
)
select distinct on (
  mapped_version.library_id,
  mapped_version.child_key
)
  mapped_version.library_id,
  mapped_version.child_key,
  mapped_version.parent_key,
  mapped_version.created_at,
  mapped_version.updated_at,
  mapped_version.metadata
from (
  select
    library.manual_versions.library_id,
    coalesce(
      child_candidate.canonical_album_key,
      library.manual_versions.child_key
    ) as child_key,
    coalesce(
      parent_candidate.canonical_album_key,
      library.manual_versions.parent_key
    ) as parent_key,
    library.manual_versions.child_key as original_child_key,
    library.manual_versions.created_at,
    library.manual_versions.updated_at,
    library.manual_versions.metadata
  from library.manual_versions
  left join semantic_album_candidates as child_candidate
    on child_candidate.library_id = library.manual_versions.library_id
   and child_candidate.redundant_album_key =
       library.manual_versions.child_key
  left join semantic_album_candidates as parent_candidate
    on parent_candidate.library_id = library.manual_versions.library_id
   and parent_candidate.redundant_album_key =
       library.manual_versions.parent_key
  where child_candidate.redundant_album_id is not null
     or parent_candidate.redundant_album_id is not null
) as mapped_version
where mapped_version.child_key <> mapped_version.parent_key
order by
  mapped_version.library_id,
  mapped_version.child_key,
  (mapped_version.original_child_key = mapped_version.child_key) desc,
  mapped_version.updated_at desc
on conflict (library_id, child_key) do update
set
  parent_key = excluded.parent_key,
  created_at = least(
    library.manual_versions.created_at,
    excluded.created_at
  ),
  updated_at = greatest(
    library.manual_versions.updated_at,
    excluded.updated_at
  ),
  metadata = excluded.metadata || library.manual_versions.metadata;

delete from library.manual_versions
using semantic_album_candidates
where library.manual_versions.library_id =
      semantic_album_candidates.library_id
  and (
    library.manual_versions.child_key =
      semantic_album_candidates.redundant_album_key
    or library.manual_versions.parent_key =
      semantic_album_candidates.redundant_album_key
  );

update ops.cover_lookup_tasks
set album_key = semantic_album_candidates.canonical_album_key
from semantic_album_candidates
where ops.cover_lookup_tasks.library_id =
      semantic_album_candidates.library_id
  and ops.cover_lookup_tasks.album_key =
      semantic_album_candidates.redundant_album_key;

update library.local_tracks
set album_id = semantic_album_candidates.canonical_album_id
from semantic_album_candidates
where library.local_tracks.album_id =
      semantic_album_candidates.redundant_album_id;

delete from library.local_albums
using semantic_album_candidates
where library.local_albums.id =
      semantic_album_candidates.redundant_album_id;

drop table if exists pg_temp.semantic_album_candidates;

-- Recurring runtime reconciliation needs only the two delete privileges that
-- were not already granted by earlier migrations.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute '
      grant delete on table
        app.album_ratings,
        library.local_albums
      to album_haven_app
    ';
  end if;
end $$;
