-- Private app-reported consumption. No v1 reader or strict-v2 activation.
create table integration.playback_capture_budget (
  id bigint generated always as identity primary key,
  account_id bigint unique references app.accounts(id) on delete cascade,
  is_global boolean not null default false,
  reserved_bytes bigint not null default 0 check (reserved_bytes >= 0),
  rate_tokens numeric not null default 8 check (rate_tokens between 0 and 8),
  rate_updated_at timestamptz not null default now(),
  check ((is_global and account_id is null) or (not is_global and account_id is not null))
);
create unique index playback_capture_one_global_budget
  on integration.playback_capture_budget (is_global) where is_global;
insert into integration.playback_capture_budget(is_global) values (true);

create table integration.playback_capture_session (
  id bigint generated always as identity primary key,
  account_id bigint references app.accounts(id) on delete set null,
  library_id bigint not null references library.libraries(id) on delete cascade,
  auth_session_guard text,
  device_uuid uuid,
  capture_uuid uuid,
  v1_session_uuid uuid,
  evidence_version text not null check (evidence_version='app-rendered-position-v1'),
  original_track_id bigint not null,
  original_file_id bigint not null,
  original_root_id bigint not null,
  original_album_id bigint,
  live_track_id bigint references library.local_tracks(id) on delete set null,
  live_album_id bigint references library.local_albums(id) on delete set null,
  disc_number integer,
  track_number integer,
  admitted_at timestamptz not null,
  last_activity_at timestamptz not null,
  last_sequence bigint not null default 0 check (last_sequence between 0 and 9007199254740991),
  accepted_known_frames bigint not null default 0 check (accepted_known_frames between 0 and 9007199254740991),
  accepted_lost_frames bigint not null default 0 check (accepted_lost_frames between 0 and 9007199254740991),
  last_known_ordinal_end bigint,
  last_known_output_end bigint,
  ordinal_start bigint,
  ordinal_end bigint,
  terminal_at timestamptz,
  terminal_reason text,
  has_gaps boolean not null default false,
  timing_unknown boolean not null default false,
  anchor_count integer not null default 0 check (anchor_count between 0 and 17282),
  reservation_bytes bigint not null check (reservation_bytes=256),
  account_budget_id bigint references integration.playback_capture_budget(id) on delete set null,
  check ((account_id is null and auth_session_guard is null and device_uuid is null
           and capture_uuid is null and v1_session_uuid is null)
         or (account_id is not null and auth_session_guard is not null
             and device_uuid is not null and capture_uuid is not null)),
  check ((terminal_at is null and terminal_reason is null) or
         (terminal_at is not null and terminal_reason in
          ('ended','stopped','track_change','owner_closed','capture_limit','transport_abandoned','error')))
);
create unique index playback_capture_owned_identity
  on integration.playback_capture_session(account_id,device_uuid,capture_uuid) where account_id is not null;
create index playback_capture_active_owner
  on integration.playback_capture_session(account_id,last_activity_at) where terminal_at is null;

create table integration.playback_capture_checkpoint (
  id bigint generated always as identity primary key,
  session_id bigint not null references integration.playback_capture_session(id) on delete cascade,
  sequence bigint not null check (sequence between 1 and 9007199254740991),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  evidence jsonb not null,
  accepted_at timestamptz not null,
  known_frames bigint not null check (known_frames >= 0),
  lost_frames bigint not null check (lost_frames >= 0),
  terminal boolean not null,
  terminal_reason text,
  receipt_status integer not null check (receipt_status=200),
  receipt_body jsonb not null,
  reservation_bytes bigint not null check (reservation_bytes >= 192),
  account_budget_id bigint references integration.playback_capture_budget(id) on delete set null,
  unique(session_id,sequence)
);

create table integration.playback_capture_anchor (
  id bigint generated always as identity primary key,
  session_id bigint not null references integration.playback_capture_session(id) on delete cascade,
  epoch bigint not null check (epoch between 1 and 9007199254740991),
  probe_id bigint not null check (probe_id between 1 and 9007199254740991),
  output_frame bigint not null check (output_frame between 0 and 9007199254740991),
  utc_lower_ms bigint,
  utc_upper_ms bigint,
  monotonic_probe_span_ms bigint not null check (monotonic_probe_span_ms >= 0),
  max_quantum_frames bigint not null check (max_quantum_frames > 0),
  quality text not null check (quality in ('unknown','bounded')),
  reservation_bytes bigint not null check (reservation_bytes=128),
  account_budget_id bigint references integration.playback_capture_budget(id) on delete set null,
  unique(session_id,epoch,probe_id),
  check ((quality='unknown' and utc_lower_ms is null and utc_upper_ms is null) or
         (quality='bounded' and utc_lower_ms is not null and utc_upper_ms is not null
          and utc_lower_ms <= utc_upper_ms and monotonic_probe_span_ms <= 250 and max_quantum_frames <= 2048))
);

create table integration.playback_capture_run (
  id bigint generated always as identity primary key,
  checkpoint_id bigint not null references integration.playback_capture_checkpoint(id) on delete cascade,
  run_index integer not null check (run_index between 0 and 255),
  source_start48 bigint not null check (source_start48 between 0 and 9007199254740991),
  frames bigint not null check (frames between 1 and 9007199254740991),
  output_start bigint not null check (output_start between 0 and 9007199254740991),
  ordinal_start bigint not null check (ordinal_start between 0 and 9007199254740991),
  epoch bigint not null check (epoch between 1 and 9007199254740991),
  anchor_before bigint,
  anchor_after bigint,
  quality text not null check (quality in ('unknown','bounded')),
  reservation_bytes bigint not null check (reservation_bytes=128),
  account_budget_id bigint references integration.playback_capture_budget(id) on delete set null,
  unique(checkpoint_id,run_index),
  check (source_start48+frames <= 9007199254740991 and output_start+frames <= 9007199254740991
         and ordinal_start+frames <= 9007199254740991)
);
-- Anchor references are local numeric probe IDs; repository checks same-parent,
-- same-epoch existence, including anchors inserted by this checkpoint.

create function integration.playback_capture_anonymize() returns trigger
language plpgsql as $$
begin
  if new.account_id is null then
    new.auth_session_guard := null;
    new.device_uuid := null;
    new.capture_uuid := null;
    new.v1_session_uuid := null;
    new.account_budget_id := null;
  end if;
  return new;
end;
$$;
create trigger playback_capture_anonymize_owner before update of account_id
  on integration.playback_capture_session for each row
  execute function integration.playback_capture_anonymize();

-- Every row carries its own exact reservation. No lookup of a deleted parent,
-- no recalculation from anonymized JSON, and no double credit during cascades.
-- An account's bucket is deleted with it; SET NULL drops all child linkage.
create function integration.playback_capture_release_charge() returns trigger
language plpgsql as $$
begin
  if old.account_budget_id is not null then
    update integration.playback_capture_budget
       set reserved_bytes=reserved_bytes-old.reservation_bytes
     where id=old.account_budget_id and not is_global;
  end if;
  update integration.playback_capture_budget
     set reserved_bytes=reserved_bytes-old.reservation_bytes where is_global;
  return old;
end;
$$;
create trigger playback_capture_session_release after delete on integration.playback_capture_session
  for each row execute function integration.playback_capture_release_charge();
create trigger playback_capture_checkpoint_release after delete on integration.playback_capture_checkpoint
  for each row execute function integration.playback_capture_release_charge();
create trigger playback_capture_run_release after delete on integration.playback_capture_run
  for each row execute function integration.playback_capture_release_charge();
create trigger playback_capture_anchor_release after delete on integration.playback_capture_anchor
  for each row execute function integration.playback_capture_release_charge();
