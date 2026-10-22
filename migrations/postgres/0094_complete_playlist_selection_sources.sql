-- Explicit bounded selected-row sources remain distinct from paged searches.
alter table app.playlist_creation_sources
  drop constraint playlist_creation_sources_protocol_check;
alter table app.playlist_creation_sources
  add column source_kind text not null default 'library',
  add column origin_descriptor jsonb,
  add constraint playlist_creation_source_protocol_kind check (
    (source_kind='library' and protocol in ('library_selection_v1','complete_inventory_selection_v1'))
    or (source_kind='activity' and protocol='complete_activity_selection_v1')
    or (source_kind='playlist' and protocol='missing_playlist_selection_v1')
  ),
  add constraint playlist_creation_source_origin_shape check (
    origin_descriptor is null or jsonb_typeof(origin_descriptor)='object'
  );
alter table app.playlist_creation_entries
  alter column original_local_track_id drop not null,
  add column source_row_ref text,
  add column source_lineage jsonb,
  add constraint playlist_creation_entry_lineage_shape check (
    source_lineage is null or jsonb_typeof(source_lineage)='object'
  );
create unique index playlist_creation_entries_source_row_idx
  on app.playlist_creation_entries(source_ref,source_row_ref)
  where source_row_ref is not null;
alter table app.playlist_creation_entries add column source_label text;
alter table app.playlist_items
  add column source_kind text not null default 'library' check(source_kind in ('library','activity','playlist')),
  add column source_label text,
  add column source_lineage jsonb check(source_lineage is null or jsonb_typeof(source_lineage)='object');

alter table app.playlist_creation_entries drop constraint playlist_creation_entries_availability_check;
alter table app.playlist_creation_entries add constraint playlist_creation_entries_availability_check
  check(availability in ('local','unresolved','missing'));
