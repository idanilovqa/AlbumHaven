create unique index if not exists lastfm_sessions_account_username_idx
  on integration.lastfm_sessions (account_id, provider_username);
