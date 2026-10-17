-- Preserve the complete identity-lock phase without granting runtime catalog
-- UPDATE. The existing Python owner sorts every identity before any admission.
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    raise exception using errcode='42501',message='Remote identity locking requires a non-superuser migration owner';
  end if;
end $$;

create function app.lock_top_remote_catalog_identity(p_provider text,p_kind text,p_external text,p_catalog uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
begin
  if p_provider is distinct from 'musicbrainz' or p_kind is distinct from 'release-group'
      or p_external is null or octet_length(p_external)<>36
      or p_external !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or p_external='00000000-0000-0000-0000-000000000000' or p_catalog is null then
    return false;
  end if;
  -- The provider-tuple primary key bounds this fence to one exact mapping.
  -- No mapping, membership, authority, accounting or admission work occurs here.
  perform catalog_ref from catalog.release_group_provider_identities
    where provider=p_provider and entity_kind=p_kind and external_id=p_external and catalog_ref=p_catalog for share;
  return found;
end $$;

revoke all on function app.lock_top_remote_catalog_identity(text,text,text,uuid) from public;
do $$ declare role_name text; begin
  foreach role_name in array array['album_haven_readonly','album_haven_app'] loop
    if exists(select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on function app.lock_top_remote_catalog_identity(text,text,text,uuid) from %I',role_name);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    grant execute on function app.lock_top_remote_catalog_identity(text,text,text,uuid) to album_haven_app;
  end if;
end $$;
