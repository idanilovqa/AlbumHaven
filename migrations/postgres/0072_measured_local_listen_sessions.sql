alter table integration.listen_history
    add column device_id uuid,
    add column session_id uuid,
    add column measurement_version text,
    add column measured_listened_seconds double precision,
    add column max_measured_contiguous_seconds double precision,
    add column last_sequence bigint,
    add column finalized boolean,
    add constraint measured_local_listen_shape check (
        (measurement_version is null and device_id is null and session_id is null
         and measured_listened_seconds is null and max_measured_contiguous_seconds is null
         and last_sequence is null and finalized is null)
        or (measurement_version = 'rendered-pcm-v1'
            and account_id is not null and library_id is not null and track_id is not null
            and device_id is not null and session_id is not null
            and measured_listened_seconds is not null and max_measured_contiguous_seconds is not null
            and last_sequence is not null
            and measured_listened_seconds >= 0 and measured_listened_seconds < 'Infinity'::float8
            and max_measured_contiguous_seconds >= 0
            and max_measured_contiguous_seconds <= measured_listened_seconds
            and last_sequence >= 0 and finalized is not null)
    );
create unique index measured_local_listen_identity
    on integration.listen_history(account_id, library_id, device_id, session_id)
    where measurement_version = 'rendered-pcm-v1';
