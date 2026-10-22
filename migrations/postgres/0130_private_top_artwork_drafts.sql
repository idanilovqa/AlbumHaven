-- Dormant B2.1: typed local draft admission, no capture or publication.
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    raise exception using errcode='42501',message='Artwork drafts require a non-superuser migration owner';
  end if;
end $$;
lock table app.album_top_artwork_preparations,app.album_top_artwork_preparation_items,
  app.album_top_artwork_budgets in access exclusive mode;
alter table app.album_top_artwork_preparations
  add column preparation_kind text not null default 'saved',
  add column draft_ref uuid,
  add column draft_revision bigint,
  add column baseline_digest text,
  add constraint top_artwork_preparation_kind check(
    (preparation_kind='saved' and draft_ref is null and draft_revision is null and baseline_digest is null)
    or (preparation_kind='draft' and draft_ref is not null
      and draft_ref<>'00000000-0000-0000-0000-000000000000' and draft_revision is not null and draft_revision>0
      and baseline_digest is not null and baseline_digest ~ '^[0-9a-f]{64}$')),
  add constraint top_artwork_preparation_typed_unique unique(ref,top_ref,library_id,owner_account_id,preparation_kind);
create unique index top_artwork_draft_identity on app.album_top_artwork_preparations
  (top_ref,owner_account_id,original_session_id,context_ref,draft_ref,draft_revision) where preparation_kind='draft';
alter table app.album_top_artwork_preparation_items
  add column preparation_kind text not null default 'saved' check(preparation_kind='saved'),
  add constraint top_artwork_saved_item_kind foreign key(preparation_ref,top_ref,library_id,owner_account_id,preparation_kind)
    references app.album_top_artwork_preparations(ref,top_ref,library_id,owner_account_id,preparation_kind);

create table app.album_top_artwork_draft_items (
  preparation_ref uuid not null,
  top_ref uuid not null,
  library_id bigint not null,
  owner_account_id bigint not null,
  preparation_kind text not null default 'draft' check(preparation_kind='draft'),
  row_ref uuid not null check(row_ref<>'00000000-0000-0000-0000-000000000000'),
  row_kind text not null,
  saved_item_ref uuid,
  catalog_ref uuid not null references catalog.release_groups(ref),
  position integer not null check(position between 1 and 5000),
  selected_local_album_id bigint not null check(selected_local_album_id>0),
  selected_source_ref uuid not null,
  selected_library_root_id bigint not null check(selected_library_root_id>0),
  included boolean not null,
  primary key(preparation_ref,row_ref),
  unique(preparation_ref,position), unique(preparation_ref,catalog_ref), unique(preparation_ref,saved_item_ref),
  foreign key(preparation_ref,top_ref,library_id,owner_account_id,preparation_kind)
    references app.album_top_artwork_preparations(ref,top_ref,library_id,owner_account_id,preparation_kind),
  check((row_kind='existing' and saved_item_ref is not null and saved_item_ref<>'00000000-0000-0000-0000-000000000000')
     or (row_kind='new_local' and saved_item_ref is null))
);
-- A header cannot cascade an unmetered draft manifest. Cleanup deletes each
-- permitted row within the shared 512-row allowance, then its empty header.
alter table app.album_top_artwork_cleanup_permits drop constraint album_top_artwork_cleanup_permits_kind_check;
alter table app.album_top_artwork_cleanup_permits add constraint album_top_artwork_cleanup_permits_kind_check
  check(kind in ('item','asset','draft_item'));
create function app.guard_top_artwork_draft_item() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  if TG_OP='DELETE' and exists(select 1 from app.album_top_artwork_cleanup_permits
      where transaction_id=txid_current() and backend_id=pg_backend_pid() and kind='draft_item'
        and parent_ref=OLD.preparation_ref and row_ref=OLD.row_ref)
     and exists(select 1 from app.album_top_artwork_preparations
       where ref=OLD.preparation_ref and preparation_kind='draft' and state='cancelled') then return OLD; end if;
  raise exception using errcode='55000',constraint='top_artwork_draft_immutable',message='Artwork draft is immutable';
end $$;
create trigger top_artwork_draft_immutable before update or delete on app.album_top_artwork_draft_items
  for each row execute function app.guard_top_artwork_draft_item();

create function app.top_artwork_draft_baseline(p_top uuid,p_library bigint,p_owner bigint,p_revision bigint)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare t app.album_lists%rowtype; vector jsonb;
begin
  select * into t from app.album_lists where ref=p_top for update;
  if not found or t.library_id is distinct from p_library or t.owner_account_id is distinct from p_owner
      or t.revision is distinct from p_revision or t.deleted_at is not null then
    raise exception using errcode='55000',constraint='top_artwork_scope',message='Artwork scope changed';
  end if;
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

-- Fence every legacy entry before it can see a header with no saved-item rows.
create function app.lock_top_artwork_saved_preparation(p_ref uuid)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare p app.album_top_artwork_preparations%rowtype;
begin
  select * into p from app.album_top_artwork_preparations where ref=p_ref;
  if not found then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
  perform app.lock_top_artwork_scope(p.top_ref,p.library_id,p.owner_account_id,p.top_revision);
  select * into p from app.album_top_artwork_preparations where ref=p_ref for update;
  if not found or p.preparation_kind<>'saved' then
    raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
  end if;
end $$;
alter function app.start_top_artwork_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb,bigint)
  rename to start_top_artwork_preparation_saved_v2;
alter function app.claim_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid)
  rename to claim_top_artwork_batch_saved_v1;
alter function app.complete_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,jsonb,bytea[])
  rename to complete_top_artwork_batch_saved_v1;
create function app.start_top_artwork_preparation(p_ref uuid,p_top uuid,p_library bigint,p_owner bigint,
  p_session bigint,p_context text,p_revision bigint,p_key uuid,p_digest text,p_items jsonb,p_generation bigint)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$ begin
  perform app.lock_top_artwork_scope(p_top,p_library,p_owner,p_revision);
  if exists(select 1 from app.album_top_artwork_preparations where owner_account_id=p_owner
      and library_id=p_library and start_request_key=p_key and preparation_kind<>'saved') then
    raise exception using errcode='23514',constraint='top_artwork_request_conflict',message='Artwork request changed';
  end if;
  return app.start_top_artwork_preparation_saved_v2(p_ref,p_top,p_library,p_owner,p_session,p_context,
    p_revision,p_key,p_digest,p_items,p_generation);
end $$;
create function app.claim_top_artwork_batch(p_ref uuid,p_owner bigint,p_session bigint,p_context text,
  p_revision bigint,p_key uuid,p_lease uuid)
returns uuid[] language plpgsql security definer set search_path=pg_catalog as $$ begin
  perform app.lock_top_artwork_saved_preparation(p_ref);
  return app.claim_top_artwork_batch_saved_v1(p_ref,p_owner,p_session,p_context,p_revision,p_key,p_lease);
end $$;
create function app.complete_top_artwork_batch(p_ref uuid,p_owner bigint,p_session bigint,p_context text,
  p_revision bigint,p_key uuid,p_lease uuid,p_results jsonb,p_pngs bytea[])
returns void language plpgsql security definer set search_path=pg_catalog as $$ begin
  perform app.lock_top_artwork_saved_preparation(p_ref);
  perform app.complete_top_artwork_batch_saved_v1(p_ref,p_owner,p_session,p_context,p_revision,p_key,p_lease,p_results,p_pngs);
end $$;

create function app.start_top_artwork_draft_preparation(p_ref uuid,p_top uuid,p_library bigint,p_owner bigint,
  p_session bigint,p_context text,p_revision bigint,p_key uuid,p_generation bigint,p_draft uuid,
  p_draft_revision bigint,p_baseline text,p_items jsonb)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare old app.album_top_artwork_preparations%rowtype; n integer; inc integer; reservation bigint;
  now_at timestamptz; issued timestamptz; baseline text; manifest text;
begin
  baseline:=app.top_artwork_draft_baseline(p_top,p_library,p_owner,p_revision);
  now_at:=clock_timestamp();
  if p_generation is null or p_generation<1 or p_generation>253402300799 then
    raise exception using errcode='23514',constraint='top_artwork_request_expired',message='Artwork request generation invalid';
  end if;
  issued:=to_timestamp(p_generation::double precision);
  if issued>now_at or issued+interval '60 minutes'<=now_at then
    raise exception using errcode='23514',constraint='top_artwork_request_expired',message='Artwork request generation expired';
  end if;
  if p_baseline is distinct from baseline or p_draft is null or p_draft='00000000-0000-0000-0000-000000000000'
      or p_draft_revision is null or p_draft_revision<1 or p_session is null or p_session<1
      or p_context is null or p_context !~ '^[0-9a-f]{64}$' or p_key is null
      or p_key='00000000-0000-0000-0000-000000000000' then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork draft invalid';
  end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>5000
      or octet_length(p_items::text)>4194304 then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork draft invalid';
  end if;
  -- Check JSON types and exact object shapes before record coercions. Integer
  -- textual spelling is bounded before bigint casts; strings and booleans fail.
  if exists(select 1 from jsonb_array_elements(p_items) x where case when jsonb_typeof(x)<>'object' then true else
      not(x ?& array['row_ref','row_kind','saved_item_ref','catalog_ref','position','selected_local_album_id',
                     'selected_source_ref','selected_library_root_id','included'])
      or x-array['row_ref','row_kind','saved_item_ref','catalog_ref','position','selected_local_album_id',
                 'selected_source_ref','selected_library_root_id','included']<>'{}'::jsonb
      or jsonb_typeof(x->'included') is distinct from 'boolean'
      or jsonb_typeof(x->'row_kind') is distinct from 'string'
      or (x->>'row_kind') not in ('existing','new_local')
      or jsonb_typeof(x->'row_ref') is distinct from 'string'
      or (x->>'row_ref') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (x->>'row_ref')='00000000-0000-0000-0000-000000000000'
      or jsonb_typeof(x->'catalog_ref') is distinct from 'string'
      or (x->>'catalog_ref') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(x->'selected_source_ref') is distinct from 'string'
      or (x->>'selected_source_ref') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or case when x->>'row_kind'='existing' then
          jsonb_typeof(x->'saved_item_ref') is distinct from 'string'
          or (x->>'saved_item_ref') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        else jsonb_typeof(x->'saved_item_ref') is distinct from 'null' end
      or jsonb_typeof(x->'position') is distinct from 'number' or (x->>'position') !~ '^[1-9][0-9]{0,3}$'
      or jsonb_typeof(x->'selected_local_album_id') is distinct from 'number'
      or (x->>'selected_local_album_id') !~ '^[1-9][0-9]{0,18}$'
      or jsonb_typeof(x->'selected_library_root_id') is distinct from 'number'
      or (x->>'selected_library_root_id') !~ '^[1-9][0-9]{0,18}$'
    end) then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork draft invalid';
  end if;
  if exists(select 1 from jsonb_array_elements(p_items) x where
      (x->>'selected_local_album_id')::numeric>9223372036854775807
      or (x->>'selected_library_root_id')::numeric>9223372036854775807) then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork draft invalid';
  end if;
  n:=jsonb_array_length(p_items);
  manifest:=encode(sha256(convert_to(jsonb_build_array('top-artwork-draft-manifest-v1',p_top,p_library,p_owner,
    p_session,p_context,p_revision,p_generation,p_draft,p_draft_revision,baseline,p_items)::text,'UTF8')),'hex');
  select * into old from app.album_top_artwork_preparations
    where owner_account_id=p_owner and library_id=p_library and start_request_key=p_key for update;
  if found then
    if (old.preparation_kind,old.top_ref,old.original_session_id,old.context_ref,old.top_revision,
        old.manifest_digest,old.request_generation,old.draft_ref,old.draft_revision,old.baseline_digest)
       is distinct from ('draft',p_top,p_session,p_context,p_revision,manifest,p_generation,p_draft,p_draft_revision,baseline) then
      raise exception using errcode='23514',constraint='top_artwork_request_conflict',message='Artwork request changed';
    end if;
    if old.state='cancelled' or old.expires_at<=clock_timestamp() then
      raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
    end if;
    return old.ref;
  end if;
  if exists(select 1 from app.album_top_artwork_preparations where top_ref=p_top and owner_account_id=p_owner
      and original_session_id=p_session and context_ref=p_context and draft_ref=p_draft and draft_revision=p_draft_revision) then
    raise exception using errcode='23514',constraint='top_artwork_request_conflict',message='Artwork draft revision already admitted';
  end if;
  if exists(select 1 from jsonb_array_elements(p_items) with ordinality as v(x,ord)
      where (x->>'position')::integer<>ord)
    or (select count(distinct x->>'row_ref') from jsonb_array_elements(p_items) x)<>n
    or (select count(distinct x->>'catalog_ref') from jsonb_array_elements(p_items) x)<>n
    or (select count(distinct x->>'saved_item_ref') from jsonb_array_elements(p_items) x where x->>'row_kind'='existing')<>
       (select count(*) from jsonb_array_elements(p_items) x where x->>'row_kind'='existing')
    or exists(select 1 from jsonb_to_recordset(p_items) as x(row_ref uuid,row_kind text,saved_item_ref uuid,
         catalog_ref uuid,position integer,selected_local_album_id bigint,selected_source_ref uuid,
         selected_library_root_id bigint,included boolean)
       left join app.album_list_items i on i.ref=x.saved_item_ref and i.top_ref=p_top
          and i.library_id=p_library and i.catalog_ref=x.catalog_ref
       left join library.album_metadata_sources s on s.ref=x.selected_source_ref and s.library_id=p_library
          and s.local_album_id=x.selected_local_album_id and s.library_root_id=x.selected_library_root_id
          and s.state='active' and s.capture_builder_version=1
       left join library.catalog_album_links c on c.library_id=p_library and c.local_album_id=x.selected_local_album_id
          and c.catalog_ref=x.catalog_ref
       left join library.library_roots r on r.id=x.selected_library_root_id and r.library_id=p_library and r.is_active
       where (x.row_kind='existing' and i.ref is null)
          or (x.row_kind='new_local' and exists(select 1 from app.album_list_items b where b.top_ref=p_top and b.catalog_ref=x.catalog_ref))
          or s.ref is null or c.catalog_ref is null or r.id is null) then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork draft invalid';
  end if;
  select count(*) into inc from jsonb_array_elements(p_items) x where x->'included'='true'::jsonb;
  reservation:=1024::bigint+inc::bigint*69632+(n-inc)::bigint*1024;
  perform 1 from app.album_top_artwork_preparations where top_ref=p_top and owner_account_id=p_owner
    and original_session_id=p_session and state in ('preparing','ready') order by ref for update;
  perform app.cleanup_top_artwork_preparations(p_top,p_library,p_owner,p_revision);
  perform app.lock_top_artwork_budgets(p_top,p_library,p_owner);
  if exists(select 1 from app.album_top_artwork_budgets where owner_account_id=p_owner
    and ((scope_ref=p_top and (preparation_count+1>64 or item_count+n>20000 or proof_bytes+reservation>536870912))
      or (scope_ref='00000000-0000-0000-0000-000000000000' and
        (preparation_count+1>256 or item_count+n>100000 or proof_bytes+reservation>4294967296)))) then
    raise exception using errcode='23514',constraint='top_artwork_retention_limit',message='Artwork staging limit reached';
  end if;
  update app.album_top_artwork_preparations set state='cancelled',lease_ref=null,lease_expires_at=null,
    batch_request_key=null,batch_from_revision=null,batch_items=null where top_ref=p_top
      and owner_account_id=p_owner and original_session_id=p_session and state in ('preparing','ready');
  insert into app.album_top_artwork_preparations(ref,top_ref,library_id,owner_account_id,original_session_id,
    context_ref,top_revision,start_request_key,manifest_digest,item_count,created_at,expires_at,state,
    request_generation,retained_item_count,preparation_kind,draft_ref,draft_revision,baseline_digest)
    values(p_ref,p_top,p_library,p_owner,p_session,p_context,p_revision,p_key,manifest,n,issued,
      issued+interval '60 minutes','preparing',p_generation,n,'draft',p_draft,p_draft_revision,baseline);
  insert into app.album_top_artwork_draft_items(preparation_ref,top_ref,library_id,owner_account_id,row_ref,
    row_kind,saved_item_ref,catalog_ref,position,selected_local_album_id,selected_source_ref,selected_library_root_id,included)
    select p_ref,p_top,p_library,p_owner,x.row_ref,x.row_kind,x.saved_item_ref,x.catalog_ref,x.position,
      x.selected_local_album_id,x.selected_source_ref,x.selected_library_root_id,x.included
      from jsonb_to_recordset(p_items) as x(row_ref uuid,row_kind text,saved_item_ref uuid,catalog_ref uuid,
        position integer,selected_local_album_id bigint,selected_source_ref uuid,selected_library_root_id bigint,included boolean);
  update app.album_top_artwork_budgets set preparation_count=preparation_count+1,item_count=item_count+n,
    proof_bytes=proof_bytes+reservation where owner_account_id=p_owner
      and scope_ref in ('00000000-0000-0000-0000-000000000000'::uuid,p_top);
  if issued+interval '60 minutes'<=clock_timestamp() then
    raise exception using errcode='23514',constraint='top_artwork_request_expired',message='Artwork request generation expired';
  end if;
  return p_ref;
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
    if not exists(select 1 from app.album_top_artwork_preparation_items where asset_ref=a.ref) then
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

revoke all on app.album_top_artwork_draft_items from public;
revoke all on function app.guard_top_artwork_draft_item(),
  app.top_artwork_draft_baseline(uuid,bigint,bigint,bigint),
  app.lock_top_artwork_saved_preparation(uuid),
  app.start_top_artwork_preparation_saved_v2(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb,bigint),
  app.claim_top_artwork_batch_saved_v1(uuid,bigint,bigint,text,bigint,uuid,uuid),
  app.complete_top_artwork_batch_saved_v1(uuid,bigint,bigint,text,bigint,uuid,uuid,jsonb,bytea[]),
  app.start_top_artwork_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb,bigint),
  app.claim_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid),
  app.complete_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,jsonb,bytea[]),
  app.start_top_artwork_draft_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,bigint,uuid,bigint,text,jsonb) from public;
do $$ declare role_name text; begin
  foreach role_name in array array['album_haven_app','album_haven_readonly'] loop
    if exists(select 1 from pg_catalog.pg_roles where rolname=role_name) then
      execute format('revoke all on app.album_top_artwork_draft_items from %I',role_name);
      execute format('revoke all on function app.guard_top_artwork_draft_item(),
        app.top_artwork_draft_baseline(uuid,bigint,bigint,bigint),app.lock_top_artwork_saved_preparation(uuid),
        app.start_top_artwork_preparation_saved_v2(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb,bigint),
        app.claim_top_artwork_batch_saved_v1(uuid,bigint,bigint,text,bigint,uuid,uuid),
        app.complete_top_artwork_batch_saved_v1(uuid,bigint,bigint,text,bigint,uuid,uuid,jsonb,bytea[]),
        app.start_top_artwork_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb,bigint),
        app.claim_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid),
        app.complete_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,jsonb,bytea[]),
        app.start_top_artwork_draft_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,bigint,uuid,bigint,text,jsonb) from %I',role_name);
    end if;
  end loop;
  if exists(select 1 from pg_catalog.pg_roles where rolname='album_haven_app') then
    grant select on app.album_top_artwork_draft_items to album_haven_app;
    grant execute on function app.top_artwork_draft_baseline(uuid,bigint,bigint,bigint),
      app.start_top_artwork_draft_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,bigint,uuid,bigint,text,jsonb),
      app.start_top_artwork_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb,bigint),
      app.claim_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid),
      app.complete_top_artwork_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,jsonb,bytea[]) to album_haven_app;
  end if;
end $$;
