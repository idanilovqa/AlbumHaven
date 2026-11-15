-- Expand only. Full bootstrap publishes the initial membership; edits patch keys.
create table library.gallery_membership_headers (
  library_id bigint not null references library.gallery_projection_state(library_id) on delete cascade,
  scope_key text not null check (scope_key ~ '^[0-9a-f]{64}$'),
  source_generation bigint not null,
  builder_version text not null,
  revision text not null check (revision ~ '^[0-9a-f]{64}$'),
  view_state jsonb not null,
  album_count bigint not null check (album_count >= 0),
  occurrence_count bigint not null check (occurrence_count >= 0),
  primary key (library_id, scope_key)
);
create table library.gallery_membership_entries (
  library_id bigint not null,
  scope_key text not null,
  artist_id text not null,
  album_key text not null,
  artist_sort text[] collate "C" not null,
  artist_display text not null,
  album_year integer not null,
  album_sort text collate "C" not null,
  payload jsonb not null,
  primary key (library_id, scope_key, artist_id, album_key),
  foreign key (library_id, scope_key) references library.gallery_membership_headers on delete cascade
);
create index gallery_membership_album_idx on library.gallery_membership_entries(library_id, scope_key, album_key);
create index gallery_membership_order_idx on library.gallery_membership_entries
  (library_id, scope_key, artist_sort, artist_id collate "C", album_year, album_sort, album_key collate "C");
create table library.gallery_membership_artists (
  library_id bigint not null,
  scope_key text not null,
  artist_id text not null,
  artist_sort text[] collate "C" not null,
  artist_name text not null,
  artist_display text not null,
  occurrence_count bigint not null check (occurrence_count > 0),
  primary key (library_id, scope_key, artist_id),
  foreign key (library_id, scope_key) references library.gallery_membership_headers on delete cascade
);
create index gallery_membership_artist_order_idx on library.gallery_membership_artists
  (library_id, scope_key, artist_sort, artist_id collate "C");

-- Old readers require contiguous ordinals and a complete immutable revision.
-- This compatibility copy touches cached membership, never source tracks/files.
create function library.bridge_gallery_membership(target_library_id bigint, target_scope_key text)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare
  header library.gallery_membership_headers%rowtype;
  old_revision text;
  sidebar jsonb;
begin
  select * into strict header from library.gallery_membership_headers
    where library_id=target_library_id and scope_key=target_scope_key;
  select revision into old_revision from library.gallery_projection_snapshots
    where library_id=target_library_id and scope_key=target_scope_key;
  if old_revision=header.revision then
    update library.gallery_projection_snapshots set source_generation=header.source_generation
      where library_id=target_library_id and scope_key=target_scope_key;
    return;
  end if;
  insert into library.gallery_projection_occurrences
    (library_id,scope_key,revision,ordinal,payload,staged_at)
    select target_library_id,target_scope_key,header.revision,
      row_number() over(order by artist_sort,artist_id collate "C",album_year,album_sort,album_key collate "C")-1,
      payload,now()
    from library.gallery_membership_entries
    where library_id=target_library_id and scope_key=target_scope_key
    on conflict (library_id,scope_key,revision,ordinal) do update
      set payload=excluded.payload,staged_at=excluded.staged_at;
  select coalesce(jsonb_agg(jsonb_build_object('artist',artist_name,
      'artist_display',artist_display,'count',occurrence_count)
      order by artist_sort,artist_id collate "C"),'[]'::jsonb) into sidebar
    from library.gallery_membership_artists
    where library_id=target_library_id and scope_key=target_scope_key;
  insert into library.gallery_projection_snapshots
    (library_id,scope_key,source_generation,builder_version,revision,sidebar,album_count,occurrence_count)
    values(target_library_id,target_scope_key,header.source_generation,header.builder_version,
      header.revision,sidebar,header.album_count,header.occurrence_count)
    on conflict(library_id,scope_key) do update set
      source_generation=excluded.source_generation,builder_version=excluded.builder_version,
      revision=excluded.revision,sidebar=excluded.sidebar,album_count=excluded.album_count,
      occurrence_count=excluded.occurrence_count;
  delete from library.gallery_projection_occurrences
    where library_id=target_library_id and scope_key=target_scope_key
      and revision<>header.revision and staged_at<clock_timestamp()-interval '5 minutes';
end;
$$;
revoke all on function library.bridge_gallery_membership(bigint,text) from public;

create function library.patch_gallery_membership(
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
  insert into library.gallery_membership_artists
    (library_id,scope_key,artist_id,artist_sort,artist_name,artist_display,occurrence_count)
    select target_library_id,target_scope_key,entry.artist_id,entry.artist_sort,
      min(entry.payload->>'artist_name'),min(entry.artist_display),count(*)
    from library.gallery_membership_entries entry
    where entry.library_id=target_library_id and entry.scope_key=target_scope_key
      and entry.artist_id=any(affected_artists)
    group by entry.artist_id,entry.artist_sort;
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
revoke all on library.gallery_membership_headers,library.gallery_membership_entries,library.gallery_membership_artists from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on library.gallery_membership_headers,library.gallery_membership_entries,library.gallery_membership_artists from album_haven_app;
    revoke all on function library.bridge_gallery_membership(bigint,text) from album_haven_app;
    grant select on library.gallery_membership_headers,library.gallery_membership_entries,library.gallery_membership_artists to album_haven_app;
    grant execute on function library.patch_gallery_membership(bigint,text,bigint,bigint,text,text,jsonb,text[],jsonb) to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on library.gallery_membership_headers,library.gallery_membership_entries,library.gallery_membership_artists from album_haven_readonly;
    revoke all on function library.bridge_gallery_membership(bigint,text),library.patch_gallery_membership(bigint,text,bigint,bigint,text,text,jsonb,text[],jsonb) from album_haven_readonly;
    grant select on library.gallery_membership_headers,library.gallery_membership_entries,library.gallery_membership_artists to album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on library.gallery_membership_headers,library.gallery_membership_entries,library.gallery_membership_artists to album_haven_migrator;
    grant execute on function library.patch_gallery_membership(bigint,text,bigint,bigint,text,text,jsonb,text[],jsonb) to album_haven_migrator;
  end if;
end $$;
