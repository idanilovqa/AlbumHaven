-- A file whose tags hold text the app displays corrected (an unreadable "??"
-- credit shown as the album artist, or UTF-8 bytes in a Latin-1 frame) is a
-- Problematic Files candidate until the correction is written into its tags.
-- The corrections are their own column so the summary never reads metadata.
alter table library.local_track_files
  add column if not exists scan_file_text_corrections jsonb
    generated always as (
      case when jsonb_typeof(metadata #> '{scan_cache,file_entry,text_corrections}') = 'object'
        then metadata #> '{scan_cache,file_entry,text_corrections}' end
    ) stored;
