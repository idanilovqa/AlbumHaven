create index if not exists auth_throttles_cleanup_idx
  on app.auth_throttles (window_expires_at, id);
