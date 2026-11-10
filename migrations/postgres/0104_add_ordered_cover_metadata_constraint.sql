-- Structural protection only. Python owns UUID interpretation, URL/path
-- normalization, normalized-source uniqueness and source authorization.
-- Do not backfill selections or infer manual ownership from legacy artwork.
create or replace function library.valid_selected_cover_metadata(metadata jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = pg_catalog
as $$
declare
  item jsonb;
  field record;
  receipt jsonb;
  source jsonb;
  ids jsonb[] := array[]::jsonb[];
  sources jsonb[] := array[]::jsonb[];
  value text;
  -- Match Python str.strip() after excluding C0 and DEL, independent of locale.
  whitespace constant text := E' \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
  controls constant text := '[' || chr(1) || '-' || chr(31) || chr(127) || ']';
begin
  -- A key in an array or scalar is not a saved selection. Orphan revision and
  -- receipt keys have always been legacy metadata when the list is absent.
  if jsonb_typeof(metadata) is distinct from 'object'
     or not metadata ? 'selected_covers' then
    return true;
  end if;
  if jsonb_typeof(metadata->'selected_covers') is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(metadata->'selected_covers') not between 1 and 3
     or jsonb_typeof(metadata->'selected_covers_revision') is distinct from 'number'
     or (metadata->>'selected_covers_revision') collate "C" !~ '^[0-9]+$' then
    return false;
  end if;

  for item in select element from jsonb_array_elements(metadata->'selected_covers') as covers(element) loop
    if jsonb_typeof(item) is distinct from 'object'
       or not item ?& array['selection_id', 'kind'] then
      return false;
    end if;
    if (item->>'kind') collate "C" = 'local' then
      if not item ? 'path' or item - array['selection_id', 'kind', 'path'] <> '{}'::jsonb then
        return false;
      end if;
      source := jsonb_build_array('local', item->'path');
    elsif (item->>'kind') collate "C" = 'remote' then
      if not item ? 'url' or item - array[
        'selection_id', 'kind', 'url', 'thumbnail_url', 'source', 'source_label',
        'album_url', 'width', 'height', 'art_kind', 'art_label', 'candidate_id',
        'candidate_generation'
      ] <> '{}'::jsonb then
        return false;
      end if;
      source := jsonb_build_array('remote', item->'url');
      if item ? 'art_kind' and (item->>'art_kind') collate "C" not in ('cover', 'other') then
        return false;
      end if;
    else
      return false;
    end if;

    for field in select * from jsonb_each(item) loop
      if field.key collate "C" in ('width', 'height')
         or (field.key collate "C" = 'candidate_generation' and jsonb_typeof(field.value) = 'number') then
        -- No bigint cast: the persisted Python contract has no integer ceiling.
        -- JSONB preserves 1.0's scale, but may erase exponent syntax such as 1e0.
        if jsonb_typeof(field.value) is distinct from 'number'
           or (field.value #>> '{}') collate "C" !~ '^[0-9]+$' then
          return false;
        end if;
      else
        if jsonb_typeof(field.value) is distinct from 'string' then
          return false;
        end if;
        value := field.value #>> '{}';
        if value collate "C" ~ controls then
          return false;
        end if;
        if field.key collate "C" in ('selection_id', 'path', 'url', 'candidate_generation')
           and (value collate "C" = '' or value collate "C" <> btrim(value, whitespace)) then
          return false;
        end if;
      end if;
    end loop;

    -- Exact JSON string equality is locale independent. The application also
    -- rejects distinct spellings that normalize to the same source identity.
    if (item->'selection_id') = any(ids) or source = any(sources) then
      return false;
    end if;
    ids := array_append(ids, item->'selection_id');
    sources := array_append(sources, source);
  end loop;

  if metadata ? 'selected_covers_last_request' then
    receipt := metadata->'selected_covers_last_request';
    if jsonb_typeof(receipt) is distinct from 'object' then
      return false;
    end if;
    if not receipt ?& array['mutation_id', 'request_hash']
       or receipt - array['mutation_id', 'request_hash'] <> '{}'::jsonb then
      return false;
    end if;
    if jsonb_typeof(receipt->'mutation_id') is distinct from 'string'
       or jsonb_typeof(receipt->'request_hash') is distinct from 'string' then
      return false;
    end if;
    value := receipt->>'mutation_id';
    if value collate "C" = '' or value collate "C" <> btrim(value, whitespace)
       or value collate "C" ~ controls
       or length(receipt->>'request_hash') <> 64
       or (receipt->>'request_hash') collate "C" !~ '^[0-9a-f]{64}$' then
      return false;
    end if;
  end if;
  return true;
end;
$$;

revoke all on function library.valid_selected_cover_metadata(jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.valid_selected_cover_metadata(jsonb) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant execute on function library.valid_selected_cover_metadata(jsonb) to album_haven_migrator;
  end if;
end;
$$;

-- Existing malformed explicit lists stop validation. Never silently repair or
-- discard them. Apply in a controlled migration transaction before writers.
alter table library.local_albums
  drop constraint if exists local_albums_selected_cover_metadata_shape;
alter table library.local_albums
  add constraint local_albums_selected_cover_metadata_shape
  check (library.valid_selected_cover_metadata(metadata));
