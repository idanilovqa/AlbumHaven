create unique index if not exists lastfm_sessions_active_account_username_idx
  on integration.lastfm_sessions (account_id, provider_username)
  where is_active;

create unique index if not exists pending_scrobbles_source_identity_idx
  on integration.pending_scrobbles ((payload->>'source_family'), (payload->>'source_key'))
  where payload ? 'source_family' and payload ? 'source_key';

create unique index if not exists scrobble_retry_state_source_identity_idx
  on integration.scrobble_retry_state (
    (metadata->>'source_family'),
    (metadata->>'source_section'),
    (metadata->>'source_key')
  )
  where metadata ? 'source_family' and metadata ? 'source_section' and metadata ? 'source_key';
