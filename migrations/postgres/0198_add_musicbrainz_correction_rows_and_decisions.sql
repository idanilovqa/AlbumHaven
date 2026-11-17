-- depends on: 0197_add_musicbrainz_edition_track_order.sql
-- MusicBrainz Delivery 2, S4 rebuild (owner, 2026-11-16, "Data Correction flow"). Additive only.
--
-- Each difference between an album's tags and its certain release is stored as a row with its
-- kind. Trivial kinds (case, spacing, punctuation, accents, small edits) apply automatically;
-- edition suffixes, substantial title changes and artist changes wait for the owner. An album
-- where too many titles change substantially, or whose track pairing is ambiguous, goes to
-- review whole. "Applied" is display only until Bulk Correction (PR 53) writes tags; nothing
-- here writes media tags. The owner's undo, skip and approval decisions are remembered by
-- the exact change, so a refresh never applies an undone change again.
create table if not exists library.local_album_musicbrainz_correction_rows (
  id bigint generated always as identity primary key,
  library_id bigint not null,
  album_key text not null,
  field text not null check (field in ('album', 'album_artist', 'title', 'artist')),
  -- 0 for the album's own fields, else the local disc and track.
  disc_number integer not null default 0 check (disc_number >= 0),
  track_number integer not null default 0 check (track_number >= 0),
  current_value text not null,
  proposed_value text not null check (char_length(proposed_value) between 1 and 2048),
  kind text not null check (kind in (
    'case', 'spacing', 'case_spacing', 'punctuation', 'accents', 'small_edit', 'edition_suffix',
    'track_title', 'album_title', 'track_artist_renamed', 'track_artist_joined', 'album_artist_renamed',
    'album_artist_joined')),
  -- auto: applied without a click; review: waits for the owner.
  mode text not null check (mode in ('auto', 'review')),
  foreign key (library_id, album_key) references library.local_albums(library_id, album_key)
    on update cascade on delete cascade
);

create index if not exists local_album_musicbrainz_correction_rows_album_idx
  on library.local_album_musicbrainz_correction_rows (library_id, album_key);
create index if not exists local_album_musicbrainz_correction_rows_kind_idx
  on library.local_album_musicbrainz_correction_rows (library_id, mode, kind, album_key);

create table if not exists library.local_album_musicbrainz_correction_decisions (
  library_id bigint not null,
  album_key text not null,
  field text not null,
  disc_number integer not null default 0,
  track_number integer not null default 0,
  current_value text not null,
  proposed_value text not null,
  decision text not null check (decision in ('undone', 'skipped', 'approved')),
  decided_by_account_id bigint references app.accounts(id) on delete set null,
  decided_at timestamptz not null,
  primary key (library_id, album_key, field, disc_number, track_number, current_value, proposed_value),
  foreign key (library_id, album_key) references library.local_albums(library_id, album_key)
    on update cascade on delete cascade
);

-- The album's split, and whether it goes to review whole (the 30% guard or an ambiguous pairing).
alter table library.local_album_musicbrainz_corrections
  add column if not exists auto_count integer not null default 0 check (auto_count >= 0),
  add column if not exists review_count integer not null default 0 check (review_count >= 0),
  add column if not exists review_whole boolean not null default false;

-- Stored before rows existed: recompute every album once.
update library.local_album_musicbrainz_corrections set signature = 'recompute';

revoke all on table library.local_album_musicbrainz_correction_rows,
  library.local_album_musicbrainz_correction_decisions from public;
revoke all on sequence library.local_album_musicbrainz_correction_rows_id_seq from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table library.local_album_musicbrainz_correction_rows,
      library.local_album_musicbrainz_correction_decisions to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on table library.local_album_musicbrainz_correction_rows,
      library.local_album_musicbrainz_correction_decisions to album_haven_app;
    grant usage, select on sequence library.local_album_musicbrainz_correction_rows_id_seq to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update, delete on table library.local_album_musicbrainz_correction_rows,
      library.local_album_musicbrainz_correction_decisions to album_haven_migrator;
    grant usage, select on sequence library.local_album_musicbrainz_correction_rows_id_seq to album_haven_migrator;
  end if;
end $$;
