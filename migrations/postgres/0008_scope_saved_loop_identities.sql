-- Scope saved loop runtime identities to the bootstrap account/library context.
-- Loop audio and pitch-preview bytes remain filesystem-backed.

drop index if exists app.saved_loops_loop_key_idx;

create unique index if not exists saved_loops_loop_key_idx
  on app.saved_loops (account_id, library_id, loop_key)
  where account_id is not null
    and library_id is not null;
