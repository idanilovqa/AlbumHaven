-- Additive derived storage. Source rows remain authoritative. Rollback after
-- readers stop: drop the gallery_source_* triggers on the eight source tables, then these functions
-- and gallery_projection_occurrences/snapshots/state in dependency order.
create table if not exists library.gallery_projection_state (
  library_id bigint primary key references library.libraries(id) on delete cascade,
  generation bigint not null default 0 check (generation >= 0),
  last_invalidation_xid xid8
);
create table if not exists library.gallery_projection_snapshots (
  library_id bigint not null references library.gallery_projection_state(library_id) on delete cascade,
  scope_key text not null check (scope_key ~ '^[0-9a-f]{64}$'),
  source_generation bigint not null check (source_generation >= 0),
  builder_version text not null check (btrim(builder_version) <> '' and octet_length(builder_version) <= 128),
  revision text not null check (revision ~ '^[0-9a-f]{64}$'),
  sidebar jsonb not null check (jsonb_typeof(sidebar) = 'array'),
  album_count bigint not null check (album_count >= 0),
  occurrence_count bigint not null check (occurrence_count >= 0),
  primary key (library_id, scope_key)
);
create table if not exists library.gallery_projection_occurrences (
  library_id bigint not null,
  scope_key text not null,
  ordinal bigint not null check (ordinal >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (library_id, scope_key, ordinal),
  foreign key (library_id, scope_key) references library.gallery_projection_snapshots(library_id, scope_key) on delete cascade
);
insert into library.gallery_projection_state(library_id)
select id from library.libraries on conflict (library_id) do nothing;

-- Compare only membership/order/alias dependencies, never cover/rating fields.
-- Explicit JSON null differs from a missing exception_type key because the
-- production path uses the ? operator before choosing the track/file fallback.
create or replace function library.gallery_source_dependency(source_table text, source_row jsonb)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select case source_table
    when 'local_albums' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'library_id',
      source_row -> 'artist_id',
      source_row -> 'album_key',
      source_row -> 'title',
      source_row -> 'release_year',
      source_row #> '{metadata,root_provenance}',
      source_row #> '{metadata,album_artist}',
      source_row #> '{metadata,artists}',
      source_row #> '{metadata,is_compilation}',
      source_row #> '{metadata,relation_evidence_kind}')
    when 'local_artists' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'library_id',
      source_row -> 'artist_key',
      source_row -> 'name',
      source_row -> 'sort_name')
    when 'local_album_featured_artists' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'library_id',
      source_row -> 'album_id',
      source_row -> 'artist_id',
      source_row -> 'featured_kind',
      source_row #> '{metadata,relation_evidence_kind}')
    when 'local_tracks' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'library_id',
      source_row -> 'album_id',
      source_row -> 'artist_id')
    when 'local_track_files' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'track_id',
      source_row -> 'library_root_id',
      source_row -> 'private_path',
      source_row -> 'relative_path',
      source_row -> 'scan_cache_stale',
      source_row #> '{metadata,scan_cache,file_entry,exception_type}')
    when 'exception_overrides' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'library_id',
      source_row -> 'track_id',
      source_row -> 'track_key',
      (source_row -> 'override_payload') ? 'exception_type',
      source_row #> '{override_payload,exception_type}')
    when 'library_roots' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'library_id',
      source_row -> 'root_path',
      source_row -> 'root_kind',
      source_row -> 'is_active')
    when 'libraries' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'owner_account_id',
      source_row -> 'name',
      source_row -> 'library_kind',
      source_row #> '{metadata,scan_cache,relation_projection}',
      source_row #> '{metadata,scan_cache,relations_last_built}',
      source_row #> '{metadata,scan_cache,relation_views,alias_to_canonical}',
      source_row #> '{metadata,scan_cache,relation_views,canonical_to_aliases}',
      jsonb_typeof(source_row #> '{metadata,scan_cache,relation_views,family_to_artists}'),
      jsonb_typeof(source_row #> '{metadata,scan_cache,relation_views,folder_related}'),
      jsonb_typeof(source_row #> '{metadata,scan_cache,relation_views,artists}'),
      jsonb_typeof(source_row #> '{metadata,scan_cache,relation_views,artists_sidebar}'),
      jsonb_typeof(source_row #> '{metadata,scan_cache,relation_views,sidebar_families}'))
    else source_row
  end;
$$;
revoke all on function library.gallery_source_dependency(text, jsonb) from public;

create or replace function library.invalidate_gallery_projection_statement()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare
  changed_rows_sql text;
  affected_ids bigint[];
  affected_id bigint;
  mutation_xid xid8 := pg_current_xact_id();
begin
  if TG_OP = 'TRUNCATE' then
    select array_agg(id order by id) into affected_ids from library.libraries;
  else
    if TG_OP = 'UPDATE' then
      changed_rows_sql := format(
        'select to_jsonb(o) as source_row from gallery_old_rows o full join gallery_new_rows n using (id)
         where library.gallery_source_dependency(%L,to_jsonb(o)) is distinct from library.gallery_source_dependency(%L,to_jsonb(n))
         union all
         select to_jsonb(n) from gallery_old_rows o full join gallery_new_rows n using (id)
         where library.gallery_source_dependency(%L,to_jsonb(o)) is distinct from library.gallery_source_dependency(%L,to_jsonb(n))',
        TG_TABLE_NAME,TG_TABLE_NAME,TG_TABLE_NAME,TG_TABLE_NAME);
    elsif TG_OP = 'INSERT' then
      changed_rows_sql := 'select to_jsonb(n) as source_row from gallery_new_rows n';
    else
      changed_rows_sql := 'select to_jsonb(o) as source_row from gallery_old_rows o';
    end if;
    if TG_TABLE_NAME = 'local_track_files' then
      execute 'with changed as (' || changed_rows_sql || ')
        select array_agg(distinct tracks.library_id order by tracks.library_id)
        from changed join library.local_tracks tracks on tracks.id = (source_row->>''track_id'')::bigint'
        into affected_ids;
    elsif TG_TABLE_NAME = 'libraries' then
      execute 'with changed as (' || changed_rows_sql || ')
        select array_agg(distinct (source_row->>''id'')::bigint order by (source_row->>''id'')::bigint) from changed'
        into affected_ids;
    else
      execute 'with changed as (' || changed_rows_sql || ')
        select array_agg(distinct (source_row->>''library_id'')::bigint order by (source_row->>''library_id'')::bigint) from changed'
        into affected_ids;
    end if;
  end if;
  -- No advisory/source-row lock here: existing writers may already own them.
  -- Deterministic state-row order also covers old writers without app hooks.
  foreach affected_id in array coalesce(affected_ids, array[]::bigint[]) loop
    -- Legacy inventory writers issue one statement per artist/album. Coalesce
    -- those writes transactionally; xid8 includes the epoch and cannot alias
    -- an old marker after 32-bit transaction ID wraparound.
    insert into library.gallery_projection_state(library_id, generation, last_invalidation_xid)
      select id, 1, mutation_xid from library.libraries where id = affected_id
    on conflict (library_id) do update
      set generation = library.gallery_projection_state.generation + 1,
          last_invalidation_xid = excluded.last_invalidation_xid
      where library.gallery_projection_state.last_invalidation_xid
        is distinct from excluded.last_invalidation_xid;
  end loop;
  return null;
end;
$$;
revoke all on function library.invalidate_gallery_projection_statement() from public;

drop trigger if exists gallery_source_insert on library.local_albums;
create trigger gallery_source_insert after insert on library.local_albums referencing new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_update on library.local_albums;
create trigger gallery_source_update after update on library.local_albums referencing old table as gallery_old_rows new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_delete on library.local_albums;
create trigger gallery_source_delete after delete on library.local_albums referencing old table as gallery_old_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_truncate on library.local_albums;
create trigger gallery_source_truncate after truncate on library.local_albums
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_insert on library.local_artists;
create trigger gallery_source_insert after insert on library.local_artists referencing new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_update on library.local_artists;
create trigger gallery_source_update after update on library.local_artists referencing old table as gallery_old_rows new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_delete on library.local_artists;
create trigger gallery_source_delete after delete on library.local_artists referencing old table as gallery_old_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_truncate on library.local_artists;
create trigger gallery_source_truncate after truncate on library.local_artists
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_insert on library.local_album_featured_artists;
create trigger gallery_source_insert after insert on library.local_album_featured_artists referencing new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_update on library.local_album_featured_artists;
create trigger gallery_source_update after update on library.local_album_featured_artists referencing old table as gallery_old_rows new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_delete on library.local_album_featured_artists;
create trigger gallery_source_delete after delete on library.local_album_featured_artists referencing old table as gallery_old_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_truncate on library.local_album_featured_artists;
create trigger gallery_source_truncate after truncate on library.local_album_featured_artists
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_insert on library.local_tracks;
create trigger gallery_source_insert after insert on library.local_tracks referencing new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_update on library.local_tracks;
create trigger gallery_source_update after update on library.local_tracks referencing old table as gallery_old_rows new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_delete on library.local_tracks;
create trigger gallery_source_delete after delete on library.local_tracks referencing old table as gallery_old_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_truncate on library.local_tracks;
create trigger gallery_source_truncate after truncate on library.local_tracks
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_insert on library.local_track_files;
create trigger gallery_source_insert after insert on library.local_track_files referencing new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_update on library.local_track_files;
create trigger gallery_source_update after update on library.local_track_files referencing old table as gallery_old_rows new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_delete on library.local_track_files;
create trigger gallery_source_delete after delete on library.local_track_files referencing old table as gallery_old_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_truncate on library.local_track_files;
create trigger gallery_source_truncate after truncate on library.local_track_files
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_insert on library.exception_overrides;
create trigger gallery_source_insert after insert on library.exception_overrides referencing new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_update on library.exception_overrides;
create trigger gallery_source_update after update on library.exception_overrides referencing old table as gallery_old_rows new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_delete on library.exception_overrides;
create trigger gallery_source_delete after delete on library.exception_overrides referencing old table as gallery_old_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_truncate on library.exception_overrides;
create trigger gallery_source_truncate after truncate on library.exception_overrides
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_insert on library.library_roots;
create trigger gallery_source_insert after insert on library.library_roots referencing new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_update on library.library_roots;
create trigger gallery_source_update after update on library.library_roots referencing old table as gallery_old_rows new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_delete on library.library_roots;
create trigger gallery_source_delete after delete on library.library_roots referencing old table as gallery_old_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_truncate on library.library_roots;
create trigger gallery_source_truncate after truncate on library.library_roots
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_insert on library.libraries;
create trigger gallery_source_insert after insert on library.libraries referencing new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_update on library.libraries;
create trigger gallery_source_update after update on library.libraries referencing old table as gallery_old_rows new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_delete on library.libraries;
create trigger gallery_source_delete after delete on library.libraries referencing old table as gallery_old_rows
  for each statement execute function library.invalidate_gallery_projection_statement();
drop trigger if exists gallery_source_truncate on library.libraries;
create trigger gallery_source_truncate after truncate on library.libraries
  for each statement execute function library.invalidate_gallery_projection_statement();

create or replace function library.replace_gallery_projection(
  target_library_id bigint, target_scope_key text, expected_generation bigint,
  projection_builder_version text, content_revision text, projection_sidebar jsonb,
  projection_album_count bigint, projection_occurrences jsonb
) returns boolean language plpgsql security definer set search_path = pg_catalog as $$
declare
  current_generation bigint;
  source_mutation_xid xid8;
begin
  if target_library_id is null or expected_generation is null or expected_generation < 0
     or target_scope_key is null or target_scope_key !~ '^[0-9a-f]{64}$'
     or content_revision is null or content_revision !~ '^[0-9a-f]{64}$'
     or btrim(coalesce(projection_builder_version,'')) = '' or octet_length(projection_builder_version) > 128
     or projection_album_count is null or projection_album_count < 0
     or jsonb_typeof(projection_sidebar) is distinct from 'array'
     or jsonb_typeof(projection_occurrences) is distinct from 'array' then
    raise exception 'Invalid gallery projection publication';
  end if;
  if jsonb_array_length(projection_sidebar) > 100000 or jsonb_array_length(projection_occurrences) > 2000000
     or pg_column_size(projection_sidebar) + pg_column_size(projection_occurrences) > 268435456 then
    raise exception 'Gallery projection exceeds publication bounds';
  end if;
  if exists (select 1 from jsonb_array_elements(projection_occurrences) item
      where jsonb_typeof(item) <> 'object') then
    raise exception 'Gallery occurrences must be objects';
  end if;
  if exists (select 1 from jsonb_array_elements(projection_occurrences) item,
      lateral jsonb_object_keys(item) field
      where field not in ('artist_id','artist_name','artist_sort_name','album_id','album_key','album_title','album_release_year','missing_album_key')) then
    raise exception 'Gallery occurrences contain unsupported fields';
  end if;
  if exists (select 1 from jsonb_array_elements(projection_sidebar) item
      where jsonb_typeof(item) <> 'object') then
    raise exception 'Gallery sidebar entries must be objects';
  end if;
  if exists (select 1 from jsonb_array_elements(projection_sidebar) item,
      lateral jsonb_object_keys(item) field
      where field not in ('artist','artist_display','count')) then
    raise exception 'Gallery sidebar contains unsupported fields';
  end if;
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));
  perform pg_advisory_xact_lock(hashtextextended('album-haven:local-relation-projection',0));
  if not exists (select 1 from library.libraries l join app.bootstrap_owners b
      on b.account_id = l.owner_account_id
      where b.owner_key = 'local-bootstrap-owner' and l.id = target_library_id
        and l.name = 'Local Library' and l.library_kind = 'local') then
    raise exception 'Gallery projection library is outside the bootstrap scope';
  end if;
  select generation, last_invalidation_xid into current_generation, source_mutation_xid
    from library.gallery_projection_state
    where library_id = target_library_id for update;
  -- Coalesced source writes share one generation within their transaction.
  -- Publishing from that writer could hide a mutation made after its build.
  -- Builders must therefore publish committed source data, as startup does.
  if current_generation is distinct from expected_generation
     or source_mutation_xid = pg_current_xact_id() then
    return false;
  end if;
  delete from library.gallery_projection_snapshots
    where library_id = target_library_id and scope_key = target_scope_key;
  insert into library.gallery_projection_snapshots(
    library_id,scope_key,source_generation,builder_version,revision,sidebar,album_count,occurrence_count)
  values(target_library_id,target_scope_key,expected_generation,projection_builder_version,
    content_revision,projection_sidebar,projection_album_count,jsonb_array_length(projection_occurrences));
  insert into library.gallery_projection_occurrences(library_id,scope_key,ordinal,payload)
    select target_library_id,target_scope_key,ordinality - 1,value
    from jsonb_array_elements(projection_occurrences) with ordinality;
  return true;
end;
$$;
revoke all on function library.replace_gallery_projection(bigint,text,bigint,text,text,jsonb,bigint,jsonb) from public;
revoke all on library.gallery_projection_state,library.gallery_projection_snapshots,library.gallery_projection_occurrences from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on library.gallery_projection_state,library.gallery_projection_snapshots,library.gallery_projection_occurrences to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on library.gallery_projection_state,library.gallery_projection_snapshots,library.gallery_projection_occurrences from album_haven_app;
    grant select on library.gallery_projection_state,library.gallery_projection_snapshots,library.gallery_projection_occurrences to album_haven_app;
    grant execute on function library.replace_gallery_projection(bigint,text,bigint,text,text,jsonb,bigint,jsonb) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all on library.gallery_projection_state,library.gallery_projection_snapshots,library.gallery_projection_occurrences to album_haven_migrator;
    grant execute on function library.replace_gallery_projection(bigint,text,bigint,text,text,jsonb,bigint,jsonb) to album_haven_migrator;
  end if;
end $$;
