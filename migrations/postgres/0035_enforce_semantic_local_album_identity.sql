-- Prevent semantic local-album identities repaired by migration 0034 from
-- splitting again. Enforcement is row-local and concurrency-safe: ordinary
-- albums share the empty discriminator, while releases explicitly separated
-- by the owner use their stable album keys as discriminators.

drop trigger if exists local_albums_semantic_identity_check
  on library.local_albums;
drop trigger if exists separate_releases_semantic_identity_check
  on library.separate_releases;
drop trigger if exists local_artists_semantic_identity_check
  on library.local_artists;
drop trigger if exists local_albums_semantic_identity_discriminator
  on library.local_albums;
drop trigger if exists separate_releases_semantic_identity_discriminator
  on library.separate_releases;
drop trigger if exists separate_releases_semantic_identity_reconciliation
  on library.separate_releases;
drop trigger if exists local_artists_semantic_identity_discriminator
  on library.local_artists;
drop trigger if exists separate_releases_inventory_publication_lock
  on library.separate_releases;
drop trigger if exists local_artists_inventory_publication_lock
  on library.local_artists;
drop function if exists library.enforce_semantic_local_album_identity();

alter table library.local_albums
  add column if not exists semantic_identity_discriminator
    text not null default '';

create or replace function library.acquire_inventory_publication_lock()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(
    hashtext('album-haven:local-inventory-publication')
  );
  return null;
end;
$$;

create trigger separate_releases_inventory_publication_lock
before insert or delete or update
on library.separate_releases
for each statement
execute function library.acquire_inventory_publication_lock();

create trigger local_artists_inventory_publication_lock
before update
on library.local_artists
for each statement
execute function library.acquire_inventory_publication_lock();

-- Match the release-key contract used by runtime reconciliation. A whitespace
-- album-artist tag is absent and therefore falls back to the canonical artist.
update library.local_albums as albums
set semantic_identity_discriminator = case
  when exists (
    select 1
    from library.local_artists as artists
    join library.separate_releases as separate_releases
      on separate_releases.library_id = albums.library_id
     and separate_releases.release_key = concat_ws(
           '::',
           lower(
             btrim(
               coalesce(
                 nullif(btrim(albums.metadata ->> 'album_artist'), ''),
                 artists.name,
                 ''
               )
             )
           ),
           lower(btrim(albums.title)),
           nullif(
             lower(
               btrim(coalesce(albums.metadata ->> 'edition', ''))
             ),
             ''
           )
         )
    where artists.id = albums.artist_id
      and artists.library_id = albums.library_id
  )
    then albums.album_key
  else ''
end;

create unique index if not exists local_albums_semantic_identity_key
  on library.local_albums (
    library_id,
    artist_id,
    lower(btrim(title)),
    release_year,
    lower(btrim(coalesce(metadata ->> 'edition', ''))),
    semantic_identity_discriminator
  )
  nulls not distinct
  where artist_id is not null
    and nullif(btrim(title), '') is not null;

create or replace function library.set_local_album_semantic_discriminator()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from library.local_artists as artists
    join library.separate_releases as separate_releases
      on separate_releases.library_id = new.library_id
     and separate_releases.release_key = concat_ws(
           '::',
           lower(
             btrim(
               coalesce(
                 nullif(btrim(new.metadata ->> 'album_artist'), ''),
                 artists.name,
                 ''
               )
             )
           ),
           lower(btrim(new.title)),
           nullif(
             lower(btrim(coalesce(new.metadata ->> 'edition', ''))),
             ''
           )
         )
    where artists.id = new.artist_id
      and artists.library_id = new.library_id
  ) then
    new.semantic_identity_discriminator := new.album_key;
  else
    new.semantic_identity_discriminator := '';
  end if;
  return new;
end;
$$;

create trigger local_albums_semantic_identity_discriminator
before insert or update of
  library_id, artist_id, album_key, title, release_year, metadata,
  semantic_identity_discriminator
on library.local_albums
for each row
execute function library.set_local_album_semantic_discriminator();

create or replace function library.reconcile_removed_separate_release(
  target_library_id bigint,
  target_release_key text
)
returns void
language plpgsql
as $$
declare
  canonical record;
begin
  perform pg_advisory_xact_lock(
    hashtext('album-haven:local-inventory-publication')
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'album_haven:semantic-local-album-reconciliation:'
        || target_library_id::text,
      0
    )
  );

  for canonical in
    select
      min(albums.id) as album_id,
      (array_agg(albums.album_key order by albums.id))[1] as album_key,
      albums.artist_id,
      lower(btrim(albums.title)) as normalized_title,
      albums.release_year,
      lower(btrim(coalesce(albums.metadata ->> 'edition', '')))
        as normalized_edition
    from library.local_albums as albums
    join library.local_artists as artists
      on artists.id = albums.artist_id
     and artists.library_id = albums.library_id
    where albums.library_id = target_library_id
      and target_release_key = concat_ws(
            '::',
            lower(
              btrim(
                coalesce(
                  nullif(btrim(albums.metadata ->> 'album_artist'), ''),
                  artists.name,
                  ''
                )
              )
            ),
            lower(btrim(albums.title)),
            nullif(
              lower(btrim(coalesce(albums.metadata ->> 'edition', ''))),
              ''
            )
          )
    group by
      albums.artist_id,
      lower(btrim(albums.title)),
      albums.release_year,
      lower(btrim(coalesce(albums.metadata ->> 'edition', '')))
    having count(*) > 1
  loop
    perform albums.id
    from library.local_albums as albums
    where albums.library_id = target_library_id
      and albums.artist_id = canonical.artist_id
      and lower(btrim(albums.title)) = canonical.normalized_title
      and albums.release_year is not distinct from canonical.release_year
      and lower(btrim(coalesce(albums.metadata ->> 'edition', ''))) =
          canonical.normalized_edition
    order by albums.id
    for update;

    with semantic_album_members as (
      select albums.id as album_id
      from library.local_albums as albums
      where albums.library_id = target_library_id
        and albums.artist_id = canonical.artist_id
        and lower(btrim(albums.title)) = canonical.normalized_title
        and albums.release_year is not distinct from canonical.release_year
        and lower(btrim(coalesce(albums.metadata ->> 'edition', ''))) =
            canonical.normalized_edition
    ),
    metadata_candidates as (
      select
        members.album_id,
        metadata_entry.key,
        metadata_entry.value,
        case
          when metadata_entry.value = 'null'::jsonb then false
          when jsonb_typeof(metadata_entry.value) = 'string'
            then nullif(btrim(metadata_entry.value #>> '{}'), '') is not null
          when jsonb_typeof(metadata_entry.value) = 'array'
            then metadata_entry.value <> '[]'::jsonb
          when jsonb_typeof(metadata_entry.value) = 'object'
            then metadata_entry.value <> '{}'::jsonb
          else true
        end as value_is_meaningful
      from semantic_album_members as members
      join library.local_albums as albums on albums.id = members.album_id
      cross join lateral jsonb_each(
        coalesce(albums.metadata, '{}'::jsonb)
      ) as metadata_entry
    ),
    metadata_values as (
      select
        metadata_candidates.key,
        metadata_candidates.value,
        row_number() over (
          partition by metadata_candidates.key
          order by
            (
              metadata_candidates.album_id = canonical.album_id
              and metadata_candidates.value_is_meaningful
            ) desc,
            metadata_candidates.value_is_meaningful desc,
            (
              metadata_candidates.album_id = canonical.album_id
            ) desc,
            metadata_candidates.album_id
        ) as preference
      from metadata_candidates
    ),
    merged_metadata as (
      select jsonb_object_agg(key, value) as metadata
      from metadata_values
      where preference = 1
    ),
    merged_projection as (
      select
        (
          array_agg(
            nullif(btrim(albums.cover_path), '')
            order by
              (
                members.album_id = canonical.album_id
                and nullif(btrim(albums.cover_path), '') is not null
              ) desc,
              (nullif(btrim(albums.cover_path), '') is not null) desc,
              members.album_id
          )
        )[1] as cover_path,
        min(albums.first_seen_at) as first_seen_at,
        max(albums.last_seen_at) as last_seen_at,
        (
          array_agg(
            members.album_id
            order by
              (albums.mbid is not null) desc,
              (albums.mbid_assertion_state <> 'unreviewed') desc,
              albums.evidence_confidence desc nulls last,
              (members.album_id = canonical.album_id) desc,
              (albums.evidence_source is not null) desc,
              members.album_id
          )
        )[1] as best_evidence_album_id
      from semantic_album_members as members
      join library.local_albums as albums on albums.id = members.album_id
    )
    update library.local_albums as survivor
    set
      cover_path = merged_projection.cover_path,
      first_seen_at = merged_projection.first_seen_at,
      last_seen_at = merged_projection.last_seen_at,
      mbid = best_evidence.mbid,
      mbid_assertion_state = best_evidence.mbid_assertion_state,
      evidence_source = best_evidence.evidence_source,
      evidence_confidence = best_evidence.evidence_confidence,
      mbid_assertion_migration_run_id =
        best_evidence.mbid_assertion_migration_run_id,
      mbid_assertion_scan_run_ref =
        best_evidence.mbid_assertion_scan_run_ref,
      metadata = coalesce(merged_metadata.metadata, survivor.metadata)
    from merged_projection
    cross join merged_metadata
    join library.local_albums as best_evidence
      on best_evidence.id = merged_projection.best_evidence_album_id
    where survivor.id = canonical.album_id;

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
      albums.id,
      canonical.album_id,
      albums.library_id,
      albums.album_key,
      canonical.album_key
    from library.local_albums as albums
    where albums.library_id = target_library_id
      and albums.artist_id = canonical.artist_id
      and lower(btrim(albums.title)) = canonical.normalized_title
      and albums.release_year is not distinct from canonical.release_year
      and lower(btrim(coalesce(albums.metadata ->> 'edition', ''))) =
          canonical.normalized_edition
      and albums.id <> canonical.album_id;

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
  end loop;
end;
$$;

create or replace function library.sync_separate_release_discriminators()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('DELETE', 'UPDATE')
     and (
       tg_op = 'DELETE'
       or old.library_id is distinct from new.library_id
       or old.release_key is distinct from new.release_key
     )
  then
    perform library.reconcile_removed_separate_release(
      old.library_id,
      old.release_key
    );

    update library.local_albums as albums
    set semantic_identity_discriminator = ''
    from library.local_artists as artists
    where albums.library_id = old.library_id
      and artists.id = albums.artist_id
      and artists.library_id = albums.library_id
      and old.release_key = concat_ws(
            '::',
            lower(
              btrim(
                coalesce(
                  nullif(btrim(albums.metadata ->> 'album_artist'), ''),
                  artists.name,
                  ''
                )
              )
            ),
            lower(btrim(albums.title)),
            nullif(
              lower(
                btrim(coalesce(albums.metadata ->> 'edition', ''))
              ),
              ''
            )
          );
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    update library.local_albums as albums
    set semantic_identity_discriminator = albums.album_key
    from library.local_artists as artists
    where albums.library_id = new.library_id
      and artists.id = albums.artist_id
      and artists.library_id = albums.library_id
      and new.release_key = concat_ws(
            '::',
            lower(
              btrim(
                coalesce(
                  nullif(btrim(albums.metadata ->> 'album_artist'), ''),
                  artists.name,
                  ''
                )
              )
            ),
            lower(btrim(albums.title)),
            nullif(
              lower(
                btrim(coalesce(albums.metadata ->> 'edition', ''))
              ),
              ''
            )
          );
  end if;

  update library.libraries
  set metadata = jsonb_set(
    coalesce(metadata, '{}'::jsonb),
    '{inventory_mutation_revision}',
    to_jsonb(
      coalesce(
        nullif(metadata ->> 'inventory_mutation_revision', '')::bigint,
        0
      ) + 1
    ),
    true
  )
  where id in (
    case when tg_op in ('INSERT', 'UPDATE') then new.library_id end,
    case when tg_op in ('DELETE', 'UPDATE') then old.library_id end
  );

  return null;
end;
$$;

create trigger separate_releases_semantic_identity_discriminator
after insert or delete or update of library_id, release_key
on library.separate_releases
for each row
execute function library.sync_separate_release_discriminators();

create or replace function library.refresh_artist_album_semantic_discriminators()
returns trigger
language plpgsql
as $$
declare
  marker record;
  rewritten_release_key text;
begin
  if old.library_id is distinct from new.library_id then
    raise exception using
      errcode = '23514',
      constraint = 'local_artists_library_id_immutable',
      message = format(
        'local artist %s cannot move from library %s to library %s',
        new.id,
        old.library_id,
        new.library_id
      );
  end if;

  perform pg_advisory_xact_lock(
    hashtext('album-haven:local-inventory-publication')
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'album_haven:semantic-local-album-reconciliation:'
        || new.library_id::text,
      0
    )
  );
  for marker in
    select distinct
      separate_releases.library_id,
      separate_releases.release_key,
      separate_releases.created_at,
      separate_releases.metadata,
      lower(btrim(albums.title)) as normalized_title,
      nullif(
        lower(btrim(coalesce(albums.metadata ->> 'edition', ''))),
        ''
      ) as normalized_edition
    from library.local_albums as albums
    join library.separate_releases as separate_releases
      on separate_releases.library_id = albums.library_id
     and separate_releases.release_key = concat_ws(
           '::',
           lower(btrim(old.name)),
           lower(btrim(albums.title)),
           nullif(
             lower(btrim(coalesce(albums.metadata ->> 'edition', ''))),
             ''
           )
         )
    where albums.artist_id = new.id
      and albums.library_id = new.library_id
      and nullif(btrim(albums.metadata ->> 'album_artist'), '') is null
  loop
    rewritten_release_key := concat_ws(
      '::',
      lower(btrim(new.name)),
      marker.normalized_title,
      marker.normalized_edition
    );
    if rewritten_release_key <> marker.release_key then
      insert into library.separate_releases (
        library_id, release_key, created_at, metadata
      )
      values (
        marker.library_id, rewritten_release_key,
        marker.created_at, marker.metadata
      )
      on conflict (library_id, release_key) do update
      set
        created_at = least(
          library.separate_releases.created_at,
          excluded.created_at
        ),
        metadata = excluded.metadata || library.separate_releases.metadata;

      delete from library.separate_releases
      where library_id = marker.library_id
        and release_key = marker.release_key
        and not exists (
          select 1
          from library.local_albums as retained_albums
          join library.local_artists as retained_artists
            on retained_artists.id = retained_albums.artist_id
           and retained_artists.library_id = retained_albums.library_id
          where retained_albums.library_id = marker.library_id
            and marker.release_key = concat_ws(
                  '::',
                  lower(
                    btrim(
                      coalesce(
                        nullif(
                          btrim(
                            retained_albums.metadata ->> 'album_artist'
                          ),
                          ''
                        ),
                        retained_artists.name,
                        ''
                      )
                    )
                  ),
                  lower(btrim(retained_albums.title)),
                  nullif(
                    lower(
                      btrim(
                        coalesce(
                          retained_albums.metadata ->> 'edition',
                          ''
                        )
                      )
                    ),
                    ''
                  )
                )
        );
    end if;
  end loop;
  update library.local_albums as albums
  set semantic_identity_discriminator =
        albums.semantic_identity_discriminator
  where albums.artist_id = new.id
    and albums.library_id = new.library_id;

  update library.libraries
  set metadata = jsonb_set(
    coalesce(metadata, '{}'::jsonb),
    '{inventory_mutation_revision}',
    to_jsonb(
      coalesce(
        nullif(metadata ->> 'inventory_mutation_revision', '')::bigint,
        0
      ) + 1
    ),
    true
  )
  where id = new.library_id;
  return null;
end;
$$;

create trigger local_artists_semantic_identity_discriminator
after update of library_id, name
on library.local_artists
for each row
when (
  old.library_id is distinct from new.library_id
  or old.name is distinct from new.name
)
execute function library.refresh_artist_album_semantic_discriminators();
