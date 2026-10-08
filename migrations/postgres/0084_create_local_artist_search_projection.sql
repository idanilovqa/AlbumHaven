create table if not exists library.local_artist_search_projection (
  library_id bigint not null references library.libraries(id) on delete cascade,
  normalized_artist_key text not null,
  canonical_artist_name text not null,
  builder_version text not null,
  source_fingerprint text not null,
  relations_last_built double precision not null,
  primary key (library_id, normalized_artist_key),
  constraint local_artist_search_projection_key_not_blank
    check (btrim(normalized_artist_key) <> ''),
  constraint local_artist_search_projection_key_size_bounded
    check (octet_length(normalized_artist_key) <= 1024),
  constraint local_artist_search_projection_name_not_blank
    check (btrim(canonical_artist_name) <> ''),
  constraint local_artist_search_projection_name_size_bounded
    check (octet_length(canonical_artist_name) <= 4096),
  constraint local_artist_search_projection_builder_size_bounded
    check (octet_length(builder_version) <= 128),
  constraint local_artist_search_projection_fingerprint_valid
    check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint local_artist_search_projection_timestamp_finite
    check (relations_last_built not in (
      'NaN'::double precision,
      'Infinity'::double precision,
      '-Infinity'::double precision
    ))
);

create index if not exists local_artist_search_projection_canonical_scope_idx
  on library.local_artist_search_projection (
    library_id,
    canonical_artist_name,
    normalized_artist_key
  );

create or replace function library.replace_local_artist_search_projection(
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
  replacement_row_count integer := 0;
begin
  if jsonb_typeof(projection_rows) is distinct from 'array' then
    raise exception 'projection_rows must be a JSON array';
  end if;
  if jsonb_array_length(projection_rows) > 100000 then
    raise exception 'projection_rows exceeds the bounded row limit';
  end if;
  if pg_column_size(projection_rows) > 67108864 then
    raise exception 'projection_rows exceeds the bounded byte limit';
  end if;
  if btrim(coalesce(projection_builder_version, '')) = ''
     or btrim(coalesce(projection_source_fingerprint, '')) = ''
     or projection_relations_last_built is null then
    raise exception 'projection publication metadata is required';
  end if;
  if octet_length(projection_builder_version) > 128 then
    raise exception 'projection builder version exceeds the bounded byte limit';
  end if;
  if projection_source_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'projection source fingerprint must be a lowercase SHA-256 digest';
  end if;
  if projection_relations_last_built in (
    'NaN'::double precision,
    'Infinity'::double precision,
    '-Infinity'::double precision
  ) then
    raise exception 'projection relations timestamp must be finite';
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
  ) then
    raise exception 'projection rows contain invalid or oversized artist values';
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
    raise exception 'projection rows contain duplicate normalized keys';
  end if;

  delete from library.local_artist_search_projection
  using app.bootstrap_owners
  join library.libraries
    on library.libraries.owner_account_id = app.bootstrap_owners.account_id
   and library.libraries.name = 'Local Library'
   and library.libraries.library_kind = 'local'
  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
    and library.local_artist_search_projection.library_id = library.libraries.id;

  insert into library.local_artist_search_projection (
    library_id,
    normalized_artist_key,
    canonical_artist_name,
    builder_version,
    source_fingerprint,
    relations_last_built
  )
  select
    library.libraries.id,
    rows.normalized_artist_key,
    rows.canonical_artist_name,
    projection_builder_version,
    projection_source_fingerprint,
    projection_relations_last_built
  from app.bootstrap_owners
  join library.libraries
    on library.libraries.owner_account_id = app.bootstrap_owners.account_id
   and library.libraries.name = 'Local Library'
   and library.libraries.library_kind = 'local'
  join jsonb_to_recordset(projection_rows) as rows(
    normalized_artist_key text,
    canonical_artist_name text
  ) on true
  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner';

  get diagnostics replacement_row_count = row_count;
  return replacement_row_count;
end;
$$;

revoke all on function library.replace_local_artist_search_projection(
  jsonb, text, text, double precision
) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table library.local_artist_search_projection to album_haven_readonly;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke insert, update, delete on table library.local_artist_search_projection
      from album_haven_app;
    grant select on table library.local_artist_search_projection to album_haven_app;
    grant execute on function library.replace_local_artist_search_projection(
      jsonb, text, text, double precision
    ) to album_haven_app;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on table library.local_artist_search_projection
      to album_haven_migrator;
    grant execute on function library.replace_local_artist_search_projection(
      jsonb, text, text, double precision
    ) to album_haven_migrator;
  end if;
end $$;
