-- Additive: the frame map of an MP3 file (where each audio frame starts, its sample rate and its
-- gapless trim), one row per media file, read and written per key on a stream's first open. A
-- restart then reads one row instead of scanning the whole file. The row is valid only while the
-- file's size and modified time match; a changed file is scanned again and its row replaced.
-- Rows are derived from the file and hold no user choice. Rollback leaves the table unused.
create table if not exists library.mp3_stream_maps (
  media_path text primary key,
  size_bytes bigint not null,
  mtime_ns bigint not null,
  sample_rate integer not null,
  samples_per_frame integer not null,
  first_sample bigint not null,
  end_sample bigint not null,
  end_byte bigint not null,
  -- zlib-compressed little-endian uint32 sizes of each frame, after the first frame's offset.
  first_frame_offset bigint not null,
  frame_sizes bytea not null,
  updated_at timestamptz not null default now(),
  constraint mp3_stream_maps_path_check check (btrim(media_path) <> ''),
  constraint mp3_stream_maps_counts_check check (
    size_bytes >= 0 and sample_rate > 0 and samples_per_frame > 0
    and first_sample >= 0 and end_sample > first_sample and end_byte > first_frame_offset
  )
);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on library.mp3_stream_maps to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on library.mp3_stream_maps to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on library.mp3_stream_maps to album_haven_migrator;
  end if;
end $$;
