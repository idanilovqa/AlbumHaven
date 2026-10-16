-- Dormant staging retention only. No routes, public v2 or published cleanup.
-- All existing staging (including over-limit legacy usage) is accounted exactly.
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    raise exception using errcode='42501',message='Artwork retention requires a non-superuser migration owner';
  end if;
end $$;

-- Freeze admitted mutation while backfilling; migration runs atomically.
lock table app.album_top_artwork_preparations,app.album_top_artwork_preparation_items,
  app.album_top_artwork_assets,app.album_top_artwork_budgets in access exclusive mode;
alter table app.album_top_artwork_preparations
  add column request_generation bigint,
  add column retained_item_count integer not null default 0 check(retained_item_count between 0 and 5000);
update app.album_top_artwork_preparations p set
  request_generation=floor(extract(epoch from p.created_at))::bigint,
  retained_item_count=(select count(*) from app.album_top_artwork_preparation_items i where i.preparation_ref=p.ref);
alter table app.album_top_artwork_preparations alter column request_generation set not null;
alter table app.album_top_artwork_preparations alter column request_generation
  set default floor(extract(epoch from clock_timestamp()))::bigint;
alter table app.album_top_artwork_preparations add constraint top_artwork_request_generation
  check(request_generation between 1 and 253402300799);
alter table app.album_top_artwork_budgets
  add column preparation_count bigint not null default 0 check(preparation_count>=0),
  add column item_count bigint not null default 0 check(item_count>=0),
  add column proof_bytes bigint not null default 0 check(proof_bytes>=0),
  add column cleanup_asset_after uuid;
-- Limits are admission predicates, not backfill truncation or maximum CHECKs.
insert into app.album_top_artwork_budgets(owner_account_id,scope_ref)
  select distinct owner_account_id,'00000000-0000-0000-0000-000000000000'::uuid
  from app.album_top_artwork_preparations on conflict do nothing;
insert into app.album_top_artwork_budgets(owner_account_id,scope_ref,top_ref,library_id)
  select distinct owner_account_id,top_ref,top_ref,library_id
  from app.album_top_artwork_preparations on conflict do nothing;
with per_top as (
  select p.owner_account_id,p.top_ref,count(*)::bigint as headers,
    sum(p.retained_item_count)::bigint as items,
    sum(1024::bigint+coalesce((select sum(case when i.included then 69632::bigint else 1024::bigint end)
      from app.album_top_artwork_preparation_items i where i.preparation_ref=p.ref),0))::bigint as bytes
  from app.album_top_artwork_preparations p group by p.owner_account_id,p.top_ref
), amounts as (
  select owner_account_id,top_ref as scope_ref,headers,items,bytes from per_top
  union all
  select owner_account_id,'00000000-0000-0000-0000-000000000000'::uuid,
    sum(headers)::bigint,sum(items)::bigint,sum(bytes)::bigint from per_top group by owner_account_id
)
update app.album_top_artwork_budgets b set preparation_count=a.headers,item_count=a.items,proof_bytes=a.bytes
  from amounts a where b.owner_account_id=a.owner_account_id and b.scope_ref=a.scope_ref;

create index top_artwork_expiry_cleanup on app.album_top_artwork_preparations(top_ref,expires_at,ref);
create index top_artwork_cancelled_cleanup on app.album_top_artwork_preparations(top_ref,ref)
  where state='cancelled' and retained_item_count>0;
create index top_artwork_asset_scan on app.album_top_artwork_assets(top_ref,ref);
create index top_artwork_asset_references on app.album_top_artwork_preparation_items(asset_ref)
  where asset_ref is not null;

-- Only a SECURITY DEFINER cleanup transition can mint exact transaction permits.
-- No caller-supplied GUC, role switching, trigger disable or broad table privilege.
create table app.album_top_artwork_cleanup_permits (
  transaction_id bigint not null,
  backend_id integer not null,
  kind text not null check(kind in ('item','asset')),
  parent_ref uuid not null,
  row_ref uuid not null,
  primary key(transaction_id,backend_id,kind,parent_ref,row_ref)
);
revoke all on app.album_top_artwork_cleanup_permits from public;

create or replace function app.guard_top_artwork_asset() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  if TG_OP='DELETE' and exists(select 1 from app.album_top_artwork_cleanup_permits
      where transaction_id=txid_current() and backend_id=pg_backend_pid() and kind='asset'
        and parent_ref=OLD.top_ref and row_ref=OLD.ref)
     and not exists(select 1 from app.album_top_artwork_preparation_items where asset_ref=OLD.ref) then
    return OLD;
  end if;
  raise exception using errcode='55000',constraint='top_artwork_asset_immutable',message='Artwork asset is immutable';
end $$;
create or replace function app.guard_top_artwork_item() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  if TG_OP='DELETE' then
    if exists(select 1 from app.album_top_artwork_cleanup_permits
        where transaction_id=txid_current() and backend_id=pg_backend_pid() and kind='item'
          and parent_ref=OLD.preparation_ref and row_ref=OLD.item_ref)
       and exists(select 1 from app.album_top_artwork_preparations
          where ref=OLD.preparation_ref and state='cancelled') then return OLD; end if;
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

create function app.lock_top_artwork_budgets(p_top uuid,p_library bigint,p_owner bigint)
returns void language plpgsql security definer set search_path=pg_catalog as $$ begin
  insert into app.album_top_artwork_budgets(owner_account_id,scope_ref)
    values(p_owner,'00000000-0000-0000-0000-000000000000') on conflict do nothing;
  perform 1 from app.album_top_artwork_budgets where owner_account_id=p_owner
    and scope_ref='00000000-0000-0000-0000-000000000000' for update;
  insert into app.album_top_artwork_budgets(owner_account_id,scope_ref,top_ref,library_id)
    values(p_owner,p_top,p_top,p_library) on conflict do nothing;
  perform 1 from app.album_top_artwork_budgets where owner_account_id=p_owner and scope_ref=p_top for update;
end $$;

-- Keep the foundation's structural/source checks as a private subordinate.
-- Its old public runtime entry is removed: callers cannot bypass reservation.
alter function app.start_top_artwork_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb)
  rename to start_top_artwork_preparation_unmetered;
revoke all on function app.start_top_artwork_preparation_unmetered(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb) from public;

create function app.start_top_artwork_preparation(p_ref uuid,p_top uuid,p_library bigint,p_owner bigint,
  p_session bigint,p_context text,p_revision bigint,p_key uuid,p_digest text,p_items jsonb,p_generation bigint)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare old app.album_top_artwork_preparations%rowtype; n integer; included_count integer;
  reservation bigint; now_at timestamptz; issued timestamptz; result uuid;
begin
  perform app.lock_top_artwork_scope(p_top,p_library,p_owner,p_revision);
  now_at:=clock_timestamp();
  if p_generation is null or p_generation<1 or p_generation>253402300799 then
    raise exception using errcode='23514',constraint='top_artwork_request_expired',message='Artwork request generation invalid';
  end if;
  issued:=to_timestamp(p_generation::double precision);
  if issued>now_at or issued+interval '60 minutes'<=now_at then
    raise exception using errcode='23514',constraint='top_artwork_request_expired',message='Artwork request generation expired';
  end if;
  select * into old from app.album_top_artwork_preparations
    where owner_account_id=p_owner and library_id=p_library and start_request_key=p_key for update;
  if found then
    if (old.top_ref,old.original_session_id,old.context_ref,old.top_revision,old.manifest_digest,old.request_generation)
       is distinct from (p_top,p_session,p_context,p_revision,p_digest,p_generation) then
      raise exception using errcode='23514',constraint='top_artwork_request_conflict',message='Artwork request changed';
    end if;
    if old.state='cancelled' or old.expires_at<=now_at then
      raise exception using errcode='55000',constraint='top_artwork_preparation',message='Artwork preparation unavailable';
    end if;
    return old.ref;
  end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>5000
      or octet_length(p_items::text)>4194304 then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork manifest invalid';
  end if;
  -- jsonb_to_recordset can coerce strings such as "true" or "t" to SQL
  -- boolean. Reject those before counting, state selection or delegation.
  -- CASE keeps object-only operators away from scalar/array elements.
  if exists(select 1 from jsonb_array_elements(p_items) x where case
      when jsonb_typeof(x)<>'object' then true
      else jsonb_typeof(x->'included') is distinct from 'boolean'
        or not (x ?& array['item_ref','catalog_ref','position','selected_local_album_id',
                          'selected_source_ref','selected_library_root_id','included'])
        or x-array['item_ref','catalog_ref','position','selected_local_album_id',
                   'selected_source_ref','selected_library_root_id','included']<>'{}'::jsonb
      end) then
    raise exception using errcode='23514',constraint='top_artwork_manifest',message='Artwork manifest invalid';
  end if;
  n:=jsonb_array_length(p_items);
  select count(*) into included_count from jsonb_array_elements(p_items) x where x->'included'='true'::jsonb;
  reservation:=1024::bigint+included_count::bigint*69632+(n-included_count)::bigint*1024;
  -- The subordinate will cancel this at-most-one active predecessor. Lock it
  -- before cleanup/account budgets, retaining Top -> preparation -> budgets.
  perform 1 from app.album_top_artwork_preparations where top_ref=p_top
    and owner_account_id=p_owner and original_session_id=p_session and state in ('preparing','ready')
    order by ref for update;
  perform app.cleanup_top_artwork_preparations(p_top,p_library,p_owner,p_revision);
  perform app.lock_top_artwork_budgets(p_top,p_library,p_owner);
  if exists(select 1 from app.album_top_artwork_budgets where owner_account_id=p_owner
      and ((scope_ref=p_top and (preparation_count+1>64 or item_count+n>20000 or proof_bytes+reservation>536870912))
        or (scope_ref='00000000-0000-0000-0000-000000000000' and
           (preparation_count+1>256 or item_count+n>100000 or proof_bytes+reservation>4294967296)))) then
    raise exception using errcode='23514',constraint='top_artwork_retention_limit',message='Artwork staging limit reached';
  end if;
  if issued+interval '60 minutes'<=clock_timestamp() then
    raise exception using errcode='23514',constraint='top_artwork_request_expired',message='Artwork request generation expired';
  end if;
  result:=app.start_top_artwork_preparation_unmetered(p_ref,p_top,p_library,p_owner,p_session,
    p_context,p_revision,p_key,p_digest,p_items);
  update app.album_top_artwork_preparations set request_generation=p_generation,
    created_at=issued,expires_at=issued+interval '60 minutes',retained_item_count=n where ref=result;
  update app.album_top_artwork_budgets set preparation_count=preparation_count+1,
    item_count=item_count+n,proof_bytes=proof_bytes+reservation
    where owner_account_id=p_owner and scope_ref in ('00000000-0000-0000-0000-000000000000'::uuid,p_top);
  if issued+interval '60 minutes'<=clock_timestamp() then
    raise exception using errcode='23514',constraint='top_artwork_request_expired',message='Artwork request generation expired';
  end if;
  return result;
end $$;

create function app.cleanup_top_artwork_preparations(p_top uuid,p_library bigint,p_owner bigint,p_revision bigint)
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
    for i in select item_ref,included from app.album_top_artwork_preparation_items
        where preparation_ref=p.ref order by position limit (512-removed_items) loop
      insert into app.album_top_artwork_cleanup_permits values(txid_current(),pg_backend_pid(),'item',p.ref,i.item_ref);
      delete from app.album_top_artwork_preparation_items where preparation_ref=p.ref and item_ref=i.item_ref;
      delete from app.album_top_artwork_cleanup_permits where transaction_id=txid_current()
        and backend_id=pg_backend_pid() and kind='item' and parent_ref=p.ref and row_ref=i.item_ref;
      item_bytes:=case when i.included then 69632 else 1024 end;
      update app.album_top_artwork_preparations set retained_item_count=retained_item_count-1 where ref=p.ref;
      update app.album_top_artwork_budgets set item_count=item_count-1,proof_bytes=proof_bytes-item_bytes
        where owner_account_id=p_owner and scope_ref in ('00000000-0000-0000-0000-000000000000'::uuid,p_top);
      removed_items:=removed_items+1;
    end loop;
    if not exists(select 1 from app.album_top_artwork_preparation_items where preparation_ref=p.ref) then
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

-- PUBLIC/default grants and readonly access are explicitly removed. Runtime
-- retains SELECT-only staging plus bounded transitions; old unmetered start
-- and all trigger/permit/budget internals are not executable by runtime.
revoke all on function app.lock_top_artwork_budgets(uuid,bigint,bigint),
  app.start_top_artwork_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb,bigint),
  app.cleanup_top_artwork_preparations(uuid,bigint,bigint,bigint) from public;
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname='album_haven_readonly') then
    revoke all on app.album_top_artwork_cleanup_permits from album_haven_readonly;
    revoke all on function app.lock_top_artwork_budgets(uuid,bigint,bigint),
      app.start_top_artwork_preparation_unmetered(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb),
      app.start_top_artwork_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb,bigint),
      app.cleanup_top_artwork_preparations(uuid,bigint,bigint,bigint) from album_haven_readonly;
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname='album_haven_app') then
    revoke all on app.album_top_artwork_cleanup_permits from album_haven_app;
    revoke all on function app.lock_top_artwork_budgets(uuid,bigint,bigint),
      app.start_top_artwork_preparation_unmetered(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb) from album_haven_app;
    grant execute on function
      app.start_top_artwork_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb,bigint),
      app.cleanup_top_artwork_preparations(uuid,bigint,bigint,bigint) to album_haven_app;
  end if;
end $$;
