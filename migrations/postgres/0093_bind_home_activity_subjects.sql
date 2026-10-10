-- Stop the application while upgrading its disposable read-receipt contract.
-- Receipt ownership remains the viewer; source ownership is explicit.
alter table app.activity_snapshots
  add column subject_account_id bigint references app.accounts(id) on delete cascade,
  add column audience text not null default 'own',
  add column relationship_revision bigint,
  add column subject_authority_fingerprint text,
  add column viewer_ledger_revision bigint;
update app.activity_snapshots set subject_account_id=account_id;
alter table app.activity_snapshots
  alter column subject_account_id set not null,
  add constraint activity_snapshot_subject_scope check (
    (audience='own' and subject_account_id=account_id
      and relationship_revision is null and subject_authority_fingerprint is null
      and viewer_ledger_revision is null)
    or (audience in ('friend','comparison') and subject_account_id<>account_id
      and relationship_revision is not null and relationship_revision>0 and subject_authority_fingerprint is not null
      and ((audience='friend' and viewer_ledger_revision is null)
        or (audience='comparison' and viewer_ledger_revision is not null and viewer_ledger_revision>=0)))
  );
drop index app.activity_snapshots_session_query_idx;
create index activity_snapshots_session_query_idx on app.activity_snapshots(
  account_id,session_id,library_id,subject_account_id,audience,kind,period,created_at desc,id desc);
alter table app.activity_snapshot_rows
  drop constraint activity_snapshot_rows_listen_count_check,
  add constraint activity_snapshot_rows_listen_count_check check (listen_count >= 0),
  add column resource_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(resource_ids)='array');
create unique index activity_snapshot_rows_public_id_idx
  on app.activity_snapshot_rows(snapshot_id,(payload->>'id')) where ordinal is not null;

-- Event IDs are global ledger identities. A viewer-owned friend/comparison
-- receipt can retain a subject's event without owning its source revision.
-- Builders hold ordered viewer/subject capture keys before beginning RR.
create or replace function app.home_activity_event_was_captured(p_library bigint, p_account bigint, p_event bigint)
returns boolean language plpgsql volatile security definer set search_path = pg_catalog as $$
begin
  if p_library is null or p_account is null then return false; end if;
  if current_setting('transaction_isolation') != 'read committed' then return true; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('home-activity:' || p_account::text,0)) then
    return true;
  end if;
  return exists(select 1 from app.activity_snapshot_events e
    join app.activity_snapshots s on s.id=e.snapshot_id
    where e.event_id=p_event and s.library_id=p_library
      and s.ready and s.expires_at>clock_timestamp());
end $$;
revoke all on function app.home_activity_event_was_captured(bigint,bigint,bigint) from public;
