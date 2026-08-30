with bootstrap_context as (
  select
    app.bootstrap_owners.account_id,
    library.libraries.id as library_id
  from app.bootstrap_owners
  join library.libraries
    on library.libraries.owner_account_id = app.bootstrap_owners.account_id
   and library.libraries.name = 'Local Library'
   and library.libraries.library_kind = 'local'
  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
  limit 1
)
update integration.scrobble_retry_state
set metadata = integration.scrobble_retry_state.metadata
  || jsonb_build_object(
    'account_id', bootstrap_context.account_id::text,
    'library_id', bootstrap_context.library_id::text
  )
from bootstrap_context
where integration.scrobble_retry_state.metadata ->> 'source_family' = 'lastfm_sync_state'
  and (
    not integration.scrobble_retry_state.metadata ? 'account_id'
    or not integration.scrobble_retry_state.metadata ? 'library_id'
  );

drop index if exists lastfm_sessions_account_username_idx;

create unique index if not exists lastfm_sessions_account_username_idx
  on integration.lastfm_sessions (account_id, provider_username);

drop index if exists pending_scrobbles_source_identity_idx;

create unique index if not exists pending_scrobbles_source_identity_idx
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

drop index if exists scrobble_retry_state_source_identity_idx;

create unique index if not exists scrobble_retry_state_source_identity_idx
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
