-- Add a distinct receipt protocol; retain every existing protocol/kind pair.
alter table app.playlist_creation_sources
  drop constraint playlist_creation_source_protocol_kind;
alter table app.playlist_creation_sources
  add constraint playlist_creation_source_protocol_kind check (
    (source_kind='library' and protocol in ('library_selection_v1','complete_inventory_selection_v1'))
    or (source_kind='activity' and protocol in ('complete_activity_selection_v1','missing_activity_selection_v1'))
    or (source_kind='playlist' and protocol='missing_playlist_selection_v1')
  );

-- A saved occurrence keeps its protocol even after its disposable capture
-- expires. NULL means older saved provenance is unknown, not guessed.
alter table app.playlist_items
  add column source_protocol text,
  add constraint playlist_items_source_protocol_kind check (
    source_protocol is null
    or (source_kind='library' and source_protocol in ('library_selection_v1','complete_inventory_selection_v1'))
    or (source_kind='activity' and source_protocol in ('complete_activity_selection_v1','missing_activity_selection_v1'))
    or (source_kind='playlist' and source_protocol='missing_playlist_selection_v1')
  ),
  add constraint playlist_items_missing_activity_occurrence check (
    source_protocol is distinct from 'missing_activity_selection_v1'
    or (source_ref is not null and source_entry_ref is not null and source_revision is not null)
  );
alter table app.playlist_items
  drop constraint playlist_items_playlist_ref_original_local_track_id_key;
-- Every existing/ordinary source retains its exact original-track guard.
create unique index playlist_items_original_track_unique
  on app.playlist_items(playlist_ref,original_local_track_id)
  where source_protocol is distinct from 'missing_activity_selection_v1';
create unique index playlist_items_missing_activity_occurrence_unique
  on app.playlist_items(playlist_ref,source_entry_ref)
  where source_protocol='missing_activity_selection_v1';
