create table if not exists library.local_track_waveform_peaks (
  track_file_id bigint not null references library.local_track_files(id) on delete cascade,
  sample_count integer not null,
  analyzer_version text not null,
  file_size_bytes bigint not null,
  modified_at_ns bigint not null,
  content_signature text,
  left_peaks real[] not null,
  right_peaks real[] not null,
  updated_at timestamptz not null default now(),
  primary key (track_file_id, sample_count),
  constraint local_track_waveform_peaks_sample_count_check check (sample_count > 0),
  constraint local_track_waveform_peaks_left_cardinality_check check (
    cardinality(left_peaks) = sample_count
  ),
  constraint local_track_waveform_peaks_right_cardinality_check check (
    cardinality(right_peaks) = sample_count
  )
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update on table
      library.local_track_waveform_peaks
    to album_haven_app;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update on table
      library.local_track_waveform_peaks
    to album_haven_migrator;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table
      library.local_track_waveform_peaks
    to album_haven_readonly;
  end if;
end $$;
