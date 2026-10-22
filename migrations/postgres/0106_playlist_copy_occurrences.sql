-- Authored Playlist occurrences have identities independent of track identity.
-- A copy retains only safe Playlist lineage, never an Activity capture receipt.
alter table app.playlist_items drop constraint playlist_items_source_protocol_kind;
alter table app.playlist_items add constraint playlist_items_source_protocol_kind check (
  source_protocol is null
  or (source_kind='library' and source_protocol in ('library_selection_v1','complete_inventory_selection_v1'))
  or (source_kind='activity' and source_protocol in ('complete_activity_selection_v1','missing_activity_selection_v1'))
  or (source_kind='playlist' and source_protocol in ('missing_playlist_selection_v1','playlist_copy_v1'))
);

alter table app.playlist_items drop constraint playlist_items_missing_activity_occurrence;
alter table app.playlist_items add constraint playlist_items_missing_occurrence check (
  source_protocol not in ('missing_activity_selection_v1','missing_playlist_selection_v1')
  or (source_ref is not null and source_entry_ref is not null and source_revision is not null)
);
alter table app.playlist_items add constraint playlist_items_copy_occurrence check (
  source_protocol is distinct from 'playlist_copy_v1'
  or (source_ref is null and source_entry_ref is null and source_revision is null and source_label is null
    and source_lineage is not null
    and source_lineage ?& array['playlist_ref','playlist_item_ref','playlist_revision']
    and source_lineage - array['playlist_ref','playlist_item_ref','playlist_revision'] = '{}'::jsonb
    and jsonb_typeof(source_lineage->'playlist_ref')='string'
    and jsonb_typeof(source_lineage->'playlist_item_ref')='string'
    and jsonb_typeof(source_lineage->'playlist_revision')='string'
    and (source_lineage->>'playlist_ref') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (source_lineage->>'playlist_item_ref') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (source_lineage->>'playlist_revision') ~ '^[1-9][0-9]{0,18}$')
);

drop index app.playlist_items_original_track_unique;
create unique index playlist_items_original_track_unique
  on app.playlist_items(playlist_ref,original_local_track_id)
  where source_protocol is distinct from 'missing_activity_selection_v1'
    and source_protocol is distinct from 'missing_playlist_selection_v1'
    and source_protocol is distinct from 'playlist_copy_v1';
drop index app.playlist_items_missing_activity_occurrence_unique;
create unique index playlist_items_missing_occurrence_unique
  on app.playlist_items(playlist_ref,source_entry_ref)
  where source_protocol in ('missing_activity_selection_v1','missing_playlist_selection_v1');
create unique index playlist_items_copy_occurrence_unique
  on app.playlist_items(playlist_ref,(source_lineage->>'playlist_item_ref'))
  where source_protocol='playlist_copy_v1';
