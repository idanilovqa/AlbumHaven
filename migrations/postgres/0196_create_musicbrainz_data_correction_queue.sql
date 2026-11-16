-- depends on: 0194_create_musicbrainz_lookup_queue.sql
-- MusicBrainz Delivery 2, S4: the Edits Queue. Additive only.
--
-- A data correction is an album whose tags differ from the release it certainly is
-- (library.local_album_musicbrainz_releases, state release). Problematic Files proposes it;
-- "Add to queue" keeps the owner's approved snapshot here until Bulk Correction writes it
-- through Edit Tags. Nothing here writes media tags. "Auto submit bulks" is stored per
-- library (one per server); when on, the queue is due hourly.
create table if not exists ops.musicbrainz_correction_queue (
  id bigint generated always as identity primary key,
  library_id bigint not null,
  album_key text not null,
  release_mbid uuid not null references integration.musicbrainz_releases(mbid) on delete restrict,
  -- [{"field", "label", "current", "proposed", "tracks": [{"disc_number", "track_number"}]}]
  corrections jsonb not null check (jsonb_typeof(corrections) = 'array' and jsonb_array_length(corrections) > 0),
  queued_by_account_id bigint references app.accounts(id) on delete set null,
  queued_at timestamptz not null,
  unique (library_id, album_key),
  foreign key (library_id, album_key) references library.local_albums(library_id, album_key)
    on update cascade on delete cascade
);

create table if not exists ops.musicbrainz_correction_settings (
  library_id bigint primary key references library.libraries(id) on delete cascade,
  auto_submit_bulks boolean not null default false,
  -- When the switch last changed: an hourly run counts from here.
  changed_at timestamptz not null,
  changed_by_account_id bigint references app.accounts(id) on delete set null
);

revoke all on table ops.musicbrainz_correction_queue, ops.musicbrainz_correction_settings from public;
revoke all on sequence ops.musicbrainz_correction_queue_id_seq from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table ops.musicbrainz_correction_queue, ops.musicbrainz_correction_settings
      to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on table ops.musicbrainz_correction_queue to album_haven_app;
    grant select, insert, update on table ops.musicbrainz_correction_settings to album_haven_app;
    grant usage, select on sequence ops.musicbrainz_correction_queue_id_seq to album_haven_app;
    -- The Edits Queue removes a waiting MusicBrainz lookup (S5's queue).
    grant delete on table ops.musicbrainz_lookup_requests to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update, delete on table ops.musicbrainz_correction_queue to album_haven_migrator;
    grant select, insert, update on table ops.musicbrainz_correction_settings to album_haven_migrator;
    grant usage, select on sequence ops.musicbrainz_correction_queue_id_seq to album_haven_migrator;
  end if;
end $$;
