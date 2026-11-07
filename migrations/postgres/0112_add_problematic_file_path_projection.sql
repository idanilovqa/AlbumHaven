-- Derived, deterministic projections of existing path and tag columns.
-- Problematic Files previously re-evaluated these regular expressions for
-- every active file on every cold request (tens of seconds at library scale).
-- No user-owned value is read, inferred, promoted, or changed here.
alter table library.local_track_files
  add column if not exists scan_path_key_present boolean
    generated always as (library.local_path_key(private_path) <> '') stored,
  add column if not exists scan_physical_parent text
    generated always as (
      regexp_replace(
        case when library.local_path_style(private_path) = 'windows'
          then replace(library.local_path_key(private_path), chr(92), '/')
          else library.local_path_key(private_path) end,
        '/[^/]*$', ''
      )
    ) stored,
  add column if not exists scan_source_directory text
    generated always as (
      regexp_replace(replace(private_path, chr(92), '/'), '/[^/]*$', '')
    ) stored,
  add column if not exists scan_physical_album_container text
    generated always as (
      case when regexp_replace(
          regexp_replace(replace(private_path, chr(92), '/'), '/[^/]*$', ''),
          '^.*/', ''
        ) ~* '(^|[^[:alnum:]])(cd|disc|disk)[[:space:]]*[-_.]?[[:space:]]*[0-9]{1,2}([^[:alnum:]]|$)'
        then regexp_replace(
          regexp_replace(replace(private_path, chr(92), '/'), '/[^/]*$', ''),
          '/[^/]*$', ''
        )
        else regexp_replace(replace(private_path, chr(92), '/'), '/[^/]*$', '')
      end
    ) stored,
  add column if not exists scan_file_album_identity text
    generated always as (
      case when jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object'
        then library.duplicate_identity_text(
          nullif(lower(btrim(metadata #>> '{scan_cache,file_entry,album}')), '')
        )
      end
    ) stored;

-- Problematic Files reads this sparse projected membership classification on
-- every cold request; without an index each read scans every file's metadata.
create index if not exists local_track_files_membership_problem_idx
on library.local_track_files (id)
where scan_cache_stale is false
  and nullif(metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null;
