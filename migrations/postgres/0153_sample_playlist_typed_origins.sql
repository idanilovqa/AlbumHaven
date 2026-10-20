-- Proposed only. Apply after exact held 0151 and 0152; reserve slot freshly.
-- Typed library-origin Sample receipts, no new table, grants or helper.
alter table app.playlist_creation_sources
  drop constraint playlist_creation_source_protocol_kind;
alter table app.playlist_creation_sources
  add constraint playlist_creation_source_protocol_kind check (
    (source_kind='library' and protocol in ('library_selection_v1',
      'complete_inventory_selection_v1','library_mix_selection_v1',
      'artist_popular_selection_v1','artist_loved_selection_v1',
      'sample_playlist_selection_v1'))
    or (source_kind='activity' and protocol in (
      'complete_activity_selection_v1','missing_activity_selection_v1'))
    or (source_kind='playlist' and protocol in (
      'missing_playlist_selection_v1','sample_playlist_selection_v1'))
  );
alter table app.playlist_creation_sources
  drop constraint playlist_sample_source_origin_v1;
alter table app.playlist_creation_sources
  add constraint playlist_sample_source_origin_v1 check (
    protocol <> 'sample_playlist_selection_v1' or coalesce((
      origin_descriptor is not null
      and jsonb_typeof(origin_descriptor) = 'object'
      and jsonb_typeof(origin_descriptor->'version') = 'number'
      and octet_length(origin_descriptor::text) <= 2097152
      and (
        (source_kind='playlist' and origin_descriptor->>'version'='1')
        or (source_kind='library' and origin_descriptor->>'version'='2'
          and jsonb_typeof(origin_descriptor->'request')='object'
          and jsonb_typeof(origin_descriptor->'request'->'origin')='object'
          and origin_descriptor->'request'->'origin'->>'kind'
            in ('album_top','album_set','album_details')
          and not ((origin_descriptor->'request') ? 'playlist_ref')
          and not ((origin_descriptor->'request') ? 'revision'))
      )
    ), false)
  );
-- Explicit Sample Save preserves ordinary item provenance and all legacy pairs.
alter table app.playlist_items drop constraint playlist_items_source_protocol_kind;
alter table app.playlist_items add constraint playlist_items_source_protocol_kind check (
  source_protocol is null
  or (source_kind='library' and source_protocol in ('library_selection_v1',
    'complete_inventory_selection_v1','library_mix_selection_v1',
    'artist_popular_selection_v1','artist_loved_selection_v1',
    'sample_playlist_selection_v1'))
  or (source_kind='activity' and source_protocol in (
    'complete_activity_selection_v1','missing_activity_selection_v1'))
  or (source_kind='playlist' and source_protocol in (
    'missing_playlist_selection_v1','playlist_copy_v1','sample_playlist_selection_v1'))
);
