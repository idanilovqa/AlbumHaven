-- Internal metadata publication foundation. No existing inventory is certified,
-- no selection is inferred, and no Top is enabled or published by this migration.
alter table library.local_tracks
  add column title_origin text not null default 'unknown'
    check (title_origin in ('tag_metadata','filename_fallback','unknown')),
  add column artist_origin text not null default 'unknown'
    check (artist_origin in ('tag_metadata','filename_fallback','unknown'));

create table library.public_metadata_source_state (
  library_id bigint primary key references library.libraries(id) on delete cascade,
  generation bigint not null default 0 check (generation >= 0),
  last_invalidation_xid xid8
);
insert into library.public_metadata_source_state(library_id) select id from library.libraries;

-- As in 0088, obtain a row lock without granting mutation of freshness evidence.
create function library.lock_public_metadata_source(p_library bigint)
returns void language plpgsql volatile security definer set search_path=pg_catalog as $$
begin
  perform s.library_id from library.public_metadata_source_state s
    where s.library_id=p_library for share of s;
end $$;

-- Pure lexical facts for indexed membership. The producer stores the flavor;
-- neither a host OS guess nor source association determines physical identity.
create function library.public_metadata_container(private_path text,path_flavor text)
returns text language plpgsql immutable strict security invoker set search_path=pg_catalog as $$
declare
  separator text;
  normalized text;
  anchor text;
  remainder text;
  server_name text;
  share_name text;
  boundary integer;
  components text[];
  parent text;
begin
  if octet_length(private_path)>16384 or private_path='' then return null; end if;
  if path_flavor='posix' then
    if left(private_path,1)<>'/' then return null; end if;
    separator := '/';
    anchor := case when left(private_path,2)='//' and left(private_path,3)<>'///'
      then '//' else '/' end;
    remainder := private_path;
  elsif path_flavor='windows' then
    separator := chr(92);
    normalized := replace(private_path,'/',separator);
    if left(normalized,1) collate "C" ~ '^[A-Za-z]$'
        and substring(normalized,2,2)=':'||separator then
      anchor := left(normalized,2)||separator;
      remainder := substring(normalized,4);
    elsif left(normalized,2)=separator||separator
        and substring(normalized,3,1)<>separator then
      remainder := substring(normalized,3);
      boundary := strpos(remainder,separator);
      if boundary=0 then return null; end if;
      server_name := left(remainder,boundary-1);
      remainder := substring(remainder,boundary+1);
      boundary := strpos(remainder,separator);
      if boundary=0 then share_name := remainder; remainder := '';
      else
        share_name := left(remainder,boundary-1);
        remainder := substring(remainder,boundary+1);
      end if;
      if server_name='' or share_name='' or server_name='..' or share_name='..' then return null; end if;
      anchor := separator||separator||server_name||separator||share_name||separator;
      if server_name='?' and upper(share_name collate "C")='UNC' then
        boundary := strpos(remainder,separator);
        if boundary=0 then return null; end if;
        server_name := left(remainder,boundary-1);
        remainder := substring(remainder,boundary+1);
        boundary := strpos(remainder,separator);
        if boundary=0 then share_name := remainder; remainder := '';
        else
          share_name := left(remainder,boundary-1);
          remainder := substring(remainder,boundary+1);
        end if;
        if server_name='' or share_name='' or server_name='..' or share_name='..' then return null; end if;
        anchor := anchor||server_name||separator||share_name||separator;
      end if;
    else return null;
    end if;
  else return null;
  end if;
  components := array_remove(array_remove(string_to_array(remainder,separator),''),'.');
  if '..'=any(components) then return null; end if;
  parent := anchor||array_to_string(components[1:greatest(cardinality(components)-1,0)],separator);
  if octet_length(parent)>8192 then return null; end if;
  return parent;
end $$;

create table library.album_metadata_sources (
  ref uuid primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  local_album_id bigint not null,
  library_root_id bigint not null references library.library_roots(id) on delete cascade,
  container_identity text collate "C" not null check (octet_length(container_identity) between 1 and 8192),
  path_flavor text not null check (path_flavor in ('posix','windows')),
  capture_builder_version integer not null check (capture_builder_version = 1),
  state text not null check (state in ('active','invalid')),
  title text check (length(title)<=1000),
  artist text check (length(artist)<=1000),
  year integer check (year between 1 and 9999),
  title_origin text not null default 'unknown' check (title_origin in ('tag_metadata','filename_fallback','unknown')),
  artist_origin text not null default 'unknown' check (artist_origin in ('tag_metadata','filename_fallback','unknown')),
  foreign key(library_id,local_album_id) references library.local_albums(library_id,id) on delete cascade
);
-- A bounded conflict bucket, not an assertion that a digest is full identity.
-- The producer verifies exact C-collated identity before updates/associations.
create unique index album_metadata_sources_identity_idx on library.album_metadata_sources
  (library_id,local_album_id,library_root_id,path_flavor,pg_catalog.md5(container_identity));
create index album_metadata_sources_root_idx on library.album_metadata_sources(library_root_id);
alter table library.local_track_files add column metadata_source_ref uuid
  references library.album_metadata_sources(ref) on delete set null;
create index local_track_files_metadata_source_idx on library.local_track_files(metadata_source_ref,id);
create index local_track_files_publication_posix_idx on library.local_track_files
  (library_root_id,pg_catalog.md5(library.public_metadata_container(private_path,'posix')),id)
  where library.public_metadata_container(private_path,'posix') is not null;
create index local_track_files_publication_windows_idx on library.local_track_files
  (library_root_id,pg_catalog.md5(library.public_metadata_container(private_path,'windows')),id)
  where library.public_metadata_container(private_path,'windows') is not null;

alter table app.album_list_items add constraint album_list_items_publication_binding_unique
  unique(top_ref,library_id,ref,catalog_ref);
create table app.album_list_item_publication_sources (
  top_ref uuid not null,
  item_ref uuid not null,
  library_id bigint not null,
  catalog_ref uuid not null,
  selected_local_album_id bigint not null check (selected_local_album_id > 0),
  selected_source_ref uuid not null,
  primary key(top_ref,item_ref),
  foreign key(top_ref,library_id,item_ref,catalog_ref)
    references app.album_list_items(top_ref,library_id,ref,catalog_ref) on delete cascade
);
create index album_list_item_sources_library_idx on app.album_list_item_publication_sources(library_id);

create table catalog.album_presentation_versions (
  ref uuid primary key,
  catalog_ref uuid not null references catalog.release_groups(ref),
  contract_version integer not null check (contract_version=1),
  title text not null check (length(btrim(title)) between 1 and 1000),
  artist text not null check (length(btrim(artist)) between 1 and 1000),
  year integer check (year between 1 and 9999),
  metadata_digest text not null check (metadata_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique(catalog_ref,ref)
);
create table catalog.album_presentation_tracks (
  ref uuid primary key,
  presentation_ref uuid not null references catalog.album_presentation_versions(ref) on delete cascade,
  position integer not null check (position between 1 and 5000),
  title text not null check (length(btrim(title)) between 1 and 1000),
  artist text not null check (length(btrim(artist)) between 1 and 1000),
  duration_ms integer check (duration_ms >= 0),
  unique(presentation_ref,position),
  unique(presentation_ref,ref)
);
create table library.album_presentation_evidence (
  presentation_ref uuid primary key references catalog.album_presentation_versions(ref) on delete cascade,
  library_id bigint not null references library.libraries(id),
  selected_local_album_id bigint not null check (selected_local_album_id > 0),
  selected_source_ref uuid not null,
  selected_library_root_id bigint not null check (selected_library_root_id > 0),
  captured_generation bigint not null check (captured_generation >= 0),
  capture_builder_version integer not null check (capture_builder_version=1),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  admitted_at timestamptz not null default now(),
  unique(library_id,selected_source_ref,capture_builder_version,evidence_digest)
);

create table app.album_list_publications (
  ref uuid primary key,
  top_ref uuid not null,
  library_id bigint not null,
  publication_revision bigint not null check (publication_revision > 0),
  approved_top_revision bigint not null check (approved_top_revision > 0),
  approved_by_account_id bigint not null references app.accounts(id),
  title text not null check (length(btrim(title)) between 1 and 100),
  description text not null check (length(description) <= 1000),
  contract_version integer not null check (contract_version=1),
  content_fingerprint text not null check (content_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  foreign key(top_ref,library_id) references app.album_lists(ref,library_id) on delete cascade,
  unique(top_ref,publication_revision),
  unique(top_ref,library_id,ref)
);
create index album_list_publications_owner_idx on app.album_list_publications(approved_by_account_id);
create index album_list_publications_library_idx on app.album_list_publications(library_id);
create table app.album_list_publication_items (
  publication_ref uuid not null,
  item_ref uuid not null,
  top_ref uuid not null,
  library_id bigint not null,
  catalog_ref uuid not null,
  presentation_ref uuid not null,
  original_position bigint not null check (original_position > 0),
  curator_position integer not null check (curator_position between 1 and 5000),
  primary key(publication_ref,item_ref),
  foreign key(top_ref,library_id,publication_ref)
    references app.album_list_publications(top_ref,library_id,ref) on delete cascade,
  foreign key(catalog_ref,presentation_ref) references catalog.album_presentation_versions(catalog_ref,ref),
  unique(publication_ref,catalog_ref),
  unique(publication_ref,original_position),
  unique(publication_ref,curator_position)
);
create index album_list_publication_items_parent_idx on app.album_list_publication_items(top_ref,library_id,publication_ref);
create index album_list_publication_items_presentation_idx on app.album_list_publication_items(catalog_ref,presentation_ref);
create table app.shared_links (
  ref uuid primary key,
  top_ref uuid not null unique,
  library_id bigint not null,
  state text not null check (state in ('enabled','revoked')),
  active_publication_ref uuid,
  link_revision bigint not null check (link_revision > 0),
  enabled_at timestamptz,
  revoked_at timestamptz,
  foreign key(top_ref,library_id) references app.album_lists(ref,library_id) on delete cascade,
  foreign key(top_ref,library_id,active_publication_ref)
    references app.album_list_publications(top_ref,library_id,ref),
  check ((state='enabled') = (active_publication_ref is not null))
);
create index shared_links_publication_idx on app.shared_links(top_ref,library_id,active_publication_ref);
create index shared_links_library_idx on app.shared_links(library_id);

alter table app.album_list_operations drop constraint album_list_operations_action_check;
alter table app.album_list_operations add constraint album_list_operations_action_check check(action in (
  'create','save','add','remove','reorder','delete','visibility','grant_editor','revoke_editor',
  'request_edit','decide_edit_request','copy','set_manual_completion','enable_external','revoke_external'));
alter table app.album_list_operations add column required_actions text[] not null default '{}',
  add column publication_ref uuid;

-- A distinct dependency clock: gallery freshness intentionally has other inputs.
create function library.public_metadata_dependency(source_table text, r jsonb)
returns jsonb language sql immutable set search_path=pg_catalog as $$
  select case source_table
    when 'local_tracks' then jsonb_build_array(r->'id',r->'library_id',r->'album_id',r->'artist_id',r->'title',r->'disc_number',r->'track_number',r->'duration_seconds',r->'title_origin',r->'artist_origin')
    when 'local_track_files' then jsonb_build_array(r->'id',r->'track_id',r->'library_root_id',r->'private_path',r->'metadata_source_ref',r->'scan_cache_stale',r#>'{metadata,scan_cache,file_entry,title_origin}',r#>'{metadata,scan_cache,file_entry,album_origin}',r#>'{metadata,scan_cache,file_entry,album_artist_origin}',r#>'{metadata,scan_cache,file_entry,artist_origin}')
    when 'local_albums' then jsonb_build_array(r->'id',r->'library_id',r->'artist_id',r->'title',r->'release_year')
    when 'local_artists' then jsonb_build_array(r->'id',r->'library_id',r->'name')
    when 'library_roots' then jsonb_build_array(r->'id',r->'library_id',r->'root_path',r->'is_active')
    when 'libraries' then jsonb_build_array(r->'id',r->'owner_account_id')
    when 'catalog_album_links' then jsonb_build_array(r->'library_id',r->'local_album_id',r->'catalog_ref')
    else r
  end
$$;
create function library.invalidate_public_metadata_source()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare
  rows_sql text;
  key_name text := case TG_TABLE_NAME when 'album_metadata_sources' then 'ref'
    when 'catalog_album_links' then 'local_album_id' else 'id' end;
  ids bigint[];
  library_key bigint;
  transaction_id xid8 := pg_current_xact_id();
begin
  if TG_OP='TRUNCATE' then
    select array_agg(id order by id) into ids from library.libraries;
  else
    if TG_OP='UPDATE' then
      rows_sql := format('select to_jsonb(o) r from metadata_old o full join metadata_new n using (%I) where library.public_metadata_dependency(%L,to_jsonb(o)) is distinct from library.public_metadata_dependency(%L,to_jsonb(n)) union all select to_jsonb(n) r from metadata_old o full join metadata_new n using (%I) where library.public_metadata_dependency(%L,to_jsonb(o)) is distinct from library.public_metadata_dependency(%L,to_jsonb(n))',key_name,TG_TABLE_NAME,TG_TABLE_NAME,key_name,TG_TABLE_NAME,TG_TABLE_NAME);
    elsif TG_OP='INSERT' then rows_sql := 'select to_jsonb(n) r from metadata_new n';
    else rows_sql := 'select to_jsonb(o) r from metadata_old o'; end if;
    if TG_TABLE_NAME='local_track_files' then
      execute 'with changed as ('||rows_sql||') select array_agg(distinct t.library_id order by t.library_id) from changed join library.local_tracks t on t.id=(r->>''track_id'')::bigint' into ids;
    else
      execute 'with changed as ('||rows_sql||') select array_agg(distinct (r->>'||quote_literal(case TG_TABLE_NAME when 'libraries' then 'id' else 'library_id' end)||')::bigint order by (r->>'||quote_literal(case TG_TABLE_NAME when 'libraries' then 'id' else 'library_id' end)||')::bigint) from changed' into ids;
    end if;
  end if;
  foreach library_key in array coalesce(ids,array[]::bigint[]) loop
    insert into library.public_metadata_source_state(library_id,generation,last_invalidation_xid)
      select id,1,transaction_id from library.libraries where id=library_key
    on conflict(library_id) do update set generation=library.public_metadata_source_state.generation+1,
      last_invalidation_xid=excluded.last_invalidation_xid
    where library.public_metadata_source_state.last_invalidation_xid is distinct from excluded.last_invalidation_xid;
  end loop;
  return null;
end $$;
do $$ declare source text; begin
  foreach source in array array['libraries','library_roots','local_albums','local_artists','local_tracks','local_track_files','catalog_album_links','album_metadata_sources'] loop
    execute format('create trigger metadata_source_insert after insert on library.%I referencing new table as metadata_new for each statement execute function library.invalidate_public_metadata_source()',source);
    execute format('create trigger metadata_source_update after update on library.%I referencing old table as metadata_old new table as metadata_new for each statement execute function library.invalidate_public_metadata_source()',source);
    execute format('create trigger metadata_source_delete after delete on library.%I referencing old table as metadata_old for each statement execute function library.invalidate_public_metadata_source()',source);
    execute format('create trigger metadata_source_truncate after truncate on library.%I for each statement execute function library.invalidate_public_metadata_source()',source);
  end loop;
end $$;
revoke all on function library.lock_public_metadata_source(bigint),
  library.public_metadata_container(text,text),library.public_metadata_dependency(text,jsonb),
  library.invalidate_public_metadata_source() from public;

do $$ declare relation text; role_name text; begin
  foreach relation in array array['library.public_metadata_source_state','library.album_metadata_sources',
    'app.album_list_item_publication_sources','catalog.album_presentation_versions','catalog.album_presentation_tracks',
    'library.album_presentation_evidence','app.album_list_publications','app.album_list_publication_items','app.shared_links'] loop
    execute 'revoke all on '||relation||' from public';
    foreach role_name in array array['album_haven_readonly','album_haven_app'] loop
      if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on %s from %I',relation,role_name); end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='album_haven_app') then
      execute 'grant select on '||relation||' to album_haven_app';
      if relation <> 'library.public_metadata_source_state' then execute 'grant insert on '||relation||' to album_haven_app'; end if;
      if relation in ('library.album_metadata_sources','app.album_list_item_publication_sources','app.shared_links') then execute 'grant update on '||relation||' to album_haven_app'; end if;
      if relation in ('library.album_metadata_sources','app.album_list_item_publication_sources') then execute 'grant delete on '||relation||' to album_haven_app'; end if;
    end if;
    if exists(select 1 from pg_roles where rolname='album_haven_migrator') then execute 'grant all on '||relation||' to album_haven_migrator'; end if;
  end loop;
  foreach role_name in array array['album_haven_readonly','album_haven_app'] loop
    if exists(select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on function library.lock_public_metadata_source(bigint),library.public_metadata_container(text,text),library.public_metadata_dependency(text,jsonb),library.invalidate_public_metadata_source() from %I',role_name);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    grant execute on function library.lock_public_metadata_source(bigint),
      library.public_metadata_container(text,text) to album_haven_app;
  end if;
end $$;
