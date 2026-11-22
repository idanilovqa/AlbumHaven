-- depends on: 0258_invalidate_gallery_on_split_labels.sql
-- MusicBrainz Delivery 2, edits that go against MusicBrainz. Additive only, no backfill:
-- an exception, a rejection or a choice exists only because the user confirmed it.
--
-- A tag exception is a difference from the matched release that the user confirmed. Album
-- fields follow the album key; a track field follows its track row, so renumbering keeps it.
create table if not exists library.local_album_tag_exceptions (
  id bigint generated always as identity primary key,
  library_id bigint not null,
  album_key text not null,
  field text not null check (field in ('album', 'album_artist', 'title', 'artist')),
  local_track_id bigint references library.local_tracks(id) on delete cascade,
  user_value text not null check (char_length(user_value) <= 2048),
  musicbrainz_value text not null check (char_length(musicbrainz_value) between 1 and 2048),
  release_mbid uuid not null references integration.musicbrainz_releases(mbid) on delete restrict,
  created_by_account_id bigint references app.accounts(id) on delete set null,
  created_at timestamptz not null,
  foreign key (library_id, album_key) references library.local_albums(library_id, album_key)
    on update cascade on delete cascade,
  check ((field in ('album', 'album_artist')) = (local_track_id is null))
);

create unique index if not exists local_album_tag_exceptions_field_idx
  on library.local_album_tag_exceptions (library_id, album_key, field, coalesce(local_track_id, 0));
create index if not exists local_album_tag_exceptions_rules_idx
  on library.local_album_tag_exceptions (library_id, created_at desc, id desc);
create index if not exists local_album_tag_exceptions_track_idx
  on library.local_album_tag_exceptions (local_track_id) where local_track_id is not null;

-- What an album was unlinked from. The edition is absent when only the group was matched.
create table if not exists library.local_album_release_rejections (
  id bigint generated always as identity primary key,
  library_id bigint not null,
  album_key text not null,
  release_group_mbid uuid not null references integration.musicbrainz_release_groups(mbid) on delete restrict,
  release_mbid uuid references integration.musicbrainz_releases(mbid) on delete restrict,
  rejected_by_account_id bigint references app.accounts(id) on delete set null,
  rejected_at timestamptz not null,
  foreign key (library_id, album_key) references library.local_albums(library_id, album_key)
    on update cascade on delete cascade
);

create unique index if not exists local_album_release_rejections_release_idx
  on library.local_album_release_rejections (
    library_id, album_key, release_group_mbid,
    coalesce(release_mbid, '00000000-0000-0000-0000-000000000000'::uuid));

-- The dialog's answer for one save, so finishing that save after a crash applies the same answer.
create table if not exists ops.tag_edit_match_choices (
  intent_id uuid primary key references library.tag_edit_intents(id) on delete cascade,
  choice text not null check (choice in ('continue', 'unlink')),
  chosen_by_account_id bigint references app.accounts(id) on delete set null,
  chosen_at timestamptz not null
);

revoke all on table library.local_album_tag_exceptions, library.local_album_release_rejections,
  ops.tag_edit_match_choices from public;
revoke all on sequence library.local_album_tag_exceptions_id_seq,
  library.local_album_release_rejections_id_seq from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table library.local_album_tag_exceptions, library.local_album_release_rejections
      to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on table library.local_album_tag_exceptions,
      library.local_album_release_rejections to album_haven_app;
    grant select, insert on table ops.tag_edit_match_choices to album_haven_app;
    grant usage, select on sequence library.local_album_tag_exceptions_id_seq,
      library.local_album_release_rejections_id_seq to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update, delete on table library.local_album_tag_exceptions,
      library.local_album_release_rejections to album_haven_migrator;
    grant select, insert on table ops.tag_edit_match_choices to album_haven_migrator;
    grant usage, select on sequence library.local_album_tag_exceptions_id_seq,
      library.local_album_release_rejections_id_seq to album_haven_migrator;
  end if;
end $$;
