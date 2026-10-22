-- Preserve the metadata clock contract; route each changed file to all
-- independently referenced track, root and source owners. No backfill or grants.
create or replace function library.invalidate_public_metadata_source()
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
      execute 'with changed as ('||rows_sql||'), targets as (
        select t.library_id from changed join library.local_tracks t on t.id=(r->>''track_id'')::bigint
        union all
        select r.library_id from changed c join library.library_roots r on r.id=(c.r->>''library_root_id'')::bigint
        union all
        select s.library_id from changed join library.album_metadata_sources s on s.ref=(r->>''metadata_source_ref'')::uuid
      ) select array_agg(distinct library_id order by library_id) from targets where library_id is not null' into ids;
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
