-- Explicit Sample Save preserves ordinary item provenance and all legacy pairs.
alter table app.playlist_items drop constraint playlist_items_source_protocol_kind;
alter table app.playlist_items add constraint playlist_items_source_protocol_kind check (
  source_protocol is null
  or (source_kind='library' and source_protocol in ('library_selection_v1',
    'complete_inventory_selection_v1','library_mix_selection_v1',
    'artist_popular_selection_v1','artist_loved_selection_v1'))
  or (source_kind='activity' and source_protocol in (
    'complete_activity_selection_v1','missing_activity_selection_v1'))
  or (source_kind='playlist' and source_protocol in (
    'missing_playlist_selection_v1','playlist_copy_v1','sample_playlist_selection_v1'))
);
