-- Dormant owner-private preparation. No publication child, seal, route or pointer.
-- Apply only as the trusted non-superuser migration owner.
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    raise exception using errcode='42501',message='Artwork preparation requires a non-superuser migration owner';
  end if;
end $$;

alter table app.album_lists add constraint album_lists_artwork_owner_unique
  unique(ref,library_id,owner_account_id);

create table app.album_top_artwork_preparations (
  ref uuid primary key check(ref<>'00000000-0000-0000-0000-000000000000'),
  top_ref uuid not null,
  library_id bigint not null,
  owner_account_id bigint not null,
  original_session_id bigint not null check(original_session_id>0),
  context_ref text not null check(context_ref ~ '^[0-9a-f]{64}$'),
  top_revision bigint not null check(top_revision>0),
  start_request_key uuid not null,
  manifest_digest text not null check(manifest_digest ~ '^[0-9a-f]{64}$'),
  item_count integer not null check(item_count between 0 and 5000),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  state text not null check(state in ('preparing','ready','cancelled')),
  revision bigint not null default 1 check(revision>0),
  lease_ref uuid,
  lease_expires_at timestamptz,
  batch_request_key uuid,
  batch_from_revision bigint,
  batch_items uuid[],
  completed_request_key uuid,
  completed_from_revision bigint,
  foreign key(top_ref,library_id,owner_account_id)
    references app.album_lists(ref,library_id,owner_account_id),
  unique(ref,top_ref,library_id,owner_account_id),
  unique(owner_account_id,library_id,start_request_key),
  check(expires_at=created_at+interval '60 minutes'),
  check((lease_ref is null and lease_expires_at is null and batch_request_key is null
         and batch_from_revision is null and batch_items is null)
     or (lease_ref is not null and lease_expires_at is not null and batch_request_key is not null
         and batch_from_revision is not null and batch_from_revision=revision and batch_items is not null
         and cardinality(batch_items) between 1 and 4 and state='preparing'
         and lease_expires_at<=expires_at)),
  check((completed_request_key is null)=(completed_from_revision is null)),
  check(completed_from_revision is null or completed_from_revision>0)
);
create unique index album_top_artwork_active_scope on app.album_top_artwork_preparations
  (top_ref,owner_account_id,original_session_id) where state in ('preparing','ready');

create table app.album_top_artwork_assets (
  ref uuid primary key check(ref<>'00000000-0000-0000-0000-000000000000'),
  top_ref uuid not null,
  library_id bigint not null,
  owner_account_id bigint not null,
  sanitizer_contract integer not null check(sanitizer_contract=1),
  mime_type text not null check(mime_type='image/png'),
  width integer not null check(width between 1 and 256),
  height integer not null check(height between 1 and 256),
  byte_length integer not null check(byte_length between 1 and 327680),
  content_digest text not null check(content_digest ~ '^[0-9a-f]{64}$'),
  png bytea not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(top_ref,library_id,owner_account_id)
    references app.album_lists(ref,library_id,owner_account_id),
  unique(ref,top_ref,library_id,owner_account_id),
  unique(top_ref,sanitizer_contract,content_digest,width,height),
  check(octet_length(png)=byte_length and substring(png from 1 for 8)=decode('89504e470d0a1a0a','hex')
    and encode(sha256(png),'hex')=content_digest)
);

create table app.album_top_artwork_preparation_items (
  preparation_ref uuid not null,
  top_ref uuid not null,
  library_id bigint not null,
  owner_account_id bigint not null,
  item_ref uuid not null,
  catalog_ref uuid not null references catalog.release_groups(ref),
  position integer not null check(position between 1 and 5000),
  selected_local_album_id bigint not null check(selected_local_album_id>0),
  selected_source_ref uuid not null,
  selected_library_root_id bigint not null check(selected_library_root_id>0),
  included boolean not null,
  status text not null check(status in ('excluded','pending','failed','ready')),
  asset_ref uuid,
  source_stamp jsonb,
  acquisition_stamp jsonb,
  error_code text check(error_code in ('artwork_unavailable','artwork_source_changed','artwork_limit')),
  primary key(preparation_ref,item_ref),
  unique(preparation_ref,position),
  unique(preparation_ref,catalog_ref),
  foreign key(preparation_ref,top_ref,library_id,owner_account_id)
    references app.album_top_artwork_preparations(ref,top_ref,library_id,owner_account_id) on delete cascade,
  foreign key(asset_ref,top_ref,library_id,owner_account_id)
    references app.album_top_artwork_assets(ref,top_ref,library_id,owner_account_id),
  check((not included and status='excluded' and asset_ref is null and source_stamp is null
         and acquisition_stamp is null and error_code is null)
    or (included and status='pending' and asset_ref is null and source_stamp is null
         and acquisition_stamp is null and error_code is null)
    or (included and status='failed' and asset_ref is null and source_stamp is null
         and acquisition_stamp is null and error_code is not null)
    or (included and status='ready' and asset_ref is not null and source_stamp is not null
         and acquisition_stamp is not null and error_code is null)),
  check(source_stamp is null or (jsonb_typeof(source_stamp)='object'
      and octet_length(source_stamp::text)<=65536)),
  check(acquisition_stamp is null or (jsonb_typeof(acquisition_stamp)='object'
      and octet_length(acquisition_stamp::text)<=2048))
);

create table app.album_top_artwork_budgets (
  owner_account_id bigint not null references app.accounts(id),
  scope_ref uuid not null,
  top_ref uuid,
  library_id bigint,
  byte_count bigint not null default 0 check(byte_count>=0),
  asset_count integer not null default 0 check(asset_count>=0),
  primary key(owner_account_id,scope_ref),
  foreign key(top_ref,library_id,owner_account_id)
    references app.album_lists(ref,library_id,owner_account_id),
  check((scope_ref='00000000-0000-0000-0000-000000000000' and top_ref is null and library_id is null
         and byte_count<=4294967296 and asset_count<=100000)
    or (top_ref is not null and scope_ref=top_ref and top_ref<>'00000000-0000-0000-0000-000000000000' and library_id is not null
         and byte_count<=536870912 and asset_count<=20000))
);

-- Immutable assets and completed proofs are protected even against accidental
-- trusted-writer changes. No runtime UPDATE/DELETE/TRUNCATE grant is provided.
create function app.guard_top_artwork_asset() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  raise exception using errcode='55000',constraint='top_artwork_asset_immutable',message='Artwork asset is immutable';
end $$;
create trigger top_artwork_asset_immutable before update or delete on app.album_top_artwork_assets
  for each row execute function app.guard_top_artwork_asset();
create function app.guard_top_artwork_item() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  if TG_OP='DELETE' then
    raise exception using errcode='55000',constraint='top_artwork_proof_immutable',message='Artwork proof is immutable';
  end if;
  if OLD.status in ('ready','excluded') or
     (NEW.preparation_ref,NEW.top_ref,NEW.library_id,NEW.owner_account_id,NEW.item_ref,
      NEW.catalog_ref,NEW.position,NEW.selected_local_album_id,NEW.selected_source_ref,
      NEW.selected_library_root_id,NEW.included) is distinct from
     (OLD.preparation_ref,OLD.top_ref,OLD.library_id,OLD.owner_account_id,OLD.item_ref,
      OLD.catalog_ref,OLD.position,OLD.selected_local_album_id,OLD.selected_source_ref,
      OLD.selected_library_root_id,OLD.included) then
    raise exception using errcode='55000',constraint='top_artwork_proof_immutable',message='Artwork proof is immutable';
  end if;
  return NEW;
end $$;
create trigger top_artwork_proof_immutable before update or delete on app.album_top_artwork_preparation_items
  for each row execute function app.guard_top_artwork_item();

-- The service owns real current account/session/policy checks. These helpers
-- enforce structural ownership/revision, bounded transitions and immutable facts;
-- neither a UUID nor these caller parameters replace the authenticated service.
create function app.lock_top_artwork_scope(p_top uuid,p_library bigint,p_owner bigint,p_revision bigint)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare t app.album_lists%rowtype;
begin
  select * into t from app.album_lists where ref=p_top for update;
  if not found or t.library_id<>p_library or t.owner_account_id<>p_owner
      or t.deleted_at is not null or t.revision<>p_revision then
    raise exception using errcode='55000',constraint='top_artwork_scope',message='Artwork scope changed';
  end if;
end $$;

create function app.start_top_artwork_preparation(p_ref uuid,p_top uuid,p_library bigint,p_owner bigint,
  p_session bigint,p_context text,p_revision bigint,p_key uuid,p_digest text,p_items jsonb)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare previous app.album_top_artwork_preparations%rowtype; n integer; now_at timestamptz;
begin
  perform app.lock_top_artwork_scope(p_top,p_library,p_owner,p_revision);
  select * into previous from app.album_top_artwork_preparations
    where owner_account_id=p_owner and library_id=p_library and start_request_key=p_key for update;
  if found then
    if (previous.top_ref,previous.original_session_id,previous.context_ref,previous.top_revision,previous.manifest_digest)
       is distinct from (p_top,p_session,p_context,p_revision,p_digest) then
      raise exception using errcode='23514',constraint='top_artwork_request_conflict',message='Artwork request changed';
    end if;
    return previous.ref;
  end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>5000
      or octet_length(p_items::text)>4194304 then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork manifest invalid';
  end if;
  n:=jsonb_array_length(p_items);
  -- Require the complete saved ordered set. No unresolved nonempty Top can be
  -- converted into an empty manifest; local source eligibility is checked below.
  if n<>(select count(*) from app.album_list_items where top_ref=p_top)
     or exists(select 1 from jsonb_to_recordset(p_items) as x(item_ref uuid,catalog_ref uuid,
        position integer,selected_local_album_id bigint,selected_source_ref uuid,
        selected_library_root_id bigint,included boolean)
       left join app.album_list_items i on i.ref=x.item_ref and i.top_ref=p_top
         and i.library_id=p_library and i.catalog_ref=x.catalog_ref and i.curator_position=x.position
       left join library.album_metadata_sources s on s.ref=x.selected_source_ref
         and s.library_id=p_library and s.local_album_id=x.selected_local_album_id
         and s.library_root_id=x.selected_library_root_id and s.state='active' and s.capture_builder_version=1
       left join library.catalog_album_links c on c.library_id=p_library
         and c.local_album_id=x.selected_local_album_id and c.catalog_ref=x.catalog_ref
       left join library.library_roots r on r.id=x.selected_library_root_id
         and r.library_id=p_library and r.is_active is true
       where i.ref is null or s.ref is null or c.catalog_ref is null or r.id is null or x.included is null) then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork manifest invalid';
  end if;
  now_at:=clock_timestamp();
  update app.album_top_artwork_preparations set state='cancelled',lease_ref=null,lease_expires_at=null,
    batch_request_key=null,batch_from_revision=null,batch_items=null
    where top_ref=p_top and owner_account_id=p_owner and original_session_id=p_session
      and state in ('preparing','ready');
  insert into app.album_top_artwork_preparations
    (ref,top_ref,library_id,owner_account_id,original_session_id,context_ref,top_revision,
     start_request_key,manifest_digest,item_count,created_at,expires_at,state)
    values(p_ref,p_top,p_library,p_owner,p_session,p_context,p_revision,p_key,p_digest,n,
      now_at,now_at+interval '60 minutes',case when exists(select 1 from jsonb_array_elements(p_items) x
        where x->'included'='true'::jsonb) then 'preparing' else 'ready' end);
  insert into app.album_top_artwork_preparation_items
    (preparation_ref,top_ref,library_id,owner_account_id,item_ref,catalog_ref,position,
     selected_local_album_id,selected_source_ref,selected_library_root_id,included,status)
    select p_ref,p_top,p_library,p_owner,x.item_ref,x.catalog_ref,x.position,x.selected_local_album_id,
      x.selected_source_ref,x.selected_library_root_id,x.included,case when x.included then 'pending' else 'excluded' end
    from jsonb_to_recordset(p_items) as x(item_ref uuid,catalog_ref uuid,position integer,
      selected_local_album_id bigint,selected_source_ref uuid,selected_library_root_id bigint,included boolean);
  return p_ref;
end $$;

create function app.claim_top_artwork_batch(p_ref uuid,p_owner bigint,p_session bigint,p_context text,
  p_revision bigint,p_key uuid,p_lease uuid)
returns uuid[] language plpgsql security definer set search_path=pg_catalog as $$
declare p app.album_top_artwork_preparations%rowtype; chosen uuid[]; now_at timestamptz;
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
      or p.state='cancelled' or p.expires_at<=now_at then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  if p.completed_request_key=p_key then
    if p.completed_from_revision=p_revision then return '{}'::uuid[]; end if;
    raise exception using errcode='23514',constraint='top_artwork_request_conflict',message='Artwork request changed';
  end if;
  if p.revision<>p_revision then
    raise exception using errcode='55000',constraint='top_artwork_revision',message='Artwork preparation changed';
  end if;
  if p.lease_ref is not null and p.lease_expires_at>now_at then
    -- A lost in-flight response cannot create a second decoder for this lease.
    raise exception using errcode='55P03',constraint='top_artwork_busy',message='Artwork batch is busy';
  end if;
  if p.state='ready' then return '{}'::uuid[]; end if;
  select array_agg(item_ref order by position) into chosen from
    (select item_ref,position from app.album_top_artwork_preparation_items
      where preparation_ref=p_ref and status in ('pending','failed')
      order by case when status='pending' then 0 else 1 end,position limit 4) x;
  if chosen is null then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork manifest incomplete';
  end if;
  update app.album_top_artwork_preparations set lease_ref=p_lease,
    lease_expires_at=least(now_at+interval '120 seconds',expires_at),batch_request_key=p_key,
    batch_from_revision=p_revision,batch_items=chosen where ref=p_ref;
  return chosen;
end $$;

create function app.complete_top_artwork_batch(p_ref uuid,p_owner bigint,p_session bigint,p_context text,
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
    select * into a from app.album_top_artwork_assets where top_ref=p.top_ref and sanitizer_contract=1
      and content_digest=result->>'content_digest' and width=(result->>'width')::integer
      and height=(result->>'height')::integer;
    if found then
      if a.png<>image or a.library_id<>p.library_id or a.owner_account_id<>p_owner then
        raise exception using errcode='23514',constraint='top_artwork_asset_collision',message='Artwork asset mismatch';
      end if;
    else
      update app.album_top_artwork_budgets set byte_count=byte_count+octet_length(image),asset_count=asset_count+1
        where owner_account_id=p_owner and scope_ref in ('00000000-0000-0000-0000-000000000000'::uuid,p.top_ref);
      insert into app.album_top_artwork_assets
        (ref,top_ref,library_id,owner_account_id,sanitizer_contract,mime_type,width,height,byte_length,content_digest,png)
        values((result->>'asset_ref')::uuid,p.top_ref,p.library_id,p_owner,1,'image/png',
          (result->>'width')::integer,(result->>'height')::integer,octet_length(image),result->>'content_digest',image)
        returning * into a;
    end if;
    update app.album_top_artwork_preparation_items set status='ready',asset_ref=a.ref,
      source_stamp=result->'source_stamp',acquisition_stamp=result->'acquisition_stamp',error_code=null
      where preparation_ref=p_ref and item_ref=item.item_ref;
  end loop;
  if count_results<>cardinality(p.batch_items) then
    raise exception using errcode='23514',constraint='top_artwork_results',message='Artwork results incomplete';
  end if;
  select coalesce(sum(a.byte_length),0) into total_bytes from app.album_top_artwork_preparation_items i
    join app.album_top_artwork_assets a on a.ref=i.asset_ref where i.preparation_ref=p_ref;
  if total_bytes>134217728 then
    raise exception using errcode='23514',constraint='top_artwork_publication_budget',message='Artwork publication budget exceeded';
  end if;
  update app.album_top_artwork_preparations set revision=revision+1,
    state=case when exists(select 1 from app.album_top_artwork_preparation_items
      where preparation_ref=p_ref and status in ('pending','failed')) then 'preparing' else 'ready' end,
    completed_request_key=p_key,completed_from_revision=p_revision,lease_ref=null,lease_expires_at=null,
    batch_request_key=null,batch_from_revision=null,batch_items=null where ref=p_ref;
end $$;

-- No deletion/retention job is introduced. Bounded private reclamation is a
-- separate complete-chain companion; immutable history is never pruned here.
revoke all on app.album_top_artwork_preparations,app.album_top_artwork_preparation_items,
  app.album_top_artwork_assets,app.album_top_artwork_budgets from public;
revoke all on function app.guard_top_artwork_asset(),app.guard_top_artwork_item(),
  app.lock_top_artwork_scope(uuid,bigint,bigint,bigint),
  app.start_top_artwork_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb),
  app.claim_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid),
  app.complete_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,jsonb,bytea[]) from public;
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname='album_haven_readonly') then
    revoke all on app.album_top_artwork_preparations,app.album_top_artwork_preparation_items,
      app.album_top_artwork_assets,app.album_top_artwork_budgets from album_haven_readonly;
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname='album_haven_app') then
    revoke all on app.album_top_artwork_preparations,app.album_top_artwork_preparation_items,
      app.album_top_artwork_assets,app.album_top_artwork_budgets from album_haven_app;
    grant select on app.album_top_artwork_preparations,app.album_top_artwork_preparation_items,
      app.album_top_artwork_assets,app.album_top_artwork_budgets to album_haven_app;
    grant execute on function
      app.start_top_artwork_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb),
      app.claim_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid),
      app.complete_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,jsonb,bytea[]) to album_haven_app;
  end if;
end $$;
