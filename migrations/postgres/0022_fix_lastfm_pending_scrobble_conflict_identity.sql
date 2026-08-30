drop index if exists integration.pending_scrobbles_source_identity_idx;

create unique index pending_scrobbles_source_identity_idx
  on integration.pending_scrobbles (
    account_id,
    library_id,
    (payload->>'source_family'),
    (payload->>'source_key')
  )
  where account_id is not null
    and library_id is not null
    and payload ? 'source_family'
    and payload ? 'source_key';

drop index if exists integration.scrobble_retry_state_source_identity_idx;

create unique index scrobble_retry_state_source_identity_idx
  on integration.scrobble_retry_state (
    (metadata->>'account_id'),
    (metadata->>'library_id'),
    (metadata->>'source_family'),
    (metadata->>'source_section'),
    (metadata->>'source_key')
  )
  where metadata ? 'account_id'
    and metadata ? 'library_id'
    and metadata ? 'source_family'
    and metadata ? 'source_section'
    and metadata ? 'source_key';
