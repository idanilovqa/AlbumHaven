create table if not exists app.saved_loop_waveform_peaks (
  saved_loop_id bigint not null references app.saved_loops(id) on delete cascade,
  sample_count integer not null,
  analyzer_version text not null,
  file_size_bytes bigint not null,
  modified_at_ns bigint not null,
  left_peaks real[] not null,
  right_peaks real[] not null,
  updated_at timestamptz not null default now(),
  primary key (saved_loop_id, sample_count),
  constraint saved_loop_waveform_peaks_sample_count_check check (sample_count > 0),
  constraint saved_loop_waveform_peaks_left_cardinality_check check (
    cardinality(left_peaks) = sample_count
  ),
  constraint saved_loop_waveform_peaks_right_cardinality_check check (
    cardinality(right_peaks) = sample_count
  )
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on table
      app.saved_loop_waveform_peaks
    to album_haven_app;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update, delete on table
      app.saved_loop_waveform_peaks
    to album_haven_migrator;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table
      app.saved_loop_waveform_peaks
    to album_haven_readonly;
  end if;
end $$;
