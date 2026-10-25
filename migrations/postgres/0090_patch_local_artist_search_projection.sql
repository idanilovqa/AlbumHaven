create or replace function library.patch_local_artist_search_projection(
  affected_normalized_keys text[],
  projection_rows jsonb,
  projection_builder_version text,
  projection_source_fingerprint text,
  projection_relations_last_built double precision
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  selected_library_id bigint;
  deleted_row_count integer := 0;
  upserted_row_count integer := 0;
begin
  if affected_normalized_keys is null
     or cardinality(affected_normalized_keys) = 0
     or cardinality(affected_normalized_keys) > 256 then
    raise exception 'affected_normalized_keys must contain 1 to 256 values';
  end if;
  if exists (
    select 1
    from unnest(affected_normalized_keys) as affected(normalized_artist_key)
    where btrim(coalesce(affected.normalized_artist_key, '')) = ''
       or octet_length(affected.normalized_artist_key) > 1024
  ) then
    raise exception 'affected_normalized_keys contains an invalid value';
  end if;
  if jsonb_typeof(projection_rows) is distinct from 'array'
     or jsonb_array_length(projection_rows) > 256
     or pg_column_size(projection_rows) > 1048576 then
    raise exception 'projection_rows exceeds the bounded patch contract';
  end if;
  if btrim(coalesce(projection_builder_version, '')) = ''
     or octet_length(projection_builder_version) > 128
     or projection_source_fingerprint !~ '^[0-9a-f]{64}$'
     or projection_relations_last_built is null
     or projection_relations_last_built in (
       'NaN'::double precision,
       'Infinity'::double precision,
       '-Infinity'::double precision
     ) then
    raise exception 'projection patch metadata is invalid';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(projection_rows) as rows(
      normalized_artist_key text,
      canonical_artist_name text
    )
    where btrim(coalesce(rows.normalized_artist_key, '')) = ''
       or btrim(coalesce(rows.canonical_artist_name, '')) = ''
       or octet_length(rows.normalized_artist_key) > 1024
       or octet_length(rows.canonical_artist_name) > 4096
       or not (rows.normalized_artist_key = any(affected_normalized_keys))
  ) then
    raise exception 'projection_rows contains an invalid or unaffected value';
  end if;
  if exists (
    select rows.normalized_artist_key
    from jsonb_to_recordset(projection_rows) as rows(
      normalized_artist_key text,
      canonical_artist_name text
    )
    group by rows.normalized_artist_key
    having count(*) > 1
  ) then
    raise exception 'projection_rows contains duplicate normalized keys';
  end if;

  select libraries.id
  into strict selected_library_id
  from app.bootstrap_owners
  join library.libraries
    on library.libraries.owner_account_id = app.bootstrap_owners.account_id
   and library.libraries.name = 'Local Library'
   and library.libraries.library_kind = 'local'
  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner';

  delete from library.local_artist_search_projection
  where library_id = selected_library_id
    and normalized_artist_key = any(affected_normalized_keys);
  get diagnostics deleted_row_count = row_count;

  insert into library.local_artist_search_projection (
    library_id,
    normalized_artist_key,
    canonical_artist_name,
    builder_version,
    source_fingerprint,
    relations_last_built
  )
  select
    selected_library_id,
    rows.normalized_artist_key,
    rows.canonical_artist_name,
    projection_builder_version,
    projection_source_fingerprint,
    projection_relations_last_built
  from jsonb_to_recordset(projection_rows) as rows(
    normalized_artist_key text,
    canonical_artist_name text
  )
  on conflict (library_id, normalized_artist_key) do update
  set canonical_artist_name = excluded.canonical_artist_name,
      builder_version = excluded.builder_version,
      source_fingerprint = excluded.source_fingerprint,
      relations_last_built = excluded.relations_last_built;
  get diagnostics upserted_row_count = row_count;

  return deleted_row_count + upserted_row_count;
end;
$$;

revoke all on function library.patch_local_artist_search_projection(
  text[], jsonb, text, text, double precision
) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.patch_local_artist_search_projection(
      text[], jsonb, text, text, double precision
    ) to album_haven_app;
  end if;
end $$;
