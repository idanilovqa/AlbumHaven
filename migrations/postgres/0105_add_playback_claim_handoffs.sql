-- Single-use reload handoffs preserve one playback owner without persisting
-- the successor's renewable runtime claim token.
alter table app.playback_claims
add column pending_handoff_id uuid,
add column pending_handoff_digest bytea,
    add column pending_completion_digest bytea,
add column pending_handoff_expires_at timestamptz,
add constraint playback_claims_pending_handoff_shape check (
  (pending_handoff_id is null
    and pending_handoff_digest is null
         and pending_completion_digest is null
    and pending_handoff_expires_at is null)
  or
  (pending_handoff_id is not null
    and pending_handoff_digest is not null
    and octet_length(pending_handoff_digest) = 32
         and pending_completion_digest is not null
         and octet_length(pending_completion_digest) = 32
    and pending_handoff_expires_at is not null)
);
