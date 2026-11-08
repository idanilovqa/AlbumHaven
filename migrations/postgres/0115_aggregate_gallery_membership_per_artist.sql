-- A gallery membership patch aggregated artists by (artist_id, artist_sort)
-- into a table keyed by artist_id. When an artist's sort changed in the
-- patched albums but not in its other albums, the insert produced two rows for
-- one artist and the whole publication failed with a unique violation.
-- Only the artist aggregation changes; the rest of the function is unchanged.

create or replace function library.patch_gallery_membership(
  target_library_id bigint, target_scope_key text, expected_generation bigint,
  target_generation bigint, projection_builder_version text, content_revision text,
  scope_state jsonb, affected_album_keys text[], membership_rows jsonb
) returns boolean language plpgsql security definer set search_path = pg_catalog as $$
declare
  current_generation bigint;
  source_xid xid8;
  baseline library.gallery_membership_headers%rowtype;
  affected_artists text[];
  old_albums bigint;
  old_occurrences bigint;
  new_albums bigint;
  new_occurrences bigint;
  changed boolean;
begin
  if target_library_id is null or expected_generation is null or expected_generation < 0
     or target_generation is null or target_generation < expected_generation
     or target_scope_key is null or target_scope_key !~ '^[0-9a-f]{64}$'
     or content_revision is null or content_revision !~ '^[0-9a-f]{64}$'
     or btrim(coalesce(projection_builder_version,'')) = ''
     or octet_length(projection_builder_version) > 128
     or jsonb_typeof(scope_state) is distinct from 'object'
     or jsonb_typeof(membership_rows) is distinct from 'array'
     or (affected_album_keys is not null and (
       cardinality(affected_album_keys) not between 0 and 65536
       or exists(select 1 from unnest(affected_album_keys) key where key is null or btrim(key)='')))
     or jsonb_array_length(membership_rows) > 2000000
     or pg_column_size(membership_rows) > 268435456 then
    raise exception 'Invalid incremental gallery publication';
  end if;
  if exists (select 1 from jsonb_array_elements(membership_rows) item
      where jsonb_typeof(item) is distinct from 'object'
        or jsonb_typeof(item->'payload') is distinct from 'object'
        or jsonb_typeof(item->'artist_sort') is distinct from 'array'
        or coalesce(item->>'artist_id','') = '' or coalesce(item->>'album_key','') = ''
        or item->>'artist_id' is distinct from item#>>'{payload,artist_id}'
        or item->>'album_key' is distinct from item#>>'{payload,album_key}'
        or (affected_album_keys is not null and not (item->>'album_key' = any(affected_album_keys))))
     or exists (select 1 from jsonb_array_elements(membership_rows) item,
         lateral jsonb_object_keys(item->'payload') field
       where field not in ('artist_id','artist_name','artist_sort_name','album_id','album_key',
         'album_title','album_release_year','featured_kind','missing_album_key')) then
    raise exception 'Invalid gallery membership item';
  end if;
  if not exists (select 1 from library.libraries l join app.bootstrap_owners b
      on b.account_id=l.owner_account_id where b.owner_key='local-bootstrap-owner'
      and l.id=target_library_id and l.name='Local Library' and l.library_kind='local') then
    raise exception 'Gallery publication is outside bootstrap scope';
  end if;
  select generation, last_invalidation_xid into current_generation, source_xid
    from library.gallery_projection_state where library_id=target_library_id for update;
  if current_generation is distinct from target_generation then return false; end if;
  select * into baseline from library.gallery_membership_headers
    where library_id=target_library_id and scope_key=target_scope_key for update;
  if affected_album_keys is null then
    -- Full seed must represent committed source data, never a partial writer.
    if source_xid=pg_current_xact_id() then return false; end if;
    delete from library.gallery_membership_headers
      where library_id=target_library_id and scope_key=target_scope_key;
    insert into library.gallery_membership_headers values
      (target_library_id,target_scope_key,target_generation,projection_builder_version,
       content_revision,scope_state,0,0);
    old_albums := 0; old_occurrences := 0;
    changed := true;
  else
    if baseline.library_id is null or baseline.source_generation<>expected_generation
       or baseline.builder_version<>projection_builder_version
       or baseline.view_state<>scope_state then return false; end if;
    -- Detached-track edits can invalidate only the generation marker. Never
    -- acknowledge an empty scope while actual album work remains journaled.
    if cardinality(affected_album_keys)=0 and exists (
      select 1 from library.local_relation_dirty_albums where library_id=target_library_id
    ) then return false; end if;
    select count(distinct album_key),count(*) into old_albums,old_occurrences
      from library.gallery_membership_entries
      where library_id=target_library_id and scope_key=target_scope_key
        and album_key=any(affected_album_keys);
    select exists (
      (select artist_id,album_key,payload from library.gallery_membership_entries
        where library_id=target_library_id and scope_key=target_scope_key
          and album_key=any(affected_album_keys)
       except select item->>'artist_id',item->>'album_key',item->'payload'
         from jsonb_array_elements(membership_rows) item)
      union all
      (select item->>'artist_id',item->>'album_key',item->'payload'
         from jsonb_array_elements(membership_rows) item
       except select artist_id,album_key,payload from library.gallery_membership_entries
         where library_id=target_library_id and scope_key=target_scope_key
           and album_key=any(affected_album_keys))
    ) into changed;
    if not changed then
      update library.gallery_membership_headers set source_generation=target_generation
        where library_id=target_library_id and scope_key=target_scope_key;
      perform library.bridge_gallery_membership(target_library_id,target_scope_key);
      return true;
    end if;
  end if;
  select array_agg(distinct artist_id) into affected_artists from (
    select artist_id from library.gallery_membership_entries
      where library_id=target_library_id and scope_key=target_scope_key
        and album_key=any(affected_album_keys)
    union all select item->>'artist_id' from jsonb_array_elements(membership_rows) item
  ) affected;
  delete from library.gallery_membership_entries
    where library_id=target_library_id and scope_key=target_scope_key
      and album_key=any(affected_album_keys);
  insert into library.gallery_membership_entries
    (library_id,scope_key,artist_id,album_key,artist_sort,artist_display,album_year,album_sort,payload)
    select target_library_id,target_scope_key,item->>'artist_id',item->>'album_key',
      array(select jsonb_array_elements_text(item->'artist_sort')),
      item->>'artist_display',(item->>'album_year')::integer,item->>'album_sort',item->'payload'
    from jsonb_array_elements(membership_rows) item;
  select count(distinct item->>'album_key'),count(*) into new_albums,new_occurrences
    from jsonb_array_elements(membership_rows) item;
  delete from library.gallery_membership_artists
    where library_id=target_library_id and scope_key=target_scope_key
      and artist_id=any(affected_artists);
  -- One row per artist, as the primary key requires. A patch rewrites only the
  -- affected albums, so after a rename or re-normalization the artist's other
  -- albums can still carry the previous sort; grouping by sort as well emitted
  -- two rows for one artist. The patch's own identity is the current one.
  with incoming as (
    select distinct on (item->>'artist_id') item->>'artist_id' as artist_id,
      array(select jsonb_array_elements_text(item->'artist_sort')) as artist_sort,
      item->>'artist_display' as artist_display
    from jsonb_array_elements(membership_rows) item
    order by item->>'artist_id', item->>'album_key'
  )
  insert into library.gallery_membership_artists
    (library_id,scope_key,artist_id,artist_sort,artist_name,artist_display,occurrence_count)
    select target_library_id,target_scope_key,entry.artist_id,
      coalesce(incoming.artist_sort,min(entry.artist_sort)),
      min(entry.payload->>'artist_name'),
      coalesce(incoming.artist_display,min(entry.artist_display)),count(*)
    from library.gallery_membership_entries entry
    left join incoming on incoming.artist_id=entry.artist_id
    where entry.library_id=target_library_id and entry.scope_key=target_scope_key
      and entry.artist_id=any(affected_artists)
    group by entry.artist_id,incoming.artist_sort,incoming.artist_display;
  update library.gallery_membership_headers
    set source_generation=target_generation, revision=content_revision,
      album_count=album_count-old_albums+new_albums,
      occurrence_count=occurrence_count-old_occurrences+new_occurrences
    where library_id=target_library_id and scope_key=target_scope_key;
  perform library.bridge_gallery_membership(target_library_id,target_scope_key);
  return true;
end;
$$;

revoke all on function library.patch_gallery_membership(bigint,text,bigint,bigint,text,text,jsonb,text[],jsonb) from public;
