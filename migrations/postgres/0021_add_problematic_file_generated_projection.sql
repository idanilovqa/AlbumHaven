drop index if exists library.local_track_files_active_track_projection_idx;

create or replace function library.problematic_text_candidate(candidate_text text)
returns boolean
language sql
immutable
parallel safe
as $$
  select
    btrim(coalesce(candidate_text, '')) = '?'
    or position('??' in coalesce(candidate_text, '')) > 0
    or position(chr(65533) in coalesce(candidate_text, '')) > 0
    or position('пїѕ' in coalesce(candidate_text, '')) > 0
    or case
      when coalesce(candidate_text, '') !~ '[À-ÿ¨¸㐀-鿿]' then false
      else exists (
      select 1
      from unnest(array[
        'Ð', 'Ñ', 'Ã', 'Â', 'ÄÄ', 'ÄÅ', 'ÄÆ', 'ÄÇ', 'ÄÈ', 'ÄÉ', 'ÄÊ', 'ÄË',
        'ÄÌ', 'ÄÍ', 'ÄÎ', 'ÄÏ', 'ÄÒ', 'ÄÓ', 'Ýï', 'Þð', 'Øå', 'Ð°', 'Ñ‚',
        'Ñƒ', 'Ñ�', 'Ðµ', 'Ð¾', 'Ð¸', 'Ð½', 'Ð»', 'Ðº', 'Àë', 'Áå', 'Âî',
        'Ãî', 'Äå', 'Åë', 'Æè', 'Çà', 'Èë', 'Éî', 'Êð', 'Ëå', 'Ìî', 'Íà',
        'Îò', 'Ïî', 'Ðî', 'Ñë', 'Òå', 'Óñ', 'Ôå', 'Õî', 'Öå', '×å', 'Ùå',
        'Úå', 'Ûé', 'Üÿ', 'Ýò', 'ß ', 'àë', 'áå', 'âî', 'ãî', 'äå', 'åë',
        'æè', 'çà', 'èë', 'éî', 'êð', 'ëå', 'ìî', 'íà', 'îò', 'ïî', 'ðî',
        'ñë', 'òå', 'óñ', 'ôå', 'õî', 'öå', '÷å', 'øå', 'ùå', 'úå', 'ûé',
        'üÿ', 'ýò', 'þð'
      ]::text[]) as suspicious(marker)
      where position(suspicious.marker in coalesce(candidate_text, '')) > 0
      )
      or case
      when coalesce(candidate_text, '') !~ '[À-ÿ¨¸]' then false
      else (
        char_length(coalesce(candidate_text, ''))
          - char_length(translate(
              coalesce(candidate_text, ''),
              '¨¸ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ',
              ''
            ))
      ) >= 3
      and (
        char_length(coalesce(candidate_text, ''))
          - char_length(translate(
              coalesce(candidate_text, ''),
              '¨¸ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ',
              ''
            ))
      ) * 100 >= 45 * char_length(
        regexp_replace(coalesce(candidate_text, ''), '[^[:alpha:]À-ÿ¨¸]', '', 'g')
      )
      end
      or case
      when char_length(coalesce(candidate_text, '')) < 3 then false
      when coalesce(candidate_text, '') !~ '[㐀-鿿]' then false
      else 3 <= (
        select count(*)
        from regexp_split_to_table(coalesce(candidate_text, ''), '') as candidate_character(value)
        where ascii(candidate_character.value) between 13312 and 40959
          and mod(ascii(candidate_character.value), 256) = 0
          and (
            ascii(candidate_character.value) / 256 between 65 and 90
            or ascii(candidate_character.value) / 256 between 97 and 122
          )
      )
      end
    end;
$$;

revoke all on function library.problematic_text_candidate(text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.problematic_text_candidate(text) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant execute on function library.problematic_text_candidate(text) to album_haven_migrator;
  end if;
end;
$$;

alter table library.local_track_files
  add column if not exists scan_cache_stale boolean
    generated always as (
      lower(btrim(coalesce(metadata #>> '{scan_cache,stale}', ''))) in (
        'true', 't', 'yes', 'y', 'on', '1'
      )
    ) stored,
  add column if not exists scan_file_entry_is_object boolean
    generated always as (jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object') stored,
  add column if not exists scan_file_album text generated always as (
    case when jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object'
      then metadata #>> '{scan_cache,file_entry,album}' end
  ) stored,
  add column if not exists scan_file_album_artist text generated always as (
    case when jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object'
      then metadata #>> '{scan_cache,file_entry,album_artist}' end
  ) stored,
  add column if not exists scan_file_artist text generated always as (
    case when jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object'
      then metadata #>> '{scan_cache,file_entry,artist}' end
  ) stored,
  add column if not exists scan_file_title text generated always as (
    case when jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object'
      then metadata #>> '{scan_cache,file_entry,title}' end
  ) stored,
  add column if not exists scan_file_year text generated always as (
    case when jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object'
      then metadata #>> '{scan_cache,file_entry,year}' end
  ) stored,
  add column if not exists scan_file_track_number text generated always as (
    case when jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object'
      then metadata #>> '{scan_cache,file_entry,track_number}' end
  ) stored,
  add column if not exists scan_file_text_mojibake_candidate boolean
    generated always as (
      library.problematic_text_candidate(metadata #>> '{scan_cache,file_entry,album}')
      or library.problematic_text_candidate(metadata #>> '{scan_cache,file_entry,album_artist}')
      or library.problematic_text_candidate(metadata #>> '{scan_cache,file_entry,artist}')
      or library.problematic_text_candidate(metadata #>> '{scan_cache,file_entry,title}')
      or library.problematic_text_candidate(metadata #>> '{scan_cache,file_entry,year}')
      or library.problematic_text_candidate(metadata #>> '{scan_cache,file_entry,track_number}')
    ) stored,
  add column if not exists scan_file_metadata_problem_candidate boolean
    generated always as (
      lower(btrim(coalesce(metadata #>> '{scan_cache,file_entry,album}', '')))
        in ('unknown', 'unknown artist', 'unknown album', 'none', 'null')
      or lower(btrim(coalesce(metadata #>> '{scan_cache,file_entry,album_artist}', '')))
        in ('unknown', 'unknown artist', 'unknown album', 'none', 'null')
      or lower(btrim(coalesce(metadata #>> '{scan_cache,file_entry,artist}', '')))
        in ('unknown', 'unknown artist', 'unknown album', 'none', 'null')
      or lower(btrim(coalesce(metadata #>> '{scan_cache,file_entry,title}', '')))
        in ('unknown', 'unknown artist', 'unknown album', 'none', 'null')
      or case
        when metadata #> '{scan_cache,file_entry}' ? 'year' then
          nullif(btrim(coalesce(metadata #>> '{scan_cache,file_entry,year}', '')), '') is null
          or btrim(metadata #>> '{scan_cache,file_entry,year}') !~ '^[+-]?[0-9]+$'
          or case
            when btrim(metadata #>> '{scan_cache,file_entry,year}') ~ '^[+-]?[0-9]+$'
              then btrim(metadata #>> '{scan_cache,file_entry,year}')::numeric <= 0
            else false
          end
        else false
      end
      or case
        when metadata #> '{scan_cache,file_entry}' ? 'track_number' then
          nullif(btrim(coalesce(metadata #>> '{scan_cache,file_entry,track_number}', '')), '') is null
          or btrim(metadata #>> '{scan_cache,file_entry,track_number}') !~ '^[+-]?[0-9]+$'
          or case
            when btrim(metadata #>> '{scan_cache,file_entry,track_number}') ~ '^[+-]?[0-9]+$'
              then btrim(metadata #>> '{scan_cache,file_entry,track_number}')::numeric <= 0
            else false
          end
        else false
      end
    ) stored;

alter table library.local_tracks
  add column if not exists scan_title_problem_candidate boolean
    generated always as (
      lower(btrim(title)) in ('', 'unknown', 'unknown artist', 'unknown album', 'none', 'null')
      or btrim(title) = '?'
      or library.problematic_text_candidate(title)
    ) stored;

alter table library.local_artists
  add column if not exists scan_name_problem_candidate boolean
    generated always as (
      lower(btrim(name)) in ('', 'unknown', 'unknown artist', 'unknown album', 'none', 'null')
      or btrim(name) = '?'
      or library.problematic_text_candidate(name)
    ) stored;
