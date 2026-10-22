-- Bounded Sample preview receipts, not saved Playlists or recipes.
alter table app.playlist_creation_sources
  drop constraint playlist_creation_source_protocol_kind;
alter table app.playlist_creation_sources
  add constraint playlist_creation_source_protocol_kind check (
    (source_kind='library' and protocol in ('library_selection_v1',
      'complete_inventory_selection_v1','library_mix_selection_v1',
      'artist_popular_selection_v1','artist_loved_selection_v1'))
    or (source_kind='activity' and protocol in (
      'complete_activity_selection_v1','missing_activity_selection_v1'))
    or (source_kind='playlist' and protocol in (
      'missing_playlist_selection_v1','sample_playlist_selection_v1'))
  );
alter table app.playlist_creation_sources
  add constraint playlist_sample_source_origin_v1 check (
    protocol <> 'sample_playlist_selection_v1' or (
      origin_descriptor is not null
      and jsonb_typeof(origin_descriptor) = 'object'
      and origin_descriptor ? 'version'
      and origin_descriptor->'version' = '1'::jsonb
      and octet_length(origin_descriptor::text) <= 2097152
    )
  );
