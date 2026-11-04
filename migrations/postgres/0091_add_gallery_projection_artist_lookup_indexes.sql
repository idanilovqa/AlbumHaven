-- Accelerate anchored root-gallery lookup and complete artist-boundary reads.
-- The projection payload remains the authority; these indexes change no rows.
create index if not exists gallery_projection_occurrences_artist_name_ordinal_idx
    on library.gallery_projection_occurrences
    (library_id, scope_key, (payload ->> 'artist_name'), ordinal);

create index if not exists gallery_projection_occurrences_artist_id_ordinal_idx
    on library.gallery_projection_occurrences
    (library_id, scope_key, (payload ->> 'artist_id'), ordinal);
