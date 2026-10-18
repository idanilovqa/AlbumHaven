-- Dormant C-1: independent owner-approved artwork publication storage.
-- No application dispatch, route, native integration or public proof access.
-- The authenticated service validates canonical codec bytes, full S/current
-- policy and HMAC consent. SQL independently validates immutable values/scopes.
-- JSONB value digests below are NOT the codec's canonical-byte digests.
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    raise exception using errcode='42501',message='Artwork publication requires a non-superuser migration owner';
  end if;
end $$;

alter table app.album_list_publications drop constraint album_list_publications_contract_version_check;
alter table app.album_list_publications add constraint album_list_publications_contract_version_check
  check(contract_version in (1,2));
alter table app.album_list_publication_seals drop constraint album_list_publication_seals_seal_contract_version_check;
alter table app.album_list_publication_seals add constraint album_list_publication_seals_seal_contract_version_check
  check(seal_contract_version in (1,2));

create table app.album_top_artwork_publication_lineage (
  publication_ref uuid primary key references app.album_list_publications(ref),
  top_ref uuid not null,
  library_id bigint not null,
  owner_account_id bigint not null,
  build_xid xid8 not null,
  preparation_kind text not null check(preparation_kind in ('saved','draft')),
  preparation_ref uuid not null unique,
  preparation_revision bigint not null check(preparation_revision>0),
  original_session_id bigint not null check(original_session_id>0),
  context_ref text not null check(context_ref ~ '^[0-9a-f]{64}$'),
  old_top_revision bigint not null check(old_top_revision>0),
  approved_top_revision bigint not null check(approved_top_revision=old_top_revision+1),
  old_next_original_position bigint not null check(old_next_original_position>0),
  old_baseline_digest text not null check(old_baseline_digest ~ '^[0-9a-f]{64}$'),
  request_generation bigint not null check(request_generation between 1 and 253402300799),
  start_request_key uuid not null,
  manifest_digest text not null check(manifest_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  expires_at timestamptz not null check(expires_at=created_at+interval '60 minutes'),
  draft_ref uuid,
  draft_revision bigint,
  baseline_digest text,
  action text not null check(action in ('save','enable_external')),
  normalized_title text not null check(length(normalized_title) between 1 and 100 and normalized_title=btrim(normalized_title)),
  normalized_description text not null check(length(normalized_description)<=1000),
  evidence_revision text not null check(evidence_revision ~ '^[0-9a-f]{64}$'),
  review_digest text not null check(review_digest ~ '^[0-9a-f]{64}$'),
  full_s_digest text not null check(full_s_digest ~ '^[0-9a-f]{64}$'),
  intent_digest text not null check(intent_digest ~ '^[0-9a-f]{64}$'),
  asset_manifest_digest text not null check(asset_manifest_digest ~ '^[0-9a-f]{64}$'),
  metadata_generation bigint not null check(metadata_generation>=0),
  operation_key uuid not null,
  command_digest text not null check(command_digest ~ '^[0-9a-f]{64}$'),
  link_state text not null check(link_state in ('no_link','enabled','revoked')),
  link_ref uuid,
  link_revision bigint,
  row_count integer not null check(row_count between 0 and 5000),
  included_count integer not null check(included_count between 0 and row_count),
  proof_reservation bigint not null check(proof_reservation between 1024 and 348161024),
  foreign key(top_ref,library_id,owner_account_id) references app.album_lists(ref,library_id,owner_account_id),
  unique(publication_ref,top_ref,library_id,owner_account_id),
  unique(owner_account_id,library_id,start_request_key),
  unique(owner_account_id,library_id,operation_key),
  check((preparation_kind='saved' and draft_ref is null and draft_revision is null and baseline_digest is null)
    or (preparation_kind='draft' and draft_ref is not null and draft_revision is not null and draft_revision>0 and baseline_digest is not null and baseline_digest ~ '^[0-9a-f]{64}$')),
  check((link_state='no_link' and link_ref is null and link_revision is null)
    or (link_state in ('enabled','revoked') and link_ref is not null and link_revision is not null and link_revision>0)),
  check(action<>'save' or link_state='enabled')
);

create table app.album_top_artwork_publication_baseline (
  publication_ref uuid not null references app.album_top_artwork_publication_lineage(publication_ref),
  item_ref uuid not null,
  catalog_ref uuid not null,
  original_position bigint not null check(original_position>0),
  curator_position integer not null check(curator_position between 1 and 5000),
  primary key(publication_ref,item_ref),
  unique(publication_ref,catalog_ref), unique(publication_ref,original_position), unique(publication_ref,curator_position)
);

create table app.album_top_artwork_publication_logical_rows (
  publication_ref uuid not null references app.album_top_artwork_publication_lineage(publication_ref),
  curator_position integer not null check(curator_position between 1 and 5000),
  row_kind text not null check(row_kind in ('saved','existing','new_local')),
  draft_ref uuid,
  draft_revision bigint,
  row_ref uuid,
  saved_item_ref uuid,
  catalog_ref uuid not null,
  local_album_id bigint not null check(local_album_id>0),
  metadata_source_ref uuid not null,
  metadata_root_id bigint not null check(metadata_root_id>0),
  included boolean not null,
  staged_proof_value_digest text,
  staged_asset_ref uuid,
  expected_original_position bigint not null check(expected_original_position>0),
  primary key(publication_ref,curator_position),
  unique(publication_ref,catalog_ref), unique(publication_ref,row_ref), unique(publication_ref,saved_item_ref),
  check((row_kind='saved' and draft_ref is null and draft_revision is null and row_ref is null and saved_item_ref is not null)
    or (row_kind='existing' and draft_ref is not null and draft_revision is not null and draft_revision>0 and row_ref is not null and saved_item_ref is not null)
    or (row_kind='new_local' and draft_ref is not null and draft_revision is not null and draft_revision>0 and row_ref is not null and saved_item_ref is null)),
  check((included and staged_proof_value_digest is not null and staged_proof_value_digest ~ '^[0-9a-f]{64}$' and staged_asset_ref is not null)
    or (not included and staged_proof_value_digest is null and staged_asset_ref is null))
);

create table app.album_top_artwork_publication_proofs (
  top_ref uuid not null,
  library_id bigint not null,
  owner_account_id bigint not null,
  proof_version integer not null check(proof_version in (1,2)),
  value_digest text not null check(value_digest ~ '^[0-9a-f]{64}$'),
  source_stamp jsonb not null check(jsonb_typeof(source_stamp)='object' and octet_length(source_stamp::text)<=65536),
  acquisition_stamp jsonb not null check(jsonb_typeof(acquisition_stamp)='object' and octet_length(acquisition_stamp::text)<=2048),
  primary key(top_ref,value_digest),
  unique(top_ref,library_id,owner_account_id,value_digest),
  foreign key(top_ref,library_id,owner_account_id) references app.album_lists(ref,library_id,owner_account_id)
);

create table app.album_top_artwork_publication_rows (
  publication_ref uuid not null,
  top_ref uuid not null,
  library_id bigint not null,
  owner_account_id bigint not null,
  curator_position integer not null check(curator_position between 1 and 5000),
  item_ref uuid not null,
  catalog_ref uuid not null,
  original_position bigint not null check(original_position>0),
  presentation_ref uuid not null,
  local_album_id bigint not null check(local_album_id>0),
  metadata_source_ref uuid not null,
  metadata_root_id bigint not null check(metadata_root_id>0),
  included boolean not null,
  artwork_root_id bigint,
  asset_ref uuid,
  proof_value_digest text,
  primary key(publication_ref,curator_position),
  unique(publication_ref,item_ref), unique(publication_ref,catalog_ref), unique(publication_ref,original_position),
  foreign key(publication_ref,top_ref,library_id,owner_account_id)
    references app.album_top_artwork_publication_lineage(publication_ref,top_ref,library_id,owner_account_id),
  foreign key(publication_ref,curator_position)
    references app.album_top_artwork_publication_logical_rows(publication_ref,curator_position),
  foreign key(publication_ref,item_ref) references app.album_list_publication_items(publication_ref,item_ref),
  foreign key(asset_ref,top_ref,library_id,owner_account_id)
    references app.album_top_artwork_assets(ref,top_ref,library_id,owner_account_id),
  foreign key(top_ref,library_id,owner_account_id,proof_value_digest)
    references app.album_top_artwork_publication_proofs(top_ref,library_id,owner_account_id,value_digest),
  check((included and artwork_root_id is not null and artwork_root_id>0 and asset_ref is not null and proof_value_digest is not null)
    or (not included and artwork_root_id is null and asset_ref is null and proof_value_digest is null))
);
create index top_artwork_publication_asset_pins on app.album_top_artwork_publication_rows(asset_ref) where asset_ref is not null;

-- Terminal evidence is not content and is minted only by the fixed consume
-- definer after the existing operation receipt, seal and exact reclamation.
create table app.album_top_artwork_publication_consumptions (
  publication_ref uuid primary key references app.album_top_artwork_publication_lineage(publication_ref),
  build_xid xid8 not null,
  seal_digest text not null check(seal_digest ~ '^[0-9a-f]{64}$'),
  preparation_ref uuid not null unique,
  removed_items integer not null check(removed_items between 0 and 5000),
  released_proof_bytes bigint not null check(released_proof_bytes between 1024 and 348161024),
  consumed_at timestamptz not null
);

create function app._artwork_publication_value_digest(label text,value jsonb)
returns bytea language sql immutable strict set search_path=pg_catalog as $$
  select sha256(convert_to(label,'UTF8')||decode('00','hex')||convert_to(value::text,'UTF8'))
$$;
create function app._artwork_publication_proof_digest(p_top uuid,p_library bigint,p_owner bigint,s jsonb,a jsonb)
returns text language sql immutable strict set search_path=pg_catalog as $$
  select encode(app._artwork_publication_value_digest('artwork-publication-proof-jsonb-v1',
    jsonb_build_array(p_top,p_library,p_owner,case when s ? 'descriptor_version' then 2 else 1 end,s,a)),'hex')
$$;

create function app._artwork_publication_immutable() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  raise exception using errcode='55000',constraint='top_artwork_publication_immutable',message='Retained artwork publication is immutable';
end $$;
create function app._artwork_publication_child_open() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$ begin
  if not exists(select 1 from app.album_list_publication_seals s
      join app.album_list_publications h on h.ref=s.publication_ref
      where s.publication_ref=NEW.publication_ref and s.sealed_at is null
        and s.build_xid=pg_current_xact_id() and s.seal_contract_version=2 and h.contract_version=2) then
    raise exception using errcode='55000',constraint='top_artwork_publication_open',message='Artwork publication generation is not open';
  end if;
  return NEW;
end $$;
do $$ declare name text; begin
  foreach name in array array['album_top_artwork_publication_lineage','album_top_artwork_publication_baseline',
      'album_top_artwork_publication_logical_rows','album_top_artwork_publication_proofs',
      'album_top_artwork_publication_rows','album_top_artwork_publication_consumptions'] loop
    execute format('create trigger artwork_publication_immutable before update or delete on app.%I for each row execute function app._artwork_publication_immutable()',name);
    execute format('create trigger artwork_publication_no_truncate before truncate on app.%I for each statement execute function app._artwork_publication_immutable()',name);
    if name not in ('album_top_artwork_publication_proofs','album_top_artwork_publication_consumptions') then
      execute format('create trigger artwork_publication_child_open before insert on app.%I for each row execute function app._artwork_publication_child_open()',name);
    end if;
  end loop;
end $$;

create or replace function app.open_album_publication_generation()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$ begin
  insert into app.album_list_publication_seals(publication_ref,build_xid,seal_contract_version)
    values(NEW.ref,pg_current_xact_id(),NEW.contract_version);
  return null;
end $$;

-- Legacy integer identities are intentionally not restricted to int64. Their
-- transport is bounded by the source/acquisition SQL byte limits, as the codec.
create function app._artwork_publication_legacy_pair_valid(s jsonb,a jsonb,p_library bigint,p_local bigint)
returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare f jsonb; part jsonb; k text; pieces text[]:='{}'; roots text[];
  sk text[]:=array['library_id','local_album_id','artwork_root_id','artwork_root_path',
    'stored_cover_path','resolved_cover_path','relative_parts','root_device','root_inode'];
begin
  if s is null or a is null or jsonb_typeof(s)<>'object' or jsonb_typeof(a)<>'object'
      or octet_length(s::text)>65536 or octet_length(a::text)>2048 then return false; end if;
  if not(s ?& sk) or s-sk<>'{}'::jsonb
      or not(a ?& array['file','input_bytes','input_pixels'])
      or a-array['file','input_bytes','input_pixels']<>'{}'::jsonb then return false; end if;
  foreach k in array array['library_id','local_album_id','artwork_root_id'] loop
    if not app._top_artwork_json_integer(s->k,1,9223372036854775807) then return false; end if;
  end loop;
  if s->>'library_id' is distinct from p_library::text or s->>'local_album_id' is distinct from p_local::text then return false; end if;
  foreach k in array array['root_device','root_inode'] loop
    if jsonb_typeof(s->k) is distinct from 'number' or (s->>k) !~ '^(0|[1-9][0-9]*)$' then return false; end if;
  end loop;
  if jsonb_typeof(s->'artwork_root_path') is distinct from 'string'
      or octet_length(s->>'artwork_root_path') not between 1 and 8192
      or left(s->>'artwork_root_path',1)<>'/'
      or jsonb_typeof(s->'stored_cover_path') is distinct from 'string'
      or octet_length(s->>'stored_cover_path') not between 1 and 16384
      or strpos(s->>'stored_cover_path','://')>0
      or jsonb_typeof(s->'resolved_cover_path') is distinct from 'string'
      or octet_length(s->>'resolved_cover_path') not between 1 and 16384
      or jsonb_typeof(s->'relative_parts') is distinct from 'array' then return false; end if;
  if jsonb_array_length(s->'relative_parts') not between 1 and 256 then return false; end if;
  for part in select value from jsonb_array_elements(s->'relative_parts') loop
    if jsonb_typeof(part)<>'string' or octet_length(part#>>'{}') not between 1 and 16384
        or part#>>'{}' in ('.','..') or strpos(part#>>'{}','/')>0 then return false; end if;
    pieces:=array_append(pieces,part#>>'{}');
  end loop;
  roots:=case when s->>'artwork_root_path'='/' then '{}'::text[]
    else string_to_array(substring(s->>'artwork_root_path' from 2),'/') end;
  if exists(select 1 from unnest(roots) x where x in ('','.','..'))
      or cardinality(roots)+1+cardinality(pieces)>256
      or s->>'resolved_cover_path' is distinct from '/'||array_to_string(roots||pieces,'/') then return false; end if;
  f:=a->'file';
  if jsonb_typeof(f) is distinct from 'object'
      or not(f ?& array['device','inode','size','mtime_ns','ctime_ns'])
      or f-array['device','inode','size','mtime_ns','ctime_ns']<>'{}'::jsonb then return false; end if;
  foreach k in array array['device','inode'] loop
    if jsonb_typeof(f->k) is distinct from 'number' or (f->>k) !~ '^(0|[1-9][0-9]*)$' then return false; end if;
  end loop;
  foreach k in array array['mtime_ns','ctime_ns'] loop
    if jsonb_typeof(f->k) is distinct from 'number' or (f->>k) !~ '^(0|-?[1-9][0-9]*)$' then return false; end if;
  end loop;
  return app._top_artwork_json_integer(f->'size',1,16777216)
    and app._top_artwork_json_integer(a->'input_bytes',1,16777216)
    and app._top_artwork_json_integer(a->'input_pixels',1,16000000)
    and f->'size'=a->'input_bytes';
end $$;

-- Reuse 0134's exact v2 structural predicate without pretending a SQL JSONB
-- rendering is codec canonical. The transient substituted digest is ONLY for
-- invoking its shape checks; the original declared digest remains unchanged
-- in staging/retained values and real witness binding is required at transfer.
create function app._artwork_publication_pair_shape(s jsonb,a jsonb,p_library bigint,p_local bigint)
returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare witness text; structural_acquisition jsonb;
begin
  if s is null or a is null or jsonb_typeof(s)<>'object' or jsonb_typeof(a)<>'object' then return false; end if;
  if not(s ? 'descriptor_version') then
    return app._artwork_publication_legacy_pair_valid(s,a,p_library,p_local);
  end if;
  if jsonb_typeof(a->'descriptor_digest') is distinct from 'string'
      or (a->>'descriptor_digest') !~ '^[0-9a-f]{64}$' then return false; end if;
  witness:=s::text;
  structural_acquisition:=jsonb_set(a,'{descriptor_digest}',to_jsonb(encode(sha256(
    convert_to('AlbumHaven/artwork-descriptor/v2','UTF8')||decode('00','hex')||convert_to(witness,'UTF8')),'hex')),false);
  return app._top_artwork_v2_pair_valid(s,structural_acquisition,witness,p_library,p_local);
end $$;

-- One private projection of exact staging. No external source/proof arrays are
-- accepted. Every caller uses keyset pages of 100 (with a 101-row sentinel).
create function app._artwork_publication_staging(p_ref uuid,p_after integer,p_limit integer)
returns table(position integer,row_kind text,draft_ref uuid,draft_revision bigint,row_ref uuid,
  saved_item_ref uuid,catalog_ref uuid,local_album_id bigint,metadata_source_ref uuid,metadata_root_id bigint,
  included boolean,status text,asset_ref uuid,source_stamp jsonb,acquisition_stamp jsonb)
language sql stable security definer set search_path=pg_catalog as $$
  select x.* from (
    (select i.position,'saved'::text,null::uuid,null::bigint,null::uuid,i.item_ref,i.catalog_ref,
      i.selected_local_album_id,i.selected_source_ref,i.selected_library_root_id,i.included,i.status,
      i.asset_ref,i.source_stamp,i.acquisition_stamp
    from app.album_top_artwork_preparation_items i join app.album_top_artwork_preparations p
      on p.ref=i.preparation_ref and p.preparation_kind='saved'
    where i.preparation_ref=p_ref and i.position>p_after
    order by i.position limit least(greatest(p_limit,0),101))
    union all
    (select i.position,i.row_kind,p.draft_ref,p.draft_revision,i.row_ref,i.saved_item_ref,i.catalog_ref,
      i.selected_local_album_id,i.selected_source_ref,i.selected_library_root_id,i.included,i.status,
      i.asset_ref,i.source_stamp,i.acquisition_stamp
    from app.album_top_artwork_draft_items i join app.album_top_artwork_preparations p
      on p.ref=i.preparation_ref and p.preparation_kind='draft'
    where i.preparation_ref=p_ref and i.position>p_after
    order by i.position limit least(greatest(p_limit,0),101))
  ) x order by x.position limit least(greatest(p_limit,0),101)
$$;

create function app._artwork_publication_logical_leaf(p_position integer,p_kind text,p_draft uuid,
  p_draft_revision bigint,p_row uuid,p_saved uuid,p_catalog uuid,p_local bigint,p_source uuid,
  p_root bigint,p_included boolean,p_proof text,p_asset uuid)
returns bytea language sql immutable set search_path=pg_catalog as $$
  select app._artwork_publication_value_digest('artwork-publication-logical-v2/row',
    jsonb_build_array(p_position,p_kind,p_draft,p_draft_revision,p_row,p_saved,p_catalog,p_local,
      p_source,p_root,p_included,p_proof,p_asset))
$$;
create function app._artwork_publication_logical_fingerprint(p_ref uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog as $$
declare l app.album_top_artwork_publication_lineage%rowtype; r record; state bytea; n integer:=0; page_count integer;
begin
  select * into strict l from app.album_top_artwork_publication_lineage where publication_ref=p_ref;
  state:=app._artwork_publication_value_digest('artwork-publication-logical-v2/header',jsonb_build_array(
    2,l.top_ref,l.library_id,l.owner_account_id,l.preparation_kind,l.preparation_ref,l.preparation_revision,
    l.old_top_revision,l.approved_top_revision,l.action,l.normalized_title,l.normalized_description,
    l.evidence_revision,l.review_digest,l.full_s_digest,l.intent_digest,l.row_count));
  loop
    page_count:=0;
    for r in select * from app.album_top_artwork_publication_logical_rows where publication_ref=p_ref
        and curator_position>n order by curator_position limit 101 loop
      exit when page_count=100;
      if r.curator_position<>n+1 or n>=5000 then
        raise exception using errcode='23514',constraint='top_artwork_publication_binding',message='Artwork publication binding invalid';
      end if;
      state:=sha256(convert_to('artwork-publication-logical-v2/step','UTF8')||decode('00','hex')||state||
        app._artwork_publication_logical_leaf(r.curator_position,r.row_kind,r.draft_ref,r.draft_revision,
          r.row_ref,r.saved_item_ref,r.catalog_ref,r.local_album_id,r.metadata_source_ref,r.metadata_root_id,
          r.included,r.staged_proof_value_digest,r.staged_asset_ref));
      n:=n+1; page_count:=page_count+1;
    end loop;
    exit when page_count<100 or n=5000;
  end loop;
  if n<>l.row_count then
    raise exception using errcode='23514',constraint='top_artwork_publication_binding',message='Artwork publication binding invalid';
  end if;
  return encode(app._artwork_publication_value_digest('artwork-publication-logical-v2/final',
    jsonb_build_array(n,encode(state,'hex'))),'hex');
end $$;

create function app.top_artwork_start_consumed(p_top uuid,p_library bigint,p_owner bigint,p_key uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog as $$ begin
  if not exists(select 1 from app.album_lists where ref=p_top and library_id=p_library
      and owner_account_id=p_owner and deleted_at is null) then
    raise exception using errcode='55000',constraint='top_artwork_scope',message='Artwork scope changed';
  end if;
  return exists(select 1 from app.album_top_artwork_publication_lineage
    where owner_account_id=p_owner and library_id=p_library and start_request_key=p_key);
end $$;

create function app.admit_top_artwork_publication(p_publication uuid,p_preparation uuid,p_owner bigint,
  p_session bigint,p_context text,p_preparation_revision bigint,p_top_revision bigint,p_action text,
  p_title text,p_description text,p_evidence_revision text,p_review_digest text,p_full_s_digest text,
  p_intent_digest text,p_asset_manifest_digest text,p_metadata_generation bigint,p_operation_key uuid,
  p_command_digest text,p_link_state text,p_link_revision bigint)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare p app.album_top_artwork_preparations%rowtype; t app.album_lists%rowtype; link app.shared_links%rowtype;
  r record; state bytea; proof text; fingerprint text; n integer:=0; inc integer:=0; page_count integer;
  reservation bigint; baseline text; next_original bigint; original bigint; public_revision bigint; k text; image_bytes bigint:=0; image_length integer; last_album bigint:=0; locked_count integer;
begin
  if p_publication is null or p_publication='00000000-0000-0000-0000-000000000000'
      or p_operation_key is null or p_operation_key='00000000-0000-0000-0000-000000000000'
      or p_title is null or p_title<>btrim(p_title, ' '||chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(28)||chr(29)||chr(30)||chr(31)||
        chr(133)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||
        chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||
        chr(8239)||chr(8287)||chr(12288)) or length(p_title) not between 1 and 100
      or p_description is null or length(p_description)>1000
      or (p_title||p_description) ~ '[\x01-\x1f\x7f]'
      or p_action is null or p_action not in ('save','enable_external')
      or p_metadata_generation is null or p_metadata_generation<0 then
    raise exception using errcode='23514',constraint='top_artwork_publication_binding',message='Artwork publication binding invalid';
  end if;
  foreach k in array array[p_evidence_revision,p_review_digest,p_full_s_digest,p_intent_digest,p_asset_manifest_digest,p_command_digest] loop
    if k is null or k !~ '^[0-9a-f]{64}$' then
      raise exception using errcode='23514',constraint='top_artwork_publication_binding',message='Artwork publication binding invalid';
    end if;
  end loop;
  select * into p from app.album_top_artwork_preparations where ref=p_preparation;
  if not found then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  perform app.lock_top_artwork_scope(p.top_ref,p.library_id,p_owner,p_top_revision);
  select * into t from app.album_lists where ref=p.top_ref;
  select * into link from app.shared_links where top_ref=p.top_ref for update;
  if (coalesce(link.state,'no_link'),link.link_revision) is distinct from (p_link_state,p_link_revision)
      or (p_action='save' and p_link_state is distinct from 'enabled') then
    raise exception using errcode='23514',constraint='top_artwork_publication_link',message='Artwork publication intent changed';
  end if;
  -- Sorted local locks precede metadata and preparation/budget locks. No new
  -- account/session authority is acquired here; that remains the service owner.
  loop
    locked_count:=0;
    for r in select a.id from library.local_albums a where a.library_id=p.library_id and a.id>last_album and a.id in (
      select selected_local_album_id from app.album_top_artwork_preparation_items where preparation_ref=p.ref
      union select selected_local_album_id from app.album_top_artwork_draft_items where preparation_ref=p.ref)
      order by a.id limit 100 for share loop
      last_album:=r.id; locked_count:=locked_count+1;
    end loop;
    exit when locked_count<100 or last_album=(select max(selected_local_album_id) from (
      select selected_local_album_id from app.album_top_artwork_preparation_items where preparation_ref=p.ref
      union all select selected_local_album_id from app.album_top_artwork_draft_items where preparation_ref=p.ref) chosen);
  end loop;
  lock table library.album_metadata_sources,library.catalog_album_links,library.local_albums,
    library.local_artists,library.local_tracks,library.local_track_files,library.library_roots in access share mode;
  perform library.lock_public_metadata_source(p.library_id);
  select * into p from app.album_top_artwork_preparations where ref=p_preparation for update;
  if not found or (p.owner_account_id,p.original_session_id,p.context_ref,p.revision,p.top_revision)
      is distinct from (p_owner,p_session,p_context,p_preparation_revision,p_top_revision)
      or p.state<>'ready' or p.expires_at<=clock_timestamp() or p.lease_ref is not null
      or p.item_count<>p.retained_item_count then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  -- The existing zero-image draft claim also transitions its header to ready;
  -- validate that header AND the complete immutable status vector below.
  if p.preparation_kind='draft' then
    perform app._validate_top_artwork_draft(p.ref,p_owner,p_session,p_context,p_top_revision,p.draft_ref,p.draft_revision);
  elsif p.item_count<>(select count(*) from app.album_list_items where top_ref=p.top_ref) then
    raise exception using errcode='23514',constraint='top_artwork_publication_binding',message='Artwork publication binding invalid';
  end if;
  baseline:=app._top_artwork_draft_baseline(p.top_ref,p.library_id,p_owner,p_top_revision);
  if (select generation from library.public_metadata_source_state where library_id=p.library_id)
      is distinct from p_metadata_generation then
    raise exception using errcode='23514',constraint='top_artwork_publication_binding',message='Artwork publication evidence changed';
  end if;
  perform app.lock_top_artwork_budgets(p.top_ref,p.library_id,p_owner);
  if p.expires_at<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  if t.revision=9223372036854775807 or link.link_revision=9223372036854775807 then
    raise exception using errcode='23514',constraint='top_artwork_publication_binding',message='Artwork publication revision exhausted';
  end if;
  if t.next_original_position<=coalesce((select max(original_position) from app.album_list_items where top_ref=p.top_ref),0) then
    raise exception using errcode='23514',constraint='top_artwork_publication_binding',message='Artwork publication original positions invalid';
  end if;
  select coalesce(max(publication_revision),0)+1 into public_revision from app.album_list_publications where top_ref=p.top_ref;
  state:=app._artwork_publication_value_digest('artwork-publication-logical-v2/header',jsonb_build_array(
    2,p.top_ref,p.library_id,p_owner,p.preparation_kind,p.ref,p.revision,p.top_revision,p.top_revision+1,
    p_action,p_title,p_description,p_evidence_revision,p_review_digest,p_full_s_digest,p_intent_digest,p.item_count));
  loop
    page_count:=0;
    for r in select * from app._artwork_publication_staging(p.ref,n,101) loop
      exit when page_count=100;
      if r.position<>n+1 or n>=5000
          or (r.included and r.status<>'ready') or (not r.included and r.status<>'excluded')
          or not exists(select 1 from library.album_metadata_sources s
            join library.local_albums a on a.library_id=s.library_id and a.id=s.local_album_id
            join library.library_roots root on root.id=s.library_root_id and root.library_id=s.library_id and root.is_active
            join library.catalog_album_links c on c.library_id=s.library_id and c.local_album_id=s.local_album_id
            where s.ref=r.metadata_source_ref and s.library_id=p.library_id and s.local_album_id=r.local_album_id
              and s.library_root_id=r.metadata_root_id and s.state='active' and s.capture_builder_version=1
              and s.title_origin='tag_metadata' and s.artist_origin='tag_metadata' and c.catalog_ref=r.catalog_ref)
          or (r.row_kind='saved' and not exists(select 1 from app.album_list_items i where i.ref=r.saved_item_ref
            and i.top_ref=p.top_ref and i.library_id=p.library_id and i.catalog_ref=r.catalog_ref and i.curator_position=r.position)) then
        raise exception using errcode='23514',constraint='top_artwork_publication_binding',message='Artwork publication binding invalid';
      end if;
      if r.included then
        if not app._artwork_publication_pair_shape(r.source_stamp,r.acquisition_stamp,p.library_id,r.local_album_id) then
          raise exception using errcode='23514',constraint='top_artwork_publication_proof',message='Artwork publication proof invalid';
        end if;
        select byte_length into image_length from app.album_top_artwork_assets where ref=r.asset_ref
          and top_ref=p.top_ref and library_id=p.library_id and owner_account_id=p_owner;
        if not found or not exists(select 1 from library.library_roots where library_id=p.library_id
            and id=(r.source_stamp->>'artwork_root_id')::bigint and root_path=r.source_stamp->>'artwork_root_path' and is_active) then
          raise exception using errcode='23514',constraint='top_artwork_publication_proof',message='Artwork publication proof invalid';
        end if;
        image_bytes:=image_bytes+image_length;
        if image_bytes>134217728 then
          raise exception using errcode='23514',constraint='top_artwork_publication_budget',message='Artwork publication budget exceeded';
        end if;
      end if;
      proof:=case when r.included then app._artwork_publication_proof_digest(p.top_ref,p.library_id,p_owner,r.source_stamp,r.acquisition_stamp) end;
      state:=sha256(convert_to('artwork-publication-logical-v2/step','UTF8')||decode('00','hex')||state||
        app._artwork_publication_logical_leaf(r.position,r.row_kind,r.draft_ref,r.draft_revision,r.row_ref,
          r.saved_item_ref,r.catalog_ref,r.local_album_id,r.metadata_source_ref,r.metadata_root_id,r.included,proof,r.asset_ref));
      n:=n+1; inc:=inc+case when r.included then 1 else 0 end; page_count:=page_count+1;
    end loop;
    exit when page_count<100 or n=5000;
  end loop;
  if n<>p.item_count or exists(select 1 from app.album_top_artwork_preparation_items where preparation_ref=p.ref and p.preparation_kind<>'saved')
      or exists(select 1 from app.album_top_artwork_draft_items where preparation_ref=p.ref and p.preparation_kind<>'draft') then
    raise exception using errcode='23514',constraint='top_artwork_publication_binding',message='Artwork publication binding invalid';
  end if;
  fingerprint:=encode(app._artwork_publication_value_digest('artwork-publication-logical-v2/final',jsonb_build_array(n,encode(state,'hex'))),'hex');
  reservation:=1024::bigint+inc::bigint*69632+(n-inc)::bigint*1024;
  insert into app.album_list_publications(ref,top_ref,library_id,publication_revision,approved_top_revision,
    approved_by_account_id,title,description,contract_version,content_fingerprint)
    values(p_publication,p.top_ref,p.library_id,public_revision,p.top_revision+1,p_owner,p_title,p_description,2,fingerprint);
  insert into app.album_top_artwork_publication_lineage values(p_publication,p.top_ref,p.library_id,p_owner,
    pg_current_xact_id(),p.preparation_kind,p.ref,p.revision,p.original_session_id,p.context_ref,p.top_revision,
    p.top_revision+1,t.next_original_position,baseline,p.request_generation,p.start_request_key,p.manifest_digest,
    p.created_at,p.expires_at,p.draft_ref,p.draft_revision,p.baseline_digest,p_action,p_title,p_description,
    p_evidence_revision,p_review_digest,p_full_s_digest,p_intent_digest,p_asset_manifest_digest,p_metadata_generation,
    p_operation_key,p_command_digest,p_link_state,link.ref,p_link_revision,n,inc,reservation);
  insert into app.album_top_artwork_publication_baseline select p_publication,ref,catalog_ref,original_position,curator_position
    from app.album_list_items where top_ref=p.top_ref and library_id=p.library_id order by curator_position;
  n:=0; next_original:=t.next_original_position;
  loop
    page_count:=0;
    for r in select * from app._artwork_publication_staging(p.ref,n,101) loop
      exit when page_count=100;
      if r.saved_item_ref is null then original:=next_original; next_original:=next_original+1;
      else select original_position into strict original from app.album_top_artwork_publication_baseline
        where publication_ref=p_publication and item_ref=r.saved_item_ref; end if;
      insert into app.album_top_artwork_publication_logical_rows values(p_publication,r.position,r.row_kind,
        r.draft_ref,r.draft_revision,r.row_ref,r.saved_item_ref,r.catalog_ref,r.local_album_id,r.metadata_source_ref,
        r.metadata_root_id,r.included,case when r.included then app._artwork_publication_proof_digest(
          p.top_ref,p.library_id,p_owner,r.source_stamp,r.acquisition_stamp) end,r.asset_ref,original);
      n:=r.position; page_count:=page_count+1;
    end loop;
    exit when page_count<100 or n=5000;
  end loop;
  if app._artwork_publication_logical_fingerprint(p_publication) is distinct from fingerprint or p.expires_at<=clock_timestamp() then
    raise exception using errcode='23514',constraint='top_artwork_publication_binding',message='Artwork publication binding invalid';
  end if;
  return fingerprint;
end $$;

-- Transition checking deliberately never re-enters the N baseline/new-local
-- absence validators. The admitted old identity is now immutable; N+1 working
-- rows and their source bridge must independently match it.
create function app._artwork_publication_transition(p_ref uuid,p_open boolean)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare l app.album_top_artwork_publication_lineage%rowtype; t app.album_lists%rowtype; s app.album_list_publication_seals%rowtype;
begin
  select * into l from app.album_top_artwork_publication_lineage where publication_ref=p_ref;
  if not found or l.build_xid<>pg_current_xact_id() then
    raise exception using errcode='55000',constraint='top_artwork_publication_open',message='Artwork publication generation is not open';
  end if;
  select * into t from app.album_lists where ref=l.top_ref for update;
  select * into s from app.album_list_publication_seals where publication_ref=p_ref for update;
  if not found or s.build_xid<>l.build_xid or s.seal_contract_version<>2
      or (p_open and s.sealed_at is not null)
      or (t.library_id,t.owner_account_id,t.revision,t.title,t.description) is distinct from
        (l.library_id,l.owner_account_id,l.approved_top_revision,l.normalized_title,l.normalized_description)
      or t.deleted_at is not null or l.expires_at<=clock_timestamp()
      or t.next_original_position<>l.old_next_original_position+(select count(*)
        from app.album_top_artwork_publication_logical_rows where publication_ref=p_ref and row_kind='new_local')
      or (select count(*) from app.album_list_items where top_ref=l.top_ref)<>l.row_count
      or exists(select 1 from app.album_list_item_remote_sources where top_ref=l.top_ref) then
    raise exception using errcode='23514',constraint='top_artwork_publication_transition',message='Artwork publication transition invalid';
  end if;
end $$;

create function app.map_top_artwork_publication_page(p_publication uuid,p_rows jsonb)
returns integer language plpgsql security definer set search_path=pg_catalog as $$
declare l app.album_top_artwork_publication_lineage%rowtype; q app.album_top_artwork_publication_logical_rows%rowtype;
  p app.album_top_artwork_preparations%rowtype; r record; x jsonb; n integer; pos integer; actual uuid;
  presentation uuid; original bigint; proof text; proof_version integer; witness text; prior record;
  source_value jsonb; acquisition_value jsonb; asset uuid; root bigint;
begin
  if p_rows is null or jsonb_typeof(p_rows)<>'array' then
    raise exception using errcode='23514',constraint='top_artwork_publication_mapping',message='Artwork publication mapping invalid';
  end if;
  n:=jsonb_array_length(p_rows);
  if n not between 1 and 100 or octet_length(p_rows::text)>16777216 then
    raise exception using errcode='23514',constraint='top_artwork_publication_mapping',message='Artwork publication mapping invalid';
  end if;
  perform app._artwork_publication_transition(p_publication,true);
  select * into strict l from app.album_top_artwork_publication_lineage where publication_ref=p_publication;
  select * into p from app.album_top_artwork_preparations where ref=l.preparation_ref for update;
  if not found or (p.top_ref,p.library_id,p.owner_account_id,p.revision,p.original_session_id,p.context_ref,
      p.request_generation,p.manifest_digest,p.item_count,p.retained_item_count,p.expires_at,p.preparation_kind)
      is distinct from (l.top_ref,l.library_id,l.owner_account_id,l.preparation_revision,l.original_session_id,l.context_ref,
        l.request_generation,l.manifest_digest,l.row_count,l.row_count,l.expires_at,l.preparation_kind)
      or p.state<>'ready' or p.lease_ref is not null then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  perform app.lock_top_artwork_budgets(l.top_ref,l.library_id,l.owner_account_id);
  if l.expires_at<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  -- Pages append in curator order; duplicate/replayed pages fail atomically.
  select coalesce(max(curator_position),0) into pos from app.album_top_artwork_publication_rows where publication_ref=p_publication;
  for x in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(x) is distinct from 'object' then
      raise exception using errcode='23514',constraint='top_artwork_publication_mapping',message='Artwork publication mapping invalid';
    end if;
    if not(x ?& array['curator_position','item_ref','original_position','presentation_ref','descriptor_witness'])
        or x-array['curator_position','item_ref','original_position','presentation_ref','descriptor_witness']<>'{}'::jsonb
        or not app._top_artwork_json_integer(x->'curator_position',1,5000)
        or not app._top_artwork_json_integer(x->'original_position',1,9223372036854775807)
        or jsonb_typeof(x->'item_ref') is distinct from 'string'
        or (x->>'item_ref') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(x->'presentation_ref') is distinct from 'string'
        or (x->>'presentation_ref') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(x->'descriptor_witness') not in ('null','string') then
      raise exception using errcode='23514',constraint='top_artwork_publication_mapping',message='Artwork publication mapping invalid';
    end if;
    pos:=pos+1; actual:=(x->>'item_ref')::uuid; original:=(x->>'original_position')::bigint;
    presentation:=(x->>'presentation_ref')::uuid; witness:=x->>'descriptor_witness';
    select * into q from app.album_top_artwork_publication_logical_rows
      where publication_ref=p_publication and curator_position=pos;
    if not found or (x->>'curator_position')::integer<>pos or original<>q.expected_original_position
        or actual='00000000-0000-0000-0000-000000000000'
        or (q.saved_item_ref is not null and actual<>q.saved_item_ref)
        or (q.saved_item_ref is null and exists(select 1 from app.album_top_artwork_publication_baseline
          where publication_ref=p_publication and item_ref=actual))
        or not exists(select 1 from app.album_list_items i join app.album_list_item_publication_sources s
          on s.top_ref=i.top_ref and s.item_ref=i.ref and s.library_id=i.library_id and s.catalog_ref=i.catalog_ref
          where i.ref=actual and i.top_ref=l.top_ref and i.library_id=l.library_id
            and i.catalog_ref=q.catalog_ref and i.curator_position=pos and i.original_position=original
            and s.selected_local_album_id=q.local_album_id and s.selected_source_ref=q.metadata_source_ref)
        or not exists(select 1 from catalog.album_presentation_versions h
          join library.album_presentation_evidence e on e.presentation_ref=h.ref
          join library.album_presentation_seals s on s.presentation_ref=h.ref and s.sealed_at is not null
          where h.ref=presentation and h.catalog_ref=q.catalog_ref and h.contract_version=1
            and s.seal_contract_version=1 and e.library_id=l.library_id and s.library_id=e.library_id
            and e.selected_local_album_id=q.local_album_id and e.selected_source_ref=q.metadata_source_ref
            and e.selected_library_root_id=q.metadata_root_id
            and e.capture_builder_version=1 and s.capture_builder_version=e.capture_builder_version
            and s.selected_source_ref=e.selected_source_ref and s.evidence_digest=e.evidence_digest) then
      raise exception using errcode='23514',constraint='top_artwork_publication_mapping',message='Artwork publication mapping invalid';
    end if;
    select * into r from app._artwork_publication_staging(l.preparation_ref,pos-1,1);
    if not found or (r.position,r.row_kind,r.draft_ref,r.draft_revision,r.row_ref,r.saved_item_ref,r.catalog_ref,
        r.local_album_id,r.metadata_source_ref,r.metadata_root_id,r.included,r.asset_ref) is distinct from
        (q.curator_position,q.row_kind,q.draft_ref,q.draft_revision,q.row_ref,q.saved_item_ref,q.catalog_ref,
          q.local_album_id,q.metadata_source_ref,q.metadata_root_id,q.included,q.staged_asset_ref)
        or (q.included and r.status<>'ready') or (not q.included and r.status<>'excluded') then
      raise exception using errcode='23514',constraint='top_artwork_publication_mapping',message='Artwork publication mapping invalid';
    end if;
    proof:=null; asset:=null; root:=null;
    if q.included then
      source_value:=r.source_stamp; acquisition_value:=r.acquisition_stamp;
      proof_version:=case when source_value ? 'descriptor_version' then 2 else 1 end;
      if (proof_version=1 and (witness is not null or not app._artwork_publication_legacy_pair_valid(
            source_value,acquisition_value,l.library_id,q.local_album_id)))
          or (proof_version=2 and not app._top_artwork_v2_pair_valid(source_value,acquisition_value,
            witness,l.library_id,q.local_album_id)) then
        raise exception using errcode='23514',constraint='top_artwork_publication_proof',message='Artwork publication proof invalid';
      end if;
      proof:=app._artwork_publication_proof_digest(l.top_ref,l.library_id,l.owner_account_id,source_value,acquisition_value);
      if proof is distinct from q.staged_proof_value_digest then
        raise exception using errcode='23514',constraint='top_artwork_publication_proof',message='Artwork publication proof invalid';
      end if;
      root:=(source_value->>'artwork_root_id')::bigint; asset:=q.staged_asset_ref;
      if not exists(select 1 from app.album_top_artwork_assets a where a.ref=asset
          and a.top_ref=l.top_ref and a.library_id=l.library_id and a.owner_account_id=l.owner_account_id
          and a.sanitizer_contract=1 and a.mime_type='image/png' and a.width between 1 and 256
          and a.height between 1 and 256 and a.byte_length between 1 and 327680)
          or not exists(select 1 from library.library_roots where id=root and library_id=l.library_id
            and root_path=source_value->>'artwork_root_path' and is_active) then
        raise exception using errcode='23514',constraint='top_artwork_publication_proof',message='Artwork publication proof invalid';
      end if;
      insert into app.album_top_artwork_publication_proofs values(l.top_ref,l.library_id,l.owner_account_id,
        proof_version,proof,source_value,acquisition_value) on conflict(top_ref,value_digest) do nothing;
      select * into strict prior from app.album_top_artwork_publication_proofs where top_ref=l.top_ref and value_digest=proof;
      if (prior.library_id,prior.owner_account_id,prior.proof_version,prior.source_stamp,prior.acquisition_stamp)
          is distinct from (l.library_id,l.owner_account_id,proof_version,source_value,acquisition_value) then
        raise exception using errcode='23514',constraint='top_artwork_publication_proof',message='Artwork publication proof invalid';
      end if;
    elsif witness is not null or r.source_stamp is not null or r.acquisition_stamp is not null then
      raise exception using errcode='23514',constraint='top_artwork_publication_proof',message='Artwork publication proof invalid';
    end if;
    insert into app.album_list_publication_items values(p_publication,actual,l.top_ref,l.library_id,q.catalog_ref,
      presentation,original,pos);
    insert into app.album_top_artwork_publication_rows values(p_publication,l.top_ref,l.library_id,l.owner_account_id,
      pos,actual,q.catalog_ref,original,presentation,q.local_album_id,q.metadata_source_ref,q.metadata_root_id,
      q.included,root,asset,proof);
  end loop;
  if l.expires_at<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  return n;
end $$;

-- Constant-state compact sealing: no whole proof or PNG aggregate. This check
-- remains valid after disposable preparation, session and working rows vanish.
create function app._artwork_publication_content_digest(p_ref uuid,p_compare_staging boolean)
returns text language plpgsql stable security definer set search_path=pg_catalog set timezone='UTC' as $$
declare l app.album_top_artwork_publication_lineage%rowtype; h app.album_list_publications%rowtype;
  r record; old record; staged record; proof app.album_top_artwork_publication_proofs%rowtype;
  asset app.album_top_artwork_assets%rowtype; state bytea; leaf jsonb; n integer:=0; inc integer:=0;
  pages integer; baseline_after integer:=0; total_bytes bigint:=0; total_tracks bigint:=0; fingerprint text;
begin
  select * into l from app.album_top_artwork_publication_lineage where publication_ref=p_ref;
  select * into h from app.album_list_publications where ref=p_ref;
  if l.publication_ref is null or h.ref is null or h.contract_version<>2
      or (h.top_ref,h.library_id,h.approved_by_account_id,h.approved_top_revision,h.title,h.description)
        is distinct from (l.top_ref,l.library_id,l.owner_account_id,l.approved_top_revision,l.normalized_title,l.normalized_description)
      or (select count(*) from app.album_list_publication_items where publication_ref=p_ref)<>l.row_count
      or (select count(*) from app.album_top_artwork_publication_rows where publication_ref=p_ref)<>l.row_count then
    raise exception using errcode='23514',constraint='top_artwork_publication_seal',message='Artwork publication seal invalid';
  end if;
  fingerprint:=app._artwork_publication_logical_fingerprint(p_ref);
  if fingerprint is distinct from h.content_fingerprint then
    raise exception using errcode='23514',constraint='top_artwork_publication_seal',message='Artwork publication seal invalid';
  end if;
  state:=app._artwork_publication_value_digest('artwork-publication-seal-v2/header',jsonb_build_array(
    jsonb_build_array(h.ref,h.top_ref,h.library_id,h.publication_revision,h.approved_top_revision,
      h.approved_by_account_id,h.title,h.description,h.contract_version,h.content_fingerprint),to_jsonb(l)));
  -- Old positions are compact, bounded at admission and immutable, including
  -- rows intentionally removed from the approved final vector.
  loop
    pages:=0;
    for old in select * from app.album_top_artwork_publication_baseline where publication_ref=p_ref
        and curator_position>baseline_after order by curator_position limit 101 loop
      exit when pages=100;
      if old.curator_position<>baseline_after+1 or baseline_after>=5000 then
        raise exception using errcode='23514',constraint='top_artwork_publication_seal',message='Artwork publication seal invalid';
      end if;
      state:=sha256(convert_to('artwork-publication-seal-v2/baseline','UTF8')||decode('00','hex')||state||
        app._artwork_publication_value_digest('artwork-publication-seal-v2/old-row',
          jsonb_build_array(old.item_ref,old.catalog_ref,old.original_position,old.curator_position)));
      baseline_after:=old.curator_position; pages:=pages+1;
    end loop;
    exit when pages<100 or baseline_after=5000;
  end loop;
  loop
    pages:=0;
    for r in select m.*,q.row_kind,q.draft_ref,q.draft_revision,q.row_ref,q.saved_item_ref,
        q.expected_original_position,q.staged_asset_ref,q.staged_proof_value_digest,
        q.catalog_ref as logical_catalog,q.local_album_id as logical_local,
        q.metadata_source_ref as logical_source,q.metadata_root_id as logical_root,q.included as logical_included,
        i.item_ref as published_item,i.catalog_ref as published_catalog,i.presentation_ref as published_presentation,
        i.original_position as published_original,i.curator_position as published_position,
        i.top_ref as published_top,i.library_id as published_library,
        ps.track_count,ps.content_digest as presentation_digest,ps.sealed_at as presentation_sealed,
        ps.seal_contract_version as presentation_seal_version,ph.contract_version as presentation_version,
        ph.catalog_ref as presentation_catalog,e.library_id as evidence_library,e.selected_local_album_id as evidence_local,
        e.selected_source_ref as evidence_source,e.selected_library_root_id as evidence_root,
        e.capture_builder_version,e.evidence_digest,
        ps.library_id as seal_library,ps.selected_source_ref as seal_source,
        ps.capture_builder_version as seal_builder,ps.evidence_digest as seal_evidence
      from app.album_top_artwork_publication_rows m
      join app.album_top_artwork_publication_logical_rows q using(publication_ref,curator_position)
      left join app.album_list_publication_items i on i.publication_ref=m.publication_ref and i.item_ref=m.item_ref
      left join catalog.album_presentation_versions ph on ph.ref=m.presentation_ref
      left join library.album_presentation_evidence e on e.presentation_ref=m.presentation_ref
      left join library.album_presentation_seals ps on ps.presentation_ref=m.presentation_ref
      where m.publication_ref=p_ref and m.curator_position>n order by m.curator_position limit 101 loop
      exit when pages=100;
      if r.curator_position<>n+1 or n>=5000
          or (r.top_ref,r.library_id,r.owner_account_id) is distinct from (l.top_ref,l.library_id,l.owner_account_id)
          or (r.catalog_ref,r.local_album_id,r.metadata_source_ref,r.metadata_root_id,r.included)
            is distinct from (r.logical_catalog,r.logical_local,r.logical_source,r.logical_root,r.logical_included)
          or r.original_position<>r.expected_original_position
          or (r.saved_item_ref is not null and r.item_ref<>r.saved_item_ref)
          or (r.row_kind='new_local' and exists(select 1 from app.album_top_artwork_publication_baseline
            where publication_ref=p_ref and item_ref=r.item_ref))
          or (r.item_ref,r.catalog_ref,r.presentation_ref,r.original_position,r.curator_position,r.top_ref,r.library_id)
            is distinct from (r.published_item,r.published_catalog,r.published_presentation,r.published_original,
              r.published_position,r.published_top,r.published_library)
          or r.presentation_sealed is null or r.presentation_seal_version is distinct from 1
          or r.presentation_version is distinct from 1 or r.presentation_catalog is distinct from r.catalog_ref
          or (r.evidence_library,r.evidence_local,r.evidence_source,r.evidence_root,r.capture_builder_version)
            is distinct from (l.library_id,r.local_album_id,r.metadata_source_ref,r.metadata_root_id,1)
          or (r.seal_library,r.seal_source,r.seal_builder,r.seal_evidence)
            is distinct from (r.evidence_library,r.evidence_source,r.capture_builder_version,r.evidence_digest) then
        raise exception using errcode='23514',constraint='top_artwork_publication_seal',message='Artwork publication seal invalid';
      end if;
      leaf:=jsonb_build_array(to_jsonb(r)-array['presentation_sealed'],null::jsonb);
      if r.included then
        select * into proof from app.album_top_artwork_publication_proofs where top_ref=l.top_ref and value_digest=r.proof_value_digest;
        if not found or (proof.library_id,proof.owner_account_id) is distinct from (l.library_id,l.owner_account_id)
            or not app._artwork_publication_pair_shape(proof.source_stamp,proof.acquisition_stamp,l.library_id,r.local_album_id)
            or proof.proof_version<>case when proof.source_stamp ? 'descriptor_version' then 2 else 1 end
            or app._artwork_publication_proof_digest(l.top_ref,l.library_id,l.owner_account_id,
              proof.source_stamp,proof.acquisition_stamp) is distinct from r.proof_value_digest
            or r.proof_value_digest is distinct from r.staged_proof_value_digest
            or r.asset_ref is distinct from r.staged_asset_ref
            or (proof.source_stamp->>'artwork_root_id')::bigint is distinct from r.artwork_root_id then
          raise exception using errcode='23514',constraint='top_artwork_publication_proof',message='Artwork publication proof invalid';
        end if;
        select * into asset from app.album_top_artwork_assets where ref=r.asset_ref and top_ref=l.top_ref
          and library_id=l.library_id and owner_account_id=l.owner_account_id;
        if not found or asset.sanitizer_contract<>1 or asset.mime_type<>'image/png'
            or asset.width not between 1 and 256 or asset.height not between 1 and 256
            or asset.byte_length not between 1 and 327680
            or octet_length(asset.png)<>asset.byte_length
            or substring(asset.png from 1 for 8)<>decode('89504e470d0a1a0a','hex')
            or encode(sha256(asset.png),'hex')<>asset.content_digest then
          raise exception using errcode='23514',constraint='top_artwork_publication_proof',message='Artwork publication proof invalid';
        end if;
        leaf:=jsonb_build_array(to_jsonb(r)-array['presentation_sealed'],jsonb_build_array(asset.ref,asset.top_ref,
          asset.library_id,asset.owner_account_id,asset.sanitizer_contract,asset.mime_type,asset.width,asset.height,
          asset.byte_length,asset.content_digest),proof.proof_version,proof.value_digest);
        inc:=inc+1; total_bytes:=total_bytes+asset.byte_length;
      elsif r.asset_ref is not null or r.proof_value_digest is not null or r.artwork_root_id is not null then
        raise exception using errcode='23514',constraint='top_artwork_publication_seal',message='Artwork publication seal invalid';
      end if;
      if p_compare_staging then
        select * into staged from app._artwork_publication_staging(l.preparation_ref,r.curator_position-1,1);
        if not found or (staged.position,staged.row_kind,staged.draft_ref,staged.draft_revision,staged.row_ref,
            staged.saved_item_ref,staged.catalog_ref,staged.local_album_id,staged.metadata_source_ref,
            staged.metadata_root_id,staged.included,staged.asset_ref) is distinct from
            (r.curator_position,r.row_kind,r.draft_ref,r.draft_revision,r.row_ref,r.saved_item_ref,r.catalog_ref,
              r.local_album_id,r.metadata_source_ref,r.metadata_root_id,r.included,r.asset_ref)
            or (r.included and (staged.status<>'ready' or staged.source_stamp is distinct from proof.source_stamp
              or staged.acquisition_stamp is distinct from proof.acquisition_stamp))
            or (not r.included and staged.status<>'excluded') then
          raise exception using errcode='23514',constraint='top_artwork_publication_proof',message='Artwork publication proof invalid';
        end if;
      end if;
      total_tracks:=total_tracks+r.track_count;
      if total_bytes>134217728 or total_tracks>100000 then
        raise exception using errcode='23514',constraint='top_artwork_publication_budget',message='Artwork publication budget exceeded';
      end if;
      state:=sha256(convert_to('artwork-publication-seal-v2/step','UTF8')||decode('00','hex')||state||
        app._artwork_publication_value_digest('artwork-publication-seal-v2/row',leaf));
      n:=n+1; pages:=pages+1;
    end loop;
    exit when pages<100 or n=l.row_count;
  end loop;
  if n<>l.row_count or inc<>l.included_count or l.proof_reservation<>1024::bigint+inc::bigint*69632+(n-inc)::bigint*1024 then
    raise exception using errcode='23514',constraint='top_artwork_publication_seal',message='Artwork publication seal invalid';
  end if;
  return encode(app._artwork_publication_value_digest('artwork-publication-seal-v2/final',
    jsonb_build_array(n,inc,total_bytes,total_tracks,encode(state,'hex'))),'hex');
end $$;

create function app.seal_top_artwork_publication(p_publication uuid,p_expected_digest text default null)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare actual text; l app.album_top_artwork_publication_lineage%rowtype;
begin
  perform app._artwork_publication_transition(p_publication,true);
  select * into strict l from app.album_top_artwork_publication_lineage where publication_ref=p_publication;
  if exists(select 1 from app.album_top_artwork_publication_rows m
      left join app.album_list_items i on i.ref=m.item_ref and i.top_ref=m.top_ref and i.library_id=m.library_id
      left join app.album_list_item_publication_sources s on s.top_ref=m.top_ref and s.item_ref=m.item_ref
      where m.publication_ref=p_publication and ((i.catalog_ref,i.original_position,i.curator_position)
        is distinct from (m.catalog_ref,m.original_position,m.curator_position)
        or (s.library_id,s.catalog_ref,s.selected_local_album_id,s.selected_source_ref)
          is distinct from (m.library_id,m.catalog_ref,m.local_album_id,m.metadata_source_ref))) then
    raise exception using errcode='23514',constraint='top_artwork_publication_transition',message='Artwork publication transition invalid';
  end if;
  actual:=app._artwork_publication_content_digest(p_publication,true);
  if p_expected_digest is not null and p_expected_digest is distinct from actual then
    raise exception using errcode='23514',constraint='top_artwork_publication_seal',message='Artwork publication seal invalid';
  end if;
  update app.album_list_publication_seals set sealed_at=clock_timestamp(),item_count=l.row_count,content_digest=actual
    where publication_ref=p_publication and build_xid=pg_current_xact_id() and seal_contract_version=2 and sealed_at is null;
  if not found or l.expires_at<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_artwork_publication_open',message='Artwork publication generation is not open';
  end if;
  return actual;
end $$;

create function app._artwork_publication_receipt_valid(p_ref uuid)
returns boolean language sql stable security definer set search_path=pg_catalog as $$
  select exists(select 1 from app.album_top_artwork_publication_lineage l
    join app.album_list_publications h on h.ref=l.publication_ref and h.contract_version=2
    join app.album_list_operations op on op.actor_account_id=l.owner_account_id and op.library_id=l.library_id
      and op.request_key=l.operation_key and op.original_session_id=l.original_session_id
      and op.action=l.action and op.top_ref=l.top_ref and op.command_digest=l.command_digest and op.publication_ref=l.publication_ref
    join app.shared_links link on link.top_ref=l.top_ref and link.library_id=l.library_id and link.state='enabled'
      and link.active_publication_ref=l.publication_ref
      and (l.link_ref is null or link.ref=l.link_ref) and link.link_revision=coalesce(l.link_revision,0)+1
    where l.publication_ref=p_ref and op.receipt->>'top_ref'=l.top_ref::text
      and op.receipt->>'revision'=l.approved_top_revision::text and op.receipt->>'action'=l.action
      and op.receipt->>'request_key'=l.operation_key::text
      and op.receipt#>>'{publication,publication_ref}'=l.publication_ref::text
      and op.receipt#>>'{publication,publication_revision}'=h.publication_revision::text
      and op.receipt#>>'{publication,link_revision}'=link.link_revision::text
      and op.receipt#>>'{publication,share_ref}'=link.ref::text
      and op.receipt#>>'{publication,state}'='enabled')
$$;

create function app.consume_top_artwork_publication(p_publication uuid)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare l app.album_top_artwork_publication_lineage%rowtype; p app.album_top_artwork_preparations%rowtype;
  s app.album_list_publication_seals%rowtype; r record; page_count integer; removed integer:=0; after_position integer:=0;
  released bigint:=1024; amount bigint;
begin
  perform app._artwork_publication_transition(p_publication,false);
  select * into strict l from app.album_top_artwork_publication_lineage where publication_ref=p_publication;
  select * into s from app.album_list_publication_seals where publication_ref=p_publication;
  if s.sealed_at is null or not app._artwork_publication_receipt_valid(p_publication)
      or s.content_digest is distinct from app._artwork_publication_content_digest(p_publication,true) then
    raise exception using errcode='55000',constraint='top_artwork_publication_consumption',message='Artwork publication consumption invalid';
  end if;
  select * into p from app.album_top_artwork_preparations where ref=l.preparation_ref for update;
  if not found or (p.top_ref,p.library_id,p.owner_account_id,p.preparation_kind,p.revision,p.original_session_id,
      p.context_ref,p.top_revision,p.request_generation,p.start_request_key,p.manifest_digest,p.expires_at,
      p.draft_ref,p.draft_revision,p.baseline_digest,p.item_count,p.retained_item_count)
      is distinct from (l.top_ref,l.library_id,l.owner_account_id,l.preparation_kind,l.preparation_revision,l.original_session_id,
        l.context_ref,l.old_top_revision,l.request_generation,l.start_request_key,l.manifest_digest,l.expires_at,
        l.draft_ref,l.draft_revision,l.baseline_digest,l.row_count,l.row_count)
      or p.state<>'ready' or p.lease_ref is not null or p.expires_at<=clock_timestamp()
      or exists(select 1 from app.album_top_artwork_publication_consumptions where publication_ref=p_publication) then
    raise exception using errcode='55000',constraint='top_artwork_publication_consumption',message='Artwork publication consumption invalid';
  end if;
  perform app.lock_top_artwork_budgets(l.top_ref,l.library_id,l.owner_account_id);
  if l.expires_at<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  update app.album_top_artwork_preparations set state='cancelled',lease_ref=null,lease_expires_at=null,
    batch_request_key=null,batch_from_revision=null,batch_items=null where ref=p.ref;
  loop
    page_count:=0;
    for r in select * from (
      select item_ref as row_ref,position,included,'item'::text as kind
        from app.album_top_artwork_preparation_items where preparation_ref=p.ref and position>after_position
      union all
      select row_ref,position,included,'draft_item'::text as kind
        from app.album_top_artwork_draft_items where preparation_ref=p.ref and position>after_position
    ) rows order by position limit 101 loop
      exit when page_count=100;
      if removed>=5000 or r.position<>removed+1 or (p.preparation_kind='saved')<>(r.kind='item') then
        raise exception using errcode='55000',constraint='top_artwork_publication_consumption',message='Artwork publication consumption invalid';
      end if;
      insert into app.album_top_artwork_cleanup_permits values(txid_current(),pg_backend_pid(),r.kind,p.ref,r.row_ref);
      if r.kind='item' then
        delete from app.album_top_artwork_preparation_items where preparation_ref=p.ref and item_ref=r.row_ref;
      else
        delete from app.album_top_artwork_draft_items where preparation_ref=p.ref and row_ref=r.row_ref;
      end if;
      if not found then
        raise exception using errcode='55000',constraint='top_artwork_publication_consumption',message='Artwork publication consumption invalid';
      end if;
      delete from app.album_top_artwork_cleanup_permits where transaction_id=txid_current()
        and backend_id=pg_backend_pid() and kind=r.kind and parent_ref=p.ref and row_ref=r.row_ref;
      amount:=case when r.included then 69632 else 1024 end; released:=released+amount;
      removed:=removed+1; after_position:=r.position; page_count:=page_count+1;
    end loop;
    exit when page_count<100 or removed=l.row_count;
  end loop;
  if removed<>l.row_count or released<>l.proof_reservation
      or exists(select 1 from app.album_top_artwork_preparation_items where preparation_ref=p.ref)
      or exists(select 1 from app.album_top_artwork_draft_items where preparation_ref=p.ref) then
    raise exception using errcode='55000',constraint='top_artwork_publication_consumption',message='Artwork publication consumption invalid';
  end if;
  update app.album_top_artwork_preparations set retained_item_count=0 where ref=p.ref;
  delete from app.album_top_artwork_preparations where ref=p.ref and retained_item_count=0;
  update app.album_top_artwork_budgets set preparation_count=preparation_count-1,item_count=item_count-removed,
    proof_bytes=proof_bytes-released where owner_account_id=l.owner_account_id
      and scope_ref in ('00000000-0000-0000-0000-000000000000'::uuid,l.top_ref);
  get diagnostics page_count=row_count;
  if page_count<>2 or l.expires_at<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_artwork_publication_consumption',message='Artwork publication consumption invalid';
  end if;
  insert into app.album_top_artwork_publication_consumptions values(p_publication,l.build_xid,s.content_digest,
    l.preparation_ref,removed,released,clock_timestamp());
end $$;

create function app._artwork_publication_finalize() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare v_ref uuid; l app.album_top_artwork_publication_lineage%rowtype; s app.album_list_publication_seals%rowtype;
begin
  if TG_TABLE_NAME='album_list_publications' then v_ref:=NEW.ref; else v_ref:=NEW.publication_ref; end if;
  if not exists(select 1 from app.album_list_publications where album_list_publications.ref=v_ref and contract_version=2) then return null; end if;
  select * into l from app.album_top_artwork_publication_lineage where publication_ref=v_ref;
  select * into s from app.album_list_publication_seals where publication_ref=v_ref;
  if l.publication_ref is null or s.publication_ref is null or s.sealed_at is null or s.seal_contract_version<>2 then
    raise exception using errcode='55000',constraint='top_artwork_publication_finalized',message='Artwork publication was not finalized';
  end if;
  -- Creation-time closure includes the actual N+1 result even after consume.
  -- Expiry is checked when this finalizer executes. SET CONSTRAINTS can run
  -- it early; clock-only waits cannot queue another trigger. C-2 must retain
  -- its last-authoritative-statement clock/session fence before commit.
  -- This obligation is never replayed against historical working membership.
  perform app._artwork_publication_transition(v_ref,false);
  if exists(select 1 from app.album_top_artwork_publication_rows m
      left join app.album_list_items i on i.ref=m.item_ref and i.top_ref=m.top_ref and i.library_id=m.library_id
      left join app.album_list_item_publication_sources src on src.top_ref=m.top_ref and src.item_ref=m.item_ref
      where m.publication_ref=v_ref and ((i.catalog_ref,i.original_position,i.curator_position)
        is distinct from (m.catalog_ref,m.original_position,m.curator_position)
        or (src.library_id,src.catalog_ref,src.selected_local_album_id,src.selected_source_ref)
          is distinct from (m.library_id,m.catalog_ref,m.local_album_id,m.metadata_source_ref))) then
    raise exception using errcode='55000',constraint='top_artwork_publication_finalized',message='Artwork publication was not finalized';
  end if;
  if s.build_xid<>pg_current_xact_id() or l.build_xid<>s.build_xid or s.item_count<>l.row_count
      or not app._artwork_publication_receipt_valid(v_ref)
      or s.content_digest is distinct from app._artwork_publication_content_digest(v_ref,false)
      or not exists(select 1 from app.album_top_artwork_publication_consumptions c where c.publication_ref=v_ref
        and c.build_xid=s.build_xid and c.seal_digest=s.content_digest and c.preparation_ref=l.preparation_ref
        and c.removed_items=l.row_count and c.released_proof_bytes=l.proof_reservation and c.consumed_at<l.expires_at)
      or exists(select 1 from app.album_top_artwork_preparations where album_top_artwork_preparations.ref=l.preparation_ref)
      or exists(select 1 from app.album_top_artwork_preparation_items where preparation_ref=l.preparation_ref)
      or exists(select 1 from app.album_top_artwork_draft_items where preparation_ref=l.preparation_ref)
      or l.expires_at<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_artwork_publication_finalized',message='Artwork publication was not finalized';
  end if;
  return null;
end $$;
-- Universal insertion obligations, including permitted runtime header inserts
-- that never use admission. Historical v1 rows/builds are deliberately exempt.
create constraint trigger artwork_publication_finalize after insert on app.album_list_publications
  deferrable initially deferred for each row execute function app._artwork_publication_finalize();
create constraint trigger artwork_publication_finalize after insert on app.album_list_publication_seals
  deferrable initially deferred for each row execute function app._artwork_publication_finalize();

-- A caller may drain deferred checks with SET CONSTRAINTS ALL IMMEDIATE.
-- Consumption therefore freezes this transaction's checked mutable closure;
-- later transactions may still edit working rows or revoke historical links.
-- This indexed lookup never reseals or scans a publication's member vector.
create index top_artwork_publication_current_build
  on app.album_top_artwork_publication_lineage(build_xid,top_ref);
create function app._artwork_publication_top_frozen(p_top uuid)
returns boolean language sql volatile security definer set search_path=pg_catalog as $$
  select exists(select 1 from app.album_top_artwork_publication_lineage l
    join app.album_top_artwork_publication_consumptions c using(publication_ref)
    where l.top_ref=p_top and l.build_xid=pg_current_xact_id() and c.build_xid=l.build_xid)
$$;
create function app._artwork_publication_receipt_frozen(p_owner bigint,p_library bigint,p_key uuid)
returns boolean language sql volatile security definer set search_path=pg_catalog as $$
  select exists(select 1 from app.album_top_artwork_publication_lineage l
    join app.album_top_artwork_publication_consumptions c using(publication_ref)
    where l.owner_account_id=p_owner and l.library_id=p_library and l.operation_key=p_key
      and l.build_xid=pg_current_xact_id() and c.build_xid=l.build_xid)
$$;
create function app._artwork_publication_preparation_frozen(p_ref uuid)
returns boolean language sql volatile security definer set search_path=pg_catalog as $$
  select exists(select 1 from app.album_top_artwork_publication_lineage l
    join app.album_top_artwork_publication_consumptions c using(publication_ref)
    where l.preparation_ref=p_ref and l.build_xid=pg_current_xact_id() and c.build_xid=l.build_xid)
$$;

-- VOLATILE helpers intentionally observe earlier writes in the same SQL
-- command too. Both OLD and NEW identities are checked before a scope move.
create function app._artwork_publication_closure_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare old_top uuid; new_top uuid; frozen boolean:=false;
begin
  if TG_TABLE_NAME='album_list_operations' then
    if TG_OP='UPDATE' and (OLD.actor_account_id,OLD.library_id,OLD.request_key,
        OLD.original_session_id,OLD.action,OLD.top_ref,OLD.command_digest,OLD.publication_ref,OLD.receipt)
        is not distinct from (NEW.actor_account_id,NEW.library_id,NEW.request_key,
        NEW.original_session_id,NEW.action,NEW.top_ref,NEW.command_digest,NEW.publication_ref,NEW.receipt) then return NEW; end if;
    if TG_OP<>'INSERT' then frozen:=app._artwork_publication_receipt_frozen(OLD.actor_account_id,OLD.library_id,OLD.request_key); end if;
    if TG_OP<>'DELETE' then frozen:=frozen or app._artwork_publication_receipt_frozen(NEW.actor_account_id,NEW.library_id,NEW.request_key); end if;
  else
    if TG_TABLE_NAME='album_lists' then
      if TG_OP='UPDATE' and (OLD.ref,OLD.library_id,OLD.owner_account_id,OLD.revision,OLD.title,
          OLD.description,OLD.next_original_position,OLD.deleted_at) is not distinct from
          (NEW.ref,NEW.library_id,NEW.owner_account_id,NEW.revision,NEW.title,
          NEW.description,NEW.next_original_position,NEW.deleted_at) then return NEW; end if;
      if TG_OP<>'INSERT' then old_top:=OLD.ref; end if;
      if TG_OP<>'DELETE' then new_top:=NEW.ref; end if;
    elsif TG_TABLE_NAME='shared_links' then
      if TG_OP='UPDATE' and (OLD.ref,OLD.top_ref,OLD.library_id,OLD.state,OLD.active_publication_ref,OLD.link_revision)
          is not distinct from (NEW.ref,NEW.top_ref,NEW.library_id,NEW.state,NEW.active_publication_ref,NEW.link_revision) then return NEW; end if;
      if TG_OP<>'INSERT' then old_top:=OLD.top_ref; end if;
      if TG_OP<>'DELETE' then new_top:=NEW.top_ref; end if;
    elsif TG_TABLE_NAME='album_list_items' then
      if TG_OP='UPDATE' and (OLD.ref,OLD.top_ref,OLD.library_id,OLD.catalog_ref,OLD.original_position,OLD.curator_position)
          is not distinct from (NEW.ref,NEW.top_ref,NEW.library_id,NEW.catalog_ref,NEW.original_position,NEW.curator_position) then return NEW; end if;
      if TG_OP<>'INSERT' then old_top:=OLD.top_ref; end if;
      if TG_OP<>'DELETE' then new_top:=NEW.top_ref; end if;
    elsif TG_TABLE_NAME='album_list_item_publication_sources' then
      if TG_OP='UPDATE' and (OLD.top_ref,OLD.item_ref,OLD.library_id,OLD.catalog_ref,OLD.selected_local_album_id,OLD.selected_source_ref)
          is not distinct from (NEW.top_ref,NEW.item_ref,NEW.library_id,NEW.catalog_ref,NEW.selected_local_album_id,NEW.selected_source_ref) then return NEW; end if;
      if TG_OP<>'INSERT' then old_top:=OLD.top_ref; end if;
      if TG_OP<>'DELETE' then new_top:=NEW.top_ref; end if;
    elsif TG_TABLE_NAME='album_list_item_remote_sources' then
      if TG_OP='UPDATE' and OLD is not distinct from NEW then return NEW; end if;
      if TG_OP<>'INSERT' then old_top:=OLD.top_ref; end if;
      if TG_OP<>'DELETE' then new_top:=NEW.top_ref; end if;
    else
      raise exception using errcode='55000',constraint='top_artwork_publication_closure',message='Unsupported artwork closure relation';
    end if;
    frozen:=app._artwork_publication_top_frozen(old_top) or app._artwork_publication_top_frozen(new_top);
  end if;
  if frozen then
    raise exception using errcode='55000',constraint='top_artwork_publication_closure',message='Consumed artwork publication closure is frozen';
  end if;
  if TG_OP='DELETE' then return OLD; end if;
  return NEW;
end $$;
do $$ declare name text; begin
  foreach name in array array['album_lists','album_list_items','album_list_item_publication_sources',
      'album_list_item_remote_sources','shared_links','album_list_operations'] loop
    execute format('create trigger artwork_publication_closure before insert or update or delete on app.%I for each row execute function app._artwork_publication_closure_guard()',name);
  end loop;
end $$;

-- Fresh start keys cannot resurrect the exact consumed preparation reference
-- after the finalizer's absence check. Unrelated preparations stay mutable.
create function app._artwork_publication_preparation_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare old_ref uuid; new_ref uuid;
begin
  if TG_TABLE_NAME='album_top_artwork_preparations' then
    if TG_OP='UPDATE' then old_ref:=OLD.ref; end if;
    new_ref:=NEW.ref;
  elsif TG_TABLE_NAME in ('album_top_artwork_preparation_items','album_top_artwork_draft_items') then
    if TG_OP='UPDATE' then old_ref:=OLD.preparation_ref; end if;
    new_ref:=NEW.preparation_ref;
  else
    raise exception using errcode='55000',constraint='top_artwork_publication_closure',message='Unsupported artwork closure relation';
  end if;
  if TG_OP='UPDATE' and old_ref is not distinct from new_ref then return NEW; end if;
  if app._artwork_publication_preparation_frozen(old_ref) or app._artwork_publication_preparation_frozen(new_ref) then
    raise exception using errcode='55000',constraint='top_artwork_publication_closure',message='Consumed artwork publication closure is frozen';
  end if;
  return NEW;
end $$;
do $$ declare name text; begin
  foreach name in array array['album_top_artwork_preparations','album_top_artwork_preparation_items','album_top_artwork_draft_items'] loop
    execute format('create trigger artwork_publication_preparation_closure before insert or update on app.%I for each row execute function app._artwork_publication_preparation_guard()',name);
  end loop;
end $$;

create or replace function app.guard_album_publication_pointer()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$ begin
  if NEW.state='enabled' and not exists(select 1 from app.album_list_publications h
      join app.album_list_publication_seals s on s.publication_ref=h.ref and s.sealed_at is not null
        and s.seal_contract_version=h.contract_version
      where h.ref=NEW.active_publication_ref and h.top_ref=NEW.top_ref and h.library_id=NEW.library_id
        and case when h.contract_version=1 then s.seal_contract_version=1
          when h.contract_version=2 then exists(select 1 from app.album_top_artwork_publication_lineage l
            where l.publication_ref=h.ref and l.approved_top_revision=h.approved_top_revision
              and l.row_count=s.item_count) and s.content_digest=app._artwork_publication_content_digest(h.ref,false)
          else false end) then
    raise exception using errcode='55000',constraint='album_publication_sealed_pointer',message='Publication pointer requires a sealed generation';
  end if;
  return NEW;
end $$;

-- Existing v1 sealer: exact historical body plus matched-v1 admission guard.
create or replace function app.seal_album_list_publication(p_ref uuid,p_count integer,p_expected jsonb)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare
  generation app.album_list_publication_seals%rowtype;
  actual jsonb;
  rows_count bigint;
  first_position integer;
  last_position integer;
  valid_count bigint;
  total_tracks bigint;
begin
  if p_ref is null or p_count is null or p_count not between 0 and 5000
      or p_expected is null or jsonb_typeof(p_expected) <> 'array' then
    raise exception using errcode='23514', constraint='album_publication_seal_binding',
      message='Publication seal binding is invalid';
  end if;
  select * into generation from app.album_list_publication_seals where publication_ref=p_ref for update;
  if not found or generation.seal_contract_version<>1
      or not exists(select 1 from app.album_list_publications where ref=p_ref and contract_version=1)
      or generation.sealed_at is not null or generation.build_xid <> pg_current_xact_id() then
    raise exception using errcode='55000', constraint='album_publication_generation_open',
      message='Publication generation is not open';
  end if;
  select count(*),min(curator_position),max(curator_position) into rows_count,first_position,last_position
    from app.album_list_publication_items where publication_ref=p_ref;
  if rows_count <> p_count or (rows_count > 0 and (first_position <> 1 or last_position <> rows_count)) then
    raise exception using errcode='23514', constraint='album_publication_seal_binding',
      message='Publication seal binding is invalid';
  end if;
  select count(*),coalesce(sum(s.track_count),0) into valid_count,total_tracks
    from app.album_list_publication_items i
    join app.album_list_publications h on h.ref=i.publication_ref and h.top_ref=i.top_ref and h.library_id=i.library_id
    join catalog.album_presentation_versions p on p.ref=i.presentation_ref and p.catalog_ref=i.catalog_ref
    join library.album_presentation_evidence e on e.presentation_ref=p.ref and e.library_id=i.library_id
    join library.album_presentation_seals s on s.presentation_ref=p.ref and s.sealed_at is not null
      and s.seal_contract_version=1 and s.library_id=e.library_id
      and s.selected_source_ref=e.selected_source_ref and s.capture_builder_version=e.capture_builder_version
      and s.evidence_digest=e.evidence_digest
    where i.publication_ref=p_ref;
  if valid_count <> rows_count or total_tracks > 100000 then
    raise exception using errcode='23514', constraint='album_publication_seal_binding',
      message='Publication seal binding is invalid';
  end if;
  select jsonb_build_array('album-list-publication-seal-v1',
      jsonb_build_array(h.ref,h.top_ref,h.library_id,h.publication_revision,h.approved_top_revision,
        h.approved_by_account_id,h.title,h.description,h.contract_version,h.content_fingerprint),
      coalesce((select jsonb_agg(jsonb_build_array(i.item_ref,i.top_ref,i.library_id,i.catalog_ref,i.presentation_ref,
          i.original_position,i.curator_position,s.track_count,s.content_digest) order by i.curator_position)
        from app.album_list_publication_items i
        join library.album_presentation_seals s on s.presentation_ref=i.presentation_ref
        where i.publication_ref=p_ref),'[]'::jsonb))
    into actual from app.album_list_publications h where h.ref=p_ref;
  if actual is distinct from p_expected then
    raise exception using errcode='23514', constraint='album_publication_seal_binding',
      message='Publication seal binding is invalid';
  end if;
  update app.album_list_publication_seals set sealed_at=clock_timestamp(),item_count=p_count,
    content_digest=encode(sha256(convert_to(actual::text,'UTF8')),'hex')
    where publication_ref=p_ref and sealed_at is null and build_xid=pg_current_xact_id();
end $$;


-- Existing bounded staging cleanup: only the third-store pin predicate changes.
create or replace function app.guard_top_artwork_asset() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  if TG_OP='DELETE' and exists(select 1 from app.album_top_artwork_cleanup_permits
      where transaction_id=txid_current() and backend_id=pg_backend_pid() and kind='asset'
        and parent_ref=OLD.top_ref and row_ref=OLD.ref)
     and not exists(select 1 from app.album_top_artwork_preparation_items where asset_ref=OLD.ref)
     and not exists(select 1 from app.album_top_artwork_draft_items where asset_ref=OLD.ref)
     and not exists(select 1 from app.album_top_artwork_publication_rows where asset_ref=OLD.ref) then return OLD; end if;
  raise exception using errcode='55000',constraint='top_artwork_asset_immutable',message='Artwork asset is immutable';
end $$;
create or replace function app.cleanup_top_artwork_preparations(p_top uuid,p_library bigint,p_owner bigint,p_revision bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare t app.album_lists%rowtype; p app.album_top_artwork_preparations%rowtype; i record; a record;
  candidates uuid[]; cursor_ref uuid; removed_items integer:=0; removed_headers integer:=0;
  removed_assets integer:=0; retained_tombstones integer:=0; scanned_assets integer:=0;
  item_bytes bigint; now_at timestamptz;
begin
  -- Cleanup alone may release retained quota for a soft-deleted parent.
  -- Keep the exact owner/library/revision lock; historical live-scope checks
  -- remain unchanged for every admission, claim and completion operation.
  select * into t from app.album_lists where ref=p_top for update;
  if not found or t.library_id is distinct from p_library
      or t.owner_account_id is distinct from p_owner
      or t.revision is distinct from p_revision then
    raise exception using errcode='55000',constraint='top_artwork_scope',message='Artwork scope changed';
  end if;
  now_at:=clock_timestamp();
  -- Each branch uses its scoped index and reads at most 32 candidates before
  -- the bounded union sort. No scan of all cancelled tombstones/history.
  select coalesce(array_agg(ref order by ref),'{}'::uuid[]) into candidates from (
    select distinct ref from (
      (select ref from app.album_top_artwork_preparations where top_ref=p_top and expires_at<=now_at
        order by expires_at,ref limit 32)
      union all
      (select ref from app.album_top_artwork_preparations where top_ref=p_top and state='cancelled'
          and retained_item_count>0 order by ref limit 32)
    ) bounded order by ref limit 32
  ) chosen;
  -- Parent Top serializes every admitted writer, including direct helper calls.
  perform 1 from app.album_top_artwork_preparations where ref=any(candidates) order by ref for update;
  perform app.lock_top_artwork_budgets(p_top,p_library,p_owner);
  for p in select * from app.album_top_artwork_preparations where ref=any(candidates) order by ref loop
    if p.owner_account_id<>p_owner or p.library_id<>p_library
       or (p.state<>'cancelled' and p.expires_at>now_at) then
      raise exception using errcode='55000',constraint='top_artwork_retention_guard',message='Artwork cleanup scope changed';
    end if;
    update app.album_top_artwork_preparations set state='cancelled',lease_ref=null,lease_expires_at=null,
      batch_request_key=null,batch_from_revision=null,batch_items=null where ref=p.ref;
    for i in select * from (
        (select item_ref as row_ref,included,position,'item'::text as kind
          from app.album_top_artwork_preparation_items where preparation_ref=p.ref and p.preparation_kind='saved'
          order by position limit (512-removed_items))
        union all
        (select row_ref,included,position,'draft_item'::text as kind
          from app.album_top_artwork_draft_items where preparation_ref=p.ref and p.preparation_kind='draft'
          order by position limit (512-removed_items))
      ) bounded order by position limit (512-removed_items) loop
      insert into app.album_top_artwork_cleanup_permits values(txid_current(),pg_backend_pid(),i.kind,p.ref,i.row_ref);
      if i.kind='item' then
        delete from app.album_top_artwork_preparation_items where preparation_ref=p.ref and item_ref=i.row_ref;
      else
        delete from app.album_top_artwork_draft_items where preparation_ref=p.ref and row_ref=i.row_ref;
      end if;
      delete from app.album_top_artwork_cleanup_permits where transaction_id=txid_current()
        and backend_id=pg_backend_pid() and kind=i.kind and parent_ref=p.ref and row_ref=i.row_ref;
      item_bytes:=case when i.included then 69632 else 1024 end;
      update app.album_top_artwork_preparations set retained_item_count=retained_item_count-1 where ref=p.ref;
      update app.album_top_artwork_budgets set item_count=item_count-1,proof_bytes=proof_bytes-item_bytes
        where owner_account_id=p_owner and scope_ref in ('00000000-0000-0000-0000-000000000000'::uuid,p_top);
      removed_items:=removed_items+1;
    end loop;
    if not exists(select 1 from app.album_top_artwork_preparation_items where preparation_ref=p.ref)
       and not exists(select 1 from app.album_top_artwork_draft_items where preparation_ref=p.ref)
       and (select retained_item_count from app.album_top_artwork_preparations where ref=p.ref)=0 then
      if p.expires_at<=now_at then
        delete from app.album_top_artwork_preparations where ref=p.ref;
        update app.album_top_artwork_budgets set preparation_count=preparation_count-1,proof_bytes=proof_bytes-1024
          where owner_account_id=p_owner and scope_ref in ('00000000-0000-0000-0000-000000000000'::uuid,p_top);
        removed_headers:=removed_headers+1;
      else
        -- Compact header is the exact cancelled-key tombstone until expiry.
        retained_tombstones:=retained_tombstones+1;
      end if;
    end if;
  end loop;
  select cleanup_asset_after into cursor_ref from app.album_top_artwork_budgets
    where owner_account_id=p_owner and scope_ref=p_top;
  -- Scan at most 128 asset keys, not an unbounded search for 128 orphans.
  for a in select ref,byte_length from app.album_top_artwork_assets
      where top_ref=p_top and ref>coalesce(cursor_ref,'00000000-0000-0000-0000-000000000000'::uuid)
      order by ref limit 128 loop
    scanned_assets:=scanned_assets+1; cursor_ref:=a.ref;
    if not exists(select 1 from app.album_top_artwork_preparation_items where asset_ref=a.ref)
       and not exists(select 1 from app.album_top_artwork_draft_items where asset_ref=a.ref)
       and not exists(select 1 from app.album_top_artwork_publication_rows where asset_ref=a.ref) then
      insert into app.album_top_artwork_cleanup_permits values(txid_current(),pg_backend_pid(),'asset',p_top,a.ref);
      delete from app.album_top_artwork_assets where ref=a.ref and top_ref=p_top;
      delete from app.album_top_artwork_cleanup_permits where transaction_id=txid_current()
        and backend_id=pg_backend_pid() and kind='asset' and parent_ref=p_top and row_ref=a.ref;
      update app.album_top_artwork_budgets set byte_count=byte_count-a.byte_length,asset_count=asset_count-1
        where owner_account_id=p_owner and scope_ref in ('00000000-0000-0000-0000-000000000000'::uuid,p_top);
      removed_assets:=removed_assets+1;
    end if;
  end loop;
  update app.album_top_artwork_budgets set cleanup_asset_after=case when scanned_assets<128 then null else cursor_ref end
    where owner_account_id=p_owner and scope_ref=p_top;
  return jsonb_build_object('preparations_deleted',removed_headers,'items_deleted',removed_items,
    'assets_deleted',removed_assets,'assets_scanned',scanned_assets,'tombstones_retained',retained_tombstones);
end $$;


-- Current-owner visibility is checked before consumed-key lookup. Private
-- subordinate saved admission keeps its existing ACL and metering contract.
create or replace function app.start_top_artwork_preparation(p_ref uuid,p_top uuid,p_library bigint,p_owner bigint,
  p_session bigint,p_context text,p_revision bigint,p_key uuid,p_digest text,p_items jsonb,p_generation bigint)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$ begin
  if app.top_artwork_start_consumed(p_top,p_library,p_owner,p_key) then
    raise exception using errcode='55000',constraint='top_artwork_preparation_consumed',message='Artwork preparation consumed';
  end if;
  perform app.lock_top_artwork_scope(p_top,p_library,p_owner,p_revision);
  if exists(select 1 from app.album_top_artwork_preparations where owner_account_id=p_owner
      and library_id=p_library and start_request_key=p_key and preparation_kind<>'saved') then
    raise exception using errcode='23514',constraint='top_artwork_request_conflict',message='Artwork request changed';
  end if;
  return app.start_top_artwork_preparation_saved_v2(p_ref,p_top,p_library,p_owner,p_session,p_context,
    p_revision,p_key,p_digest,p_items,p_generation);
end $$;
alter function app.start_top_artwork_draft_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,bigint,uuid,bigint,text,jsonb)
  rename to _start_top_artwork_draft_preparation_v1;
create function app.start_top_artwork_draft_preparation(p_ref uuid,p_top uuid,p_library bigint,p_owner bigint,
  p_session bigint,p_context text,p_revision bigint,p_key uuid,p_generation bigint,p_draft uuid,
  p_draft_revision bigint,p_baseline text,p_items jsonb)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$ begin
  if app.top_artwork_start_consumed(p_top,p_library,p_owner,p_key) then
    raise exception using errcode='55000',constraint='top_artwork_preparation_consumed',message='Artwork preparation consumed';
  end if;
  return app._start_top_artwork_draft_preparation_v1(p_ref,p_top,p_library,p_owner,p_session,p_context,
    p_revision,p_key,p_generation,p_draft,p_draft_revision,p_baseline,p_items);
end $$;

-- Existing admissions hold the shared account budget before this INSERT. This
-- final indexed check closes cross-Top races with a consume that waited/committed
-- after the wrapper's early check. It mints no new authority and allocates no quota.
create function app._artwork_publication_start_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$ begin
  if exists(select 1 from app.album_top_artwork_publication_lineage where owner_account_id=NEW.owner_account_id
      and library_id=NEW.library_id and start_request_key=NEW.start_request_key) then
    raise exception using errcode='55000',constraint='top_artwork_preparation_consumed',message='Artwork preparation consumed';
  end if;
  return NEW;
end $$;
create trigger artwork_publication_consumed_start before insert on app.album_top_artwork_preparations
  for each row execute function app._artwork_publication_start_guard();

-- Exact function inventories, not schema-wide grants. No readonly/public proof
-- access, no runtime immutable-child writes, no trigger/internal EXECUTE.
do $$ declare fn regprocedure; name text; role_name text; public_entries regprocedure[]:=array[
  'app.admit_top_artwork_publication(uuid,uuid,bigint,bigint,text,bigint,bigint,text,text,text,text,text,text,text,text,bigint,uuid,text,text,bigint)'::regprocedure,
  'app.map_top_artwork_publication_page(uuid,jsonb)'::regprocedure,
  'app.seal_top_artwork_publication(uuid,text)'::regprocedure,
  'app.consume_top_artwork_publication(uuid)'::regprocedure,
  'app.top_artwork_start_consumed(uuid,bigint,bigint,uuid)'::regprocedure,
  'app.start_top_artwork_draft_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,bigint,uuid,bigint,text,jsonb)'::regprocedure
]; begin
  for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='app' and (p.proname like '\_artwork\_publication\_%' escape '\'
        or p.proname='_start_top_artwork_draft_preparation_v1' or p.oid=any(public_entries::oid[])) loop
    execute format('revoke all on function %s from public',fn);
    foreach role_name in array array['album_haven_readonly','album_haven_app'] loop
      if exists(select 1 from pg_roles where rolname=role_name) then
        execute format('revoke all on function %s from %I',fn,role_name);
      end if;
    end loop;
  end loop;
  foreach name in array array['album_top_artwork_publication_lineage','album_top_artwork_publication_baseline',
      'album_top_artwork_publication_logical_rows','album_top_artwork_publication_proofs',
      'album_top_artwork_publication_rows','album_top_artwork_publication_consumptions'] loop
    execute format('revoke all on app.%I from public',name);
    foreach role_name in array array['album_haven_readonly','album_haven_app'] loop
      if exists(select 1 from pg_roles where rolname=role_name) then
        execute format('revoke all on app.%I from %I',name,role_name);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='album_haven_app') then
      execute format('grant select on app.%I to album_haven_app',name);
    end if;
    if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
      execute format('grant all on app.%I to album_haven_migrator',name);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    foreach fn in array public_entries loop
      execute format('grant execute on function %s to album_haven_app',fn);
    end loop;
  end if;
end $$;
