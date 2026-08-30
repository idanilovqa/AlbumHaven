-- Repair two narrowly identified album-identity corruptions reported in Section 14.
--
-- The first repair only merges a legacy base-key album with its exact
-- `::year::<release_year>` twin when library, artist, normalized title, year,
-- and blank edition all agree. The second repair only accepts the literal
-- empty-ID3 projection `['']` when every track points at one real artist and
-- exactly one same-title/year album owned by that artist exists.

drop table if exists pg_temp.section14_album_merges;
create temporary table section14_album_merges (
  redundant_album_id bigint primary key,
  canonical_album_id bigint not null,
  canonical_artist_id bigint,
  malformed_artist_id bigint,
  repair_kind text not null
) on commit drop;

insert into section14_album_merges (
  redundant_album_id,
  canonical_album_id,
  canonical_artist_id,
  malformed_artist_id,
  repair_kind
)
select
  year_album.id,
  base_album.id,
  base_album.artist_id,
  null,
  'legacy_year_key_split'
from library.local_albums as base_album
join library.local_albums as year_album
  on year_album.library_id = base_album.library_id
 and year_album.artist_id is not distinct from base_album.artist_id
 and lower(btrim(year_album.title)) = lower(btrim(base_album.title))
 and year_album.release_year is not distinct from base_album.release_year
 and year_album.album_key = (
   base_album.album_key
   || '::year::'
   || base_album.release_year::text
 )
where base_album.release_year is not null
  and nullif(btrim(coalesce(base_album.metadata ->> 'edition', '')), '') is null
  and nullif(btrim(coalesce(year_album.metadata ->> 'edition', '')), '') is null
  and base_album.album_key not like '%::year::%'
  and (
    select count(*)
    from library.local_albums as exact_pair
    where exact_pair.library_id = base_album.library_id
      and exact_pair.artist_id is not distinct from base_album.artist_id
      and lower(btrim(exact_pair.title)) = lower(btrim(base_album.title))
      and exact_pair.release_year is not distinct from base_album.release_year
      and nullif(
        btrim(coalesce(exact_pair.metadata ->> 'edition', '')),
        ''
      ) is null
      and exact_pair.album_key in (
        base_album.album_key,
        base_album.album_key || '::year::' || base_album.release_year::text
      )
  ) = 2;

with malformed_candidates as (
  select
    bad_album.id as redundant_album_id,
    bad_album.library_id,
    bad_album.artist_id as malformed_artist_id,
    min(track.artist_id) as canonical_artist_id,
    count(*) as track_count,
    count(distinct track.artist_id) as track_artist_count
  from library.local_albums as bad_album
  join library.local_artists as bad_artist
    on bad_artist.id = bad_album.artist_id
   and bad_artist.library_id = bad_album.library_id
  join library.local_tracks as track
    on track.album_id = bad_album.id
   and track.library_id = bad_album.library_id
  where btrim(bad_artist.name) = '['''']'
    and btrim(bad_artist.artist_key) = '['''']'
    and bad_album.album_key like '['''']::%'
    and nullif(btrim(coalesce(bad_album.metadata ->> 'edition', '')), '') is null
    and track.artist_id is not null
    and track.artist_id <> bad_album.artist_id
    and not exists (
      select 1
      from library.local_tracks as incompatible_track
      where incompatible_track.album_id = bad_album.id
        and (
          incompatible_track.artist_id is null
          or incompatible_track.artist_id = bad_album.artist_id
        )
    )
  group by bad_album.id, bad_album.library_id, bad_album.artist_id
),
unambiguous_candidates as (
  select
    candidate.redundant_album_id,
    candidate.canonical_artist_id,
    candidate.malformed_artist_id,
    min(destination.id) as canonical_album_id,
    count(*) as destination_count
  from malformed_candidates as candidate
  join library.local_albums as bad_album
    on bad_album.id = candidate.redundant_album_id
  join library.local_artists as canonical_artist
    on canonical_artist.id = candidate.canonical_artist_id
   and canonical_artist.library_id = candidate.library_id
   and btrim(canonical_artist.name) <> '['''']'
   and btrim(canonical_artist.artist_key) <> '['''']'
  join library.local_albums as destination
    on destination.library_id = candidate.library_id
   and destination.artist_id = candidate.canonical_artist_id
   and lower(btrim(destination.title)) = lower(btrim(bad_album.title))
   and destination.release_year is not distinct from bad_album.release_year
   and nullif(
     btrim(coalesce(destination.metadata ->> 'edition', '')),
     ''
   ) is null
  where candidate.track_count > 0
    and candidate.track_artist_count = 1
  group by
    candidate.redundant_album_id,
    candidate.canonical_artist_id,
    candidate.malformed_artist_id
),
single_claim_candidates as (
  select
    unambiguous_candidates.*,
    count(*) over (
      partition by unambiguous_candidates.canonical_album_id
    ) as destination_claim_count
  from unambiguous_candidates
  where unambiguous_candidates.destination_count = 1
)
insert into section14_album_merges (
  redundant_album_id,
  canonical_album_id,
  canonical_artist_id,
  malformed_artist_id,
  repair_kind
)
select
  redundant_album_id,
  canonical_album_id,
  canonical_artist_id,
  malformed_artist_id,
  'literal_empty_id3_album_artist'
from single_claim_candidates
where destination_claim_count = 1
on conflict (redundant_album_id) do nothing;

do $$
declare
  unresolved_count bigint;
begin
  select count(*)
  into unresolved_count
  from library.local_albums as bad_album
  join library.local_artists as bad_artist
    on bad_artist.id = bad_album.artist_id
   and bad_artist.library_id = bad_album.library_id
  where btrim(bad_artist.name) = '['''']'
    and btrim(bad_artist.artist_key) = '['''']'
    and bad_album.album_key like '['''']::%'
    and not exists (
      select 1
      from section14_album_merges as accepted
      where accepted.redundant_album_id = bad_album.id
        and accepted.repair_kind = 'literal_empty_id3_album_artist'
    );

  if unresolved_count > 0 then
    raise warning
      'Section 14 left % ambiguous literal empty-ID3 album artist row(s) untouched',
      unresolved_count;
  end if;
end;
$$;

create temporary table section14_malformed_tracks
on commit drop
as
select
  track.id as track_id,
  merge.canonical_album_id,
  canonical_artist.name as canonical_artist_name
from section14_album_merges as merge
join library.local_tracks as track
  on track.album_id = merge.redundant_album_id
join library.local_artists as canonical_artist
  on canonical_artist.id = merge.canonical_artist_id
where merge.repair_kind = 'literal_empty_id3_album_artist';

-- Preserve the strongest available album projection while retaining the
-- legacy base-key row as the stable identity.
update library.local_albums as canonical
set
  mbid = case
    when canonical.mbid is not null then canonical.mbid
    else redundant.mbid
  end,
  mbid_assertion_state = case
    when canonical.mbid is not null then canonical.mbid_assertion_state
    when redundant.mbid is not null then redundant.mbid_assertion_state
    when coalesce(redundant.evidence_confidence, -1)
      > coalesce(canonical.evidence_confidence, -1)
      then redundant.mbid_assertion_state
    else canonical.mbid_assertion_state
  end,
  evidence_source = case
    when canonical.mbid is not null then canonical.evidence_source
    when redundant.mbid is not null then redundant.evidence_source
    when coalesce(redundant.evidence_confidence, -1)
      > coalesce(canonical.evidence_confidence, -1)
      then redundant.evidence_source
    else canonical.evidence_source
  end,
  evidence_confidence = greatest(
    canonical.evidence_confidence,
    redundant.evidence_confidence
  ),
  mbid_assertion_migration_run_id = case
    when canonical.mbid is not null then canonical.mbid_assertion_migration_run_id
    when redundant.mbid is not null then redundant.mbid_assertion_migration_run_id
    else coalesce(
      canonical.mbid_assertion_migration_run_id,
      redundant.mbid_assertion_migration_run_id
    )
  end,
  mbid_assertion_scan_run_ref = case
    when canonical.mbid is not null then canonical.mbid_assertion_scan_run_ref
    when redundant.mbid is not null then redundant.mbid_assertion_scan_run_ref
    else coalesce(
      canonical.mbid_assertion_scan_run_ref,
      redundant.mbid_assertion_scan_run_ref
    )
  end,
  cover_path = coalesce(
    nullif(btrim(canonical.cover_path), ''),
    nullif(btrim(redundant.cover_path), '')
  ),
  first_seen_at = least(canonical.first_seen_at, redundant.first_seen_at),
  last_seen_at = greatest(canonical.last_seen_at, redundant.last_seen_at),
  metadata = redundant.metadata || canonical.metadata
from section14_album_merges as merge
join library.local_albums as redundant
  on redundant.id = merge.redundant_album_id
where canonical.id = merge.canonical_album_id;

-- Ratings are re-keyed before the redundant album is deleted. A conflicting
-- non-null value remains inspectable in metadata instead of being discarded.
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
select
  rating.account_id,
  rating.library_id,
  canonical.album_key,
  rating.rating,
  rating.provenance,
  rating.created_at,
  rating.updated_at,
  rating.metadata
from section14_album_merges as merge
join library.local_albums as redundant
  on redundant.id = merge.redundant_album_id
join library.local_albums as canonical
  on canonical.id = merge.canonical_album_id
join app.album_ratings as rating
  on rating.library_id = redundant.library_id
 and rating.album_key = redundant.album_key
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
  metadata = excluded.metadata
    || app.album_ratings.metadata
    || case
      when app.album_ratings.rating is not null
       and excluded.rating is not null
       and app.album_ratings.rating <> excluded.rating
      then jsonb_build_object(
        'section_14_repair',
        jsonb_build_object(
          'preserved_merged_rating',
          excluded.rating,
          'canonical_rating',
          app.album_ratings.rating
        )
      )
      else '{}'::jsonb
    end;

delete from app.album_ratings as rating
using section14_album_merges as merge,
      library.local_albums as redundant
where redundant.id = merge.redundant_album_id
  and rating.library_id = redundant.library_id
  and rating.album_key = redundant.album_key;

with remapped_featured as (
  select
    featured.library_id,
    merge.canonical_album_id as album_id,
    case
      when featured.artist_id = merge.malformed_artist_id
        then merge.canonical_artist_id
      else featured.artist_id
    end as artist_id,
    featured.featured_kind,
    min(featured.first_seen_at) over (
      partition by
        featured.library_id,
        merge.canonical_album_id,
        case
          when featured.artist_id = merge.malformed_artist_id
            then merge.canonical_artist_id
          else featured.artist_id
        end,
        featured.featured_kind
    ) as first_seen_at,
    max(featured.last_seen_at) over (
      partition by
        featured.library_id,
        merge.canonical_album_id,
        case
          when featured.artist_id = merge.malformed_artist_id
            then merge.canonical_artist_id
          else featured.artist_id
        end,
        featured.featured_kind
    ) as last_seen_at,
    featured.metadata
  from section14_album_merges as merge
  join library.local_album_featured_artists as featured
    on featured.album_id = merge.redundant_album_id
),
deduplicated_featured as (
  select distinct on (library_id, album_id, artist_id, featured_kind)
    library_id,
    album_id,
    artist_id,
    featured_kind,
    first_seen_at,
    last_seen_at,
    metadata
  from remapped_featured
  order by
    library_id,
    album_id,
    artist_id,
    featured_kind,
    (metadata = '{}'::jsonb),
    last_seen_at desc
)
insert into library.local_album_featured_artists (
  library_id,
  album_id,
  artist_id,
  featured_kind,
  first_seen_at,
  last_seen_at,
  metadata
)
select
  library_id,
  album_id,
  artist_id,
  featured_kind,
  first_seen_at,
  last_seen_at,
  metadata
from deduplicated_featured
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
  metadata = excluded.metadata || library.local_album_featured_artists.metadata;

delete from library.local_album_featured_artists as featured
using section14_album_merges as merge
where featured.album_id = merge.redundant_album_id;

-- Move review evidence before deleting either malformed identity.
update library.local_mbid_assertions as assertion
set
  album_id = case
    when assertion.album_id = merge.redundant_album_id
      then merge.canonical_album_id
    else assertion.album_id
  end,
  artist_id = case
    when assertion.artist_id = merge.malformed_artist_id
      then merge.canonical_artist_id
    else assertion.artist_id
  end,
  target_key = case
    when assertion.target_kind = 'album' then canonical.album_key
    when assertion.target_kind = 'artist' then canonical_artist.artist_key
    else assertion.target_key
  end,
  source_payload = assertion.source_payload || jsonb_build_object(
    'section_14_repair',
    merge.repair_kind
  )
from section14_album_merges as merge
join library.local_albums as canonical
  on canonical.id = merge.canonical_album_id
left join library.local_artists as canonical_artist
  on canonical_artist.id = merge.canonical_artist_id
where assertion.album_id = merge.redundant_album_id
   or (
     merge.malformed_artist_id is not null
     and assertion.artist_id = merge.malformed_artist_id
   );

delete from library.local_mbid_assertions as duplicate
using library.local_mbid_assertions as keeper
where duplicate.id > keeper.id
  and duplicate.library_id = keeper.library_id
  and duplicate.target_kind = keeper.target_kind
  and duplicate.target_key = keeper.target_key
  and duplicate.artist_id is not distinct from keeper.artist_id
  and duplicate.album_id is not distinct from keeper.album_id
  and duplicate.track_id is not distinct from keeper.track_id
  and duplicate.evidence_source = keeper.evidence_source
  and duplicate.mbid is not distinct from keeper.mbid
  and duplicate.mbid_assertion_state = keeper.mbid_assertion_state
  and duplicate.confidence is not distinct from keeper.confidence
  and duplicate.explanation is not distinct from keeper.explanation
  and duplicate.observed_at is not distinct from keeper.observed_at
  and duplicate.migration_run_id is not distinct from keeper.migration_run_id
  and duplicate.source_payload = keeper.source_payload
  and (
    duplicate.album_id in (
      select canonical_album_id from section14_album_merges
    )
    or duplicate.artist_id in (
      select canonical_artist_id
      from section14_album_merges
      where malformed_artist_id is not null
    )
  );

update library.local_artist_mbid_assertions as assertion
set
  artist_id = merge.canonical_artist_id,
  source_payload = assertion.source_payload || jsonb_build_object(
    'section_14_repair',
    merge.repair_kind
  )
from section14_album_merges as merge
where merge.malformed_artist_id is not null
  and assertion.artist_id = merge.malformed_artist_id;

delete from library.local_artist_mbid_assertions as duplicate
using library.local_artist_mbid_assertions as keeper
where duplicate.id > keeper.id
  and duplicate.artist_id = keeper.artist_id
  and duplicate.evidence_source = keeper.evidence_source
  and duplicate.mbid is not distinct from keeper.mbid
  and duplicate.mbid_assertion_state = keeper.mbid_assertion_state
  and duplicate.confidence is not distinct from keeper.confidence
  and duplicate.explanation is not distinct from keeper.explanation
  and duplicate.observed_at is not distinct from keeper.observed_at
  and duplicate.migration_run_id is not distinct from keeper.migration_run_id
  and duplicate.mbid_assertion_scan_run_ref is not distinct from keeper.mbid_assertion_scan_run_ref
  and duplicate.source_payload = keeper.source_payload
  and duplicate.artist_id in (
    select canonical_artist_id
    from section14_album_merges
    where malformed_artist_id is not null
  );

-- `scan_file_album_artist` is a stored generated column over this JSON path
-- (migration 0021), so changing the source metadata recomputes that projection
-- automatically. `scan_file_entry_is_object` remains true because the object
-- shape does not change.
-- `scan_file_album_artist` is a stored generated column over this JSON path
-- (migration 0021), so changing the source metadata recomputes that projection
-- automatically. `scan_file_entry_is_object` remains true because the object
-- shape does not change.
update library.local_track_files as track_file
set metadata = case
  when track_file.metadata #>> '{scan_cache,file_entry,album_artist}' = '['''']'
    then jsonb_set(
      track_file.metadata,
      '{scan_cache,file_entry,album_artist}',
      to_jsonb(malformed_track.canonical_artist_name),
      false
    )
  else track_file.metadata
end
from section14_malformed_tracks as malformed_track
where malformed_track.track_id = track_file.track_id;

update library.local_tracks as track
set album_id = merge.canonical_album_id
from section14_album_merges as merge
where track.album_id = merge.redundant_album_id;

delete from library.local_albums as redundant
using section14_album_merges as merge
where redundant.id = merge.redundant_album_id;

-- Artist-family links are a folder-derived runtime projection. Accepted
-- malformed artists cannot remain valid endpoints, and their canonical artist
-- already owns the meaningful projection, so remove every edge involving the
-- malformed identity (including edges that would become canonical self-links).
delete from library.local_artist_family_links as family_link
using (
  select distinct malformed_artist_id
  from section14_album_merges
  where malformed_artist_id is not null
) as repaired
where family_link.artist_id = repaired.malformed_artist_id
   or family_link.related_artist_id = repaired.malformed_artist_id;

delete from library.local_artists as bad_artist
using (
  select distinct malformed_artist_id
  from section14_album_merges
  where malformed_artist_id is not null
) as repaired
where bad_artist.id = repaired.malformed_artist_id
  and btrim(bad_artist.name) = '['''']'
  and btrim(bad_artist.artist_key) = '['''']'
  and not exists (
    select 1 from library.local_albums
    where local_albums.artist_id = bad_artist.id
  )
  and not exists (
    select 1 from library.local_tracks
    where local_tracks.artist_id = bad_artist.id
  )
  and not exists (
    select 1 from library.local_album_featured_artists
    where local_album_featured_artists.artist_id = bad_artist.id
  )
  and not exists (
    select 1 from library.local_artist_family_links
    where local_artist_family_links.artist_id = bad_artist.id
       or local_artist_family_links.related_artist_id = bad_artist.id
  )
  and not exists (
    select 1 from library.local_artist_mbid_assertions
    where local_artist_mbid_assertions.artist_id = bad_artist.id
  )
  and not exists (
    select 1 from library.local_mbid_assertions
    where local_mbid_assertions.artist_id = bad_artist.id
  );

drop table if exists pg_temp.section14_malformed_tracks;
drop table if exists pg_temp.section14_album_merges;
