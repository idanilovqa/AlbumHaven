-- Private, expiring draft choices. Source observations and saved originals stay immutable.
create unique index playlist_creation_entries_source_ref_idx
  on app.playlist_creation_entries(source_ref,ref);
create table app.playlist_local_match_receipts (
  source_ref uuid not null references app.playlist_creation_sources(ref) on delete cascade,
  entry_ref uuid not null,
  review_ref uuid not null unique,
  candidates jsonb not null check(jsonb_typeof(candidates)='array' and jsonb_array_length(candidates)<=8),
  chosen_review_ref uuid,
  chosen_candidate_ref uuid,
  chosen_track_id bigint check(chosen_track_id>0),
  chosen_evidence_digest text check(chosen_evidence_digest ~ '^[0-9a-f]{64}$'),
  primary key(source_ref,entry_ref),
  foreign key(source_ref,entry_ref) references app.playlist_creation_entries(source_ref,ref) on delete cascade,
  check ((chosen_review_ref is null and chosen_candidate_ref is null and chosen_track_id is null
          and chosen_evidence_digest is null)
      or (chosen_review_ref is not null and chosen_candidate_ref is not null and chosen_track_id is not null
          and chosen_evidence_digest is not null))
);
-- Only the server's current actor/session/source check can resolve these opaque receipts.
revoke all on app.playlist_local_match_receipts from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.playlist_local_match_receipts from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.playlist_local_match_receipts from album_haven_app;
    grant select,insert,update on app.playlist_local_match_receipts to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.playlist_local_match_receipts to album_haven_migrator;
  end if;
end $$;
