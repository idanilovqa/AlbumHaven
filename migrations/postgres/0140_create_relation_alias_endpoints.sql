-- Source-only authoring. Apply only after separate migration/runtime acceptance.
-- The trusted publisher derives keys with local_inventory_identity_key; SQL never
-- substitutes lower()/casefold approximations. No permission decisions live here.
do $$ begin
  if to_regprocedure('pg_catalog.sha256(bytea)') is null then
    raise exception 'core SHA256 support is required for endpoint proofs';
  end if;
end $$;
create function library.relation_alias_endpoint_payload_reason(
  source_snapshot jsonb, relation_metadata jsonb, relations_last_built double precision,
  manifest jsonb, edge_count integer
) returns text language plpgsql immutable set search_path = pg_catalog as $$
declare
  item jsonb;
  member jsonb;
  k text;
  n integer := 0;
  expected_raw jsonb;
  actual_raw jsonb;
begin
  if source_snapshot is null or jsonb_typeof(source_snapshot) is distinct from 'object'
     or relation_metadata is null or jsonb_typeof(relation_metadata) is distinct from 'object'
     or manifest is null or jsonb_typeof(manifest) is distinct from 'array'
     or edge_count is null or edge_count < 0
     or relations_last_built is null or relations_last_built in
       ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
  then return 'unsupported_shape'; end if;
  if (select array_agg(key order by key) from jsonb_object_keys(source_snapshot) key)
       is distinct from array['alias_to_canonical','canonical_to_aliases']::text[]
     or jsonb_typeof(source_snapshot->'alias_to_canonical') is distinct from 'object'
     or jsonb_typeof(source_snapshot->'canonical_to_aliases') is distinct from 'object'
     or relation_metadata->>'status' is distinct from 'ready'
     or relation_metadata->>'builder_version' is distinct from 'local-relation-builder-v10'
     or jsonb_typeof(relation_metadata->'source_fingerprint') is distinct from 'string'
     or coalesce(relation_metadata->>'source_fingerprint','') !~ '^[0-9a-f]{64}$'
     or relation_metadata->'built_from_fingerprint' is distinct from relation_metadata->'source_fingerprint'
  then return 'unsupported_shape'; end if;
  if edge_count > 100000 or jsonb_array_length(manifest) > 100000
     or octet_length(convert_to(source_snapshot::text,'UTF8')) > 67108864
     or octet_length(convert_to(manifest::text,'UTF8')) > 67108864
  then return 'budget_exceeded'; end if;
  for k,item in select key,value from jsonb_each(source_snapshot->'alias_to_canonical') loop
    if btrim(k) = '' or jsonb_typeof(item) is distinct from 'string'
       or btrim(item #>> '{}') = '' then return 'unsupported_shape'; end if;
    if octet_length(convert_to(k,'UTF8')) > 4096
       or octet_length(convert_to(item #>> '{}','UTF8')) > 4096 then return 'budget_exceeded'; end if;
  end loop;
  for k,item in select key,value from jsonb_each(source_snapshot->'canonical_to_aliases') loop
    if btrim(k) = '' or jsonb_typeof(item) is distinct from 'array'
      then return 'unsupported_shape'; end if;
    if octet_length(convert_to(k,'UTF8')) > 4096 then return 'budget_exceeded'; end if;
    for member in select value from jsonb_array_elements(item) loop
      if jsonb_typeof(member) is distinct from 'string' or btrim(member #>> '{}') = ''
        then return 'unsupported_shape'; end if;
      if octet_length(convert_to(member #>> '{}','UTF8')) > 4096 then return 'budget_exceeded'; end if;
    end loop;
  end loop;
  for item in select value from jsonb_array_elements(manifest) loop
    if jsonb_typeof(item) is distinct from 'object' then return 'unsupported_shape'; end if;
    if (select array_agg(key order by key) from jsonb_object_keys(item) key)
       is distinct from array['alias_key','canonical_key','edge_id','origin','raw_alias','raw_canonical']::text[]
      then return 'unsupported_shape'; end if;
    if jsonb_typeof(item->'edge_id') is distinct from 'number' then return 'unsupported_shape'; end if;
    if (item->>'edge_id')::numeric <> n then return 'unsupported_shape'; end if;
    foreach k in array array['origin','raw_alias','raw_canonical','alias_key','canonical_key'] loop
      if jsonb_typeof(item->k) is distinct from 'string' or btrim(item->>k) = ''
        then return 'unsupported_shape'; end if;
    end loop;
    if item->>'origin' not in ('alias_to_canonical','canonical_to_aliases','canonical_group')
      then return 'unsupported_shape'; end if;
    if octet_length(convert_to(item->>'raw_alias','UTF8')) > 4096
       or octet_length(convert_to(item->>'raw_canonical','UTF8')) > 4096
       or octet_length(convert_to(item->>'alias_key','UTF8')) > 1024
       or octet_length(convert_to(item->>'canonical_key','UTF8')) > 1024
      then return 'budget_exceeded'; end if;
    if item->>'origin' = 'canonical_group' and
       (item->>'raw_alias' is distinct from item->>'raw_canonical'
        or item->>'alias_key' is distinct from item->>'canonical_key')
      then return 'unsupported_shape'; end if;
    n := n + 1;
  end loop;
  if n <> edge_count then return 'unsupported_shape'; end if;
  -- UTF8 byte ordering under C agrees with Python Unicode codepoint ordering.
  if exists (
    select 1 from (
      select value, row_number() over (order by
        (value->>'origin') collate "C", (value->>'raw_alias') collate "C",
        (value->>'raw_canonical') collate "C", (value->>'alias_key') collate "C",
        (value->>'canonical_key') collate "C") - 1 as ordinal
      from jsonb_array_elements(manifest)
    ) ordered where (value->>'edge_id')::numeric::integer <> ordinal
  ) then return 'unsupported_shape'; end if;
  if exists (select 1 from jsonb_array_elements(manifest) e
    group by e->>'origin',e->>'raw_alias',e->>'raw_canonical' having count(*) > 1)
  then return 'unsupported_shape'; end if;
  -- Same raw spelling must receive the same trusted normalized key everywhere.
  if exists (select 1 from (
      select e->>'raw_alias' raw,e->>'alias_key' key from jsonb_array_elements(manifest) e
      union all select e->>'raw_canonical',e->>'canonical_key' from jsonb_array_elements(manifest) e
    ) names group by raw having count(distinct key) > 1)
    then return 'unsupported_membership'; end if;
  if exists (select 1 from (
      select e->>'alias_key' member_key,e->>'canonical_key' canonical_key from jsonb_array_elements(manifest) e
      union all select e->>'canonical_key',e->>'canonical_key' from jsonb_array_elements(manifest) e
    ) memberships group by member_key having count(distinct canonical_key) > 1)
    then return 'unsupported_membership'; end if;
  with raw_records as (
    select 'alias_to_canonical'::text origin,key raw_alias,value #>> '{}' raw_canonical
      from jsonb_each(source_snapshot->'alias_to_canonical')
    union select 'canonical_to_aliases',a.value #>> '{}',c.key
      from jsonb_each(source_snapshot->'canonical_to_aliases') c
      cross join lateral jsonb_array_elements(c.value) a
    union select 'canonical_group',key,key from jsonb_object_keys(source_snapshot->'canonical_to_aliases') key
  ) select coalesce(jsonb_agg(jsonb_build_array(origin,raw_alias,raw_canonical)
      order by origin collate "C",raw_alias collate "C",raw_canonical collate "C"),'[]'::jsonb)
    into expected_raw from raw_records;
  select coalesce(jsonb_agg(jsonb_build_array(e->>'origin',e->>'raw_alias',e->>'raw_canonical')
      order by (e->>'origin') collate "C",(e->>'raw_alias') collate "C",(e->>'raw_canonical') collate "C"),'[]'::jsonb)
    into actual_raw from jsonb_array_elements(manifest) e;
  if expected_raw is distinct from actual_raw then return 'unsupported_shape'; end if;
  return null;
end $$;

create table library.relation_alias_endpoint_publications (
  library_id bigint primary key references library.libraries(id) on delete cascade,
  publication_id uuid not null,
  endpoint_builder_version text not null check (endpoint_builder_version = 'relation-alias-endpoints-v1'),
  status text not null check (status in ('ready','unavailable')),
  reason_code text,
  source_snapshot jsonb,
  relation_metadata jsonb,
  relations_last_built double precision,
  manifest jsonb not null,
  edge_count integer not null,
  unique (library_id,publication_id),
  constraint relation_alias_endpoint_status_evidence check (
    (status = 'ready' and reason_code is null and source_snapshot is not null
      and relation_metadata is not null and relations_last_built is not null
      and library.relation_alias_endpoint_payload_reason(source_snapshot,relation_metadata,
          relations_last_built,manifest,edge_count) is null)
    or (status = 'unavailable' and reason_code is not null
      and reason_code in ('unsupported_shape','unsupported_membership','budget_exceeded')
      and source_snapshot is null and relation_metadata is null and relations_last_built is null
      and manifest = '[]'::jsonb and edge_count = 0)
  )
);
create table library.relation_alias_endpoints (
  library_id bigint not null,
  publication_id uuid not null,
  edge_id integer not null check (edge_id between 0 and 99999),
  origin text not null check (origin in ('alias_to_canonical','canonical_to_aliases','canonical_group')),
  raw_alias text not null check (btrim(raw_alias) <> '' and octet_length(convert_to(raw_alias,'UTF8')) <= 4096),
  raw_canonical text not null check (btrim(raw_canonical) <> '' and octet_length(convert_to(raw_canonical,'UTF8')) <= 4096),
  alias_key text not null check (btrim(alias_key) <> '' and octet_length(convert_to(alias_key,'UTF8')) <= 1024),
  canonical_key text not null check (btrim(canonical_key) <> '' and octet_length(convert_to(canonical_key,'UTF8')) <= 1024),
  primary key (library_id,publication_id,edge_id),
  foreign key (library_id,publication_id) references library.relation_alias_endpoint_publications(library_id,publication_id) on delete cascade
);

create function library.replace_relation_alias_endpoints(payload jsonb)
returns text language plpgsql security definer set search_path = pg_catalog as $$
declare
  target_id bigint;
  target_ids bigint[];
  publication uuid;
  reason text;
  stamp double precision;
  supplied_count integer;
  published_status text;
begin
  perform pg_advisory_xact_lock(hashtextextended('album-haven:local-relation-projection',0));
  select array_agg(l.id order by l.id) into target_ids from app.bootstrap_owners b
    join library.libraries l on l.owner_account_id = b.account_id
      and l.name = 'Local Library' and l.library_kind = 'local'
    where b.owner_key = 'local-bootstrap-owner';
  if coalesce(cardinality(target_ids),0) <> 1 then raise exception 'unsupported endpoint publication target'; end if;
  target_id := target_ids[1];
  perform 1 from library.libraries where id = target_id for update;
  if not found then raise exception 'unsupported endpoint publication target'; end if;
  if jsonb_typeof(payload) is distinct from 'object' then raise exception 'invalid endpoint publication envelope'; end if;
  if (select array_agg(key order by key) from jsonb_object_keys(payload) key)
      is distinct from array['edge_count','endpoint_builder_version','manifest','publication_id','reason_code','relation_metadata','relations_last_built','source_snapshot','status']::text[]
    or jsonb_typeof(payload->'publication_id') is distinct from 'string'
    or coalesce(payload->>'publication_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or payload->>'endpoint_builder_version' is distinct from 'relation-alias-endpoints-v1'
    or coalesce(payload->>'status','') not in ('ready','unavailable')
    then raise exception 'invalid endpoint publication envelope'; end if;
  publication := (payload->>'publication_id')::uuid;
  published_status := payload->>'status';
  if published_status = 'unavailable' then
    if coalesce(payload->>'reason_code','') not in ('unsupported_shape','unsupported_membership','budget_exceeded')
      or payload->'source_snapshot' is distinct from 'null'::jsonb
      or payload->'relation_metadata' is distinct from 'null'::jsonb
      or payload->'relations_last_built' is distinct from 'null'::jsonb
      or payload->'manifest' is distinct from '[]'::jsonb
      or payload->'edge_count' is distinct from '0'::jsonb
      then raise exception 'invalid endpoint unavailable envelope'; end if;
    reason := payload->>'reason_code';
  else
    reason := 'unsupported_shape';
    if payload->'reason_code' = 'null'::jsonb
      and jsonb_typeof(payload->'relations_last_built') = 'number'
      and jsonb_typeof(payload->'edge_count') = 'number' then
      if abs((payload->>'relations_last_built')::numeric) <= 1.7976931348623157e308::numeric
        and (payload->>'edge_count')::numeric between 0 and 100000
        and trunc((payload->>'edge_count')::numeric) = (payload->>'edge_count')::numeric then
        stamp := (payload->>'relations_last_built')::double precision;
        supplied_count := (payload->>'edge_count')::numeric::integer;
        reason := library.relation_alias_endpoint_payload_reason(payload->'source_snapshot',
          payload->'relation_metadata',stamp,payload->'manifest',supplied_count);
      elsif (payload->>'edge_count')::numeric > 100000 then reason := 'budget_exceeded'; end if;
    end if;
  end if;
  -- Expected validation failures invalidate old ready rows in this transaction.
  -- Unexpected failures/cancellation propagate; there is deliberately no handler.
  delete from library.relation_alias_endpoint_publications where library_id = target_id;
  if reason is not null then
    insert into library.relation_alias_endpoint_publications values
      (target_id,publication,'relation-alias-endpoints-v1','unavailable',reason,null,null,null,'[]'::jsonb,0);
    return 'unavailable';
  end if;
  insert into library.relation_alias_endpoint_publications values
    (target_id,publication,'relation-alias-endpoints-v1','ready',null,payload->'source_snapshot',
     payload->'relation_metadata',stamp,payload->'manifest',supplied_count);
  insert into library.relation_alias_endpoints
    select target_id,publication,(r->>'edge_id')::numeric::integer,r->>'origin',
      r->>'raw_alias',r->>'raw_canonical',r->>'alias_key',r->>'canonical_key'
    from jsonb_array_elements(payload->'manifest') r;
  return 'ready';
end $$;

create function library.relation_alias_endpoints_ready(p_library_id bigint)
returns boolean language plpgsql stable set search_path = pg_catalog as $$
declare
  h library.relation_alias_endpoint_publications%rowtype;
  cache jsonb;
  views jsonb;
  rows_manifest jsonb;
  k text;
begin
  if (select count(*) from app.bootstrap_owners b join library.libraries l
      on l.owner_account_id = b.account_id and l.name = 'Local Library' and l.library_kind = 'local'
      where b.owner_key = 'local-bootstrap-owner') <> 1 then return false; end if;
  select l.metadata->'scan_cache' into cache from app.bootstrap_owners b join library.libraries l
    on l.owner_account_id = b.account_id and l.name = 'Local Library' and l.library_kind = 'local'
    where b.owner_key = 'local-bootstrap-owner' and l.id = p_library_id;
  if not found then return false; end if;
  select * into h from library.relation_alias_endpoint_publications where library_id = p_library_id;
  if not found or h.status is distinct from 'ready'
    or h.endpoint_builder_version is distinct from 'relation-alias-endpoints-v1' then return false; end if;
  if library.relation_alias_endpoint_payload_reason(h.source_snapshot,h.relation_metadata,
      h.relations_last_built,h.manifest,h.edge_count) is not null then return false; end if;
  views := cache->'relation_views';
  foreach k in array array['alias_to_canonical','canonical_to_aliases','family_to_artists','folder_related'] loop
    if jsonb_typeof(views->k) is distinct from 'object' then return false; end if;
  end loop;
  foreach k in array array['artists','artists_sidebar','sidebar_families'] loop
    if jsonb_typeof(views->k) is distinct from 'array' then return false; end if;
  end loop;
  if h.source_snapshot is distinct from jsonb_build_object('alias_to_canonical',views->'alias_to_canonical',
      'canonical_to_aliases',views->'canonical_to_aliases')
    or h.relation_metadata is distinct from cache->'relation_projection'
    or to_jsonb(h.relations_last_built) is distinct from cache->'relations_last_built'
    then return false; end if;
  select coalesce(jsonb_agg(jsonb_build_object('edge_id',e.edge_id,'origin',e.origin,
    'raw_alias',e.raw_alias,'raw_canonical',e.raw_canonical,'alias_key',e.alias_key,
    'canonical_key',e.canonical_key) order by e.edge_id),'[]'::jsonb)
    into rows_manifest from library.relation_alias_endpoints e
    where e.library_id = h.library_id and e.publication_id = h.publication_id;
  return rows_manifest = h.manifest;
end $$;

revoke all on table library.relation_alias_endpoint_publications,library.relation_alias_endpoints from public;
revoke all on function library.relation_alias_endpoint_payload_reason(jsonb,jsonb,double precision,jsonb,integer) from public;
revoke all on function library.replace_relation_alias_endpoints(jsonb) from public;
revoke all on function library.relation_alias_endpoints_ready(bigint) from public;
do $$
declare role_name text; table_name text; acl_grant record;
begin
  -- Remove defaults on these new objects only, before granting the 0084 roles.
  -- No role membership, schema, configuration or existing-object grants change.
  for acl_grant in
    select distinct c.oid::regclass::text object_name, r.rolname grantee
    from pg_class c cross join lateral aclexplode(c.relacl) a
    join pg_roles r on r.oid = a.grantee
    where c.oid in ('library.relation_alias_endpoint_publications'::regclass,
                    'library.relation_alias_endpoints'::regclass)
      and a.grantee <> c.relowner
  loop
    execute format('revoke all on table %s from %I',acl_grant.object_name,acl_grant.grantee);
  end loop;
  for acl_grant in
    select distinct p.oid::regprocedure::text object_name, r.rolname grantee
    from pg_proc p cross join lateral aclexplode(p.proacl) a
    join pg_roles r on r.oid = a.grantee
    where p.oid in ('library.replace_relation_alias_endpoints(jsonb)'::regprocedure,
      'library.relation_alias_endpoints_ready(bigint)'::regprocedure,
      'library.relation_alias_endpoint_payload_reason(jsonb,jsonb,double precision,jsonb,integer)'::regprocedure)
      and a.grantee <> p.proowner
  loop
    execute format('revoke all on function %s from %I',acl_grant.object_name,acl_grant.grantee);
  end loop;
  foreach role_name in array array['album_haven_app','album_haven_readonly'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on table library.relation_alias_endpoint_publications,library.relation_alias_endpoints from %I',role_name);
      execute format('grant select on table library.relation_alias_endpoint_publications,library.relation_alias_endpoints to %I',role_name);
      execute format('grant execute on function library.relation_alias_endpoints_ready(bigint),library.relation_alias_endpoint_payload_reason(jsonb,jsonb,double precision,jsonb,integer) to %I',role_name);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.replace_relation_alias_endpoints(jsonb) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on table library.relation_alias_endpoint_publications,library.relation_alias_endpoints to album_haven_migrator;
    grant execute on function library.replace_relation_alias_endpoints(jsonb),library.relation_alias_endpoints_ready(bigint),
      library.relation_alias_endpoint_payload_reason(jsonb,jsonb,double precision,jsonb,integer) to album_haven_migrator;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on function library.replace_relation_alias_endpoints(jsonb) from album_haven_readonly;
    if has_function_privilege('album_haven_readonly','library.replace_relation_alias_endpoints(jsonb)','EXECUTE') then
      raise exception 'unexpected inherited endpoint publication privilege';
    end if;
  end if;
  -- Verify effective privileges after every grant, including inherited paths.
  foreach role_name in array array['album_haven_app','album_haven_readonly'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      foreach table_name in array array['library.relation_alias_endpoint_publications','library.relation_alias_endpoints'] loop
        if has_table_privilege(role_name,table_name,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
          raise exception 'unexpected inherited endpoint mutation privilege';
        end if;
      end loop;
    end if;
  end loop;
end $$;
