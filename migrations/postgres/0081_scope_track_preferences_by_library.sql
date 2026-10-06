-- Deploy with all runtime taste writers and offline importers stopped.
-- The migration runner supplies the transaction. Preserve every legacy row.

create unique index track_preferences_account_library_track_key_idx
  on app.track_preferences (account_id, library_id, track_key)
  nulls not distinct;

drop index app.track_preferences_account_track_key_idx;
