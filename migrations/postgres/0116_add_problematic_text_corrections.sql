-- Files whose tags hold text the app displays corrected (an unreadable "??"
-- credit shown as the album artist, or UTF-8 bytes in a Latin-1 frame). Each
-- is a Problematic Files candidate, and a pending "Write in tags" correction,
-- until its tags are corrected. A side table keeps local_track_files
-- unrewritten: the trigger follows every write of a file's scan entry.
create table if not exists library.local_track_file_text_corrections (
  track_file_id bigint primary key
    references library.local_track_files(id) on delete cascade,
  text_corrections jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function library.sync_local_track_file_text_corrections()
returns trigger
language plpgsql
as $$
declare
  corrections jsonb := new.metadata #> '{scan_cache,file_entry,text_corrections}';
begin
  if jsonb_typeof(corrections) = 'object' then
    insert into library.local_track_file_text_corrections (track_file_id, text_corrections)
    values (new.id, corrections)
    on conflict (track_file_id) do update
      set text_corrections = excluded.text_corrections, updated_at = now()
      where library.local_track_file_text_corrections.text_corrections is distinct from excluded.text_corrections;
  elsif tg_op = 'UPDATE' then
    delete from library.local_track_file_text_corrections where track_file_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists local_track_files_sync_text_corrections on library.local_track_files;
create trigger local_track_files_sync_text_corrections
  after insert or update of metadata on library.local_track_files
  for each row execute function library.sync_local_track_file_text_corrections();

-- No backfill: corrections first appear with reader version 7, whose upgrade
-- rewrites every scan entry after this trigger exists. A backfill would read
-- all file metadata while holding the trigger's write lock.

-- Corrections "Write in tags" already wrote. When undo restores the original
-- text the file's corrections match this record again, and the writer leaves
-- the user's undo in place instead of writing the correction a second time.
create table if not exists library.local_track_file_text_correction_writes (
  track_file_id bigint primary key
    references library.local_track_files(id) on delete cascade,
  text_corrections jsonb not null,
  written_at timestamptz not null default now()
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on library.local_track_file_text_corrections to album_haven_app;
    grant select, insert, update, delete on library.local_track_file_text_correction_writes to album_haven_app;
  end if;
end;
$$;
