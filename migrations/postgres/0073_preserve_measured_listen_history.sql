-- Historical listens survive the existing account/track ON DELETE SET NULL FKs.
-- Authenticated insertion still requires exact scope in the application service.
alter table integration.listen_history drop constraint measured_local_listen_shape;
alter table integration.listen_history add constraint measured_local_listen_shape check (
    (measurement_version is null and device_id is null and session_id is null
     and measured_listened_seconds is null and max_measured_contiguous_seconds is null
     and last_sequence is null and finalized is null)
    or (measurement_version = 'rendered-pcm-v1'
        and library_id is not null
        and device_id is not null and session_id is not null
        and measured_listened_seconds is not null and max_measured_contiguous_seconds is not null
        and last_sequence is not null
        and measured_listened_seconds >= 0 and measured_listened_seconds < 'Infinity'::float8
        and max_measured_contiguous_seconds >= 0
        and max_measured_contiguous_seconds <= measured_listened_seconds
        and last_sequence >= 0 and finalized is not null)
);

update integration.listen_history h set track_key = t.track_key
from library.local_tracks t
where h.measurement_version = 'rendered-pcm-v1' and h.track_key is null
  and t.id = h.track_id and t.library_id = h.library_id;
