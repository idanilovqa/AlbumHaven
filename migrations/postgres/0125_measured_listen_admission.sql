-- Dormant private decoder-instance telemetry. No route/decoder activation.
-- No FK to listen_history: partial evidence does not require an ordinary listen.
create table integration.measured_listen_admission (
    decoder_instance_id uuid primary key,
    account_id bigint not null references app.accounts(id) on delete cascade,
    original_library_id bigint not null check (original_library_id > 0),
    original_track_id bigint not null check (original_track_id > 0),
    original_file_id bigint not null check (original_file_id > 0),
    live_library_id bigint references library.libraries(id) on delete set null,
    live_track_id bigint references library.local_tracks(id) on delete set null,
    live_file_id bigint references library.local_track_files(id) on delete set null,
    device_id uuid not null,
    session_id uuid not null,
    evidence_version text not null check (evidence_version = 'rendered-position-histogram-v1'),
    sample_rate integer not null check (sample_rate between 8000 and 192000),
    admitted_at timestamptz not null,
    current_admission jsonb not null check (jsonb_typeof(current_admission) = 'object'),
    lifecycle_state text not null check (lifecycle_state in ('open', 'retired')),
    retirement_reason text check (retirement_reason in ('eos', 'cancelled', 'replaced', 'shutdown', 'error', 'source_changed')),
    retired_at timestamptz,
    accepted_checkpoint jsonb,
    accepted_admission jsonb,
    accepted_digest text,
    accepted_sequence bigint check (accepted_sequence between 0 and 9007199254740991),
    receipt_body text,
    receipt_status integer,
    accepted_at timestamptz,
    constraint admission_live_identity check (
        (live_library_id is null or live_library_id = original_library_id)
        and (live_track_id is null or live_track_id = original_track_id)
        and (live_file_id is null or live_file_id = original_file_id)),
    constraint admission_metadata_shape check (
        current_admission ?& array['metadata_revision','observed_intervals','extent_state',
                                   'verified_total_frames','extent_provenance','admission_limited']
        and current_admission - array['metadata_revision','observed_intervals','extent_state',
                                      'verified_total_frames','extent_provenance','admission_limited'] = '{}'::jsonb
        and jsonb_typeof(current_admission->'metadata_revision') = 'number'
        and current_admission->>'metadata_revision' ~ '^(0|[1-9][0-9]*)$'
        and (current_admission->>'metadata_revision')::numeric between 0 and 9007199254740991
        and jsonb_typeof(current_admission->'observed_intervals') = 'array'
        and jsonb_array_length(current_admission->'observed_intervals') between 1 and 4096
        and jsonb_typeof(current_admission->'admission_limited') = 'boolean'
        and jsonb_typeof(current_admission->'extent_state') = 'string'
        and ((current_admission->>'extent_state' = 'observed_partial'
              and current_admission->'verified_total_frames' = 'null'::jsonb
              and current_admission->'extent_provenance' = 'null'::jsonb)
             or (current_admission->>'extent_state' = 'verified_complete'
                 and jsonb_typeof(current_admission->'verified_total_frames') = 'number'
                 and current_admission->>'verified_total_frames' ~ '^[1-9][0-9]*$'
                 and (current_admission->>'verified_total_frames')::numeric between 1 and 9007199254740991
                 and jsonb_typeof(current_admission->'extent_provenance') = 'string'
                 and current_admission->>'extent_provenance' = 'successful_from_zero_decode'
                 and lifecycle_state = 'retired' and retirement_reason = 'eos'))),
    constraint admission_nonzero_uuids check (
        decoder_instance_id <> '00000000-0000-0000-0000-000000000000'::uuid
        and device_id <> '00000000-0000-0000-0000-000000000000'::uuid
        and session_id <> '00000000-0000-0000-0000-000000000000'::uuid),
    constraint admission_lifecycle_shape check (
        (lifecycle_state = 'open' and retirement_reason is null and retired_at is null)
        or (lifecycle_state = 'retired' and retirement_reason is not null and retired_at is not null)),
    constraint admission_accepted_shape check (
        (accepted_checkpoint is null and accepted_admission is null and accepted_digest is null
         and accepted_sequence is null and receipt_body is null and receipt_status is null and accepted_at is null)
        or (accepted_checkpoint is not null and jsonb_typeof(accepted_checkpoint) = 'object'
            and accepted_admission is not null and jsonb_typeof(accepted_admission) = 'object'
            and accepted_digest is not null and accepted_digest ~ '^[0-9a-f]{64}$'
            and accepted_sequence is not null and receipt_body is not null
            and octet_length(receipt_body) <= 8192 and receipt_status is not null
            and receipt_status = 200 and accepted_at is not null)),
    constraint admission_json_size check (
        octet_length(current_admission::text) <= 262144
        and (accepted_admission is null or octet_length(accepted_admission::text) <= 262144)
        and (accepted_checkpoint is null or octet_length(accepted_checkpoint::text) <= 262144)),
    constraint admission_time_order check (
        (retired_at is null or retired_at >= admitted_at)
        and (accepted_at is null or accepted_at >= admitted_at))
);
create index measured_listen_admission_group_idx on integration.measured_listen_admission
    (account_id, original_library_id, device_id, session_id, admitted_at, decoder_instance_id);

-- 0001's default privileges are broad. This table is deliberately private.
revoke all on integration.measured_listen_admission from public;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
        revoke all on integration.measured_listen_admission from album_haven_readonly;
    end if;
    if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
        revoke all on integration.measured_listen_admission from album_haven_app;
        grant select, insert on integration.measured_listen_admission to album_haven_app;
        grant update (current_admission, lifecycle_state, retirement_reason, retired_at,
                      accepted_checkpoint, accepted_admission, accepted_digest,
                      accepted_sequence, receipt_body, receipt_status, accepted_at)
            on integration.measured_listen_admission to album_haven_app;
    end if;
end $$;
