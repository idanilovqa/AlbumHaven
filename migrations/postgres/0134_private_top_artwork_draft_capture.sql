-- Dormant typed POSIX staging. No route, publication seal or image reader.
-- This migration is transactional and must run as the non-superuser owner.
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    raise exception using errcode='42501',message='Artwork capture requires a non-superuser migration owner';
  end if;
end $$;
lock table app.album_top_artwork_preparations,app.album_top_artwork_draft_items,
  app.album_top_artwork_preparation_items,app.album_top_artwork_assets,
  app.album_top_artwork_budgets in access exclusive mode;
alter table app.album_top_artwork_draft_items
  add column status text,
  add column asset_ref uuid,
  add column source_stamp jsonb,
  add column acquisition_stamp jsonb,
  add column error_code text;
-- The old guard rejects every UPDATE. Replace it under the migration table
-- lock with this one-purpose owner-only backfill transition, never a GUC or
-- persistent bypass. The normal guard replaces it before this transaction ends.
create or replace function app.guard_top_artwork_draft_item() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  if TG_OP='UPDATE' and current_user=(select pg_get_userbyid(relowner) from pg_class
      where oid='app.album_top_artwork_draft_items'::regclass)
     and OLD.status is null and NEW.status=(case when OLD.included then 'pending' else 'excluded' end)
     and (to_jsonb(NEW)-'status')=(to_jsonb(OLD)-'status') then return NEW; end if;
  raise exception using errcode='55000',constraint='top_artwork_draft_immutable',message='Artwork draft is immutable';
end $$;
update app.album_top_artwork_draft_items set status=case when included then 'pending' else 'excluded' end;
alter table app.album_top_artwork_draft_items
  alter column status set not null,
  add constraint top_artwork_draft_status check(status in ('excluded','pending','failed','ready')),
  add constraint top_artwork_draft_error check(error_code in ('artwork_unavailable','artwork_source_changed','artwork_limit')),
  add constraint top_artwork_draft_proof_state check(
    (not included and status='excluded' and asset_ref is null and source_stamp is null and acquisition_stamp is null and error_code is null)
    or (included and status='pending' and asset_ref is null and source_stamp is null and acquisition_stamp is null and error_code is null)
    or (included and status='failed' and asset_ref is null and source_stamp is null and acquisition_stamp is null and error_code is not null)
    or (included and status='ready' and asset_ref is not null and source_stamp is not null and acquisition_stamp is not null and error_code is null)),
  add constraint top_artwork_draft_source_size check(source_stamp is null or
    (jsonb_typeof(source_stamp)='object' and octet_length(source_stamp::text)<=65536)),
  add constraint top_artwork_draft_acquisition_size check(acquisition_stamp is null or
    (jsonb_typeof(acquisition_stamp)='object' and octet_length(acquisition_stamp::text)<=2048)),
  add constraint top_artwork_draft_asset_scope foreign key(asset_ref,top_ref,library_id,owner_account_id)
    references app.album_top_artwork_assets(ref,top_ref,library_id,owner_account_id);
create index top_artwork_draft_asset_references on app.album_top_artwork_draft_items(asset_ref) where asset_ref is not null;
create index top_artwork_draft_claim on app.album_top_artwork_draft_items(preparation_ref,status,position);
create or replace function app.guard_top_artwork_draft_item() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  if TG_OP='INSERT' then
    -- 0130 admission remains byte-for-byte immutable and omits new columns.
    if NEW.status is null then NEW.status:=case when NEW.included then 'pending' else 'excluded' end; end if;
    if NEW.status=(case when NEW.included then 'pending' else 'excluded' end)
       and NEW.asset_ref is null and NEW.source_stamp is null
       and NEW.acquisition_stamp is null and NEW.error_code is null then return NEW; end if;
  elsif TG_OP='DELETE' then
    if exists(select 1 from app.album_top_artwork_cleanup_permits
        where transaction_id=txid_current() and backend_id=pg_backend_pid() and kind='draft_item'
          and parent_ref=OLD.preparation_ref and row_ref=OLD.row_ref)
       and exists(select 1 from app.album_top_artwork_preparations
         where ref=OLD.preparation_ref and preparation_kind='draft' and state='cancelled') then return OLD; end if;
  elsif OLD.status in ('pending','failed') and NEW.status in ('failed','ready') and
    (NEW.preparation_ref,NEW.top_ref,NEW.library_id,NEW.owner_account_id,NEW.preparation_kind,
      NEW.row_ref,NEW.row_kind,NEW.saved_item_ref,NEW.catalog_ref,NEW.position,
      NEW.selected_local_album_id,NEW.selected_source_ref,NEW.selected_library_root_id,NEW.included)
    is not distinct from
    (OLD.preparation_ref,OLD.top_ref,OLD.library_id,OLD.owner_account_id,OLD.preparation_kind,
      OLD.row_ref,OLD.row_kind,OLD.saved_item_ref,OLD.catalog_ref,OLD.position,
      OLD.selected_local_album_id,OLD.selected_source_ref,OLD.selected_library_root_id,OLD.included) then return NEW;
  end if;
  raise exception using errcode='55000',constraint='top_artwork_draft_immutable',message='Artwork draft is immutable';
end $$;
create trigger top_artwork_draft_initial_status before insert on app.album_top_artwork_draft_items
  for each row execute function app.guard_top_artwork_draft_item();
create function app.deny_top_artwork_draft_identity_update() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  raise exception using errcode='55000',constraint='top_artwork_draft_immutable',message='Artwork draft is immutable';
end $$;
create trigger top_artwork_draft_identity_immutable before update of
  preparation_ref,top_ref,library_id,owner_account_id,preparation_kind,row_ref,row_kind,
  saved_item_ref,catalog_ref,position,selected_local_album_id,selected_source_ref,selected_library_root_id,included
  on app.album_top_artwork_draft_items for each row execute function app.deny_top_artwork_draft_identity_update();

-- Private digest implementation beneath an already validated Top SHARE/UPDATE.
-- Preserve the exact 0130 JSONB vector, ordering and remote structural identity.
create function app._top_artwork_draft_baseline(p_top uuid,p_library bigint,p_owner bigint,p_revision bigint)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare t app.album_lists%rowtype; vector jsonb;
begin
  select * into t from app.album_lists where ref=p_top;
  -- Immutable remote identity only. A retired source or revoked former editor
  -- must not prevent explicit removal/replacement by independently proven local sources.
  select coalesce(jsonb_agg(jsonb_build_array(i.ref,i.catalog_ref,i.original_position,i.curator_position,
      s.selected_local_album_id,s.selected_source_ref,r.admission_ref,a.evidence_version)
      order by i.curator_position,i.ref),'[]'::jsonb) into vector
    from (select * from app.album_list_items where top_ref=p_top and library_id=p_library
      order by curator_position,ref limit 5001) i
    left join app.album_list_item_publication_sources s on s.top_ref=i.top_ref and s.item_ref=i.ref
    left join app.album_list_item_remote_sources r on r.top_ref=i.top_ref and r.item_ref=i.ref
    left join app.album_top_remote_admissions a on a.ref=r.admission_ref
    where i.top_ref=p_top and i.library_id=p_library;
  if jsonb_array_length(vector)>5000 then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork baseline exceeds limit';
  end if;
  return encode(sha256(convert_to(jsonb_build_array('top-artwork-draft-baseline-v1',p_top,p_library,p_owner,
    p_revision,t.next_original_position,vector)::text,'UTF8')),'hex');
end $$;
create or replace function app.top_artwork_draft_baseline(p_top uuid,p_library bigint,p_owner bigint,p_revision bigint)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare t app.album_lists%rowtype;
begin
  select * into t from app.album_lists where ref=p_top for update;
  if not found or t.library_id is distinct from p_library or t.owner_account_id is distinct from p_owner
      or t.revision is distinct from p_revision or t.deleted_at is not null then
    raise exception using errcode='55000',constraint='top_artwork_scope',message='Artwork scope changed';
  end if;
  return app._top_artwork_draft_baseline(p_top,p_library,p_owner,p_revision);
end $$;

-- Shared complete-set checker. No public caller may skip its baseline or supply
-- an asserted digest. Top locks precede selected album locks and metadata clock;
-- the mutable preparation lock is deliberately taken only by mutation callers.
create function app._validate_top_artwork_draft(p_ref uuid,p_owner bigint,p_session bigint,p_context text,
  p_top_revision bigint,p_draft uuid,p_draft_revision bigint)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare p app.album_top_artwork_preparations%rowtype; vector jsonb; baseline text; n integer;
begin
  select * into p from app.album_top_artwork_preparations where ref=p_ref;
  if not found or p.preparation_kind<>'draft'
      or (p.owner_account_id,p.original_session_id,p.context_ref,p.top_revision,p.draft_ref,p.draft_revision)
         is distinct from (p_owner,p_session,p_context,p_top_revision,p_draft,p_draft_revision)
      or p_owner is null or p_session is null or p_session<1 or p_context is null
      or p_context !~ '^[0-9a-f]{64}$' or p_draft is null
      or p_draft='00000000-0000-0000-0000-000000000000' or p_draft_revision is null or p_draft_revision<1
      or p.state='cancelled' or p.expires_at<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  baseline:=app._top_artwork_draft_baseline(p.top_ref,p.library_id,p.owner_account_id,p.top_revision);
  select coalesce(jsonb_agg(jsonb_build_object('row_ref',i.row_ref,'row_kind',i.row_kind,
      'saved_item_ref',i.saved_item_ref,'catalog_ref',i.catalog_ref,'position',i.position,
      'selected_local_album_id',i.selected_local_album_id,'selected_source_ref',i.selected_source_ref,
      'selected_library_root_id',i.selected_library_root_id,'included',i.included) order by i.position),'[]'::jsonb)
    into vector from (select * from app.album_top_artwork_draft_items
      where preparation_ref=p_ref order by position limit 5001) i;
  n:=jsonb_array_length(vector);
  if n>5000 or n<>p.item_count or n<>p.retained_item_count or p.baseline_digest is distinct from baseline
      or octet_length(vector::text)>4194304
      or exists(select 1 from jsonb_array_elements(vector) with ordinality v(x,ord) where (x->>'position')::integer<>ord)
      or p.manifest_digest is distinct from encode(sha256(convert_to(jsonb_build_array(
          'top-artwork-draft-manifest-v1',p.top_ref,p.library_id,p.owner_account_id,p.original_session_id,
          p.context_ref,p.top_revision,p.request_generation,p.draft_ref,p.draft_revision,baseline,vector)::text,'UTF8')),'hex') then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork draft changed';
  end if;
  if not exists(select 1 from library.public_metadata_source_state where library_id=p.library_id)
    or exists(select 1 from app.album_top_artwork_draft_items i
      left join app.album_list_items saved on saved.ref=i.saved_item_ref and saved.top_ref=p.top_ref
        and saved.library_id=p.library_id and saved.catalog_ref=i.catalog_ref
      left join library.local_albums a on a.id=i.selected_local_album_id and a.library_id=p.library_id
      left join library.album_metadata_sources s on s.ref=i.selected_source_ref and s.library_id=p.library_id
        and s.local_album_id=i.selected_local_album_id and s.library_root_id=i.selected_library_root_id
      left join library.library_roots r on r.id=i.selected_library_root_id and r.library_id=p.library_id
      where i.preparation_ref=p_ref and (
        (i.top_ref,i.library_id,i.owner_account_id,i.preparation_kind) is distinct from
          (p.top_ref,p.library_id,p.owner_account_id,'draft'::text)
        or (i.row_kind='existing' and saved.ref is null)
        or (i.row_kind='new_local' and exists(select 1 from app.album_list_items b
          where b.top_ref=p.top_ref and b.catalog_ref=i.catalog_ref))
        or a.id is null or s.ref is null or s.state is distinct from 'active' or s.capture_builder_version is distinct from 1
        or s.title_origin is distinct from 'tag_metadata' or s.artist_origin is distinct from 'tag_metadata'
        or r.id is null or r.is_active is distinct from true
        or not exists(select 1 from library.catalog_album_links c where c.library_id=p.library_id
          and c.local_album_id=i.selected_local_album_id and c.catalog_ref=i.catalog_ref))) then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork draft changed';
  end if;
  if p.expires_at<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
end $$;

create function app.validate_top_artwork_draft_preparation(p_ref uuid,p_owner bigint,p_session bigint,p_context text,
  p_top_revision bigint,p_draft uuid,p_draft_revision bigint)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare p app.album_top_artwork_preparations%rowtype; t app.album_lists%rowtype;
begin
  select * into p from app.album_top_artwork_preparations where ref=p_ref;
  if not found then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  select * into t from app.album_lists where ref=p.top_ref for share;
  if not found or (t.library_id,t.owner_account_id,t.revision) is distinct from
      (p.library_id,p_owner,p_top_revision) or t.deleted_at is not null then
    raise exception using errcode='55000',constraint='top_artwork_scope',message='Artwork scope changed';
  end if;
  perform app._validate_top_artwork_draft(p_ref,p_owner,p_session,p_context,p_top_revision,p_draft,p_draft_revision);
end $$;

-- Only mutation entry points call this owner. A read snapshot acquires its
-- selected-row locks and metadata barrier in the service AFTER the read helper.
create function app._lock_top_artwork_draft_sources(p_ref uuid,p_library bigint)
returns void language plpgsql security definer set search_path=pg_catalog as $$ begin
  perform a.id from library.local_albums a where a.library_id=p_library and a.id in
    (select selected_local_album_id from app.album_top_artwork_draft_items where preparation_ref=p_ref)
    order by a.id for share;
  lock table library.album_metadata_sources,library.catalog_album_links,library.local_albums,
    library.local_artists,library.local_tracks,library.local_track_files,library.library_roots in access share mode;
  perform library.lock_public_metadata_source(p_library);
end $$;

create function app.claim_top_artwork_draft_batch(p_ref uuid,p_owner bigint,p_session bigint,p_context text,
  p_revision bigint,p_key uuid,p_lease uuid,p_draft uuid,p_draft_revision bigint)
returns uuid[] language plpgsql security definer set search_path=pg_catalog as $$
declare p app.album_top_artwork_preparations%rowtype; chosen uuid[]; now_at timestamptz;
begin
  select * into p from app.album_top_artwork_preparations where ref=p_ref;
  if not found then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  perform app.lock_top_artwork_scope(p.top_ref,p.library_id,p.owner_account_id,p.top_revision);
  perform app._lock_top_artwork_draft_sources(p_ref,p.library_id);
  perform app._validate_top_artwork_draft(p_ref,p_owner,p_session,p_context,p.top_revision,p_draft,p_draft_revision);
  select * into p from app.album_top_artwork_preparations where ref=p_ref for update;
  now_at:=clock_timestamp();
  if p.expires_at<=now_at or p.state='cancelled' then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  if p_revision is null or p_revision<1 or p_key is null or p_key='00000000-0000-0000-0000-000000000000'
      or p_lease is null or p_lease='00000000-0000-0000-0000-000000000000' then
    raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork request invalid';
  end if;
  if p.completed_request_key=p_key then
    if p.completed_from_revision=p_revision then return '{}'::uuid[]; end if;
    raise exception using errcode='23514',constraint='top_artwork_request_conflict',message='Artwork request changed';
  end if;
  if p.revision<>p_revision then
    raise exception using errcode='55000',constraint='top_artwork_revision',message='Artwork preparation changed';
  end if;
  if p.lease_ref is not null and p.lease_expires_at>now_at then
    raise exception using errcode='55P03',constraint='top_artwork_busy',message='Artwork batch is busy';
  end if;
  if p.state='ready' then return '{}'::uuid[]; end if;
  if not exists(select 1 from app.album_top_artwork_draft_items where preparation_ref=p_ref and included) then
    update app.album_top_artwork_preparations set state='ready',revision=revision+1,
      completed_request_key=p_key,completed_from_revision=p_revision,lease_ref=null,lease_expires_at=null,
      batch_request_key=null,batch_from_revision=null,batch_items=null where ref=p_ref;
    return '{}'::uuid[];
  end if;
  select array_agg(row_ref order by position) into chosen from
    (select row_ref,position from app.album_top_artwork_draft_items where preparation_ref=p_ref
      and included and status in ('pending','failed')
      order by case when status='pending' then 0 else 1 end,position limit 4) bounded;
  if chosen is null then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork manifest incomplete';
  end if;
  update app.album_top_artwork_preparations set lease_ref=p_lease,
    lease_expires_at=least(now_at+interval '120 seconds',expires_at),batch_request_key=p_key,
    batch_from_revision=p_revision,batch_items=chosen where ref=p_ref;
  return chosen;
end $$;

-- Exact type/range primitives used only by the fixed v2 schema below. CASE
-- ensures malformed strings/booleans/objects are never cast as numbers.
create function app._top_artwork_json_integer(v jsonb,lo numeric,hi numeric)
returns boolean language sql immutable set search_path=pg_catalog as $$
  select case when jsonb_typeof(v)='number' and v::text ~ '^(0|[1-9][0-9]{0,19})$'
    then v::text::numeric between lo and hi else false end
$$;
create function app._top_artwork_decimal(v jsonb,signed_value boolean)
returns boolean language sql immutable set search_path=pg_catalog as $$
  select case when jsonb_typeof(v)='string' and length(v#>>'{}')<=20
      and (v#>>'{}') ~ case when signed_value then '^(0|-?[1-9][0-9]*)$' else '^(0|[1-9][0-9]*)$' end
    then (v#>>'{}')::numeric between case when signed_value then -9223372036854775808 else 0 end
      and case when signed_value then 9223372036854775807 else 18446744073709551615 end else false end
$$;
create function app._top_artwork_v2_pair_valid(s jsonb,a jsonb,witness text,p_library bigint,p_local bigint)
returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare root jsonb; context jsonb; f jsonb; part jsonb; pieces text[]; root_parts text[];
  parsed jsonb; source_keys text[]:=array['descriptor_version','platform','library_id','local_album_id',
    'artwork_root_id','artwork_root_path','stored_cover_path','resolved_cover_path','relative_parts','root','selection_context'];
begin
  if s is null or a is null or witness is null or octet_length(witness)>65536 or witness=''
      or jsonb_typeof(s)<>'object' or jsonb_typeof(a)<>'object'
      or octet_length(s::text)>65536 or octet_length(a::text)>2048 then return false; end if;
  if not(s ?& source_keys) or s-source_keys<>'{}'::jsonb
      or not(a ?& array['acquisition_version','platform','descriptor_digest','file','input_bytes','input_pixels'])
      or a-array['acquisition_version','platform','descriptor_digest','file','input_bytes','input_pixels']<>'{}'::jsonb
      or not app._top_artwork_json_integer(s->'descriptor_version',2,2)
      or s->'platform' is distinct from '"posix"'::jsonb
      or not app._top_artwork_json_integer(a->'acquisition_version',2,2)
      or a->'platform' is distinct from '"posix"'::jsonb
      or not app._top_artwork_json_integer(s->'library_id',1,9223372036854775807)
      or not app._top_artwork_json_integer(s->'local_album_id',1,9223372036854775807)
      or not app._top_artwork_json_integer(s->'artwork_root_id',1,9223372036854775807)
      or s->>'library_id' is distinct from p_library::text or s->>'local_album_id' is distinct from p_local::text
      or jsonb_typeof(s->'artwork_root_path') is distinct from 'string'
      or jsonb_typeof(s->'stored_cover_path') is distinct from 'string'
      or jsonb_typeof(s->'resolved_cover_path') is distinct from 'string'
      or octet_length(s->>'artwork_root_path') not between 1 and 8192
      or octet_length(s->>'stored_cover_path') not between 1 and 16384
      or octet_length(s->>'resolved_cover_path') not between 1 and 16384
      or strpos(s->>'stored_cover_path','://')>0
      or jsonb_typeof(s->'relative_parts') is distinct from 'array' then return false; end if;
  if jsonb_array_length(s->'relative_parts') not between 1 and 256 then return false; end if;
  pieces:='{}'::text[];
  for part in select value from jsonb_array_elements(s->'relative_parts') loop
    if jsonb_typeof(part)<>'string' or octet_length(part#>>'{}') not between 1 and 16384
        or (part#>>'{}') in ('.','..') or strpos(part#>>'{}','/')>0 then return false; end if;
    pieces:=array_append(pieces,part#>>'{}');
  end loop;
  if left(s->>'artwork_root_path',1)<>'/' then return false; end if;
  root_parts:=case when s->>'artwork_root_path'='/' then '{}'::text[]
    else string_to_array(substring(s->>'artwork_root_path' from 2),'/') end;
  if exists(select 1 from unnest(root_parts) x where x in ('','.','..'))
      or cardinality(root_parts)+1+cardinality(pieces)>256
      or s->>'resolved_cover_path' is distinct from '/'||array_to_string(root_parts||pieces,'/') then return false; end if;
  root:=s->'root'; context:=s->'selection_context'; f:=a->'file';
  if jsonb_typeof(root) is distinct from 'object' or jsonb_typeof(context) is distinct from 'object'
      or jsonb_typeof(f) is distinct from 'object' then return false; end if;
  if not(root ?& array['device','inode']) or root-array['device','inode']<>'{}'::jsonb
      or not app._top_artwork_decimal(root->'device',false) or not app._top_artwork_decimal(root->'inode',false)
      or not(context ?& array['version','resolver_contract','inventory_digest'])
      or context-array['version','resolver_contract','inventory_digest']<>'{}'::jsonb
      or not app._top_artwork_json_integer(context->'version',1,1)
      or context->'resolver_contract' is distinct from '"artwork-posix-bounded-selection-v1"'::jsonb
      or jsonb_typeof(context->'inventory_digest') is distinct from 'string'
      or (context->>'inventory_digest') !~ '^[0-9a-f]{64}$'
      or not(f ?& array['device','inode','size','mtime_ns','ctime_ns'])
      or f-array['device','inode','size','mtime_ns','ctime_ns']<>'{}'::jsonb
      or not app._top_artwork_decimal(f->'device',false) or not app._top_artwork_decimal(f->'inode',false)
      or not app._top_artwork_decimal(f->'mtime_ns',true) or not app._top_artwork_decimal(f->'ctime_ns',true)
      or not app._top_artwork_json_integer(f->'size',1,16777216)
      or not app._top_artwork_json_integer(a->'input_bytes',1,16777216)
      or not app._top_artwork_json_integer(a->'input_pixels',1,16000000)
      or f->'size' is distinct from a->'input_bytes'
      or jsonb_typeof(a->'descriptor_digest') is distinct from 'string'
      or (a->>'descriptor_digest') !~ '^[0-9a-f]{64}$' then return false; end if;
  -- Transient supplied bytes are a bounded binding witness, not a SQL canonical
  -- serializer. Every ready consumer must validate_pair with canonical codec
  -- bytes and bind the complete fresh inventory before returning any status.
  begin parsed:=witness::jsonb;
  exception when invalid_text_representation or untranslatable_character or character_not_in_repertoire then return false;
  end;
  if parsed is distinct from s then return false; end if;
  return a->>'descriptor_digest'=encode(sha256(
    convert_to('AlbumHaven/artwork-descriptor/v2','UTF8')||decode('00','hex')||convert_to(witness,'UTF8')),'hex');
end $$;

-- Caller holds exact live Top, preparation and account-budget -> Top-budget
-- locks. This is the one physical admission owner for saved and typed rows.
create function app._admit_top_artwork_asset(p_top uuid,p_library bigint,p_owner bigint,p_ref text,
  p_digest text,p_width integer,p_height integer,p_png bytea)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare a app.album_top_artwork_assets%rowtype;
begin
  select * into a from app.album_top_artwork_assets where top_ref=p_top and sanitizer_contract=1
    and content_digest=p_digest and width=p_width and height=p_height;
  if found then
    if a.png<>p_png or a.library_id<>p_library or a.owner_account_id<>p_owner then
      raise exception using errcode='23514',constraint='top_artwork_asset_collision',message='Artwork asset mismatch';
    end if;
  else
    update app.album_top_artwork_budgets set byte_count=byte_count+octet_length(p_png),asset_count=asset_count+1
      where owner_account_id=p_owner and scope_ref in ('00000000-0000-0000-0000-000000000000'::uuid,p_top);
    insert into app.album_top_artwork_assets
      (ref,top_ref,library_id,owner_account_id,sanitizer_contract,mime_type,width,height,byte_length,content_digest,png)
      values(p_ref::uuid,p_top,p_library,p_owner,1,'image/png',p_width,p_height,octet_length(p_png),p_digest,p_png)
      returning * into a;
  end if;
  return a.ref;
end $$;

create function app.complete_top_artwork_draft_batch(p_ref uuid,p_owner bigint,p_session bigint,p_context text,
  p_revision bigint,p_key uuid,p_lease uuid,p_draft uuid,p_draft_revision bigint,p_results jsonb,p_pngs bytea[])
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare p app.album_top_artwork_preparations%rowtype; item record; result jsonb; image bytea; admitted uuid;
  count_results integer:=0; total_bytes bigint; now_at timestamptz; ordered uuid[];
begin
  select * into p from app.album_top_artwork_preparations where ref=p_ref;
  if not found then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  perform app.lock_top_artwork_scope(p.top_ref,p.library_id,p.owner_account_id,p.top_revision);
  perform app._lock_top_artwork_draft_sources(p_ref,p.library_id);
  perform app._validate_top_artwork_draft(p_ref,p_owner,p_session,p_context,p.top_revision,p_draft,p_draft_revision);
  select * into p from app.album_top_artwork_preparations where ref=p_ref for update;
  now_at:=clock_timestamp();
  if p.state<>'preparing' or p.expires_at<=now_at or p.lease_expires_at is null or p.lease_expires_at<=now_at
      or p_revision is null or p_key is null or p_lease is null
      or p_key='00000000-0000-0000-0000-000000000000' or p_lease='00000000-0000-0000-0000-000000000000'
      or (p.revision,p.batch_from_revision,p.batch_request_key,p.lease_ref)
        is distinct from (p_revision,p_revision,p_key,p_lease) then
    raise exception using errcode='55000',constraint='top_artwork_claim',message='Artwork batch claim changed';
  end if;
  -- Bounds precede JSON expansion/casts. PostgreSQL argument parsing happened
  -- already; these are function-body admission limits, not wire-parser limits.
  if p_results is null or jsonb_typeof(p_results)<>'array' or octet_length(p_results::text)>1048576
      or p_pngs is null or array_ndims(p_pngs) is distinct from 1 or array_lower(p_pngs,1) is distinct from 1
      or cardinality(p.batch_items) not between 1 and 4
      or jsonb_array_length(p_results)<>cardinality(p.batch_items)
      or cardinality(p_pngs)<>cardinality(p.batch_items) then
    raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results invalid';
  end if;
  if exists(select 1 from unnest(p_pngs) png where octet_length(png)>327680)
      or (select coalesce(sum(octet_length(png)),0) from unnest(p_pngs) png)>1310720 then
    raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results invalid';
  end if;
  select array_agg(row_ref order by position) into ordered from app.album_top_artwork_draft_items
    where preparation_ref=p_ref and row_ref=any(p.batch_items) and included and status in ('pending','failed');
  if ordered is distinct from p.batch_items then
    raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results invalid';
  end if;
  perform app.lock_top_artwork_budgets(p.top_ref,p.library_id,p_owner);
  for item in select * from app.album_top_artwork_draft_items where preparation_ref=p_ref
      and row_ref=any(p.batch_items) order by position for update loop
    result:=p_results->count_results; image:=p_pngs[count_results+1]; count_results:=count_results+1;
    if jsonb_typeof(result) is distinct from 'object' then
      raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results invalid';
    end if;
    if result->'row_ref' is distinct from to_jsonb(item.row_ref::text)
        or jsonb_typeof(result->'status') is distinct from 'string' then
      raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results invalid';
    end if;
    if result->>'status'='failed' then
      if not(result ?& array['row_ref','status','error_code']) or result-array['row_ref','status','error_code']<>'{}'::jsonb
          or image is not null or jsonb_typeof(result->'error_code') is distinct from 'string'
          or result->>'error_code' not in ('artwork_unavailable','artwork_source_changed','artwork_limit') then
        raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results invalid';
      end if;
      update app.album_top_artwork_draft_items set status='failed',error_code=result->>'error_code'
        where preparation_ref=p_ref and row_ref=item.row_ref;
      continue;
    end if;
    if result->>'status' is distinct from 'ready' or image is null
        or not(result ?& array['row_ref','status','asset_ref','content_digest','width','height','source_stamp','acquisition_stamp','source_bytes'])
        or result-array['row_ref','status','asset_ref','content_digest','width','height','source_stamp','acquisition_stamp','source_bytes']<>'{}'::jsonb
        or jsonb_typeof(result->'asset_ref') is distinct from 'string'
        or (result->>'asset_ref') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or result->>'asset_ref'='00000000-0000-0000-0000-000000000000'
        or jsonb_typeof(result->'content_digest') is distinct from 'string'
        or (result->>'content_digest') !~ '^[0-9a-f]{64}$'
        or not app._top_artwork_json_integer(result->'width',1,256)
        or not app._top_artwork_json_integer(result->'height',1,256)
        or jsonb_typeof(result->'source_bytes') is distinct from 'string'
        or not app._top_artwork_v2_pair_valid(result->'source_stamp',result->'acquisition_stamp',result->>'source_bytes',
          p.library_id,item.selected_local_album_id) then
      raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results invalid';
    end if;
    if not exists(select 1 from library.library_roots where library_id=p.library_id and is_active is true
          and id=(result->'source_stamp'->>'artwork_root_id')::bigint
          and root_path=result->'source_stamp'->>'artwork_root_path')
       or not exists(select 1 from library.local_albums where library_id=p.library_id and id=item.selected_local_album_id
          and cover_path=result->'source_stamp'->>'stored_cover_path') then
      raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results invalid';
    end if;
    admitted:=app._admit_top_artwork_asset(p.top_ref,p.library_id,p_owner,result->>'asset_ref',
      result->>'content_digest',(result->>'width')::integer,(result->>'height')::integer,image);
    update app.album_top_artwork_draft_items set status='ready',asset_ref=admitted,
      source_stamp=result->'source_stamp',acquisition_stamp=result->'acquisition_stamp',error_code=null
      where preparation_ref=p_ref and row_ref=item.row_ref;
  end loop;
  if count_results<>cardinality(p.batch_items) then
    raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results incomplete';
  end if;
  select coalesce(sum(asset_row.byte_length),0) into total_bytes from app.album_top_artwork_draft_items i
    join app.album_top_artwork_assets asset_row on asset_row.ref=i.asset_ref where i.preparation_ref=p_ref;
  if total_bytes>134217728 then
    raise exception using errcode='23514',constraint='top_artwork_publication_budget',message='Artwork publication budget exceeded';
  end if;
  -- Original deadlines, freshly measured AFTER every budget/asset wait and all
  -- proof writes. Failure rolls this entire statement/transaction back.
  now_at:=clock_timestamp();
  if p.expires_at<=now_at or p.lease_expires_at<=now_at then
    raise exception using errcode='55000',constraint='top_artwork_claim',message='Artwork batch claim expired';
  end if;
  update app.album_top_artwork_preparations set revision=revision+1,
    state=case when exists(select 1 from app.album_top_artwork_draft_items
      where preparation_ref=p_ref and status in ('pending','failed')) then 'preparing' else 'ready' end,
    completed_request_key=p_key,completed_from_revision=p_revision,lease_ref=null,lease_expires_at=null,
    batch_request_key=null,batch_from_revision=null,batch_items=null where ref=p_ref;
end $$;

-- Saved semantics remain as 0131 except the shared physical admission and the
-- deliberate original-lease/preparation final deadline correction below.
create or replace function app.complete_top_artwork_batch_saved_v1(p_ref uuid,p_owner bigint,p_session bigint,p_context text,
  p_revision bigint,p_key uuid,p_lease uuid,p_results jsonb,p_pngs bytea[])
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare p app.album_top_artwork_preparations%rowtype; item record; result jsonb; image bytea;
  a app.album_top_artwork_assets%rowtype; count_results integer; total_bytes bigint; now_at timestamptz;
begin
  -- Discover the immutable parent without a child lock, then always lock Top
  -- before preparation. This also serializes direct admitted helper calls with
  -- the owner's read-only Top SHARE lock without granting staging-row UPDATE.
  select * into p from app.album_top_artwork_preparations where ref=p_ref;
  if not found then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  perform app.lock_top_artwork_scope(p.top_ref,p.library_id,p.owner_account_id,p.top_revision);
  select * into p from app.album_top_artwork_preparations where ref=p_ref for update;
  now_at:=clock_timestamp();
  if not found or (p.owner_account_id,p.original_session_id,p.context_ref) is distinct from (p_owner,p_session,p_context)
      or p.state<>'preparing' or p.expires_at<=now_at or p.lease_expires_at<=now_at
      or (p.revision,p.batch_from_revision,p.batch_request_key,p.lease_ref)
         is distinct from (p_revision,p_revision,p_key,p_lease) then
    raise exception using errcode='55000',constraint='top_artwork_claim',message='Artwork batch claim changed';
  end if;
  if p_results is null or jsonb_typeof(p_results)<>'array' or p_pngs is null
      or jsonb_array_length(p_results)<>cardinality(p.batch_items)
      or cardinality(p_pngs)<>cardinality(p.batch_items) or octet_length(p_results::text)>262144 then
    raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results invalid';
  end if;
  -- Account budget is always acquired before Top budget. Parent authority/Top
  -- and preparation are already held by the service; no counter is client input.
  insert into app.album_top_artwork_budgets(owner_account_id,scope_ref)
    values(p_owner,'00000000-0000-0000-0000-000000000000') on conflict do nothing;
  perform 1 from app.album_top_artwork_budgets where owner_account_id=p_owner
    and scope_ref='00000000-0000-0000-0000-000000000000' for update;
  insert into app.album_top_artwork_budgets(owner_account_id,scope_ref,top_ref,library_id)
    values(p_owner,p.top_ref,p.top_ref,p.library_id) on conflict do nothing;
  perform 1 from app.album_top_artwork_budgets where owner_account_id=p_owner and scope_ref=p.top_ref for update;
  count_results:=0;
  for item in select * from app.album_top_artwork_preparation_items where preparation_ref=p_ref
      and item_ref=any(p.batch_items) order by position for update loop
    result:=p_results->count_results; image:=p_pngs[count_results+1]; count_results:=count_results+1;
    if result->>'item_ref' is distinct from item.item_ref::text or item.status not in ('pending','failed') then
      raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results invalid';
    end if;
    if result->>'status'='failed' then
      if image is not null or result->>'error_code' not in ('artwork_unavailable','artwork_source_changed','artwork_limit') then
        raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results invalid';
      end if;
      update app.album_top_artwork_preparation_items set status='failed',error_code=result->>'error_code'
        where preparation_ref=p_ref and item_ref=item.item_ref;
      continue;
    end if;
    if result->>'status' is distinct from 'ready' or image is null
        or result->'source_stamp'->>'library_id' is distinct from p.library_id::text
        or result->'source_stamp'->>'local_album_id' is distinct from item.selected_local_album_id::text
        or not exists(select 1 from library.library_roots where library_id=p.library_id and is_active is true
          and id=(result->'source_stamp'->>'artwork_root_id')::bigint
          and root_path=result->'source_stamp'->>'artwork_root_path') then
      raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results invalid';
    end if;
    a.ref:=app._admit_top_artwork_asset(p.top_ref,p.library_id,p_owner,result->>'asset_ref',
      result->>'content_digest',(result->>'width')::integer,(result->>'height')::integer,image);
    update app.album_top_artwork_preparation_items set status='ready',asset_ref=a.ref,
      source_stamp=result->'source_stamp',acquisition_stamp=result->'acquisition_stamp',error_code=null
      where preparation_ref=p_ref and item_ref=item.item_ref;
  end loop;
  if count_results<>cardinality(p.batch_items) then
    raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results incomplete';
  end if;
  select coalesce(sum(asset_row.byte_length),0) into total_bytes from app.album_top_artwork_preparation_items i
    join app.album_top_artwork_assets asset_row on asset_row.ref=i.asset_ref where i.preparation_ref=p_ref;
  if total_bytes>134217728 then
    raise exception using errcode='23514',constraint='top_artwork_publication_budget',message='Artwork publication budget exceeded';
  end if;
  now_at:=clock_timestamp();
  if p.expires_at<=now_at or p.lease_expires_at<=now_at then
    raise exception using errcode='55000',constraint='top_artwork_claim',message='Artwork batch claim expired';
  end if;
  update app.album_top_artwork_preparations set revision=revision+1,
    state=case when exists(select 1 from app.album_top_artwork_preparation_items
      where preparation_ref=p_ref and status in ('pending','failed')) then 'preparing' else 'ready' end,
    completed_request_key=p_key,completed_from_revision=p_revision,lease_ref=null,lease_expires_at=null,
    batch_request_key=null,batch_from_revision=null,batch_items=null where ref=p_ref;
end $$;

-- Either store's pin prevents deletion, even with an otherwise exact cleanup
-- permit. Scoped FK/index and the same Top UPDATE serialization are retained.
create or replace function app.guard_top_artwork_asset() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  if TG_OP='DELETE' and exists(select 1 from app.album_top_artwork_cleanup_permits
      where transaction_id=txid_current() and backend_id=pg_backend_pid() and kind='asset'
        and parent_ref=OLD.top_ref and row_ref=OLD.ref)
     and not exists(select 1 from app.album_top_artwork_preparation_items where asset_ref=OLD.ref)
     and not exists(select 1 from app.album_top_artwork_draft_items where asset_ref=OLD.ref) then return OLD; end if;
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
       and not exists(select 1 from app.album_top_artwork_draft_items where asset_ref=a.ref) then
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

-- New implementation helpers have no runtime/PUBLIC/readonly entry. Existing
-- saved wrapper ACLs remain unchanged through CREATE OR REPLACE above.
revoke all on function app.deny_top_artwork_draft_identity_update(),
  app._top_artwork_draft_baseline(uuid,bigint,bigint,bigint),
  app._validate_top_artwork_draft(uuid,bigint,bigint,text,bigint,uuid,bigint),
  app._lock_top_artwork_draft_sources(uuid,bigint),
  app._top_artwork_json_integer(jsonb,numeric,numeric),app._top_artwork_decimal(jsonb,boolean),
  app._top_artwork_v2_pair_valid(jsonb,jsonb,text,bigint,bigint),
  app._admit_top_artwork_asset(uuid,bigint,bigint,text,text,integer,integer,bytea),
  app.validate_top_artwork_draft_preparation(uuid,bigint,bigint,text,bigint,uuid,bigint),
  app.claim_top_artwork_draft_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,uuid,bigint),
  app.complete_top_artwork_draft_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,uuid,bigint,jsonb,bytea[]) from public;
do $$ declare role_name text; begin
  foreach role_name in array array['album_haven_app','album_haven_readonly'] loop
    if exists(select 1 from pg_catalog.pg_roles where rolname=role_name) then
      execute format('revoke all on function app.deny_top_artwork_draft_identity_update(),
  app._top_artwork_draft_baseline(uuid,bigint,bigint,bigint),
        app._validate_top_artwork_draft(uuid,bigint,bigint,text,bigint,uuid,bigint),
        app._lock_top_artwork_draft_sources(uuid,bigint),
        app._top_artwork_json_integer(jsonb,numeric,numeric),app._top_artwork_decimal(jsonb,boolean),
        app._top_artwork_v2_pair_valid(jsonb,jsonb,text,bigint,bigint),
        app._admit_top_artwork_asset(uuid,bigint,bigint,text,text,integer,integer,bytea),
        app.validate_top_artwork_draft_preparation(uuid,bigint,bigint,text,bigint,uuid,bigint),
        app.claim_top_artwork_draft_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,uuid,bigint),
        app.complete_top_artwork_draft_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,uuid,bigint,jsonb,bytea[]) from %I',role_name);
    end if;
  end loop;
  if exists(select 1 from pg_catalog.pg_roles where rolname='album_haven_app') then
    grant execute on function app.validate_top_artwork_draft_preparation(uuid,bigint,bigint,text,bigint,uuid,bigint),
      app.claim_top_artwork_draft_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,uuid,bigint),
      app.complete_top_artwork_draft_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,uuid,bigint,jsonb,bytea[]) to album_haven_app;
  end if;
end $$;
