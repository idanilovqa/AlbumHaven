-- Correct the saved completion implementation renamed by 0130. Its PL/pgSQL
-- asset variable "a" must not also name the relation in the publication sum.
-- CREATE OR REPLACE preserves the existing owner and private function ACL;
-- the public saved-kind fencing wrapper and all completion behavior stay intact.
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
  select coalesce(sum(asset_row.byte_length),0) into total_bytes from app.album_top_artwork_preparation_items i
    join app.album_top_artwork_assets asset_row on asset_row.ref=i.asset_ref where i.preparation_ref=p_ref;
  if total_bytes>134217728 then
    raise exception using errcode='23514',constraint='top_artwork_publication_budget',message='Artwork publication budget exceeded';
  end if;
  update app.album_top_artwork_preparations set revision=revision+1,
    state=case when exists(select 1 from app.album_top_artwork_preparation_items
      where preparation_ref=p_ref and status in ('pending','failed')) then 'preparing' else 'ready' end,
    completed_request_key=p_key,completed_from_revision=p_revision,lease_ref=null,lease_expires_at=null,
    batch_request_key=null,batch_from_revision=null,batch_items=null where ref=p_ref;
end $$;
