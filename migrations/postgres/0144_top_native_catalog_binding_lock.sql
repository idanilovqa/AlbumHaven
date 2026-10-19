-- A details-source lock, not a grant of Top or Album authority. The service
-- proves the actual caller under the existing locked private transaction.
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    raise exception using errcode='42501',message='Top native binding locking requires a non-superuser migration owner';
  end if;
end $$;

create function app.lock_top_native_catalog_binding(p_top uuid,p_item uuid,p_library bigint,
                                                   p_revision bigint,p_catalog uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
begin
  if p_top is null or p_item is null or p_library is null or p_library<=0
      or p_revision is null or p_revision<=0 or p_catalog is null then
    return false;
  end if;
  -- Service already holds the Top lock. Recheck its exact tuple and acquire
  -- the catalog parent first. Incoming links need FK key-share on this parent,
  -- so they cannot make a unique local mapping ambiguous before commit.
  perform c.ref from catalog.release_groups c
    join app.album_list_items i on i.catalog_ref=c.ref
    join app.album_lists t on t.ref=i.top_ref
    where t.ref=p_top and t.library_id=p_library and t.revision=p_revision
      and t.deleted_at is null and i.ref=p_item and c.ref=p_catalog
    for update of c;
  if not found then return false; end if;
  -- Existing links cannot be deleted/remapped between the service's two reads.
  perform local_album_id from library.catalog_album_links
    where library_id=p_library and catalog_ref=p_catalog order by local_album_id for share;
  return true;
end $$;

revoke all on function app.lock_top_native_catalog_binding(uuid,uuid,bigint,bigint,uuid) from public;
do $$ declare role_name text; begin
  foreach role_name in array array['album_haven_readonly','album_haven_app'] loop
    if exists(select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on function app.lock_top_native_catalog_binding(uuid,uuid,bigint,bigint,uuid) from %I',role_name);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    grant execute on function app.lock_top_native_catalog_binding(uuid,uuid,bigint,bigint,uuid) to album_haven_app;
  end if;
end $$;
