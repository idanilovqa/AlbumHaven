-- Durable user-owned offline source evidence; never a Top membership authority.
create table app.album_top_source_jobs (
  ref uuid primary key,
  actor_account_id bigint not null references app.accounts(id) on delete cascade,
  library_id bigint not null references library.libraries(id) on delete cascade,
  request_key uuid not null,
  command_digest text not null check (command_digest ~ '^[0-9a-f]{64}$'),
  source jsonb not null check (jsonb_typeof(source)='object' and octet_length(source::text)<=1048576),
  status text not null check (status in ('queued','running','completed','canceled','failed')),
  revision bigint not null check (revision>0),
  attempt_ref uuid,
  lease_until timestamptz,
  review_result jsonb check (jsonb_typeof(review_result)='object' and octet_length(review_result::text)<=4194304),
  error_code text check (error_code='source_processing_failed'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(actor_account_id,library_id,request_key),
  check ((status='running' and attempt_ref is not null and lease_until is not null) or
         (status<>'running' and attempt_ref is null and lease_until is null)),
  check (status<>'completed' or review_result is not null),
  check ((status='failed')=(error_code is not null))
);
create index album_top_source_jobs_owner_idx
  on app.album_top_source_jobs(actor_account_id,library_id,created_at desc,ref desc);

-- Immutable evidence and identity also hold for the application database role.
create function app.guard_album_top_source_job() returns trigger language plpgsql as $$
begin
  if (new.ref,new.actor_account_id,new.library_id,new.request_key,new.command_digest,
      new.source,new.created_at) is distinct from
     (old.ref,old.actor_account_id,old.library_id,old.request_key,old.command_digest,
      old.source,old.created_at) then
    raise exception 'source evidence is immutable' using errcode='23514';
  end if;
  if old.status='canceled' or
     (old.status='queued' and new.status not in ('running','canceled')) or
     (old.status='failed' and new.status not in ('running','canceled')) or
     (old.status='completed' and new.status<>'canceled') or
     new.revision<>old.revision+1 or
     (old.review_result is not null and new.review_result is distinct from old.review_result) then
    raise exception 'source job transition is invalid' using errcode='23514';
  end if;
  return new;
end $$;
create trigger album_top_source_job_guard before update on app.album_top_source_jobs
  for each row execute function app.guard_album_top_source_job();
revoke all on app.album_top_source_jobs from public;
revoke all on function app.guard_album_top_source_job() from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.album_top_source_jobs from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.album_top_source_jobs from album_haven_app;
    grant select,insert,update on app.album_top_source_jobs to album_haven_app;
  end if;
end $$;
