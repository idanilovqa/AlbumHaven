do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute '
      grant delete on table
        integration.pending_scrobbles,
        integration.scrobble_retry_state,
        integration.listen_history,
        library.move_policy_settings,
        library.ignored_versions,
        library.ignored_repairs,
        library.manual_versions,
        library.separate_releases,
        library.exception_overrides,
        ops.cover_lookup_tasks
      to album_haven_app
    ';
  end if;
end $$;
