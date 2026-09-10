create index if not exists security_audit_events_cleanup_idx
  on app.security_audit_events (occurred_at, id);
