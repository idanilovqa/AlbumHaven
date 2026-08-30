alter table library.local_album_cover_candidate_snapshots
  add column if not exists automatic_improvement_candidate_id text;
